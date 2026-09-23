import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, CheckCircle2, XCircle, Loader2, RefreshCw, ChevronRight, AlertTriangle, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, ArrowUpLeft, ArrowUpRight } from 'lucide-react';
import { cn } from '../ui/utils';
import { authConfig } from '../../config/authConfig';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { ConsentStep } from './ConsentStep';
import FaceMeshOverlay from './FaceMeshOverlay';

const ANGLES = [
  { id: 'front', label: 'Front', hint: 'Look straight at the camera' },
  { id: 'left',  label: 'Left',  hint: 'Turn your face to the left'  },
  { id: 'right', label: 'Right', hint: 'Turn your face to the right' },
  { id: 'up',    label: 'Up',    hint: 'Tilt your head slightly up'  },
  { id: 'up_deep', label: 'Look Up High', hint: 'Tilt your head significantly up towards the ceiling' },
  { id: 'left_up', label: 'Left-Up', hint: 'Turn your face to the left and tilt up' },
  { id: 'right_up', label: 'Right-Up', hint: 'Turn your face to the right and tilt up' },
  { id: 'down',  label: 'Down',  hint: 'Tilt your head slightly down'},
];

// Real reference photos (one per angle) showing HR exactly how the pose
// should look — served as static files so the ~450KB source PNGs (compressed
// to ~12KB JPEGs) don't bloat the JS bundle.
const REFERENCE_PHOTOS: Record<string, string> = {
  front: '/enrollment-references/front.jpg',
  left: '/enrollment-references/left.jpg',
  right: '/enrollment-references/right.jpg',
  up: '/enrollment-references/up.jpg',
  up_deep: '/enrollment-references/up_deep.jpg',
  left_up: '/enrollment-references/left_up.jpg',
  right_up: '/enrollment-references/right_up.jpg',
  down: '/enrollment-references/down.jpg',
};

// Accepted yaw/pitch RANGES (degrees) per angle, as [min, max].
//
// ⚠️ These MUST stay in sync with POSE_RANGES_MP in
// backend/api/scripts/mediapipe_engine.py — the same calibration duplicated
// across the language boundary, and the values below gate whether the Capture
// button can be pressed at all. If you change one side, change the other.
//
// Ranges rather than target±tolerance on purpose: enrollment needs a spread of
// clearly distinct poses, not an exact number of degrees. Narrow bands fitted
// to the reference photos rejected people who turned or tilted more than the
// (fairly mild) reference shots — e.g. anyone genuinely looking up, since
// up.jpg reads only ≈-4° of pitch. Generous at the far end; tight only at the
// near end, where each angle has to stay distinguishable from "front".
// The vertical gates demand a real tilt, not a few degrees off level: a webcam
// sits below the face so a level head already reads slightly "up", and an
// earlier cut accepting pitch past -3°/-4° let users look *down* and still be
// told the pose was correct. "front" is held to ±10° for the same reason —
// clearing step 1 pins the user to a canonical head position, cancelling much
// of the camera's vertical offset before the tilted angles are measured.
export const POSE_RANGES: Record<string, { yaw: [number, number]; pitch: [number, number] }> = {
  front:    { yaw: [-18, 18],  pitch: [-10, 10] },
  left:     { yaw: [-75, -15], pitch: [-25, 25] },
  right:    { yaw: [15, 75],   pitch: [-25, 25] },
  up:       { yaw: [-20, 20],  pitch: [-45, -15] },
  up_deep:  { yaw: [-20, 20],  pitch: [-55, -22] },
  left_up:  { yaw: [-75, -12], pitch: [-48, -12] },
  right_up: { yaw: [12, 75],   pitch: [-48, -12] },
  down:     { yaw: [-20, 20],  pitch: [10, 45] },
};

// Centering tolerance: for the FRONT angle the face must be within ±30% of
// the frame center. For side/up/down we allow drift up to ±40%.
const CENTER_TOL_FRONT = 0.30;
const CENTER_TOL_SIDE  = 0.40;

// Face size thresholds — must mirror face_quality_service.py constants.
// AdaFace embeddings degrade rapidly when the face covers less than ~8-10%
// of the image; anything below 8% is a hard fail, above 40% the face is
// too close and likely clipped at the edges.
const MIN_FACE_SIZE_PCT  = 0.08;  // hard fail → "come closer"
const GOOD_FACE_SIZE_PCT = 0.10;  // score penalty zone → encourage closer
const MAX_FACE_SIZE_PCT  = 0.40;  // hard fail → "step back"

// Exported so tests exercise this exact implementation. A test that copies the
// logic instead only guards its own copy — which is how the pose calibration
// came to exist in three places and drift.
export function getPoseSuggestion(angleId: string, pose: { yaw?: number; pitch?: number } | null | undefined, faceOffset?: { x?: number; y?: number } | null): string | null {
  if (!pose) return null;
  const range = POSE_RANGES[angleId];
  if (!range || typeof pose.yaw !== 'number' || typeof pose.pitch !== 'number') return null;

  const [yawLo, yawHi]     = range.yaw;
  const [pitchLo, pitchHi] = range.pitch;
  const messages: string[] = [];

  // Check face position in frame first
  if (faceOffset) {
    const tol = angleId === 'front' ? CENTER_TOL_FRONT : CENTER_TOL_SIDE;
    if (Math.abs((faceOffset.x ?? 0)) > tol) {
      messages.push((faceOffset.x ?? 0) > 0 ? 'move slightly left in the frame' : 'move slightly right in the frame');
    }
    if (Math.abs((faceOffset.y ?? 0)) > tol) {
      messages.push((faceOffset.y ?? 0) > 0 ? 'move up in the frame' : 'move down in the frame');
    }
  }

  // Yaw is negative when turned left, so falling above the range means "not
  // far enough left / too far right" and vice versa.
  if (pose.yaw > yawHi)      messages.push('turn a little more to your left');
  else if (pose.yaw < yawLo) messages.push('turn a little more to your right');

  // Pitch is negative when looking up.
  if (pose.pitch > pitchHi)      messages.push('tilt your head up a bit');
  else if (pose.pitch < pitchLo) messages.push('tilt your head down a bit');

  return messages.length ? `Please ${messages.join(', and ')}` : null;
}

interface EnrollmentData {
  employeeName: string;
  employeeCode: string;
  status: string;
}

interface CapturedPhoto {
  blob: Blob;
  objectUrl: string;             // local preview URL
  quality: number | null;        // null = AdaFace svc was down
  face_detected: boolean | null;
  multiple_faces_detected: boolean | null;
  uploading: boolean;
  quality_meta?: {
    face_detected?: boolean;
    multiple_faces_detected?: boolean;
    fully_visible?: boolean;
    partial_face?: boolean;
    glasses_detected?: boolean;
    mask_detected?: boolean;
    occlusion_detected?: boolean;
    det_score?: number;
    sharpness?: number;
    brightness?: number;
    face_size_pct?: number;
    face_center_offset?: { x: number; y: number };
    pose?: { yaw: number; pitch: number; roll: number };
    note?: string;
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function qualityColor(q: number | null) {
  if (q === null) return 'text-slate-400';
  if (q >= 0.75) return 'text-green-600';
  if (q >= 0.55) return 'text-yellow-500';
  return 'text-red-500';
}

function QualityBadge({ photo }: { photo: CapturedPhoto | undefined }) {
  if (!photo) return null;
  if (photo.uploading) return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
      <Loader2 className="w-3 h-3 animate-spin" /> Analyzing…
    </span>
  );
  if (photo.quality === null) return (
    <span className="text-xs text-slate-400">No score</span>
  );
  const pct = Math.round(photo.quality * 100);
  return (
    <span className={cn('text-xs font-semibold', qualityColor(photo.quality))}>
      {pct}%
    </span>
  );
}

function getFeedbackTips(photo: CapturedPhoto, angleId: string) {
  const tips: string[] = [];
  if (photo.multiple_faces_detected || photo.quality_meta?.multiple_faces_detected) {
    tips.push("Multiple people detected in the frame. Only one person should be in the photo.");
    return tips;
  }
  if (photo.face_detected === false) {
    tips.push("Make sure your face is fully visible in the oval frame.");
    return tips;
  }

  const meta = photo.quality_meta;
  if (meta?.fully_visible === false) {
    tips.push("Your face is cropped at the edge of the frame. Step back or center yourself and retake.");
    return tips;
  }
  if (meta?.partial_face) {
    tips.push("Part of your face looks hidden or turned away. Face the camera directly and retake.");
    return tips;
  }
  if (meta?.glasses_detected) {
    tips.push("Sunglasses or tinted glasses detected. Please remove them and retake — they interfere with face matching.");
    return tips;
  }
  if (meta?.mask_detected) {
    tips.push("A mask or face covering was detected. Please remove it and retake — your full face is needed for enrollment.");
    return tips;
  }
  if (meta?.occlusion_detected) {
    tips.push("Hand or object covering your face detected. Please clear your face completely and retake.");
    return tips;
  }
  if (!meta) return tips;

  if (meta.pose) {
    const poseSuggestion = getPoseSuggestion(angleId, meta.pose);
    if (poseSuggestion) {
      tips.push(poseSuggestion + " and retake.");
    }
  }

  if (meta.face_size_pct !== undefined) {
    if (meta.face_size_pct < GOOD_FACE_SIZE_PCT) {
      tips.push("📏 You are too far from the camera. Move closer for a better quality embedding.");
    } else if (meta.face_size_pct > MAX_FACE_SIZE_PCT) {
      tips.push("📏 You are too close. Step back slightly to avoid clipping.");
    }
  }

  if (meta.brightness !== undefined) {
    if (meta.brightness < 0.35) {
      tips.push("💡 Lighting is too dim. Find a brighter spot or face a light.");
    } else if (meta.brightness > 0.70) {
      tips.push("☀️ Lighting is too harsh or backlit. Move away from bright background light.");
    }
  }

  if (meta.sharpness !== undefined && meta.sharpness < 0.20) {
    tips.push("📷 Image is blurry. Hold your device steady and tap to focus.");
  }

  return tips;
}

function QualityCircularProgress({ quality, size = 50 }: { quality: number | null, size?: number }) {
  if (quality === null) return (
    <div className="w-[50px] h-[50px] rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-[10px] text-slate-400 font-bold shadow-inner">
      N/A
    </div>
  );

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (quality * circumference);
  const pct = Math.round(quality * 100);

  let strokeColor = 'stroke-rose-500';
  let textColor = 'text-rose-400';
  
  if (quality >= 0.75) {
    strokeColor = 'stroke-emerald-500';
    textColor = 'text-emerald-400';
  } else if (quality >= 0.55) {
    strokeColor = 'stroke-amber-500';
    textColor = 'text-amber-400';
  }

  return (
    <div className="relative flex items-center justify-center shadow-lg rounded-full bg-slate-900/40 p-0.5 border border-slate-800" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          className="stroke-slate-800"
          strokeWidth="3.5"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        <circle
          className={cn("transition-all duration-1000 ease-out", strokeColor)}
          strokeWidth="3.5"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
      </svg>
      <span className={cn("absolute text-xs font-black tracking-tighter", textColor)}>
        {pct}%
      </span>
    </div>
  );
}

const BiometricStyles = () => (
  <style dangerouslySetInnerHTML={{ __html: `
    @keyframes biometric-scanner {
      0% { top: 10%; opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { top: 90%; opacity: 0; }
    }
    @keyframes pulse-glow {
      0%, 100% { border-color: rgba(255, 255, 255, 0.2); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
      50% { border-color: rgba(59, 130, 246, 0.7); box-shadow: 0 0 15px 2px rgba(59, 130, 246, 0.3); }
    }
    @keyframes float-up {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-6px); }
    }
    @keyframes float-down {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(6px); }
    }
    @keyframes float-left {
      0%, 100% { transform: translateX(0); }
      50% { transform: translateX(-6px); }
    }
    @keyframes float-right {
      0%, 100% { transform: translateX(0); }
      50% { transform: translateX(6px); }
    }
    @keyframes float-diag-l {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(-5px, -5px); }
    }
    @keyframes float-diag-r {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(5px, -5px); }
    }
    .biometric-scanner-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, transparent, #3b82f6, #60a5fa, #3b82f6, transparent);
      box-shadow: 0 0 10px #60a5fa;
      animation: biometric-scanner 2.5s infinite linear;
    }
    .oval-glow {
      animation: pulse-glow 2.5s infinite ease-in-out;
    }
    .animate-float-up { animation: float-up 1.5s infinite ease-in-out; }
    .animate-float-down { animation: float-down 1.5s infinite ease-in-out; }
    .animate-float-left { animation: float-left 1.5s infinite ease-in-out; }
    .animate-float-right { animation: float-right 1.5s infinite ease-in-out; }
    .animate-float-diag-l { animation: float-diag-l 1.5s infinite ease-in-out; }
    .animate-float-diag-r { animation: float-diag-r 1.5s infinite ease-in-out; }
    .glass-card {
      background: rgba(15, 23, 42, 0.7) !important;
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.5);
    }
    .welcome-bg {
      background: radial-gradient(circle at top, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.95));
    }
    .welcome-card-glow {
      position: relative;
    }
    .welcome-card-glow::before {
      content: '';
      position: absolute;
      inset: -1px;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), transparent, rgba(16, 185, 129, 0.2));
      border-radius: 12px;
      z-index: -1;
      padding: 1px;
      pointer-events: none;
    }
  ` }} />
);

const AngleVisualGuide: React.FC<{ angleId: string }> = ({ angleId }) => {
  const photo = REFERENCE_PHOTOS[angleId];
  if (!photo) return null;

  return (
    <div className="absolute top-4 right-4 z-20 flex flex-col items-center gap-1.5 p-2 rounded-xl bg-slate-950/90 border border-slate-800 backdrop-blur-md shadow-2xl w-[90px] pointer-events-none">
      <p className="text-[8px] font-black tracking-widest text-blue-400 uppercase">Reference</p>
      <div className="w-20 h-20 relative rounded-lg border border-slate-800 overflow-hidden shadow-inner">
        <img src={photo} alt={`Example ${angleId} pose`} className="w-full h-full object-cover" />
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const SelfEnrollmentPortal: React.FC<{ token: string }> = ({ token }) => {
  const [step, setStep] = useState<'loading'|'welcome'|'consent'|'capture'|'review'|'complete'|'error'>('loading');
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [currentAngleIdx, setCurrentAngleIdx] = useState(0);
  const [photos, setPhotos] = useState<Record<string, CapturedPhoto>>({});
  const [cameraActive, setCameraActive] = useState(false);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [poseHint, setPoseHint] = useState<{ message: string; ok: boolean; liveScore?: number; centerOffset?: { x: number; y: number }; faceSizePct?: number; pose?: { yaw?: number; pitch?: number } } | null>(null);

  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const poseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const poseCheckInFlightRef = useRef(false);

  // Derived constants — declared before any hooks that reference them
  const currentAngle   = ANGLES[currentAngleIdx];
  const currentPhoto   = photos[currentAngle.id];
  const allCaptured    = ANGLES.every(a => photos[a.id] && !photos[a.id].uploading);
  const anyUploading   = ANGLES.some(a => photos[a.id]?.uploading);
  const scoredQualities = ANGLES.map(a => photos[a.id]?.quality).filter((q): q is number => typeof q === 'number');
  const avgQuality     = scoredQualities.length
    ? scoredQualities.reduce((s, q) => s + q, 0) / scoredQualities.length : null;

  useEffect(() => {
    validateToken();
    return () => stopCamera();
  }, []);

  // ── Token validation ───────────────────────────────────────────────────────
  async function validateToken() {
    try {
      const res = await fetch(`${authConfig.apiBaseUrl}/enroll/${token}`);
      if (!res.ok) { setStep('error'); setErrorMsg('Invalid or expired enrollment link.'); return; }
      const data = await res.json();
      setEnrollmentData(data);
      if (data.status === 'completed') {
        setStep('error'); setErrorMsg('This enrollment link has already been completed.');
      } else if (data.status === 'expired') {
        setStep('error'); setErrorMsg('This enrollment link has expired. Please contact HR for a new link.');
      } else if (data.status === 'superseded') {
        setStep('error'); setErrorMsg('A newer invitation link was sent to you. Please use the most recent email, or contact HR.');
      } else {
        setStep('welcome');
      }
    } catch {
      setStep('error'); setErrorMsg('Failed to validate enrollment link. Check your internet connection.');
    }
  }

  // ── Camera helpers ─────────────────────────────────────────────────────────
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error('Camera not available', {
        description: !window.isSecureContext
          ? 'Camera requires HTTPS.' : 'Browser does not support camera API.',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (videoRef.current) { videoRef.current.srcObject = stream; streamRef.current = stream; }
      setCameraActive(true);
    } catch (err: any) {
      const msgs: Record<string,string> = {
        NotAllowedError: 'Camera permission denied — enable it in browser settings.',
        NotFoundError:   'No camera found on this device.',
      };
      toast.error('Camera access denied', { description: msgs[err.name] ?? 'Please allow camera access.' });
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }

  // ── Capture + upload (score is returned immediately from AdaFace quality service) ──
  async function capturePhoto() {
    if (!videoRef.current || !canvasRef.current) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    // Front-facing cameras output a mirrored stream in most browsers.
    // Flip the canvas horizontally so the stored image is in the actual
    // camera orientation — matching what the Jetson attendance camera sees.
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    ctx.restore();

    canvas.toBlob(async (blob) => {
      if (!blob) { toast.error('Failed to capture photo'); return; }

      const angle = ANGLES[currentAngleIdx].id;
      const objectUrl = URL.createObjectURL(blob);

      // Show placeholder immediately so the user sees their photo
      setPhotos(prev => ({
        ...prev,
        [angle]: { blob, objectUrl, quality: null, face_detected: null, multiple_faces_detected: null, uploading: true },
      }));

      try {
        const form = new FormData();
        form.append('photo', blob, `${angle}.jpg`);
        form.append('angle', angle);

        const res = await fetch(`${authConfig.apiBaseUrl}/enroll/${token}/upload-angle`, {
          method: 'POST', body: form,
        });
        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();

        const quality: number | null = typeof data.quality === 'number' ? data.quality : null;
        const faceDetected: boolean | null = data.face_detected ?? null;
        const multipleFacesDetected: boolean | null = data.multiple_faces_detected ?? null;
        const qualityMeta = data.quality_meta || {};

        console.log("[enrollment] capture quality:", quality, "faceDetected:", faceDetected, "multipleFaces:", multipleFacesDetected);

        setPhotos(prev => ({
          ...prev,
          [angle]: { 
            ...prev[angle], 
            quality, 
            face_detected: faceDetected, 
            multiple_faces_detected: multipleFacesDetected,
            uploading: false,
            quality_meta: qualityMeta
          },
        }));

        // Reject photo if occlusion, no face, multiple faces, or low quality (<55%)
        const isRejected = (
          multipleFacesDetected ||
          qualityMeta.multiple_faces_detected ||
          faceDetected === false ||
          qualityMeta.occlusion_detected ||
          qualityMeta.glasses_detected ||
          qualityMeta.mask_detected ||
          (quality !== null && Math.round(quality * 100) < 55)
        );

        if (isRejected) {
          URL.revokeObjectURL(objectUrl);
          setPhotos(prev => {
            const next = { ...prev };
            delete next[angle];
            return next;
          });

          if (qualityMeta.occlusion_detected) {
            toast.error(`${ANGLES[currentAngleIdx].label}: Face covered / obstructed`, {
              description: 'Hand or object detected covering face. Please clear your face and retake.',
            });
          } else if (multipleFacesDetected || qualityMeta.multiple_faces_detected) {
            toast.error(`${ANGLES[currentAngleIdx].label}: Multiple people detected`, {
              description: 'Make sure only one person is in the frame and try again.',
            });
          } else if (faceDetected === false) {
            toast.error(`${ANGLES[currentAngleIdx].label}: No face detected`, {
              description: 'Make sure your face is fully visible and try again.',
            });
          } else if (qualityMeta.glasses_detected) {
            toast.error(`${ANGLES[currentAngleIdx].label}: Glasses / Sunglasses detected`, {
              description: 'Please remove sunglasses or tinted glasses and try again.',
            });
          } else if (qualityMeta.mask_detected) {
            toast.error(`${ANGLES[currentAngleIdx].label}: Mask detected`, {
              description: 'Please remove mask or face covering and try again.',
            });
          } else {
            toast.error(`${ANGLES[currentAngleIdx].label}: Poor quality (${Math.round((quality || 0) * 100)}%)`, {
              description: 'Please follow on-screen guidance and retake.',
            });
          }
          return;
        }

        // Photo passed validation!
        const pct = quality !== null ? Math.round(quality * 100) : null;
        if (pct !== null && pct >= 75) {
          toast.success(`${ANGLES[currentAngleIdx].label}: ${pct}% ✓ Great shot!`);
        } else {
          toast.info(`${ANGLES[currentAngleIdx].label}: Photo saved`);
        }

        setTimeout(() => {
          handleNext();
        }, 1200);
      } catch {
        setPhotos(prev => ({ ...prev, [angle]: { ...prev[angle], uploading: false } }));
        toast.error('Upload failed — please retake');
      }
    }, 'image/jpeg', 0.92);
  }

  function retakeAngle() {
    const angle = ANGLES[currentAngleIdx].id;
    if (photos[angle]) { URL.revokeObjectURL(photos[angle].objectUrl); }
    setPhotos(prev => { const n = { ...prev }; delete n[angle]; return n; });
  }

  async function handleStartEnrollment() {
    setStep('consent');
  }

  async function handleConsentGiven() {
    setStep('capture');
    await startCamera();
  }

  // Re-attach stream any time the video element comes back into view
  // (React may remount the <video> node when step/angle changes)
  useEffect(() => {
    if (step === 'capture' && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
    }
  }, [step, currentAngleIdx, currentPhoto]);

  // ── Live pose check ────────────────────────────────────────────────────────
  // While the camera is live and no photo has been captured for the current
  // angle yet, periodically sample a downscaled frame and ask the backend
  // (check-pose — never persisted, see EnrollmentController.checkPose) whether
  // the user is actually facing the direction this angle needs, so we can
  // correct them ("turn slightly left") before they waste a capture.
  const checkPoseOnce = useCallback(async () => {
    if (poseCheckInFlightRef.current) return;
    if (!videoRef.current || videoRef.current.readyState < 2) return;

    if (!poseCanvasRef.current) poseCanvasRef.current = document.createElement('canvas');
    const video = videoRef.current;
    const canvas = poseCanvasRef.current;
    const scale = 320 / video.videoWidth;
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Must match the capture canvas flip so yaw/centering are consistent
    // with the un-mirrored image the backend will actually store.
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      poseCheckInFlightRef.current = true;
      try {
        const angle = ANGLES[currentAngleIdx].id;
        const form = new FormData();
        form.append('photo', blob, `${angle}-pose.jpg`);
        form.append('angle', angle);
        const res = await fetch(`${authConfig.apiBaseUrl}/enroll/${token}/check-pose`, {
          method: 'POST', body: form,
        });
        if (!res.ok) return;
        const data = await res.json();

        if (data.multiple_faces_detected) {
          setPoseHint({ message: 'Multiple people detected — make sure only you are in the frame', ok: false });
          return;
        }
        if (data.face_detected === false) {
          // Check if face size suggests too far
          if (data.face_size_pct !== null && data.face_size_pct !== undefined && data.face_size_pct < MIN_FACE_SIZE_PCT) {
            setPoseHint({ message: 'Come closer — your face is too small for a good embedding', ok: false });
          } else {
            setPoseHint({ message: 'No face detected — make sure your face is fully visible and well-lit', ok: false });
          }
          return;
        }
        if (data.fully_visible === false) {
          setPoseHint({ message: 'Your face is cropped at the edge — step back or center yourself in the frame', ok: false });
          return;
        }
        if (data.partial_face) {
          setPoseHint({ message: 'Part of your face looks hidden or turned away — face the camera directly', ok: false });
          return;
        }
        if (data.glasses_detected) {
          setPoseHint({ message: 'Please remove sunglasses or tinted glasses', ok: false });
          return;
        }
        if (data.mask_detected) {
          setPoseHint({ message: 'Please remove your mask or face covering', ok: false });
          return;
        }
        if (data.occlusion_detected) {
          setPoseHint({ message: 'Face covered — please remove your hand or object from your face', ok: false });
          return;
        }
        // Check face size — must match backend MIN/MAX_FACE_SIZE_PCT thresholds
        if (data.face_size_pct !== null && data.face_size_pct !== undefined) {
          if (data.face_size_pct < MIN_FACE_SIZE_PCT) {
            setPoseHint({ message: 'Come closer — your face is too small for a reliable embedding', ok: false, faceSizePct: data.face_size_pct, centerOffset: data.face_center_offset });
            return;
          }
          if (data.face_size_pct < GOOD_FACE_SIZE_PCT) {
            setPoseHint({ message: 'A little closer — face needs to be slightly larger for best accuracy', ok: false, faceSizePct: data.face_size_pct, centerOffset: data.face_center_offset });
            return;
          }
          if (data.face_size_pct > MAX_FACE_SIZE_PCT) {
            setPoseHint({ message: 'Step back — your face is too close to the camera', ok: false, faceSizePct: data.face_size_pct, centerOffset: data.face_center_offset });
            return;
          }
        }
        // Check face centering (before angle check)
        if (data.face_center_offset) {
          const tol = angle === 'front' ? CENTER_TOL_FRONT : CENTER_TOL_SIDE;
          const ox = data.face_center_offset.x ?? 0;
          const oy = data.face_center_offset.y ?? 0;
          if (Math.abs(ox) > tol || Math.abs(oy) > tol) {
            const xMsg = Math.abs(ox) > tol ? (ox > 0 ? 'move left in the frame' : 'move right in the frame') : null;
            const yMsg = Math.abs(oy) > tol ? (oy > 0 ? 'move up in the frame' : 'move down in the frame') : null;
            const nudges = [xMsg, yMsg].filter(Boolean).join(', and ');
            setPoseHint({ message: `Please ${nudges}`, ok: false, centerOffset: data.face_center_offset, faceSizePct: data.face_size_pct });
            return;
          }
        }
        const pose = data.pose;
        const poseDataAvailable = pose != null && typeof pose.yaw === 'number' && typeof pose.pitch === 'number';
        const liveScore = typeof data.quality === 'number' ? data.quality : undefined;
        if (!poseDataAvailable) {
          // No pose landmarks returned (face-quality service down, or no face in frame).
          // Do NOT set ok:true — leave the Capture button disabled (AB#3198).
          setPoseHint({ message: 'Checking pose…', ok: false, liveScore, centerOffset: data.face_center_offset, faceSizePct: data.face_size_pct });
        } else {
          const suggestion = getPoseSuggestion(angle, pose, data.face_center_offset);
          setPoseHint(suggestion
            ? { message: suggestion, ok: false, liveScore, centerOffset: data.face_center_offset, faceSizePct: data.face_size_pct, pose }
            : { message: '✓ Perfect — hold that pose!', ok: true, liveScore, centerOffset: data.face_center_offset, faceSizePct: data.face_size_pct, pose });
        }
      } catch {
        // Advisory only — silently skip this tick on network hiccups.
      } finally {
        poseCheckInFlightRef.current = false;
      }
    }, 'image/jpeg', 0.6);
  }, [currentAngleIdx, token]);

  useEffect(() => {
    setPoseHint(null);
    if (step !== 'capture' || !cameraActive || (currentPhoto && !currentPhoto.uploading)) {
      return;
    }
    const intervalId = setInterval(checkPoseOnce, 1300);
    return () => clearInterval(intervalId);
  }, [step, cameraActive, currentAngleIdx, currentPhoto, checkPoseOnce]);

  function handleNext() {
    if (currentAngleIdx < ANGLES.length - 1) setCurrentAngleIdx(i => i + 1);
    else { stopCamera(); setStep('review'); }
  }

  // ── Submit: data already in DB from upload-angle; complete() finalises it ──
  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch(`${authConfig.apiBaseUrl}/enroll/${token}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error('Submission failed');
      setStep('complete');
    } catch {
      toast.error('Submission failed — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step progress indicator ────────────────────────────────────────────────
  const ENROLLMENT_STEPS = [
    { key: 'consent',  label: 'Consent' },
    { key: 'capture',  label: 'Photo'   },
    { key: 'review',   label: 'Review'  },
    { key: 'submit',   label: 'Submit'  },
    { key: 'complete', label: 'Done'    },
  ];

  const StepProgress = () => {
    const currentIdx = ENROLLMENT_STEPS.findIndex(s => s.key === step);
    if (currentIdx < 0) return null;
    return (
      <div className="flex items-center justify-center gap-2 mb-6 text-xs">
        {ENROLLMENT_STEPS.map((s, i) => (
          <React.Fragment key={s.key}>
            <div className={`flex flex-col items-center gap-1 ${
              s.key === step           ? 'text-blue-600 font-semibold' :
              currentIdx > i           ? 'text-green-600'              : 'text-gray-400'
            }`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                s.key === step ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-600' :
                currentIdx > i ? 'border-green-500 bg-green-50 text-green-600'                  :
                'border-gray-300 text-gray-400'
              }`}>{i + 1}</div>
              <span className="hidden sm:block">{s.label}</span>
            </div>
            {i < ENROLLMENT_STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 max-w-8 ${currentIdx > i ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
            )}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // ── LOADING ────────────────────────────────────────────────────────────────
  if (step === 'loading') return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto mb-3" />
        <p className="text-slate-500">Validating enrollment link…</p>
      </div>
    </div>
  );

  // ── ERROR ──────────────────────────────────────────────────────────────────
  if (step === 'error') return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <div className="max-w-md w-full glass-card rounded-xl shadow-lg p-8 text-center">
        <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-slate-800 dark:text-white mb-3">Enrollment Error</h1>
        <p className="text-slate-500 mb-4">{errorMsg}</p>
        <p className="text-sm text-slate-400">Contact HR for assistance.</p>
      </div>
    </div>
  );

  // ── CONSENT ────────────────────────────────────────────────────────────────
  if (step === 'consent') return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <div className="max-w-xl w-full glass-card rounded-xl shadow-lg p-8">
        <StepProgress />
        <ConsentStep
          token={token}
          onConsentGiven={handleConsentGiven}
          mode="self-enrollment"
        />
      </div>
    </div>
  );

  // ── WELCOME ────────────────────────────────────────────────────────────────
  if (step === 'welcome') return (
    <div className="min-h-screen flex items-center justify-center welcome-bg p-4 transition-all duration-500">
      <BiometricStyles />
      <div className="max-w-xl w-full glass-card welcome-card-glow rounded-2xl shadow-2xl p-8 hover:scale-[1.01] transition-transform duration-300">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold text-white mb-2 tracking-tight bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            Welcome, {enrollmentData?.employeeName}!
          </h1>
          <p className="text-slate-400 text-sm">Complete your high-fidelity face enrollment for the attendance system.</p>
        </div>

        <div className="space-y-4 mb-8">
          <div className="bg-blue-950/40 border border-blue-900/50 p-4 rounded-xl">
            <p className="text-sm font-bold text-blue-300 mb-2 flex items-center gap-2">📸 What you'll need</p>
            <ul className="text-xs text-blue-200/90 space-y-1.5 list-disc list-inside">
              <li>Device with a working front camera (phone or laptop)</li>
              <li>Good direct lighting — face towards a light source</li>
              <li>Remove glasses, hat, or mask temporarily</li>
            </ul>
          </div>

          <div className="bg-emerald-950/40 border border-emerald-900/50 p-4 rounded-xl">
            <p className="text-sm font-bold text-emerald-300 mb-1 flex items-center gap-2">🎯 Eight angles in ~3 minutes</p>
            <p className="text-xs font-semibold text-emerald-200/90 leading-relaxed">
              Front · Left · Right · Up · High Up · Left Up · Right Up · Down
            </p>
            <p className="text-[11px] text-emerald-400/80 mt-1.5">
              Each photo is analyzed in real-time. Retake any shot if the quality score is low.
            </p>
          </div>

          <label className="flex items-start gap-3 p-4 border border-slate-800 rounded-xl cursor-pointer hover:bg-slate-900/30 transition-colors">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-slate-700 bg-slate-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-slate-950 flex-shrink-0" />
            <span className="text-xs text-slate-400 leading-normal">
              I consent to providing my facial biometric data for attendance tracking.
              This data is secured and used solely for identity verification within this system.
            </span>
          </label>
        </div>

        <Button onClick={handleStartEnrollment} className="w-full shadow-lg shadow-blue-950/50 hover:shadow-blue-500/10 font-bold transition-all hover:scale-[1.02] duration-300" size="lg">
          Start Enrollment <ChevronRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );

  // ── CAPTURE ────────────────────────────────────────────────────────────────
  if (step === 'capture') return (
    <div className="min-h-screen welcome-bg p-4 transition-all duration-500">
      <BiometricStyles />
      <div className="max-w-2xl mx-auto">

        <StepProgress />

        {/* Header */}
        <div className="flex items-center justify-center gap-4 mb-6">
          {REFERENCE_PHOTOS[currentAngle.id] && (
            <img
              src={REFERENCE_PHOTOS[currentAngle.id]}
              alt={`Example ${currentAngle.label} pose`}
              className="w-14 h-14 rounded-xl object-cover border-2 border-blue-500/50 shadow-lg shadow-blue-950/30 flex-shrink-0"
            />
          )}
          <div className="text-center sm:text-left">
            <p className="text-blue-400 text-xs font-bold uppercase tracking-wider mb-1">Step {currentAngleIdx + 1} of {ANGLES.length}</p>
            <h2 className="text-2xl font-black text-white tracking-tight">{currentAngle.label} — {currentAngle.hint}</h2>
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex gap-2 mb-6">
          {ANGLES.map((a, i) => {
            const ph = photos[a.id];
            const done = ph && !ph.uploading;
            const active = i === currentAngleIdx;
            const q = ph?.quality;
            return (
              <div key={a.id} className={cn(
                'flex-1 h-2 rounded-full transition-all duration-300',
                done  ? (q !== null && q < 0.55 ? 'bg-rose-500 shadow-md shadow-rose-950/50' : q !== null && q < 0.75 ? 'bg-amber-400 shadow-md shadow-amber-950/50' : 'bg-emerald-500 shadow-md shadow-emerald-950/50') :
                active ? 'bg-blue-500 shadow-lg shadow-blue-500/30 scale-y-110' : 'bg-slate-800'
              )} />
            );
          })}
        </div>

        {/* Camera / captured preview
            IMPORTANT: <video> stays in the DOM at all times so the MediaStream
            is never detached. The captured photo and overlays sit on top of it. */}
        <div className="bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden mb-6 relative shadow-2xl aspect-[3/4] sm:aspect-[4/3] md:aspect-[16/9] min-h-[440px] sm:min-h-[380px]">
          
          {(!currentPhoto || currentPhoto.uploading) && (
            <AngleVisualGuide angleId={currentAngle.id} />
          )}

          {/* Live camera — always mounted, hidden only when showing a captured photo.
              scaleX(-1) mirrors the feed so it acts like a natural mirror for
              the user while posing. The canvas capture flips it back, so the
              stored image is in the actual (non-mirrored) camera orientation. */}
          <video
            ref={videoRef}
            autoPlay playsInline muted
            className={cn(
              'w-full h-full object-cover transition-opacity duration-300',
              currentPhoto && !currentPhoto.uploading ? 'opacity-0 absolute inset-0' : 'opacity-100'
            )}
            style={{ transform: 'scaleX(-1)' }}
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Live face-mesh overlay — visual feedback only, never gates capture.
              Hidden once a photo is captured so it doesn't sit over the still. */}
          <FaceMeshOverlay
            videoRef={videoRef}
            active={step === 'capture' && cameraActive && (!currentPhoto || !!currentPhoto.uploading)}
            poseOk={!!poseHint?.ok}
          />

          {/* Captured photo overlay */}
          {currentPhoto && !currentPhoto.uploading && (
            <img
              src={currentPhoto.objectUrl}
              alt="Captured"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}

          {/* Face oval guide — shown while waiting to capture.
              Color changes based on pose hint state: red (no face/wrong pose),
              amber (close but needs adjustment), green (perfect). */}
          {(!currentPhoto || currentPhoto.uploading) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div
                className={cn(
                  'border-4 rounded-full relative flex items-center justify-center transition-all duration-500',
                  !poseHint             ? 'border-dashed border-blue-400/40 oval-glow' :
                  poseHint.ok           ? 'border-solid border-emerald-400 shadow-[0_0_25px_rgba(52,211,153,0.6)]' :
                  'border-dashed border-amber-400/80 shadow-[0_0_15px_rgba(251,191,36,0.3)]'
                )}
                style={{ width: '42%', aspectRatio: '3/4' }}
              >
                {/* Active scan line — only shown when not yet verified */}
                {!poseHint?.ok && <div className="biometric-scanner-line" />}

                {/* ✓ checkmark when pose is perfect */}
                {poseHint?.ok && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/25 flex items-center justify-center">
                      <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  </div>
                )}
              </div>

              {/* Face centering dot indicator — shows where face is vs center */}
              {poseHint?.centerOffset && !poseHint.ok && (
                <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                  {/* Small target dot showing face position vs oval center */}
                  <div
                    className="absolute w-3 h-3 rounded-full bg-amber-400 border-2 border-amber-200 shadow-lg"
                    style={{
                      left: `calc(50% + ${(poseHint.centerOffset.x ?? 0) * 60}px)`,
                      top: `calc(50% + ${(poseHint.centerOffset.y ?? 0) * 60}px)`,
                      transform: 'translate(-50%, -50%)',
                      transition: 'left 0.3s ease, top 0.3s ease',
                    }}
                    title="Your face position"
                  />
                </div>
              )}
            </div>
          )}

          {/* Dynamic edge-aligned arrow indicators to guide user pose */}
          {(!currentPhoto || currentPhoto.uploading) && (
            <div className="absolute inset-0 pointer-events-none z-10">
              {currentAngle.id === 'left' && (
                <div className="absolute left-6 top-1/2 -translate-y-1/2 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowLeft className="w-8 h-8 text-blue-400" />
                </div>
              )}
              {currentAngle.id === 'right' && (
                <div className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowRight className="w-8 h-8 text-blue-400" />
                </div>
              )}
              {currentAngle.id === 'up' && (
                <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowUp className="w-8 h-8 text-blue-400" />
                </div>
              )}
              {currentAngle.id === 'up_deep' && (
                <div className="absolute top-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
                  <div className="flex items-center justify-center w-14 h-14 rounded-full bg-blue-600/35 border-2 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.7)] animate-bounce">
                    <ArrowUp className="w-8 h-8 text-blue-300" />
                  </div>
                  <span className="text-[9px] uppercase font-black tracking-widest bg-blue-500 text-slate-950 px-1.5 py-0.5 rounded shadow">Look High</span>
                </div>
              )}
              {currentAngle.id === 'left_up' && (
                <div className="absolute left-6 top-6 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowUpLeft className="w-8 h-8 text-blue-400" />
                </div>
              )}
              {currentAngle.id === 'right_up' && (
                <div className="absolute right-6 top-6 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowUpRight className="w-8 h-8 text-blue-400" />
                </div>
              )}
              {currentAngle.id === 'down' && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center justify-center w-14 h-14 rounded-full bg-blue-500/20 border-2 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.5)] animate-pulse">
                  <ArrowDown className="w-8 h-8 text-blue-400" />
                </div>
              )}
            </div>
          )}

          {/* Uploading / analyzing overlay */}
          {currentPhoto?.uploading && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-10 h-10 text-white animate-spin" />
              <p className="text-white text-sm font-medium">Analyzing photo…</p>
            </div>
          )}

          {/* Live pose guidance — tells the user in real time whether they're
              facing the direction this angle needs, before they even capture. */}
          {!currentPhoto && poseHint && (
            <div className={cn(
              'absolute bottom-0 left-0 right-0 px-4 py-2.5 text-center text-sm font-semibold z-20 backdrop-blur-sm flex items-center justify-center gap-3',
              poseHint.ok ? 'bg-emerald-600/85 text-white' : 'bg-amber-500/90 text-slate-950'
            )}>
              <span>{poseHint.message}</span>
              {/* Live head-angle readout. Surfaced because the accepted pose
                  ranges are calibration-sensitive: when a pose is refused,
                  these numbers say why, without needing server logs. */}
              {poseHint.pose && typeof poseHint.pose.yaw === 'number' && typeof poseHint.pose.pitch === 'number' && (
                <span className={cn(
                  'text-[11px] font-mono font-bold px-2 py-0.5 rounded-full tabular-nums',
                  poseHint.ok ? 'bg-white/20 text-white' : 'bg-slate-900/25 text-slate-900'
                )}>
                  {poseHint.pose.yaw > 0 ? 'R' : 'L'}{Math.abs(Math.round(poseHint.pose.yaw))}° {poseHint.pose.pitch < 0 ? 'U' : 'D'}{Math.abs(Math.round(poseHint.pose.pitch))}°
                </span>
              )}
              {poseHint.liveScore !== undefined && (
                <span className={cn(
                  'text-xs font-black px-2 py-0.5 rounded-full',
                  poseHint.ok ? 'bg-white/25 text-white' : 'bg-slate-900/30 text-slate-900'
                )}>
                  {Math.round(poseHint.liveScore * 100)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Quality result for current photo */}
        {currentPhoto && !currentPhoto.uploading && (() => {
          const tips = getFeedbackTips(currentPhoto, ANGLES[currentAngleIdx].id);
          const hasTips = tips.length > 0;
          const isLow = currentPhoto.quality !== null && currentPhoto.quality < 0.75;
          
          return (
            <div className={cn(
              'rounded-lg p-4 mb-4 border flex flex-col gap-2',
              currentPhoto.face_detected === false || currentPhoto.multiple_faces_detected || (currentPhoto.quality !== null && currentPhoto.quality < 0.55)
                ? 'bg-red-900/40 border-red-700 text-red-100'
                : currentPhoto.quality !== null && currentPhoto.quality < 0.75
                ? 'bg-yellow-900/40 border-yellow-700 text-yellow-100'
                : 'bg-green-900/40 border-green-700 text-green-100'
            )}>
              <div className="flex items-center gap-3">
                {currentPhoto.face_detected === false || currentPhoto.multiple_faces_detected ? (
                  <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
                ) : (
                  <CheckCircle2 className={cn('w-5 h-5 flex-shrink-0',
                    currentPhoto.quality === null ? 'text-slate-400' :
                    currentPhoto.quality >= 0.75 ? 'text-green-400' : 'text-yellow-400')}
                  />
                )}
                <div>
                  <p className="text-sm font-semibold">
                    {currentPhoto.multiple_faces_detected
                      ? 'Multiple people detected'
                      : currentPhoto.face_detected === false
                      ? 'No face detected'
                      : currentPhoto.quality === null
                      ? 'Photo saved (quality score unavailable)'
                      : `Quality Score: ${Math.round(currentPhoto.quality * 100)}%`}
                    {currentPhoto.quality !== null && !currentPhoto.multiple_faces_detected && (
                      currentPhoto.quality >= 0.75 ? ' — Excellent' :
                      currentPhoto.quality >= 0.55 ? ' — Acceptable' : ' — Too low'
                    )}
                  </p>
                </div>
              </div>
              
              {hasTips && (
                <div className="mt-2 pl-8 space-y-1 text-xs opacity-90">
                  {tips.map((tip, idx) => (
                    <div key={idx} className="flex items-start gap-1.5 text-left">
                      <span className="text-blue-400 font-bold">•</span>
                      <span>{tip}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Controls */}
        <div className="flex gap-3 justify-center">
          {currentPhoto && !currentPhoto.uploading ? (
            <>
              <Button variant="outline" onClick={retakeAngle}
                className="w-full max-w-xs border-slate-600 text-slate-300 hover:bg-slate-800">
                <RefreshCw className="w-4 h-4 mr-2" /> Retake
              </Button>
            </>
          ) : (
            <Button
              onClick={capturePhoto}
              disabled={!cameraActive || currentPhoto?.uploading || !poseHint || !poseHint.ok}
              size="lg" className="min-w-[220px]"
            >
              {currentPhoto?.uploading
                ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Analyzing…</>
                : <><Camera className="w-5 h-5 mr-2" />Capture Photo</>}
            </Button>
          )}
        </div>

        {/* Mini progress bar for already-captured angles */}
        {Object.keys(photos).length > 0 && (
          <div className="mt-6 flex flex-wrap gap-4 justify-center items-center p-3 rounded-lg bg-slate-900/50 border border-slate-800">
            {ANGLES.map(a => {
              const ph = photos[a.id];
              if (!ph) return null;
              return (
                <div key={a.id} className="text-center flex flex-col items-center">
                  <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-700 hover:scale-105 duration-200">
                    <img src={ph.objectUrl} alt={a.label} className="w-full h-full object-cover" />
                  </div>
                  <p className="text-[9px] font-semibold text-slate-400 mt-1">{a.label}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ── REVIEW ─────────────────────────────────────────────────────────────────
  if (step === 'review') return (
    <div className="min-h-screen welcome-bg p-4 transition-all duration-500">
      <BiometricStyles />
      <div className="max-w-3xl mx-auto">
        <div className="glass-card welcome-card-glow rounded-2xl shadow-2xl p-8">
          <StepProgress />
          <h2 className="text-2xl font-extrabold text-center mb-6 tracking-tight bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            Review &amp; Submit
          </h2>

          {/* 8 photo thumbnails with circular progress scores */}
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-3 mb-6">
            {ANGLES.map(a => {
              const ph = photos[a.id];
              return (
                <div key={a.id} className="text-center flex flex-col items-center">
                  <div className={cn(
                    'aspect-square w-full rounded-lg overflow-hidden mb-2 border-2 transition-all hover:scale-105 duration-300 shadow-md relative group',
                    !ph ? 'bg-slate-850 border-slate-750' :
                    ph.face_detected === false || ph.multiple_faces_detected ? 'border-rose-500 shadow-rose-950/20' :
                    ph.quality === null ? 'border-slate-600' :
                    ph.quality >= 0.75 ? 'border-emerald-500 shadow-emerald-950/20' :
                    ph.quality >= 0.55 ? 'border-amber-500 shadow-amber-950/20' : 'border-rose-500 shadow-rose-950/20'
                  )}>
                    {ph ? (
                      <img src={ph.objectUrl} alt={a.label} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-500 font-bold uppercase bg-slate-900/50">
                        {a.id.slice(0, 3)}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] font-bold text-slate-700 dark:text-slate-300 mb-1 truncate w-full">{a.label}</p>
                  {ph && <QualityCircularProgress quality={ph.quality} size={36} />}
                </div>
              );
            })}
          </div>

          {/* Average quality summary */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 mb-6 text-center shadow-inner">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Average Biometric Quality</p>
            {anyUploading ? (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-blue-450" />
                <span className="text-sm text-slate-400">Analyzing feedback…</span>
              </div>
            ) : avgQuality !== null ? (
              <div className="flex flex-col items-center justify-center gap-1">
                <p className={cn('text-5xl font-black tracking-tighter', 
                  avgQuality >= 0.75 ? 'text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]' :
                  avgQuality >= 0.55 ? 'text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.3)]' :
                  'text-rose-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.3)]'
                )}>
                  {Math.round(avgQuality * 100)}%
                </p>
                <p className="text-[11px] font-semibold text-slate-400 mt-1">
                  {avgQuality >= 0.75 ? 'Excellent Quality — Ready to submit' :
                   avgQuality >= 0.55 ? 'Acceptable Quality — Ready to submit' :
                   'Low Quality — Retake recommended'}
                </p>
              </div>
            ) : (
              <p className="text-slate-500">—</p>
            )}
          </div>

          {/* Warning if any angle is low quality */}
          {!anyUploading && ANGLES.some(a => {
            const ph = photos[a.id];
            return ph && (ph.face_detected === false || ph.multiple_faces_detected || (ph.quality !== null && ph.quality < 0.55));
          }) && (
            <div className="flex gap-3 items-start bg-rose-950/20 border border-rose-900/50 rounded-xl p-4 mb-6 text-left">
              <AlertTriangle className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-rose-200/90 leading-relaxed">
                Some captured angles do not meet the minimum biometric criteria or face alignment checks. Please retake these specific angles before submitting.
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => { setStep('capture'); setCurrentAngleIdx(0); startCamera(); }}>
              Retake All
            </Button>
            <Button
              className="flex-1"
              onClick={handleSubmit}
              disabled={
                !allCaptured || 
                submitting || 
                ANGLES.some(a => {
                  const ph = photos[a.id];
                  return ph && (ph.face_detected === false || ph.multiple_faces_detected || (ph.quality !== null && ph.quality < 0.55));
                })
              }
            >
              {submitting
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting…</>
                : <><CheckCircle2 className="w-4 h-4 mr-2" />Submit Enrollment</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  // ── COMPLETE ───────────────────────────────────────────────────────────────
  if (step === 'complete') return (
    <div className="min-h-screen flex items-center justify-center welcome-bg p-4">
      <BiometricStyles />
      <div className="max-w-md w-full glass-card welcome-card-glow rounded-2xl shadow-2xl p-8 text-center">
        <CheckCircle2 className="w-16 h-16 text-emerald-400 mx-auto mb-4 drop-shadow-[0_0_10px_rgba(52,211,153,0.4)]" />
        <h1 className="text-2xl font-black text-white mb-3 bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
          Enrollment Complete!
        </h1>
        <p className="text-slate-400 text-sm mb-6">
          All 8 biometric photos submitted successfully. Your enrollment is now pending HR approval.
        </p>
        {avgQuality !== null && (
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 mb-6 shadow-inner">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">Overall Biometric Quality</p>
            <p className={cn('text-4xl font-black tracking-tight', 
              avgQuality >= 0.75 ? 'text-emerald-400' :
              avgQuality >= 0.55 ? 'text-amber-400' : 'text-rose-400'
            )}>
              {Math.round(avgQuality * 100)}%
            </p>
          </div>
        )}
        <p className="text-xs text-slate-500 leading-normal">You'll receive a confirmation email once your profile has been approved.</p>
      </div>
    </div>
  );

  return null;
};
