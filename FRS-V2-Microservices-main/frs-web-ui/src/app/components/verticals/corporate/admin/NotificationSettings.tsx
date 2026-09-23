import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Switch } from '../../../ui/switch';
import { Badge } from '../../../ui/badge';
import { toast } from 'sonner';
import { Loader2, Mail, Bell, Smartphone, Save, AlertTriangle, UserCheck, Wifi } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { ApiError, apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

interface NotifConfig {
  email_enabled: boolean;
  email_recipients: string;          // comma-separated
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_pass: string;
  sms_enabled: boolean;
  sms_recipients: string;
  inapp_enabled: boolean;
  alert_on_device_offline: boolean;
  alert_on_low_accuracy: boolean;
  alert_on_unauthorized_access: boolean;
  alert_on_late_arrival: boolean;
  low_accuracy_threshold: string;
}

const DEFAULTS: NotifConfig = {
  email_enabled: false,
  email_recipients: '',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  sms_enabled: false,
  sms_recipients: '',
  inapp_enabled: true,
  alert_on_device_offline: true,
  alert_on_low_accuracy: true,
  alert_on_unauthorized_access: true,
  alert_on_late_arrival: false,
  low_accuracy_threshold: '80',
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between py-3 border-b border-slate-100 dark:border-slate-800 last:border-0">
    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
    {children}
  </div>
);

export const NotificationSettings: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [cfg, setCfg] = useState<NotifConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiRequest<{ data: NotifConfig }>('/site/settings/notifications', { accessToken, scopeHeaders })
      .then(res => { if (res?.data) setCfg({ ...DEFAULTS, ...res.data }); })
      .catch(() => {/* first-time setup — use defaults */})
      .finally(() => setLoading(false));
  }, [accessToken]);

  const set = (key: keyof NotifConfig, val: any) => setCfg(c => ({ ...c, [key]: val }));
  const getErrorMessage = (err: unknown) => {
    if (err instanceof ApiError || err instanceof Error) return err.message;
    return 'Please try again.';
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest('/site/settings/notifications', {
        method: 'PATCH', accessToken, scopeHeaders,
        body: JSON.stringify(cfg),
      });
      toast.success('Notification settings saved');
    } catch (err) {
      toast.error('Failed to save notification settings', {
        description: getErrorMessage(err),
      });
    } finally { setSaving(false); }
  };

  const handleTestEmail = async () => {
    if (!cfg.email_recipients) { toast.error('Add at least one recipient first'); return; }
    if (cfg.email_enabled && !cfg.smtp_user && !cfg.smtp_host) {
      toast.warning('Using server email defaults for this test');
    }
    setTesting(true);
    try {
      await apiRequest('/site/settings/notifications/test-email', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({ recipients: cfg.email_recipients }),
      });
      toast.success('Test email sent');
    } catch (err) {
      toast.error('Test email failed', {
        description: getErrorMessage(err),
      });
    } finally { setTesting(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-blue-500 w-6 h-6" /></div>;

  return (
    <div className="space-y-6 max-w-2xl">

      {/* ── IN-APP ─────────────────────────────────────────────── */}
      <Card className="border border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
            <Bell className="w-4 h-4" /> In-App Alerts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Enable in-app notifications">
            <Switch checked={cfg.inapp_enabled} onCheckedChange={v => set('inapp_enabled', v)} />
          </Row>
        </CardContent>
      </Card>

      {/* ── ALERT TRIGGERS ────────────────────────────────────── */}
      <Card className="border border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Alert Triggers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Device goes offline">
            <Switch checked={cfg.alert_on_device_offline} onCheckedChange={v => set('alert_on_device_offline', v)} />
          </Row>
          <Row label="Recognition accuracy drops below threshold">
            <div className="flex items-center gap-2">
              <Input
                type="number" min="50" max="100"
                value={cfg.low_accuracy_threshold}
                onChange={e => set('low_accuracy_threshold', e.target.value)}
                className="w-20 h-8 text-center rounded-lg text-sm"
              />
              <span className="text-xs text-slate-400">%</span>
              <Switch checked={cfg.alert_on_low_accuracy} onCheckedChange={v => set('alert_on_low_accuracy', v)} />
            </div>
          </Row>
          <Row label="Unauthorized access attempt">
            <Switch checked={cfg.alert_on_unauthorized_access} onCheckedChange={v => set('alert_on_unauthorized_access', v)} />
          </Row>
          <Row label="Late arrival detected">
            <Switch checked={cfg.alert_on_late_arrival} onCheckedChange={v => set('alert_on_late_arrival', v)} />
          </Row>
        </CardContent>
      </Card>

      {/* ── EMAIL ─────────────────────────────────────────────── */}
      <Card className="border border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
            <Mail className="w-4 h-4" /> Email Notifications
            <Switch checked={cfg.email_enabled} onCheckedChange={v => set('email_enabled', v)} />
          </CardTitle>
        </CardHeader>
        {cfg.email_enabled && (
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Recipients (comma-separated)</Label>
              <Input value={cfg.email_recipients} onChange={e => set('email_recipients', e.target.value)} placeholder="admin@company.com, hr@company.com" className="rounded-xl" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">SMTP Host</Label>
                <Input value={cfg.smtp_host} onChange={e => set('smtp_host', e.target.value)} placeholder="smtp.gmail.com" className="rounded-xl" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">SMTP Port</Label>
                <Input value={cfg.smtp_port} onChange={e => set('smtp_port', e.target.value)} placeholder="587" className="rounded-xl" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">SMTP Username</Label>
                <Input value={cfg.smtp_user} onChange={e => set('smtp_user', e.target.value)} placeholder="noreply@company.com" className="rounded-xl" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">SMTP Password</Label>
                <Input type="password" value={cfg.smtp_pass} onChange={e => set('smtp_pass', e.target.value)} placeholder="••••••••" className="rounded-xl" />
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleTestEmail} disabled={testing} className="rounded-xl gap-2">
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              Send Test Email
            </Button>
            <p className="text-xs text-slate-500">
              Leave SMTP fields blank to use the secure server defaults. Enter a password only when rotating credentials.
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── SMS ───────────────────────────────────────────────── */}
      <Card className="border border-slate-200 shadow-sm dark:border-slate-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
            <Smartphone className="w-4 h-4" /> SMS Notifications
            <Switch checked={cfg.sms_enabled} onCheckedChange={v => set('sms_enabled', v)} />
          </CardTitle>
        </CardHeader>
        {cfg.sms_enabled && (
          <CardContent>
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Phone Numbers (comma-separated, with country code)</Label>
              <Input value={cfg.sms_recipients} onChange={e => set('sms_recipients', e.target.value)} placeholder="+91 98765 43210, +971 50 123 4567" className="rounded-xl" />
            </div>
            <p className="text-xs text-slate-400 mt-2">SMS delivery requires a configured Twilio / SNS gateway on the backend.</p>
          </CardContent>
        )}
      </Card>

      <Button onClick={handleSave} disabled={saving} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl h-11 font-bold gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save Notification Settings
      </Button>
    </div>
  );
};
