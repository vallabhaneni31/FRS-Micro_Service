import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiRequest, ApiError } from '../../../../services/http/apiClient';
import {
  Trash2, AlertTriangle, Loader2, X, Check, ScanFace,
  CalendarDays, Camera, FileText, ShieldCheck, ArrowRight, ArrowLeft,
} from 'lucide-react';
import { cn } from '../../../ui/utils';

interface Employee {
  id: string;
  name: string;
  employeeCode?: string;
}

interface ErasureSummary {
  embeddings: number;
  attendanceRecords: number;
  enrollmentPhotos: number;
  auditEntries: number;
}

interface Props {
  employee: Employee;
  open: boolean;
  onClose: () => void;
  onErased: () => void;
  scopeHeaders?: Record<string, string>;
}

type Step = 'impact' | 'reason' | 'confirm' | 'done';

const ERASURE_REASONS = [
  'Employee Request',
  'Legal Order / Court Direction',
  'Termination / End of Employment',
  'Data Minimisation Policy',
  'Consent Withdrawn',
  'Other',
] as const;

const STEP_ORDER: Step[] = ['impact', 'reason', 'confirm'];
const STEP_LABELS = ['Impact', 'Reason', 'Confirm'];

export const ErasureConfirmationModal: React.FC<Props> = ({
  employee,
  open,
  onClose,
  onErased,
  scopeHeaders,
}) => {
  const [step, setStep] = useState<Step>('impact');
  const [summary, setSummary] = useState<ErasureSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erasureRef, setErasureRef] = useState<string | null>(null);

  // Load impact summary when modal opens
  React.useEffect(() => {
    if (!open || step !== 'impact') return;
    setSummaryLoading(true);
    apiRequest<ErasureSummary>(`/employees/${employee.id}/erasure-summary`, {
      scopeHeaders,
    })
      .then(setSummary)
      .catch(() => setSummary({ embeddings: 0, attendanceRecords: 0, enrollmentPhotos: 0, auditEntries: 0 }))
      .finally(() => setSummaryLoading(false));
  }, [open, employee.id, step]);

  const handleErase = async () => {
    if (confirmName.trim() !== employee.name.trim()) {
      setError('Employee name does not match. Please type the exact name.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<{ erasureReferenceId: string }>(
        `/employees/${employee.id}/erase`,
        {
          method: 'DELETE',
          body: JSON.stringify({ reason, reference }),
          scopeHeaders,
        }
      );
      setErasureRef(result.erasureReferenceId ?? `ERA-${Date.now()}`);
      setStep('done');
      onErased();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erasure failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setStep('impact');
    setSummary(null);
    setReason('');
    setReference('');
    setConfirmName('');
    setError(null);
    setErasureRef(null);
    onClose();
  };

  const stepIndex = STEP_ORDER.indexOf(step);
  const nameMatches = confirmName.trim() === employee.name.trim();

  const totalItems = summary
    ? summary.embeddings + summary.attendanceRecords + summary.enrollmentPhotos + summary.auditEntries
    : null;

  const IMPACT_ROWS = [
    { label: 'Face embeddings',   icon: ScanFace,     count: summary?.embeddings },
    { label: 'Attendance records', icon: CalendarDays, count: summary?.attendanceRecords },
    { label: 'Enrollment photos',  icon: Camera,       count: summary?.enrollmentPhotos },
    { label: 'Audit log entries',  icon: FileText,     count: summary?.auditEntries },
  ];

  const inputCn = 'w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none transition';
  const ghostBtn = 'flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors font-bold text-sm flex items-center justify-center gap-2';
  const dangerBtn = 'flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-colors flex items-center justify-center gap-2';

  const isDone = step === 'done';

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[100] animate-in fade-in duration-200" />
        <Dialog.Content
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 focus:outline-none"
          aria-describedby="erasure-description"
        >
          <div className="w-full max-w-md max-h-[88vh] flex flex-col overflow-hidden rounded-3xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10 animate-in zoom-in-95 duration-200">

            {/* Header */}
            <div className={cn('relative px-5 pt-5 pb-4 text-white',
              isDone ? 'bg-gradient-to-br from-emerald-600 to-teal-600' : 'bg-gradient-to-br from-rose-600 via-red-600 to-red-700')}>
              <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:16px_16px]" />
              {!isDone && (
                <Dialog.Close onClick={handleClose} className="absolute top-4 right-4 p-1.5 rounded-full bg-white/15 hover:bg-white/30 transition-colors" aria-label="Close">
                  <X className="w-4 h-4" />
                </Dialog.Close>
              )}
              <div className="relative flex items-center gap-3">
                <span className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
                  {isDone ? <ShieldCheck className="w-5 h-5" /> : <Trash2 className="w-5 h-5" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/70">GDPR · Right to erasure</p>
                  <Dialog.Title className="text-base font-black truncate">
                    {isDone ? 'Data Erased' : 'Request Data Erasure'}
                  </Dialog.Title>
                </div>
              </div>

              {/* Step indicator */}
              {!isDone && (
                <div className="relative mt-4 flex items-center gap-1.5">
                  {STEP_LABELS.map((lbl, i) => (
                    <React.Fragment key={lbl}>
                      <div className="flex items-center gap-1.5">
                        <span className={cn('w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center transition-colors',
                          i < stepIndex ? 'bg-white text-red-600'
                          : i === stepIndex ? 'bg-white text-red-600 ring-2 ring-white/40'
                          : 'bg-white/20 text-white/80')}>
                          {i < stepIndex ? <Check className="w-3 h-3" /> : i + 1}
                        </span>
                        <span className={cn('text-[10px] font-bold uppercase tracking-wide', i === stepIndex ? 'text-white' : 'text-white/60')}>{lbl}</span>
                      </div>
                      {i < STEP_LABELS.length - 1 && <span className={cn('flex-1 h-px', i < stepIndex ? 'bg-white/70' : 'bg-white/20')} />}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>

            {/* Body */}
            <div className="p-5 overflow-y-auto" id="erasure-description">
              {/* Step 1: Impact */}
              {step === 'impact' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50">
                    <div className="flex items-center gap-2 mb-1.5">
                      <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" aria-hidden="true" />
                      <span className="font-black text-red-700 dark:text-red-400">This action is permanent and irreversible</span>
                    </div>
                    <p className="text-sm text-red-600/90 dark:text-red-400/90 leading-relaxed">
                      All biometric and personal data for <strong>{employee.name}</strong>
                      {employee.employeeCode ? <> (<span className="font-mono">{employee.employeeCode}</span>)</> : null} will be permanently deleted:
                    </p>
                  </div>

                  {summaryLoading ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {IMPACT_ROWS.map(({ label, icon: Icon, count }) => (
                        <div key={label} className="rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-3">
                          <div className="flex items-center justify-between">
                            <span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center justify-center">
                              <Icon className="w-3.5 h-3.5" />
                            </span>
                            <span className="text-xl font-black text-red-600 dark:text-red-400 leading-none">{count ?? '—'}</span>
                          </div>
                          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-2">{label}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {totalItems != null && totalItems > 0 && (
                    <p className="text-xs text-slate-400 text-center">
                      <strong className="text-slate-600 dark:text-slate-300">{totalItems}</strong> record(s) will be destroyed.
                    </p>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button onClick={handleClose} className={ghostBtn}>Cancel</button>
                    <button onClick={() => setStep('reason')} className={dangerBtn}>
                      I understand <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2: Reason */}
              {step === 'reason' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
                      Reason for erasure <span className="text-red-500">*</span>
                    </label>
                    <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputCn}>
                      <option value="">Select a reason…</option>
                      {ERASURE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
                      Reference number <span className="text-slate-400 font-medium normal-case">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. GDPR-REQ-2026-001"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      className={cn(inputCn, 'font-mono')}
                    />
                    <p className="text-[11px] text-slate-400 mt-1.5">Links this erasure to a ticket or legal request in the audit log.</p>
                  </div>

                  <div className="flex gap-3 pt-1">
                    <button onClick={() => setStep('impact')} className={ghostBtn}>
                      <ArrowLeft className="w-4 h-4" /> Back
                    </button>
                    <button onClick={() => setStep('confirm')} disabled={!reason} className={dangerBtn}>
                      Continue <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Final confirmation */}
              {step === 'confirm' && (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 p-3.5 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-400">Reason</span>
                      <span className="font-semibold text-slate-700 dark:text-slate-200 text-right">{reason}</span>
                    </div>
                    {reference && (
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-400">Reference</span>
                        <span className="font-mono font-semibold text-slate-700 dark:text-slate-200 text-right break-all">{reference}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">
                      Type <strong className="text-slate-900 dark:text-white">{employee.name}</strong> to confirm permanent erasure:
                    </p>
                    <input
                      type="text"
                      placeholder="Type employee name here"
                      value={confirmName}
                      onChange={(e) => { setConfirmName(e.target.value); if (error) setError(null); }}
                      className={cn('w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-800 border-2 text-slate-900 dark:text-white text-sm font-medium outline-none transition',
                        nameMatches ? 'border-emerald-400 focus:border-emerald-500' : 'border-slate-300 dark:border-slate-600 focus:border-red-500')}
                      aria-label="Confirm employee name"
                      autoFocus
                    />
                    {nameMatches && (
                      <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-center gap-1">
                        <Check className="w-3 h-3" /> Name matches
                      </p>
                    )}
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm flex items-start gap-2" role="alert">
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      {error}
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button onClick={() => setStep('reason')} className={ghostBtn}>
                      <ArrowLeft className="w-4 h-4" /> Back
                    </button>
                    <button onClick={handleErase} disabled={loading || !nameMatches} className={dangerBtn}>
                      {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Erasing…</> : <><Trash2 className="w-4 h-4" /> Permanently Erase</>}
                    </button>
                  </div>
                </div>
              )}

              {/* Step 4: Done */}
              {step === 'done' && (
                <div className="flex flex-col items-center gap-4 py-2 text-center">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <Check className="w-8 h-8 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-slate-900 dark:text-white">Data erased</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                      All biometric data for <strong>{employee.name}</strong> has been permanently deleted.
                    </p>
                  </div>
                  {erasureRef && (
                    <div className="w-full p-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-center">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Erasure reference</p>
                      <p className="font-mono font-black text-slate-900 dark:text-white mt-0.5">{erasureRef}</p>
                    </div>
                  )}
                  <button onClick={handleClose} className="w-full py-2.5 bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white rounded-xl font-bold text-sm hover:opacity-90 transition-opacity">
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
