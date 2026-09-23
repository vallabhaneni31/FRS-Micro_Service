import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import { Card, CardContent, CardHeader } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Badge } from '../../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/alert-dialog';
import {
  Camera, Server, Plus, Play, RefreshCw,
  Loader2, Trash2, Cpu, Activity, X,
  Maximize2, Database, Shield, WifiOff, Edit2,
  Layers, Check, HardDrive, Clock, Building2, Network
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useDeviceStatuses } from '../../../../hooks/useDeviceStatuses';
import { ZtpActivationModal } from './ZtpActivationModal';

// MediaMTX HLS base — dynamically configurable or same host on port 8888 fallback
const HLS_BASE = (import.meta as any).env?.VITE_MEDIAMTX_URL || `${window.location.protocol}//${window.location.hostname}:8888`;

interface ChildCamera {
  id: string;
  name: string;
  cam_id: string;
  stream_name: string | null;   // MediaMTX path, e.g. "cam1"
  status: 'online' | 'offline' | 'error';
  ip_address: string;
  rtsp_url: string;
  model?: string | null;
  last_active: string;
  zone_type?: 'work' | 'break' | 'other' | 'unassigned';
  zone_label?: string | null;
  camera_mode?: 'IN' | 'OUT' | 'MIXED';
}

interface EdgeDevice {
  pk_device_id: string;
  pk_nug_id: string | null;
  name: string;
  device_code: string;
  status: 'online' | 'offline' | 'error';
  ip_address: string;
  port: number;
  cpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  gpu_percent: number;
  temperature_c: number;
  disk_used_gb: number;
  disk_total_gb: number;
  disk_free_gb: number;
  uptime_seconds: number;
  last_heartbeat: string;
  zone_type?: 'work' | 'break' | 'other' | 'unassigned';
  zone_label?: string | null;
  floor_id?: number | null;
  camera_count: number;
  cameras: ChildCamera[];
}

// Location/zone a device monitors — drives dwell-time roll-ups (work vs break vs other).
const ZONE_OPTIONS: { value: 'work' | 'break' | 'other' | 'unassigned'; label: string }[] = [
  { value: 'work',       label: '🏢 Workplace' },
  { value: 'break',      label: '☕ Cafeteria / Break' },
  { value: 'other',      label: '📍 Other area' },
  { value: 'unassigned', label: '— Unassigned' },
];


const OFFLINE_THRESHOLD_MS = (parseInt((import.meta as any).env?.VITE_DEVICE_OFFLINE_THRESHOLD_MIN || '5', 10)) * 60 * 1000;
/** Returns the effective status: if last_heartbeat is stale, treat as offline regardless of DB value */
function effectiveStatus(status: string, lastHeartbeat?: string | null): 'online' | 'offline' | 'error' {
  if (status === 'error') return 'error';
  if (!lastHeartbeat) return status === 'online' ? 'online' : 'offline';
  const staleSince = Date.now() - new Date(lastHeartbeat).getTime();
  if (staleSince > OFFLINE_THRESHOLD_MS) return 'offline';
  return status === 'online' ? 'online' : 'offline';
}

const DeviceStatusBadge = ({ status, lastHeartbeat }: { status: string; lastHeartbeat?: string | null }) => {
  const resolved = effectiveStatus(status, lastHeartbeat);
  const colors = {
    online:  'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    offline: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    error:   'bg-rose-500/10 text-rose-500 border-rose-500/20',
  };
  return (
    <Badge className={cn('font-bold tracking-tight px-2 py-0.5 border', colors[resolved])}>
      {resolved.toUpperCase()}
    </Badge>
  );
};

/** Industry-standard field validation — returns first error message or null. */
const validateNodeField = (fieldName: string, value: string): string | null => {
  if (fieldName === 'name') {
    if (!value) return 'Node Name is required.';
    if (value.length < 2) return 'Node Name must be at least 2 characters.';
    if (value.length > 30) return 'Node Name cannot exceed 30 characters.';
    if (/\s/.test(value)) return 'Spaces are not allowed. Use hyphens (-) instead.';
    if (/--/.test(value)) return 'Consecutive hyphens (--) are not allowed.';
    if (!/^[a-zA-Z0-9-]+$/.test(value)) return 'Only letters (A-Z, a-z), numbers (0-9), and hyphens (-) are allowed.';
  }
  if (fieldName === 'device_code' && value) {
    if (value.length < 2) return 'Device Code must be at least 2 characters.';
    if (/\s/.test(value)) return 'Spaces are not allowed. Use hyphens (-) instead.';
    if (!/^[a-zA-Z0-9-]+$/.test(value)) return 'Only letters (A-Z, a-z), numbers (0-9), and hyphens (-) are allowed.';
  }
  return null;
};

const NODE_NAME_MAX = 30;
const NODE_NAME_WARN = 25;

export const DeviceManagement: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
  const { accessToken, isAuthenticated, sites, activeScope } = useAuth();
  const baseScopeHeaders = useScopeHeaders();
  const globalSiteId = activeScope?.siteId;
  const [localSiteId, setLocalSiteId] = useState<string>('');

  useEffect(() => {
    if (globalSiteId) {
      setLocalSiteId(globalSiteId);
    } else if (sites && sites.length > 0 && !localSiteId) {
      setLocalSiteId(String(sites[0].id));
    }
  }, [globalSiteId, sites, localSiteId]);

  const scopeHeaders = React.useMemo(() => {
    const headers = { ...baseScopeHeaders };
    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }
    if (localSiteId) {
      headers['x-site-id'] = localSiteId;
    }
    return headers;
  }, [baseScopeHeaders, tenantId, localSiteId]);

  const activeSite = useMemo(() => {
    return sites?.find((s: any) => String(s.id) === String(localSiteId));
  }, [sites, localSiteId]);

  const [edgeDevices, setEdgeDevices] = useState<EdgeDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const liveStatuses = useDeviceStatuses();
  const [activeStream, setActiveStream] = useState<ChildCamera | null>(null);

  // Floor states
  const [floors, setFloors] = useState<any[]>([]);
  const [selectedFloorId, setSelectedFloorId] = useState<number | null>(null);
  const [isAddFloorOpen, setIsAddFloorOpen] = useState(false);
  const [floorForm, setFloorForm] = useState({ floor_number: '', floor_name: '' });

  // Node Edit states
  const [isEditNodeOpen, setIsEditNodeOpen] = useState(false);
  const [selectedNodeForEdit, setSelectedNodeForEdit] = useState<EdgeDevice | null>(null);
  const [editNodeForm, setEditNodeForm] = useState({ name: '', device_code: '', ip_address: '', port: 5000, floor_id: 'unassigned' });

  // Modals
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isZtpOpen, setIsZtpOpen] = useState(false);
  const [isAddCamOpen, setIsAddCamOpen] = useState(false);
  const [selectedNodeForCam, setSelectedNodeForCam] = useState<EdgeDevice | null>(null);
  const [isAddZoneOpen, setIsAddZoneOpen] = useState(false);
  const [selectedDeviceForCustomZone, setSelectedDeviceForCustomZone] = useState<string | null>(null);
  const [customZoneForm, setCustomZoneForm] = useState({ name: '', type: 'work' });
  const [isEditCamOpen, setIsEditCamOpen] = useState(false);
  const [selectedCamForEdit, setSelectedCamForEdit] = useState<ChildCamera | null>(null);
  const [editCamForm, setEditCamForm] = useState({ name: '', cam_id: '', rtsp_url: '', ip_address: '', model: '', camera_mode: 'MIXED' as 'IN' | 'OUT' | 'MIXED' });

  // Zone Groups dialog
  const [isZoneGroupOpen, setIsZoneGroupOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<{ name: string; type: string; originalName?: string; originalType?: string; originalCams?: string[] } | null>(null);
  const [selectedCamsForGroup, setSelectedCamsForGroup] = useState<Set<string>>(new Set());

  // Forms
  const [nodeForm, setNodeForm] = useState({ name: '', device_code: '', ip_address: '', port: 5000 });
  const [nodeNameSpaceError, setNodeNameSpaceError] = useState(false);
  const [editNodeNameSpaceError, setEditNodeNameSpaceError] = useState(false);
  const [camForm, setCamForm] = useState({ name: '', cam_id: '', rtsp_url: '', ip_address: '', model: 'IP Camera', camera_mode: 'MIXED' as 'IN' | 'OUT' | 'MIXED' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditNodeChanged = selectedNodeForEdit ? (
    editNodeForm.name !== (selectedNodeForEdit.name || '') ||
    editNodeForm.device_code !== (selectedNodeForEdit.device_code || '') ||
    editNodeForm.ip_address !== (selectedNodeForEdit.ip_address || '') ||
    editNodeForm.port !== (selectedNodeForEdit.port || 5000) ||
    editNodeForm.floor_id !== (selectedNodeForEdit.floor_id != null ? String(selectedNodeForEdit.floor_id) : 'unassigned')
  ) : false;

  const isEditCamChanged = selectedCamForEdit ? (
    editCamForm.name !== (selectedCamForEdit.name || '') ||
    editCamForm.cam_id !== (selectedCamForEdit.cam_id || '') ||
    editCamForm.rtsp_url !== (selectedCamForEdit.rtsp_url || '') ||
    editCamForm.ip_address !== (selectedCamForEdit.ip_address || '') ||
    editCamForm.model !== (selectedCamForEdit.model || 'IP Camera') ||
    editCamForm.camera_mode !== (selectedCamForEdit.camera_mode || 'MIXED')
  ) : false;

  const isZoneGroupChanged = editingGroup?.originalName ? (
    editingGroup.name !== editingGroup.originalName ||
    editingGroup.type !== editingGroup.originalType ||
    selectedCamsForGroup.size !== (editingGroup.originalCams?.length || 0) ||
    ![...selectedCamsForGroup].every(id => editingGroup.originalCams?.includes(id))
  ) : true;

  const isFloorFormFilled = floorForm.floor_number.trim() !== '' || floorForm.floor_name.trim() !== '';
  const isNodeFormFilled = nodeForm.name.trim() !== '' || nodeForm.device_code.trim() !== '' || nodeForm.ip_address.trim() !== '';
  const isCamFormFilled = camForm.name.trim() !== '' || camForm.cam_id.trim() !== '' || camForm.rtsp_url.trim() !== '';

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive?: boolean;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const confirmAction = (title: string, message: string, onConfirm: () => void, isDestructive = true) => {
    setConfirmDialog({
      isOpen: true,
      title,
      message,
      onConfirm: () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        onConfirm();
      },
      isDestructive
    });
  };

  const fetchHierarchy = useCallback(async () => {
    if (!isAuthenticated) return;
    console.log('[DeviceManagement] fetchHierarchy scopeHeaders:', scopeHeaders);
    setIsLoading(true);
    try {
      const [deviceRes, floorRes] = await Promise.all([
        apiRequest<{ success: boolean; data: EdgeDevice[] }>('/devices/edge-devices', { accessToken, scopeHeaders, noCache: true }),
        apiRequest<{ success: boolean; data: any[] }>('/devices/floors', { accessToken, scopeHeaders, noCache: true })
      ]);
      setEdgeDevices(deviceRes.data || []);
      const floorData = floorRes.data || [];
      setFloors(floorData);
      
      if (floorData.length > 0) {
        setSelectedFloorId(prev => {
          if (prev !== null && floorData.some((f: any) => f.pk_floor_id === prev)) {
            return prev;
          }
          return floorData[0].pk_floor_id;
        });
      } else {
        setSelectedFloorId(null);
      }
    } catch (error) {
      toast.error('Failed to sync device hierarchy');
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, scopeHeaders, isAuthenticated]);

  // Fetch on mount + auto-refresh every 30 s so offline status updates without manual Sync
  useEffect(() => {
    fetchHierarchy();
    const interval = setInterval(fetchHierarchy, 30_000);
    return () => clearInterval(interval);
  }, [fetchHierarchy]);

  const handleAddFloor = async () => {
    if (!floorForm.floor_number) return toast.error('Floor number is required');
    console.log('[DeviceManagement] handleAddFloor scopeHeaders:', scopeHeaders);
    setIsSubmitting(true);
    try {
      await apiRequest('/devices/floors', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          floor_number: parseInt(floorForm.floor_number, 10),
          floor_name: floorForm.floor_name || `Floor ${floorForm.floor_number}`
        })
      });
      toast.success('Floor created');
      setIsAddFloorOpen(false);
      setFloorForm({ floor_number: '', floor_name: '' });
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to create floor');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddNode = async () => {
    if (!nodeForm.name || !nodeForm.device_code || !nodeForm.ip_address) return toast.error('Please fill all required fields');
    if (validateNodeField('name', nodeForm.name) || validateNodeField('device_code', nodeForm.device_code)) return toast.error('Please fix validation errors');
    if (!selectedFloorId) return toast.error('Please select a floor first');
    setIsSubmitting(true);
    try {
      await apiRequest('/devices/nug-boxes', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({ ...nodeForm, floorId: selectedFloorId })
      });
      toast.success('Edge Node registered!');
      setIsAddNodeOpen(false);
      setNodeForm({ name: '', device_code: '', ip_address: '', port: 5000 });
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to add node');
    } finally {
      setIsSubmitting(false);
    }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDeleteFloor = async () => {
    if (!selectedFloorId) return;
    setConfirmConfig({
      title: 'Delete this floor?',
      description: 'This will remove the floor definition and unassign associated nodes.',
      confirmText: 'Delete Floor',
      onConfirm: async () => {
        try {
          await apiRequest(`/devices/floors/${selectedFloorId}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Floor deleted');
          fetchHierarchy();
        } catch (e: any) {
          toast.error(e?.message || 'Failed to delete floor');
        }
      },
    });
  };

  const handleOpenEditNode = (node: EdgeDevice) => {
    setSelectedNodeForEdit(node);
    setEditNodeForm({
      name: node.name || '',
      device_code: node.device_code || '',
      ip_address: node.ip_address || '',
      port: node.port || 5000,
      floor_id: node.floor_id ? String(node.floor_id) : 'unassigned'
    });
    setIsEditNodeOpen(true);
  };

  const handleEditNode = async () => {
    if (!selectedNodeForEdit || !editNodeForm.name || !editNodeForm.ip_address) return toast.error('Name and IP address are required');
    if (validateNodeField('name', editNodeForm.name)) return toast.error('Please fix validation errors');
    setIsSubmitting(true);
    try {
      await apiRequest(`/device-management/devices/${encodeURIComponent(selectedNodeForEdit.device_code)}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({
          name: editNodeForm.name,
          ip_address: editNodeForm.ip_address,
          device_config: { port: editNodeForm.port },
          floor_id: editNodeForm.floor_id === 'unassigned' ? null : parseInt(editNodeForm.floor_id, 10)
        })
      });
      toast.success('Edge Node updated');
      setIsEditNodeOpen(false);
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update edge node');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAssignNodeToFloor = async (deviceCode: string, floorVal: string) => {
    try {
      const parsedFloorId = floorVal === 'unassigned' ? null : parseInt(floorVal, 10);
      await apiRequest(`/device-management/devices/${encodeURIComponent(deviceCode)}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ floor_id: parsedFloorId })
      });
      toast.success(parsedFloorId ? 'Node assigned to floor' : 'Node unassigned');
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update node floor');
    }
  };

  const handleAddCamera = async () => {
    if (!selectedNodeForCam || !camForm.name || !camForm.cam_id) return toast.error('Name and ID are required');
    setIsSubmitting(true);
    try {
      await apiRequest('/devices/cameras', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({ ...camForm, parent_device_pk: selectedNodeForCam.pk_device_id })
      });
      toast.success('Camera attached');
      setIsAddCamOpen(false);
      setCamForm({ name: '', cam_id: '', rtsp_url: '', ip_address: '', model: 'IP Camera', camera_mode: 'MIXED' });
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to attach camera');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteNode = async (deviceCode: string) => {
    setConfirmConfig({
      title: 'Decommission this Edge Node?',
      description: 'This will also disconnect all associated cameras from the system.',
      confirmText: 'Decommission Node',
      onConfirm: async () => {
        try {
          await apiRequest(`/devices/edge-devices/${encodeURIComponent(deviceCode)}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Node removed');
          fetchHierarchy();
        } catch (e: any) { toast.error(e?.message || 'Delete failed'); }
      },
    });
  };

  // Devices with no floor assigned (floor_id null) only surface in the UI via
  // the synthetic 'UNASSIGNED' tab — floor_id is never literally that string,
  // so every floor-scoped filter must special-case it the same way
  // `filteredDevices` below does, or their zone groups silently disappear.
  const isOnSelectedFloor = (floorId: number | null | undefined) =>
    selectedFloorId === 'UNASSIGNED' ? (floorId === null || floorId === undefined) : floorId === selectedFloorId;

  const getCustomZones = useCallback(() => {
    const zonesMap = new Map<string, { zone_type: string; zone_label: string }>();
    const floorNodes = edgeDevices.filter(node => isOnSelectedFloor(node.floor_id));
    floorNodes.forEach(d => {
      if (d.zone_label && d.zone_type && d.zone_type !== 'unassigned') {
        const key = `${d.zone_type}:${d.zone_label}`;
        zonesMap.set(key, { zone_type: d.zone_type, zone_label: d.zone_label });
      }
      (d.cameras || []).forEach(c => {
        if (c.zone_label && c.zone_type && c.zone_type !== 'unassigned') {
          const key = `${c.zone_type}:${c.zone_label}`;
          zonesMap.set(key, { zone_type: c.zone_type, zone_label: c.zone_label });
        }
      });
    });
    return Array.from(zonesMap.values());
  }, [edgeDevices, selectedFloorId]);

  // Returns all cameras (and edge nodes with cameras) as flat list for the zone group dialog
  const getAllCameras = useCallback(() => {
    const list: Array<{ id: string; name: string; nodeName: string; zone_label?: string | null; zone_type?: string }> = [];
    const floorNodes = edgeDevices.filter(node => isOnSelectedFloor(node.floor_id));
    floorNodes.forEach(node => {
      (node.cameras || []).forEach(cam => {
        list.push({ id: cam.cam_id, name: cam.name, nodeName: node.name, zone_label: cam.zone_label, zone_type: cam.zone_type });
      });
    });
    return list;
  }, [edgeDevices, selectedFloorId]);

  // Returns current zone groups: name → { type, cameras[] }
  const getZoneGroups = useCallback(() => {
    const groups = new Map<string, { type: string; cameras: Array<{ id: string; name: string; nodeName: string }> }>();
    const seenCamIds = new Set<string>();
    const floorNodes = edgeDevices.filter(node => isOnSelectedFloor(node.floor_id));
    floorNodes.forEach(node => {
      if (node.zone_label && node.zone_label.trim()) {
        const key = node.zone_label.trim();
        if (!groups.has(key)) groups.set(key, { type: node.zone_type || 'other', cameras: [] });
      }
      (node.cameras || []).forEach(cam => {
        if (cam.zone_label && cam.zone_label.trim() && !seenCamIds.has(cam.cam_id)) {
          seenCamIds.add(cam.cam_id);
          const key = cam.zone_label.trim();
          if (!groups.has(key)) groups.set(key, { type: cam.zone_type || 'other', cameras: [] });
          groups.get(key)!.cameras.push({ id: cam.cam_id, name: cam.name, nodeName: node.name });
        }
      });
    });
    return Array.from(groups.entries()).map(([name, val]) => ({ name, ...val }));
  }, [edgeDevices, selectedFloorId]);

  const openNewZoneGroup = () => {
    setEditingGroup({ name: '', type: 'work' });
    setSelectedCamsForGroup(new Set());
    setIsZoneGroupOpen(true);
  };

  const openEditZoneGroup = (groupName: string, groupType: string, cameraIds: string[]) => {
    setEditingGroup({ name: groupName, type: groupType, originalName: groupName, originalType: groupType, originalCams: [...cameraIds] });
    setSelectedCamsForGroup(new Set(cameraIds));
    setIsZoneGroupOpen(true);
  };

  const saveZoneGroup = async () => {
    if (!editingGroup || !editingGroup.name.trim()) { toast.error('Group name is required'); return; }
    setIsSubmitting(true);
    try {
      const allCams = getAllCameras();
      const newLabel = editingGroup.name.trim();
      const newType = editingGroup.type;
      const oldLabel = editingGroup.originalName;

      const ops: Promise<void>[] = [];

      // Update each camera silently
      allCams.forEach(cam => {
        const shouldBeInGroup = selectedCamsForGroup.has(cam.id);
        const isCurrentlyInGroup = cam.zone_label === newLabel || (oldLabel && cam.zone_label === oldLabel);

        if (shouldBeInGroup && (!isCurrentlyInGroup || cam.zone_label !== newLabel || cam.zone_type !== newType)) {
          ops.push(handleSetZone(cam.id, `${newType}:${newLabel}`, true));
        } else if (!shouldBeInGroup && isCurrentlyInGroup) {
          ops.push(handleSetZone(cam.id, 'unassigned', true));
        }
      });

      // Also set the same zone on parent edge nodes that have ANY cameras in this group,
      // because attendance_ping.device_code stores the edge node's code, not the camera cam_id.
      // This ensures live ping activity is grouped correctly in Zone Activity.
      edgeDevices.forEach(node => {
        const nodeCams = (node.cameras || []);
        if (nodeCams.length === 0) return;
        const anyInGroup = nodeCams.some(c => selectedCamsForGroup.has(c.cam_id));
        const wasInGroup = node.zone_label === newLabel || (oldLabel && node.zone_label === oldLabel);

        if (anyInGroup && (!wasInGroup || node.zone_label !== newLabel || node.zone_type !== newType)) {
          ops.push(handleSetZone(node.device_code, `${newType}:${newLabel}`, true));
        } else if (!anyInGroup && wasInGroup) {
          ops.push(handleSetZone(node.device_code, 'unassigned', true));
        }
      });

      await Promise.all(ops);
      setIsZoneGroupOpen(false);
      setEditingGroup(null);
      toast.success(
        oldLabel ? `Zone group "${newLabel}" updated — refresh Zone Activity to see changes` : `Zone group "${newLabel}" created — refresh Zone Activity to see changes`,
        { duration: 5000 }
      );
    } catch {
      toast.error('Failed to save zone group');
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteZoneGroup = async (groupName: string) => {
    setConfirmConfig({
      title: `Remove zone group "${groupName}"?`,
      description: 'Cameras in this group will become unassigned.',
      confirmText: 'Remove Zone Group',
      onConfirm: async () => {
        setIsSubmitting(true);
        try {
          const cams = getAllCameras().filter(c => c.zone_label === groupName);
          const nodeIds = edgeDevices.filter(n => n.zone_label === groupName).map(n => n.device_code);
          await Promise.all([
            ...cams.map(c => handleSetZone(c.id, 'unassigned', true)),
            ...nodeIds.map(id => handleSetZone(id, 'unassigned', true)),
          ]);
          toast.success(`Zone group "${groupName}" removed — refresh Zone Activity to see changes`, { duration: 5000 });
        } catch {
          toast.error('Failed to remove zone group');
        } finally {
          setIsSubmitting(false);
        }
      },
    });
  };

  const handleSetZone = async (deviceCode: string, zoneValue: string, silent = false) => {
    let zone_type: string;
    let zone_label: string | null = null;
    if (zoneValue.includes(':')) {
      const parts = zoneValue.split(':');
      zone_type = parts[0];
      zone_label = parts.slice(1).join(':');
    } else {
      zone_type = zoneValue;
    }

    const zt = zone_type as EdgeDevice['zone_type'];
    setEdgeDevices(prev => prev.map(d => {
      const isMatch = d.device_code === deviceCode;
      const updatedCameras = (d.cameras || []).map(c =>
        c.cam_id === deviceCode ? { ...c, zone_type: zt, zone_label } : c
      );
      return {
        ...d,
        zone_type: isMatch ? zt : d.zone_type,
        zone_label: isMatch ? zone_label : d.zone_label,
        cameras: updatedCameras,
      };
    }));

    try {
      await apiRequest(`/device-management/devices/${encodeURIComponent(deviceCode)}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ zone_type, zone_label }),
      });
      if (!silent) toast.success('Location updated');
    } catch (e: any) {
      if (!silent) toast.error(e?.message || 'Failed to update location');
      fetchHierarchy(); // revert to server truth on failure
    }
  };

  const onZoneChange = (deviceCode: string, val: string) => {
    if (val === 'ADD_CUSTOM_ZONE') {
      setSelectedDeviceForCustomZone(deviceCode);
      setIsAddZoneOpen(true);
    } else {
      handleSetZone(deviceCode, val);
    }
  };

  const handleSetCameraMode = async (camId: string, mode: 'IN' | 'OUT' | 'MIXED') => {
    setEdgeDevices(prev => prev.map(d => ({
      ...d,
      cameras: (d.cameras || []).map(c => c.cam_id === camId ? { ...c, camera_mode: mode } : c),
    })));
    try {
      await apiRequest(`/devices/cameras/${encodeURIComponent(camId)}/camera-mode`, {
        method: 'PATCH', accessToken, scopeHeaders,
        body: JSON.stringify({ camera_mode: mode }),
      });
      toast.success('Camera mode updated');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update camera mode');
      fetchHierarchy();
    }
  };

  const handleDeleteCamera = async (id: string) => {
    setConfirmConfig({
      title: 'Detach this camera?',
      description: 'The camera will be disconnected from this node.',
      confirmText: 'Detach Camera',
      onConfirm: async () => {
        try {
          await apiRequest(`/devices/cameras/${id}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Camera detached');
          fetchHierarchy();
        } catch (e) { toast.error('Detach failed'); }
      },
    });
  };

  const handleOpenEditCam = (cam: ChildCamera) => {
    setSelectedCamForEdit(cam);
    setEditCamForm({
      name: cam.name || '',
      cam_id: cam.cam_id || '',
      rtsp_url: cam.rtsp_url || '',
      ip_address: cam.ip_address || '',
      model: cam.model || 'IP Camera',
      camera_mode: cam.camera_mode || 'MIXED',
    });
    setIsEditCamOpen(true);
  };

  const handleEditCamera = async () => {
    if (!selectedCamForEdit || !editCamForm.name || !editCamForm.cam_id) return toast.error('Name and ID are required');
    setIsSubmitting(true);
    try {
      await apiRequest(`/devices/cameras/${selectedCamForEdit.id}`, {
        method: 'PUT',
        accessToken,
        scopeHeaders,
        body: JSON.stringify(editCamForm)
      });
      toast.success('Camera updated');
      setIsEditCamOpen(false);
      fetchHierarchy();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update camera');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCaptureFrame = async (cam: ChildCamera) => {
    toast.info(`Capturing frame from ${cam.name}…`);
    try {
      const res = await apiRequest<{ success: boolean; image?: string; message?: string }>(
        `/devices/cameras/${cam.id}/capture-frame`,
        { method: 'POST', accessToken, scopeHeaders }
      );
      if (res.success && res.image) {
        const img = new Image();
        img.src = res.image;
        const win = window.open('', '_blank');
        if (win) {
          win.document.title = cam.name;
          win.document.body.style.cssText = 'margin:0;background:#000';
          img.style.cssText = 'width:100%;height:100vh;object-fit:contain';
          win.document.body.appendChild(img);
        }
      } else {
        toast.warning(res.message ?? 'Frame not available — Edge Node may be offline');
      }
    } catch {
      toast.error('Frame capture failed — Edge Node unreachable');
    }
  };

  const unassignedCount = useMemo(() => {
    return edgeDevices.filter(node => node.floor_id === null || node.floor_id === undefined).length;
  }, [edgeDevices]);

  const filteredDevices = useMemo(() => {
    if (selectedFloorId === 'UNASSIGNED') {
      return edgeDevices.filter(node => node.floor_id === null || node.floor_id === undefined);
    }
    return edgeDevices.filter(node => node.floor_id === selectedFloorId);
  }, [edgeDevices, selectedFloorId]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <PageHeader
        title="Edge AI Command Center"
        icon={Server}
        subtitle="Hierarchical management of Jetson AI Nodes and connected IP Cameras"
        actions={
          <>
            <Button variant="outline" onClick={fetchHierarchy} disabled={isLoading} className="rounded-xl border-2 hover:bg-slate-50 transition-all gap-2">
              <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
              <span className="font-bold">Sync Fleet</span>
            </Button>

            <Button
              onClick={() => setIsZtpOpen(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-lg shadow-emerald-500/20 font-bold transition-all hover:scale-105 active:scale-95"
            >
              <Plus className="w-4 h-4 mr-2" />
              ZTP Device Activation
            </Button>
          </>
        }
      />

      {isLoading && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      {!globalSiteId && sites && sites.length > 0 && (
        <Card className={cn('p-3 border rounded-xl flex flex-row items-center justify-between gap-4 shadow-sm bg-slate-50 dark:bg-slate-900/50', lightTheme.border.default)}>
          <div className="flex flex-row items-center gap-2">
            <Server className="w-4 h-4 text-blue-600 shrink-0" />
            <span className={cn('text-xs font-bold shrink-0', lightTheme.text.primary)}>Campus / Site:</span>
            <select
              value={localSiteId}
              onChange={(e) => setLocalSiteId(e.target.value)}
              className={cn(
                'h-8 rounded-lg border bg-white dark:bg-slate-900 px-2.5 text-xs font-bold cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                lightTheme.border.default, lightTheme.text.secondary
              )}
            >
              {sites.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <span className={cn('text-[10px] hidden sm:inline-block', lightTheme.text.muted)}>
            Select site to view floors & edge boxes
          </span>
        </Card>
      )}

      {/* ── Device Hierarchy Flow ── */}
      {(() => {
        const selectedFloor = floors.find((f: any) => f.pk_floor_id === selectedFloorId);
        const floorNodes = edgeDevices.filter(node => isOnSelectedFloor(node.floor_id));
        const totalCameras = floorNodes.reduce((acc, node) => acc + (node.cameras?.length || 0), 0);
        const zoneGroups = getZoneGroups();

        // Color helpers
        const nodeOnline = floorNodes.filter(n => (liveStatuses[n.device_code]?.status || n.status) === 'online').length;
        const camOnline = floorNodes.reduce((acc, node) => acc + (node.cameras || []).filter((c: any) => (liveStatuses[c.cam_id]?.status || c.status) === 'online').length, 0);

        return (
          <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl overflow-hidden bg-white dark:bg-card">
            <CardHeader className="pb-4 border-b border-slate-100 dark:border-slate-800 px-5 pt-4">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <p className="text-sm font-bold text-slate-800 dark:text-white">Device Hierarchy Flow</p>
                  <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                    {activeSite?.name ?? 'Site'} · {selectedFloor?.floor_name ?? 'Select a floor'} · Live counts
                  </p>
                </div>
                <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl px-2.5 py-1.5">
                  <Network className="w-3.5 h-3.5 text-indigo-500" />
                  <span className="text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">Live</span>
                </div>
              </div>

              {/* ── Large Flow Path Strip ── */}
              <div className="flex items-center gap-0 flex-wrap">
                {[
                  {
                    icon: <Building2 className="w-5 h-5" />,
                    label: 'Site',
                    value: activeSite?.name ?? '—',
                    bg: 'bg-violet-50 dark:bg-violet-950/40',
                    border: 'border-violet-200 dark:border-violet-800/60',
                    iconColor: 'text-violet-600 dark:text-violet-400',
                    valueColor: 'text-violet-700 dark:text-violet-300',
                    labelColor: 'text-violet-400 dark:text-violet-500',
                  },
                  {
                    icon: <Layers className="w-5 h-5" />,
                    label: 'Floor',
                    value: selectedFloor?.floor_name ?? '—',
                    bg: 'bg-blue-50 dark:bg-blue-950/40',
                    border: 'border-blue-200 dark:border-blue-800/60',
                    iconColor: 'text-blue-600 dark:text-blue-400',
                    valueColor: 'text-blue-700 dark:text-blue-300',
                    labelColor: 'text-blue-400 dark:text-blue-500',
                  },
                  {
                    icon: <Cpu className="w-5 h-5" />,
                    label: 'Edge Nodes',
                    value: String(floorNodes.length),
                    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
                    border: 'border-emerald-200 dark:border-emerald-800/60',
                    iconColor: 'text-emerald-600 dark:text-emerald-400',
                    valueColor: 'text-emerald-700 dark:text-emerald-300',
                    labelColor: 'text-emerald-400 dark:text-emerald-500',
                  },
                  {
                    icon: <Camera className="w-5 h-5" />,
                    label: 'Cameras',
                    value: String(totalCameras),
                    bg: 'bg-sky-50 dark:bg-sky-950/40',
                    border: 'border-sky-200 dark:border-sky-800/60',
                    iconColor: 'text-sky-600 dark:text-sky-400',
                    valueColor: 'text-sky-700 dark:text-sky-300',
                    labelColor: 'text-sky-400 dark:text-sky-500',
                  },
                  {
                    icon: <Database className="w-5 h-5" />,
                    label: 'Zone Groups',
                    value: String(zoneGroups.length),
                    bg: 'bg-amber-50 dark:bg-amber-950/40',
                    border: 'border-amber-200 dark:border-amber-800/60',
                    iconColor: 'text-amber-600 dark:text-amber-400',
                    valueColor: 'text-amber-700 dark:text-amber-300',
                    labelColor: 'text-amber-400 dark:text-amber-500',
                  },
                ].map((item, i, arr) => (
                  <React.Fragment key={item.label}>
                    <div className={cn(
                      'flex items-center gap-2.5 px-4 py-3 rounded-2xl border',
                      item.bg, item.border
                    )}>
                      <span className={item.iconColor}>{item.icon}</span>
                      <div className="flex flex-col leading-none">
                        <span className={cn('text-[10px] font-bold uppercase tracking-widest', item.labelColor)}>{item.label}</span>
                        <span className={cn('text-base font-black mt-1', item.valueColor)}>{item.value}</span>
                      </div>
                    </div>
                    {i < arr.length - 1 && (
                      <span className="text-2xl font-black text-slate-300 dark:text-slate-600 px-2 select-none">›</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-50 dark:divide-slate-800/60">

                {/* Site */}
                <div className="flex justify-between items-center px-5 py-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Site</p>
                      <p className="text-[10px] text-slate-400 font-medium">{activeSite?.name ?? '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                    <span className="text-xs font-black text-violet-600 dark:text-violet-400">{floors.length} floors</span>
                  </div>
                </div>

                {/* Floor */}
                <div className="flex justify-between items-center px-5 py-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                      <Layers className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Floor</p>
                      <p className="text-[10px] text-slate-400 font-medium">{selectedFloor?.floor_name ?? 'None selected'}</p>
                    </div>
                  </div>
                  <span className="text-xs font-black text-blue-600 dark:text-blue-400">{floors.length} total</span>
                </div>

                {/* Edge Nodes */}
                <div className="flex justify-between items-center px-5 py-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                      <Cpu className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Edge Nodes</p>
                      <p className="text-[10px] text-slate-400 font-medium">
                        {nodeOnline} online · {floorNodes.length - nodeOnline} offline
                      </p>
                    </div>
                  </div>
                  <span className={cn(
                    "text-xs font-black",
                    floorNodes.length === 0 ? "text-slate-400" :
                    nodeOnline === floorNodes.length ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                  )}>{floorNodes.length}</span>
                </div>

                {/* Cameras */}
                <div className="flex justify-between items-center px-5 py-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-sky-50 dark:bg-sky-950/30 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                      <Camera className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Cameras</p>
                      <p className="text-[10px] text-slate-400 font-medium">
                        {camOnline} online · {totalCameras - camOnline} offline
                      </p>
                    </div>
                  </div>
                  <span className={cn(
                    "text-xs font-black",
                    totalCameras === 0 ? "text-slate-400" :
                    camOnline === totalCameras ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                  )}>{totalCameras}</span>
                </div>

                {/* Zone Groups */}
                <div className="flex justify-between items-center px-5 py-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                      <Database className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Zone Groups</p>
                      <p className="text-[10px] text-slate-400 font-medium">
                        {zoneGroups.length > 0
                          ? zoneGroups.map(z => z.name).join(', ')
                          : 'No zones configured'}
                      </p>
                    </div>
                  </div>
                  <span className={cn(
                    "text-xs font-black",
                    zoneGroups.length === 0 ? "text-slate-400" : "text-amber-600 dark:text-amber-400"
                  )}>{zoneGroups.length}</span>
                </div>

              </div>

              {/* Flow path indicator */}
              <div className="px-5 py-3 bg-gradient-to-r from-slate-50 to-transparent dark:from-slate-800/30 border-t border-slate-50 dark:border-slate-800/60">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { label: activeSite?.name ?? 'Site', color: 'text-violet-600 dark:text-violet-400' },
                    { label: selectedFloor?.floor_name ?? 'Floor', color: 'text-blue-600 dark:text-blue-400' },
                    { label: `${floorNodes.length} Edges`, color: 'text-emerald-600 dark:text-emerald-400' },
                    { label: `${totalCameras} Cams`, color: 'text-sky-600 dark:text-sky-400' },
                    { label: `${zoneGroups.length} Zones`, color: 'text-amber-600 dark:text-amber-400' },
                  ].map((item, i, arr) => (
                    <React.Fragment key={item.label}>
                      <span className={cn("text-[10px] font-black", item.color)}>{item.label}</span>
                      {i < arr.length - 1 && (
                        <span className="text-[10px] text-slate-300 dark:text-slate-600 font-bold">›</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* ── Floor Selector Tabs ── */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          {floors.map(f => {
            const isSelected = selectedFloorId === f.pk_floor_id;
            return (
              <button
                key={f.pk_floor_id}
                onClick={() => setSelectedFloorId(f.pk_floor_id)}
                className={cn(
                  "px-4 py-2 text-sm font-bold rounded-xl transition-all border flex items-center gap-2",
                  isSelected
                    ? "bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20"
                    : "bg-white hover:bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
                )}
              >
                <span>🏢 {f.floor_name}</span>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full",
                  isSelected ? "bg-white/20 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500"
                )}>
                  {f.device_count || 0} Dev / {f.camera_count || 0} Cam
                </span>
                {isSelected && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFloor();
                    }}
                    className="p-1 hover:bg-white/20 rounded-lg text-white/80 hover:text-white transition-colors cursor-pointer"
                    title="Delete Floor"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </span>
                )}
              </button>
            );
          })}
          {unassignedCount > 0 && (
            <button
              onClick={() => setSelectedFloorId('UNASSIGNED')}
              className={cn(
                "px-4 py-2 text-sm font-bold rounded-xl transition-all border flex items-center gap-2",
                selectedFloorId === 'UNASSIGNED'
                  ? "bg-amber-600 text-white border-amber-600 shadow-md shadow-amber-500/20"
                  : "bg-amber-50 hover:bg-amber-100/80 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300"
              )}
            >
              <span>⚡ Unassigned Nodes</span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-extrabold",
                selectedFloorId === 'UNASSIGNED' ? "bg-white/20 text-white" : "bg-amber-200/80 dark:bg-amber-900/80 text-amber-900 dark:text-amber-100"
              )}>
                {unassignedCount} Node{unassignedCount > 1 ? 's' : ''}
              </span>
            </button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAddFloorOpen(true)}
            className="rounded-xl border-dashed border-2 hover:bg-slate-50 transition-all font-bold gap-1 text-xs h-9 px-3"
          >
            <Plus className="w-3.5 h-3.5" /> Add Floor
          </Button>
        </div>
      </div>

      {floors.length === 0 && filteredDevices.length === 0 ? (
        <div className={cn("flex flex-col items-center justify-center py-20 border-2 border-dashed dark:border-slate-700 rounded-3xl text-center gap-4", lightTheme.border.default)}>
          <div className={cn("p-5 rounded-3xl", lightTheme.table.header)}>
            <Layers className={cn("w-10 h-10 text-slate-400")} />
          </div>
          <div>
            <h3 className={cn("text-lg font-black", lightTheme.text.primary)}>No Floors Created Yet</h3>
            <p className={cn("text-sm font-medium mt-1 max-w-sm", lightTheme.text.muted)}>
              To configure edge devices, you must first create a Floor for this Site.
            </p>
          </div>
          <Button onClick={() => setIsAddFloorOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold">
            <Plus className="w-4 h-4 mr-2" />
            Create First Floor
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Area: Devices on this Floor (8/12 width) */}
          <div className="lg:col-span-8 space-y-6">
            {unassignedCount > 0 && selectedFloorId !== 'UNASSIGNED' && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200 dark:bg-amber-950/40 dark:border-amber-800 text-amber-900 dark:text-amber-200">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-amber-100 dark:bg-amber-900/60 shrink-0">
                    <Server className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="text-xs font-bold">
                      {unassignedCount} ZTP-Activated Edge Node{unassignedCount > 1 ? 's are' : ' is'} currently unassigned to any floor.
                    </p>
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                      Switch to the Unassigned Nodes tab or select a floor in the node dropdown to place them.
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => setSelectedFloorId('UNASSIGNED')}
                  className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold px-3 shrink-0"
                >
                  View Unassigned ({unassignedCount})
                </Button>
              </div>
            )}

            <div className="flex justify-between items-center px-1">
              <h3 className={cn("text-lg font-bold", lightTheme.text.primary)}>
                {selectedFloorId === 'UNASSIGNED' ? '⚡ Unassigned ZTP Edge Nodes' : 'AI Edge Nodes'} ({filteredDevices.length})
              </h3>
              <Button size="sm" onClick={() => setIsAddNodeOpen(true)} className="rounded-xl gap-1.5 text-xs font-bold bg-blue-600 text-white">
                <Plus className="w-3.5 h-3.5" /> Register Edge Node
              </Button>
            </div>

            {!isLoading && filteredDevices.length === 0 && (
              <div className={cn("flex flex-col items-center justify-center py-16 border-2 border-dashed dark:border-slate-700 rounded-3xl text-center gap-4", lightTheme.border.default)}>
                <div className={cn("p-4 rounded-2xl", lightTheme.table.header)}>
                  <WifiOff className={cn("w-8 h-8", lightTheme.text.muted)} />
                </div>
                <div>
                  <h4 className={cn("text-sm font-bold", lightTheme.text.primary)}>No Nodes on this Floor</h4>
                  <p className={cn("text-xs mt-1 max-w-xs", lightTheme.text.muted)}>
                    Register a new Edge Node manually or set the floor of an existing node.
                  </p>
                </div>
                <Button size="sm" onClick={() => setIsAddNodeOpen(true)} className="bg-blue-600 text-white rounded-xl">
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Node
                </Button>
              </div>
            )}

            <div className="grid grid-cols-1 gap-6">
              {filteredDevices.map((node) => (
                <Card key={node.device_code} className={cn("border-2 dark:border-slate-800 rounded-3xl overflow-hidden shadow-sm hover:shadow-md transition-all duration-300", lightTheme.border.default)}>
                  <CardHeader className={cn("dark:bg-slate-900/50 border-b dark:border-slate-800 p-6", lightTheme.table.header, lightTheme.border.default)}>
                    <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 w-full">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full xl:w-auto flex-1 min-w-[250px]">
                        <div className="p-3 bg-blue-600 rounded-2xl shadow-lg shadow-blue-500/30 shrink-0">
                          <Server className="w-6 h-6 text-white" />
                        </div>
                        <div className="min-w-0 overflow-hidden">
                          <h3 className={cn("text-xl font-black leading-tight truncate", lightTheme.text.primary)} title={node.name}>{node.name}</h3>
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            <code className={cn("text-xs px-2 py-0.5 rounded-md font-bold truncate max-w-[200px]", lightTheme.table.header)} title={node.device_code}>
                              {node.device_code}
                            </code>
                            <span className={cn("text-xs font-medium", lightTheme.text.muted)}>{node.ip_address}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <select
                          value={node.floor_id ?? 'unassigned'}
                          onChange={(e) => handleAssignNodeToFloor(node.device_code, e.target.value)}
                          title="Floor assignment for this Edge Node"
                          className={cn(
                            "h-8 rounded-lg border bg-white dark:bg-slate-900 px-2 text-xs font-bold cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30",
                            lightTheme.border.default, lightTheme.text.secondary,
                          )}
                        >
                          <option value="unassigned">🏢 — Unassigned Floor</option>
                          {floors.map(f => (
                            <option key={f.pk_floor_id} value={f.pk_floor_id}>
                              🏢 {f.floor_name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={node.zone_label ? `${node.zone_type}:${node.zone_label}` : (node.zone_type || 'unassigned')}
                          onChange={(e) => onZoneChange(node.device_code, e.target.value)}
                          title="Location / zone this device monitors — drives dwell-time tracking"
                          className={cn(
                            "h-8 rounded-lg border bg-white dark:bg-slate-900 px-2 text-xs font-bold cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30",
                            lightTheme.border.default, lightTheme.text.secondary,
                          )}
                        >
                          <optgroup label="Default Categories">
                            <option value="work">🏢 Workplace</option>
                            <option value="break">☕ Cafeteria / Break</option>
                            <option value="other">📍 Other area</option>
                          </optgroup>
                          {getCustomZones().length > 0 && (
                            <optgroup label="Custom Zones">
                              {getCustomZones().map(z => {
                                const emoji = z.zone_type === 'work' ? '🏢' : z.zone_type === 'break' ? '☕' : '📍';
                                return (
                                  <option key={`${z.zone_type}:${z.zone_label}`} value={`${z.zone_type}:${z.zone_label}`}>
                                    {emoji} {z.zone_label}
                                  </option>
                                );
                              })}
                            </optgroup>
                          )}
                          <optgroup label="Actions & Defaults">
                            <option value="unassigned">— Unassigned</option>
                            <option value="ADD_CUSTOM_ZONE">➕ Add Custom Zone...</option>
                          </optgroup>
                        </select>
                        <DeviceStatusBadge status={node.status} lastHeartbeat={node.last_heartbeat} />
                        <Button
                          variant="ghost" size="icon"
                          onClick={() => handleOpenEditNode(node)}
                          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          title="Edit Node settings"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          onClick={() => handleDeleteNode(node.device_code)}
                          className="h-8 w-8 rounded-lg text-rose-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Decommission Node"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-6 space-y-6">
                    {/* Telemetry Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {/* CPU */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <Cpu className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">CPU</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.cpu_percent || 0).toFixed(1)}%
                        </div>
                      </div>
                      {/* GPU */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <Activity className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">GPU</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.gpu_percent || 0).toFixed(1)}%
                        </div>
                      </div>
                      {/* RAM */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <Database className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">RAM</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.memory_total_mb) > 0 ? Math.round((Number(node.memory_used_mb) / Number(node.memory_total_mb)) * 100) : 0}%
                        </div>
                        {Number(node.memory_total_mb) > 0 && (
                          <div className={cn("text-[10px] mt-0.5", lightTheme.text.muted)}>
                            {Math.round(Number(node.memory_used_mb) / 1024 * 10) / 10} / {Math.round(Number(node.memory_total_mb) / 1024 * 10) / 10} GB
                          </div>
                        )}
                      </div>
                      {/* Temp */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <div className="w-3 h-3 rounded-full bg-orange-500" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">TEMP</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.temperature_c || 0).toFixed(1)}°C
                        </div>
                      </div>
                      {/* Disk */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <HardDrive className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">DISK</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.disk_total_gb) > 0 ? Math.round((Number(node.disk_used_gb) / Number(node.disk_total_gb)) * 100) : 0}%
                        </div>
                        {Number(node.disk_total_gb) > 0 && (
                          <div className={cn("text-[10px] mt-0.5", lightTheme.text.muted)}>
                            {Number(node.disk_used_gb || 0).toFixed(1)} / {Number(node.disk_total_gb || 0).toFixed(1)} GB
                          </div>
                        )}
                      </div>
                      {/* Uptime */}
                      <div className={cn("dark:bg-slate-900 rounded-2xl p-3 border dark:border-slate-800", lightTheme.table.header, lightTheme.border.default)}>
                        <div className={cn("flex items-center gap-2 mb-1", lightTheme.text.muted)}>
                          <Clock className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-wider">UPTIME</span>
                        </div>
                        <div className={cn("text-lg font-black", lightTheme.text.primary)}>
                          {Number(node.uptime_seconds) > 0
                            ? Number(node.uptime_seconds) < 3600
                              ? `${Math.floor(Number(node.uptime_seconds) / 60)}m`
                              : Number(node.uptime_seconds) < 86400
                                ? `${Math.floor(Number(node.uptime_seconds) / 3600)}h`
                                : `${Math.floor(Number(node.uptime_seconds) / 86400)}d`
                            : '—'}
                        </div>
                      </div>
                    </div>

                    {/* Cameras List */}
                    <div className="space-y-3">
                      <div className="flex justify-between items-center px-1">
                        <h4 className={cn("text-xs font-black uppercase tracking-widest flex items-center gap-2", lightTheme.text.muted)}>
                          <Camera className="w-3 h-3" />
                          Attached Cameras ({node.camera_count})
                        </h4>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => { setSelectedNodeForCam(node); setIsAddCamOpen(true); }}
                          className="h-6 text-blue-600 hover:text-blue-700 font-bold text-[10px] uppercase"
                        >
                          + Attach New
                        </Button>
                      </div>
                      
                      <div className="space-y-2">
                        {node.cameras?.length > 0 ? (
                          node.cameras.map((cam) => (
                            <div key={cam.id} className={cn("group flex flex-col md:flex-row items-start md:items-center gap-3 justify-between p-3 bg-white dark:bg-slate-950 border dark:border-slate-800 rounded-2xl hover:border-blue-200 dark:hover:border-blue-900 transition-all", lightTheme.border.default)}>
                              <div className="flex items-center gap-3">
                                <div className="relative">
                                  <div className={cn(
                                    "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                                    (() => {
                                      const live = liveStatuses.get(cam.id) ?? liveStatuses.get(cam.cam_id);
                                      const s = live?.status ?? cam.status;
                                      return s === 'online' ? "bg-emerald-50 text-emerald-500" : "bg-slate-100 text-slate-400";
                                    })()
                                  )}>
                                    <Camera className="w-5 h-5" />
                                  </div>
                                  {(() => {
                                    const live = liveStatuses.get(cam.id) ?? liveStatuses.get(cam.cam_id);
                                    const isOnline = (live?.status ?? cam.status) === 'online';
                                    return (
                                      <span className={cn(
                                        "absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-white",
                                        isOnline ? "bg-emerald-400 animate-pulse" : "bg-slate-300"
                                      )} title={isOnline ? 'Online' : 'Offline'} />
                                    );
                                  })()}
                                </div>
                                <div>
                                  <div className={cn("font-bold text-sm", lightTheme.text.primary)}>{cam.name}</div>
                                  <div className={cn("text-[10px] font-medium", lightTheme.text.muted)}>
                                    {cam.cam_id} • {cam.ip_address}
                                    {(() => {
                                      const live = liveStatuses.get(cam.id) ?? liveStatuses.get(cam.cam_id);
                                      if (!live) return null;
                                      const mins = Math.round((Date.now() - live.lastSeen.getTime()) / 60000);
                                      return <span className="ml-1 text-slate-300">· seen {mins < 1 ? 'just now' : `${mins}m ago`}</span>;
                                    })()}
                                  </div>
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-1 w-full md:w-auto justify-end">
                                <select
                                  value={cam.camera_mode || 'MIXED'}
                                  onChange={(e) => handleSetCameraMode(cam.cam_id, e.target.value as 'IN' | 'OUT' | 'MIXED')}
                                  title="Camera direction — IN records check-in, OUT records check-out, MIXED uses time-based logic"
                                  className={cn(
                                    "h-7 rounded-lg border px-1.5 text-[11px] font-bold cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30",
                                    cam.camera_mode === 'IN'
                                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                      : cam.camera_mode === 'OUT'
                                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                                        : 'bg-white dark:bg-slate-900 ' + lightTheme.border.default + ' ' + lightTheme.text.secondary,
                                  )}
                                >
                                  <option value="IN">↵ Entry</option>
                                  <option value="OUT">↳ Exit</option>
                                  <option value="MIXED">⇄ Mixed</option>
                                </select>
                                <select
                                  value={cam.zone_label ? `${cam.zone_type}:${cam.zone_label}` : (cam.zone_type || 'unassigned')}
                                  onChange={(e) => onZoneChange(cam.cam_id, e.target.value)}
                                  title="Location / zone this camera monitors — drives dwell-time tracking"
                                  className={cn(
                                    "h-7 rounded-lg border bg-white dark:bg-slate-900 px-1.5 text-[11px] font-bold cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30",
                                    lightTheme.border.default, lightTheme.text.secondary,
                                  )}
                                >
                                  <optgroup label="Default Categories">
                                    <option value="work">🏢 Workplace</option>
                                    <option value="break">☕ Cafeteria / Break</option>
                                    <option value="other">📍 Other area</option>
                                  </optgroup>
                                  {getCustomZones().length > 0 && (
                                    <optgroup label="Custom Zones">
                                      {getCustomZones().map(z => {
                                        const emoji = z.zone_type === 'work' ? '🏢' : z.zone_type === 'break' ? '☕' : '📍';
                                        return (
                                          <option key={`${z.zone_type}:${z.zone_label}`} value={`${z.zone_type}:${z.zone_label}`}>
                                            {emoji} {z.zone_label}
                                          </option>
                                        );
                                      })}
                                    </optgroup>
                                  )}
                                  <optgroup label="Actions & Defaults">
                                    <option value="unassigned">— Unassigned</option>
                                    <option value="ADD_CUSTOM_ZONE">➕ Add Custom Zone...</option>
                                  </optgroup>
                                </select>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-100"
                                    onClick={() => handleOpenEditCam(cam)}
                                    title="Edit Camera Settings"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleDeleteCamera(cam.id)}
                                    className="h-8 w-8 rounded-lg text-rose-400 hover:bg-rose-50"
                                    title="Detach Camera"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className={cn("text-center py-6 border-2 border-dashed dark:border-slate-800 rounded-2xl", lightTheme.border.default)}>
                            <p className={cn("text-xs font-bold", lightTheme.text.muted)}>No cameras connected to this node</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={cn("pt-4 flex justify-between items-center text-[10px] font-bold uppercase tracking-tighter", lightTheme.text.muted)}>
                      <div className="flex items-center gap-2">
                        <Shield className="w-3 h-3" />
                        Node Secured via JWT
                      </div>
                      <div>Last Heartbeat: {node.last_heartbeat ? new Date(node.last_heartbeat).toLocaleTimeString() : 'Never'}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Right Area: Zone Groups for this Floor (4/12 width) */}
          <div className="lg:col-span-4 space-y-6">
            <h3 className={cn("text-lg font-bold px-1", lightTheme.text.primary)}>
              Floor Zone Groups
            </h3>
            {(() => {
              const groups = getZoneGroups();
              const TYPE_EMOJI: Record<string, string> = { work: '🏢', break: '☕', other: '📍' };
              const TYPE_COLOR: Record<string, string> = {
                work:  'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/20 dark:border-emerald-800 dark:text-emerald-300',
                break: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-300',
                other: 'bg-sky-50 border-sky-200 text-sky-700 dark:bg-sky-950/20 dark:border-sky-800 dark:text-sky-300',
              };
              return (
                <Card className={cn('border rounded-2xl overflow-hidden shadow-sm', lightTheme.border.default)}>
                  <div className={cn('flex items-center justify-between px-5 py-3.5 border-b', lightTheme.table.header, lightTheme.table.border)}>
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 bg-violet-100 dark:bg-violet-900/30 rounded-lg">
                        <Layers className="w-4 h-4 text-violet-600" />
                      </div>
                      <div>
                        <p className={cn('text-sm font-bold', lightTheme.text.primary)}>Zone Groups</p>
                        <p className={cn('text-[9px]', lightTheme.text.muted)}>Logical areas for this floor</p>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={openNewZoneGroup} className="gap-1.5 rounded-xl h-8 text-xs font-bold">
                      <Plus className="w-3.5 h-3.5" />
                      Add Group
                    </Button>
                  </div>
                  <CardContent className="p-4">
                    {groups.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-6 text-center">
                        <Layers className={cn('w-7 h-7 opacity-20', lightTheme.text.muted)} />
                        <p className={cn('text-xs font-semibold', lightTheme.text.muted)}>No zone groups yet</p>
                        <p className={cn('text-[10px]', lightTheme.text.muted)}>Combine cameras on this floor into one area.</p>
                        <Button size="sm" variant="outline" onClick={openNewZoneGroup} className="mt-2 gap-1.5 rounded-xl text-xs font-bold h-8">
                          <Plus className="w-3.5 h-3.5" /> Create Group
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {groups.map(group => {
                          const color = TYPE_COLOR[group.type] ?? TYPE_COLOR.other;
                          const emoji = TYPE_EMOJI[group.type] ?? '📍';
                          return (
                            <div key={group.name} className={cn('flex items-center gap-3 rounded-xl border px-4 py-3', color)}>
                              <span className="text-base">{emoji}</span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold truncate">{group.name}</p>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {group.cameras.map(c => (
                                    <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/60 dark:bg-slate-900/60 border border-current/20 text-[10px] font-semibold">
                                      <Camera className="w-2.5 h-2.5" />{c.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-lg hover:bg-white/60 dark:hover:bg-slate-800/60"
                                  onClick={() => openEditZoneGroup(group.name, group.type, group.cameras.map(c => c.id))}>
                                  <Edit2 className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-lg text-rose-500 hover:bg-white/60 hover:text-rose-700"
                                  onClick={() => deleteZoneGroup(group.name)}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}
          </div>
        </div>
      )}


      {/* Add Node Dialog */}
      <Dialog open={isAddNodeOpen} onOpenChange={setIsAddNodeOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Register Edge Node</DialogTitle>
            <DialogDescription>Add a new Jetson AI Box to the fleet</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Node Name <span className="text-rose-500">*</span></label>
              <Input 
                placeholder="Entrance-Jetson-01" 
                value={nodeForm.name}
                maxLength={NODE_NAME_MAX + 1}
                onChange={e => {
                  const raw = e.target.value;
                  setNodeNameSpaceError(/\s/.test(raw));
                  const cleaned = raw.replace(/\s/g, '');
                  if (cleaned.length > NODE_NAME_MAX) {
                    toast.warning(`Character limit reached (${NODE_NAME_MAX}/${NODE_NAME_MAX}). Maximum ${NODE_NAME_MAX} characters allowed for Node Name.`);
                    return;
                  }
                  setNodeForm({...nodeForm, name: cleaned});
                }} 
                className={cn("rounded-xl border-2", (nodeNameSpaceError || validateNodeField('name', nodeForm.name)) ? "border-red-500 focus-visible:ring-red-500" : "")} 
              />
              <div className="flex justify-between items-start mt-1 ml-1">
                <div className="flex-1">
                  {(nodeNameSpaceError || validateNodeField('name', nodeForm.name)) && <p className="text-xs text-red-500 font-medium">{nodeNameSpaceError ? "Spaces are not allowed. Use hyphens (-) instead." : validateNodeField('name', nodeForm.name)}</p>}
                </div>
                <span className={cn("text-[10px] font-medium shrink-0 ml-2",
                  nodeForm.name.length >= NODE_NAME_MAX ? "text-red-500 font-bold" :
                  nodeForm.name.length >= NODE_NAME_WARN ? "text-amber-500" : "text-slate-400"
                )}>
                  {nodeForm.name.length}/{NODE_NAME_MAX}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Hardware ID / Device Code <span className="text-rose-500">*</span></label>
              <Input
                placeholder="JETSON-ORIN-NX-001"
                value={nodeForm.device_code}
                onChange={e => {
                  const cleaned = e.target.value.replace(/\s/g, '');
                  setNodeForm({...nodeForm, device_code: cleaned});
                }}
                className={cn("rounded-xl border-2", validateNodeField('device_code', nodeForm.device_code) ? "border-red-500 focus-visible:ring-red-500" : "")}
              />
              {validateNodeField('device_code', nodeForm.device_code) && <p className="text-xs text-red-500 font-medium ml-1">{validateNodeField('device_code', nodeForm.device_code)}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">IP Address <span className="text-rose-500">*</span></label>
                <Input placeholder="172.18.3.202" value={nodeForm.ip_address} onChange={e => setNodeForm({...nodeForm, ip_address: e.target.value})} className="rounded-xl border-2" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">API Port</label>
                <Input type="number" value={nodeForm.port} onChange={e => setNodeForm({...nodeForm, port: parseInt(e.target.value)})} className="rounded-xl border-2" />
              </div>
            </div>
            <div className="flex gap-3 pt-6">
              <Button variant="ghost" onClick={() => setIsAddNodeOpen(false)} className="flex-1 font-bold rounded-xl">Cancel</Button>
              <Button 
                onClick={handleAddNode} 
                disabled={isSubmitting || !isNodeFormFilled || !!validateNodeField('name', nodeForm.name) || nodeNameSpaceError || !!validateNodeField('device_code', nodeForm.device_code)} 
                className={cn(
                  "flex-1 font-bold rounded-xl text-white transition-all",
                  (isSubmitting || !isNodeFormFilled || !!validateNodeField('name', nodeForm.name) || nodeNameSpaceError || !!validateNodeField('device_code', nodeForm.device_code))
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 shadow-md"
                )}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                Provision
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Camera Dialog */}
      <Dialog open={isAddCamOpen} onOpenChange={setIsAddCamOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Attach Camera</DialogTitle>
            <DialogDescription>Connect an IP camera to {selectedNodeForCam?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Camera Display Name</label>
              <Input placeholder="Gate 01 - Entry" value={camForm.name} onChange={e => setCamForm({...camForm, name: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Internal Camera ID</label>
              <Input placeholder="CAM_ENT_01" value={camForm.cam_id} onChange={e => setCamForm({...camForm, cam_id: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">RTSP Stream URL</label>
              <Input placeholder="rtsp://admin:pass@172.18.3.10:554/Streaming/Channels/101" value={camForm.rtsp_url} onChange={e => setCamForm({...camForm, rtsp_url: e.target.value})} className="rounded-xl border-2 font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">IP Address (Optional)</label>
              <Input placeholder="172.18.3.10" value={camForm.ip_address} onChange={e => setCamForm({...camForm, ip_address: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Camera Direction</label>
              <select
                value={camForm.camera_mode}
                onChange={e => setCamForm({...camForm, camera_mode: e.target.value as 'IN' | 'OUT' | 'MIXED'})}
                className={cn("w-full h-10 rounded-xl border-2 bg-white dark:bg-slate-900 px-3 text-sm font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30", lightTheme.border.default, lightTheme.text.secondary)}
              >
                <option value="IN">↵ Entry (Check-In only)</option>
                <option value="OUT">↳ Exit (Check-Out only)</option>
                <option value="MIXED">⇄ Mixed (time-based IN/OUT)</option>
              </select>
            </div>
            <div className="flex gap-3 pt-6">
              <Button variant="ghost" onClick={() => setIsAddCamOpen(false)} className="flex-1 font-bold rounded-xl">Cancel</Button>
              <Button 
                onClick={handleAddCamera} 
                disabled={isSubmitting || !isCamFormFilled} 
                className={cn(
                  "flex-1 font-bold rounded-xl text-white transition-all",
                  (isSubmitting || !isCamFormFilled)
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 shadow-md"
                )}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                Attach
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ZTP Activation Modal */}
      <ZtpActivationModal
        isOpen={isZtpOpen}
        onClose={() => setIsZtpOpen(false)}
        accessToken={accessToken}
        scopeHeaders={scopeHeaders}
        onActivated={fetchHierarchy}
        tenantId={tenantId}
      />

      {/* Add Custom Zone Dialog */}
      <Dialog open={isAddZoneOpen} onOpenChange={setIsAddZoneOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Add Custom Zone</DialogTitle>
            <DialogDescription>Create a custom named location and classify its tracking category</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Zone Name / Label</label>
              <Input 
                placeholder="e.g. Server Room, Meeting Room A" 
                value={customZoneForm.name} 
                onChange={e => setCustomZoneForm({...customZoneForm, name: e.target.value})} 
                className="rounded-xl border-2" 
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Category (For Dwell-Time)</label>
              <select
                value={customZoneForm.type}
                onChange={e => setCustomZoneForm({...customZoneForm, type: e.target.value})}
                className={cn(
                  "w-full h-10 rounded-xl border bg-white dark:bg-slate-900 px-3 text-sm font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30",
                  lightTheme.border.default, lightTheme.text.secondary
                )}
              >
                <option value="work">🏢 Workplace (Productive)</option>
                <option value="break">☕ Cafeteria / Break (Away)</option>
                <option value="other">📍 Other area (Neutral)</option>
              </select>
            </div>
            <div className="flex gap-3 pt-6">
              <Button 
                variant="ghost" 
                onClick={() => {
                  setIsAddZoneOpen(false);
                  setCustomZoneForm({ name: '', type: 'work' });
                }} 
                className="flex-1 font-bold rounded-xl"
              >
                Cancel
              </Button>
              <Button 
                onClick={async () => {
                  if (!customZoneForm.name.trim()) {
                    toast.error('Zone Name is required');
                    return;
                  }
                  if (selectedDeviceForCustomZone) {
                    setIsSubmitting(true);
                    try {
                      await handleSetZone(selectedDeviceForCustomZone, `${customZoneForm.type}:${customZoneForm.name.trim()}`);
                      setIsAddZoneOpen(false);
                      setCustomZoneForm({ name: '', type: 'work' });
                    } finally {
                      setIsSubmitting(false);
                    }
                  }
                }} 
                disabled={isSubmitting} 
                className="flex-1 bg-blue-600 font-bold rounded-xl text-white hover:bg-blue-700"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                Add Zone
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Camera Dialog */}
      <Dialog open={isEditCamOpen} onOpenChange={setIsEditCamOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Edit Camera</DialogTitle>
            <DialogDescription>Update configuration for {selectedCamForEdit?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Camera Display Name</label>
              <Input placeholder="Gate 01 - Entry" value={editCamForm.name} onChange={e => setEditCamForm({...editCamForm, name: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Internal Camera ID</label>
              <Input placeholder="CAM_ENT_01" value={editCamForm.cam_id} onChange={e => setEditCamForm({...editCamForm, cam_id: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">RTSP Stream URL</label>
              <Input placeholder="rtsp://admin:pass@172.18.3.10:554/Streaming/Channels/101" value={editCamForm.rtsp_url} onChange={e => setEditCamForm({...editCamForm, rtsp_url: e.target.value})} className="rounded-xl border-2 font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">IP Address (Optional)</label>
              <Input placeholder="172.18.3.10" value={editCamForm.ip_address} onChange={e => setEditCamForm({...editCamForm, ip_address: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Model / Brand (Optional)</label>
              <Input placeholder="Hikvision, Dahua, etc." value={editCamForm.model} onChange={e => setEditCamForm({...editCamForm, model: e.target.value})} className="rounded-xl border-2" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Camera Direction</label>
              <select
                value={editCamForm.camera_mode}
                onChange={e => setEditCamForm({...editCamForm, camera_mode: e.target.value as 'IN' | 'OUT' | 'MIXED'})}
                className={cn("w-full h-10 rounded-xl border-2 bg-white dark:bg-slate-900 px-3 text-sm font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30", lightTheme.border.default, lightTheme.text.secondary)}
              >
                <option value="IN">↵ Entry (Check-In only)</option>
                <option value="OUT">↳ Exit (Check-Out only)</option>
                <option value="MIXED">⇄ Mixed (time-based IN/OUT)</option>
              </select>
            </div>
            <div className="flex gap-3 pt-6">
              <Button variant="ghost" onClick={() => setIsEditCamOpen(false)} className="flex-1 font-bold rounded-xl">Cancel</Button>
              <Button 
                onClick={handleEditCamera} 
                disabled={isSubmitting || !isEditCamChanged} 
                className={cn(
                  "flex-1 font-bold rounded-xl text-white transition-all",
                  (isSubmitting || !isEditCamChanged)
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 shadow-md"
                )}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Save Changes
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Zone Group Create / Edit Dialog */}
      <Dialog open={isZoneGroupOpen} onOpenChange={setIsZoneGroupOpen}>
        <DialogContent className="max-w-lg rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black flex items-center gap-2">
              <Layers className="w-5 h-5 text-violet-600" />
              {editingGroup?.originalName ? 'Edit Zone Group' : 'New Zone Group'}
            </DialogTitle>
            <DialogDescription>
              Cameras in this group will appear as one tile in Zone Activity heatmap.
            </DialogDescription>
          </DialogHeader>

          {editingGroup && (
            <div className="space-y-5 mt-4">
              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Group Name</label>
                <Input
                  placeholder="e.g. 7th Floor Office, Cafeteria, Reception"
                  value={editingGroup.name}
                  onChange={e => setEditingGroup({ ...editingGroup, name: e.target.value })}
                  className="rounded-xl border-2"
                />
              </div>

              {/* Type */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Category</label>
                <select
                  value={editingGroup.type}
                  onChange={e => setEditingGroup({ ...editingGroup, type: e.target.value })}
                  className={cn(
                    'w-full h-10 rounded-xl border bg-white dark:bg-slate-900 px-3 text-sm font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                    lightTheme.border.default, lightTheme.text.secondary,
                  )}
                >
                  <option value="work">🏢 Workplace (Productive)</option>
                  <option value="break">☕ Cafeteria / Break (Away)</option>
                  <option value="other">📍 Other area (Neutral)</option>
                </select>
              </div>

              {/* Camera selection */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">
                  Assign Cameras <span className="normal-case font-medium text-slate-400">({selectedCamsForGroup.size} selected)</span>
                </label>
                <div className="max-h-56 overflow-y-auto rounded-xl border divide-y" style={{ borderColor: 'var(--border)' }}>
                  {getAllCameras().length === 0 ? (
                    <p className="text-xs text-center text-slate-400 py-6">No cameras registered yet.</p>
                  ) : (
                    getAllCameras().map(cam => {
                      const checked = selectedCamsForGroup.has(cam.id);
                      return (
                        <button
                          key={cam.id}
                          type="button"
                          onClick={() => {
                            setSelectedCamsForGroup(prev => {
                              const next = new Set(prev);
                              if (next.has(cam.id)) next.delete(cam.id);
                              else next.add(cam.id);
                              return next;
                            });
                          }}
                          className={cn(
                            'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
                            checked ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                          )}
                        >
                          <div className={cn(
                            'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                            checked ? 'bg-violet-600 border-violet-600' : 'border-slate-300 dark:border-slate-600',
                          )}>
                            {checked && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <Camera className={cn('w-3.5 h-3.5 shrink-0', checked ? 'text-violet-600' : 'text-slate-400')} />
                          <div className="min-w-0">
                            <p className={cn('text-sm font-bold truncate', checked ? 'text-violet-800 dark:text-violet-300' : lightTheme.text.primary)}>{cam.name}</p>
                            <p className="text-[10px] text-slate-400 truncate">{cam.nodeName}</p>
                          </div>
                          {cam.zone_label && cam.zone_label !== editingGroup.originalName && (
                            <span className="ml-auto text-[9px] text-slate-400 shrink-0 italic">in "{cam.zone_label}"</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="ghost"
                  onClick={() => { setIsZoneGroupOpen(false); setEditingGroup(null); }}
                  className="flex-1 font-bold rounded-xl"
                >
                  Cancel
                </Button>
                <Button
                  onClick={saveZoneGroup}
                  disabled={isSubmitting || !editingGroup.name.trim() || selectedCamsForGroup.size === 0 || !isZoneGroupChanged}
                  className={cn(
                    "flex-1 font-bold rounded-xl text-white transition-all",
                    (isSubmitting || !editingGroup.name.trim() || selectedCamsForGroup.size === 0 || !isZoneGroupChanged)
                      ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                      : "bg-violet-600 hover:bg-violet-700 shadow-md"
                  )}
                >
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Check className="w-4 h-4 mr-2" />}
                  {editingGroup.originalName ? 'Save Changes' : 'Create Group'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Floor Dialog */}
      <Dialog open={isAddFloorOpen} onOpenChange={setIsAddFloorOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Create New Floor</DialogTitle>
            <DialogDescription>Add a new Floor for device and zone group configuration</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Floor Number</label>
              <Input
                type="number"
                placeholder="e.g. 1, 2, 0 (Ground)"
                value={floorForm.floor_number}
                onChange={e => setFloorForm({...floorForm, floor_number: e.target.value})}
                className="rounded-xl border-2"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Floor Name</label>
              <Input
                placeholder="e.g. 1st Floor, Cafeteria, Reception Area"
                value={floorForm.floor_name}
                onChange={e => setFloorForm({...floorForm, floor_name: e.target.value})}
                className="rounded-xl border-2"
              />
            </div>
            <div className="flex gap-3 pt-6">
              <Button variant="ghost" onClick={() => setIsAddFloorOpen(false)} className="flex-1 font-bold rounded-xl">Cancel</Button>
              <Button 
                onClick={handleAddFloor} 
                disabled={isSubmitting || !isFloorFormFilled} 
                className={cn(
                  "flex-1 font-bold rounded-xl text-white transition-all",
                  (isSubmitting || !isFloorFormFilled)
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 shadow-md"
                )}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                Create Floor
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Node Dialog */}
      <Dialog open={isEditNodeOpen} onOpenChange={setIsEditNodeOpen}>
        <DialogContent className="max-w-md rounded-3xl p-8">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">Edit Edge Node</DialogTitle>
            <DialogDescription>Configure details for {selectedNodeForEdit?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Node Name <span className="text-red-400">*</span></label>
              <Input
                placeholder="e.g. Entrance-Jetson-01"
                value={editNodeForm.name}
                maxLength={NODE_NAME_MAX + 1}
                onChange={e => {
                  const raw = e.target.value;
                  setEditNodeNameSpaceError(/\s/.test(raw));
                  const cleaned = raw.replace(/\s/g, '');
                  if (cleaned.length > NODE_NAME_MAX) {
                    toast.warning(`Character limit reached (${NODE_NAME_MAX}/${NODE_NAME_MAX}). Maximum ${NODE_NAME_MAX} characters allowed for Node Name.`);
                    return;
                  }
                  setEditNodeForm({...editNodeForm, name: cleaned});
                }}
                className={cn("rounded-xl border-2", (editNodeNameSpaceError || validateNodeField('name', editNodeForm.name)) ? "border-red-500 focus-visible:ring-red-500" : "")}
              />
              <div className="flex justify-between items-start mt-1 ml-1">
                <div className="flex-1">
                  {(editNodeNameSpaceError || validateNodeField('name', editNodeForm.name)) && <p className="text-xs text-red-500 font-medium">{editNodeNameSpaceError ? "Spaces are not allowed. Use hyphens (-) instead." : validateNodeField('name', editNodeForm.name)}</p>}
                </div>
                <span className={cn("text-[10px] font-medium shrink-0 ml-2",
                  editNodeForm.name.length >= NODE_NAME_MAX ? "text-red-500 font-bold" :
                  editNodeForm.name.length >= NODE_NAME_WARN ? "text-amber-500" : "text-slate-400"
                )}>
                  {editNodeForm.name.length}/{NODE_NAME_MAX}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">IP Address</label>
              <Input
                placeholder="e.g. 172.18.3.202"
                value={editNodeForm.ip_address}
                onChange={e => setEditNodeForm({...editNodeForm, ip_address: e.target.value})}
                className="rounded-xl border-2"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">API Port</label>
                <Input
                  type="number"
                  value={editNodeForm.port}
                  onChange={e => setEditNodeForm({...editNodeForm, port: parseInt(e.target.value)})}
                  className="rounded-xl border-2"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Floor Location</label>
                <select
                  value={editNodeForm.floor_id}
                  onChange={e => setEditNodeForm({...editNodeForm, floor_id: e.target.value})}
                  className={cn(
                    'w-full h-10 rounded-xl border bg-white dark:bg-slate-900 px-3 text-sm font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                    lightTheme.border.default, lightTheme.text.secondary
                  )}
                >
                  <option value="unassigned">— Unassigned</option>
                  {floors.map(f => (
                    <option key={f.pk_floor_id} value={f.pk_floor_id}>{f.floor_name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3 pt-6">
              <Button variant="ghost" onClick={() => setIsEditNodeOpen(false)} className="flex-1 font-bold rounded-xl">Cancel</Button>
              <Button 
                onClick={handleEditNode} 
                disabled={isSubmitting || !isEditNodeChanged || !!validateNodeField('name', editNodeForm.name) || editNodeNameSpaceError} 
                className={cn(
                  "flex-1 font-bold rounded-xl text-white transition-all",
                  (isSubmitting || !isEditNodeChanged || !!validateNodeField('name', editNodeForm.name) || editNodeNameSpaceError)
                    ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 shadow-md"
                )}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Check className="w-4 h-4 mr-2" />}
                Save Changes
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}
    </div>
  );
};
