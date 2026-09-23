import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Progress } from '../../../ui/progress';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { toast } from 'sonner';
import {
  Camera, Upload, ScanFace, Trash2, X, Loader2,
  CheckCircle2, AlertTriangle, Wifi, WifiOff, RefreshCw, Info,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Star,
} from 'lucide-react';
import { authConfig } from '../../../../config/authConfig';
import { useAuth } from '../../../../contexts/AuthContext';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';

import { PhotoViewerModal } from './PhotoViewerModal';
import { EnrollmentHistory } from './EnrollmentHistory';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { Clock } from 'lucide-react';

const AuthedEmbeddingThumb: React.FC<{
  photoUrl?: string;
  alt: string;
  className?: string;
  title?: string;
  onClick?: () => void;
}> = ({ photoUrl, alt, className, title, onClick }) => {
  const { url } = useAuthedPhotoUrl(photoUrl);
  return (
    <img
      src={url || ''}
      alt={alt}
      className={className}
      title={title}
      onClick={onClick}
    />
  );
};

export interface EnrollmentEmbedding {
  id: string;
  modelVersion?: string;
  qualityScore?: number;
  isPrimary?: boolean;
  enrolledAt?: string;
  angle?: string;
  photoUrl?: string; 
}

export interface EnrollmentStatus {
  enrolled: boolean;
  embeddingCount: number;
  embeddings: EnrollmentEmbedding[];
}

interface FaceEnrollButtonProps {
  employeeId: string;
  employeeName: string;
  enrolled?: boolean;
  onEnrolled?: (newStatus: EnrollmentStatus) => void;
  compact?: boolean;
}

type PanelState =
  | 'idle' | 'selecting' | 'preview' | 'uploading' | 'enrolling-cam' | 'success' | 'error'
  | 'multi-capture' | 'multi-review' | 'multi-submitting'
  | 'kiosk-pending';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const ANGLES = [
  { id: 'front', label: 'Front',  hint: 'Look straight at the camera',   Icon: null },
  { id: 'left',  label: 'Left',   hint: 'Turn your head slightly left',  Icon: ChevronLeft },
  { id: 'right', label: 'Right',  hint: 'Turn your head slightly right', Icon: ChevronRight },
  { id: 'up',    label: 'Up',     hint: 'Tilt your chin slightly upward',Icon: ChevronUp },
  { id: 'down',  label: 'Down',   hint: 'Gently tilt your chin down',    Icon: ChevronDown },
] as const;

export const FaceEnrollButton: React.FC<FaceEnrollButtonProps> = ({
  employeeId, employeeName, enrolled, onEnrolled, compact,
}) => {
  const { accessToken } = useAuth();
  // Keep a ref so async loops always use the latest token even if it refreshes mid-flight
  const accessTokenRef = useRef(accessToken);
  useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
  const getToken = () => accessTokenRef.current;

  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [isEnrolled, setIsEnrolled] = useState(!!enrolled);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ name: string; id: string } | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [kioskStatus, setKioskStatus] = useState<'idle' | 'sending' | 'waiting'>('idle');

  // Multi-angle state (webcam)
  const [captureStep, setCaptureStep] = useState(0);
  const [capturedBlobs, setCapturedBlobs] = useState<(Blob | null)[]>([null, null, null, null, null]);
  const [capturedThumbs, setCapturedThumbs] = useState<(string | null)[]>([null, null, null, null, null]);
  
  // Track which angles user wants to keep vs re-capture
  const [angleActions, setAngleActions] = useState<('keep' | 'recapture' | 'pending')[]>(['pending', 'pending', 'pending', 'pending', 'pending']);
  
  const [submitProgress, setSubmitProgress] = useState(0);

  // Jetson multi-angle state
  type JetsonAngleResult = { frame: string | null; confidence: number | null; done: boolean };
  const [jetsonStep, setJetsonStep] = useState(0);
  const [jetsonCapturing, setJetsonCapturing] = useState(false);
  const [jetsonResults, setJetsonResults] = useState<JetsonAngleResult[]>(
    Array(5).fill({ frame: null, confidence: null, done: false })
  );

  const [showHistory, setShowHistory] = useState(false);
  const [updatingPrimary, setUpdatingPrimary] = useState(false);
  const [hrConsentAcknowledged, setHrConsentAcknowledged] = useState(false);

  const handleSetPrimary = async (embeddingId: string) => {
    if (!getToken()) {
      toast.error('Not authenticated');
      return;
    }
    if (updatingPrimary) return;
    
    setUpdatingPrimary(true);
    try {
      const response = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/embeddings/${embeddingId}/set-primary`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to set primary');
      }
      
      const result = await response.json();
      toast.success('Primary embedding updated');
      
      // Refresh status
      const statusResp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      const statusData = await statusResp.json();
      setStatus(statusData);
      
    } catch (error) {
      toast.error('Failed to update primary embedding');
      console.error(error);
    } finally {
      setUpdatingPrimary(false);
    }
  };

  // Calculate enrollment quality status
  const getEnrollmentQuality = (embeddings: EnrollmentEmbedding[]) => {
    if (!embeddings || embeddings.length === 0) {
      return { status: 'poor', label: 'Not Enrolled', color: 'bg-red-100 text-red-800 border-red-300' };
    }
    
    const count = embeddings.length;
    const avgQuality = embeddings.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / count;
    
    if (count >= 5 && avgQuality >= 0.70) {
      return { status: 'excellent', label: 'Excellent', color: 'bg-green-100 text-green-800 border-green-300' };
    } else if (count >= 3 && avgQuality >= 0.60) {
      return { status: 'good', label: 'Good', color: 'bg-blue-100 text-blue-800 border-blue-300' };
    } else if (count >= 1) {
      return { status: 'fair', label: 'Fair', color: 'bg-yellow-100 text-yellow-800 border-yellow-300' };
    } else {
      return { status: 'poor', label: 'Poor', color: 'bg-red-100 text-red-800 border-red-300' };
    }
  };

  const enrollmentQuality = status?.embeddings ? getEnrollmentQuality(status.embeddings) : null;

  // Analyze enrollment quality by angle
  const analyzeEnrollment = (embeddings: EnrollmentEmbedding[]) => {
    const excellent = embeddings.filter(e => (e.qualityScore || 0) >= 0.75);
    const needsImprovement = embeddings.filter(e => (e.qualityScore || 0) < 0.60);
    const allAngles = ['front', 'left', 'right', 'up', 'down'];
    const capturedAngles = new Set(embeddings.map(e => e.angle?.toLowerCase()).filter(Boolean));
    // Only reason about "missing angles" when the embeddings actually carry angle
    // metadata — otherwise every angle looks missing and the labels render "null".
    const hasAngleData = capturedAngles.size > 0;
    const missingAngles = hasAngleData ? allAngles.filter(a => !capturedAngles.has(a)) : [];

    return { excellent, needsImprovement, missingAngles, hasAngleData };
  };

  const analysis = status?.embeddings ? analyzeEnrollment(status.embeddings) : null;

  // Generate smart recommendations
  const getRecommendations = (embeddings: EnrollmentEmbedding[], analysis: any) => {
    const recommendations = [];
    
    if (analysis.missingAngles.length > 0) {
      recommendations.push({
        type: 'info',
        icon: Info,
        message: `Capture ${analysis.missingAngles.length} missing angle${analysis.missingAngles.length > 1 ? 's' : ''}: ${analysis.missingAngles.join(', ')}`
      });
    }
    
    if (analysis.needsImprovement.length > 0) {
      recommendations.push({
        type: 'warning',
        icon: AlertTriangle,
        message: `Re-capture ${analysis.needsImprovement.length} low-quality angle${analysis.needsImprovement.length > 1 ? 's' : ''} for better recognition`
      });
    }
    
    if (embeddings.length >= 5 && analysis.needsImprovement.length === 0 && analysis.missingAngles.length === 0) {
      recommendations.push({
        type: 'success',
        icon: CheckCircle2,
        message: 'Enrollment complete! All angles captured with good quality.'
      });
    }
    
    return recommendations;
  };

  const recommendations = analysis && status?.embeddings ? getRecommendations(status.embeddings, analysis) : [];

  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);

  const [photoViewerIndex, setPhotoViewerIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Kiosk enrollment: sets employee status to 'pending_kiosk' so Jetson picks it up on next poll
  const triggerKioskEnrollment = useCallback(async () => {
    if (!getToken()) return;
    setKioskStatus('sending');
    try {
      const r = await fetch(`${authConfig.apiBaseUrl}/face/sync/trigger-enrollment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ employee_id: employeeId }),
      });
      if (!r.ok) throw new Error('Failed to queue kiosk enrollment');
      setKioskStatus('waiting');
      setPanelState('kiosk-pending');
      toast.success('Kiosk enrollment queued', {
        description: `${employeeName} will be prompted at the nearest kiosk device.`,
      });
    } catch (e: any) {
      setKioskStatus('idle');
      toast.error('Failed to queue enrollment', { description: e?.message });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, employeeName]);

  useEffect(() => {
    if (authConfig.mode === 'mock' || !accessToken) return;
    let mounted = true;
    fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    }).then(r => r.ok ? r.json() : null).then(d => {
      if (!mounted || !d) return;
      setStatus({ enrolled: !!d.enrolled, embeddingCount: d.embeddingCount || 0, embeddings: d.embeddings || [] });
      setIsEnrolled(!!d.enrolled);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [accessToken, employeeId]);

  // Poll for enrollment completion while kiosk-pending (kiosk or remote)
  useEffect(() => {
    if (panelState !== 'kiosk-pending' || authConfig.mode === 'mock') return;
    const baseline = status?.embeddingCount ?? 0;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face-direct`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if ((d.count ?? 0) > baseline) {
          clearInterval(iv);
          const s: EnrollmentStatus = { enrolled: true, embeddingCount: d.count, embeddings: [] };
          setIsEnrolled(true); setStatus(s); setKioskStatus('idle'); setPanelState('success');
          onEnrolled?.(s);
          toast.success(`${employeeName} enrolled successfully`);
        }
      } catch (_) {}
    }, 5000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelState]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (stream) stream.getTracks().forEach(t => t.stop()); }, [stream]);
  // Cleanup multi-capture thumb URLs on unmount
  useEffect(() => () => { capturedThumbs.forEach(u => { if (u) URL.revokeObjectURL(u); }); }, []);

  const primaryEmbedding = status?.embeddings?.find(e => e.isPrimary) || status?.embeddings?.[0];

  if (compact) {
    return isEnrolled ? (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <ScanFace className="w-3 h-3 mr-1" />Face Enrolled
      </Badge>
    ) : (
      <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">Not Enrolled</Badge>
    );
  }

  const stopStream = () => {
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null); }
  };

  const resetToIdle = () => {
    stopStream();
    setPanelState('idle');
    setSelectedFile(null);
    setPreviewUrl(null);
    setErrorMessage(null);
    setDuplicateOf(null);
    setCaptureStep(0);
    setCapturedBlobs([null, null, null, null, null]);
    setCapturedThumbs(prev => { prev.forEach(u => { if (u) URL.revokeObjectURL(u); }); return [null, null, null, null, null]; });
    setSubmitProgress(0);
    setHrConsentAcknowledged(false);
  };

  const handleFile = (file: File) => {
    if (!ACCEPTED_TYPES.includes(file.type)) { toast.error('Use JPG, PNG or WEBP'); return; }
    if (file.size > MAX_SIZE_BYTES) { toast.error('Max 5 MB'); return; }
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setPanelState('preview');
  };

  // ── Enroll via photo upload ────────────────────────────────────────────────
  const handlePhotoEnroll = async () => {
    if (!selectedFile) return;
    if (authConfig.mode === 'mock') {
      setTimeout(() => {
        const s: EnrollmentStatus = { enrolled: true, embeddingCount: 1, embeddings: [] };
        setIsEnrolled(true); setStatus(s); setPanelState('success'); onEnrolled?.(s);
      }, 1500);
      return;
    }
    setPanelState('uploading');
    setErrorMessage(null);
    try {
      const form = new FormData();
      form.append('photo', selectedFile);
      const resp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-remote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.message || 'Enrollment failed');
      setKioskStatus('waiting');
      setPanelState('kiosk-pending');
      toast.success('Photo sent to Jetson', { description: 'Enrollment will complete within 30 seconds.' });
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Enrollment failed');
      setPanelState('error');
    }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDelete = async () => {
    setConfirmConfig({
      title: `Remove ${employeeName}'s face enrollment?`,
      description: "They won't be recognized by cameras until re-enrolled.",
      confirmText: 'Remove Enrollment',
      onConfirm: async () => {
        if (authConfig.mode === 'mock') { setIsEnrolled(false); setStatus(null); resetToIdle(); return; }
        try {
          const r = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          });
          if (!r.ok) throw new Error('Failed to remove');
          toast.success('Enrollment removed', { description: `${employeeName} can be re-enrolled.` });
          setIsEnrolled(false); setStatus(null); resetToIdle();
          onEnrolled?.({ enrolled: false, embeddingCount: 0, embeddings: [] });
        } catch (e) {
          toast.error('Delete failed', { description: e instanceof Error ? e.message : 'Unknown error' });
        }
      },
    });
  };

  // ── Single webcam ──────────────────────────────────────────────────────────
  const startWebcam = async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      setStream(media);
      setPanelState('selecting');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (videoRef.current) { videoRef.current.srcObject = media; videoRef.current.play().catch(() => {}); }
      }));
    } catch {
      toast.error('Webcam unavailable', { description: 'Allow camera access in browser settings, or upload a photo instead.' });
    }
  };

  const captureWebcam = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(async (blob) => {
      if (!blob) return;
      stopStream();
      setPanelState('uploading');
      try {
        const embedding: number[] | null = null;
        const confidence = 0.8;
        let resp: Response;
        const form = new FormData();
        form.append('photo', new File([blob], 'webcam.jpg', { type: 'image/jpeg' }));
        resp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-remote`, {
          method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.message || data.error || `Upload failed (${resp.status})`);
        setKioskStatus('waiting');
        setPanelState('kiosk-pending');
        toast.success('Photo sent to Jetson', { description: 'Enrollment will complete within 30 seconds.' });
      } catch (e: any) {
        setPanelState('error');
        setErrorMessage(e?.message || 'Webcam enrollment failed');
        toast.error('Enrollment failed', { description: e?.message });
      }
    }, 'image/jpeg', 0.95);
  };

  // ── 5-angle capture ────────────────────────────────────────────────────────
  const startMultiCapture = async () => {
    setCaptureStep(0);
    
    // Pre-populate with existing photos
    const initialBlobs: (Blob | null)[] = [null, null, null, null, null];
    const initialThumbs: (string | null)[] = [null, null, null, null, null];
    
    if (status?.embeddings) {
      for (const emb of status.embeddings) {
        const angleIndex = ANGLES.findIndex(a => a.id === emb.angle?.toLowerCase());
        if (angleIndex >= 0 && emb.photoUrl) {
          try {
            // Fetch existing photo as blob
            const response = await fetch(`${authConfig.apiBaseUrl.replace(/\/api$/, '')}${emb.photoUrl}`);
            const blob = await response.blob();
            initialBlobs[angleIndex] = blob;
            initialThumbs[angleIndex] = URL.createObjectURL(blob);
          } catch (err) {
            console.warn(`Failed to load existing photo for ${emb.angle}:`, err);
          }
        }
      }
    }
    
    setCapturedBlobs(initialBlobs);
    setCapturedThumbs(prev => { 
      prev.forEach(u => { if (u) URL.revokeObjectURL(u); }); 
      return initialThumbs; 
    });
    
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      setStream(media);
      setPanelState('multi-capture');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (videoRef.current) { videoRef.current.srcObject = media; videoRef.current.play().catch(() => {}); }
      }));
    } catch {
      toast.error('Webcam unavailable', { description: 'Allow camera access in browser settings.' });
    }
  };

  const captureCurrentAngle = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return;
      const thumbUrl = URL.createObjectURL(blob);
      setCapturedBlobs(prev => { const n = [...prev]; n[captureStep] = blob; return n; });
      setCapturedThumbs(prev => {
        const n = [...prev];
        if (n[captureStep]) URL.revokeObjectURL(n[captureStep]!);
        n[captureStep] = thumbUrl;
        return n;
      });
      if (captureStep < 4) {
        setCaptureStep(s => s + 1);
      } else {
        // All 5 captured — stop webcam and show review
        stopStream();
        setPanelState('multi-review');
      }
    }, 'image/jpeg', 0.95);
  };

  const retakeAngle = (idx: number) => {
    setCapturedBlobs(prev => { const n = [...prev]; n[idx] = null; return n; });
    setCapturedThumbs(prev => {
      const n = [...prev];
      if (n[idx]) URL.revokeObjectURL(n[idx]!);
      n[idx] = null;
      return n;
    });
    setCaptureStep(idx);
    // Restart webcam if needed
    if (!stream) {
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } })
        .then(media => {
          setStream(media);
          setPanelState('multi-capture');
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (videoRef.current) { videoRef.current.srcObject = media; videoRef.current.play().catch(() => {}); }
          }));
        }).catch(() => toast.error('Webcam unavailable'));
    } else {
      setPanelState('multi-capture');
    }
  };

  const submitAllAngles = async () => {
    if (authConfig.mode === 'mock') {
      const s: EnrollmentStatus = { enrolled: true, embeddingCount: 5, embeddings: [] };
      setIsEnrolled(true); setStatus(s); setPanelState('success'); onEnrolled?.(s);
      return;
    }
    setPanelState('multi-submitting');
    setSubmitProgress(0);
    let successCount = 0;
    let firstError = '';
    for (let i = 0; i < 5; i++) {
      const blob = capturedBlobs[i];
      if (!blob) { setSubmitProgress(i + 1); continue; }
      try {
        const form = new FormData();
        form.append('photo', new File([blob], `${ANGLES[i].id}.jpg`, { type: 'image/jpeg' }));
        form.append('angle', ANGLES[i].id);
        const resp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: form,
        });
        if (resp.ok) {
          successCount++;
        } else {
          const d = await resp.json().catch(() => ({}));
          const msg = d.message || d.error || `HTTP ${resp.status}`;
          if (!firstError) firstError = `${ANGLES[i].label}: ${msg}`;
          toast.warning(`${ANGLES[i].label} angle skipped`, { description: msg });
        }
      } catch (e: any) {
        const msg = e?.message || 'Network error';
        if (!firstError) firstError = `${ANGLES[i].label}: ${msg}`;
      }
      setSubmitProgress(i + 1);
    }

    if (successCount > 0) {
      const statusResp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      }).catch(() => null);
      const statusData = statusResp?.ok ? await statusResp.json().catch(() => null) : null;
      const s: EnrollmentStatus = statusData
        ? { enrolled: true, embeddingCount: statusData.embeddingCount || successCount, embeddings: statusData.embeddings || [] }
        : { enrolled: true, embeddingCount: successCount, embeddings: [] };
      setIsEnrolled(true); setStatus(s); setPanelState('success'); onEnrolled?.(s);
      toast.success(`${employeeName} enrolled`, { description: `${successCount}/5 angles stored` });
    } else {
      const hint = firstError.toLowerCase().includes('no face')
        ? 'Face not detected — ensure good lighting and look directly at the camera for each capture.'
        : firstError || 'All angle submissions failed.';
      setErrorMessage(hint);
      setPanelState('error');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const cardCn = cn('border rounded-xl p-4 space-y-4',
    lightTheme.background.card, lightTheme.border.default, 'dark:bg-slate-900 dark:border-border');

  const currentAngle = ANGLES[captureStep];
  const AngleIcon = currentAngle?.Icon;

  return (
    <div className="space-y-4">
      {/* Enrolled status bar */}
      {isEnrolled && panelState === 'idle' && (
        <div className="rounded-2xl border border-emerald-100 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/15 p-4 flex items-start gap-3">
          <span className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-black text-slate-800 dark:text-white">Face enrolled</p>
              {enrollmentQuality && (
                <span className={cn('text-[10px] px-2 py-0.5 rounded-full border font-bold', enrollmentQuality.color)}>
                  {enrollmentQuality.label}
                </span>
              )}
            </div>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-0.5">
              {status?.embeddingCount ?? 1} capture(s) · {status?.embeddings ? (status.embeddings.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / status.embeddings.length * 100).toFixed(0) : 0}% avg quality{primaryEmbedding?.enrolledAt ? ` · ${new Date(primaryEmbedding.enrolledAt).toLocaleDateString()}` : ''}
            </p>
            {status?.embeddings && status.embeddings.some(e => e.photoUrl) && (
              <div className="grid grid-cols-2 gap-2.5 mt-2">
                {status.embeddings.filter(e => e.photoUrl).map((emb, idx) => {
  // Calculate quality badge color
  const quality = emb.qualityScore || 0;
  const qualityClass = quality >= 0.75
    ? 'ring-emerald-500'
    : quality >= 0.60
    ? 'ring-amber-500'
    : 'ring-red-500';
  const qualityBadgeClass = quality >= 0.75
    ? 'bg-emerald-500'
    : quality >= 0.60
    ? 'bg-amber-500'
    : 'bg-red-500';

  return (
    <div key={emb.id} className="relative aspect-square">
      <AuthedEmbeddingThumb
        photoUrl={emb.photoUrl}
        alt={emb.angle || `Capture ${idx + 1}`}
        className={cn(
          "w-full h-full rounded-xl object-cover ring-2 hover:scale-105 transition-transform cursor-pointer",
          qualityClass
        )}
        title={`${emb.angle ? emb.angle.charAt(0).toUpperCase() + emb.angle.slice(1) : `Capture ${idx + 1}`}${emb.isPrimary ? ' · Primary' : ''}`}
        onClick={() => {
          setPhotoViewerIndex(idx);
          setPhotoViewerOpen(true);
        }}
      />
      {/* Quality % shown directly on the photo (not just in a hover tooltip
          or a separate text list below) — a small caption bar over the
          bottom edge of the thumbnail itself. */}
      <span
        className={cn(
          'pointer-events-none absolute bottom-0 left-0 right-0 rounded-b-xl px-1 py-0.5 text-center text-[11px] font-black text-white',
          qualityBadgeClass
        )}
      >
        {(quality * 100).toFixed(0)}%
      </span>
      {/* Star - clickable to set as primary */}
      <button
        onClick={(e) => {
          e.stopPropagation(); // Don't trigger photo viewer
          if (emb.id && !updatingPrimary) {
            handleSetPrimary(emb.id);
          }
        }}
        disabled={updatingPrimary}
        className={cn(
          'absolute -top-1 -right-1 rounded-full p-0.5 transition-all',
          emb.isPrimary
            ? 'bg-yellow-400 cursor-default'
            : 'bg-slate-200 hover:bg-yellow-300 cursor-pointer dark:bg-slate-700 dark:hover:bg-yellow-400'
        )}
        title={emb.isPrimary ? 'Primary embedding' : 'Click to set as primary'}
      >
        <Star className={cn('w-2.5 h-2.5 transition-colors',
          emb.isPrimary ? 'text-yellow-900 fill-yellow-900' : 'text-slate-400 dark:text-slate-500')} />
      </button>
    </div>
  );
})}
            
            {/* Smart Recommendations */}
            {recommendations.length > 0 && (
              <div className="mt-2 space-y-1">
                {recommendations.map((rec, idx) => {
                  const Icon = rec.icon;
                  const colorClass = rec.type === 'success' 
                    ? 'text-green-700 dark:text-green-400' 
                    : rec.type === 'warning' 
                    ? 'text-yellow-700 dark:text-yellow-400' 
                    : 'text-blue-700 dark:text-blue-400';
                  
                  return (
                    <div key={idx} className="flex items-start gap-1.5">
                      <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', colorClass)} />
                      <span className={cn('text-[11px] font-medium', colorClass)}>
                        {rec.message}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
              </div>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => setShowHistory(true)}
            title="View enrollment history"
            className="shrink-0"
          >
            <Clock className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleDelete} className="text-red-500 hover:text-red-600 shrink-0">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* Idle — method picker */}
      {panelState === 'idle' && (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          className="space-y-3"
        >
          {/* Consent gate — both methods require this first */}
          <label className={cn(
            'flex items-start gap-3 cursor-pointer rounded-xl border p-3 transition-colors',
            hrConsentAcknowledged
              ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20'
              : 'border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20',
          )}>
            <input
              type="checkbox"
              checked={hrConsentAcknowledged}
              onChange={(e) => setHrConsentAcknowledged(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
              aria-label="HR consent acknowledgment"
            />
            <div className="min-w-0">
              <p className={cn('text-xs font-black', hrConsentAcknowledged ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
                {hrConsentAcknowledged ? 'Biometric consent confirmed' : 'Biometric consent required'}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                I confirm this employee has provided written biometric consent in accordance with company policy and applicable data-protection laws.
              </p>
            </div>
          </label>

          {/* Kiosk Device Enrollment — recommended path (Jetson picks up on next poll) */}
          <div className="rounded-xl border border-violet-200 dark:border-violet-900/50 bg-violet-50/50 dark:bg-violet-950/20 p-4">
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
                <ScanFace className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-slate-800 dark:text-slate-100">Kiosk Device Enrollment</span>
                  <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-violet-600 text-white">Recommended</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  Queues a capture task — {employeeName || 'the employee'} scans their face at the nearest kiosk for the best multi-angle quality.
                </p>
              </div>
            </div>
            <Button
              className="w-full mt-3"
              disabled={!hrConsentAcknowledged || kioskStatus === 'sending' || kioskStatus === 'waiting'}
              onClick={triggerKioskEnrollment}
            >
              {kioskStatus === 'sending'
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
                : kioskStatus === 'waiting'
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for kiosk…</>
                : <><ScanFace className="w-4 h-4 mr-2" />{isEnrolled ? 'Re-Enroll at Kiosk' : 'Enroll at Kiosk Device'}</>
              }
            </Button>
            {!hrConsentAcknowledged && (
              <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" /> Confirm consent above to enable enrollment.
              </p>
            )}
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-dashed border-slate-200 dark:border-slate-700" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 shrink-0">or use browser</span>
            <div className="flex-1 border-t border-dashed border-slate-200 dark:border-slate-700" />
          </div>

          {/* Upload via browser (also the drop target) */}
          <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-4 text-center">
            <Upload className="w-5 h-5 text-slate-400 mx-auto mb-2" />
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={!hrConsentAcknowledged}>
              <Upload className="w-4 h-4 mr-2" />Upload Photo
            </Button>
            <p className="text-[11px] text-slate-400 mt-2">Drag &amp; drop or browse · JPG / PNG / WEBP up to 5 MB</p>
            <div className="inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300 px-2.5 py-1 rounded-full mt-2">
              <Info className="w-3 h-3" />
              One face · Good lighting · No sunglasses
            </div>
          </div>
        </div>
      )}

      {/* ── Kiosk pending panel ── */}
      {panelState === 'kiosk-pending' && (
        <div className={cardCn}>
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-white">Waiting for kiosk enrollment</p>
              <p className="text-xs text-slate-500 mt-1">
                {employeeName} will be prompted to scan their face when they approach a kiosk device.
              </p>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 dark:bg-violet-900/20 dark:border-violet-900/40 px-3 py-2 w-full text-left">
              <Info className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-violet-700 dark:text-violet-300">
                The page will update automatically when enrollment is complete. You can navigate away — the kiosk task stays queued.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setKioskStatus('idle'); resetToIdle(); }}>
              <X className="w-3 h-3 mr-1" />Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Single webcam */}
      {panelState === 'selecting' && (
        <div className={cardCn}>
          <div className="relative overflow-hidden rounded-lg">
            <video ref={videoRef} className="w-full rounded-lg" autoPlay muted playsInline onLoadedMetadata={() => videoRef.current?.play()} />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-48 h-64 border-2 border-emerald-400/70 rounded-full bg-emerald-500/5" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={captureWebcam}><Camera className="w-4 h-4 mr-2" />Capture</Button>
            <Button variant="outline" className="flex-1" onClick={() => { stopStream(); resetToIdle(); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* 5-angle capture wizard */}
      {panelState === 'multi-capture' && (
        <div className={cardCn}>
          {/* Step indicator */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">5-Angle Capture</span>
            <span className="text-xs font-bold text-blue-500">{captureStep + 1} / 5</span>
          </div>
          <div className="flex gap-1.5 mb-3">
            {ANGLES.map((a, i) => (
              <div key={a.id} className={cn(
                'flex-1 h-1.5 rounded-full transition-all',
                i < captureStep ? 'bg-emerald-500' : i === captureStep ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-700'
              )} />
            ))}
          </div>

          {/* Angle instruction */}
          <div className="flex items-center justify-center gap-3 py-2 px-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/40 mb-2">
            {AngleIcon
              ? <AngleIcon className="w-6 h-6 text-blue-500 shrink-0" />
              : <ScanFace className="w-6 h-6 text-blue-500 shrink-0" />
            }
            <div>
              <p className="text-sm font-bold text-blue-800 dark:text-blue-200">{currentAngle.label}</p>
              <p className="text-xs text-blue-600 dark:text-blue-300">{currentAngle.hint}</p>
            </div>
          </div>

          {/* Camera feed */}
          <div className="relative overflow-hidden rounded-lg">
            <video ref={videoRef} className="w-full rounded-lg" autoPlay muted playsInline onLoadedMetadata={() => videoRef.current?.play()} />
            {/* Face oval overlay */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className={cn(
                'w-44 h-60 border-2 rounded-full',
                captureStep === 0 ? 'border-blue-400/80 bg-blue-500/5' : 'border-emerald-400/60 bg-emerald-500/5'
              )} />
            </div>
            {/* Tip overlay */}
            <div className="pointer-events-none absolute bottom-2 left-0 right-0 flex justify-center">
              <span className="text-[10px] text-white/80 bg-black/40 rounded px-2 py-0.5">
                Fill the oval · good lighting · {captureStep === 0 ? 'face camera directly' : currentAngle.hint}
              </span>
            </div>
            {/* Direction arrow overlay */}
            {AngleIcon && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <AngleIcon className="w-16 h-16 text-white/50 drop-shadow-lg" />
              </div>
            )}
          </div>

          {/* Thumbnail strip of captured angles */}
          <div className="flex gap-1.5 mt-1">
            {ANGLES.map((a, i) => (
              <div key={a.id} className="flex-1 space-y-1">
                {capturedThumbs[i] ? (
                  <img src={capturedThumbs[i]!} alt={a.label}
                    className="w-full aspect-square object-cover rounded border-2 border-emerald-500" />
                ) : (
                  <div className={cn(
                    'w-full aspect-square rounded border-2 flex items-center justify-center',
                    i === captureStep
                      ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/50'
                  )}>
                    <span className="text-[10px] text-slate-400">{i + 1}</span>
                  </div>
                )}
                <p className="text-[9px] text-center text-slate-400 font-medium uppercase">{a.label}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-2">
            <Button className="flex-1" onClick={captureCurrentAngle}>
              <Camera className="w-4 h-4 mr-2" />Capture {currentAngle.label}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { stopStream(); resetToIdle(); }}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* 5-angle review */}
      {panelState === 'multi-review' && (
        <div className={cardCn}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-slate-800 dark:text-white">Review Captures</p>
            <span className="text-xs text-emerald-600 font-semibold">All 5 angles captured</span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {ANGLES.map((a, i) => (
              <div key={a.id} className="space-y-1">
                <div className="relative">
                  {capturedThumbs[i] ? (
                    <img src={capturedThumbs[i]!} alt={a.label}
                      className="w-full aspect-square object-cover rounded-lg border-2 border-emerald-500" />
                  ) : (
                    <div className="w-full aspect-square rounded-lg border-2 border-dashed border-red-300 bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                    </div>
                  )}
                  <button
                    onClick={() => retakeAngle(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-slate-700 hover:bg-blue-600 text-white rounded-full flex items-center justify-center transition-colors"
                    title={`Retake ${a.label}`}
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                  </button>
                </div>
                <p className="text-[10px] text-center text-slate-500 font-medium uppercase">{a.label}</p>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-slate-400">
            Click <RefreshCw className="w-3 h-3 inline" /> on any thumbnail to retake that angle.
          </p>

          <div className="flex gap-2">
            <Button className="flex-1" onClick={submitAllAngles}>
              <ScanFace className="w-4 h-4 mr-2" />Enroll All 5 Angles
            </Button>
            <Button variant="outline" onClick={() => { setCaptureStep(0); startMultiCapture(); }}>
              Retake All
            </Button>
          </div>
        </div>
      )}

      {/* Submitting all angles */}
      {panelState === 'multi-submitting' && (
        <div className={cardCn}>
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />
            <div>
              <p className={cn('text-sm font-medium', lightTheme.text.primary, 'dark:text-white')}>
                Enrolling angle {submitProgress + 1} / 5…
              </p>
              <p className={cn('text-xs', lightTheme.text.muted, 'dark:text-slate-400')}>
                Running face detection and ArcFace embedding for each angle
              </p>
            </div>
          </div>
          <Progress value={(submitProgress / 5) * 100} className="h-2" />
          <div className="flex gap-1">
            {ANGLES.map((a, i) => (
              <div key={a.id} className={cn(
                'flex-1 flex flex-col items-center gap-1',
              )}>
                <div className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-[10px]',
                  i < submitProgress ? 'bg-emerald-500 text-white' :
                  i === submitProgress ? 'bg-blue-100 dark:bg-blue-900/40 border-2 border-blue-500 text-blue-600' :
                  'bg-slate-100 dark:bg-slate-800 text-slate-400'
                )}>
                  {i < submitProgress ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <span className="text-[9px] text-slate-400 uppercase">{a.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Single photo preview */}
      {panelState === 'preview' && previewUrl && (
        <div className={cardCn}>
          <div className="relative">
            <img src={previewUrl} alt="Preview" className="w-full rounded-lg object-cover max-h-64" />
            <Button variant="ghost" size="icon" className="absolute top-2 right-2 bg-white/80 dark:bg-slate-800/80" onClick={resetToIdle}>
              <X className="w-4 h-4" />
            </Button>
          </div>
          <Button onClick={handlePhotoEnroll} className="w-full">
            {isEnrolled ? 'Re-Enroll with This Photo' : 'Enroll with This Photo'}
          </Button>
        </div>
      )}

      {/* Processing */}
      {(panelState === 'uploading' || panelState === 'enrolling-cam') && (
        <div className={cardCn}>
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />
            <div>
              <p className={cn('text-sm font-medium', lightTheme.text.primary, 'dark:text-white')}>
                {panelState === 'enrolling-cam' ? 'Capturing from camera…' : 'Processing photo…'}
              </p>
              <p className={cn('text-xs', lightTheme.text.muted, 'dark:text-slate-400')}>
                {panelState === 'enrolling-cam'
                  ? 'Jetson: ISAPI snapshot → YOLOv8 → ArcFace → pgvector (up to 30s)'
                  : 'Running face detection and ArcFace embedding…'}
              </p>
            </div>
          </div>
          <Progress value={panelState === 'enrolling-cam' ? 45 : 65} className="h-1.5 animate-pulse" />
        </div>
      )}

      {/* Success */}
      {panelState === 'success' && (
        <div className="space-y-3">
          <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="text-sm">
              <strong>{employeeName}</strong> enrolled — will be recognised by cameras within 30 seconds.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={resetToIdle}>Add More Angles</Button>
        </div>
      )}

      {/* Error */}
      {panelState === 'error' && (
        <div className="space-y-3">
          {duplicateOf ? (
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="text-sm font-bold">Duplicate face detected</p>
                <p className="text-xs mt-0.5">
                  This face is already enrolled as <strong>{duplicateOf.name}</strong>. Each person can only have one face profile.
                </p>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-xl border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/20 text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="text-sm">{errorMessage || 'Enrollment failed. Try again.'}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={resetToIdle}>Try Again</Button>
            <Button variant="ghost" size="sm" onClick={triggerKioskEnrollment}>
              <RefreshCw className="w-3 h-3 mr-1" />Try Kiosk
            </Button>
          </div>
        </div>
      )}

      <input ref={inputRef} type="file" accept={ACCEPTED_TYPES.join(',')} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.currentTarget.value = ''; }} />
      <canvas ref={canvasRef} className="hidden" />
      
      {/* Photo Viewer Modal */}
      {photoViewerOpen && status?.embeddings && (
        <PhotoViewerModal
          photos={status.embeddings.filter((e): e is EnrollmentEmbedding & Required<Pick<EnrollmentEmbedding, 'photoUrl'>> => Boolean(e?.photoUrl)) as any[]}
          initialIndex={photoViewerIndex}
          onClose={() => setPhotoViewerOpen(false)}
onDelete={async (id, angle) => {
  setConfirmConfig({
    title: `Delete ${angle || 'this'} photo?`,
    description: 'This will reduce overall enrollment quality score.',
    confirmText: 'Delete Photo',
    onConfirm: async () => {
      try {
        const response = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/embeddings/${id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getToken()}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to delete embedding');
        }
        
        setPhotoViewerOpen(false);
        
        const statusResp = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enroll-face`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        const statusData = statusResp.ok ? await statusResp.json() : null;
        const newStatus: EnrollmentStatus = statusData 
          ? { enrolled: !!statusData.enrolled, embeddingCount: statusData.embeddingCount || 0, embeddings: statusData.embeddings || [] }
          : { enrolled: false, embeddingCount: 0, embeddings: [] };
        setStatus(newStatus);
        setIsEnrolled(newStatus.enrolled);
        onEnrolled?.(newStatus);
        
        toast.success('Photo deleted successfully');
      } catch (error) {
        console.error('Delete failed:', error);
        toast.error('Failed to delete photo. Please try again.');
      }
    },
  });
}}
        />
      )}

      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}

      {/* Enrollment History Modal — portalled to <body> so the fixed overlay is
          viewport-centred, not trapped by a transformed / glass-card ancestor. */}
      {showHistory && createPortal(
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="glass-card rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
              <h2 className="text-lg font-bold">Enrollment History</h2>
              <Button variant="ghost" size="icon" onClick={() => setShowHistory(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <EnrollmentHistory employeeId={employeeId} employeeName={employeeName} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
