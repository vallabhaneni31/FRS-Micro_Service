import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Switch } from '../../../ui/switch';
import { toast } from 'sonner';
import { Loader2, Save, Thermometer, Cpu, MemoryStick, Wifi } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

interface ThresholdConfig {
  cpu_warn: string;
  cpu_crit: string;
  temp_warn: string;
  temp_crit: string;
  ram_warn: string;
  ram_crit: string;
  offline_alert_after_seconds: string;
  accuracy_warn: string;
  alert_enabled: boolean;
}

const DEFAULTS: ThresholdConfig = {
  cpu_warn: '75', cpu_crit: '90',
  temp_warn: '70', temp_crit: '85',
  ram_warn: '80', ram_crit: '95',
  offline_alert_after_seconds: '60',
  accuracy_warn: '80',
  alert_enabled: true,
};

const ThresholdRow = ({
  icon: Icon, label, warnKey, critKey, unit = '%', cfg, set,
}: {
  icon: any; label: string; warnKey: keyof ThresholdConfig; critKey: keyof ThresholdConfig;
  unit?: string; cfg: ThresholdConfig; set: (k: keyof ThresholdConfig, v: any) => void;
}) => (
  <div className="flex items-center gap-4 py-3 border-b border-slate-100 dark:border-slate-800 last:border-0">
    <div className="flex items-center gap-2 w-36">
      <Icon className="w-4 h-4 text-slate-400" />
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
    </div>
    <div className="flex items-center gap-2">
      <Label className="text-[10px] font-bold text-amber-600 uppercase tracking-wide w-10">Warn</Label>
      <div className="flex items-center gap-1">
        <Input type="number" value={cfg[warnKey] as string} onChange={e => set(warnKey, e.target.value)}
          className="w-20 h-8 text-center rounded-lg text-sm border-amber-200 focus:ring-amber-300" />
        <span className="text-xs text-slate-400">{unit}</span>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <Label className="text-[10px] font-bold text-rose-600 uppercase tracking-wide w-10">Crit</Label>
      <div className="flex items-center gap-1">
        <Input type="number" value={cfg[critKey] as string} onChange={e => set(critKey, e.target.value)}
          className="w-20 h-8 text-center rounded-lg text-sm border-rose-200 focus:ring-rose-300" />
        <span className="text-xs text-slate-400">{unit}</span>
      </div>
    </div>
  </div>
);

export const DeviceThresholdSettings: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [cfg, setCfg] = useState<ThresholdConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiRequest<{ data: ThresholdConfig }>('/site/settings/device-thresholds', { accessToken, scopeHeaders })
      .then(res => { if (res?.data) setCfg({ ...DEFAULTS, ...res.data }); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accessToken]);

  const set = (k: keyof ThresholdConfig, v: any) => setCfg(c => ({ ...c, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest('/site/settings/device-thresholds', {
        method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify(cfg),
      });
      toast.success('Thresholds saved');
    } catch {
      toast.error('Failed to save thresholds');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-blue-500 w-6 h-6" /></div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400">Alert Thresholds</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Alerts enabled</span>
            <Switch checked={cfg.alert_enabled} onCheckedChange={v => set('alert_enabled', v)} />
          </div>
        </CardHeader>
        <CardContent>
          <ThresholdRow icon={Cpu}         label="CPU Usage"    warnKey="cpu_warn"  critKey="cpu_crit"  cfg={cfg} set={set} />
          <ThresholdRow icon={Thermometer} label="Temperature"  warnKey="temp_warn" critKey="temp_crit" unit="°C" cfg={cfg} set={set} />
          <ThresholdRow icon={MemoryStick} label="RAM Usage"    warnKey="ram_warn"  critKey="ram_crit"  cfg={cfg} set={set} />

          <div className="flex items-center gap-4 py-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2 w-36">
              <Wifi className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Offline Alert</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Alert after</span>
              <Input type="number" value={cfg.offline_alert_after_seconds}
                onChange={e => set('offline_alert_after_seconds', e.target.value)}
                className="w-20 h-8 text-center rounded-lg text-sm" />
              <span className="text-xs text-slate-400">seconds offline</span>
            </div>
          </div>

          <div className="flex items-center gap-4 py-3">
            <div className="flex items-center gap-2 w-36">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Low Accuracy</span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-[10px] font-bold text-amber-600 uppercase tracking-wide w-10">Warn</Label>
              <Input type="number" value={cfg.accuracy_warn}
                onChange={e => set('accuracy_warn', e.target.value)}
                className="w-20 h-8 text-center rounded-lg text-sm border-amber-200" />
              <span className="text-xs text-slate-400">%</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-slate-400">Thresholds apply to all NUG edge nodes. Changes take effect on next telemetry cycle (~15 s).</p>

      <Button onClick={handleSave} disabled={saving} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl h-11 font-bold gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save Thresholds
      </Button>
    </div>
  );
};
