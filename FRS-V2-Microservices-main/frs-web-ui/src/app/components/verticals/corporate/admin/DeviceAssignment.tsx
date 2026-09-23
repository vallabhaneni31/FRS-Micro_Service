import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import { Button } from '../../../ui/button';
import { Badge } from '../../../ui/badge';
import { Loader2, Plus, X, CheckCircle2, Server, Camera } from 'lucide-react';
import { toast } from 'sonner';
import { apiRequest } from '../../../../services/http/apiClient';

interface Device {
  pk_device_id: number;
  external_device_id: string;
  name: string;
  status: string;
  device_category: string;
  is_assigned: boolean;
}

interface DeviceAssignmentProps {
  isOpen: boolean;
  onClose: () => void;
  siteId: number;
  siteName: string;
  accessToken: string | null;
  scopeHeaders: Record<string, string>;
  onAssignmentChange: () => void;
}

export const DeviceAssignment: React.FC<DeviceAssignmentProps> = ({
  isOpen,
  onClose,
  siteId,
  siteName,
  accessToken,
  scopeHeaders,
  onAssignmentChange
}) => {
  const [assignedDevices, setAssignedDevices] = useState<Device[]>([]);
  const [availableDevices, setAvailableDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actioningDevice, setActioningDevice] = useState<number | null>(null);

  const fetchDevices = async () => {
    if (!accessToken) return;
    setIsLoading(true);
    try {
      // Get devices assigned to this site
      const assignedRes = await apiRequest<{ success: boolean; devices: any[] }>(
        `/device-management/sites/${siteId}/devices`,
        { accessToken, scopeHeaders }
      );

      // Get all devices
      const allRes = await apiRequest<{ success: boolean; devices: any[] }>(
        '/device-management/devices',
        { accessToken, scopeHeaders }
      );

      const assigned = assignedRes.devices || [];
      const all = allRes.devices || [];

      // Mark which devices are assigned to THIS site
      const assignedIds = new Set(assigned.map(d => d.pk_device_id));
      
      setAssignedDevices(assigned);
      setAvailableDevices(all.filter(d => !assignedIds.has(d.pk_device_id)));

    } catch (error) {
      toast.error('Failed to load devices');
      console.error('Fetch devices error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDevices();
    }
  }, [isOpen, siteId]);

  const handleAssign = async (device: Device) => {
    setActioningDevice(device.pk_device_id);
    try {
      const res = await apiRequest<{ success: boolean }>(
        `/device-management/sites/${siteId}/devices`,
        {
          method: 'POST',
          accessToken,
          scopeHeaders,
          body: JSON.stringify({
            device_code: device.external_device_id,
            device_role: 'primary',
            zone_name: 'main'
          })
        }
      );

      if (res.success) {
        toast.success(`${device.name} assigned to ${siteName}`);
        fetchDevices();
        onAssignmentChange();
      }
    } catch (error) {
      toast.error('Failed to assign device');
    } finally {
      setActioningDevice(null);
    }
  };

  const handleUnassign = async (device: Device) => {
    setActioningDevice(device.pk_device_id);
    try {
      const res = await apiRequest<{ success: boolean }>(
        `/device-management/sites/${siteId}/devices/${device.external_device_id}`,
        {
          method: 'DELETE',
          accessToken,
          scopeHeaders
        }
      );

      if (res.success) {
        toast.success(`${device.name} unassigned from ${siteName}`);
        fetchDevices();
        onAssignmentChange();
      }
    } catch (error) {
      toast.error('Failed to unassign device');
    } finally {
      setActioningDevice(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Manage Devices - {siteName}</DialogTitle>
          <DialogDescription>
            Assign or unassign devices to this site
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="space-y-6 overflow-y-auto flex-1">
            {/* Assigned Devices */}
            <div>
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                Assigned Devices ({assignedDevices.length})
              </h3>
              {assignedDevices.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">No devices assigned yet</p>
              ) : (
                <div className="space-y-2">
                  {assignedDevices.map(device => (
                    <div
                      key={device.pk_device_id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-green-100 dark:bg-green-900/20 rounded-lg">
                          {device.device_category === 'camera' ? (
                            <Camera className="w-4 h-4 text-green-700" />
                          ) : (
                            <Server className="w-4 h-4 text-green-700" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{device.name}</p>
                          <p className="text-xs text-slate-500">{device.external_device_id}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className="bg-green-100 text-green-700 border-green-200">
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Assigned
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUnassign(device)}
                          disabled={actioningDevice === device.pk_device_id}
                          className="gap-1"
                        >
                          {actioningDevice === device.pk_device_id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <X className="w-3 h-3" />
                          )}
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Available Devices */}
            <div>
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                Available Devices ({availableDevices.length})
              </h3>
              {availableDevices.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">All devices are assigned</p>
              ) : (
                <div className="space-y-2">
                  {availableDevices.map(device => (
                    <div
                      key={device.pk_device_id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                          {device.device_category === 'camera' ? (
                            <Camera className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Server className="w-4 h-4 text-blue-600" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{device.name}</p>
                          <p className="text-xs text-slate-500">{device.external_device_id}</p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleAssign(device)}
                        disabled={actioningDevice === device.pk_device_id}
                        className="gap-1"
                      >
                        {actioningDevice === device.pk_device_id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        Assign
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="border-t pt-4 mt-4">
          <Button onClick={onClose} className="w-full">
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
