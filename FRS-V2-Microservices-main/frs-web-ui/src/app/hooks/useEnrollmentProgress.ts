import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/http/apiClient';
import { realtimeEngine, RteEventType } from '../engine/RealTimeEngine';
import { useScopeHeaders } from './useScopeHeaders';

export type AngleStage = 'pending' | 'queued' | 'delivered' | 'embedded' | 'failed';

export interface AngleProgress {
  stage: AngleStage;
  command_id: number | null;
  queued_at: string | null;
  delivered_at: string | null;
  embedded_at: string | null;
  quality_score: number | null;
}

export interface EnrollmentProgress {
  invitation_id: number;
  employee_code: string | null;
  full_name: string | null;
  approval_status: string;
  embedding_status: string;
  angles: Record<string, AngleProgress>;
}

/**
 * Live per-angle pipeline status for an enrollment invitation, shown in
 * PendingEnrollmentApprovals.tsx right after clicking Approve. Follows the
 * same poll + socket-nudge pattern as useAlerts.ts: a baseline ~4s poll
 * against GET /enroll/invitations/:id/progress (source of truth — the
 * backend derives each angle's stage from device_command_queue +
 * employee_face_embeddings, not from anything cached client-side), plus an
 * immediate re-fetch whenever a relevant enrollment.completed/failed
 * WebSocket event arrives so the panel doesn't sit waiting for the next tick.
 *
 * Pass `null` for invitationId to disable (panel closed / nothing to track).
 */
export function useEnrollmentProgress(invitationId: number | null, pollMs = 4_000) {
  const [progress, setProgress] = useState<EnrollmentProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scopeHeaders = useScopeHeaders();
  const headersKey = JSON.stringify(scopeHeaders);

  const fetchProgress = useCallback(async () => {
    if (!invitationId) return;
    try {
      const res = await apiRequest<EnrollmentProgress>(
        `/enroll/invitations/${invitationId}/progress`,
        { noCache: true, scopeHeaders: JSON.parse(headersKey) }
      );
      setProgress(res);
    } catch {
      // transient poll failures are non-critical — keep showing the last
      // known state rather than flashing an error on every missed tick
    } finally {
      setLoading(false);
    }
  }, [invitationId, headersKey]);

  useEffect(() => {
    if (!invitationId) {
      setProgress(null);
      return;
    }
    setLoading(true);
    fetchProgress();
    timerRef.current = setInterval(fetchProgress, pollMs);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [invitationId, fetchProgress, pollMs]);

  useEffect(() => {
    if (!invitationId) return;
    const unsub = realtimeEngine.subscribe(RteEventType.ENROLLMENT_PROGRESS, () => fetchProgress());
    return () => { unsub(); };
  }, [invitationId, fetchProgress]);

  const allTerminal = !!progress && Object.values(progress.angles).every(
    a => a.stage === 'embedded' || a.stage === 'failed'
  );

  return { progress, loading, allTerminal, refresh: fetchProgress };
}
