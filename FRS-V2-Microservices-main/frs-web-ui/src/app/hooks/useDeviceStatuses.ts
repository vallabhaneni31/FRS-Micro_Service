import { useState, useEffect } from 'react';
import { realtimeEngine, RteEventType } from '../engine/RealTimeEngine';

export interface LiveDeviceStatus {
  status: 'online' | 'offline' | 'error' | 'unknown';
  lastSeen: Date;
}

export function useDeviceStatuses(): Map<string, LiveDeviceStatus> {
  const [statusMap, setStatusMap] = useState<Map<string, LiveDeviceStatus>>(new Map());

  useEffect(() => {
    const unsubHeartbeat = realtimeEngine.subscribe(
      RteEventType.DEVICE_HEARTBEAT,
      (devices: any[]) => {
        setStatusMap(prev => {
          const next = new Map(prev);
          devices.forEach(d => {
            if (!d.id) return;
            const rawStatus = (d.status ?? '').toLowerCase();
            const status: LiveDeviceStatus['status'] =
              rawStatus === 'online'  ? 'online'  :
              rawStatus === 'offline' ? 'offline' :
              rawStatus === 'error'   ? 'error'   : 'unknown';
            next.set(String(d.id), { status, lastSeen: new Date() });
          });
          return next;
        });
      },
    );

    const unsubStatus = realtimeEngine.subscribe(
      RteEventType.DEVICE_STATUS_CHANGE,
      (payload: { deviceId: string; status: string }) => {
        setStatusMap(prev => {
          const next = new Map(prev);
          const rawStatus = (payload.status ?? '').toLowerCase();
          const status: LiveDeviceStatus['status'] =
            rawStatus === 'online'  ? 'online'  :
            rawStatus === 'offline' ? 'offline' :
            rawStatus === 'error'   ? 'error'   : 'unknown';
          next.set(String(payload.deviceId), { status, lastSeen: new Date() });
          return next;
        });
      },
    );

    return () => { unsubHeartbeat(); unsubStatus(); };
  }, []);

  return statusMap;
}
