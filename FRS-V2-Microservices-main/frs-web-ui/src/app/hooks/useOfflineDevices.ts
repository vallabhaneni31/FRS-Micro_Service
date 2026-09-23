import { useState, useEffect, useRef } from 'react';
import { realtimeEngine, RteEventType } from '../engine/RealTimeEngine';

export interface OfflineDevice { id: string; name: string; since: Date; }

export function useOfflineDevices() {
  const [offlineDevices, setOfflineDevices] = useState<OfflineDevice[]>([]);
  // deviceId → name, populated from DEVICE_HEARTBEAT
  const nameMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const unsubHeartbeat = realtimeEngine.subscribe(
      RteEventType.DEVICE_HEARTBEAT,
      (devices: any[]) => {
        devices.forEach(d => {
          if (d.id && d.name) nameMapRef.current.set(String(d.id), d.name);
        });
      },
    );

    const unsubStatus = realtimeEngine.subscribe(
      RteEventType.DEVICE_STATUS_CHANGE,
      (payload: { deviceId: string; status: string }) => {
        const isOffline =
          payload.status === 'offline' ||
          payload.status === 'Offline' ||
          payload.status === 'error';
        const id   = String(payload.deviceId);
        const name = nameMapRef.current.get(id) ?? `Device ${id}`;

        setOfflineDevices(prev => {
          if (isOffline) {
            if (prev.some(d => d.id === id)) return prev;
            return [...prev, { id, name, since: new Date() }];
          }
          return prev.filter(d => d.id !== id);
        });
      },
    );

    return () => { unsubHeartbeat(); unsubStatus(); };
  }, []);

  return offlineDevices;
}
