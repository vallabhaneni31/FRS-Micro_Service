import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import {
  Building2, Plus, Edit, Trash2, Search, RefreshCw, 
  MapPin, Clock, Loader2, CheckCircle2, AlertCircle, Server, Settings
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { DeviceAssignment } from './DeviceAssignment';
import { PageHeader } from '../../../shared/PageHeader';
import { LocationPicker } from '../../../shared/LocationPicker';
import { detectTimezoneFromLocation } from '../../../../utils/timezone';

interface Site {
  pk_site_id: number;
  site_name: string;
  location_address: string;
  timezone_offset: string;
  status: 'active' | 'inactive';
  device_count: number;
  fk_customer_id?: number;
  customer_name?: string;
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  site_config?: {
    attendance_rules?: any;
    recognition_settings?: any;
    direction_detection?: any;
    unauthorized_access_policy?: any;
  };
}

const TIMEZONES = [
  // Universal
  { value: 'UTC', label: 'UTC — Coordinated Universal Time (UTC+0)' },
  // Africa
  { value: 'Africa/Abidjan',       label: 'Africa/Abidjan — GMT (UTC+0)' },
  { value: 'Africa/Cairo',         label: 'Africa/Cairo — EET (UTC+2)' },
  { value: 'Africa/Johannesburg',  label: 'Africa/Johannesburg — SAST (UTC+2)' },
  { value: 'Africa/Lagos',         label: 'Africa/Lagos — WAT (UTC+1)' },
  { value: 'Africa/Nairobi',       label: 'Africa/Nairobi — EAT (UTC+3)' },
  // Americas
  { value: 'America/Anchorage',    label: 'America/Anchorage — AKST/AKDT (UTC-9)' },
  { value: 'America/Bogota',       label: 'America/Bogota — COT (UTC-5)' },
  { value: 'America/Buenos_Aires', label: 'America/Buenos_Aires — ART (UTC-3)' },
  { value: 'America/Caracas',      label: 'America/Caracas — VET (UTC-4)' },
  { value: 'America/Chicago',      label: 'America/Chicago — CST/CDT (UTC-6)' },
  { value: 'America/Denver',       label: 'America/Denver — MST/MDT (UTC-7)' },
  { value: 'America/Halifax',      label: 'America/Halifax — AST/ADT (UTC-4)' },
  { value: 'America/Lima',         label: 'America/Lima — PET (UTC-5)' },
  { value: 'America/Los_Angeles',  label: 'America/Los_Angeles — PST/PDT (UTC-8)' },
  { value: 'America/Mexico_City',  label: 'America/Mexico_City — CST/CDT (UTC-6)' },
  { value: 'America/New_York',     label: 'America/New_York — EST/EDT (UTC-5)' },
  { value: 'America/Phoenix',      label: 'America/Phoenix — MST (UTC-7)' },
  { value: 'America/Santiago',     label: 'America/Santiago — CLT/CLST (UTC-4)' },
  { value: 'America/Sao_Paulo',    label: 'America/Sao_Paulo — BRT (UTC-3)' },
  { value: 'America/St_Johns',     label: 'America/St_Johns — NST/NDT (UTC-3:30)' },
  { value: 'America/Toronto',      label: 'America/Toronto — EST/EDT (UTC-5)' },
  { value: 'America/Vancouver',    label: 'America/Vancouver — PST/PDT (UTC-8)' },
  // Asia
  { value: 'Asia/Almaty',          label: 'Asia/Almaty — ALMT (UTC+6)' },
  { value: 'Asia/Baghdad',         label: 'Asia/Baghdad — AST (UTC+3)' },
  { value: 'Asia/Baku',            label: 'Asia/Baku — AZT (UTC+4)' },
  { value: 'Asia/Bangkok',         label: 'Asia/Bangkok — ICT (UTC+7)' },
  { value: 'Asia/Dhaka',           label: 'Asia/Dhaka — BST (UTC+6)' },
  { value: 'Asia/Dubai',           label: 'Asia/Dubai — GST (UTC+4)' },
  { value: 'Asia/Ho_Chi_Minh',     label: 'Asia/Ho_Chi_Minh — ICT (UTC+7)' },
  { value: 'Asia/Hong_Kong',       label: 'Asia/Hong_Kong — HKT (UTC+8)' },
  { value: 'Asia/Jakarta',         label: 'Asia/Jakarta — WIB (UTC+7)' },
  { value: 'Asia/Jerusalem',       label: 'Asia/Jerusalem — IST/IDT (UTC+2)' },
  { value: 'Asia/Kabul',           label: 'Asia/Kabul — AFT (UTC+4:30)' },
  { value: 'Asia/Karachi',         label: 'Asia/Karachi — PKT (UTC+5)' },
  { value: 'Asia/Kathmandu',       label: 'Asia/Kathmandu — NPT (UTC+5:45)' },
  { value: 'Asia/Kolkata',         label: 'Asia/Kolkata — IST (UTC+5:30)' },
  { value: 'Asia/Kuala_Lumpur',    label: 'Asia/Kuala_Lumpur — MYT (UTC+8)' },
  { value: 'Asia/Kuwait',          label: 'Asia/Kuwait — AST (UTC+3)' },
  { value: 'Asia/Makassar',        label: 'Asia/Makassar — WITA (UTC+8)' },
  { value: 'Asia/Manila',          label: 'Asia/Manila — PST (UTC+8)' },
  { value: 'Asia/Muscat',          label: 'Asia/Muscat — GST (UTC+4)' },
  { value: 'Asia/Riyadh',          label: 'Asia/Riyadh — AST (UTC+3)' },
  { value: 'Asia/Seoul',           label: 'Asia/Seoul — KST (UTC+9)' },
  { value: 'Asia/Shanghai',        label: 'Asia/Shanghai — CST (UTC+8)' },
  { value: 'Asia/Singapore',       label: 'Asia/Singapore — SGT (UTC+8)' },
  { value: 'Asia/Taipei',          label: 'Asia/Taipei — CST (UTC+8)' },
  { value: 'Asia/Tashkent',        label: 'Asia/Tashkent — UZT (UTC+5)' },
  { value: 'Asia/Tbilisi',         label: 'Asia/Tbilisi — GET (UTC+4)' },
  { value: 'Asia/Tehran',          label: 'Asia/Tehran — IRST/IRDT (UTC+3:30)' },
  { value: 'Asia/Tokyo',           label: 'Asia/Tokyo — JST (UTC+9)' },
  { value: 'Asia/Vladivostok',     label: 'Asia/Vladivostok — VLAT (UTC+10)' },
  { value: 'Asia/Yakutsk',         label: 'Asia/Yakutsk — YAKT (UTC+9)' },
  { value: 'Asia/Yekaterinburg',   label: 'Asia/Yekaterinburg — YEKT (UTC+5)' },
  // Atlantic
  { value: 'Atlantic/Azores',      label: 'Atlantic/Azores — AZOT/AZOST (UTC-1)' },
  { value: 'Atlantic/Cape_Verde',  label: 'Atlantic/Cape_Verde — CVT (UTC-1)' },
  // Australia
  { value: 'Australia/Adelaide',   label: 'Australia/Adelaide — ACST/ACDT (UTC+9:30)' },
  { value: 'Australia/Brisbane',   label: 'Australia/Brisbane — AEST (UTC+10)' },
  { value: 'Australia/Darwin',     label: 'Australia/Darwin — ACST (UTC+9:30)' },
  { value: 'Australia/Perth',      label: 'Australia/Perth — AWST (UTC+8)' },
  { value: 'Australia/Sydney',     label: 'Australia/Sydney — AEST/AEDT (UTC+10)' },
  // Europe
  { value: 'Europe/Amsterdam',     label: 'Europe/Amsterdam — CET/CEST (UTC+1)' },
  { value: 'Europe/Athens',        label: 'Europe/Athens — EET/EEST (UTC+2)' },
  { value: 'Europe/Berlin',        label: 'Europe/Berlin — CET/CEST (UTC+1)' },
  { value: 'Europe/Brussels',      label: 'Europe/Brussels — CET/CEST (UTC+1)' },
  { value: 'Europe/Bucharest',     label: 'Europe/Bucharest — EET/EEST (UTC+2)' },
  { value: 'Europe/Budapest',      label: 'Europe/Budapest — CET/CEST (UTC+1)' },
  { value: 'Europe/Copenhagen',    label: 'Europe/Copenhagen — CET/CEST (UTC+1)' },
  { value: 'Europe/Dublin',        label: 'Europe/Dublin — GMT/IST (UTC+0)' },
  { value: 'Europe/Helsinki',      label: 'Europe/Helsinki — EET/EEST (UTC+2)' },
  { value: 'Europe/Istanbul',      label: 'Europe/Istanbul — TRT (UTC+3)' },
  { value: 'Europe/Kiev',          label: 'Europe/Kiev — EET/EEST (UTC+2)' },
  { value: 'Europe/Lisbon',        label: 'Europe/Lisbon — WET/WEST (UTC+0)' },
  { value: 'Europe/London',        label: 'Europe/London — GMT/BST (UTC+0)' },
  { value: 'Europe/Madrid',        label: 'Europe/Madrid — CET/CEST (UTC+1)' },
  { value: 'Europe/Moscow',        label: 'Europe/Moscow — MSK (UTC+3)' },
  { value: 'Europe/Oslo',          label: 'Europe/Oslo — CET/CEST (UTC+1)' },
  { value: 'Europe/Paris',         label: 'Europe/Paris — CET/CEST (UTC+1)' },
  { value: 'Europe/Prague',        label: 'Europe/Prague — CET/CEST (UTC+1)' },
  { value: 'Europe/Rome',          label: 'Europe/Rome — CET/CEST (UTC+1)' },
  { value: 'Europe/Stockholm',     label: 'Europe/Stockholm — CET/CEST (UTC+1)' },
  { value: 'Europe/Vienna',        label: 'Europe/Vienna — CET/CEST (UTC+1)' },
  { value: 'Europe/Warsaw',        label: 'Europe/Warsaw — CET/CEST (UTC+1)' },
  { value: 'Europe/Zurich',        label: 'Europe/Zurich — CET/CEST (UTC+1)' },
  // Pacific
  { value: 'Pacific/Auckland',     label: 'Pacific/Auckland — NZST/NZDT (UTC+12)' },
  { value: 'Pacific/Fiji',         label: 'Pacific/Fiji — FJT (UTC+12)' },
  { value: 'Pacific/Guam',         label: 'Pacific/Guam — ChST (UTC+10)' },
  { value: 'Pacific/Honolulu',     label: 'Pacific/Honolulu — HST (UTC-10)' },
  { value: 'Pacific/Tahiti',       label: 'Pacific/Tahiti — TAHT (UTC-10)' },
];

function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState('');
  const selected = TIMEZONES.find(t => t.value === value);
  const filtered = search.trim()
    ? TIMEZONES.filter(t =>
        t.label.toLowerCase().includes(search.toLowerCase()) ||
        t.value.toLowerCase().includes(search.toLowerCase())
      )
    : TIMEZONES;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger title={selected?.label ?? value}>
        <SelectValue placeholder="Select timezone...">
          <span className="truncate" title={selected?.label ?? value}>{selected?.label || 'Select timezone...'}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <div className="px-2 py-1.5 sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 z-10">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              className="w-full pl-7 pr-2 py-1 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Search timezone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
            />
          </div>
        </div>
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-sm text-slate-400 text-center">No match</div>
        )}
        {filtered.map(tz => (
          <SelectItem key={tz.value} value={tz.value} className="text-sm" title={tz.label}>
            <span className="truncate" title={tz.label}>{tz.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const StatusBadge = ({ status }: { status: string }) => {
  const colors = {
    active: 'bg-green-100 text-green-700 border-green-200',
    inactive: 'bg-slate-100 text-slate-600 border-slate-200'
  };
  const icons = {
    active: CheckCircle2,
    inactive: AlertCircle
  };
  const Icon = icons[status as keyof typeof icons] || AlertCircle;
  
  return (
    <Badge className={cn('border px-2 py-1', colors[status as keyof typeof colors] || colors.inactive)}>
      <Icon className="w-3 h-3 mr-1" />
      {(status?.toString() || 'unknown').charAt(0).toUpperCase() + (status?.toString() || 'unknown').slice(1)}
    </Badge>
  );
};

export const SiteManagement: React.FC = () => {
  const { accessToken, user, customers , isAuthenticated, verticalLabel } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const scopeHeaders = useScopeHeaders();
  const [sites, setSites] = useState<Site[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  
  // Create/Edit Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [siteForm, setSiteForm] = useState({
    site_name: '',
    location_address: '',
    timezone_offset: '',
    timezone_label: '',
    status: 'active' as 'active' | 'inactive',
    customer_id: '',
    city: '',
    country: '',
    latitude: null as number | null,
    longitude: null as number | null,
  });
  const [isSaving, setIsSaving] = useState(false);

  // Device Assignment Modal
  const [isAssignmentOpen, setIsAssignmentOpen] = useState(false);
  const [assignmentSite, setAssignmentSite] = useState<Site | null>(null);

  const fetchSites = useCallback(async (isManual = false) => {
    if (!isAuthenticated) return;
    if (isManual) {
      setRefreshing(true);
    } else {
      setIsLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [res] = await Promise.all([
        apiRequest<{ success: boolean; sites: Site[] }>(
          '/site-management/sites',
          { accessToken, scopeHeaders, noCache: isManual }
        ),
        minDelay,
      ]);
      if (res.success) {
        setSites(res.sites || []);
      }
    } catch (error) {
      toast.error('Failed to load sites');
      console.error('Fetch sites error:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders]);

  useEffect(() => { fetchSites(); }, [fetchSites]);

  const openCreateModal = () => {
    setEditingSite(null);
    setSiteForm({
      site_name: '',
      location_address: '',
      timezone_offset: '',
      timezone_label: '',
      status: 'active',
      customer_id: '',
      city: '',
      country: '',
      latitude: null,
      longitude: null,
    });
    setIsModalOpen(true);
  };

  const openEditModal = (site: Site) => {
    setEditingSite(site);
    setSiteForm({
      site_name: site.site_name,
      location_address: site.location_address,
      timezone_offset: site.timezone_offset,
      timezone_label: TIMEZONES.find(t => t.value === site.timezone_offset)?.label ?? site.timezone_offset,
      status: site.status,
      customer_id: site.fk_customer_id ? String(site.fk_customer_id) : '',
      city: site.city || '',
      country: site.country || '',
      latitude: site.latitude !== undefined ? site.latitude : null,
      longitude: site.longitude !== undefined ? site.longitude : null,
    });
    setIsModalOpen(true);
  };

  const openDeviceAssignment = (site: Site) => {
    setAssignmentSite(site);
    setIsAssignmentOpen(true);
  };

  const handleSave = async () => {
    if (!siteForm.site_name) {
      return toast.error(verticalLabel('Site name is required', 'Campus name is required'));
    }
    if (!siteForm.country) {
      return toast.error('Country is required');
    }
    if (!siteForm.city) {
      return toast.error('City is required');
    }
    if (!siteForm.location_address) {
      return toast.error(verticalLabel('Street address is required', 'Street address is required'));
    }
    if (!siteForm.timezone_offset) {
      return toast.error('Timezone is required');
    }

    if (isSuperAdmin && !siteForm.customer_id) {
      return toast.error('Customer is required');
    }

    if (siteForm.latitude === null || siteForm.longitude === null) {
      return toast.error('Please search for the building/place and pick a precise location on the map');
    }

    setIsSaving(true);
    try {
      if (editingSite) {
        const res = await apiRequest<{ success: boolean }>(
          `/site-management/sites/${editingSite.pk_site_id}`,
          {
            method: 'PATCH',
            accessToken,
            scopeHeaders,
            body: JSON.stringify(siteForm)
          }
        );
        if (res.success) {
          toast.success(verticalLabel('Site updated successfully!', 'Campus updated successfully!'));
        }
      } else {
        const res = await apiRequest<{ success: boolean }>(
          '/site-management/sites',
          {
            method: 'POST',
            accessToken,
            scopeHeaders,
            body: JSON.stringify(siteForm)
          }
        );
        if (res.success) {
          toast.success(verticalLabel('Site created successfully!', 'Campus created successfully!'));
        }
      }
      setIsModalOpen(false);
      fetchSites();
    } catch (error) {
      toast.error(editingSite ? 'Failed to update site' : 'Failed to create site');
      console.error('Save site error:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDelete = async (site: Site) => {
    setConfirmConfig({
      title: `Delete "${site.site_name}"?`,
      description: 'This action cannot be undone and will remove all site configuration.',
      confirmText: 'Delete Site',
      onConfirm: async () => {
        try {
          const res = await apiRequest<{ success: boolean }>(
            `/site-management/sites/${site.pk_site_id}`,
            {
              method: 'DELETE',
              accessToken,
              scopeHeaders
            }
          );
          if (res.success) {
            toast.success(verticalLabel('Site deleted successfully', 'Campus deleted successfully'));
            setSites(prev => prev.filter(s => s.pk_site_id !== site.pk_site_id));
          }
        } catch (error: any) {
          const message = error.message || 'Failed to delete site';
          toast.error(message);
        }
      },
    });
  };

  const filteredSites = sites.filter(site => {
    const matchesSearch = site.site_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         site.location_address.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || site.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title={verticalLabel('Site Management', 'Campus Management')}
        icon={Building2}
        subtitle={verticalLabel('Manage facilities, locations, and site configurations', 'Manage campuses, locations, and campus configurations')}
        actions={
          <Button onClick={openCreateModal} className="gap-2">
            <Plus className="w-4 h-4" />
            {verticalLabel('Create Site', 'Create Campus')}
          </Button>
        }
      />

      <div className="flex gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4', lightTheme.text.muted)} />
          <Input
            placeholder={verticalLabel('Search sites...', 'Search campuses...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => fetchSites(true)} disabled={isLoading || refreshing} className="gap-2">
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

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

      {isLoading && !refreshing ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className={cn("grid gap-4 md:grid-cols-2 lg:grid-cols-3 transition-opacity duration-300", refreshing && "opacity-60 pointer-events-none")}>
          {filteredSites.map(site => (
            <Card key={site.pk_site_id} className="overflow-hidden">
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={cn('p-2 rounded-lg', lightTheme.primary.selectedBg)}>
                      <Building2 className={cn('w-5 h-5', lightTheme.primary.selectedText)} />
                    </div>
                    <div>
                      <h3 className={cn('font-bold', lightTheme.text.primary)}>{site.site_name}</h3>
                      <p className={cn('text-xs', lightTheme.text.secondary)}>{verticalLabel('Site', 'Campus')} ID: {site.pk_site_id}</p>
                    </div>
                  </div>
                  <StatusBadge status={site.status} />
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-start gap-2">
                    <MapPin className={cn('w-4 h-4 mt-0.5', lightTheme.text.muted)} />
                    <span className={lightTheme.text.secondary}>{site.location_address}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className={cn('w-4 h-4', lightTheme.text.muted)} />
                    <span className={lightTheme.text.secondary}>{site.timezone_offset}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Server className={cn('w-4 h-4', lightTheme.text.muted)} />
                    <span className="font-medium">{site.device_count || 0} Devices</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openDeviceAssignment(site)}
                    className="gap-1"
                  >
                    <Settings className="w-3 h-3" />
                    Devices
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEditModal(site)}
                    className="gap-1"
                  >
                    <Edit className="w-3 h-3" />
                    Edit
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDelete(site)}
                  className="w-full mt-2 gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  {verticalLabel('Delete Site', 'Delete Campus')}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {filteredSites.length === 0 && !isLoading && !refreshing && (
        <div className="text-center py-12">
          <p className={lightTheme.text.secondary}>No {verticalLabel('sites', 'campuses')} found</p>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSite ? verticalLabel('Edit Site', 'Edit Campus') : verticalLabel('Create New Site', 'Create New Campus')}</DialogTitle>
            <DialogDescription>
              {editingSite ? verticalLabel('Update site information', 'Update campus information') : verticalLabel('Add a new facility or location', 'Add a new campus or location')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            {isSuperAdmin && (
              <div>
                <Label>Customer <span className="text-rose-500">*</span></Label>
                <Select
                  value={siteForm.customer_id}
                  onValueChange={(value) => setSiteForm({ ...siteForm, customer_id: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a Customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>{verticalLabel('Site Name', 'Campus Name')} <span className="text-rose-500">*</span></Label>
              <Input
                placeholder={verticalLabel('Headquarters', 'Main Campus')}
                value={siteForm.site_name}
                onChange={(e) => setSiteForm({ ...siteForm, site_name: e.target.value })}
              />
            </div>
            <div>
              <Label>Precise Location <span className="text-rose-500">*</span></Label>
              <LocationPicker
                initialLatitude={siteForm.latitude}
                initialLongitude={siteForm.longitude}
                initialDisplayName={siteForm.location_address || undefined}
                onLocationSelected={(loc) => {
                  const detectedTz = detectTimezoneFromLocation(loc);
                  setSiteForm(prev => ({
                    ...prev,
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    city: loc.city || prev.city,
                    country: loc.country || prev.country,
                    location_address: loc.displayName || prev.location_address,
                    timezone_offset: detectedTz || prev.timezone_offset,
                    timezone_label: detectedTz ? (TIMEZONES.find(t => t.value === detectedTz)?.label ?? detectedTz) : prev.timezone_label,
                  }));
                }}
              />
            </div>
            <div className={cn(
              "rounded-xl border p-2.5 flex items-start gap-2 text-[11px] transition-all",
              siteForm.latitude !== null && siteForm.longitude !== null
                ? "bg-emerald-50/50 border-emerald-100 text-emerald-800"
                : "bg-slate-50 border-slate-100 text-slate-500"
            )}>
              <MapPin className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", siteForm.latitude !== null ? "text-emerald-500" : "text-slate-400")} />
              <p className="font-semibold">
                {siteForm.latitude !== null ? "Precise location set — address, city, and country below were filled in from the pick and can be edited" : "Search for a building or place name above to set a precise pin"}
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Country <span className="text-rose-500">*</span></Label>
                <Input
                  placeholder="Country"
                  value={siteForm.country}
                  onChange={(e) => {
                    const newCountry = e.target.value;
                    const detectedTz = detectTimezoneFromLocation({ country: newCountry, city: siteForm.city, location_address: siteForm.location_address });
                    setSiteForm(prev => ({
                      ...prev,
                      country: newCountry,
                      timezone_offset: detectedTz || prev.timezone_offset,
                      timezone_label: detectedTz ? (TIMEZONES.find(t => t.value === detectedTz)?.label ?? detectedTz) : prev.timezone_label,
                    }));
                  }}
                />
              </div>
              <div>
                <Label>City <span className="text-rose-500">*</span></Label>
                <Input
                  placeholder="City"
                  value={siteForm.city}
                  onChange={(e) => {
                    const newCity = e.target.value;
                    const detectedTz = detectTimezoneFromLocation({ country: siteForm.country, city: newCity, location_address: siteForm.location_address });
                    setSiteForm(prev => ({
                      ...prev,
                      city: newCity,
                      timezone_offset: detectedTz || prev.timezone_offset,
                      timezone_label: detectedTz ? (TIMEZONES.find(t => t.value === detectedTz)?.label ?? detectedTz) : prev.timezone_label,
                    }));
                  }}
                />
              </div>
            </div>
            <div>
              <Label>Street Address <span className="text-rose-500">*</span></Label>
              <Input
                placeholder="e.g. Suite 402, 123 Main St"
                value={siteForm.location_address}
                onChange={(e) => setSiteForm({ ...siteForm, location_address: e.target.value })}
              />
            </div>
            <div>
              <Label>Timezone</Label>
              <TimezoneSelect
                value={siteForm.timezone_offset}
                onChange={(value) => setSiteForm({
                  ...siteForm,
                  timezone_offset: value,
                  timezone_label: TIMEZONES.find(t => t.value === value)?.label ?? value,
                })}
              />
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={siteForm.status}
                onValueChange={(value: 'active' | 'inactive') => setSiteForm({ ...siteForm, status: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-4">
              <Button variant="outline" onClick={() => setIsModalOpen(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving} className="flex-1 gap-2">
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {editingSite ? 'Update' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Device Assignment Modal */}
      {assignmentSite && (
        <DeviceAssignment
          isOpen={isAssignmentOpen}
          onClose={() => setIsAssignmentOpen(false)}
          siteId={assignmentSite.pk_site_id}
          siteName={assignmentSite.site_name}
          accessToken={accessToken}
          scopeHeaders={scopeHeaders}
          onAssignmentChange={fetchSites}
        />
      )}

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
