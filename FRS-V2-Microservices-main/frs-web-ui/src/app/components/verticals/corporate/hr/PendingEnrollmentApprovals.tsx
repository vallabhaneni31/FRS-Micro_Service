import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, Eye, RefreshCw, Calendar, User, X, Radio, Clock, Send, Cpu, Sparkles } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { authConfig } from '../../../../config/authConfig';
import { apiRequest } from '../../../../services/http/apiClient';
import { tokenStorage } from '../../../../services/auth/tokenStorage';
import { fetchAuthedPhotoBlobUrl } from '../../../../services/http/authedPhoto';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useAuth } from '../../../../contexts/AuthContext';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { useEnrollmentProgress, type AngleStage } from '../../../../hooks/useEnrollmentProgress';
import { useRealTimeStatus } from '../../../../hooks/useRealTimeStatus';
import { Button } from '../../../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../../ui/dialog';
import { toast } from 'sonner';

// Canonical capture order — must stay in sync with ANGLES in
// SelfEnrollmentPortal.tsx (the enrollment-link capture flow) and the angle
// list accepted by EnrollmentController.uploadAngle on the backend. Rendered
// dynamically from each approval's own photo_paths keys (not hardcoded to a
// fixed count) so older 5-angle and newer 8-angle submissions both display
// every photo actually captured, instead of silently hiding the extras.
const ANGLE_ORDER = ['front', 'left', 'right', 'up', 'up_deep', 'left_up', 'right_up', 'down'];

const ANGLE_LABELS: { [angle: string]: string } = {
  front: 'Front',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  up_deep: 'Up High',
  left_up: 'Left-Up',
  right_up: 'Right-Up',
  down: 'Down',
};

function orderedAngles(photoPaths: { [angle: string]: string } | undefined): string[] {
  const captured = Object.keys(photoPaths || {});
  const known = ANGLE_ORDER.filter((a) => captured.includes(a));
  const unknown = captured.filter((a) => !ANGLE_ORDER.includes(a));
  return [...known, ...unknown];
}

// Per-stage chip styling for the live progress panel — mirrors the
// quality-score green/yellow/red threshold convention already used
// elsewhere in this file (e.g. the photo grid's quality label).
const STAGE_META: Record<AngleStage, { label: string; icon: React.FC<any>; className: string }> = {
  pending:   { label: 'Pending',   icon: Clock,        className: 'text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-400' },
  queued:    { label: 'Queued',    icon: Send,         className: 'text-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-yellow-400' },
  delivered: { label: 'Delivered', icon: Cpu,          className: 'text-blue-700 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-400' },
  embedded:  { label: 'Embedded',  icon: Sparkles,     className: 'text-green-700 bg-green-50 dark:bg-green-900/20 dark:text-green-400' },
  failed:    { label: 'Failed',    icon: XCircle,      className: 'text-red-700 bg-red-50 dark:bg-red-900/20 dark:text-red-400' },
};

/**
 * Live pipeline-progress panel, shown inline right after clicking Approve.
 * Polls GET /enroll/invitations/:id/progress (nudged by enrollment.completed/
 * failed WebSocket events) via useEnrollmentProgress, and renders one row per
 * captured angle showing which stage it's reached: queued on the device
 * command queue -> delivered to the Jetson -> embedding created (with its
 * quality score) -- or failed. Answers "which frame went, which got
 * enrolled" live, in the same place the admin clicked Approve.
 *
 * Takes only an invitationId (not the full PendingApproval object) so the
 * caller can persist just that number across a page refresh and rehydrate
 * this panel from scratch — name/angle list all come from the progress
 * response itself, not from client-held state that a refresh would wipe.
 */
const EnrollmentProgressPanel: React.FC<{
  invitationId: number;
  onClose: () => void;
}> = ({ invitationId, onClose }) => {
  const { progress, allTerminal } = useEnrollmentProgress(invitationId);
  const { isLive } = useRealTimeStatus();
  const angleNames = Object.keys(progress?.angles ?? {});
  const angles = [
    ...ANGLE_ORDER.filter((a) => angleNames.includes(a)),
    ...angleNames.filter((a) => !ANGLE_ORDER.includes(a)),
  ];

  return (
    <div className="mt-4 p-4 bg-muted/40 rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h5 className="text-sm font-semibold text-slate-800 dark:text-white">
            Enrollment Pipeline{progress?.full_name ? ` — ${progress.full_name}` : ''}
          </h5>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase',
              isLive ? 'text-green-700 bg-green-50 dark:bg-green-900/20 dark:text-green-400' : 'text-slate-500 bg-slate-100 dark:bg-slate-800'
            )}
            title={isLive ? 'Receiving live updates' : 'Falling back to periodic refresh'}
          >
            <Radio className="w-2.5 h-2.5" />
            {isLive ? 'Live' : 'Polling'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          aria-label="Close progress panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {angles.length === 0 && (
        <p className="text-xs text-center text-slate-500 dark:text-slate-400 py-2">
          <RefreshCw className="w-3 h-3 inline animate-spin mr-1.5" />
          Loading pipeline status…
        </p>
      )}

      <div className="space-y-1.5">
        {angles.map((angle) => {
          const angleProgress = progress?.angles?.[angle];
          const stage: AngleStage = angleProgress?.stage ?? 'pending';
          const meta = STAGE_META[stage];
          const Icon = meta.icon;
          return (
            <div
              key={angle}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-background/60 border border-slate-100 dark:border-slate-800"
            >
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300 w-20 shrink-0">
                {ANGLE_LABELS[angle] ?? angle}
              </span>
              <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase', meta.className)}>
                <Icon className="w-3 h-3" />
                {meta.label}
              </span>
              <span className="flex-1 text-right text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                {angleProgress?.embedded_at && angleProgress.quality_score != null
                  ? `${Math.round(angleProgress.quality_score * 100)}% quality`
                  : angleProgress?.delivered_at
                    ? 'Awaiting device result…'
                    : angleProgress?.queued_at
                      ? `Command #${angleProgress.command_id}`
                      : '—'}
              </span>
            </div>
          );
        })}
      </div>

      {allTerminal && (
        <p className="mt-3 text-xs text-center text-slate-500 dark:text-slate-400">
          Pipeline complete — {progress?.approval_status === 'auto_approved' ? 'all angles enrolled successfully.' : 'see status above for any failed angles.'}
        </p>
      )}
    </div>
  );
};

interface PendingApproval {
  pk_invitation_id: number;
  fk_employee_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  average_quality: number;
  quality_scores: { [angle: string]: number };
  photo_paths: { [angle: string]: string };
  completed_at: string;
  approval_status: string;
  device_info?: any;
}

export const PendingEnrollmentApprovals: React.FC<{ onDataChanged?: () => void }> = ({ onDataChanged }) => {
  const scopeHeaders = useScopeHeaders();
  const { isAuthenticated } = useAuth();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<PendingApproval | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  // Kept separately from `approvals` because the invitation drops out of the
  // pending-approvals list the instant approval_status leaves 'pending'.
  // Only the ID is stored — everything else the panel shows (name, angles,
  // stage) comes from GET /enroll/invitations/:id/progress itself, so this
  // is also persisted to sessionStorage and rehydrated on mount: a plain
  // in-memory state was lost on every page refresh even though the
  // enrollment pipeline was still very much alive and trackable server-side.
  const TRACKING_KEY = 'frs.enrollment.trackingInvitationId';
  const [trackingInvitationId, setTrackingInvitationIdState] = useState<number | null>(() => {
    const stored = typeof window !== 'undefined' ? window.sessionStorage.getItem(TRACKING_KEY) : null;
    return stored ? Number(stored) : null;
  });
  const setTrackingInvitationId = (id: number | null) => {
    setTrackingInvitationIdState(id);
    if (id) {
      window.sessionStorage.setItem(TRACKING_KEY, String(id));
    } else {
      window.sessionStorage.removeItem(TRACKING_KEY);
    }
  };

  const [zoomedPhoto, setZoomedPhoto] = useState<{ url: string; label: string; quality: number | null | undefined } | null>(null);

  const [photoData, setPhotoData] = useState<{ [key: string]: string }>({});

  // Close the lightbox on Escape
  useEffect(() => {
    if (!zoomedPhoto) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomedPhoto(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomedPhoto]);

  const fetchPhoto = async (filename: string) => {
    try {
      if (!isAuthenticated) return;
      const url = await fetchAuthedPhotoBlobUrl(filename);
      if (url) {
        setPhotoData(prev => ({ ...prev, [filename]: url }));
      }
    } catch {
      // silently ignore individual photo fetch failures
    }
  };

  const getPhotoUrl = (photoPath: string): string | null => {
    const filename = photoPath.split('/').pop();
    return filename ? (photoData[filename] ?? null) : null;
  };

  useEffect(() => {
    loadPendingApprovals();
  }, [scopeHeaders]);
  
  useEffect(() => {
    // Load photos for all approvals
    approvals.forEach(approval => {
      Object.values(approval.photo_paths || {}).forEach(photoPath => {
        const filename = typeof photoPath === 'string' ? photoPath.split('/').pop() : undefined;
        if (filename && !photoData[filename]) {
          fetchPhoto(filename);
        }
      });
    });
  }, [approvals]);
  
  const loadPendingApprovals = async (isRefreshAction = false) => {
    if (isRefreshAction) setIsRefreshing(true);
    else setLoading(true);
    setLoadError(false);
    try {
      const data = await apiRequest<{ pendingApprovals: PendingApproval[] }>(
        '/enroll/pending-approvals',
        { scopeHeaders, noCache: true }
      );
      setApprovals(data.pendingApprovals || []);
    } catch (err) {
      console.error('Failed to load pending approvals:', err);
      toast.error('Failed to load pending approvals');
      setLoadError(true);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    variant?: 'destructive' | 'default';
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleApprove = async (invitationId: number) => {
    setConfirmConfig({
      title: 'Approve this enrollment?',
      description: 'This will create facial recognition embeddings for the employee.',
      confirmText: 'Approve',
      variant: 'default',
      onConfirm: async () => {
        setActionLoading(true);
        try {
          await apiRequest(`/enroll/invitations/${invitationId}/approve`, {
            method: 'POST',
            scopeHeaders,
          });
          toast.success('Enrollment approved! Tracking pipeline progress below.');
          setSelectedApproval(null);
          setTrackingInvitationId(invitationId);
          await loadPendingApprovals();
          onDataChanged?.();
        } catch (err: any) {
          toast.error(err?.message || 'Failed to approve enrollment');
        } finally {
          setActionLoading(false);
        }
      },
    });
  };

  const [rejectModalInvitationId, setRejectModalInvitationId] = useState<number | null>(null);
  const [rejectReasonPreset, setRejectReasonPreset] = useState<string>('Poor photo quality or lighting');
  const [rejectCustomNotes, setRejectCustomNotes] = useState<string>('');

  const REJECTION_REASON_PRESETS = [
    'Poor photo quality or lighting',
    'Face occlusion / hand or obstacle covering face',
    'Incorrect face angle or posture',
    'Face too far from camera',
    'Other / Custom reason',
  ];

  const openRejectModal = (invitationId: number) => {
    setRejectModalInvitationId(invitationId);
    setRejectReasonPreset('Poor photo quality or lighting');
    setRejectCustomNotes('');
  };

  const handleConfirmReject = async () => {
    if (!rejectModalInvitationId) return;
    const finalReason = rejectReasonPreset === 'Other / Custom reason'
      ? (rejectCustomNotes.trim() || 'Photo quality or alignment issue')
      : (rejectReasonPreset + (rejectCustomNotes.trim() ? `: ${rejectCustomNotes.trim()}` : ''));

    setActionLoading(true);
    try {
      await apiRequest(`/enroll/invitations/${rejectModalInvitationId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: finalReason }),
        scopeHeaders,
      });
      toast.success('Enrollment rejected');
      setSelectedApproval(null);
      setRejectModalInvitationId(null);
      await loadPendingApprovals();
      onDataChanged?.();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reject enrollment');
    } finally {
      setActionLoading(false);
    }
  };
  
  if (loading) {
    return (
      <div className="text-center py-8">
        <RefreshCw className="w-6 h-6 animate-spin text-blue-500 mx-auto mb-2" />
        <p className="text-slate-600 dark:text-slate-400">Loading pending approvals...</p>
      </div>
    );
  }
  
  if (loadError) {
    return (
      <div className="text-center py-12 glass-card rounded-lg border border-slate-200 dark:border-slate-700">
        <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">Unable to load pending approvals</h3>
        <p className="text-slate-600 dark:text-slate-400 mb-4">Please try again.</p>
        <Button variant="outline" size="sm" onClick={loadPendingApprovals}>
          <RefreshCw className="w-3 h-3 mr-1" />
          Retry
        </Button>
      </div>
    );
  }

  if (approvals.length === 0) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12 glass-card rounded-lg border border-slate-200 dark:border-slate-700">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">All caught up!</h3>
          <p className="text-slate-600 dark:text-slate-400">No pending enrollment approvals</p>
        </div>
        {trackingInvitationId && (
          <EnrollmentProgressPanel invitationId={trackingInvitationId} onClose={() => setTrackingInvitationId(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {trackingInvitationId && (
        <EnrollmentProgressPanel invitationId={trackingInvitationId} onClose={() => setTrackingInvitationId(null)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">Pending Approvals</h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {approvals.length} enrollment{approvals.length !== 1 ? 's' : ''} awaiting review
          </p>
        </div>
        <Button onClick={() => loadPendingApprovals(true)} variant="outline" size="sm" disabled={isRefreshing}>
          <RefreshCw className={cn("w-4 h-4 mr-2", isRefreshing && "animate-spin")} />
          {isRefreshing ? 'Fetching...' : 'Refresh'}
        </Button>
      </div>
      
      {/* Approvals Grid */}
      <div className="grid gap-4">
        {approvals.map((approval) => (
          <div
            key={approval.pk_invitation_id}
            className="glass-card rounded-lg border border-slate-200 dark:border-slate-700 p-6"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                  <User className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h4 className="text-lg font-bold text-slate-800 dark:text-white">
                    {approval.full_name}
                  </h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {approval.employee_code} • {approval.email}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-500 flex items-center gap-1 mt-1">
                    <Calendar className="w-3 h-3" />
                    Completed {new Date(approval.completed_at).toLocaleString()}
                  </p>
                </div>
              </div>
              
              <div className="text-right">
                <div className="text-2xl font-bold text-slate-800 dark:text-white">
                  {Math.round(approval.average_quality * 100)}%
                </div>
                <div className="text-xs text-slate-500">Avg Quality</div>
              </div>
            </div>
            
            {/* Photos Preview */}
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 mb-4">
              {orderedAngles(approval.photo_paths).map((angle) => {
                const photoPath = approval.photo_paths?.[angle];
                const quality = approval.quality_scores?.[angle];

                const photoUrl = photoPath ? getPhotoUrl(photoPath) : null;
                const label = ANGLE_LABELS[angle] ?? angle;

                return (
                  <div key={angle} className="text-center">
                    <div className="aspect-square rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-700 mb-1">
                      {photoUrl ? (
                        <img
                          src={photoUrl}
                          alt={angle}
                          onClick={() => setZoomedPhoto({ url: photoUrl, label, quality })}
                          className="w-full h-full object-cover cursor-pointer hover:opacity-80 transition-opacity"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] leading-tight font-medium text-slate-700 dark:text-slate-300 truncate">
                      {ANGLE_LABELS[angle] ?? angle}
                    </p>
                    {quality != null && (
                      <p className={cn(
                        'text-[10px] leading-tight font-semibold',
                        quality >= 0.75 ? 'text-green-600' : 
                        quality >= 0.60 ? 'text-yellow-600' : 
                        'text-red-600'
                      )}>
                        {Math.round(quality * 100)}%
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            
            {/* Actions */}
            <div className="flex gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
              <Button
                onClick={() => setSelectedApproval(selectedApproval?.pk_invitation_id === approval.pk_invitation_id ? null : approval)}
                variant="outline"
                size="sm"
              >
                <Eye className="w-4 h-4 mr-2" />
                {selectedApproval?.pk_invitation_id === approval.pk_invitation_id ? 'Hide' : 'View'} Details
              </Button>
              
              <div className="flex-1" />
              
              <Button
                onClick={() => openRejectModal(approval.pk_invitation_id)}
                variant="outline"
                size="sm"
                disabled={actionLoading}
                className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                <XCircle className="w-4 h-4 mr-2" />
                Reject
              </Button>
              
              <Button
                onClick={() => handleApprove(approval.pk_invitation_id)}
                size="sm"
                disabled={actionLoading}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Approve & Create Embeddings
              </Button>
            </div>
            
            {/* Expanded Details */}
            {selectedApproval?.pk_invitation_id === approval.pk_invitation_id && (
              <div className="mt-4 p-4 bg-muted/40 rounded-lg">
                <h5 className="text-sm font-semibold text-slate-800 dark:text-white mb-3">
                  Enrollment Details
                </h5>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-slate-600 dark:text-slate-400">Employee ID</p>
                    <p className="font-medium text-slate-800 dark:text-white font-mono">{approval.employee_code || '—'}</p>
                  </div>
                  <div>
                    <p className="text-slate-600 dark:text-slate-400">Completed</p>
                    <p className="font-medium text-slate-800 dark:text-white">
                      {new Date(approval.completed_at).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-600 dark:text-slate-400">Average Quality</p>
                    <p className="font-medium text-slate-800 dark:text-white">
                      {Math.round(approval.average_quality * 100)}%
                    </p>
                  </div>
                </div>
                
                {approval.device_info && (
                  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-xs text-slate-500 dark:text-slate-500">
                      Device: {approval.device_info.browser || 'Unknown'} on {approval.device_info.os || 'Unknown'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Photo lightbox — portalled to <body> so the fixed overlay is
          viewport-centred, not trapped by the glass-card ancestor's
          backdrop-filter (which creates a containing block for position:fixed
          descendants, same as the Enrollment History modal below deals with). */}
      {zoomedPhoto && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setZoomedPhoto(null)}
        >
          <div
            className="relative max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setZoomedPhoto(null)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white"
              aria-label="Close"
            >
              <X className="w-7 h-7" />
            </button>
            {/* Same square crop as the thumbnail (object-cover), just scaled up —
                object-contain on the raw camera frame showed the full uncropped
                shot (background/whitespace included), which looked inconsistent
                with the face-focused thumbnail the user clicked on. */}
            <div className="aspect-square w-full rounded-lg overflow-hidden shadow-2xl bg-slate-900">
              <img
                src={zoomedPhoto.url}
                alt={zoomedPhoto.label}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex items-center justify-between mt-3 px-1">
              <p className="text-white font-semibold">{zoomedPhoto.label}</p>
              {zoomedPhoto.quality != null && (
                <p className={cn(
                  'text-sm font-semibold',
                  zoomedPhoto.quality >= 0.75 ? 'text-green-400' :
                  zoomedPhoto.quality >= 0.60 ? 'text-yellow-400' :
                  'text-red-400'
                )}>
                  {Math.round(zoomedPhoto.quality * 100)}% quality
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          variant={confirmConfig.variant || 'destructive'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}

      {/* Rejection Reason Popup Modal */}
      {rejectModalInvitationId !== null && (
        <Dialog open={true} onOpenChange={(open) => { if (!open) setRejectModalInvitationId(null); }}>
          <DialogContent className="glass-card bg-slate-900/95 border-slate-800 text-white max-w-lg shadow-2xl">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold text-white flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-400" />
                Reject Enrollment Invitation
              </DialogTitle>
              <DialogDescription className="text-slate-400 text-sm mt-1">
                Select or provide the reason for rejecting this face enrollment. The employee will be notified.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3">
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-2">
                  Primary Reason
                </label>
                <div className="space-y-2">
                  {REJECTION_REASON_PRESETS.map((preset) => (
                    <label
                      key={preset}
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all text-sm",
                        rejectReasonPreset === preset
                          ? "bg-red-500/10 border-red-500/50 text-white font-medium shadow-sm"
                          : "bg-slate-800/50 border-slate-700/60 text-slate-300 hover:bg-slate-800"
                      )}
                    >
                      <input
                        type="radio"
                        name="rejectionReason"
                        value={preset}
                        checked={rejectReasonPreset === preset}
                        onChange={() => setRejectReasonPreset(preset)}
                        className="accent-red-500 w-4 h-4"
                      />
                      <span>{preset}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-2">
                  Additional Notes / Guidance (Optional)
                </label>
                <textarea
                  value={rejectCustomNotes}
                  onChange={(e) => setRejectCustomNotes(e.target.value)}
                  placeholder="e.g. Please capture photo in brighter room without hands touching face..."
                  rows={3}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 resize-none"
                />
              </div>
            </div>

            <DialogFooter className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                onClick={() => setRejectModalInvitationId(null)}
                disabled={actionLoading}
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmReject}
                disabled={actionLoading}
                className="bg-red-600 hover:bg-red-700 text-white font-bold px-5"
              >
                {actionLoading ? 'Rejecting...' : 'Reject Enrollment'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
