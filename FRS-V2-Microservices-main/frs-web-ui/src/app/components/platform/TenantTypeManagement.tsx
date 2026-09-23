import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Tag, Plus, RefreshCw, Loader2, Pencil, Trash2, GraduationCap, Store, Bus } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/http/apiClient';
import { useScopeHeaders } from '../../hooks/useScopeHeaders';
import { PageHeader } from '../shared/PageHeader';
import { lightTheme } from '../../../theme/lightTheme';
import { cn } from '../ui/utils';

interface TenantType {
  id: string;
  name: string;
  description: string | null;
  features: string[] | null;
  tenant_count: number;
  createdAt: string;
  vertical?: string;
}

const VERTICALS = [
  { key: 'all', label: 'All' },
  { key: 'corporate', label: 'Corporate' },
  { key: 'education', label: 'Education' },
  { key: 'retail', label: 'Retail / Store' },
  { key: 'transport', label: 'Transport' },
];

const VERTICAL_LABELS: Record<string, string> = {
  corporate: 'Corporate',
  education: 'Education',
  retail: 'Retail / Store',
  transport: 'Transport',
};

const getVerticalIcon = (vertical?: string | null) => {
  const v = (vertical || 'corporate').toLowerCase();
  if (v === 'education') return GraduationCap;
  if (v === 'retail') return Store;
  if (v === 'transport') return Bus;
  return Tag;
};

const getFeaturesForVertical = (vertical: string) => {
  if (vertical === 'education') {
    return [
      { key: 'student_attendance',  label: 'Student Attendance' },
      { key: 'face_recognition',    label: 'Face Recognition' },
      { key: 'devices',             label: 'Device Management' },
      { key: 'reports',             label: 'Reports & Analytics' },
      { key: 'parent_notifications',label: 'Parent Notifications' },
      { key: 'alerts',              label: 'Real-Time Alerts' },
      { key: 'analytics_export',    label: 'Analytics Export' },
      { key: 'hrms_sync',           label: 'HRMS Integration' },
      { key: 'leave',                 label: 'Leave Management' },
      { key: 'scheduled_reports',     label: 'Scheduled Reports' },
      { key: 'system_admin',          label: 'System Admin' },
      { key: 'tenant_admin',          label: 'Tenant Admin' },
      { key: 'platform_admin',        label: 'Platform Admin' },
    ];
  }
  if (vertical === 'retail') {
    return [
      { key: 'people_counting',     label: 'People Counting' },
      { key: 'live_dashboard',      label: 'Live Dashboard' },
      { key: 'reports',             label: 'Retail Reports' },
      { key: 'analytics',           label: 'Retail Analytics' },
      { key: 'uniform_detection',   label: 'Uniform Detection' },
      { key: 'store_management',    label: 'Multi-Store Management' },
      { key: 'leave',                 label: 'Leave Management' },
      { key: 'scheduled_reports',     label: 'Scheduled Reports' },
      { key: 'system_admin',          label: 'System Admin' },
      { key: 'tenant_admin',          label: 'Tenant Admin' },
      { key: 'platform_admin',        label: 'Platform Admin' },
    ];
  }
  if (vertical === 'transport') {
    return [
      { key: 'fleet_management', label: 'Fleet & Route Management' },
      { key: 'devices',          label: 'Device Management' },
      { key: 'live_occupancy',   label: 'Live Occupancy' },
      { key: 'boarding_events',  label: 'Boarding / Deboarding Events' },
      { key: 'reports',          label: 'Reports & Analytics' },
      { key: 'leave',                 label: 'Leave Management' },
      { key: 'scheduled_reports',     label: 'Scheduled Reports' },
      { key: 'system_admin',          label: 'System Admin' },
      { key: 'tenant_admin',          label: 'Tenant Admin' },
      { key: 'platform_admin',        label: 'Platform Admin' },
    ];
  }
  // Default: Corporate
  return [
    { key: 'attendance',       label: 'Attendance Tracking' },
    { key: 'face_recognition', label: 'Face Recognition' },
    { key: 'devices',          label: 'Device Management' },
    { key: 'reports',          label: 'Reports & Analytics' },
    { key: 'hrms_sync',        label: 'HRMS Integration' },
    { key: 'alerts',           label: 'Real-Time Alerts' },
    { key: 'analytics_export', label: 'Analytics Export' },
    { key: 'leave',            label: 'Leave Management' },
    { key: 'scheduled_reports',label: 'Scheduled Reports' },
    { key: 'system_admin',     label: 'System Admin' },
    { key: 'tenant_admin',     label: 'Tenant Admin' },
    { key: 'platform_admin',   label: 'Platform Admin' },
  ];
};

const MASTER_FEATURES: Record<string, { label: string }> = {
  attendance: { label: 'Attendance Tracking' },
  student_attendance: { label: 'Student Attendance' },
  face_recognition: { label: 'Face Recognition' },
  devices: { label: 'Device Management' },
  reports: { label: 'Reports & Analytics' },
  hrms_sync: { label: 'HRMS Integration' },
  alerts: { label: 'Real-Time Alerts' },
  analytics_export: { label: 'Analytics Export' },
  leave: { label: 'Leave Management' },
  scheduled_reports: { label: 'Scheduled Reports' },
  system_admin: { label: 'System Admin' },
  tenant_admin: { label: 'Tenant Admin' },
  platform_admin: { label: 'Platform Admin' },
  parent_notifications: { label: 'Parent Notifications' },
  people_counting: { label: 'People Counting' },
  live_dashboard: { label: 'Live Dashboard' },
  analytics: { label: 'Retail Analytics' },
  uniform_detection: { label: 'Uniform Detection' },
  store_management: { label: 'Multi-Store Management' },
  fleet_management: { label: 'Fleet & Route Management' },
  live_occupancy: { label: 'Live Occupancy' },
  boarding_events: { label: 'Boarding / Deboarding Events' }
};

const emptyForm = { name: '', description: '', features: [] as string[], vertical: 'corporate' };

export const TenantTypeManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [types, setTypes] = useState<TenantType[]>([]);
  const [activeVertical, setActiveVertical] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TenantType | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TenantType | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (types.length === 0) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [data] = await Promise.all([
        apiRequest<{ tenantTypes: TenantType[] }>(
          '/app-admin/tenant-types', { accessToken, scopeHeaders, noCache: true }
        ),
        minDelay
      ]);
      setTypes(data.tenantTypes);
    } catch {
      toast.error('Failed to load tenant types');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, types.length]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (t: TenantType) => {
    setEditing(t);
    setForm({ name: t.name, description: t.description ?? '', features: t.features ?? [], vertical: t.vertical ?? 'corporate' });
    setDialogOpen(true);
  };

  const toggleFeature = (key: string) =>
    setForm(f => ({
      ...f,
      features: f.features.includes(key) ? f.features.filter(x => x !== key) : [...f.features, key],
    }));

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await apiRequest(`/app-admin/tenant-types/${editing.id}`, {
          method: 'PATCH',
          accessToken,
          scopeHeaders,
          body: JSON.stringify({ name: form.name, description: form.description, features: form.features, vertical: form.vertical }),
        });
        toast.success('Tenant type updated successfully.');
      } else {
        await apiRequest('/app-admin/tenant-types', {
          method: 'POST',
          accessToken,
          scopeHeaders,
          body: JSON.stringify({ name: form.name, description: form.description, features: form.features, vertical: form.vertical }),
        });
        toast.success('Tenant type created successfully.');
      }
      setDialogOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (t: TenantType) => {
    if (t.tenant_count > 0) {
      toast.error(`Cannot delete — ${t.tenant_count} tenant(s) are assigned this type.`);
      return;
    }
    setDeleteTarget(t);
    setDeleteOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/app-admin/tenant-types/${deleteTarget.id}`, { method: 'DELETE', accessToken, scopeHeaders });
      toast.success('Tenant type deleted successfully.');
      setDeleteOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title="Tenant Types"
        subtitle="Define tiers and their default feature sets"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={loading || refreshing}
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </Button>
            <Button size="sm" onClick={openCreate} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
              <Plus className="w-4 h-4" /> New Type
            </Button>
          </>
        }
      />

      {refreshing && (
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

      {/* Tab Filters */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {VERTICALS.map(v => {
            const isActive = activeVertical === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setActiveVertical(v.key)}
                className={cn(
                  "px-5 py-1.5 text-xs font-semibold rounded-full border transition-all select-none",
                  isActive
                    ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                    : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                )}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      )}

      <div className={cn("transition-opacity duration-300 space-y-6", refreshing && "opacity-60 pointer-events-none")}>
        {loading ? (
          <div className="flex justify-center h-48 items-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-10">
            {['corporate', 'education', 'retail', 'transport'].map(vert => {
              // Only display this vertical if it is allowed by the active tab filter
              if (activeVertical !== 'all' && activeVertical !== vert) return null;

              // Filter types for this vertical
              const verticalTypes = types.filter(t => (t.vertical || 'corporate').toLowerCase() === vert);
              if (verticalTypes.length === 0) return null;

              return (
                <div key={vert} className="space-y-4">
                  {/* Category Header */}
                  <div className="flex items-center gap-4 mt-6 mb-4">
                    <h3 className="text-lg font-black text-slate-800 dark:text-white leading-none">
                      {VERTICAL_LABELS[vert] || vert}
                    </h3>
                    <div className="h-[1px] flex-1 bg-slate-100 dark:bg-slate-800" />
                  </div>

                  {/* Grid layout for cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {verticalTypes.map(t => {
                      const IconComponent = getVerticalIcon(t.vertical);
                      return (
                        <Card key={t.id} className={cn('border shadow-sm rounded-2xl overflow-hidden glass-card', lightTheme.border.default)}>
                          <CardContent className="p-6 flex flex-col justify-between h-full space-y-4">
                            <div className="space-y-3">
                              {/* Card Header: Icon + Title + Actions */}
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                                    <IconComponent className="w-4 h-4" />
                                  </div>
                                  <span className={cn('font-bold text-sm text-indigo-600 dark:text-indigo-400')}>{t.name}</span>
                                </div>
                                <div className="flex gap-0.5 shrink-0">
                                  <Button variant="ghost" size="sm" onClick={() => openEdit(t)}
                                    className={cn('h-7 w-7 p-0 hover:text-indigo-600 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => confirmDelete(t)}
                                    className={cn('h-7 w-7 p-0 hover:text-rose-600 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </div>

                              {/* Description */}
                              {t.description && (
                                <p className={cn('text-xs text-slate-500 dark:text-slate-400 leading-relaxed min-h-[40px]')}>{t.description}</p>
                              )}

                              {/* Badges / Features list */}
                              <div className="flex flex-wrap gap-1.5 pt-2">
                                {(t.features ?? []).length === 0 ? (
                                  <span className={cn('text-[10px] text-slate-400 italic')}>No default features</span>
                                ) : (
                                  (t.features ?? []).map(f => (
                                    <span key={f} className="text-[9px] font-bold tracking-wider px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 border border-indigo-100/50 dark:border-indigo-900/30 uppercase">
                                      {f}
                                    </span>
                                  ))
                                )}
                              </div>
                            </div>

                            {/* Footer divider and count */}
                            <div className="border-t border-slate-100 dark:border-slate-800 pt-4 mt-auto">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400 font-medium">Total Features</span>
                                <span className="font-bold text-slate-800 dark:text-slate-200">
                                  {(t.features ?? []).length} Feature{(t.features ?? []).length !== 1 ? 's' : ''}
                                </span>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Tenant Type' : 'New Tenant Type'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Update this type and its default feature set.' : 'New tenants assigned this type will inherit these default features.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. enterprise" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Vertical <span className="text-rose-500">*</span></Label>
              <select 
                value={form.vertical}
                onChange={e => setForm(f => ({ ...f, vertical: e.target.value }))}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="corporate">Corporate</option>
                <option value="education">Education</option>
                <option value="retail">Retail / Store</option>
                <option value="transport">Transport</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional description" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Default Features</Label>
              <div className="grid grid-cols-2 gap-2">
                {(() => {
                  const baseList = [...getFeaturesForVertical(form.vertical)];
                  form.features.forEach(pf => {
                    if (!baseList.some(df => df.key.toLowerCase() === pf.toLowerCase())) {
                      baseList.push({
                        key: pf,
                        label: MASTER_FEATURES[pf.toLowerCase()]?.label || pf,
                      });
                    }
                  });
                  return baseList;
                })().map(f => (
                  <label key={f.key}
                    className={cn('flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer', lightTheme.border.default, lightTheme.table.rowHover)}>
                    <input type="checkbox" checked={form.features.includes(f.key)}
                      onChange={() => toggleFeature(f.key)}
                      className="w-3.5 h-3.5 accent-indigo-600" />
                    <span className={cn('text-sm', lightTheme.text.primary)}>{f.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!form.name.trim() || saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {editing ? 'Save Changes' : 'Create Type'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Tenant Type</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the tenant type <strong className="text-slate-900 dark:text-white">"{deleteTarget?.name}"</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button onClick={handleDeleteConfirm} disabled={saving}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
};
