import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiRequest, ApiError } from '../../services/http/apiClient';
import { Loader2, ShieldCheck, Copy, Check, X, Download } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onEnabled: () => void;
}

type Step = 'qr' | 'verify' | 'backup';

export const MfaSetupModal: React.FC<Props> = ({ open, onClose, onEnabled }) => {
  const [step, setStep] = useState<Step>('qr');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const startSetup = async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiRequest<{ secret: string; qrCodeUrl: string; backupCodes: string[] }>('/auth/mfa/setup', { method: 'POST' });
      setSecret(data.secret);
      setQrCodeUrl(data.qrCodeUrl);
      setBackupCodes(data.backupCodes);
      setStep('qr');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    if (totpCode.length !== 6) return;
    setLoading(true); setError(null);
    try {
      await apiRequest('/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ totp: totpCode, backupCodes }) });
      setStep('backup');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadBackupCodes = () => {
    const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'frs-backup-codes.txt'; a.click();
    URL.revokeObjectURL(url);
  };

  React.useEffect(() => {
    if (open && !qrCodeUrl) startSetup();
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="glass-card rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-6">
              <Dialog.Title className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-blue-600" />
                {step === 'qr' ? 'Scan QR Code' : step === 'verify' ? 'Verify Setup' : 'Save Backup Codes'}
              </Dialog.Title>
              <Dialog.Close className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>

            {error && <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-sm">{error}</div>}

            {step === 'qr' && (
              <div className="flex flex-col items-center gap-4">
                {loading ? <Loader2 className="w-8 h-8 animate-spin text-blue-600" /> : (
                  <>
                    <p className="text-sm text-gray-600 dark:text-gray-400 text-center">
                      Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                    </p>
                    {qrCodeUrl && <img src={qrCodeUrl} alt="MFA QR code" className="w-48 h-48 rounded-lg border p-2" />}
                    <div className="w-full">
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Or enter manually:</p>
                      <div className="flex gap-2">
                        <code className="flex-1 text-xs bg-gray-100 dark:bg-gray-700 px-3 py-2 rounded-lg font-mono break-all">{secret}</code>
                        <button onClick={copySecret} className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                          {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <button onClick={() => setStep('verify')} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold transition-colors">
                      I've scanned the code →
                    </button>
                  </>
                )}
              </div>
            )}

            {step === 'verify' && (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-gray-600 dark:text-gray-400 text-center">Enter the 6-digit code from your authenticator app to confirm setup.</p>
                <input
                  type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                  value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full text-center text-2xl font-mono py-3 px-4 border-2 rounded-xl border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none tracking-widest"
                  aria-label="TOTP verification code"
                />
                <div className="flex gap-3">
                  <button onClick={() => setStep('qr')} className="flex-1 py-3 border border-gray-300 dark:border-gray-600 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">Back</button>
                  <button onClick={handleEnable} disabled={loading || totpCode.length < 6}
                    className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl font-semibold transition-colors flex items-center justify-center gap-2">
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />} Enable MFA
                  </button>
                </div>
              </div>
            )}

            {step === 'backup' && (
              <div className="flex flex-col gap-4">
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-sm">
                  Save these backup codes now. They will not be shown again.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {backupCodes.map((code, i) => (
                    <code key={i} className="text-center font-mono text-sm bg-gray-100 dark:bg-gray-700 px-3 py-2 rounded-lg">{code}</code>
                  ))}
                </div>
                <button onClick={downloadBackupCodes} className="w-full py-2 border border-gray-300 dark:border-gray-600 rounded-xl text-sm flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                  <Download className="w-4 h-4" /> Download backup codes
                </button>
                <button onClick={() => { onEnabled(); onClose(); }} className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-semibold transition-colors">
                  Done — MFA is enabled
                </button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
