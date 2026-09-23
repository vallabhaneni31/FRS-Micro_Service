import React, { useState, useRef, useEffect } from 'react';
import { apiRequest, ApiError } from '../../services/http/apiClient';
import { ShieldCheck, Loader2, ChevronDown } from 'lucide-react';

interface ConsentStepProps {
  token: string;                    // enrollment token
  onConsentGiven: () => void;       // proceed to photo capture
  mode?: 'self-enrollment' | 'hr-initiated'; // context
}

export const ConsentStep: React.FC<ConsentStepProps> = ({
  token,
  onConsentGiven,
  mode = 'self-enrollment',
}) => {
  const [checked1, setChecked1] = useState(false);
  const [checked2, setChecked2] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  // Enable "Proceed" only after user has scrolled to the bottom of the notice
  useEffect(() => {
    const el = noticeRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
      if (atBottom) setScrolledToBottom(true);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const canProceed = checked1 && checked2 && scrolledToBottom;

  const handleConsent = async () => {
    setLoading(true);
    setError(null);
    try {
      await apiRequest(`/enroll/${token}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          consentGiven: true,
          consentTimestamp: new Date().toISOString(),
          mode,
        }),
      });
      onConsentGiven();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record consent. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-6 h-6 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Biometric Data Consent
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Please read and accept the privacy notice before proceeding.
          </p>
        </div>
      </div>

      {/* Privacy Notice — scrollable */}
      <div
        ref={noticeRef}
        className="h-52 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-xl p-4 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 space-y-3 scroll-smooth"
        role="region"
        aria-label="Biometric data privacy notice"
      >
        <p className="font-semibold text-gray-900 dark:text-white">Biometric Data Privacy Notice</p>

        <p><strong>What we collect:</strong> Your facial biometric data — specifically a mathematical representation (embedding) of your facial features — will be captured and processed.</p>

        <p><strong>How it is used:</strong> The biometric data is used exclusively for automated attendance tracking and access control within your organisation. It is never used for any other purpose.</p>

        <p><strong>Storage:</strong> Your facial embedding is stored in an encrypted database. Raw photographs are automatically deleted within 24 hours of processing. Your data is retained for the duration of your employment/engagement plus a maximum of 90 days.</p>

        <p><strong>Data security:</strong> Access to biometric data is strictly limited to authorised system personnel. All access is logged and audited. Data is encrypted at rest and in transit.</p>

        <p><strong>Your rights:</strong> You have the right to withdraw consent at any time, request erasure of your biometric data, and access a copy of your stored data. To exercise these rights, contact your HR or IT administrator.</p>

        <p><strong>Consequences of not consenting:</strong> Participation in facial recognition-based attendance is voluntary where permitted by law. Alternative attendance methods may be available — please contact your HR department.</p>

        <p><strong>Legal basis:</strong> Processing of your biometric data is conducted under your explicit consent in accordance with applicable data protection legislation.</p>

        <p className="text-gray-400 dark:text-gray-500 text-xs">Last updated: January 2026. Version 1.2.</p>
      </div>

      {/* Scroll prompt */}
      {!scrolledToBottom && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 -mt-4">
          <ChevronDown className="w-3 h-3 animate-bounce" aria-hidden="true" />
          Scroll to the bottom to enable the checkboxes
        </p>
      )}

      {/* Checkboxes */}
      <div className="space-y-3">
        <label className={`flex items-start gap-3 cursor-pointer ${!scrolledToBottom ? 'opacity-50 pointer-events-none' : ''}`}>
          <input
            type="checkbox"
            checked={checked1}
            onChange={(e) => setChecked1(e.target.checked)}
            disabled={!scrolledToBottom}
            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            aria-label="Consent to biometric data collection"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            I consent to the collection and processing of my facial biometric data for attendance and access control purposes as described above.
          </span>
        </label>

        <label className={`flex items-start gap-3 cursor-pointer ${!scrolledToBottom ? 'opacity-50 pointer-events-none' : ''}`}>
          <input
            type="checkbox"
            checked={checked2}
            onChange={(e) => setChecked2(e.target.checked)}
            disabled={!scrolledToBottom}
            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            aria-label="Acknowledge biometric data privacy notice"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            I have read and understood the Biometric Data Privacy Notice and my rights regarding this data.
          </span>
        </label>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-sm" role="alert">
          {error}
        </div>
      )}

      <button
        onClick={handleConsent}
        disabled={!canProceed || loading}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors flex items-center justify-center gap-2"
        aria-disabled={!canProceed}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
        Proceed to Enrollment
      </button>
    </div>
  );
};
