import React, { useState } from 'react';
import { CheckCircle2, ChevronRight, Loader2, Mail, ShieldCheck, Users, X } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { Button } from '../../../ui/button';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { toast } from 'sonner';

interface Employee {
    pk_employee_id: number;
    employee_code: string;
    full_name: string;
    email: string;
}

interface SendSummary {
    total: number;
    sent: number;
    failed: number;
    skipped: number;
}

type Step = 'review' | 'consent' | 'sending' | 'done';

interface Props {
    employees: Employee[];
    onClose: () => void;
    onComplete: () => void;
}

const STEPS: { key: Step; label: string }[] = [
    { key: 'review',  label: 'Review'  },
    { key: 'consent', label: 'Consent' },
    { key: 'sending', label: 'Send'    },
    { key: 'done',    label: 'Done'    },
];

function StepIndicator({ current }: { current: Step }) {
    const idx = STEPS.findIndex(s => s.key === current);
    return (
        <ol className="flex items-center gap-0">
            {STEPS.map((s, i) => {
                const done    = i < idx;
                const active  = i === idx;
                return (
                    <React.Fragment key={s.key}>
                        <li className="flex items-center gap-1.5">
                            <span className={cn(
                                'w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold transition-colors',
                                done   ? 'bg-indigo-600 text-white'
                                       : active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100 dark:ring-indigo-950/50'
                                                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500'
                            )}>
                                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                            </span>
                            <span className={cn(
                                'text-xs font-medium hidden sm:block',
                                active ? 'text-indigo-600 dark:text-indigo-400' : done ? 'text-slate-600 dark:text-slate-400' : 'text-slate-400 dark:text-slate-500'
                            )}>
                                {s.label}
                            </span>
                        </li>
                        {i < STEPS.length - 1 && (
                            <div className={cn('h-px w-8 mx-1', i < idx ? 'bg-indigo-400 dark:bg-indigo-600' : 'bg-slate-200 dark:bg-slate-800')} />
                        )}
                    </React.Fragment>
                );
            })}
        </ol>
    );
}

export const EnrollmentWizard: React.FC<Props> = ({ employees, onClose, onComplete }) => {
    const scopeHeaders = useScopeHeaders();
    const [step, setStep]           = useState<Step>('review');
    const [consentChecked, setConsentChecked] = useState(false);
    const [summary, setSummary]     = useState<SendSummary | null>(null);

    const send = async () => {
        setStep('sending');
        try {
            const data = await apiRequest<{
                success: boolean;
                summary: SendSummary;
                results: { sent: unknown[]; failed: unknown[]; skipped: unknown[] };
            }>('/enroll/send-invitations', {
                method: 'POST',
                body: JSON.stringify({ employeeIds: employees.map(e => e.pk_employee_id) }),
                scopeHeaders,
            });
            setSummary(data.summary);
            setStep('done');
            if (data.summary.sent > 0) {
                toast.success(`${data.summary.sent} invitation(s) sent`);
            }
        } catch (err: any) {
            toast.error('Failed to send invitations', { description: err.message });
            setStep('consent'); // step back so user can retry
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl flex flex-col overflow-hidden border dark:border-slate-800">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                    <div>
                        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">Send Enrollment Invitations</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{employees.length} employee{employees.length !== 1 ? 's' : ''} selected</p>
                    </div>
                    {step !== 'sending' && (
                        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-350 transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                {/* Step indicator */}
                <div className="px-6 py-3 border-b border-slate-50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20">
                    <StepIndicator current={step} />
                </div>

                {/* Body */}
                <div className="px-6 py-5 flex-1 overflow-y-auto">

                    {/* Step 1 — Review */}
                    {step === 'review' && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                                <Users className="w-4 h-4 text-indigo-500 shrink-0" />
                                <span className="text-sm font-medium">Employees to invite</span>
                            </div>
                            <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-100 dark:border-slate-800 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                                {employees.map(e => (
                                    <li key={e.pk_employee_id} className="flex items-center justify-between px-3 py-2.5 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                        <div>
                                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{e.full_name}</p>
                                            <p className="text-xs text-slate-500 dark:text-slate-450">{e.employee_code}</p>
                                        </div>
                                        <span className="text-xs text-slate-400 dark:text-slate-550 truncate max-w-[160px]">{e.email || 'No email'}</span>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Each employee will receive an email with a secure link to complete their facial recognition enrollment.
                            </p>
                        </div>
                    )}

                    {/* Step 2 — Consent */}
                    {step === 'consent' && (
                        <div className="space-y-4">
                            <div className="flex items-start gap-3 p-4 bg-indigo-50 dark:bg-indigo-950/20 rounded-xl border border-indigo-100 dark:border-indigo-900/30">
                                <ShieldCheck className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
                                <div className="text-sm text-indigo-800 dark:text-indigo-300 space-y-1.5">
                                    <p className="font-medium">Biometric data notice</p>
                                    <p className="text-xs text-indigo-700 dark:text-indigo-400 leading-relaxed">
                                        This action will send an enrollment link requesting employees to submit facial images for
                                        biometric processing. Data is stored encrypted and used exclusively for attendance
                                        verification. Employees may decline at any time.
                                    </p>
                                </div>
                            </div>
                            <label className="flex items-start gap-3 cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={consentChecked}
                                    onChange={e => setConsentChecked(e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 dark:bg-slate-950"
                                />
                                <span className="text-sm text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100">
                                    I confirm that the organisation has a lawful basis for collecting biometric data and that
                                    employees have been informed of this process.
                                </span>
                            </label>
                        </div>
                    )}

                    {/* Step 3 — Sending */}
                    {step === 'sending' && (
                        <div className="flex flex-col items-center justify-center py-10 gap-4">
                            <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                            <div className="text-center">
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Sending invitations…</p>
                                <p className="text-xs text-slate-500 dark:text-slate-450 mt-1">This will only take a moment.</p>
                            </div>
                        </div>
                    )}

                    {/* Step 4 — Done */}
                    {step === 'done' && summary && (
                        <div className="space-y-4">
                            <div className="flex flex-col items-center gap-3 py-4">
                                <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-950/30 rounded-full flex items-center justify-center">
                                    <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-450" />
                                </div>
                                <p className="text-base font-semibold text-slate-800 dark:text-slate-100">Invitations sent</p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { label: 'Sent',    value: summary.sent,    color: 'text-emerald-600 dark:text-emerald-450 bg-emerald-50 dark:bg-emerald-950/20'  },
                                    { label: 'Failed',  value: summary.failed,  color: 'text-rose-600 dark:text-rose-450 bg-rose-50 dark:bg-rose-950/20'     },
                                ] as const).map(({ label, value, color }) => (
                                    <div key={label} className={cn('rounded-xl p-3 text-center', color)}>
                                        <p className="text-2xl font-bold">{value}</p>
                                        <p className="text-xs font-medium mt-0.5">{label}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                {step !== 'sending' && (
                    <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/20 dark:bg-slate-950/20">
                        {step === 'done' ? (
                            <Button className="w-full font-bold rounded-xl" onClick={() => { onComplete(); onClose(); }}>
                                <Mail className="w-4 h-4 mr-2" />
                                View invitations
                            </Button>
                        ) : (
                            <>
                                <Button variant="outline" onClick={onClose} className="flex-1 font-bold rounded-xl">
                                    Cancel
                                </Button>
                                {step === 'review' && (
                                    <Button className="flex-1 font-bold rounded-xl" onClick={() => setStep('consent')}>
                                        Next
                                        <ChevronRight className="w-4 h-4 ml-1" />
                                    </Button>
                                )}
                                {step === 'consent' && (
                                    <Button className="flex-1 font-bold rounded-xl" disabled={!consentChecked} onClick={send}>
                                        Send {employees.length} invitation{employees.length !== 1 ? 's' : ''}
                                        <Mail className="w-4 h-4 ml-2" />
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
