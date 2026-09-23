import React, { useEffect, useRef, useState } from 'react';

/**
 * Draws MediaPipe's 478-point face mesh over the live enrollment camera feed.
 *
 * This is a *visual* layer only — it deliberately does not compute pose or
 * gate capture. The backend quality service (mediapipe_engine.py) remains the
 * single authority for yaw/pitch and accept/reject; duplicating that maths
 * client-side would mean two implementations drifting apart, which has already
 * caused one production incident on this flow. What runs here is the same
 * MediaPipe Face Landmarker model the server uses, so what the user sees
 * tracking their face is what the server is reasoning about.
 *
 * The model + WASM runtime (~26 MB) are self-hosted under /mediapipe/ and
 * loaded lazily the first time the camera opens. Any failure to load is
 * non-fatal: the overlay simply never appears and enrollment proceeds exactly
 * as it did before.
 */

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Camera is live and we're on the capture step. */
  active: boolean;
  /** Tints the mesh green once the backend reports the pose is correct. */
  poseOk?: boolean;
};

// Landmark indices tracing the main facial contours, used to draw a light
// wireframe on top of the raw point cloud so the mesh reads as a face rather
// than a spray of dots. Sourced from MediaPipe's canonical face model.
const CONTOURS: number[][] = [
  // face oval
  [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
   152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  // lips (outer)
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
  // left eye
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263],
  // right eye
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
  // left eyebrow
  [276, 283, 282, 295, 285],
  // right eyebrow
  [46, 53, 52, 65, 55],
  // nose bridge + base
  [168, 6, 197, 195, 5, 4],
  [98, 97, 2, 326, 327],
];

export default function FaceMeshOverlay({ videoRef, active, poseOk }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const poseOkRef = useRef(poseOk);
  const [failed, setFailed] = useState(false);

  // Keep the draw loop reading the latest value without restarting on change.
  poseOkRef.current = poseOk;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    async function start() {
      try {
        if (!landmarkerRef.current) {
          const vision = await import('@mediapipe/tasks-vision');
          const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm');
          if (cancelled) return;
          landmarkerRef.current = await vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: '/mediapipe/models/face_landmarker.task' },
            runningMode: 'VIDEO',
            numFaces: 1,
          });
        }
        if (cancelled) return;
        loop();
      } catch (err) {
        console.warn('[enrollment] face mesh overlay unavailable:', err);
        if (!cancelled) setFailed(true);
      }
    }

    function loop() {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(loop);

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !canvas || !landmarker || video.readyState < 2) return;

      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return; // transient decode hiccup — skip this frame
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      const faces = result?.faceLandmarks;
      if (!faces || !faces.length) return;
      const points = faces[0];

      const accent = poseOkRef.current ? '52, 211, 153' : '96, 165, 250'; // emerald / blue

      ctx.strokeStyle = `rgba(${accent}, 0.55)`;
      ctx.lineWidth = Math.max(1, w / 640);
      for (const contour of CONTOURS) {
        ctx.beginPath();
        contour.forEach((idx, i) => {
          const p = points[idx];
          if (!p) return;
          const x = p.x * w;
          const y = p.y * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(${accent}, 0.85)`;
      const r = Math.max(0.8, w / 900);
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && canvasRef.current) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    };
  }, [active, videoRef]);

  // Release the native model when the portal unmounts entirely.
  useEffect(() => {
    return () => {
      try {
        landmarkerRef.current?.close?.();
      } catch {
        /* nothing useful to do if teardown fails */
      }
      landmarkerRef.current = null;
    };
  }, []);

  if (!active || failed) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      // Matches the <video> element's mirroring so the mesh lines up with what
      // the user sees; the landmarks themselves are in unmirrored source coords.
      style={{ transform: 'scaleX(-1)' }}
    />
  );
}
