import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, ShieldCheck, Building, MapPin } from 'lucide-react';
import { tokenStorage } from '../services/auth/tokenStorage';
import { cn } from './ui/utils';

interface InviteInfo {
  email:         string;
  name:          string;
  roleName:      string;
  tenantName:    string | null;
  siteName:      string | null;
  invitedByName: string;
  expiresAt:     string;
  minPasswordLength: number;
}

// ── Password strength checker ─────────────────────────────────────────────────
function checkStrength(pw: string, minLength: number = 8) {
  return {
    length:    pw.length >= minLength,
    upper:     /[A-Z]/.test(pw),
    lower:     /[a-z]/.test(pw),
    number:    /[0-9]/.test(pw),
    special:   /[^A-Za-z0-9]/.test(pw),
    noSpace:   !/\s/.test(pw) && pw.length > 0,
  };
}
function strengthScore(pw: string, minLength: number = 8) {
  const s = checkStrength(pw, minLength);
  if (!s.length) return Math.min(2, Object.values(s).filter(Boolean).length);
  return Object.values(s).filter(Boolean).length; // 0–6
}
const STRENGTH_LABEL = ['', 'Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
const STRENGTH_COLOR = ['', 'text-rose-500', 'text-rose-500', 'text-amber-500', 'text-blue-500', 'text-emerald-500', 'text-emerald-500'];
const STRENGTH_BAR   = ['', 'bg-rose-400', 'bg-rose-400', 'bg-amber-400', 'bg-blue-400', 'bg-emerald-400', 'bg-emerald-400'];

// ── Role badge colours ────────────────────────────────────────────────────────
const ROLE_STYLE: Record<string, string> = {
  'Tenant Admin': 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  'Site Admin':   'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'HR Manager':   'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
};
const roleStyle = (r: string) => ROLE_STYLE[r] ?? 'bg-slate-100 text-slate-600';

// ── API base ──────────────────────────────────────────────────────────────────
const API = (path: string) => `/api${path}`;

// ─────────────────────────────────────────────────────────────────────────────

interface Props { token: string }

export const SetupPasswordPage: React.FC<Props> = ({ token }) => {
  const [phase, setPhase]         = useState<'loading' | 'invalid' | 'form' | 'success'>('loading');
  const [invite, setInvite]       = useState<InviteInfo | null>(null);
  const [errorMsg, setErrorMsg]   = useState('');
  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [showCf, setShowCf]       = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // ── Validate token on mount ───────────────────────────────────────────────
  useEffect(() => {
    fetch(API(`/auth/invite/${token}`))
      .then(r => r.json())
      .then(data => {
        if (!data.valid) {
          const reason = data.reason === 'already_used'
            ? 'This invite link has already been used.'
            : data.reason === 'expired'
            ? 'This invite link has expired.'
            : 'This invite link is invalid or no longer active.';
          setErrorMsg(reason);
          setPhase('invalid');
        } else {
          if (data.realmSlug) {
            localStorage.setItem("frs_current_realm", data.realmSlug);
          }
          setInvite(data);
          setPhase('form');
        }
      })
      .catch(() => {
        setErrorMsg('Could not connect to the server. Please try again.');
        setPhase('invalid');
      });
  }, [token]);

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const currentMinLength = invite?.minPasswordLength ?? 8;

    if (strengthScore(password, currentMinLength) < 6) {
      setFormError(`Password must be at least ${currentMinLength} characters long and meet all complexity requirements.`);
      return;
    }
    if (password !== confirm) {
      setFormError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res  = await fetch(API(`/auth/invite/${token}/setup`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setFormError(data.message ?? 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }

      // Store tokens → reload app (AuthContext.initializeAuth picks them up)
      tokenStorage.setTokens(data.accessToken, data.refreshToken);
      setPhase('success');

      setTimeout(() => {
        window.location.replace('/');
      }, 1800);
    } catch {
      setFormError('Network error. Please check your connection and try again.');
      setSubmitting(false);
    }
  };

  const score    = strengthScore(password, invite?.minPasswordLength ?? 8);
  const strength = checkStrength(password, invite?.minPasswordLength ?? 8);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#020817]">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
          <p className="text-sm">Validating your invite link…</p>
        </div>
      </div>
    );
  }

  // ── Invalid / expired ─────────────────────────────────────────────────────
  if (phase === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#020817] p-4">
        <div className="w-full max-w-md glass-card rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-slate-800 to-slate-900 px-6 py-8 text-center">
            <img src="/motivity-logo.png" alt="FRS" className="h-8 mx-auto mb-4 object-contain" onError={e => (e.currentTarget.style.display='none')} />
            <h1 className="text-white text-xl font-bold">FRS Platform</h1>
          </div>
          <div className="p-8 text-center">
            <XCircle className="w-14 h-14 text-rose-400 mx-auto mb-4" />
            <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-2">Link Not Valid</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-6">{errorMsg}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Contact the person who invited you and ask them to resend the invite.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (phase === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#020817] p-4">
        <div className="w-full max-w-md glass-card rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-8 text-center">
            <h1 className="text-white text-xl font-bold">FRS Platform</h1>
          </div>
          <div className="p-8 text-center">
            <CheckCircle2 className="w-14 h-14 text-emerald-400 mx-auto mb-4" />
            <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-2">Password Set!</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              Signing you in…
            </p>
            <Loader2 className="w-5 h-5 animate-spin text-indigo-500 mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  // ── Setup form ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#020817] p-4">
      <div className="w-full max-w-md glass-card rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden">

        {/* Header gradient */}
        <div className="bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 px-6 pt-8 pb-6 text-center">
          <img src="/motivity-logo.png" alt="FRS" className="h-7 mx-auto mb-4 object-contain" onError={e => (e.currentTarget.style.display='none')} />
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center mx-auto mb-3">
            <ShieldCheck className="w-7 h-7 text-indigo-300" />
          </div>
          <h1 className="text-white text-xl font-bold">
            {invite?.roleName === 'Password Reset' ? 'Reset Your Password' : 'Set Up Your Password'}
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {invite?.roleName === 'Password Reset' ? 'Choose a new secure password for your FRS account' : 'Choose a secure password for your FRS account'}
          </p>
        </div>

        <div className="p-6 space-y-5">

          {/* Invite context card */}
          {invite && (
            <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
              <p className="text-sm text-slate-700 dark:text-slate-200">
                👋 Hi <strong>{invite.name}</strong>,{' '}
                <span className="text-slate-500 dark:text-slate-400">
                  {invite.roleName === 'Password Reset'
                    ? 'Please choose a new password for your FRS account.'
                    : <><strong className="text-slate-700 dark:text-slate-200">{invite.invitedByName}</strong> invited you to join FRS.</>
                  }
                </span>
              </p>

              <div className="flex flex-wrap gap-2 text-xs">
                {/* Role badge */}
                <span className={cn('flex items-center gap-1 font-semibold px-2.5 py-1 rounded-full', roleStyle(invite.roleName))}>
                  <ShieldCheck className="w-3 h-3" />
                  {invite.roleName}
                </span>
                {/* Tenant */}
                {invite.tenantName && (
                  <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">
                    <Building className="w-3 h-3" />
                    {invite.tenantName}
                  </span>
                )}
                {/* Site */}
                {invite.siteName && (
                  <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">
                    <MapPin className="w-3 h-3" />
                    {invite.siteName}
                  </span>
                )}
              </div>

              {/* Email */}
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Signing in as <strong className="text-slate-600 dark:text-slate-300">{invite.email}</strong>
              </p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Password field */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                New Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setFormError(''); }}
                  onKeyDown={e => { if (e.key === ' ') e.preventDefault(); }}
                  placeholder="Choose a strong password"
                  autoComplete="new-password"
                  className="w-full pr-10 pl-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-600 glass-card text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent [&::-ms-reveal]:hidden [&::-webkit-reveal]:hidden"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Strength bar */}
              {password.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <div className="flex gap-1">
                    {[1,2,3,4,5,6].map(i => (
                      <div
                        key={i}
                        className={cn(
                          'h-1 flex-1 rounded-full transition-all duration-300',
                          i <= score ? STRENGTH_BAR[score] : 'bg-slate-200 dark:bg-slate-700'
                        )}
                      />
                    ))}
                  </div>
                  <p className={cn('text-xs font-semibold', STRENGTH_COLOR[score])}>
                    {STRENGTH_LABEL[score]}
                  </p>
                  {/* Checklist */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                    {[
                      { ok: strength.length,  label: `${invite?.minPasswordLength ?? 8}+ characters` },
                      { ok: strength.upper,   label: 'Uppercase letter' },
                      { ok: strength.lower,   label: 'Lowercase letter' },
                      { ok: strength.number,  label: 'Number' },
                      { ok: strength.special, label: 'Special character' },
                      { ok: strength.noSpace, label: 'No spaces' },
                    ].map(({ ok, label }) => (
                      <span key={label} className={cn('text-[11px] flex items-center gap-1', ok ? 'text-emerald-500' : 'text-slate-400')}>
                        {ok ? '✓' : '○'} {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Confirm field */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  type={showCf ? 'text' : 'password'}
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setFormError(''); }}
                  onKeyDown={e => { if (e.key === ' ') e.preventDefault(); }}
                  placeholder="Repeat your password"
                  autoComplete="new-password"
                  className={cn(
                    'w-full pr-10 pl-3 py-2.5 rounded-lg border text-sm text-slate-900 dark:text-white glass-card placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent [&::-ms-reveal]:hidden [&::-webkit-reveal]:hidden',
                    confirm && password !== confirm
                      ? 'border-rose-400 dark:border-rose-500'
                      : confirm && password === confirm
                      ? 'border-emerald-400 dark:border-emerald-500'
                      : 'border-slate-200 dark:border-slate-600'
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowCf(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  {showCf ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {confirm && password === confirm && (
                <p className="text-[11px] text-emerald-500 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Passwords match
                </p>
              )}
            </div>

            {/* Form error */}
            {formError && (
              <div className="flex items-start gap-2 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-lg px-3 py-2.5">
                <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                <p className="text-xs text-rose-600 dark:text-rose-400">{formError}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting || !password || !confirm || score < 6 || password !== confirm}
              className={cn(
                'w-full py-3 rounded-xl text-sm font-bold tracking-wide transition-all',
                submitting || !password || !confirm || score < 6 || password !== confirm
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40'
              )}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Setting up…
                </span>
              ) : (
                'Set Password & Sign In →'
              )}
            </button>
          </form>

          <p className="text-center text-xs text-slate-400 dark:text-slate-500">
            Link expires{' '}
            {invite ? new Date(invite.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '…'}
          </p>
        </div>
      </div>
    </div>
  );
};
