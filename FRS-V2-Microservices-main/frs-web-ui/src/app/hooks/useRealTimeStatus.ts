import { useState, useEffect } from 'react';
import { realtimeEngine, WsConnectionStatus } from '../engine/RealTimeEngine';

interface RealTimeStatus {
  status: WsConnectionStatus;
  lastConnectedAt: Date | null;
  isLive: boolean;
  isSimulated: boolean;
}

export function useRealTimeStatus(): RealTimeStatus {
  const [status, setStatus] = useState<WsConnectionStatus>(() => realtimeEngine.getConnectionStatus());
  const [lastConnectedAt, setLastConnectedAt] = useState<Date | null>(() => realtimeEngine.getLastConnectedAt());

  useEffect(() => {
    const unsubscribe = realtimeEngine.onConnectionStatusChange((newStatus) => {
      setStatus(newStatus);
      setLastConnectedAt(realtimeEngine.getLastConnectedAt());
    });
    return unsubscribe;
  }, []);

  return {
    status,
    lastConnectedAt,
    isLive:      status === 'connected',
    isSimulated: status === 'simulation',
  };
}
