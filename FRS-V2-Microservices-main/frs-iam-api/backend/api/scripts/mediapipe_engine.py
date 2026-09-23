"""
MediaPipe-based face quality/pose scoring engine — replaces the InsightFace
5-point-landmark heuristics in face_quality_service.py's /quality route with
MediaPipe Face Detector (real per-face detection confidence + bbox) and Face
Landmarker (478 3D landmarks + a real solvePnP-derived head-pose matrix,
instead of a 2-point trig approximation).

Selected via QUALITY_ENGINE=mediapipe (see face_quality_service.py); default
engine stays InsightFace until this has been validated against real traffic.

Recognition (AdaFace on the Jetson edge devices, and the InsightFace
embedding served by /embed for visitor re-ID) is untouched — this module only
ever produces quality/pose signals, never an identity embedding.
"""

import logging
import os
import urllib.request
import numpy as np
import cv2
from scipy.spatial.transform import Rotation

log = logging.getLogger(__name__)

MODELS_DIR = __file__.rsplit('/', 1)[0] + '/models'

# Official Google-hosted MediaPipe task bundles — not committed to the repo
# (see .gitignore), auto-downloaded on first run, same pattern as
# InsightFace's buffalo_sc weights caching to ~/.insightface/models.
MODEL_URLS = {
    "blaze_face_short_range.tflite": "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
    "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
}

face_detector = None
face_landmarker = None


def _ensure_models_downloaded():
    os.makedirs(MODELS_DIR, exist_ok=True)
    for filename, url in MODEL_URLS.items():
        path = f"{MODELS_DIR}/{filename}"
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        log.info(f"Downloading MediaPipe model {filename} …")
        tmp_path = f"{path}.download"
        urllib.request.urlretrieve(url, tmp_path)
        os.rename(tmp_path, path)
        log.info(f"✅ {filename} downloaded")


def load_models():
    global face_detector, face_landmarker
    try:
        _ensure_models_downloaded()
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        detector_options = mp_vision.FaceDetectorOptions(
            base_options=mp_python.BaseOptions(model_asset_path=f"{MODELS_DIR}/blaze_face_short_range.tflite"),
            running_mode=mp_vision.RunningMode.IMAGE,
            min_detection_confidence=0.5,
        )
        face_detector = mp_vision.FaceDetector.create_from_options(detector_options)

        landmarker_options = mp_vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=f"{MODELS_DIR}/face_landmarker.task"),
            running_mode=mp_vision.RunningMode.IMAGE,
            num_faces=5,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=True,
            min_face_detection_confidence=0.5,
        )
        face_landmarker = mp_vision.FaceLandmarker.create_from_options(landmarker_options)
        log.info("MediaPipe quality engine ready")
        return True
    except Exception as e:
        log.error(f"MediaPipe engine load failed: {e}")
        face_detector = None
        face_landmarker = None
        return False


def _mp_image(img_bgr):
    import mediapipe as mp
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)


# ── Pose ──────────────────────────────────────────────────────────────────────
# Calibrated against the app's own 8 pose reference photos
# (frontend/public/enrollment-references/*.jpg — the literal "how to pose"
# guide shown to users), not against the old InsightFace heuristic's targets:
# that heuristic used an ad hoc, non-geometric yaw/pitch scale, so its numeric
# targets don't carry over to MediaPipe's real solvePnP-derived degrees.
# Sign convention matches the app's existing one (verified empirically):
# yaw negative = turned left, positive = right; pitch negative = looking up,
# positive = looking down.
#
# Expressed as ACCEPTED RANGES (min, max) per axis rather than a target with a
# symmetric tolerance. What enrollment actually needs is a spread of clearly
# distinct head poses, not a specific number of degrees: "turned far enough to
# the left" is the real requirement, and demanding e.g. -45 +/- 20 rejects both
# the person who turns modestly and the person who turns a lot, even though
# both give a perfectly usable embedding.
#
# The first cut of this used narrow target+tolerance bands fitted to the single
# reference photo per angle in frontend/public/enrollment-references/. That was
# wrong in practice: those photos are mild examples (up.jpg reads only about
# -4 deg of pitch), so a user who genuinely looked up was scored out of range.
# Ranges below are deliberately generous at the far end and only tight enough
# at the near end to keep each angle distinguishable from 'front'.
#
# The vertical gates in particular must demand a REAL tilt. An earlier cut
# accepted anything past -3/-4 degrees of pitch for 'up' and 'left_up', which
# is a head barely off level — users reported looking *down* and still being
# accepted. Two effects combine there:
#   * a webcam sits below the face, so a level head already reads several
#     degrees "up"; and
#   * the reference photo for 'up' is itself a very mild example (-4 deg), so
#     calibrating to it bakes the problem in.
# 'front' is therefore held to +/-10 as well: passing step 1 forces the user
# into a canonical head position, which cancels much of the camera offset
# before any of the tilted angles are measured.
POSE_RANGES_MP = {
    'front':     {'yaw': (-18, 18),  'pitch': (-10, 10)},
    'left':      {'yaw': (-75, -15), 'pitch': (-25, 25)},
    'right':     {'yaw': (15, 75),   'pitch': (-25, 25)},
    'up':        {'yaw': (-20, 20),  'pitch': (-45, -15)},
    'up_deep':   {'yaw': (-20, 20),  'pitch': (-55, -22)},
    # Combined turn+tilt is harder to hold, so each axis is a little looser
    # than the single-axis equivalent — but still well clear of level.
    'left_up':   {'yaw': (-75, -12), 'pitch': (-48, -12)},
    'right_up':  {'yaw': (12, 75),   'pitch': (-48, -12)},
    'down':      {'yaw': (-20, 20),  'pitch': (10, 45)},
}


def pose_from_transform_matrix(matrix) -> dict:
    """Real head pose from MediaPipe's facial transformation matrix (a PnP fit
    of the canonical face mesh to observed landmarks), vs. the old 2-point
    trig approximation. 'yxz' Euler order isolates yaw (rotation about the
    vertical axis) into the first component and pitch into the second for
    the single-axis poses this app asks for — verified against all 8
    reference angles (see calibration comment above)."""
    R = np.array(matrix)[:3, :3]
    yaw, pitch, roll = Rotation.from_matrix(R).as_euler('yxz', degrees=True)
    return {"yaw": round(float(yaw), 1), "pitch": round(float(pitch), 1), "roll": round(float(roll), 1)}


# ── Geometry helpers (same semantics as face_quality_service.py's originals,
# fed by MediaPipe's bbox/landmarks instead of InsightFace's) ────────────────

EDGE_MARGIN_PCT = 0.02
FACE_CENTER_TOLERANCE = 0.30
MIN_FACE_SIZE_PCT = 0.08
GOOD_FACE_SIZE_PCT = 0.10
MAX_FACE_SIZE_PCT = 0.40

# Canonical MediaPipe Face Mesh landmark indices (stable across the 468/478
# point topology) used for precise patch placement — far more precise than
# the old 5-point guesses.
LM_LEFT_EYE_OUTER, LM_LEFT_EYE_INNER = 263, 362
LM_RIGHT_EYE_OUTER, LM_RIGHT_EYE_INNER = 33, 133
LM_LEFT_IRIS, LM_RIGHT_IRIS = 468, 473  # present when num_landmarks == 478
LM_NOSE_TIP = 1
LM_MOUTH_LEFT, LM_MOUTH_RIGHT = 61, 291
LM_UPPER_LIP, LM_LOWER_LIP = 13, 14
LM_CHIN = 152
LM_FOREHEAD = 10
LM_CHEEK = 205


def face_size_score(bbox, img_h, img_w) -> float:
    x1, y1, x2, y2 = bbox
    return float(min(max(0, x2 - x1) * max(0, y2 - y1) / (img_h * img_w), 1.0))


def face_fully_visible(bbox, img_h, img_w) -> bool:
    x1, y1, x2, y2 = bbox
    mx, my = img_w * EDGE_MARGIN_PCT, img_h * EDGE_MARGIN_PCT
    return x1 > mx and y1 > my and x2 < (img_w - mx) and y2 < (img_h - my)


def face_center_offset(bbox, img_h, img_w) -> dict:
    x1, y1, x2, y2 = bbox
    return {
        "x": round(float(((x1 + x2) / 2 - img_w / 2) / img_w), 3),
        "y": round(float(((y1 + y2) / 2 - img_h / 2) / img_h), 3),
    }


def _px(landmarks, idx, img_w, img_h):
    p = landmarks[idx]
    return (p.x * img_w, p.y * img_h)


def landmarks_suggest_partial_face(landmarks, img_w, img_h) -> bool:
    """Same eye-width/mouth-width asymmetry idea as the old 5-point version,
    now measured from precise canonical eye/mouth corner landmarks."""
    lo = _px(landmarks, LM_LEFT_EYE_OUTER, img_w, img_h)
    ro = _px(landmarks, LM_RIGHT_EYE_OUTER, img_w, img_h)
    lm = _px(landmarks, LM_MOUTH_LEFT, img_w, img_h)
    rm = _px(landmarks, LM_MOUTH_RIGHT, img_w, img_h)
    eye_width = abs(ro[0] - lo[0])
    mouth_width = abs(rm[0] - lm[0])
    if eye_width < 1 or mouth_width < 1:
        return True
    ratio = eye_width / mouth_width
    return ratio < 0.35 or ratio > 3.0


def _patch_stats(img_bgr, cx, cy, half_w, half_h, img_h, img_w):
    x1, x2 = max(0, int(cx - half_w)), min(img_w, int(cx + half_w))
    y1, y2 = max(0, int(cy - half_h)), min(img_h, int(cy + half_h))
    if x2 <= x1 or y2 <= y1:
        return None
    patch = img_bgr[y1:y2, x1:x2]
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    min_val, max_val = float(np.min(gray)), float(np.max(gray))
    return {
        "brightness": float(np.mean(gray) / 255.0),
        "variance": float(np.var(gray)),
        "min": min_val, "max": max_val, "contrast": max_val - min_val,
        "hue": float(np.mean(hsv[:, :, 0])), "sat": float(np.mean(hsv[:, :, 1])),
    }


def detect_sunglasses(img_bgr, landmarks, img_w, img_h) -> bool:
    """Opaque dark lenses over both eyes, anchored on MediaPipe's iris
    landmarks (468/473).

    Keyed on LOCAL CONTRAST inside each eye patch, not on how dark the eyes
    are relative to the cheek. Measured on real glasses-free faces, the eye
    region is naturally 0.14-0.28 darker than the cheek (brow shadow, lashes,
    pupil), so a brightness-gap test fires on ordinary faces and was only held
    back by a variance threshold that anything dim, blurry or small slipped
    under — which is how a bare-faced user under harsh overhead lighting got
    told to remove sunglasses they were not wearing.

    Contrast separates the two cases with a wide margin: an eye showing any
    sclera/pupil at all measures 60+, while an opaque lens measures under 15
    even after downscaling to the live preview's 320px width. Thresholds sit
    in that gap and BOTH eyes must qualify.

    Deliberately biased toward missing real sunglasses rather than blocking a
    legitimate user: lightly tinted or clear lenses are not detected here and
    are left to capture-time HR review.
    """
    l_iris = _px(landmarks, LM_LEFT_IRIS, img_w, img_h)
    r_iris = _px(landmarks, LM_RIGHT_IRIS, img_w, img_h)
    lo = _px(landmarks, LM_LEFT_EYE_OUTER, img_w, img_h)
    ro = _px(landmarks, LM_RIGHT_EYE_OUTER, img_w, img_h)
    eye_width = abs(ro[0] - lo[0])
    if eye_width < 12:
        # Too few pixels across the eye to measure texture — don't guess.
        return False
    half = max(4.0, eye_width * 0.22)

    l_eye = _patch_stats(img_bgr, l_iris[0], l_iris[1], half, half * 0.6, img_h, img_w)
    r_eye = _patch_stats(img_bgr, r_iris[0], r_iris[1], half, half * 0.6, img_h, img_w)
    cheek_pt = _px(landmarks, LM_CHEEK, img_w, img_h)
    cheek = _patch_stats(img_bgr, cheek_pt[0], cheek_pt[1], half, half, img_h, img_w)
    if not l_eye or not r_eye or not cheek:
        return False

    both_flat = max(l_eye["contrast"], r_eye["contrast"]) < 40
    both_dark = max(l_eye["brightness"], r_eye["brightness"]) < 0.25
    darker_than_skin = ((l_eye["brightness"] + r_eye["brightness"]) / 2) < (cheek["brightness"] - 0.15)
    return both_flat and both_dark and darker_than_skin


def detect_mask(img_bgr, landmarks, bbox, img_w, img_h) -> bool:
    """Lower-face color/texture diverging from forehead skin — same technique,
    anchored on precise mouth-corner/nose-tip/chin landmarks."""
    nose = _px(landmarks, LM_NOSE_TIP, img_w, img_h)
    lmouth = _px(landmarks, LM_MOUTH_LEFT, img_w, img_h)
    rmouth = _px(landmarks, LM_MOUTH_RIGHT, img_w, img_h)
    chin = _px(landmarks, LM_CHIN, img_w, img_h)
    forehead = _px(landmarks, LM_FOREHEAD, img_w, img_h)
    x1, y1, x2, y2 = bbox

    mouth_mid_x = (lmouth[0] + rmouth[0]) / 2
    mouth_width = abs(rmouth[0] - lmouth[0])
    half_w = max(6.0, mouth_width * 0.9)
    lower_face_y = (nose[1] + chin[1]) / 2
    half_h = max(6.0, (chin[1] - nose[1]) * 0.35)

    lower = _patch_stats(img_bgr, mouth_mid_x, lower_face_y, half_w, half_h, img_h, img_w)
    fh = _patch_stats(img_bgr, forehead[0], forehead[1], half_w, half_h * 0.6, img_h, img_w)
    if not lower or not fh:
        return False

    # Requires the lower face to be BOTH clearly off-colour from the forehead
    # and markedly flatter than skin. The looser original (hue>18 or sat>40,
    # variance<300) fired in dim lighting, where overall variance falls and
    # colour readings drift — the bar is raised so only genuinely uniform
    # fabric qualifies. Beards, stubble and lip texture all keep variance well
    # above this floor.
    hue_diff = abs(lower["hue"] - fh["hue"])
    sat_diff = abs(lower["sat"] - fh["sat"])
    return (hue_diff > 25 or sat_diff > 55) and lower["variance"] < 150


def detect_face_occlusion(img_bgr, landmarks, bbox, img_w, img_h, pose=None) -> bool:
    """Hand/object occlusion — same checks as the InsightFace version
    (geometry anomaly, eye-patch pupil/contrast, mouth-patch darkness), fed
    by precise landmarks instead of 5-point estimates.

    The geometry-anomaly ratio check assumes a roughly frontal face — real
    perspective foreshortening at genuine yaw/pitch (measured against
    MediaPipe's precise landmarks, e.g. ~50 deg for this app's 'left'/'right'
    steps or ~25 deg for 'up_deep') pushes eye/nose/mouth distance ratios
    outside the same range an occluded face would, so it's skipped for
    intentionally angled captures and left to the appearance-based checks
    below, which don't depend on frontal geometry and caught nothing false
    at any tested angle.
    """
    leye = _px(landmarks, LM_LEFT_IRIS, img_w, img_h)
    reye = _px(landmarks, LM_RIGHT_IRIS, img_w, img_h)
    nose = _px(landmarks, LM_NOSE_TIP, img_w, img_h)
    lmouth = _px(landmarks, LM_MOUTH_LEFT, img_w, img_h)
    rmouth = _px(landmarks, LM_MOUTH_RIGHT, img_w, img_h)
    x1, y1, x2, y2 = bbox

    eye_dist = max(1.0, float(np.hypot(reye[0] - leye[0], reye[1] - leye[1])))
    eye_mid = ((leye[0] + reye[0]) / 2.0, (leye[1] + reye[1]) / 2.0)
    mouth_mid = ((lmouth[0] + rmouth[0]) / 2.0, (lmouth[1] + rmouth[1]) / 2.0)
    nose_to_eye = max(1.0, float(np.hypot(nose[0] - eye_mid[0], nose[1] - eye_mid[1])))
    eye_to_mouth = max(1.0, float(np.hypot(mouth_mid[0] - eye_mid[0], mouth_mid[1] - eye_mid[1])))

    is_angled = pose is not None and (abs(pose.get('yaw', 0)) > 20 or abs(pose.get('pitch', 0)) > 18)
    if not is_angled:
        ratio_en = eye_dist / nose_to_eye
        ratio_em = eye_dist / eye_to_mouth
        if ratio_en < 0.65 or ratio_en > 2.8 or ratio_em < 0.6 or ratio_em > 2.3:
            return True

    half_w, half_h = max(5.0, eye_dist * 0.22), max(5.0, eye_dist * 0.18)
    l_eye = _patch_stats(img_bgr, leye[0], leye[1], half_w, half_h, img_h, img_w)
    r_eye = _patch_stats(img_bgr, reye[0], reye[1], half_w, half_h, img_h, img_w)

    # Thresholds sit well clear of what real eyes measure. Sampled on
    # glasses-free faces (including heavily shadowed and blurred variants),
    # a visible eye reads contrast 60+, variance 165+ and min under ~60; a
    # covering hand or object reads far flatter. The original numbers here
    # (contrast 45 / variance 140-180 / min 95) sat close enough to the real-eye
    # floor that a dim or low-resolution frame tripped them, so they are pulled
    # down into the gap. Missing a marginal hand-over-eyes is preferable to
    # blocking a legitimate user — gross occlusions still fail the geometry and
    # mouth checks around this block.
    #
    # Skipped entirely on the deliberately angled captures for the same reason
    # the geometry check above is: at the yaw this app asks for on left/right
    # (~50 deg) the far eye is foreshortened, self-shadowed and only a few
    # pixels wide, so its texture readings say nothing reliable about occlusion.
    if l_eye and r_eye and not is_angled:
        if (l_eye["min"] > 120 and r_eye["min"] > 120) or (l_eye["contrast"] < 30 and r_eye["contrast"] < 30):
            return True
        avg_eye_var = (l_eye["variance"] + r_eye["variance"]) / 2.0
        if avg_eye_var < 70:
            return True

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
            if mouth_patch["min"] > 90:
                return True

    # The InsightFace version had a fourth check here: strong horizontal Sobel
    # energy across the upper face, guarded by eye variance < 180, meant to
    # catch the edge of a hand. It is removed rather than retuned — it fires on
    # any strong horizontal edge (brow line, hair, spectacle frame, a hard
    # shadow), and its guard sat essentially on top of what a real shadowed eye
    # measures (~167), so ordinary faces in unlucky lighting were flagged as
    # occluded. Simulated hands over the eyes are still caught by the geometry
    # and eye-flatness checks above.
    return False


def laplacian_sharpness(gray) -> float:
    return float(min(cv2.Laplacian(gray, cv2.CV_64F).var() / 300.0, 1.0))


def brightness_score(gray) -> float:
    return float(np.mean(gray) / 255.0)


def combine_score(det_score, sharpness, brightness, face_size, pose, angle='',
                   fully_visible=True, partial_face=False, glasses_detected=False,
                   mask_detected=False, occlusion_detected=False,
                   multiple_faces_detected=False, face_offset=None) -> float:
    """Same weights/vetoes as face_quality_service.py's combine_score() —
    only the inputs feeding it changed. See POSE_RANGES_MP for why the
    per-angle yaw/pitch numbers differ from the InsightFace version."""
    if not fully_visible or partial_face or glasses_detected or mask_detected or occlusion_detected or multiple_faces_detected:
        return 0.0
    if face_size < MIN_FACE_SIZE_PCT or face_size > MAX_FACE_SIZE_PCT:
        return 0.0
    if face_offset is not None and angle and angle.lower() == 'front':
        if abs(face_offset.get('x', 0)) > FACE_CENTER_TOLERANCE or abs(face_offset.get('y', 0)) > FACE_CENTER_TOLERANCE:
            return 0.0

    # No angle named means the caller is not running the enrollment wizard
    # (e.g. Transport's passenger matching posts a bare crop) and has no target
    # pose to be held to — score it on image quality alone rather than silently
    # applying the 'front' gate, which would zero out any non-frontal face.
    # Matches the InsightFace path's `if angle:` behaviour.
    ranges = POSE_RANGES_MP.get((angle or '').lower())
    if ranges is None:
        return round(float(0.35 * det_score + 0.30 * sharpness +
                           0.15 * max(0.0, min(1.0, 1.0 - abs(brightness - 0.5) * 1.5)) +
                           0.10 * min(face_size / GOOD_FACE_SIZE_PCT, 1.0) +
                           0.10), 4)

    yaw, pitch = pose.get("yaw", 0), pose.get("pitch", 0)
    (yaw_lo, yaw_hi), (pitch_lo, pitch_hi) = ranges['yaw'], ranges['pitch']

    if not (yaw_lo <= yaw <= yaw_hi) or not (pitch_lo <= pitch <= pitch_hi):
        return 0.0

    # Soft component: full marks mid-range, tapering toward the edges. Being
    # in range is the actual requirement, so this only nudges the score.
    def _centrality(v, lo, hi):
        half = max((hi - lo) / 2.0, 1e-6)
        return min(1.0, abs(v - (lo + hi) / 2.0) / half)

    deviation = max(_centrality(yaw, yaw_lo, yaw_hi), _centrality(pitch, pitch_lo, pitch_hi))
    pose_score = max(0.0, 1.0 - 0.3 * deviation)

    bri_score = max(0.0, min(1.0, 1.0 - abs(brightness - 0.5) * 1.5))

    score = (0.35 * det_score + 0.30 * sharpness + 0.15 * bri_score +
             0.10 * min(face_size / GOOD_FACE_SIZE_PCT, 1.0) + 0.10 * pose_score)
    return round(float(score), 4)


def score_quality(img_bgr, angle: str) -> dict:
    """Full MediaPipe-engine equivalent of face_quality_service.py's /quality
    handler body. Returns the same field set (minus `embedding`, which stays
    InsightFace-only via /embed — see module docstring)."""
    img_h, img_w = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    sharpness = laplacian_sharpness(gray)
    brightness = brightness_score(gray)

    if face_detector is None or face_landmarker is None:
        score = round((sharpness * 0.5 + brightness * 0.5) * 0.75, 4)
        return {
            "confidence": score, "face_detected": False, "multiple_faces_detected": False,
            "det_score": 0.0, "sharpness": round(sharpness, 4), "brightness": round(brightness, 4),
            "face_size_pct": 0.0, "pose": {}, "note": "model_unavailable_heuristic",
        }

    mp_img = _mp_image(img_bgr)
    det_result = face_detector.detect(mp_img)
    lm_result = face_landmarker.detect(mp_img)

    if not det_result.detections or not lm_result.face_landmarks:
        return {
            "confidence": 0.0, "face_detected": False, "multiple_faces_detected": False,
            "det_score": 0.0, "sharpness": round(sharpness, 4), "brightness": round(brightness, 4),
            "face_size_pct": 0.0, "pose": {},
        }

    multiple_faces_detected = len(det_result.detections) > 1

    def det_area(d):
        bb = d.bounding_box
        return bb.width * bb.height

    largest_det = max(det_result.detections, key=det_area)
    bb = largest_det.bounding_box
    bbox = (bb.origin_x, bb.origin_y, bb.origin_x + bb.width, bb.origin_y + bb.height)
    det_score = float(largest_det.categories[0].score) if largest_det.categories else 0.8

    def lm_area(lms):
        xs = [p.x for p in lms]; ys = [p.y for p in lms]
        return (max(xs) - min(xs)) * (max(ys) - min(ys))

    landmarks = max(lm_result.face_landmarks, key=lm_area)
    matrix_idx = lm_result.face_landmarks.index(landmarks)
    pose = (pose_from_transform_matrix(lm_result.facial_transformation_matrixes[matrix_idx])
            if matrix_idx < len(lm_result.facial_transformation_matrixes) else {"yaw": 0.0, "pitch": 0.0, "roll": 0.0})

    face_size = face_size_score(bbox, img_h, img_w)
    fully_visible = face_fully_visible(bbox, img_h, img_w)
    partial_face = landmarks_suggest_partial_face(landmarks, img_w, img_h)
    glasses_detected = detect_sunglasses(img_bgr, landmarks, img_w, img_h)
    mask_detected = detect_mask(img_bgr, landmarks, bbox, img_w, img_h)
    occlusion_detected = detect_face_occlusion(img_bgr, landmarks, bbox, img_w, img_h, pose=pose)
    offset = face_center_offset(bbox, img_h, img_w)

    confidence = combine_score(
        det_score, sharpness, brightness, face_size, pose, angle,
        fully_visible=fully_visible, partial_face=partial_face,
        glasses_detected=glasses_detected, mask_detected=mask_detected,
        occlusion_detected=occlusion_detected,
        multiple_faces_detected=multiple_faces_detected, face_offset=offset,
    )

    return {
        "confidence": confidence, "face_detected": True,
        "multiple_faces_detected": multiple_faces_detected,
        "fully_visible": fully_visible, "partial_face": partial_face,
        "glasses_detected": glasses_detected, "mask_detected": mask_detected,
        "occlusion_detected": occlusion_detected,
        "det_score": round(det_score, 4), "sharpness": round(sharpness, 4),
        "brightness": round(brightness, 4), "face_size_pct": round(face_size, 4),
        "pose": pose, "face_center_offset": offset,
        "model_version": "mediapipe-face_landmarker_v2",
    }
