import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mail, Clock, Loader2, Globe } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { cn } from '../../ui/utils';
import { toast } from 'sonner';
import { getTimeFormat, saveTimeFormat, type TimeFormat } from '../../../utils/timeFormat';

const RETAIL_BASE = '/v1/retail';

const TIMEZONES = [
  { value: 'Asia/Kolkata', label: 'India Standard Time (Asia/Kolkata)' },
  { value: 'America/Toronto', label: 'Eastern Time - Canada (America/Toronto)' },
  { value: 'America/Winnipeg', label: 'Central Time - Canada (America/Winnipeg)' },
  { value: 'America/Edmonton', label: 'Mountain Time - Canada (America/Edmonton)' },
  { value: 'America/Vancouver', label: 'Pacific Time - Canada (America/Vancouver)' },
  { value: 'America/Halifax', label: 'Atlantic Time - Canada (America/Halifax)' },
  { value: 'America/St_Johns', label: 'Newfoundland Time - Canada (America/St_Johns)' },
  { value: 'America/New_York', label: 'Eastern Time - US (America/New_York)' },
  { value: 'America/Chicago', label: 'Central Time - US (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain Time - US (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time - US (America/Los_Angeles)' },
  { value: 'Europe/London', label: 'UK Time (Europe/London)' },
  { value: 'UTC', label: 'Coordinated Universal Time (UTC)' },
];

export const RetailStoreSettings: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();

  // Profile state
  const [storeId, setStoreId]     = useState<string | null>(null);
  const [storeName, setStoreName] = useState('Flagship - Manhattan North');
  const [profileName, setProfileName] = useState('Sarah Jenkins');
  const [profileEmail, setProfileEmail] = useState('s.jenkins@retailsense.ai');

  // Store timezone state
  const [timezone, setTimezone]       = useState('Asia/Kolkata');
  const [timezoneSaving, setTimezoneSaving] = useState(false);

  // Time format preference (persisted in localStorage)
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(getTimeFormat);

  const handleTimeFormatChange = (fmt: TimeFormat) => {
    setTimeFormat(fmt);
    saveTimeFormat(fmt);
    toast.success(`Time format changed to ${fmt === '12h' ? '12-hour' : '24-hour'}`);
  };

  useEffect(() => {
    if (!accessToken) return;
    // Fetch stores list
    apiRequest(`${RETAIL_BASE}/stores`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        if (r.stores?.length) {
          setStoreId(r.stores[0].id);
          setStoreName(r.stores[0].name || 'Flagship - Manhattan North');
          setTimezone(r.stores[0].timezone || 'Asia/Kolkata');
        }
      })
      .catch(() => {});

    // Fetch profile
    apiRequest(`${RETAIL_BASE}/settings/profile`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        if (r.user) {
          setProfileName(r.user.display_name || 'Sarah Jenkins');
          setProfileEmail(r.user.email || 's.jenkins@retailsense.ai');
        }
      })
      .catch(() => {});
  }, [accessToken]);

  const saveTimezone = async (tz: string) => {
    if (!storeId) return;
    setTimezone(tz);
    setTimezoneSaving(true);
    try {
      await apiRequest(`${RETAIL_BASE}/stores/${storeId}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ timezone: tz }),
      });
      toast.success('Store timezone updated successfully');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update timezone');
    } finally {
      setTimezoneSaving(false);
    }
  };

  const locationId = storeId ? `LOC-${storeId.slice(0, 4).toUpperCase()}-NYC` : 'LOC-992-NYC';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col gap-8 pb-12"
    >
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground mb-1">Store Settings</h2>
        <p className="text-xs text-muted-foreground">
          Manage your retail location's configuration, security protocols, and operational thresholds.
        </p>
      </div>

      {/* Profile Information Card */}
      <Card className="glass-card border shadow-xs">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-6">
            <Mail className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Profile Information</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-wide block mb-2">Store Name</label>
              <p className="w-full bg-muted/60 border border-border/80 rounded-lg px-4 py-2.5 text-xs font-semibold text-foreground">{storeName}</p>
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-wide block mb-2">Location ID</label>
              <p className="w-full bg-muted/60 border border-border/80 rounded-lg px-4 py-2.5 text-xs font-semibold text-muted-foreground select-all">{locationId}</p>
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-wide block mb-2">Manager Name</label>
              <p className="w-full bg-muted/60 border border-border/80 rounded-lg px-4 py-2.5 text-xs font-semibold text-foreground">{profileName}</p>
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-wide block mb-2">Email Address</label>
              <p className="w-full bg-muted/60 border border-border/80 rounded-lg px-4 py-2.5 text-xs font-semibold text-foreground">{profileEmail}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Store Timezone Card */}
      <Card className="glass-card border shadow-xs">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-6">
            <Globe className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Store Timezone</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-5">
            Sets the timezone used for store hours, entries/exits, and daily analytics on this dashboard.
          </p>
          <div className="flex items-center gap-3 max-w-md">
            <select
              value={timezone}
              disabled={timezoneSaving || !storeId}
              onChange={e => saveTimezone(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-xs font-semibold text-foreground disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
            {timezoneSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      </Card>

      {/* Time Format Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="glass-card border shadow-xs">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-6">
              <Clock className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Time Format</h3>
            </div>

            <p className="text-xs text-muted-foreground mb-5">
              Choose how times are displayed across the dashboard, analytics, and reports.
            </p>

            <div className="flex bg-muted rounded-xl p-1 gap-1 border border-border/40 w-max mb-6">
              {(['12h', '24h'] as const).map(fmt => (
                <button
                  key={fmt}
                  onClick={() => handleTimeFormatChange(fmt)}
                  className={cn(
                    "px-5 py-2 text-xs font-bold rounded-lg transition-all border-none cursor-pointer",
                    timeFormat === fmt
                      ? 'bg-background text-primary shadow-xs'
                      : 'text-muted-foreground hover:text-foreground bg-transparent'
                  )}
                >
                  {fmt === '12h' ? '12-Hour' : '24-Hour'}
                </button>
              ))}
            </div>

            <div className="bg-muted/30 border border-border/40 rounded-xl p-4">
              <p className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider mb-2">Preview</p>
              <p className="text-lg font-bold font-mono text-foreground">
                {timeFormat === '12h' ? '02:30 PM' : '14:30'}
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">Current display format</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
};
