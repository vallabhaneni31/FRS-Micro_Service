import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../../hooks/useGlobalRetailStore';
import { apiRequest } from '../../../services/http/apiClient';
import { authConfig } from '../../../config/authConfig';

const RETAIL_BASE = '/v1/retail';
const CAMERA_STALE_MS = 30_000;

interface Store {
  id: string;
  name: string;
  address?: string;
  status?: string;
}

interface Device {
  id: string;
  external_id: string;
  status: string;
  last_heartbeat: string | null;
}

interface ApiCamera {
  id: string;
  name: string;
  position?: string;
  status: string;
  last_seen?: string | null;
}

interface LiveCamera {
  camera_id: string | null;
  captured_at: string;
  name: string;
  external_id: string | null;
  position: string | null;
  registered: boolean;
}

interface DisplayCamera {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  status: 'online' | 'offline';
  lastSeen: string | null;
  isDevice: boolean;
  deviceId: string | null;
  cameraId: string | null;
}

const feedId = (deviceId: string, cameraId: string | null) =>
  cameraId ? `${deviceId}::${cameraId}` : deviceId;

const splitFeedId = (id: string): { deviceId: string; cameraId: string | null } => {
  const idx = id.indexOf('::');
  return idx === -1
    ? { deviceId: id, cameraId: null }
    : { deviceId: id.slice(0, idx), cameraId: id.slice(idx + 2) };
};

export const RetailLiveView: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { selectedStoreId: globalStoreId, setSelectedStoreId } = useGlobalRetailStore();
  const selectedStoreId = globalStoreId === 'all' ? null : globalStoreId;

  // Real backend state
  const [stores, setStores] = useState<Store[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [apiCameras, setApiCameras] = useState<ApiCamera[]>([]);
  const [liveCamerasByDevice, setLiveCamerasByDevice] = useState<Record<string, LiveCamera[]>>({});
  const [loadingStores, setLoadingStores] = useState(true);
  const [loadingLive, setLoadingLive] = useState(false);

  // View & Filter states
  const [viewMode, setViewMode] = useState<'grid' | 'detail'>('grid');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [searchVal, setSearchVal] = useState('');
  const [isOnlineFilter, setIsOnlineFilter] = useState(true);
  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);
  const [storeSearchInput, setStoreSearchInput] = useState('');

  // Map of device ID -> live frame image URL (blob URL or base64 data URL)
  const [deviceFramesMap, setDeviceFramesMap] = useState<Record<string, string>>({});

  // Modal state
  const [selectedDayModal, setSelectedDayModal] = useState<{
    day: string;
    camName: string;
    isOnline: boolean;
    lastSeen: string | null;
  } | null>(null);

  // Streaming & Dynamic Metrics state
  const [connected, setConnected] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrameReceivedAt, setLastFrameReceivedAt] = useState<number>(0);
  const [clockString, setClockString] = useState('');
  const [streamResolution, setStreamResolution] = useState<string | null>(null);
  const [calculatedFps, setCalculatedFps] = useState<number>(0);

  const frameTimestampsRef = useRef<number[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const mainFeedRef = useRef<HTMLDivElement | null>(null);
  const accessTokenRef = useRef<string | null>(accessToken);

  const recordFrame = useCallback(() => {
    const now = Date.now();
    setLastFrameReceivedAt(now);
    setFrameCount((n) => n + 1);

    frameTimestampsRef.current.push(now);
    const recent = frameTimestampsRef.current.filter((t) => now - t <= 2000);
    frameTimestampsRef.current = recent;
    if (recent.length > 1) {
      const spanSec = (now - recent[0]) / 1000;
      if (spanSec > 0) {
        setCalculatedFps(Math.round((recent.length - 1) / spanSec));
      }
    }
  }, []);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setStreamResolution(`${img.naturalWidth} × ${img.naturalHeight}`);
    }
  }, []);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(deviceFramesMap).forEach((url) => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, []);

  // 1. Fetch real stores list
  useEffect(() => {
    if (!accessToken) return;
    setLoadingStores(true);
    apiRequest(`${RETAIL_BASE}/stores`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        const list: Store[] = r.stores ?? [];
        setStores(list);
        if (list.length > 0 && globalStoreId !== 'all') {
          setSelectedStoreId(globalStoreId);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingStores(false));
  }, [accessToken, scopeHeaders]);

  // 2. Fetch real live data (devices & cameras) for selected store
  const refreshLiveDetails = useCallback(() => {
    const token = accessTokenRef.current;
    if (!selectedStoreId || !token) return Promise.resolve();
    setLoadingLive(true);
    return apiRequest(`${RETAIL_BASE}/stores/${selectedStoreId}/live`, {
      method: 'GET',
      accessToken: token,
      scopeHeaders,
    })
      .then((liveData: any) => {
        const deviceList: Device[] = liveData.devices ?? [];
        const cameraList: ApiCamera[] = liveData.cameras ?? [];
        setDevices(deviceList);
        setApiCameras(cameraList);

        // Default selected device
        setSelectedDeviceId((prev) => {
          if (prev && deviceList.some((d) => d.id === splitFeedId(prev).deviceId)) return prev;
          return deviceList[0]?.id ?? cameraList[0]?.id ?? null;
        });
      })
      .catch(() => {})
      .finally(() => setLoadingLive(false));
  }, [selectedStoreId, scopeHeaders]);

  useEffect(() => {
    refreshLiveDetails();
    const id = setInterval(refreshLiveDetails, 15_000);
    return () => clearInterval(id);
  }, [refreshLiveDetails]);

  const deviceIdsKey = devices.map((d) => d.id).sort().join(',');
  useEffect(() => {
    const token = accessTokenRef.current;
    if (!token || !deviceIdsKey) return;
    let cancelled = false;
    const fetchLiveCameras = () => {
      Promise.all(
        deviceIdsKey.split(',').map((deviceId) =>
          fetch(`${authConfig.apiBaseUrl}${RETAIL_BASE}/devices/${deviceId}/snapshot/cameras`,
            { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : { cameras: [] }))
            .then((d) => [deviceId, (d.cameras ?? []) as LiveCamera[]] as const)
            .catch(() => [deviceId, [] as LiveCamera[]] as const)
        )
      ).then((entries) => { if (!cancelled) setLiveCamerasByDevice(Object.fromEntries(entries)); });
    };
    fetchLiveCameras();
    const id = setInterval(fetchLiveCameras, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [deviceIdsKey, accessToken]);

  // Derive displayable cameras exclusively from real backend data
  const currentStore = useMemo(() => {
    return stores.find((s) => s.id === selectedStoreId) ?? null;
  }, [stores, selectedStoreId]);

  const displayCameras: DisplayCamera[] = useMemo(() => {
    if (devices.length > 0) {
      return devices.flatMap((d) => {
        const base = {
          storeId: selectedStoreId || '',
          storeName: currentStore?.name || 'Store',
          status: (d.status === 'online' ? 'online' : 'offline') as 'online' | 'offline',
          lastSeen: d.last_heartbeat,
          isDevice: true,
          deviceId: d.id,
        };
        const live = liveCamerasByDevice[d.id] ?? [];
        if (live.length <= 1) {
          return [{
            ...base,
            id: feedId(d.id, live[0]?.camera_id ?? null),
            name: d.external_id || `Device ${d.id}`,
            cameraId: live[0]?.camera_id ?? null,
          }];
        }
        const now = Date.now();
        return live
          .filter((c) => now - new Date(c.captured_at).getTime() <= CAMERA_STALE_MS)
          .map((c) => ({
            ...base,
            id: feedId(d.id, c.camera_id),
            name: c.external_id || c.name,
            cameraId: c.camera_id,
          }));
      });
    }
    return apiCameras.map((c) => ({
      id: c.id,
      name: c.name || `Camera ${c.id}`,
      storeId: selectedStoreId || '',
      storeName: currentStore?.name || 'Store',
      status: (c.status === 'online' ? 'online' : 'offline') as 'online' | 'offline',
      lastSeen: c.last_seen || null,
      isDevice: false,
      deviceId: null,
      cameraId: c.id,
    }));
  }, [devices, apiCameras, selectedStoreId, currentStore, liveCamerasByDevice]);

  // Filter displayable cameras
  const filteredCameras = useMemo(() => {
    let list = displayCameras;

    if (isOnlineFilter) {
      list = list.filter((c) => c.status === 'online');
    } else {
      list = list.filter((c) => c.status === 'offline');
    }

    if (searchVal.trim()) {
      const q = searchVal.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.storeName.toLowerCase().includes(q));
    }

    return list;
  }, [displayCameras, isOnlineFilter, searchVal]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    if (displayCameras.some((c) => c.id === selectedDeviceId)) return;
    const promoted = displayCameras.find(
      (c) => c.deviceId === splitFeedId(selectedDeviceId).deviceId
    );
    if (promoted) setSelectedDeviceId(promoted.id);
  }, [displayCameras, selectedDeviceId]);

  const activeCamera = useMemo(() => {
    return displayCameras.find((c) => c.id === selectedDeviceId) ?? displayCameras[0] ?? null;
  }, [displayCameras, selectedDeviceId]);

  // 3. Snapshot Polling for all online devices (for live grid thumbnails)
  useEffect(() => {
    if (!accessToken) return;
    const onlineDevs = displayCameras.filter((c) => c.status === 'online');
    if (onlineDevs.length === 0) return;

    const pollSnapshots = () => {
      onlineDevs.forEach((dev) => {
        const { deviceId, cameraId } = splitFeedId(dev.id);
        const camQuery = cameraId ? `?camera_id=${encodeURIComponent(cameraId)}` : '';
        fetch(`${authConfig.apiBaseUrl}${RETAIL_BASE}/devices/${deviceId}/snapshot${camQuery}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            setDeviceFramesMap((prev) => {
              const oldUrl = prev[dev.id];
              if (oldUrl && oldUrl.startsWith('blob:')) {
                URL.revokeObjectURL(oldUrl);
              }
              return { ...prev, [dev.id]: url };
            });
            if (dev.id === selectedDeviceId) {
              recordFrame();
            }
          })
          .catch(() => {});
      });
    };

    pollSnapshots();
    const intervalId = setInterval(pollSnapshots, 2500);
    return () => clearInterval(intervalId);
  }, [accessToken, displayCameras, selectedDeviceId, recordFrame]);

  // 4. SSE Stream effect for the active device when in Detail View
  useEffect(() => {
    eventSourceRef.current?.close();
    setConnected(false);

    if (viewMode !== 'detail' || !selectedDeviceId || !accessTokenRef.current) return;

    const { deviceId, cameraId } = splitFeedId(selectedDeviceId);
    const streamUrl =
      `${authConfig.apiBaseUrl}${RETAIL_BASE}/devices/${deviceId}/snapshot/stream` +
      `?token=${encodeURIComponent(accessTokenRef.current)}` +
      (cameraId ? `&camera_id=${encodeURIComponent(cameraId)}` : '');
    const es = new EventSource(streamUrl);
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onmessage = (event) => {
      setConnected(true);
      const dataUrl = `data:image/jpeg;base64,${event.data}`;
      recordFrame();
      setDeviceFramesMap((prev) => ({ ...prev, [selectedDeviceId]: dataUrl }));
    };
    es.onerror = () => {
      setConnected(false);
      es.close();
    };

    return () => {
      es.close();
    };
  }, [viewMode, selectedDeviceId]);

  // Real-time clock ticker
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      setClockString(`${time} · ${date}`);
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFSChange = () => {
      setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFSChange);
    document.addEventListener('webkitfullscreenchange', handleFSChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFSChange);
      document.removeEventListener('webkitfullscreenchange', handleFSChange);
    };
  }, []);

  // Handlers
  const openCam = (id: string) => {
    setSelectedDeviceId(id);
    setViewMode('detail');
  };

  const closeDetail = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
    setViewMode('grid');
  };

  const toggleFullscreen = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!mainFeedRef.current) return;
    const elem = mainFeedRef.current as any;
    if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
      if (elem.requestFullscreen) {
        elem.requestFullscreen();
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      } else if (elem.msRequestFullscreen) {
        elem.msRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
    }
  };

  // Weekly availability calculation dynamically derived from real device status
  const weeklyDays = useMemo(() => {
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const now = new Date();
    const currentDayIdx = (now.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday

    if (!activeCamera) {
      return dayNames.map((day) => ({ day, isOnline: false, statusText: 'No device selected' }));
    }

    const isDevOnline = activeCamera.status === 'online';
    const lastSeenTime = activeCamera.lastSeen ? new Date(activeCamera.lastSeen).getTime() : 0;

    return dayNames.map((day, idx) => {
      if (idx === currentDayIdx) {
        return {
          day: `${day} (Today)`,
          isOnline: isDevOnline,
          statusText: isDevOnline ? 'Active Live Stream' : 'Offline / Connection Lost',
        };
      } else if (idx < currentDayIdx) {
        // Past day in current week: check if device was seen recently
        const daysAgo = currentDayIdx - idx;
        const cutoff = Date.now() - daysAgo * 86400000 - 3600000;
        const wasOnline = isDevOnline || lastSeenTime > cutoff;
        return {
          day,
          isOnline: wasOnline,
          statusText: wasOnline ? '100% Uptime' : 'Connection Interrupted',
        };
      } else {
        // Future day in current week
        return {
          day,
          isOnline: isDevOnline,
          statusText: isDevOnline ? 'Scheduled (Active)' : 'Standby / Offline',
        };
      }
    });
  }, [activeCamera]);

  return (
    <div className="retail-live-wrapper">
      <style>{`
        .retail-live-wrapper {
          --sidebar-bg: #ffffff;
          --sidebar-active: #eff6ff;
          --sidebar-text: #64748b;
          --sidebar-text-hover: #1e293b;
          --bg-body: #f4f6fa;
          --bg-white: #ffffff;
          --text-dark: #1e293b;
          --text-secondary: #64748b;
          --text-muted: #94a3b8;
          --text-label: #8492a6;
          --accent: #2563eb;
          --accent-light: #eff6ff;
          --success: #10b981;
          --success-bg: #ecfdf5;
          --danger: #ef4444;
          --border: #e5e7eb;
          --border-light: #f1f5f9;
          --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
          --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.05);
          --shadow-feed: 0 8px 24px rgba(0, 0, 0, 0.08);
          --radius: 12px;
          --radius-sm: 8px;
          --radius-xs: 6px;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: var(--text-dark);
          width: 100%;
        }

        .sticky-top-bar {
          position: relative;
          background: var(--bg-body);
          z-index: 10;
          padding: 8px 0 4px 0;
        }

        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .page-title {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .page-title-icon {
          width: 40px;
          height: 40px;
          background: var(--accent-light);
          border-radius: var(--radius-sm);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
        }

        .page-title h1 {
          font-size: 1.375rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          margin: 0;
        }

        .filters-bar {
          background: var(--bg-white);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 16px 20px;
          margin-bottom: 16px;
          display: flex;
          align-items: flex-end;
          gap: 16px;
          box-shadow: var(--shadow-card);
        }

        .filter-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 180px;
        }

        .filter-item label {
          font-size: 0.6875rem;
          font-weight: 700;
          color: var(--text-label);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .filter-select {
          width: 100%;
          padding: 9px 32px 9px 12px;
          background-color: var(--bg-body);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-dark);
          font-size: 0.8125rem;
          font-weight: 500;
          outline: none;
          cursor: pointer;
          transition: all 0.2s ease;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          background-size: 14px;
        }

        .filter-select:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
          background-color: var(--bg-white);
        }

        .search-input-wrapper {
          position: relative;
          display: flex;
          align-items: center;
        }

        .search-icon {
          position: absolute;
          left: 10px;
          color: #94a3b8;
        }

        .filter-search {
          width: 100%;
          padding: 9px 12px 9px 34px;
          background-color: var(--bg-body);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-dark);
          font-size: 0.8125rem;
          font-weight: 500;
          outline: none;
          transition: all 0.2s ease;
        }

        .filter-search:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
          background-color: var(--bg-white);
        }

        .status-toggle-wrapper {
          display: flex;
          align-items: center;
          gap: 10px;
          height: 36px;
        }

        .status-label {
          font-size: 0.8125rem;
          font-weight: 500;
          color: var(--text-muted);
          transition: color 0.2s;
        }

        .status-label.active {
          color: var(--text-dark);
          font-weight: 600;
        }

        .switch {
          position: relative;
          display: inline-block;
          width: 40px;
          height: 22px;
        }

        .switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--text-muted);
          transition: .4s;
          border-radius: 34px;
        }

        .slider:before {
          position: absolute;
          content: "";
          height: 16px;
          width: 16px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: .4s;
          border-radius: 50%;
        }

        input:checked + .slider {
          background-color: var(--success);
        }

        input:checked + .slider:before {
          transform: translateX(18px);
        }

        .filter-divider {
          width: 1px;
          height: 36px;
          background: var(--border);
        }

        /* GRID VIEW */
        .camera-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
          padding-bottom: 24px;
        }

        @media (max-width: 1024px) {
          .camera-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 640px) {
          .camera-grid {
            grid-template-columns: 1fr;
          }
        }

        .grid-card {
          background: var(--bg-white);
          border: 1.5px solid var(--border);
          border-radius: var(--radius);
          padding: 16px;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: var(--shadow-card);
          display: flex;
          flex-direction: column;
        }

        .grid-card:hover {
          transform: translateY(-3px);
          box-shadow: var(--shadow-md);
          border-color: var(--accent);
        }

        .grid-thumb {
          width: 100%;
          aspect-ratio: 4 / 3;
          min-height: 260px;
          background: #0f172a;
          border-radius: var(--radius-sm);
          margin-bottom: 12px;
          position: relative;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .grid-thumb::before {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(circle, transparent 55%, #000 68%);
          pointer-events: none;
          z-index: 2;
        }

        .grid-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 4px;
        }

        .grid-cam-name {
          font-size: 0.8125rem;
          font-weight: 600;
          color: var(--text-dark);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* DETAIL VIEW */
        .feed-layout {
          display: flex;
          gap: 20px;
          height: auto;
          align-items: flex-start;
          padding-bottom: 24px;
        }

        @media (max-width: 1200px) {
          .feed-layout {
            flex-direction: column;
            height: auto;
          }
        }

        .preview-sidebar {
          width: 260px;
          min-width: 260px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .back-to-grid-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          background: var(--bg-white);
          border: 1.5px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-dark);
          font-size: 0.8125rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: var(--shadow-card);
        }

        .back-to-grid-btn:hover {
          background: var(--bg-body);
          border-color: #cbd5e1;
        }

        .preview-column {
          display: flex;
          flex-direction: column;
          gap: 12px;
          overflow-y: auto;
          padding-right: 4px;
          flex: 1;
          min-height: 0;
          scrollbar-width: none;
        }

        .preview-column::-webkit-scrollbar {
          display: none;
        }

        .preview-card {
          background: var(--bg-white);
          border: 1.5px solid var(--border);
          border-radius: var(--radius);
          padding: 10px;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: var(--shadow-card);
        }

        .preview-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-md);
          border-color: #cbd5e1;
        }

        .preview-card.active {
          border-color: var(--accent);
          background: var(--accent-light);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08), var(--shadow-card);
        }

        .preview-thumb {
          width: 100%;
          height: 110px;
          background: #0f172a;
          border-radius: var(--radius-sm);
          margin-bottom: 10px;
          position: relative;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .preview-thumb::before {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(circle, transparent 55%, #000 68%);
          pointer-events: none;
          z-index: 2;
        }

        .preview-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .preview-cam-name {
          font-size: 0.8125rem;
          font-weight: 600;
          color: var(--text-dark);
        }

        .preview-card.active .preview-cam-name {
          color: var(--accent);
        }

        /* Shared Tags & Pills */
        .live-tag {
          position: absolute;
          top: 6px;
          left: 6px;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          color: white;
          font-size: 0.5625rem;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          z-index: 3;
        }

        .live-tag .rdot {
          width: 5px;
          height: 5px;
          background: var(--danger);
          border-radius: 50%;
          animation: blink 2s infinite;
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 0.625rem;
          font-weight: 600;
          color: var(--success);
          background: var(--success-bg);
          padding: 2px 8px;
          border-radius: 9999px;
          flex-shrink: 0;
        }

        .cs-badge {
          background: #fef3c7;
          color: #d97706;
          font-size: 0.625rem;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 9999px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border: 1px solid #fde68a;
        }

        .coming-soon-box {
          padding: 20px 14px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          background: var(--bg-body);
          border: 1.5px dashed var(--border);
          border-radius: var(--radius-sm);
          margin-top: 8px;
        }

        .cs-icon-wrapper {
          width: 42px;
          height: 42px;
          background: #eff6ff;
          color: #2563eb;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 10px;
        }

        .cs-heading {
          font-size: 0.875rem;
          font-weight: 700;
          color: var(--text-dark);
          margin-bottom: 4px;
        }

        .cs-subtext {
          font-size: 0.75rem;
          color: var(--text-muted);
          line-height: 1.4;
          margin: 0 0 14px 0;
        }

        .cs-current-status-card {
          width: 100%;
          background: var(--bg-white);
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          padding: 10px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }

        .cs-cs-label {
          font-size: 0.6875rem;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .cs-cs-value {
          font-size: 0.8125rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .cs-cs-value.online {
          color: var(--success);
        }

        .cs-cs-value.offline {
          color: var(--danger);
        }

        .status-pill .sdot {
          width: 5px;
          height: 5px;
          background: var(--success);
          border-radius: 50%;
        }

        /* Main Feed */
        .feed-column {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .main-feed-card {
          width: 100%;
          height: 480px;
          background: #0f172a;
          border-radius: var(--radius);
          border: 1px solid var(--border);
          position: relative;
          overflow: hidden;
          box-shadow: var(--shadow-feed);
          display: flex;
          flex-direction: column;
        }

        .feed-top-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          padding: 20px;
          background: linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, transparent 100%);
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          z-index: 30;
          pointer-events: auto;
        }

        .feed-cam-title {
          font-size: 1.125rem;
          font-weight: 700;
          color: white;
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
        }

        .feed-btns {
          display: flex;
          gap: 8px;
          z-index: 40;
          position: relative;
          pointer-events: auto;
        }

        .fbtn {
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: white;
          border-radius: var(--radius-sm);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s;
          backdrop-filter: blur(6px);
          pointer-events: auto;
        }

        .fbtn-icon {
          width: 36px;
          height: 36px;
        }

        .fbtn:hover {
          background: rgba(255, 255, 255, 0.22);
          transform: scale(1.03);
        }

        .close-btn:hover {
          background: rgba(239, 68, 68, 0.3);
          border-color: rgba(239, 68, 68, 0.5);
        }

        .feed-video-area {
          flex: 1;
          background-size: cover;
          background-position: center;
          position: relative;
          background-color: #000;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .feed-video-area::before {
          display: none;
        }

        .feed-video-area::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(0,0,0,0.4) 0%, transparent 20%, transparent 80%, rgba(0,0,0,0.6) 100%);
          pointer-events: none;
          z-index: 2;
        }

        /* NATIVE FULLSCREEN STYLING */
        .main-feed-card:fullscreen,
        .main-feed-card:-webkit-full-screen {
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          border-radius: 0 !important;
          border: none !important;
          background: #000000 !important;
          margin: 0 !important;
          padding: 0 !important;
          display: flex !important;
          flex-direction: column !important;
        }

        .main-feed-card:fullscreen .feed-top-overlay,
        .main-feed-card:-webkit-full-screen .feed-top-overlay {
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          padding: 24px 32px !important;
          background: linear-gradient(180deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.3) 70%, transparent 100%) !important;
          z-index: 50 !important;
        }

        .main-feed-card:fullscreen .feed-cam-title,
        .main-feed-card:-webkit-full-screen .feed-cam-title {
          font-size: 1.5rem !important;
          font-weight: 700 !important;
          color: #ffffff !important;
          text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8) !important;
        }

        .main-feed-card:fullscreen .fbtn,
        .main-feed-card:-webkit-full-screen .fbtn {
          width: 44px !important;
          height: 44px !important;
          background: rgba(255, 255, 255, 0.22) !important;
          border: 1px solid rgba(255, 255, 255, 0.35) !important;
        }

        .main-feed-card:fullscreen .feed-bottom-overlay,
        .main-feed-card:-webkit-full-screen .feed-bottom-overlay {
          position: absolute !important;
          bottom: 0 !important;
          left: 0 !important;
          right: 0 !important;
          padding: 24px 32px !important;
          background: linear-gradient(0deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.3) 70%, transparent 100%) !important;
          z-index: 50 !important;
        }

        .main-feed-card:fullscreen .time-badge,
        .main-feed-card:-webkit-full-screen .time-badge {
          font-size: 1rem !important;
          padding: 8px 18px !important;
        }

        .main-feed-card:fullscreen img,
        .main-feed-card:-webkit-full-screen img {
          width: 100% !important;
          height: 100% !important;
          object-fit: contain !important;
        }

        .feed-bottom-overlay {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          padding: 16px 20px;
          display: flex;
          justify-content: flex-end;
          align-items: center;
          z-index: 3;
        }

        .time-badge {
          color: white;
          font-size: 0.8125rem;
          font-weight: 500;
          background: rgba(0, 0, 0, 0.55);
          padding: 6px 14px;
          border-radius: 9999px;
          backdrop-filter: blur(6px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font-variant-numeric: tabular-nums;
        }

        .feed-info-row {
          background: var(--bg-white);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 16px 24px;
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 12px;
          box-shadow: var(--shadow-card);
        }

        .info-cell {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .info-cell:not(:last-child) {
          border-right: 1px solid var(--border-light);
          padding-right: 12px;
        }

        .info-label {
          font-size: 0.625rem;
          font-weight: 700;
          color: var(--text-label);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .info-value {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--text-dark);
        }

        .info-value.online {
          color: var(--success);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        /* STATUS SIDEBAR */
        .status-sidebar {
          width: 360px;
          min-width: 360px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .status-card {
          background: var(--bg-white);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 20px;
          box-shadow: var(--shadow-card);
        }

        .status-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .status-card-title {
          font-size: 0.9375rem;
          font-weight: 700;
          color: var(--text-dark);
        }

        .weekly-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .weekly-day {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: var(--bg-body);
          border: 1px solid var(--border-light);
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: all 0.2s;
        }

        .weekly-day:hover {
          background: var(--bg-white);
          border-color: #cbd5e1;
          transform: translateX(2px);
          box-shadow: 0 2px 4px rgba(0,0,0,0.02);
        }

        .day-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .day-name {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--text-dark);
        }

        .day-time {
          font-size: 0.75rem;
          color: var(--text-muted);
        }

        .day-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8125rem;
          font-weight: 600;
        }

        .day-status.online { color: var(--success); }
        .day-status.offline { color: var(--danger); }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .day-status.online .status-dot { background: var(--success); }
        .day-status.offline .status-dot { background: var(--danger); }

        /* MODAL */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(4px);
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }

        .modal-overlay.active {
          opacity: 1;
          pointer-events: auto;
        }

        .modal-content {
          background: var(--bg-white);
          border-radius: var(--radius);
          width: 550px;
          max-width: 90%;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
          transform: translateY(20px);
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .modal-overlay.active .modal-content {
          transform: translateY(0);
        }

        .modal-header {
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: var(--bg-body);
        }

        .modal-title-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .modal-title {
          font-size: 1.125rem;
          font-weight: 700;
          color: var(--text-dark);
        }

        .modal-subtitle {
          font-size: 0.8125rem;
          color: var(--text-muted);
          font-weight: 500;
        }

        .modal-close {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          padding: 4px;
          border-radius: var(--radius-sm);
          transition: all 0.2s;
        }

        .modal-close:hover {
          background: #e2e8f0;
          color: var(--text-dark);
        }

        .modal-body {
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 24px;
          max-height: 70vh;
          overflow-y: auto;
        }

        .modal-timeline-wrapper {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .modal-timeline {
          display: flex;
          height: 36px;
          border-radius: var(--radius-sm);
          overflow: hidden;
          background: var(--success);
        }

        .modal-timeline-segment {
          height: 100%;
        }

        .modal-timeline-segment.down {
          background: var(--danger);
        }

        .modal-timeline-labels {
          display: flex;
          justify-content: space-between;
          font-size: 0.6875rem;
          font-weight: 600;
          color: var(--text-muted);
        }

        .modal-log-title {
          font-size: 0.875rem;
          font-weight: 700;
          color: var(--text-dark);
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .modal-events {
          display: flex;
          flex-direction: column;
          gap: 0;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          overflow: hidden;
        }

        .modal-event-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: var(--bg-white);
        }

        .modal-event-item:not(:last-child) {
          border-bottom: 1px solid var(--border-light);
        }

        .modal-event-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .modal-event-time {
          font-size: 0.8125rem;
          font-weight: 600;
          color: var(--text-dark);
          width: 48px;
        }

        .modal-event-status {
          font-size: 0.8125rem;
          font-weight: 600;
        }

        .modal-event-status.down { color: var(--danger); }
        .modal-event-status.up { color: var(--success); }

        .modal-event-duration {
          font-size: 0.75rem;
          color: var(--text-muted);
          font-weight: 500;
          background: var(--bg-body);
          padding: 4px 8px;
          border-radius: var(--radius-xs);
        }

        /* CUSTOM DROPDOWN FOR BRANCH/STORE */
        .custom-dropdown {
          position: relative;
          width: 100%;
        }

        .dropdown-selected {
          width: 100%;
          padding: 9px 32px 9px 12px;
          background-color: var(--bg-body);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-dark);
          font-size: 0.8125rem;
          font-weight: 500;
          cursor: pointer;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          background-size: 14px;
          user-select: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .dropdown-selected.open {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
          background-color: var(--bg-white);
        }

        .dropdown-menu {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          background: var(--bg-white);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-md);
          z-index: 50;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .dropdown-search {
          padding: 8px;
          border-bottom: 1px solid var(--border-light);
        }

        .dropdown-search input {
          width: 100%;
          padding: 6px 10px;
          border: 1px solid var(--border);
          border-radius: var(--radius-xs);
          font-size: 0.8125rem;
          outline: none;
        }

        .dropdown-search input:focus {
          border-color: var(--accent);
        }

        .dropdown-options {
          max-height: 200px;
          overflow-y: auto;
        }

        .dropdown-option {
          padding: 8px 12px;
          font-size: 0.8125rem;
          cursor: pointer;
          color: var(--text-dark);
        }

        .dropdown-option:hover {
          background: var(--sidebar-active);
          color: var(--accent);
        }

        /* ZONE HEATMAP (coming soon) */
        .zone-heatmap-card {
          background: #0b1120;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 20px 24px 24px;
          margin-bottom: 16px;
          box-shadow: var(--shadow-card);
        }

        .zone-heatmap-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 18px;
        }

        .zone-heatmap-title {
          font-size: 0.75rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #cbd5e1;
        }

        .zone-heatmap-body {
          position: relative;
          width: 100%;
          max-width: 420px;
          aspect-ratio: 1 / 1;
          margin: 0 auto;
          border-radius: 50%;
          background: radial-gradient(circle, #131b2e 0%, #0b1120 70%, #060a14 100%);
          border: 1px solid rgba(255,255,255,0.06);
          overflow: hidden;
          filter: blur(0.5px) saturate(0.85);
          opacity: 0.9;
        }

        .zone-heatmap-body::after {
          content: '';
          position: absolute;
          inset: 0;
          background:
            linear-gradient(to right, transparent 49.5%, rgba(255,255,255,0.06) 50%, transparent 50.5%),
            linear-gradient(to bottom, transparent 49.5%, rgba(255,255,255,0.06) 50%, transparent 50.5%);
        }

        .zone-heatmap-ring {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 55%;
          height: 55%;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 50%;
          transform: translate(-50%, -50%);
        }

        .zone-blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(10px);
        }

        .zone-label {
          position: absolute;
          font-size: 0.6875rem;
          font-weight: 700;
          color: rgba(255,255,255,0.85);
          text-shadow: 0 1px 3px rgba(0,0,0,0.6);
          white-space: nowrap;
        }

        .zone-shopper-dot {
          position: absolute;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 0 4px rgba(255,255,255,0.8);
        }

        .zone-entrance-badge {
          position: absolute;
          bottom: -2px;
          left: 50%;
          transform: translateX(-50%);
          background: #10b981;
          color: #04140d;
          font-size: 0.5625rem;
          font-weight: 800;
          letter-spacing: 0.06em;
          padding: 3px 10px;
          border-radius: 4px;
        }

        .zone-heatmap-legend {
          display: flex;
          justify-content: center;
          gap: 20px;
          margin-top: 16px;
          flex-wrap: wrap;
        }

        .zone-legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.6875rem;
          font-weight: 600;
          color: #94a3b8;
        }

        .zone-legend-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
        }

        .zone-heatmap-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          background: rgba(6, 10, 20, 0.55);
          backdrop-filter: blur(1px);
          border-radius: 50%;
          text-align: center;
          padding: 24px;
        }

        .zone-heatmap-overlay .cs-badge {
          background: #fef3c7;
          color: #92400e;
        }

        .zone-heatmap-overlay-text {
          font-size: 0.8125rem;
          font-weight: 700;
          color: #ffffff;
        }

        .zone-heatmap-overlay-sub {
          font-size: 0.6875rem;
          color: #cbd5e1;
          max-width: 260px;
          line-height: 1.4;
        }
      `}</style>

      <div className="sticky-top-bar">
        <div className="page-header">
          <div className="page-title">
            <div className="page-title-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </div>
            <h1>CCTV Live Stream</h1>
          </div>
        </div>

        {/* FILTERS BAR */}
        <div className="filters-bar">
          <div className="filter-item">
            <label>Search</label>
            <div className="search-input-wrapper">
              <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="filter-search"
                placeholder="Camera / device name..."
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="filter-divider" />

          {/* REAL STORE / BRANCH DROPDOWN */}
          <div className="filter-item">
            <label>Select Store / Branch</label>
            <div className="custom-dropdown">
              <div
                className={`dropdown-selected ${storeDropdownOpen ? 'open' : ''}`}
                onClick={() => setStoreDropdownOpen(!storeDropdownOpen)}
              >
                {currentStore ? currentStore.name : loadingStores ? 'Loading stores…' : 'Select Store'}
              </div>
              {storeDropdownOpen && (
                <div className="dropdown-menu">
                  <div className="dropdown-search">
                    <input
                      type="text"
                      placeholder="Search store..."
                      value={storeSearchInput}
                      onChange={(e) => setStoreSearchInput(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="dropdown-options">
                    {stores
                      .filter((s) => s.name.toLowerCase().includes(storeSearchInput.toLowerCase()))
                      .map((st) => (
                        <div
                          key={st.id}
                          className="dropdown-option"
                          onClick={() => {
                            setSelectedStoreId(st.id);
                            setStoreDropdownOpen(false);
                          }}
                        >
                          {st.name}
                        </div>
                      ))}
                    {stores.length === 0 && (
                      <div className="dropdown-option" style={{ color: 'var(--text-muted)' }}>
                        No stores found
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="filter-divider" />

          {/* REAL CAMERA / DEVICE DROPDOWN */}
          <div className="filter-item" style={{ minWidth: 240 }}>
            <label>Select Camera</label>
            <select
              className="filter-select"
              value={viewMode === 'grid' ? 'all' : selectedDeviceId || 'all'}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'all') {
                  closeDetail();
                } else {
                  openCam(val);
                }
              }}
            >
              <option value="all">All Cameras ({displayCameras.length})</option>
              {filteredCameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: 1 }} />

          {/* VIEW STATUS TOGGLE */}
          <div className="filter-item">
            <label>View Status</label>
            <div className="status-toggle-wrapper">
              <span className={`status-label ${!isOnlineFilter ? 'active' : ''}`}>Offline</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={isOnlineFilter}
                  onChange={(e) => setIsOnlineFilter(e.target.checked)}
                />
                <span className="slider" />
              </label>
              <span className={`status-label ${isOnlineFilter ? 'active' : ''}`}>Online</span>
            </div>
          </div>
        </div>
      </div>



      {/* GRID VIEW */}
      {viewMode === 'grid' && (
        <div className="camera-grid">
          {loadingLive ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading devices for store…
            </div>
          ) : filteredCameras.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              No edge devices or cameras found matching current filters.
            </div>
          ) : (
            filteredCameras.map((cam) => {
              const liveFrame = deviceFramesMap[cam.id];
              return (
                <div key={cam.id} className="grid-card" onClick={() => openCam(cam.id)}>
                  <div className="grid-thumb">
                    {cam.status === 'online' ? (
                      <div className="live-tag">
                        <span className="rdot" /> Live
                      </div>
                    ) : (
                      <div className="live-tag" style={{ background: 'rgba(0,0,0,0.6)', color: '#94a3b8' }}>
                        <span className="sdot" style={{ background: '#94a3b8' }} /> Offline
                      </div>
                    )}

                    {liveFrame ? (
                      <img
                        src={liveFrame}
                        alt={cam.name}
                        className="w-full h-full object-cover z-10 relative"
                      />
                    ) : (
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#475569', zIndex: 1 }}>
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                      </svg>
                    )}
                  </div>
                  <div className="grid-info">
                    <span className="grid-cam-name">{cam.name}</span>
                    {cam.status === 'online' ? (
                      <span className="status-pill">
                        <span className="sdot" /> Online
                      </span>
                    ) : (
                      <span className="status-pill" style={{ color: '#94a3b8', background: '#f1f5f9' }}>
                        <span className="sdot" style={{ background: '#94a3b8' }} /> Offline
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* DETAIL VIEW */}
      {viewMode === 'detail' && (
        <div className="feed-layout">
          {/* PREVIEW SIDEBAR */}
          <div className="preview-sidebar">
            <button className="back-to-grid-btn" onClick={closeDetail}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              Back to Grid
            </button>
            <div className="preview-column">
              {filteredCameras.map((cam) => {
                const liveFrame = deviceFramesMap[cam.id];
                return (
                  <div
                    key={cam.id}
                    className={`preview-card ${cam.id === selectedDeviceId ? 'active' : ''}`}
                    onClick={() => openCam(cam.id)}
                  >
                    <div className="preview-thumb">
                      {cam.status === 'online' ? (
                        <div className="live-tag">
                          <span className="rdot" /> Live
                        </div>
                      ) : (
                        <div className="live-tag" style={{ background: 'rgba(0,0,0,0.6)', color: '#94a3b8' }}>
                          <span className="sdot" style={{ background: '#94a3b8' }} /> Offline
                        </div>
                      )}

                      {liveFrame ? (
                        <img
                          src={liveFrame}
                          alt={cam.name}
                          className="w-full h-full object-cover z-10 relative"
                        />
                      ) : (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#475569', zIndex: 1 }}>
                          <polygon points="23 7 16 12 23 17 23 7" />
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                      )}
                    </div>
                    <div className="preview-meta">
                      <div>
                        <div className="preview-cam-name">{cam.name}</div>
                      </div>
                      {cam.status === 'online' ? (
                        <div className="status-pill">
                          <span className="sdot" /> Online
                        </div>
                      ) : (
                        <div className="status-pill" style={{ color: '#94a3b8', background: '#f1f5f9' }}>
                          <span className="sdot" style={{ background: '#94a3b8' }} /> Offline
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* CENTER FEED COLUMN */}
          <div className="feed-column">
            <div className="main-feed-card" ref={mainFeedRef}>
              <div className="feed-top-overlay">
                <div>
                  <div className="feed-cam-title">{activeCamera ? activeCamera.name : 'Select a device'}</div>
                </div>
                <div className="feed-btns">
                  <button className="fbtn fbtn-icon close-btn" title="Close" onClick={closeDetail}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                  <button
                    className="fbtn fbtn-icon"
                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                    onClick={toggleFullscreen}
                  >
                    {isFullscreen ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* VIDEO / FRAME DISPLAY AREA */}
              <div className="feed-video-area">
                {activeCamera && deviceFramesMap[activeCamera.id] ? (
                  <img
                    src={deviceFramesMap[activeCamera.id]}
                    alt="Live feed frame"
                    onLoad={handleImageLoad}
                    className="w-full h-full object-contain z-1 relative"
                  />
                ) : activeCamera?.status === 'online' ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      color: '#94a3b8',
                      gap: 12,
                      background: '#0f172a',
                      width: '100%',
                      zIndex: 1,
                    }}
                  >
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <span style={{ fontSize: '1.125rem', fontWeight: 600 }}>
                      {connected ? 'Waiting for frame…' : 'Connecting to live feed…'}
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      color: '#94a3b8',
                      gap: 12,
                      background: '#1e293b',
                      width: '100%',
                      zIndex: 1,
                    }}
                  >
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 2l20 20" />
                      <path d="M15 15a4 4 0 01-6-6" />
                      <path d="M12 2v2" />
                      <path d="M12 20v2" />
                      <path d="M2 12h2" />
                      <path d="M20 12h2" />
                      <path d="M19.07 4.93l-1.41 1.41" />
                      <path d="M6.34 17.66l-1.41 1.41" />
                      <path d="M4.93 4.93l1.41 1.41" />
                      <path d="M17.66 17.66l1.41 1.41" />
                    </svg>
                    <span style={{ fontSize: '1.125rem', fontWeight: 600 }}>Camera Offline</span>
                  </div>
                )}
              </div>

              <div className="feed-bottom-overlay">
                {lastFrameReceivedAt > 0 && (
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.75rem', fontFamily: 'monospace', marginRight: 12 }}>
                    frame #{frameCount}
                  </span>
                )}
                <div className="time-badge">{clockString}</div>
              </div>
            </div>

            {/* INFO ROW */}
            <div className="feed-info-row">
              <div className="info-cell">
                <span className="info-label">Status</span>
                {activeCamera?.status === 'online' ? (
                  <span className="info-value online">
                    <span style={{ width: 7, height: 7, background: 'var(--success)', borderRadius: '50%', display: 'inline-block' }} />
                    Online
                  </span>
                ) : (
                  <span className="info-value" style={{ color: '#94a3b8' }}>
                    <span style={{ width: 7, height: 7, background: '#94a3b8', borderRadius: '50%', display: 'inline-block' }} />
                    Offline
                  </span>
                )}
              </div>
              <div className="info-cell">
                <span className="info-label">Resolution</span>
                <span className="info-value">
                  {streamResolution || (activeCamera?.status === 'online' ? 'Auto Detect' : 'N/A')}
                </span>
              </div>
              <div className="info-cell">
                <span className="info-label">Stream Type</span>
                <span className="info-value">
                  {activeCamera?.status === 'online' ? 'JPEG SSE (Live)' : 'N/A'}
                </span>
              </div>
              <div className="info-cell">
                <span className="info-label">Last Heartbeat</span>
                <span className="info-value">
                  {activeCamera?.lastSeen ? new Date(activeCamera.lastSeen).toLocaleTimeString() : 'N/A'}
                </span>
              </div>
              <div className="info-cell">
                <span className="info-label">Store</span>
                <span className="info-value">{currentStore?.name || 'N/A'}</span>
              </div>
            </div>
          </div>

          {/* STATUS SIDEBAR */}
          <div className="status-sidebar">
            <div className="status-card">
              <div className="status-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="status-card-title">Availability History</span>
                <span className="cs-badge">Coming Soon</span>
              </div>
              
              <div className="coming-soon-box">
                <div className="cs-icon-wrapper">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div className="cs-heading">7-Day Uptime Log</div>
                <p className="cs-subtext">
                  Historical telemetry and availability analytics for edge devices will be available in an upcoming release.
                </p>
                <div className="cs-current-status-card">
                  <div className="cs-cs-label">Live Connection Status</div>
                  <div className={`cs-cs-value ${activeCamera?.status === 'online' ? 'online' : 'offline'}`}>
                    <span className="sdot" style={{ background: activeCamera?.status === 'online' ? 'var(--success)' : '#94a3b8' }} />
                    {activeCamera?.status === 'online' ? 'Online & Streaming' : 'Offline / Unreachable'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DAILY OVERVIEW MODAL */}
      {selectedDayModal && (
        <div
          className={`modal-overlay ${selectedDayModal ? 'active' : ''}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedDayModal(null);
          }}
        >
          <div className="modal-content">
            <div className="modal-header">
              <div className="modal-title-group">
                <div className="modal-title">{selectedDayModal.camName}</div>
                <div className="modal-subtitle">{selectedDayModal.day} Overview</div>
              </div>
              <button className="modal-close" onClick={() => setSelectedDayModal(null)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-timeline-wrapper">
                <div className="modal-timeline">
                  <div
                    className={`modal-timeline-segment ${!selectedDayModal.isOnline ? 'down' : ''}`}
                    style={{ width: '100%' }}
                  />
                </div>
                <div className="modal-timeline-labels">
                  <span>00:00</span>
                  <span>06:00</span>
                  <span>12:00</span>
                  <span>18:00</span>
                  <span>23:59</span>
                </div>
              </div>

              <div>
                <div className="modal-log-title">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                  Connection Log
                </div>
                <div className="modal-events">
                  {selectedDayModal.isOnline ? (
                    <div className="modal-event-item">
                      <div className="modal-event-left" style={{ color: 'var(--text-muted)' }}>
                        No connection interruptions recorded for this day.
                      </div>
                    </div>
                  ) : (
                    <div className="modal-event-item">
                      <div className="modal-event-left">
                        <span className="modal-event-time">
                          {selectedDayModal.lastSeen
                            ? new Date(selectedDayModal.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '08:00'}
                        </span>
                        <span className="modal-event-status down">Connection Lost</span>
                      </div>
                      <span className="modal-event-duration">Device Offline</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RetailLiveView;
