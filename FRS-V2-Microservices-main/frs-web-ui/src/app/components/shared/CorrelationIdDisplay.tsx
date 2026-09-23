/**
 * CorrelationIdDisplay — W-06
 * Renders a small copyable correlation ID badge inside error messages.
 * Support staff can paste this ID into log searches to trace the request.
 *
 * Usage:
 *   catch (e) {
 *     toast.error(e.message);
 *     // or: <CorrelationIdDisplay id={(e as ApiError).correlationId} />
 *   }
 */
import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface Props {
  id?: string;
}

export const CorrelationIdDisplay: React.FC<Props> = ({ id }) => {
  const [copied, setCopied] = useState(false);
  if (!id) return null;

  const copy = () => {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={copy}
      title="Copy request ID for support"
      className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors mt-1"
    >
      {copied
        ? <Check className="w-3 h-3 text-green-400" />
        : <Copy className="w-3 h-3" />}
      {id.slice(0, 8)}…
    </button>
  );
};
