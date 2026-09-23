#!/usr/bin/env python3
"""
Face Quality Microservice
Runs on localhost:5050 — called by the Node.js backend for enrollment photo scoring.

Scores each face photo using InsightFace (used for detection/keypoints) and returns
quality metrics for AdaFace embedding selection:
  - confidence    : 0.0–1.0  overall quality score
  - face_detected : bool
  - det_score     : raw detection confidence from RetinaFace
  - sharpness     : Laplacian variance (normalised 0–1)
  - brightness    : mean luminance (0–1)
  - face_size_pct : fraction of image area covered by face (0–1)
  - pose          : {yaw, pitch, roll} in degrees
"""

import os, sys, io, logging, time
import numpy as np
import cv2
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO,
                    format='[face-quality] %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

# ── Load InsightFace model once at startup ────────────────────────────────────
detector = None

def load_model():
    global detector
    try:
        import insightface
        from insightface.app import FaceAnalysis
        log.info("Loading InsightFace buffalo_sc model …")
        detector = FaceAnalysis(
            name='buffalo_sc',          # small + fast: det + recognition
            providers=['CPUExecutionProvider']
        )
        detector.prepare(ctx_id=-1, det_size=(320, 320))
        log.info("✅ InsightFace ready")
    except Exception as e:
        log.error(f"❌ InsightFace load failed: {e}")
        detector = None

load_model()

# Which engine powers /quality's detection/pose/occlusion scoring:
# 'insightface' (the original heuristics) or 'mediapipe' (mediapipe_engine.py).
#
# Chosen PER REQUEST via an `engine` form field, falling back to the
# QUALITY_ENGINE env var and finally to 'insightface'. Per-request rather than
# per-process because one script serves consumers with incompatible needs:
# corporate enrollment requires MediaPipe (its frontend's pose gates are
# calibrated to MediaPipe's real degrees, and InsightFace's scale is not just
# different but sign-inverted on yaw), while Transport's :5051 instance and the
# visitor re-ID path expect the original behaviour. Making the caller name what
# it needs removes a deployment footgun: a host that forgets the env var would
# otherwise serve enrollment the wrong pose scale and silently make 7 of the 8
# capture angles unreachable.
DEFAULT_QUALITY_ENGINE = os.environ.get('QUALITY_ENGINE', 'insightface').strip().lower()

mp_engine = None
_mp_state = None  # None = not tried yet, True = ready, False = unavailable


def get_mediapipe_engine():
    """Load the MediaPipe engine on first use. Lazy so that instances which
    never request it (Transport's :5051) don't pay its ~180 MB of models."""
    global mp_engine, _mp_state
    if _mp_state is not None:
        return mp_engine if _mp_state else None
    try:
        import mediapipe_engine as _mp
        if _mp.load_models():
            mp_engine, _mp_state = _mp, True
            return mp_engine
        log.error("MediaPipe engine requested but model load failed")
    except Exception as e:
        log.error(f"MediaPipe engine requested but unavailable: {e}")
    _mp_state = False
    return None


log.info(f"Default quality engine: {DEFAULT_QUALITY_ENGINE} (overridable per request)")
if DEFAULT_QUALITY_ENGINE == 'mediapipe':
    get_mediapipe_engine()

# ── Helpers ───────────────────────────────────────────────────────────────────

def laplacian_sharpness(gray: np.ndarray) -> float:
    """Normalised sharpness: Laplacian variance → 0–1 (capped at 300 → 1.0)."""
    var = cv2.Laplacian(gray, cv2.CV_64F).var()
    return float(min(var / 300.0, 1.0))

def brightness_score(gray: np.ndarray) -> float:
    """Mean luminance normalised to 0–1."""
    return float(np.mean(gray) / 255.0)

def face_size_score(bbox, img_h: int, img_w: int) -> float:
    """Fraction of image area the face bounding box covers."""
    x1, y1, x2, y2 = bbox
    face_area = max(0, x2 - x1) * max(0, y2 - y1)
    return float(min(face_area / (img_h * img_w), 1.0))

# A half-visible/cropped face (person standing too close, or stepping out of
# frame) still gets a confident det_score from RetinaFace-style detectors —
# the model happily boxes whatever partial face it can see, so det_score
# alone can't catch this. The bbox touching (or nearly touching) the image
# edge is the actual tell: a fully-visible face has margin on all sides.
EDGE_MARGIN_PCT = 0.02  # bbox within 2% of an edge counts as "cropped"
# Face centering: fraction of image dimensions the face center can drift from
# the image center before we flag it. 0.30 means the face must be within ±30%
# of the frame center (horizontally and vertically).
FACE_CENTER_TOLERANCE = 0.30
# Minimum face size (as fraction of total image area) required for a reliable
# AdaFace embedding. At 10% (e.g. 0.10), the face bbox covers a reasonable
# portion of a 1280×720 frame → ~92×92 px aligned face after crop. Below 5%
# the embedding quality degrades rapidly; we hard-fail rather than store a
# low-quality vector that will hurt recognition accuracy.
MIN_FACE_SIZE_PCT = 0.08   # hard fail below 8%  → "come closer"
GOOD_FACE_SIZE_PCT = 0.10  # score penalty below 10% → encourage closer shot
MAX_FACE_SIZE_PCT = 0.40   # hard fail above 40% → "step back" (partial face)

def face_fully_visible(bbox, img_h: int, img_w: int) -> bool:
    x1, y1, x2, y2 = bbox
    margin_x = img_w * EDGE_MARGIN_PCT
    margin_y = img_h * EDGE_MARGIN_PCT
    return x1 > margin_x and y1 > margin_y and x2 < (img_w - margin_x) and y2 < (img_h - margin_y)

def face_center_offset(bbox, img_h: int, img_w: int) -> dict:
    """Returns face center as (cx_pct, cy_pct) relative to image center (0,0).
    Positive x = face is right of center, positive y = face is below center.
    Range roughly -0.5 to +0.5 for each axis."""
    x1, y1, x2, y2 = bbox
    face_cx = (x1 + x2) / 2
    face_cy = (y1 + y2) / 2
    img_cx = img_w / 2
    img_cy = img_h / 2
    return {
        "x": round(float((face_cx - img_cx) / img_w), 3),
        "y": round(float((face_cy - img_cy) / img_h), 3),
    }

# Landmark-based occlusion check: if the face is turned/cropped such that one
# side is out of frame or obscured, the two eyes end up much closer together
# (in pixel terms) than the mouth corners would predict for a normal frontal
# face, or the detected eye-to-nose distances are wildly asymmetric. Kept
# deliberately loose (this is a 5-point landmark heuristic, not a real
# occlusion model) — only flags egregious cases, not natural yaw turns.
def landmarks_suggest_partial_face(kps) -> bool:
    if kps is None or len(kps) < 5:
        return False
    leye, reye, nose, lmouth, rmouth = kps[:5]
    eye_width = abs(reye[0] - leye[0])
    mouth_width = abs(rmouth[0] - lmouth[0])
    if eye_width < 1 or mouth_width < 1:
        return True
    # One side of the face missing collapses either the eye or mouth span
    # relative to the other far more than natural yaw ever does.
    ratio = eye_width / mouth_width
    return ratio < 0.35 or ratio > 3.0

# Accessory/occlusion heuristics ─────────────────────────────────────────────
# buffalo_sc only ships detection + recognition, no attribute/occlusion
# classifier — there's no trained "wearing glasses/mask" model available
# locally. These are pixel-patch heuristics using the same 5-point landmarks
# as pose_from_landmarks, not a certified classifier: they catch the common,
# high-impact cases (dark sunglasses, opaque masks — both of which visibly
# wreck AdaFace embedding quality) at the cost of occasionally missing clear
# glasses (near-transparent, no reliable brightness/color signature) or
# false-flagging on unusual lighting/skin-tone edge cases. Tune the
# thresholds below against real enrollment photos if either happens often.

def _patch_stats(img_bgr, cx, cy, half_w, half_h, img_h, img_w):
    x1 = max(0, int(cx - half_w)); x2 = min(img_w, int(cx + half_w))
    y1 = max(0, int(cy - half_h)); y2 = min(img_h, int(cy + half_h))
    if x2 <= x1 or y2 <= y1:
        return None
    patch = img_bgr[y1:y2, x1:x2]
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    min_val = float(np.min(gray))
    max_val = float(np.max(gray))
    return {
        "brightness": float(np.mean(gray) / 255.0),
        "variance": float(np.var(gray)),
        "min": min_val,
        "max": max_val,
        "contrast": max_val - min_val,
        "hue": float(np.mean(hsv[:, :, 0])),
        "sat": float(np.mean(hsv[:, :, 1])),
    }

def detect_sunglasses(img_bgr, kps, img_h, img_w) -> bool:
    """Dark, smooth (lens-like) patch over both eyes vs. the cheek skin tone."""
    if kps is None or len(kps) < 5:
        return False
    leye, reye, _, _, _ = kps[:5]
    eye_width = abs(reye[0] - leye[0])
    if eye_width < 4:
        return False
    half = max(4.0, eye_width * 0.28)

    l_eye = _patch_stats(img_bgr, leye[0], leye[1], half, half * 0.6, img_h, img_w)
    r_eye = _patch_stats(img_bgr, reye[0], reye[1], half, half * 0.6, img_h, img_w)
    # Cheek reference sits below+outside the left eye — plain skin, no brows/lashes.
    cheek = _patch_stats(img_bgr, leye[0] - eye_width * 0.4, leye[1] + eye_width * 0.6, half, half, img_h, img_w)
    if not l_eye or not r_eye or not cheek:
        return False

    eye_brightness = (l_eye["brightness"] + r_eye["brightness"]) / 2
    eye_variance = (l_eye["variance"] + r_eye["variance"]) / 2
    # Real eyes (sclera/iris/lashes) are textured; a dark lens is both much
    # darker than skin AND unnaturally smooth.
    return eye_brightness < (cheek["brightness"] - 0.18) and eye_variance < 250

def detect_mask(img_bgr, kps, bbox, img_h, img_w) -> bool:
    """Lower-face (nose-to-chin) color/texture diverging sharply from forehead skin."""
    if kps is None or len(kps) < 5:
        return False
    _, _, nose, lmouth, rmouth = kps[:5]
    x1, y1, x2, y2 = bbox
    mouth_mid_x = (lmouth[0] + rmouth[0]) / 2
    mouth_width = abs(rmouth[0] - lmouth[0])
    half_w = max(6.0, mouth_width * 0.9)
    lower_face_y = (nose[1] + y2) / 2
    half_h = max(6.0, (y2 - nose[1]) * 0.35)

    lower = _patch_stats(img_bgr, mouth_mid_x, lower_face_y, half_w, half_h, img_h, img_w)
    forehead = _patch_stats(img_bgr, mouth_mid_x, y1 + (nose[1] - y1) * 0.35, half_w, half_h * 0.6, img_h, img_w)
    if not lower or not forehead:
        return False

    hue_diff = abs(lower["hue"] - forehead["hue"])
    sat_diff = abs(lower["sat"] - forehead["sat"])
    # Mask fabric both differs in color from skin AND is flatter/more uniform
    # than a bare mouth+chin (which has lip/teeth/shadow texture).
    return (hue_diff > 18 or sat_diff > 40) and lower["variance"] < 300

def detect_face_occlusion(img_bgr, kps, bbox, img_h, img_w) -> bool:
    """
    Detects hand, object, or heavy facial occlusion (e.g. hand over eyes/forehead, hand over mouth).
    """
    if kps is None or len(kps) < 5:
        return False
        
    leye, reye, nose, lmouth, rmouth = kps[:5]
    x1, y1, x2, y2 = bbox
    
    eye_dx = reye[0] - leye[0]
    eye_dy = reye[1] - leye[1]
    eye_dist = max(1.0, float(np.sqrt(eye_dx**2 + eye_dy**2)))
    
    eye_mid = ((leye[0] + reye[0]) / 2.0, (leye[1] + reye[1]) / 2.0)
    mouth_mid = ((lmouth[0] + rmouth[0]) / 2.0, (lmouth[1] + rmouth[1]) / 2.0)
    
    nose_to_eye = max(1.0, float(np.sqrt((nose[0] - eye_mid[0])**2 + (nose[1] - eye_mid[1])**2)))
    eye_to_mouth = max(1.0, float(np.sqrt((mouth_mid[0] - eye_mid[0])**2 + (mouth_mid[1] - eye_mid[1])**2)))
    
    # 1. Geometry anomaly check (fake landmarks placed on hand/fingers)
    ratio_en = eye_dist / nose_to_eye
    ratio_em = eye_dist / eye_to_mouth
    if ratio_en < 0.65 or ratio_en > 2.8 or ratio_em < 0.6 or ratio_em > 2.3:
        return True

    # 2. Eye patch pupil presence & contrast check (hand/palm skin over eyes)
    half_w = max(5.0, eye_dist * 0.28)
    half_h = max(5.0, eye_dist * 0.22)
    
    l_eye = _patch_stats(img_bgr, leye[0], leye[1], half_w, half_h, img_h, img_w)
    r_eye = _patch_stats(img_bgr, reye[0], reye[1], half_w, half_h, img_h, img_w)
    cheek = _patch_stats(img_bgr, leye[0] - eye_dist * 0.3, leye[1] + eye_dist * 0.6, half_w, half_h, img_h, img_w)
    
    if l_eye and r_eye:
        # Real open eyes MUST have dark pupil/sclera structure (min intensity < 95 or contrast > 45)
        # When a hand covers eyes, min pixel intensity is > 95 (skin tone) or contrast is low!
        if (l_eye["min"] > 95 and r_eye["min"] > 95) or (l_eye["contrast"] < 45 and r_eye["contrast"] < 45):
            return True
            
        avg_eye_var = (l_eye["variance"] + r_eye["variance"]) / 2.0
        if avg_eye_var < 140:
            return True
        if cheek and avg_eye_var < 180:
            hue_diff = abs((l_eye["hue"] + r_eye["hue"])/2.0 - cheek["hue"])
            if hue_diff < 15 and avg_eye_var < 160:
                return True

    # 3. Mouth occlusion check (hand/object covering lower face).
    # Widened from a narrow strip pinned to the raw landmark point to the
    # full nose-to-chin band at (roughly) face width: the 5-point landmark
    # regressor has no "not visible" output, so it still emits a
    # plausible-looking mouth position even when the real mouth is fully
    # hidden — a tightly-centered patch can land squarely in a gap between
    # spread fingers and sample real skin/mouth instead of the occluding hand.
    mouth_w = abs(rmouth[0] - lmouth[0])
    if mouth_w > 4:
        lower_cx = (lmouth[0] + rmouth[0]) / 2.0
        lower_cy = (nose[1] + y2) / 2.0
        lower_half_w = max(mouth_w * 0.5, eye_dist * 0.7)
        lower_half_h = max(8.0, (y2 - nose[1]) * 0.5)
        mouth_patch = _patch_stats(img_bgr, lower_cx, lower_cy, lower_half_w, lower_half_h, img_h, img_w)
        if mouth_patch:
            if mouth_patch["contrast"] < 35 or mouth_patch["variance"] < 90:
                return True
            # A real mouth — even closed and neutral — almost always has at
            # least one genuinely dark pixel (the lip line / mouth-opening
            # shadow). A hand spread over the same region is uniformly
            # mid-tone skin with no such dark feature, even in cases where
            # finger-edge shadows push contrast/variance high enough to
            # dodge the check above.
            if mouth_patch["min"] > 90:
                return True

    # 4. Horizontal finger edge check across upper face
    x1_i, y1_i, x2_i, y2_i = max(0, int(x1)), max(0, int(y1)), min(img_w, int(x2)), min(img_h, int(y2))
    if (x2_i - x1_i) > 20 and (y2_i - y1_i) > 20:
        face_crop = img_bgr[y1_i:y2_i, x1_i:x2_i]
        gray_crop = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
        fh = gray_crop.shape[0]
        upper_crop = gray_crop[0:int(fh * 0.55), :]
        sobel_y = np.abs(cv2.Sobel(upper_crop, cv2.CV_64F, 0, 1, ksize=3))
        mean_sobel_y = float(np.mean(sobel_y))
        if mean_sobel_y > 25.0 and (l_eye and l_eye["variance"] < 180):
            return True

    return False

def pose_from_landmarks(kps) -> dict:
    """
    Very rough yaw/pitch from 5-point landmarks.
    kps: [[leye_x,leye_y],[reye_x,reye_y],[nose_x,nose_y],[lmouth_x,lmouth_y],[rmouth_x,rmouth_y]]
    """
    if kps is None or len(kps) < 5:
        return {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    leye, reye, nose, lmouth, rmouth = kps[:5]
    eye_mid = ((leye[0] + reye[0]) / 2, (leye[1] + reye[1]) / 2)
    mouth_mid = ((lmouth[0] + rmouth[0]) / 2, (lmouth[1] + rmouth[1]) / 2)
    eye_width = abs(reye[0] - leye[0])
    # yaw: horizontal nose offset from eye centre (negative = turned left, positive = turned right)
    yaw = -(nose[0] - eye_mid[0]) / max(eye_width, 1) * 45.0
    # pitch: vertical nose offset relative to eye–mouth distance
    em_dist = abs(mouth_mid[1] - eye_mid[1])
    pitch = (nose[1] - (eye_mid[1] + em_dist * 0.5)) / max(em_dist, 1) * 30.0
    # roll: eye line tilt (0 when horizontal, negative when head tilts to right)
    roll = float(np.degrees(np.arctan2(leye[1] - reye[1], leye[0] - reye[0])))
    return {"yaw": round(float(yaw), 1),
            "pitch": round(float(pitch), 1),
            "roll": round(float(roll), 1)}

def combine_score(det_score: float, sharpness: float,
                  brightness: float, face_size: float,
                  pose: dict, angle: str = '', fully_visible: bool = True,
                  partial_face: bool = False, glasses_detected: bool = False,
                  mask_detected: bool = False, occlusion_detected: bool = False,
                  multiple_faces_detected: bool = False,
                  face_offset: dict = None) -> float:
    """
    Weighted quality score:
      det_score  35%  – face detection confidence
      sharpness  30%  – image sharpness
      brightness 15%  – well-lit
      face_size  10%  – face is large enough in frame
      pose       10%  – penalise extreme angles

    A cropped-at-the-edge or landmark-asymmetric ("half") face, or a detected
    mask/sunglasses/hand occlusion, fails outright regardless of how well the other
    components score.
    """
    if not fully_visible or partial_face or glasses_detected or mask_detected or occlusion_detected or multiple_faces_detected:
        return 0.0
    
    # Hard minimum face size — below 8% the AdaFace embedding degrades sharply.
    # The scorer always tells the user to come closer before allowing capture.
    if face_size < MIN_FACE_SIZE_PCT:
        return 0.0
    
    # Hard maximum face size — above 40% the face is too close; edges are
    # likely cropped and the embedding will be distorted.
    if face_size > MAX_FACE_SIZE_PCT:
        return 0.0
    
    # Face centering check: for the front angle, the face must be within ±30%
    # of the image center. For side/up/down angles we allow more drift since
    # the person naturally tilts away from the camera center.
    if face_offset is not None and angle and angle.lower() == 'front':
        if abs(face_offset.get('x', 0)) > FACE_CENTER_TOLERANCE or abs(face_offset.get('y', 0)) > FACE_CENTER_TOLERANCE:
            return 0.0
    yaw = pose.get("yaw", 0)
    pitch = pose.get("pitch", 0)
    
    # Strict pose target validation — fail outright if pose does not match the requested angle
    if angle:
        angle_lower = angle.lower()
        # Tolerances (yaw, pitch) on this module's own InsightFace pose scale.
        # NOTE: the enrollment frontend no longer mirrors these — it tracks
        # POSE_RANGES_MP in mediapipe_engine.py, which is what serves the
        # corporate :5050 instance. This legacy path is still live for the
        # Transport :5051 instance (QUALITY_ENGINE unset), which has no
        # enrollment UI of its own.
        # Front is tighter (±12°) to ensure the user is really looking straight
        yaw_tol = 12.0 if angle_lower == 'front' else 15.0 if angle_lower in ['up_deep', 'left_up', 'right_up'] else 12.0
        pitch_tol = 12.0 if angle_lower == 'front' else 15.0 if angle_lower in ['up_deep', 'left_up', 'right_up'] else 12.0
        
        expected_yaw = 0.0
        expected_pitch = 0.0
        
        if angle_lower == 'left':
            expected_yaw = -20.0
        elif angle_lower == 'right':
            expected_yaw = 20.0
        elif angle_lower == 'up':
            expected_pitch = -15.0
        elif angle_lower == 'up_deep':
            expected_pitch = -25.0
        elif angle_lower == 'left_up':
            expected_yaw = -25.0
            expected_pitch = -20.0
        elif angle_lower == 'right_up':
            expected_yaw = 25.0
            expected_pitch = -20.0
        elif angle_lower == 'down':
            expected_pitch = 15.0

        if abs(yaw - expected_yaw) > yaw_tol or abs(pitch - expected_pitch) > pitch_tol:
            return 0.0

    # Default pose penalty
    pose_penalty = (abs(yaw) + abs(pitch)) / 90.0
    
    # Align penalty with expected pose offsets for non-front and ceiling angles
    if angle:
        angle_lower = angle.lower()
        if angle_lower == 'up_deep':
            # Look Up High: Expect deep pitch-up (pitch ≈ -25.0°)
            expected_pitch = -25.0
            adjusted_pitch = max(0.0, abs(pitch - expected_pitch) - 15.0)
            pose_penalty = (abs(yaw) + adjusted_pitch) / 90.0
        elif angle_lower in ['left_up', 'right_up']:
            # Expect side rotation and tilt-up (yaw ≈ ±25.0°, pitch ≈ -20.0°)
            expected_yaw = -25.0 if angle_lower == 'left_up' else 25.0
            expected_pitch = -20.0
            adjusted_yaw = max(0.0, abs(yaw - expected_yaw) - 15.0)
            adjusted_pitch = max(0.0, abs(pitch - expected_pitch) - 15.0)
            pose_penalty = (adjusted_yaw + adjusted_pitch) / 90.0
        elif angle_lower == 'up':
            expected_pitch = -15.0
            adjusted_pitch = max(0.0, abs(pitch - expected_pitch) - 10.0)
            pose_penalty = (abs(yaw) + adjusted_pitch) / 90.0
        elif angle_lower == 'left':
            expected_yaw = -20.0
            adjusted_yaw = max(0.0, abs(yaw - expected_yaw) - 10.0)
            pose_penalty = (adjusted_yaw + abs(pitch)) / 90.0
        elif angle_lower == 'right':
            expected_yaw = 20.0
            adjusted_yaw = max(0.0, abs(yaw - expected_yaw) - 10.0)
            pose_penalty = (adjusted_yaw + abs(pitch)) / 90.0
        elif angle_lower == 'down':
            expected_pitch = 15.0
            adjusted_pitch = max(0.0, abs(pitch - expected_pitch) - 10.0)
            pose_penalty = (abs(yaw) + adjusted_pitch) / 90.0

    pose_score = max(0.0, 1.0 - pose_penalty)

    # Penalise very dark or very bright images
    bri = brightness
    bri_score = 1.0 - abs(bri - 0.5) * 1.5  # peaks at 0.5, drops at extremes
    bri_score = max(0.0, min(1.0, bri_score))

    score = (0.35 * det_score +
             0.30 * sharpness +
             0.15 * bri_score +
             0.10 * min(face_size / GOOD_FACE_SIZE_PCT, 1.0) +  # peaks at 10% face coverage
             0.10 * pose_score)
    return round(float(score), 4)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model_loaded": detector is not None})


@app.route('/quality', methods=['POST'])
def quality():
    t0 = time.time()

    if 'image' not in request.files:
        return jsonify({"error": "No image file in request"}), 400

    file = request.files['image']
    file_bytes = file.read()
    
    angle = request.form.get('angle', '')
    if not angle and file.filename:
        angle = file.filename.split('.')[0]

    nparr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        return jsonify({"error": "Could not decode image"}), 400

    requested_engine = (request.form.get('engine') or DEFAULT_QUALITY_ENGINE).strip().lower()
    if requested_engine == 'mediapipe':
        engine = get_mediapipe_engine()
        if engine is not None:
            result = engine.score_quality(img, angle)
            # MediaPipe cannot produce a recognition embedding. Callers that
            # want one (Transport's FaceEmbeddingClient reads it off the same
            # /quality response) are served by InsightFace alongside, so this
            # route stays a superset of the InsightFace response no matter
            # which engine scored it.
            if detector is not None and result.get("face_detected"):
                try:
                    faces = detector.get(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                    if faces:
                        largest = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))
                        if getattr(largest, 'normed_embedding', None) is not None:
                            result["embedding"] = largest.normed_embedding.tolist()
                except Exception as e:
                    log.warning(f"embedding alongside mediapipe scoring failed: {e}")
            result.setdefault("embedding", None)
            result["elapsed_ms"] = round((time.time() - t0) * 1000, 1)
            return jsonify(result)
        log.warning("mediapipe engine requested but unavailable — scoring with insightface")

    img_h, img_w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sharpness = laplacian_sharpness(gray)
    brightness = brightness_score(gray)

    if detector is None:
        # Model failed to load – return heuristic-only score
        score = round((sharpness * 0.5 + brightness * 0.5) * 0.75, 4)
        return jsonify({
            "confidence": score,
            "face_detected": False,
            "multiple_faces_detected": False,
            "det_score": 0.0,
            "sharpness": round(sharpness, 4),
            "brightness": round(brightness, 4),
            "face_size_pct": 0.0,
            "pose": {},
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
            "note": "model_unavailable_heuristic"
        })

    # Run InsightFace detection
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    faces = detector.get(img_rgb)

    if not faces:
        return jsonify({
            "confidence": 0.0,
            "face_detected": False,
            "multiple_faces_detected": False,
            "det_score": 0.0,
            "sharpness": round(sharpness, 4),
            "brightness": round(brightness, 4),
            "face_size_pct": 0.0,
            "pose": {},
            "elapsed_ms": round((time.time() - t0) * 1000, 1)
        })

    multiple_faces_detected = len(faces) > 1

    # Pick the largest face
    face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))

    det_score   = float(face.det_score) if hasattr(face, 'det_score') else 0.8
    bbox        = face.bbox.tolist()
    kps         = face.kps.tolist() if hasattr(face, 'kps') and face.kps is not None else None
    pose        = pose_from_landmarks(kps)
    face_size   = face_size_score(bbox, img_h, img_w)
    fully_visible = face_fully_visible(bbox, img_h, img_w)
    partial_face  = landmarks_suggest_partial_face(kps)
    glasses_detected   = detect_sunglasses(img, kps, img_h, img_w)
    mask_detected      = detect_mask(img, kps, bbox, img_h, img_w)
    occlusion_detected = detect_face_occlusion(img, kps, bbox, img_h, img_w)
    offset      = face_center_offset(bbox, img_h, img_w)
    confidence  = combine_score(det_score, sharpness, brightness, face_size, pose, angle,
                                 fully_visible=fully_visible, partial_face=partial_face,
                                 glasses_detected=glasses_detected, mask_detected=mask_detected,
                                 occlusion_detected=occlusion_detected,
                                 multiple_faces_detected=multiple_faces_detected,
                                 face_offset=offset)

    # buffalo_sc loads both detection and recognition — face.normed_embedding
    # is already computed as part of detector.get() above. Kept here too for
    # the Transport vertical's :5051 instance, whose FaceEmbeddingClient still
    # reads both confidence and embedding off a single /quality call. The
    # corporate visitor re-ID path (DeviceEventService.computeEmbeddingFromCrop)
    # now calls the leaner /embed route below instead.
    embedding = None
    if hasattr(face, 'normed_embedding') and face.normed_embedding is not None:
        embedding = face.normed_embedding.tolist()

    return jsonify({
        "confidence":       confidence,
        "face_detected":    True,
        "multiple_faces_detected": multiple_faces_detected,
        "fully_visible":    fully_visible,
        "partial_face":     partial_face,
        "glasses_detected": glasses_detected,
        "mask_detected":    mask_detected,
        "occlusion_detected": occlusion_detected,
        "det_score":      round(det_score, 4),
        "sharpness":      round(sharpness, 4),
        "brightness":     round(brightness, 4),
        "face_size_pct":  round(face_size, 4),
        "pose":           pose,
        "face_center_offset": offset,
        "embedding":      embedding,
        "model_version":  "insightface-buffalo_sc",
        "elapsed_ms":     round((time.time() - t0) * 1000, 1)
    })


@app.route('/embed', methods=['POST'])
def embed():
    """
    Embedding-only endpoint — InsightFace buffalo_sc detect+embed, no quality/
    pose scoring. Used by the visitor re-ID path (DeviceEventService.
    computeEmbeddingFromCrop), which only ever reads the `embedding` field from
    /quality and ignores everything else; split out so that changing /quality's
    detection engine can't silently affect this call site.
    """
    t0 = time.time()

    if 'image' not in request.files:
        return jsonify({"error": "No image file in request"}), 400

    file_bytes = request.files['image'].read()
    nparr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        return jsonify({"error": "Could not decode image"}), 400

    if detector is None:
        return jsonify({
            "embedding": None,
            "face_detected": False,
            "model_version": "insightface-buffalo_sc",
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
            "note": "model_unavailable"
        })

    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    faces = detector.get(img_rgb)

    if not faces:
        return jsonify({
            "embedding": None,
            "face_detected": False,
            "model_version": "insightface-buffalo_sc",
            "elapsed_ms": round((time.time() - t0) * 1000, 1)
        })

    # Pick the largest face, matching /quality's selection rule.
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    embedding = None
    if hasattr(face, 'normed_embedding') and face.normed_embedding is not None:
        embedding = face.normed_embedding.tolist()

    return jsonify({
        "embedding": embedding,
        "face_detected": True,
        "model_version": "insightface-buffalo_sc",
        "elapsed_ms": round((time.time() - t0) * 1000, 1)
    })


if __name__ == '__main__':
    port = int(os.environ.get('FACE_QUALITY_PORT', 5050))
    log.info(f"Starting face quality service on port {port}")
    app.run(host='127.0.0.1', port=port, threaded=True)
