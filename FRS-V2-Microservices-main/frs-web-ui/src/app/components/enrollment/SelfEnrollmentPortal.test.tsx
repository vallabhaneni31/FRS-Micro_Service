// AB#3198 — Face Enrollment: Pose Validation Auto-Accepts Without Verifying Orientation
//
// Regression tests for the bug where `getPoseSuggestion(angle, {})` returned null
// (no landmarks → short-circuits) and null was mistakenly treated as "pose OK",
// causing "✓ Perfect — hold that pose!" to appear after ~2 s regardless of actual
// head orientation.
//
// Test framework: Vitest + @testing-library/react (matches project convention).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';

// ── Isolated helper tests (no DOM needed) ─────────────────────────────────────
// getPoseSuggestion and POSE_RANGES are imported from the component itself.
// An earlier version of this file re-implemented the function and copied the
// pose calibration into it, which meant the tests only ever guarded their own
// copy: when the backend switched to MediaPipe's real head-pose degrees these
// assertions still passed against stale numbers while enrollment was broken in
// production. Import the real thing so a calibration change either passes here
// for the right reason or fails loudly.
import { getPoseSuggestion, POSE_RANGES } from './SelfEnrollmentPortal';

describe('getPoseSuggestion — pose guard (AB#3198 regression)', () => {
  it('returns null when pose is an empty object — must NOT be treated as "pose OK"', () => {
    expect(getPoseSuggestion('front', {})).toBeNull();
    expect(getPoseSuggestion('left',  {})).toBeNull();
    expect(getPoseSuggestion('right', {})).toBeNull();
  });

  it('returns null when pose is null/undefined (missing)', () => {
    expect(getPoseSuggestion('front', null)).toBeNull();
    expect(getPoseSuggestion('front', undefined)).toBeNull();
  });

  it('returns null (no correction) for a pose in the middle of each angle range', () => {
    // Derived from the real ranges rather than hardcoded, so this keeps
    // asserting "the middle of the range is accepted" after any recalibration.
    for (const [angle, range] of Object.entries(POSE_RANGES)) {
      const mid = (lo: number, hi: number) => (lo + hi) / 2;
      const pose = { yaw: mid(...range.yaw), pitch: mid(...range.pitch) };
      expect(getPoseSuggestion(angle, pose), `${angle} midpoint should be accepted`).toBeNull();
    }
  });

  it('rejects a pose just outside each angle range on both axes', () => {
    for (const [angle, range] of Object.entries(POSE_RANGES)) {
      const [yawLo, yawHi] = range.yaw;
      const [pitchLo, pitchHi] = range.pitch;
      const pitchMid = (pitchLo + pitchHi) / 2;
      const yawMid = (yawLo + yawHi) / 2;
      expect(getPoseSuggestion(angle, { yaw: yawHi + 5, pitch: pitchMid }), `${angle} yaw above range`).not.toBeNull();
      expect(getPoseSuggestion(angle, { yaw: yawLo - 5, pitch: pitchMid }), `${angle} yaw below range`).not.toBeNull();
      expect(getPoseSuggestion(angle, { yaw: yawMid, pitch: pitchHi + 5 }), `${angle} pitch above range`).not.toBeNull();
      expect(getPoseSuggestion(angle, { yaw: yawMid, pitch: pitchLo - 5 }), `${angle} pitch below range`).not.toBeNull();
    }
  });

  it('a level head is NOT accepted on the upward angles (regression)', () => {
    // The vertical gates once accepted anything past -3°/-4° of pitch, so a
    // user looking DOWN was told the pose was correct. A webcam sits below the
    // face, so "a few degrees off level" is not evidence of an upward tilt.
    for (const angle of ['up', 'up_deep', 'left_up', 'right_up']) {
      const yawMid = (POSE_RANGES[angle].yaw[0] + POSE_RANGES[angle].yaw[1]) / 2;
      expect(getPoseSuggestion(angle, { yaw: yawMid, pitch: 0 }), `${angle} at level`).not.toBeNull();
      expect(getPoseSuggestion(angle, { yaw: yawMid, pitch: -7 }), `${angle} barely up`).not.toBeNull();
      expect(getPoseSuggestion(angle, { yaw: yawMid, pitch: 12 }), `${angle} looking down`).not.toBeNull();
    }
  });

  it('names the direction to move when yaw is outside the range', () => {
    // front accepts yaw -18..18; yaw=40 is past the top, i.e. turned too far
    // right, so the correction is to come back to the left.
    expect(getPoseSuggestion('front', { yaw: 40, pitch: 0 })).toMatch(/turn a little more to your left/i);
    expect(getPoseSuggestion('front', { yaw: -40, pitch: 0 })).toMatch(/turn a little more to your right/i);
  });

  it('names the direction to move when pitch is outside the range', () => {
    expect(getPoseSuggestion('front', { yaw: 0, pitch: 25 })).toMatch(/tilt your head up/i);
    expect(getPoseSuggestion('front', { yaw: 0, pitch: -25 })).toMatch(/tilt your head down/i);
  });

  it('returns null for unknown angle (no POSE_RANGES entry)', () => {
    expect(getPoseSuggestion('diagonal', { yaw: 0, pitch: 0 })).toBeNull();
  });

  it('returns centering nudge when face is off-center beyond front tolerance', () => {
    // front tol=0.30; offset.x=0.45 > 0.30 → "move slightly left in the frame"
    const msg = getPoseSuggestion('front', { yaw: 0, pitch: 0 }, { x: 0.45, y: 0 });
    expect(msg).toMatch(/move slightly left/i);
  });
});

// ── Integration-level tests: poseHint state inside SelfEnrollmentPortal ───────
//
// We use vi.useFakeTimers({ shouldAdvanceTime: true }) so that:
//   - waitFor() (which polls via real setTimeout internally) continues to work
//   - We can also manually fast-forward past the 1300ms pose-check interval via
//     vi.advanceTimersByTimeAsync(), which properly awaits any async work the
//     timer callback kicks off.

vi.mock('../../config/authConfig', () => ({
  authConfig: { apiBaseUrl: 'http://localhost:3000/api' },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

vi.mock('./ConsentStep', () => ({
  ConsentStep: ({ onConsentGiven }: { onConsentGiven: () => void }) => (
    <button onClick={onConsentGiven}>Give Consent</button>
  ),
}));

const mockMediaStream = { getTracks: () => [{ stop: vi.fn() }] };

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn().mockResolvedValue(mockMediaStream) },
  writable: true,
  configurable: true,
});

Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { get: () => 4, configurable: true });
Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth',  { get: () => 640, configurable: true });
Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 480, configurable: true });
HTMLVideoElement.prototype.play = vi.fn().mockResolvedValue(undefined);

HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => {
  cb(new Blob(['x'], { type: 'image/jpeg' }));
});

// jsdom's canvas.getContext('2d') returns null — stub it so checkPoseOnce
// doesn't bail at `if (!ctx) return` before reaching the fetch call (AB#3198).
const mockCtx = {
  save: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  drawImage: vi.fn(),
  restore: vi.fn(),
};
// Cast through unknown: mockCtx is a stub with only the handful of 2D methods
// this component calls, not a full CanvasRenderingContext2D.
HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;

import { SelfEnrollmentPortal } from './SelfEnrollmentPortal';

async function renderAtCaptureStep(token = 'test-token') {
  const validateResp = { status: 'pending', employeeName: 'Test User', employeeCode: 'EMP001' };
  (globalThis.fetch as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ ok: true, json: async () => validateResp } as unknown as Response);

  render(<SelfEnrollmentPortal token={token} />);

  // Flush the validateToken fetch promise
  await act(async () => {});

  await waitFor(() => screen.getByText(/complete your.*enrollment/i), { timeout: 3000 });

  const startBtn = screen.getByRole('button', { name: /start enrollment/i });
  await act(async () => { startBtn.click(); });

  const consentBtn = screen.getByRole('button', { name: /give consent/i });
  await act(async () => { consentBtn.click(); });

  // Flush getUserMedia promise so camera becomes active
  await act(async () => {});

  await waitFor(() => screen.getByRole('button', { name: /capture photo/i }), { timeout: 3000 });
}

function makePoseResponse(pose: unknown, quality = 0.80) {
  return {
    ok: true,
    json: async () => ({
      face_detected: true,
      multiple_faces_detected: false,
      fully_visible: true,
      partial_face: false,
      glasses_detected: false,
      mask_detected: false,
      occlusion_detected: false,
      pose,
      face_size_pct: 0.15,
      face_center_offset: { x: 0, y: 0 },
      quality,
    }),
  } as unknown as Response;
}

describe('SelfEnrollmentPortal — live pose-check poseHint state (AB#3198)', () => {
  beforeEach(() => {
    // shouldAdvanceTime:true lets waitFor()/setTimeout poll work even under fake clocks,
    // while still allowing manual vi.advanceTimersByTimeAsync() to fast-forward the
    // 1300ms pose-check interval without waiting in real time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('Capture button is DISABLED and shows "Checking pose…" when check-pose returns pose: {} (root-cause scenario)', async () => {
    await renderAtCaptureStep();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makePoseResponse({}));

    // Advance past the 1300ms setInterval tick, then drain the blob→fetch→setState chain
    await vi.advanceTimersByTimeAsync(1400);
    await act(async () => {});

    expect(screen.getByRole('button', { name: /capture photo/i })).toBeDisabled();
    expect(screen.queryByText(/perfect/i)).toBeNull();
    expect(screen.getByText(/checking pose/i)).toBeInTheDocument();
  });

  it('Capture button is DISABLED and shows "Checking pose…" when check-pose returns pose: null', async () => {
    await renderAtCaptureStep();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makePoseResponse(null));

    await vi.advanceTimersByTimeAsync(1400);
    await act(async () => {});

    expect(screen.getByRole('button', { name: /capture photo/i })).toBeDisabled();
    expect(screen.queryByText(/perfect/i)).toBeNull();
  });

  it('Capture button is ENABLED and shows "Perfect" when pose is valid and in-tolerance', async () => {
    await renderAtCaptureStep();

    // Front pose: yaw=2, pitch=1 — inside the accepted front range
    // (yaw -18..18, pitch -10..10)
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePoseResponse({ yaw: 2, pitch: 1, roll: 0 }));

    await vi.advanceTimersByTimeAsync(1400);
    await act(async () => {});

    expect(screen.getByRole('button', { name: /capture photo/i })).not.toBeDisabled();
    expect(screen.getByText(/perfect/i)).toBeInTheDocument();
  });

  it('Capture button is DISABLED and shows correction hint when pose is out-of-tolerance', async () => {
    await renderAtCaptureStep();

    // Front accepts yaw -18..18. yaw=40 is past the top of the range, i.e.
    // turned too far right, so the correction is to turn back to the left.
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePoseResponse({ yaw: 40, pitch: 0, roll: 0 }, 0.60));

    await vi.advanceTimersByTimeAsync(1400);
    await act(async () => {});

    expect(screen.getByRole('button', { name: /capture photo/i })).toBeDisabled();
    expect(screen.getByText(/turn a little more to your left/i)).toBeInTheDocument();
  });

});
