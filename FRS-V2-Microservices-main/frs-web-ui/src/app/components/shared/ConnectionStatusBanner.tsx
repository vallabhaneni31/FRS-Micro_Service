import React from 'react';
import { useRealTimeStatus } from '../../hooks/useRealTimeStatus';
import { AlertTriangle, WifiOff } from 'lucide-react';

export const ConnectionStatusBanner: React.FC = () => {
  const { status } = useRealTimeStatus();

  if (status !== 'simulation') return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="sticky top-16 md:top-16 z-40 w-full bg-red-600 text-white px-4 py-2.5 flex items-center justify-center gap-3 text-sm font-semibold shadow-md"
    >
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>
        🔴 LIVE FEED DISCONNECTED — SHOWING SIMULATED DATA.
        <span className="font-normal ml-2">
          All displayed events are synthetic. Do not act on this data.
        </span>
      </span>
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
    </div>
  );
};
