import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { cn } from '../ui/utils';

export const OfflineBanner: React.FC = () => {
    const [offline, setOffline] = useState(!navigator.onLine);

    useEffect(() => {
        const goOffline = () => setOffline(true);
        const goOnline  = () => setOffline(false);
        window.addEventListener('offline', goOffline);
        window.addEventListener('online',  goOnline);
        return () => {
            window.removeEventListener('offline', goOffline);
            window.removeEventListener('online',  goOnline);
        };
    }, []);

    if (!offline) return null;

    return (
        <div
            role="alert"
            aria-live="assertive"
            className={cn(
                'fixed bottom-4 left-1/2 -translate-x-1/2 z-50',
                'flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg',
                'bg-slate-800 border border-slate-600 text-slate-100 text-sm font-medium',
                'animate-in slide-in-from-bottom-4 duration-200'
            )}
        >
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <span>You're offline — some features may be unavailable</span>
        </div>
    );
};
