import React, { useState } from 'react';
import { Wifi, X } from 'lucide-react';
import { useOfflineDevices } from '../../hooks/useOfflineDevices';
import { cn } from '../ui/utils';

export const DeviceOfflineBanner: React.FC = () => {
  const offlineDevices = useOfflineDevices();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = offlineDevices.filter(d => !dismissed.has(d.id));
  if (visible.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="sticky top-16 md:top-16 z-30 w-full bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/50 px-4 py-2.5 flex items-center gap-3"
    >
      <Wifi className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
      <span className="text-sm font-semibold text-amber-800 dark:text-amber-200 flex-1">
        {visible.length === 1 ? (
          <>Camera offline: <span className="font-black">{visible[0].name}</span></>
        ) : (
          <>{visible.length} cameras offline: {visible.slice(0, 3).map(d => d.name).join(', ')}{visible.length > 3 ? ` +${visible.length - 3} more` : ''}</>
        )}
      </span>
      <div className="flex gap-1 shrink-0">
        {visible.slice(0, 3).map(d => (
          <button
            key={d.id}
            onClick={() => setDismissed(prev => new Set([...prev, d.id]))}
            title={`Dismiss ${d.name}`}
            className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-500 dark:text-amber-400 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        ))}
        {visible.length > 1 && (
          <button
            onClick={() => setDismissed(new Set(visible.map(d => d.id)))}
            className="text-xs font-semibold text-amber-600 dark:text-amber-300 hover:text-amber-800 dark:hover:text-amber-100 px-2 py-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          >
            Dismiss all
          </button>
        )}
      </div>
    </div>
  );
};
