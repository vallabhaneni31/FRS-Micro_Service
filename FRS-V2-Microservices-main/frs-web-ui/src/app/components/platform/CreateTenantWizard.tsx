import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Building2, Globe, Shield, CheckCircle2, Circle, ChevronRight,
  Loader2, Clock, Lock, Users, AlertTriangle, Sparkles,
  Camera, Cpu, BarChart3, Calendar, RefreshCw, Check, X,
  UserPlus, Mail, MapPin,
  Bell, Briefcase, FileSpreadsheet, Presentation, Eye, CheckSquare, LayoutGrid, Bus
} from 'lucide-react';
import { cn } from '../ui/utils';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest, ApiError } from '../../services/http/apiClient';
import { useScopeHeaders } from '../../hooks/useScopeHeaders';
import { toast } from 'sonner';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { LocationPicker } from '../shared/LocationPicker';

// Fix broken default icon paths in bundled environments
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface TenantType {
  id: string;
  name: string;
  description: string | null;
  features: string[] | null;
  vertical?: string;
}

interface WizardData {
  tenantName: string;
  tenantTypeId: string;
  realmSlug: string;
  realmName: string;
  domain: string;
  sessionTimeout: number;
  maxFailedLogins: number;
  passwordMinLength: number;
  lockoutDurationMinutes: number;
  adminName: string;
  adminEmail: string;
  vertical: 'corporate' | 'education' | 'retail' | 'transport';
  city: string;
  country: string;
  locationAddress: string;
  latitude: number | null;
  longitude: number | null;
}

interface CreationStep {
  key: string;
  label: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface Props {
  tenantTypes: TenantType[];
  onSuccess: () => void;
  onCancel: () => void;
}



// ── Constants ──────────────────────────────────────────────────────────────────
const WIZARD_STEPS = [
  { key: 'org',      label: 'Organization',    icon: Building2 },
  { key: 'location', label: 'HQ Location',     icon: MapPin    },
  { key: 'realm',    label: 'Realm Identity',  icon: Globe     },
  { key: 'security', label: 'Security Policy', icon: Shield    },
  { key: 'admin',    label: 'Tenant Admin',    icon: UserPlus  },
  { key: 'review',   label: 'Review & Create', icon: Sparkles  },
];



const getFeaturesForVertical = (vertical: string) => {
  if (vertical === 'education') {
    return [
      { key: 'student_attendance',  label: 'Student Attendance',   icon: Users,        matches: ['student_attendance', 'attendance'] },
      { key: 'face_recognition',    label: 'Face Recognition',     icon: Camera,       matches: ['face_recognition'] },
      { key: 'devices',             label: 'Device Management',    icon: Cpu,          matches: ['devices'] },
      { key: 'reports',             label: 'Reports & Analytics',  icon: BarChart3,    matches: ['reports'] },
      { key: 'parent_notifications',label: 'Parent Notifications', icon: Bell,         matches: ['parent_notifications'] },
      { key: 'alerts',              label: 'Real-Time Alerts',     icon: Bell,         matches: ['alerts'] },
      { key: 'analytics_export',    label: 'Analytics Export',     icon: FileSpreadsheet, matches: ['analytics_export'] },
      { key: 'hrms_sync',           label: 'HRMS Integration',     icon: RefreshCw,    matches: ['hrms_sync'] },
      { key: 'leave',                 label: 'Leave Management',     icon: Calendar,     matches: ['leave'] },
      { key: 'scheduled_reports',     label: 'Scheduled Reports',    icon: FileSpreadsheet, matches: ['scheduled_reports'] },
      { key: 'system_admin',          label: 'System Admin',         icon: Shield,       matches: ['system_admin'] },
      { key: 'tenant_admin',          label: 'Tenant Admin',         icon: Users,        matches: ['tenant_admin'] },
      { key: 'platform_admin',        label: 'Platform Admin',       icon: Globe,        matches: ['platform_admin'] },
    ];
  }
  if (vertical === 'retail') {
    return [
      { key: 'people_counting',     label: 'People Counting',       icon: Users,        matches: ['people_counting'] },
      { key: 'live_dashboard',      label: 'Live Dashboard',        icon: Presentation, matches: ['live_dashboard'] },
      { key: 'reports',             label: 'Retail Reports',        icon: BarChart3,    matches: ['reports'] },
      { key: 'analytics',           label: 'Retail Analytics',      icon: Eye,          matches: ['analytics'] },
      { key: 'uniform_detection',   label: 'Uniform Detection',     icon: CheckSquare,  matches: ['uniform_detection'] },
      { key: 'store_management',    label: 'Multi-Store Management',icon: LayoutGrid,   matches: ['store_management'] },
      { key: 'leave',                 label: 'Leave Management',     icon: Calendar,     matches: ['leave'] },
      { key: 'scheduled_reports',     label: 'Scheduled Reports',    icon: FileSpreadsheet, matches: ['scheduled_reports'] },
      { key: 'system_admin',          label: 'System Admin',         icon: Shield,       matches: ['system_admin'] },
      { key: 'tenant_admin',          label: 'Tenant Admin',         icon: Users,        matches: ['tenant_admin'] },
      { key: 'platform_admin',        label: 'Platform Admin',       icon: Globe,        matches: ['platform_admin'] },
    ];
  }
  if (vertical === 'transport') {
    return [
      { key: 'fleet_management', label: 'Fleet & Route Management',      icon: Bus,          matches: ['fleet_management'] },
      { key: 'devices',          label: 'Device Management',             icon: Cpu,          matches: ['devices'] },
      { key: 'live_occupancy',   label: 'Live Occupancy',                icon: Presentation, matches: ['live_occupancy'] },
      { key: 'boarding_events',  label: 'Boarding / Deboarding Events',  icon: Users,        matches: ['boarding_events'] },
      { key: 'reports',          label: 'Reports & Analytics',           icon: BarChart3,    matches: ['reports'] },
      { key: 'leave',                 label: 'Leave Management',     icon: Calendar,     matches: ['leave'] },
      { key: 'scheduled_reports',     label: 'Scheduled Reports',    icon: FileSpreadsheet, matches: ['scheduled_reports'] },
      { key: 'system_admin',          label: 'System Admin',         icon: Shield,       matches: ['system_admin'] },
      { key: 'tenant_admin',          label: 'Tenant Admin',         icon: Users,        matches: ['tenant_admin'] },
      { key: 'platform_admin',        label: 'Platform Admin',       icon: Globe,        matches: ['platform_admin'] },
    ];
  }
  // Default: Corporate
  return [
    { key: 'attendance',            label: 'Attendance Tracking',  icon: Clock,        matches: ['attendance'] },
    { key: 'face_recognition',      label: 'Face Recognition',     icon: Camera,       matches: ['face_recognition'] },
    { key: 'devices',               label: 'Device Management',    icon: Cpu,          matches: ['devices'] },
    { key: 'reports',               label: 'Reports & Analytics',  icon: BarChart3,    matches: ['reports'] },
    { key: 'hrms_sync',             label: 'HRMS Integration',     icon: RefreshCw,    matches: ['hrms_sync'] },
    { key: 'alerts',                label: 'Real-Time Alerts',     icon: Bell,         matches: ['alerts'] },
    { key: 'analytics_export',      label: 'Analytics Export',     icon: FileSpreadsheet, matches: ['analytics_export'] },
    { key: 'leave',                 label: 'Leave Management',     icon: Calendar,     matches: ['leave'] },
    { key: 'scheduled_reports',     label: 'Scheduled Reports',    icon: FileSpreadsheet, matches: ['scheduled_reports'] },
    { key: 'system_admin',          label: 'System Admin',         icon: Shield,       matches: ['system_admin'] },
    { key: 'tenant_admin',          label: 'Tenant Admin',         icon: Users,        matches: ['tenant_admin'] },
    { key: 'platform_admin',        label: 'Platform Admin',       icon: Globe,        matches: ['platform_admin'] },
  ];
};

const MASTER_FEATURES: Record<string, { label: string; icon: React.FC<any> }> = {
  attendance: { label: 'Attendance Tracking', icon: Clock },
  student_attendance: { label: 'Student Attendance', icon: Users },
  face_recognition: { label: 'Face Recognition', icon: Camera },
  devices: { label: 'Device Management', icon: Cpu },
  reports: { label: 'Reports & Analytics', icon: BarChart3 },
  hrms_sync: { label: 'HRMS Integration', icon: RefreshCw },
  alerts: { label: 'Real-Time Alerts', icon: Bell },
  analytics_export: { label: 'Analytics Export', icon: FileSpreadsheet },
  leave: { label: 'Leave Management', icon: Calendar },
  scheduled_reports: { label: 'Scheduled Reports', icon: FileSpreadsheet },
  system_admin: { label: 'System Admin', icon: Shield },
  tenant_admin: { label: 'Tenant Admin', icon: Users },
  platform_admin: { label: 'Platform Admin', icon: Globe },
  parent_notifications: { label: 'Parent Notifications', icon: Bell },
  people_counting: { label: 'People Counting', icon: Users },
  live_dashboard: { label: 'Live Dashboard', icon: Presentation },
  analytics: { label: 'Retail Analytics', icon: Eye },
  uniform_detection: { label: 'Uniform Detection', icon: CheckSquare },
  store_management: { label: 'Multi-Store Management', icon: LayoutGrid },
  fleet_management: { label: 'Fleet & Route Management', icon: Bus },
  live_occupancy: { label: 'Live Occupancy', icon: Presentation },
  boarding_events: { label: 'Boarding / Deboarding Events', icon: Users }
};

const getMergedDisplayFeatures = (vertical: string, planFeatures: string[]) => {
  const baseList = [...getFeaturesForVertical(vertical)];
  planFeatures.forEach(pf => {
    // If this feature isn't represented in the base list, append it dynamically
    if (!baseList.some(df => df.matches.some(m => m.toLowerCase() === pf.toLowerCase()))) {
      const fallback = MASTER_FEATURES[pf.toLowerCase()] || { label: pf, icon: Sparkles };
      baseList.push({
        key: pf,
        label: fallback.label,
        icon: fallback.icon,
        matches: [pf.toLowerCase()]
      });
    }
  });
  return baseList;
};
const SESSION_OPTIONS = [
  { value: 120,   label: '2 hours'  },
  { value: 240,   label: '4 hours'  },
  { value: 480,   label: '8 hours'  },
  { value: 1440,  label: '24 hours' },
  { value: 10080, label: '7 days'   },
];

const TIER_STYLE: Record<string, { border: string; bg: string; badge: string; text: string; ring: string }> = {
  basic:              { border: 'border-slate-200',  bg: 'bg-slate-50',   badge: 'bg-slate-100 text-slate-600',  text: 'text-slate-700',  ring: 'ring-slate-400'  },
  smb:                { border: 'border-blue-200',   bg: 'bg-blue-50',    badge: 'bg-blue-100 text-blue-700',    text: 'text-blue-700',   ring: 'ring-blue-500'   },
  enterprise:         { border: 'border-violet-200', bg: 'bg-violet-50',  badge: 'bg-violet-100 text-violet-700',text: 'text-violet-700', ring: 'ring-violet-500' },
  'institute basic':  { border: 'border-emerald-200', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700',text: 'text-emerald-700',ring: 'ring-emerald-500' },
  'education':        { border: 'border-emerald-200', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700',text: 'text-emerald-700',ring: 'ring-emerald-500' },
  'school':           { border: 'border-emerald-200', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700',text: 'text-emerald-700',ring: 'ring-emerald-500' },
  'academic':         { border: 'border-emerald-200', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700',text: 'text-emerald-700',ring: 'ring-emerald-500' },
  'university':       { border: 'border-indigo-200',  bg: 'bg-indigo-50',  badge: 'bg-indigo-100 text-indigo-700',  text: 'text-indigo-700',  ring: 'ring-indigo-500'  },
  'retail starter':   { border: 'border-orange-200',  bg: 'bg-orange-50',  badge: 'bg-orange-100 text-orange-700',  text: 'text-orange-700',  ring: 'ring-orange-400'  },
  'retail pro':       { border: 'border-amber-200',   bg: 'bg-amber-50',   badge: 'bg-amber-100 text-amber-700',    text: 'text-amber-700',   ring: 'ring-amber-500'   },
};

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function FormattedHQAddress({ address }: { address: string }) {
  if (!address || address.trim() === '' || address === '—') return <span className="font-medium text-slate-800">—</span>;

  let parts = address.split(',').map(p => p.trim()).filter(Boolean);
  
  if (parts.length < 3) {
    return <span className="font-medium text-slate-800 text-right ml-auto max-w-[85%]">{address}</span>;
  }

  // Deduplicate consecutive identical parts
  parts = parts.filter((part, index, arr) => index === 0 || part.toLowerCase() !== arr[index - 1].toLowerCase());

  if (parts.length < 3) {
    return <span className="font-medium text-slate-800 text-right ml-auto max-w-[85%]">{parts.join(', ')}</span>;
  }

  const country = parts.pop();
  
  let pincode = '';
  if (parts.length > 0 && /^\d{4,6}(-\d{4})?$/.test(parts[parts.length - 1])) {
    pincode = parts.pop() || '';
  }

  // Split remaining parts dynamically to avoid one very long line
  const midpoint = Math.ceil(parts.length / 2);
  const line1Parts = parts.slice(0, midpoint);
  const line2Parts = parts.slice(midpoint);

  const line1 = line1Parts.join(', ');
  let line2 = line2Parts.join(', ');
  if (pincode) {
    line2 += line2 ? ` - ${pincode}` : pincode;
  }

  return (
    <div className="flex flex-col gap-1 text-right ml-auto max-w-[85%]">
      {line1 && <span className="font-medium text-slate-800 leading-snug">{line1}</span>}
      {line2 && <span className="text-slate-600 text-sm leading-snug">{line2}</span>}
      {country && <span className="text-slate-400 text-xs font-semibold">{country}</span>}
    </div>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────────────
const StepIndicator: React.FC<{ current: number }> = ({ current }) => (
  <div className="relative flex flex-col gap-6 w-40 shrink-0">
    <div className="absolute left-4 top-4 bottom-4 w-px bg-slate-100" />
    {WIZARD_STEPS.map((s, i) => {
      const done   = i < current;
      const active = i === current;
      const Icon   = s.icon;
      return (
        <div key={s.key} className="relative flex items-center gap-3 z-10">
          <div className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all duration-300',
            done   ? 'bg-emerald-500 text-white shadow-sm'  :
            active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' :
                     'bg-white border-2 border-slate-200 text-slate-400'
          )}>
            {done ? <Check className="w-4 h-4" /> : <Icon className="w-3.5 h-3.5" />}
          </div>
          <div>
            <p className={cn('text-xs font-semibold leading-none',
              active ? 'text-slate-800' : done ? 'text-emerald-600' : 'text-slate-400'
            )}>{s.label}</p>
            {active && <p className="text-xs text-slate-400 mt-0.5">In progress</p>}
            {done   && <p className="text-xs text-emerald-500 mt-0.5">Complete</p>}
          </div>
        </div>
      );
    })}
  </div>
);

// ── Tier card (Step 0) ────────────────────────────────────────────────────────
const TierCard: React.FC<{ type: TenantType; selected: boolean; onSelect: () => void; vertical: string }> = ({ type, selected, onSelect, vertical }) => {
  const style = TIER_STYLE[type.name.toLowerCase()] ?? TIER_STYLE.basic;
  const planFeatures = type.features ?? [];
  const featureCount = planFeatures.length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-xl border-2 p-4 transition-all duration-200 hover:shadow-md',
        selected ? `${style.border} ${style.bg} ring-2 ${style.ring} shadow-sm` : 'border-slate-200 bg-white hover:border-slate-300'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full', style.badge)}>
            {type.name}
          </span>
          {selected && <Check className={cn('w-4 h-4', style.text)} />}
        </div>
        <span className="text-xs text-slate-400 font-medium">{featureCount} feature{featureCount !== 1 ? 's' : ''}</span>
      </div>

      {type.description && (
        <p className="text-xs text-slate-500 mb-3">{type.description}</p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {planFeatures.length === 0 ? (
          <span className="text-xs text-slate-400 italic">No features configured</span>
        ) : (
          planFeatures.map(pf => {
            const key = pf.toLowerCase();
            const info = MASTER_FEATURES[key] || { label: pf.replace(/_/g, ' '), icon: Sparkles };
            const Icon = info.icon || Sparkles;
            return (
              <span key={pf} className={cn(
                'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border',
                style.badge, 'border-transparent'
              )}>
                <Icon className="w-2.5 h-2.5" />
                {info.label}
              </span>
            );
          })
        )}
      </div>
    </button>
  );
};

// ── Preview panels ─────────────────────────────────────────────────────────────
const OrgPreview: React.FC<{ data: WizardData; types: TenantType[] }> = ({ data, types }) => {
  const selected = types.find(t => t.id === data.tenantTypeId);
  const planFeatures = selected?.features ?? [];
  const style = TIER_STYLE[selected?.name?.toLowerCase() ?? ''] ?? TIER_STYLE.basic;

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Estimated Result</p>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
            <Building2 className="w-5 h-5 text-violet-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-800 text-sm break-all">
              {data.tenantName || <span className="text-slate-300 font-normal">Tenant name…</span>}
            </p>
            {selected && (
              <span className={cn('text-xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full inline-block mt-1 truncate max-w-full', style.badge)}>
                {selected.name}
              </span>
            )}
          </div>
        </div>
      </div>

      {selected ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-500">Features included ({planFeatures.length})</p>
          {planFeatures.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No features configured for this tier.</p>
          ) : (
            planFeatures.map(pf => {
              const key = pf.toLowerCase();
              const info = MASTER_FEATURES[key] || { label: pf.replace(/_/g, ' '), icon: Sparkles };
              const Icon = info.icon || Sparkles;
              return (
                <div key={pf} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-emerald-100 bg-emerald-50 text-sm transition-colors">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-emerald-500">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                  <Icon className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                  <span className="text-slate-700 font-medium">{info.label}</span>
                </div>
              );
            })
          )}
          <p className="text-xs text-slate-400 pt-1 italic">
            {planFeatures.length} feature{planFeatures.length !== 1 ? 's' : ''} enabled for this tier.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center">
          <p className="text-xs text-slate-400">Select a tier to see included features.</p>
        </div>
      )}
    </div>
  );
};

const LocationPreview: React.FC<{ data: WizardData }> = ({ data }) => (
  <div className="space-y-3">
    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Corporate HQ</p>
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-indigo-500" />
        <span className="font-semibold text-indigo-700 text-sm">Location Setup</span>
      </div>
      {[
        { label: 'Country', val: data.country || '—' },
        { label: 'City',    val: data.city || '—' },
        { label: 'Address', val: data.locationAddress || '—' },
      ].map(({ label, val }) => (
        <div key={label} className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-indigo-100">
          <span className="text-slate-500 text-xs">{label}</span>
          <span className="font-medium text-slate-800 text-xs truncate max-w-[120px]">{val}</span>
        </div>
      ))}
      {data.latitude !== null && data.longitude !== null && !isNaN(Number(data.latitude)) && !isNaN(Number(data.longitude)) && (
        <div className="h-36 rounded-xl overflow-hidden border border-slate-200 mt-2 z-0 relative bg-slate-50">
          <style>{`.leaflet-control-attribution { display: none !important; }`}</style>
          <MapContainer
            key={`${data.latitude}-${data.longitude}`}
            center={[Number(data.latitude), Number(data.longitude)]}
            zoom={12}
            minZoom={2}
            maxBounds={[[-85, -180], [85, 180]]}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
            scrollWheelZoom={false}
            dragging={false}
            attributionControl={false}
          >
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
              maxZoom={19}
            />
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
              attribution=''
              maxZoom={19}
            />
            <Marker position={[Number(data.latitude), Number(data.longitude)]} />
          </MapContainer>
          {/* Overlay label at bottom */}
          <div className="absolute bottom-0 left-0 right-0 z-[500] bg-white/90 backdrop-blur-sm px-2 py-1 border-t border-slate-100 flex items-center gap-1.5">
            <MapPin className="w-3 h-3 text-indigo-600 shrink-0" />
            <span className="text-[10px] text-slate-600 truncate">
              {Number(data.latitude).toFixed(4)}° N, {Number(data.longitude).toFixed(4)}° E
            </span>
          </div>
        </div>
      )}
    </div>
  </div>
);

const RealmPreview: React.FC<{ data: WizardData }> = ({ data }) => (
  <div className="space-y-3">
    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Estimated Result</p>
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="w-4 h-4 text-indigo-500" />
        <span className="font-semibold text-indigo-700 text-sm">Realm Provisioned</span>
      </div>
      {[
        { label: 'Slug',         val: data.realmSlug || '—',     mono: true },
        { label: 'Display Name', val: data.realmName || '—',     mono: false },
        { label: 'Domain',       val: data.domain    || 'not set', mono: false },
      ].map(({ label, val, mono }) => (
        <div key={label} className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-indigo-100">
          <span className="text-slate-500 text-xs">{label}</span>
          {mono
            ? <code className="text-indigo-700 font-mono text-xs bg-indigo-50 px-2 py-0.5 rounded">{val}</code>
            : <span className="text-slate-700 font-medium text-xs">{val}</span>
          }
        </div>
      ))}
      <p className="text-xs text-slate-400 italic">Isolated identity namespace for this tenant.</p>
    </div>
  </div>
);

const SecurityPreview: React.FC<{ data: WizardData }> = ({ data }) => {
  const sessionLabel = SESSION_OPTIONS.find(s => s.value === data.sessionTimeout)?.label ?? '—';
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Estimated Result</p>
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-4 h-4 text-emerald-600" />
          <span className="font-semibold text-emerald-700 text-sm">Security Policy</span>
        </div>
        {[
          { icon: Clock, label: 'Session duration',    val: sessionLabel },
          { icon: Lock,  label: 'Max failed logins',   val: `${data.maxFailedLogins} attempts` },
          { icon: Clock, label: 'Lockout duration',    val: `${data.lockoutDurationMinutes} mins` },
          { icon: Lock,  label: 'Min password length', val: `${data.passwordMinLength} characters` },
        ].map(({ icon: Icon, label, val }) => (
          <div key={label} className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-emerald-100">
            <div className="flex items-center gap-2 text-slate-500 text-xs">
              <Icon className="w-3.5 h-3.5" />{label}
            </div>
            <span className="text-slate-700 font-medium text-xs">{val}</span>
          </div>
        ))}
        <p className="text-xs text-slate-400 italic pt-1">Applied to all users in this realm.</p>
      </div>
    </div>
  );
};

const AdminPreview: React.FC<{ data: WizardData }> = ({ data }) => (
  <div className="space-y-3">
    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Estimated Result</p>
    <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus className="w-4 h-4 text-violet-600" />
        <span className="font-semibold text-violet-700 text-sm">Tenant Admin Account</span>
      </div>
      <div className="flex items-center gap-3 bg-white rounded-lg px-3 py-3 border border-violet-100">
        <div className="w-9 h-9 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4 text-violet-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">
            {data.adminName || <span className="text-slate-300 font-normal">Name…</span>}
          </p>
          <p className="text-xs text-slate-400 truncate">
            {data.adminEmail || <span className="text-slate-300">email…</span>}
          </p>
        </div>
      </div>
      <div className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-violet-100">
        <span className="text-slate-500 text-xs">Role</span>
        <span className="text-xs font-semibold bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">tenant_admin</span>
      </div>
      <div className="flex justify-between items-center bg-white rounded-lg px-3 py-2 border border-violet-100">
        <span className="text-slate-500 text-xs">Credentials</span>
        <span className="text-xs text-slate-600 flex items-center gap-1">
          <Mail className="w-3 h-3" /> Sent via email
        </span>
      </div>
      <p className="text-xs text-slate-400 italic">A welcome email with login credentials will be sent after creation.</p>
    </div>
  </div>
);

const ReviewPreview: React.FC<{ steps: CreationStep[] }> = ({ steps }) => (
  <div className="space-y-3">
    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Creation Progress</p>
    <div className="space-y-2">
      {steps.map(s => (
        <div key={s.key} className={cn(
          'flex items-start gap-3 rounded-xl p-3 border transition-all duration-300',
          s.status === 'done'    ? 'border-emerald-200 bg-emerald-50'  :
          s.status === 'running' ? 'border-indigo-200 bg-indigo-50'    :
          s.status === 'error'   ? 'border-red-200 bg-red-50'          :
                                   'border-slate-100 bg-slate-50'
        )}>
          <div className="mt-0.5 shrink-0">
            {s.status === 'done'    && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
            {s.status === 'running' && <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />}
            {s.status === 'error'   && <AlertTriangle className="w-4 h-4 text-red-500" />}
            {s.status === 'pending' && <Circle className="w-4 h-4 text-slate-300" />}
          </div>
          <div>
            <p className={cn('text-xs font-medium',
              s.status === 'done'    ? 'text-emerald-700' :
              s.status === 'running' ? 'text-indigo-700'  :
              s.status === 'error'   ? 'text-red-700'     : 'text-slate-400'
            )}>{s.label}</p>
            <p className="text-xs text-slate-400 mt-0.5">{s.detail}</p>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ── Main wizard ────────────────────────────────────────────────────────────────
export const CreateTenantWizard: React.FC<Props> = ({ tenantTypes, onSuccess, onCancel }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const [data, setData] = useState<WizardData>({
    tenantName: '', tenantTypeId: '',
    realmSlug: '', realmName: '', domain: '',
    sessionTimeout: 480, maxFailedLogins: 5, passwordMinLength: 8, lockoutDurationMinutes: 15,
    adminName: '', adminEmail: '',
    vertical: 'corporate',
    city: '', country: '', locationAddress: '',
    latitude: null, longitude: null,
  });

  const set = (patch: Partial<WizardData>) => setData(d => ({ ...d, ...patch }));

  useEffect(() => {
    const trimmed = data.tenantName.trim();
    const validTenantNamePattern = /^[a-zA-Z0-9]+(?: [a-zA-Z0-9]+)+$/;
    if (validTenantNamePattern.test(trimmed)) {
      set({ realmSlug: slugify(trimmed), realmName: trimmed });
    } else if (trimmed === '') {
      set({ realmSlug: '', realmName: '' });
    }
  }, [data.tenantName]);

  useEffect(() => {
    const groupDetail = data.vertical === 'education'
      ? 'Institution Admins · Principals · Operators Team'
      : data.vertical === 'retail'
        ? 'Store Owners · Store Managers · Counter Devices'
        : data.vertical === 'transport'
          ? 'Transport Admins · Route Managers · Operations Team'
          : 'Tenant Admins · Site Managers · HR Team';
    setCreationSteps(prev => prev.map(s => s.key === 'groups' ? { ...s, detail: groupDetail } : s));
  }, [data.vertical]);

  const [creationSteps, setCreationSteps] = useState<CreationStep[]>([
    { key: 'tenant',   label: 'Creating tenant record',    detail: 'Inserting into frs_tenant',              status: 'pending' },
    { key: 'config',   label: 'Applying UI configuration', detail: 'Seeding features from tenant type',      status: 'pending' },
    { key: 'realm',    label: 'Provisioning realm',        detail: 'Creating isolated identity namespace',   status: 'pending' },
    { key: 'groups',   label: 'Setting up default groups', detail: 'Tenant Admins · Site Managers · HR Team', status: 'pending' },
    { key: 'admin',    label: 'Creating tenant admin',     detail: 'Provisioning admin user account',        status: 'pending' },
    { key: 'email',    label: 'Sending invite email',       detail: 'Dispatching password setup link to admin', status: 'pending' },
    { key: 'complete', label: 'Tenant is live',            detail: 'All resources provisioned successfully', status: 'pending' },
  ]);

  const patchStep = (key: string, status: CreationStep['status']) =>
    setCreationSteps(prev => prev.map(s => s.key === key ? { ...s, status } : s));

  const canNext = () => {
    if (step === 0) {
      const isTenantNameValid = data.tenantName.trim().length >= 2 && data.tenantName.length <= 30 && fieldError?.field !== 'tenantName';
      return isTenantNameValid && data.tenantTypeId.length > 0;
    }
    if (step === 1) {
      const hasPickedLocation = data.latitude !== null && data.longitude !== null;
      const isAddressValid = data.locationAddress.trim().length > 0;
      return hasPickedLocation && isAddressValid;
    }
    if (step === 2) {
      const trimmedRealmSlug = data.realmSlug.trim();
      const trimmedRealmName = data.realmName.trim();
      const validRealmNamePattern = /^[a-zA-Z0-9\s\-_&',.]+$/;
      const domainInvalid = data.domain ? /[,\/\\{}_+=\[\];:"'?<>]/.test(data.domain) : false;
      return trimmedRealmSlug.length > 0 && trimmedRealmName.length > 0 && validRealmNamePattern.test(trimmedRealmName) && !domainInvalid;
    }
    if (step === 4) {
      const trimmedAdminName = data.adminName.trim();
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const emailOk = emailPattern.test(data.adminEmail.trim());
      const nameIsEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedAdminName);
      const validNamePattern = /^[a-zA-Z\s]+$/;
      const nameValidChars = trimmedAdminName.length > 0 ? validNamePattern.test(trimmedAdminName) : false;
      return trimmedAdminName.length > 0 && !nameIsEmail && nameValidChars && emailOk;
    }
    return true;
  };

  const handleCreate = async () => {
    setSaving(true);
    const keys = ['tenant', 'config', 'realm', 'groups', 'admin', 'email'];
    let idx = 0;
    const interval = setInterval(() => {
      if (idx > 0) patchStep(keys[idx - 1], 'done');
      if (idx < keys.length) { patchStep(keys[idx], 'running'); idx++; }
      else clearInterval(interval);
    }, 400);

    try {
      await apiRequest('/app-admin/tenants', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          name:              data.tenantName.trim(),
          tenantTypeId:      data.tenantTypeId || undefined,
          vertical:          data.vertical,
          realmSlug:         data.realmSlug.trim(),
          realmName:         data.realmName.trim(),
          domain:            data.domain.trim() || undefined,
          sessionTimeout:         data.sessionTimeout,
          maxFailedLogins:        data.maxFailedLogins,
          passwordMinLength:      data.passwordMinLength,
          lockoutDurationMinutes: data.lockoutDurationMinutes,
          adminName:         data.adminName.trim(),
          adminEmail:        data.adminEmail.trim(),
          city:              data.city,
          country:           data.country,
          locationAddress:   data.locationAddress,
          latitude:          data.latitude,
          longitude:         data.longitude,
        }),
      });
      clearInterval(interval);
      keys.forEach(k => patchStep(k, 'done'));
      setTimeout(() => { patchStep('complete', 'done'); setDone(true); toast.success('Tenant created successfully.'); }, 300);
    } catch (e: any) {
      clearInterval(interval);
      keys.forEach((k, i) => patchStep(k, i < idx ? 'done' : i === idx ? 'error' : 'pending'));
      if (e instanceof ApiError && e.field === 'realmSlug') {
        setFieldError({ field: 'realmSlug', message: e.message });
        setStep(2); // Step 2 = Realm Identity
        setCreationSteps(prev => prev.map(s => ({ ...s, status: 'pending' })));
      } else if (e instanceof ApiError && e.field === 'adminEmail') {
        setFieldError({ field: 'adminEmail', message: e.message });
        setStep(4); // Step 4 = Tenant Admin
        setCreationSteps(prev => prev.map(s => ({ ...s, status: 'pending' })));
      } else {
        setFieldError(null);
        toast.error(e.message ?? 'Failed to create tenant');
      }
      setSaving(false);
    }
  };

  // ── Form panels ──────────────────────────────────────────────────────────────
  const renderForm = () => {
    switch (step) {
      case 0: {
        const filteredTiers = tenantTypes.filter(t => t.vertical === data.vertical);
        const trimmedTenantName = data.tenantName.trim();
        const hasTenantNameError = fieldError?.field === 'tenantName';
        return (
          <div className="space-y-5 flex-1 overflow-y-auto pr-1">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Organization Details</h2>
              <p className="text-xs text-slate-500 mt-0.5">Name the tenant, pick a vertical, and select a service tier.</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <Label>Tenant Name <span className="text-rose-500">*</span></Label>
                <span className="text-xs text-slate-400 font-mono">{data.tenantName.length}/30</span>
              </div>
              <Input autoFocus placeholder="e.g. Acme Corporation"
                value={data.tenantName} 
                maxLength={30}
                onBlur={() => {
                  set({ tenantName: data.tenantName.trim() });
                  if (data.tenantName.trim().length > 0 && data.tenantName.trim().length < 2) {
                    setFieldError({ field: 'tenantName', message: 'Tenant Name must be between 2 and 30 characters.' });
                  }
                }}
                onChange={e => {
                  const val = e.target.value;
                  
                  if (val.startsWith(' ')) {
                    setFieldError({ field: 'tenantName', message: 'Tenant Name cannot start with a space.' });
                    return;
                  }
                  if (/\s{2,}/.test(val)) {
                    setFieldError({ field: 'tenantName', message: 'Consecutive spaces are not allowed.' });
                    return;
                  }
                  if (/-{2,}/.test(val)) {
                    setFieldError({ field: 'tenantName', message: 'Consecutive hyphens (--) are not allowed.' });
                    return;
                  }
                  if (/[^a-zA-Z0-9\s-]/.test(val)) {
                    setFieldError({ field: 'tenantName', message: 'Only letters, numbers, spaces, and hyphens are allowed.' });
                    return;
                  }

                  set({ tenantName: val });

                  if (val.length > 0) {
                    if (val.length === 30) {
                      setFieldError({ field: 'tenantName', message: 'Maximum limit of 30 characters reached.' });
                    } else if (val.trim().length > 0 && val.trim().length < 2) {
                      setFieldError({ field: 'tenantName', message: 'Tenant Name must be between 2 and 30 characters.' });
                    } else if (val.trim().length > 0 && /^\d+$/.test(val.trim())) {
                      setFieldError({ field: 'tenantName', message: 'Tenant Name cannot be purely numeric.' });
                    } else {
                      if (fieldError?.field === 'tenantName') setFieldError(null);
                    }
                  } else {
                    if (fieldError?.field === 'tenantName') setFieldError(null);
                  }
                }}
                className={hasTenantNameError ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : ''}
              />
              {hasTenantNameError && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Tenant Vertical <span className="text-rose-500">*</span></Label>
              <p className="text-xs text-slate-400 -mt-1">Choose the business sector for this tenant.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <button
                  type="button"
                  onClick={() => set({ vertical: 'corporate', tenantTypeId: '' })}
                  className={cn(
                    'flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl border-2 transition-all duration-200 hover:shadow-sm text-center min-w-0',
                    data.vertical === 'corporate'
                      ? 'border-indigo-500 bg-indigo-50/50 text-indigo-700 font-semibold ring-2 ring-indigo-500/20'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  )}
                >
                  <span className="text-xl mb-1">🏢</span>
                  <span className="text-xs sm:text-sm truncate w-full font-medium">Corporate</span>
                  <span className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight truncate w-full">Offices, factories</span>
                </button>
                <button
                  type="button"
                  onClick={() => set({ vertical: 'education', tenantTypeId: '' })}
                  className={cn(
                    'flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl border-2 transition-all duration-200 hover:shadow-sm text-center min-w-0',
                    data.vertical === 'education'
                      ? 'border-indigo-500 bg-indigo-50/50 text-indigo-700 font-semibold ring-2 ring-indigo-500/20'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  )}
                >
                  <span className="text-xl mb-1">🎓</span>
                  <span className="text-xs sm:text-sm truncate w-full font-medium">Education</span>
                  <span className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight truncate w-full">Schools, colleges</span>
                </button>
                <button
                  type="button"
                  onClick={() => set({ vertical: 'retail', tenantTypeId: '' })}
                  className={cn(
                    'flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl border-2 transition-all duration-200 hover:shadow-sm text-center min-w-0',
                    data.vertical === 'retail'
                      ? 'border-orange-500 bg-orange-50/50 text-orange-700 font-semibold ring-2 ring-orange-500/20'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  )}
                >
                  <span className="text-xl mb-1">🏪</span>
                  <span className="text-xs sm:text-sm truncate w-full font-medium">Retail / Store</span>
                  <span className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight truncate w-full">Footfall & occupancy</span>
                </button>
                <button
                  type="button"
                  onClick={() => set({ vertical: 'transport', tenantTypeId: '' })}
                  className={cn(
                    'flex flex-col items-center justify-center p-2.5 sm:p-3 rounded-xl border-2 transition-all duration-200 hover:shadow-sm text-center min-w-0',
                    data.vertical === 'transport'
                      ? 'border-emerald-500 bg-emerald-50/50 text-emerald-700 font-semibold ring-2 ring-emerald-500/20'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  )}
                >
                  <span className="text-xl mb-1">🚌</span>
                  <span className="text-xs sm:text-sm truncate w-full font-medium">Transport</span>
                  <span className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight truncate w-full">Fleet & occupancy</span>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Service Tier <span className="text-rose-500">*</span></Label>
              <p className="text-xs text-slate-400 -mt-1">Select the tier that matches this tenant's plan.</p>
              <div className="space-y-2.5">
                {filteredTiers.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No plans configured for this vertical yet.</p>
                ) : (
                  filteredTiers.map(t => (
                    <TierCard
                      key={t.id}
                      type={t}
                      selected={data.tenantTypeId === t.id}
                      onSelect={() => set({ tenantTypeId: t.id })}
                      vertical={data.vertical}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        );
      }

      case 1: {
        return (
          <div className="space-y-5 flex-1">
            <div>
              <h2 className="text-base font-semibold text-slate-800">HQ Location & Address</h2>
              <p className="text-xs text-slate-500 mt-0.5">Search for the headquarters building or address and drop a precise pin.</p>
            </div>

            <div className="space-y-1.5">
              <Label>Precise Location <span className="text-rose-500">*</span></Label>
              <LocationPicker
                initialLatitude={data.latitude}
                initialLongitude={data.longitude}
                initialDisplayName={data.locationAddress || undefined}
                onLocationSelected={(loc) => set({
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  city: loc.city || data.city,
                  country: loc.country || data.country,
                  locationAddress: loc.displayName || data.locationAddress,
                })}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Country</Label>
                <Input
                  placeholder="Country"
                  value={data.country}
                  onChange={e => set({ country: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input
                  placeholder="City"
                  value={data.city}
                  onChange={e => set({ city: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Street Address <span className="text-rose-500">*</span></Label>
              <Input
                placeholder="e.g. Building 4B, Mindspace IT Park, Madhapur"
                value={data.locationAddress}
                onBlur={() => set({ locationAddress: data.locationAddress.trim() })}
                onChange={e => set({ locationAddress: e.target.value })}
              />
            </div>

            <div className={cn(
              "rounded-xl border p-3.5 flex items-start gap-2.5 transition-all text-xs",
              (data.latitude !== null && data.longitude !== null)
                ? "bg-emerald-50/50 border-emerald-100 text-emerald-800"
                : "bg-slate-50 border-slate-100 text-slate-500"
            )}>
              <MapPin className={cn("w-4 h-4 shrink-0 mt-0.5", (data.latitude !== null && data.longitude !== null) ? "text-emerald-500" : "text-slate-400")} />
              <div>
                <p className="font-semibold">{(data.latitude !== null && data.longitude !== null) ? "Location Resolved" : "Search for a building or place name above to set a precise pin"}</p>
                <p className="mt-0.5 leading-relaxed text-[11px]">
                  {(data.latitude !== null && data.longitude !== null)
                    ? `📍 Assigned coordinates: ${data.latitude?.toFixed(4)}° N, ${data.longitude?.toFixed(4)}° E — country/city/address above were filled in from the pick and can be edited.`
                    : "Country, city, and address will be filled in automatically once a location is picked."}
                </p>
              </div>
            </div>
          </div>
        );
      }

      case 2: {
        const trimmedRealmName = data.realmName.trim();
        const isRealmNameWhitespaceOnly = data.realmName.length > 0 && trimmedRealmName.length === 0;
        const validRealmNamePattern = /^[a-zA-Z0-9\s\-_&',.]+$/;
        const isRealmNameInvalidChars = trimmedRealmName.length > 0 && !validRealmNamePattern.test(trimmedRealmName);
        const hasRealmNameError = isRealmNameWhitespaceOnly || isRealmNameInvalidChars;

        return (
          <div className="space-y-5 flex-1">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Realm Identity</h2>
              <p className="text-xs text-slate-500 mt-0.5">Define the tenant's unique identity namespace.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Realm Slug <span className="text-rose-500">*</span></Label>
              <Input
                placeholder="acme-corporation"
                value={data.realmSlug}
                onBlur={() => set({ realmSlug: data.realmSlug.trim() })}
                onChange={e => { set({ realmSlug: slugify(e.target.value) }); setFieldError(null); }}
                className={fieldError?.field === 'realmSlug' ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : ''}
              />
              {fieldError?.field === 'realmSlug' ? (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {fieldError.message}
                </p>
              ) : (
                <p className="text-xs text-slate-400">Auto-generated from the tenant name — you can edit it.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Display Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="Acme Corporation" value={data.realmName}
                onBlur={() => set({ realmName: data.realmName.trim() })}
                onChange={e => set({ realmName: e.target.value })} 
                className={hasRealmNameError ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : ''}
              />
              {isRealmNameWhitespaceOnly && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Display Name cannot consist only of spaces.
                </p>
              )}
              {isRealmNameInvalidChars && !isRealmNameWhitespaceOnly && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Only alphanumeric characters and standard punctuation (-, _, &, ', .) are allowed.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Custom Domain <span className="text-slate-400 font-normal text-xs">(optional)</span></Label>
              <Input placeholder="acme.frs.app" value={data.domain}
                onBlur={() => set({ domain: data.domain.trim() })}
                onChange={e => set({ domain: e.target.value })}
                className={data.domain && /[,\/\\{}_+=\[\];:"'?<>]/.test(data.domain) ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : ''}
              />
              {data.domain && /[,\/\\{}_+=\[\];:"'?<>]/.test(data.domain) ? (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Custom Domain contains invalid characters. Please enter a valid value.
                </p>
              ) : (
                <p className="text-xs text-slate-400">Leave blank if not using a custom domain yet.</p>
              )}
            </div>
          </div>
        );
      }

      case 3: return (
        <div className="space-y-6 flex-1">
          <div>
            <h2 className="text-base font-semibold text-slate-800">Security Policy</h2>
            <p className="text-xs text-slate-500 mt-0.5">Set auth and password policies for this realm.</p>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />Session Duration
            </Label>
            <p className="text-xs text-slate-400">Users are signed out after this period of inactivity.</p>
            <div className="flex flex-wrap gap-2">
              {SESSION_OPTIONS.map(o => (
                <button key={o.value} type="button"
                  onClick={() => set({ sessionTimeout: o.value })}
                  className={cn(
                    'px-3 py-1.5 rounded-lg border text-sm font-medium transition-all',
                    data.sessionTimeout === o.value
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-400" />Max Failed Login Attempts
            </Label>
            <p className="text-xs text-slate-400">Account is locked after this many consecutive failures.</p>
            <div className="flex gap-2">
              {[3, 5, 10].map(n => (
                <button key={n} type="button"
                  onClick={() => set({ maxFailedLogins: n })}
                  className={cn(
                    'px-4 py-1.5 rounded-lg border text-sm font-medium transition-all',
                    data.maxFailedLogins === n
                      ? 'border-rose-400 bg-rose-50 text-rose-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}>
                  {n} attempts
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />Account Lockout Duration
            </Label>
            <p className="text-xs text-slate-400">Duration account remains locked after exceeding max failed login attempts.</p>
            <div className="flex gap-2">
              {[
                { val: 5, label: '5 mins' },
                { val: 15, label: '15 mins' },
                { val: 30, label: '30 mins' },
                { val: 60, label: '1 hour' },
              ].map(o => (
                <button key={o.val} type="button"
                  onClick={() => set({ lockoutDurationMinutes: o.val })}
                  className={cn(
                    'px-4 py-1.5 rounded-lg border text-sm font-medium transition-all',
                    data.lockoutDurationMinutes === o.val
                      ? 'border-amber-500 bg-amber-50 text-amber-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-400" />Minimum Password Length
            </Label>
            <div className="flex gap-2">
              {[6, 8, 12, 16].map(n => (
                <button key={n} type="button"
                  onClick={() => set({ passwordMinLength: n })}
                  className={cn(
                    'px-4 py-1.5 rounded-lg border text-sm font-medium transition-all',
                    data.passwordMinLength === n
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}>
                  {n} chars
                </button>
              ))}
            </div>
          </div>
        </div>
      );

      case 4: {
        const trimmedName = data.adminName.trim();
        const nameIsEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedName);
        const isWhitespaceOnly = data.adminName.length > 0 && trimmedName.length === 0;
        const validNamePattern = /^[a-zA-Z\s]+$/;
        const isNameInvalidChars = trimmedName.length > 0 && !validNamePattern.test(trimmedName);
        const hasNameError = nameIsEmail || isWhitespaceOnly || isNameInvalidChars;

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmailInvalid = data.adminEmail.length > 0 && !emailPattern.test(data.adminEmail.trim());

        return (
          <div className="space-y-5 flex-1">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Tenant Administrator</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Create the first admin for this tenant. They'll receive an invite email to set their own password.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Full Name <span className="text-rose-500">*</span></Label>
              <Input
                autoFocus
                placeholder="e.g. Jane Smith"
                value={data.adminName}
                onBlur={() => set({ adminName: data.adminName.trim() })}
                onChange={e => set({ adminName: e.target.value })}
                className={hasNameError ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : ''}
              />
              {nameIsEmail && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Full Name cannot be an email address.
                </p>
              )}
              {isWhitespaceOnly && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Full Name cannot consist only of spaces.
                </p>
              )}
              {isNameInvalidChars && !isWhitespaceOnly && (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Only alphabetic characters (A–Z, a–z) are allowed.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Email Address <span className="text-rose-500">*</span></Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  type="email"
                  placeholder="admin@acme.com"
                  className={cn("pl-9", (isEmailInvalid || fieldError?.field === 'adminEmail') ? 'border-rose-500 ring-1 ring-rose-400 focus-visible:ring-rose-400' : '')}
                  value={data.adminEmail}
                  onBlur={() => set({ adminEmail: data.adminEmail.trim() })}
                  onChange={e => { set({ adminEmail: e.target.value }); setFieldError(null); }}
                />
              </div>
              {isEmailInvalid ? (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Please enter a valid email address.
                </p>
              ) : fieldError?.field === 'adminEmail' ? (
                <p className="text-xs text-rose-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {fieldError.message}
                </p>
              ) : (
                <p className="text-xs text-slate-400">This will be their login email.</p>
              )}
            </div>

            <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 flex items-start gap-2">
              <Mail className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
              <p className="text-xs text-indigo-700">
                An <strong>invite email</strong> with a password setup link will be sent to{' '}
                <strong>{data.adminEmail || 'the admin'}</strong>. They will choose their own password to access FRS.
              </p>
            </div>
          </div>
        );
      }

      case 5: return (
        <div className="space-y-4 flex-1">
          <div>
            <h2 className="text-base font-semibold text-slate-800">Review & Create</h2>
            <p className="text-xs text-slate-500 mt-0.5">Confirm everything before provisioning.</p>
          </div>

          <div className="rounded-xl border border-slate-200 overflow-hidden">
            {[
              { label: 'Tenant',       val: data.tenantName },
              { label: 'Tier',         val: tenantTypes.find(t => t.id === data.tenantTypeId)?.name ?? 'None' },
              { label: 'HQ Country',   val: data.country || '—' },
              { label: 'HQ City',      val: data.city || '—' },
              { label: 'HQ Address',   val: data.locationAddress || '—', isAddress: true },
              { label: 'Realm Slug',   val: data.realmSlug, mono: true },
              { label: 'Domain',       val: data.domain || 'not set' },
              { label: 'Session',          val: SESSION_OPTIONS.find(s => s.value === data.sessionTimeout)?.label ?? '—' },
              { label: 'Max Logins',       val: `${data.maxFailedLogins} attempts` },
              { label: 'Lockout Duration', val: `${data.lockoutDurationMinutes} mins` },
              { label: 'Min Password',     val: `${data.passwordMinLength} chars` },
            ].map((item, i, arr) => (
              <div key={item.label} className={cn(
                'flex justify-between items-start px-4 py-2.5 text-sm',
                i < arr.length - 1 ? 'border-b border-slate-100' : '',
                i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'
              )}>
                <span className="text-slate-500 mt-0.5">{item.label}</span>
                {item.isAddress ? (
                  <FormattedHQAddress address={item.val as string} />
                ) : item.mono
                  ? <code className="text-indigo-700 font-mono text-xs bg-indigo-50 px-2 py-0.5 rounded mt-0.5">{item.val as string}</code>
                  : <span className="font-medium text-slate-800 capitalize mt-0.5">{item.val as string}</span>
                }
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3 space-y-1">
            <div className="flex items-center gap-2">
              <UserPlus className="w-3.5 h-3.5 text-violet-500" />
              <span className="text-xs font-semibold text-violet-700">Tenant Admin</span>
            </div>
            <p className="text-xs text-slate-600 ml-5">{data.adminName} · <span className="text-slate-400">{data.adminEmail}</span></p>
          </div>

          <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 flex items-start gap-2">
            <Users className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
            <p className="text-xs text-indigo-700">
              3 default groups will be seeded:{' '}
              {data.vertical === 'education' ? (
                <>
                  <strong>Institution Admins</strong>, <strong>Principals</strong>, <strong>Operators Team</strong>.
                </>
              ) : data.vertical === 'retail' ? (
                <>
                  <strong>Store Owners</strong>, <strong>Store Managers</strong>, <strong>Counter Devices</strong>.
                </>
              ) : data.vertical === 'transport' ? (
                <>
                  <strong>Transport Admins</strong>, <strong>Route Managers</strong>, <strong>Operations Team</strong>.
                </>
              ) : (
                <>
                  <strong>Tenant Admins</strong>, <strong>Site Managers</strong>, <strong>HR Team</strong>.
                </>
              )}
            </p>
          </div>

          {done && (
            <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-5 text-center space-y-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
              <p className="font-semibold text-emerald-700">Tenant created successfully!</p>
              <p className="text-xs text-emerald-600">
                Realm <code className="font-mono bg-emerald-100 px-1.5 py-0.5 rounded">{data.realmSlug}</code> is now live.
                Invite email sent to <strong>{data.adminEmail}</strong>.
              </p>
            </div>
          )}
        </div>
      );
    }
  };

  const renderPreview = () => {
    switch (step) {
      case 0: return <OrgPreview data={data} types={tenantTypes} />;
      case 1: return <LocationPreview data={data} />;
      case 2: return <RealmPreview data={data} />;
      case 3: return <SecurityPreview data={data} />;
      case 4: return <AdminPreview data={data} />;
      case 5: return <ReviewPreview steps={creationSteps} />;
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto lg:overflow-hidden bg-white">
      {/* Mobile horizontal step progress bar */}
      <div className="lg:hidden flex items-center justify-between gap-1 overflow-x-auto pb-3 border-b border-slate-100 shrink-0">
        {WIZARD_STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={s.key} className="flex items-center gap-1.5 shrink-0">
              <span className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold',
                done ? 'bg-emerald-500 text-white' : active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'
              )}>
                {done ? '✓' : i + 1}
              </span>
              <span className={cn('text-xs font-medium', active ? 'text-slate-900 font-bold' : 'text-slate-400')}>
                {s.label}
              </span>
              {i < WIZARD_STEPS.length - 1 && <span className="text-slate-300 mx-1">›</span>}
            </div>
          );
        })}
      </div>

      {/* Desktop Step indicator */}
      <div className="hidden lg:block">
        <StepIndicator current={step} />
      </div>

      {/* Desktop Divider */}
      <div className="hidden lg:block w-px bg-slate-100 shrink-0" />

      {/* Form Container */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {renderForm()}
        </div>
        <div className="flex items-center justify-between pt-4 pb-3 sm:pb-0 mt-auto border-t border-slate-100 bg-white shrink-0 sticky bottom-0 z-10">
          <Button variant="outline" size="sm"
            onClick={step === 0 ? onCancel : () => setStep(s => s - 1)}
            disabled={saving}>
            {step === 0 ? 'Cancel' : '← Back'}
          </Button>
          {step < 5 ? (
            <Button size="sm" onClick={() => {
              if (step === 0) {
                set({ tenantName: data.tenantName.trim() });
              } else if (step === 1) {
                set({ locationAddress: data.locationAddress.trim() });
              } else if (step === 2) {
                set({ realmSlug: data.realmSlug.trim(), realmName: data.realmName.trim(), domain: data.domain.trim() });
              } else if (step === 4) {
                set({ adminName: data.adminName.trim(), adminEmail: data.adminEmail.trim() });
              }
              setStep(s => s + 1);
            }} disabled={!canNext()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5">
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          ) : done ? (
            <Button size="sm" onClick={onSuccess} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              Done →
            </Button>
          ) : (
            <Button size="sm" onClick={handleCreate} disabled={saving}
              className="bg-violet-600 hover:bg-violet-700 text-white gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Provisioning…' : 'Create Tenant & Realm'}
            </Button>
          )}
        </div>
      </div>

      {/* Desktop Divider */}
      <div className="hidden lg:block w-px bg-slate-100 shrink-0" />

      {/* Desktop Preview panel */}
      <div className="hidden lg:block w-60 shrink-0 overflow-y-auto pr-1 max-h-full">
        {renderPreview()}
      </div>
    </div>
  );
};
