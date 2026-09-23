import React, { useState, useEffect, useRef } from 'react';
import { apiRequest, ApiError } from '../../services/http/apiClient';
import { Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';

interface Props {
  mfaChallengeToken: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export const MfaVerifyPage: React.FC<Props> = ({ mfaChallengeToken, onSuccess, onCancel }) => {
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [backupCode, setBackupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(120);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Countdown timer — challenge expires in 2 min
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { clearInterval(interval); onCancel(); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onCancel]);

  // Auto-focus first digit
  useEffect(() => { inputRefs.current[0]?.focus(); }, []);

  const handleDigitChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);
    if (value && index < 5) inputRefs.current[index + 1]?.focus();
    // Auto-submit when all 6 digits entered
    if (value && index === 5) {
      const code = [...newDigits.slice(0, 5), value.slice(-1)].join('');
      if (code.length === 6) handleSubmit(code);
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async (totpCode?: string) => {
    setError(null);
    setLoading(true);
    try {
      const code = totpCode ?? digits.join('');
      await apiRequest('/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({
          mfaChallengeToken,
          ...(mode === 'totp' ? { totp: code } : { backupCode }),
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
      setDigits(Array(6).fill(''));
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const mins = Math.floor(timeLeft / 60);
  const secs = String(timeLeft % 60).padStart(2, '0');

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-md glass-card rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mb-4">
            <ShieldCheck className="w-7 h-7 text-blue-600 dark:text-blue-400" />
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Two-Factor Authentication</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 text-center">
            {mode === 'totp'
              ? 'Enter the 6-digit code from your authenticator app'
              : 'Enter one of your backup codes'}
          </p>
        </div>

        {/* Timer */}
        <div className={`text-center text-sm mb-6 font-mono ${timeLeft < 30 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
          Expires in {mins}:{secs}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        {mode === 'totp' ? (
          <>
            <div className="flex gap-2 justify-center mb-6">
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(i, e)}
                  className="w-11 h-14 text-center text-xl font-bold border-2 rounded-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none transition-colors"
                  aria-label={`Digit ${i + 1}`}
                />
              ))}
            </div>
            <button
              onClick={() => handleSubmit()}
              disabled={loading || digits.join('').length < 6}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Verify
            </button>
          </>
        ) : (
          <>
            <input
              type="text"
              placeholder="XXXXXXXX"
              value={backupCode}
              onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
              className="w-full px-4 py-3 border-2 rounded-xl text-center font-mono text-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none mb-4"
              aria-label="Backup code"
            />
            <button
              onClick={() => handleSubmit()}
              disabled={loading || !backupCode.trim()}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Verify Backup Code
            </button>
          </>
        )}

        <div className="mt-4 flex flex-col gap-2 text-center">
          <button
            onClick={() => { setMode(mode === 'totp' ? 'backup' : 'totp'); setError(null); }}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {mode === 'totp' ? 'Use a backup code instead' : 'Use authenticator app instead'}
          </button>
          <button onClick={onCancel} className="text-sm text-gray-500 hover:underline flex items-center justify-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to login
          </button>
        </div>
      </div>
    </div>
  );
};
