import React, { useEffect, useState } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Loader2, Palette, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../../contexts/AuthContext';
import { useManifest } from '../../../../contexts/ManifestContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { PageHeader } from '../../../shared/PageHeader';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';

const FEATURE_OPTIONS = [
  { key: 'attendance',       label: 'Attendance Tracking' },
  { key: 'face_recognition', label: 'Face Recognition' },
  { key: 'devices',          label: 'Device Management' },
  { key: 'reports',          label: 'Reports' },
  { key: 'hrms_sync',        label: 'HRMS Sync' },
  { key: 'workspace_tree',   label: 'Workspace Hierarchy Tree (beta)' },
];

export const TenantUiSettings: React.FC = () => {
  const { accessToken } = useAuth();
  const { manifest, reload } = useManifest();
  const scopeHeaders = useScopeHeaders();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [primaryColor, setPrimaryColor] = useState('#6366f1');
  const [logoUrl, setLogoUrl] = useState('');
  const [features, setFeatures] = useState<string[]>([]);

  useEffect(() => {
    apiRequest<any>('/tenant-admin/ui-config', { accessToken, scopeHeaders })
      .then(data => {
        setPrimaryColor(data.primaryColor ?? '#6366f1');
        setLogoUrl(data.logoUrl ?? '');
        setFeatures(data.enabledFeatures ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accessToken]);

  const toggleFeature = (key: string) => {
    setFeatures(f => f.includes(key) ? f.filter(x => x !== key) : [...f, key]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiRequest('/tenant-admin/ui-config', {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({
          primaryColor,
          logoUrl: logoUrl || null,
          enabledFeatures: features,
        }),
      });
      toast.success('Settings saved');
      reload();
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center h-48 items-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader
        title="Tenant Settings"
        icon={Palette}
        subtitle="Customize your tenant's UI and enabled features"
      />

      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardContent className="p-6 space-y-5">
          <div className="flex items-center gap-2 mb-2">
            <Palette className="w-4 h-4 text-indigo-500" />
            <h2 className={cn('font-semibold', lightTheme.text.primary)}>Branding</h2>
          </div>

          <div className="space-y-1.5">
            <Label>Primary Color</Label>
            <div className="flex items-center gap-3">
              <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)}
                className="w-10 h-10 rounded cursor-pointer border border-slate-200" />
              <Input value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="max-w-[140px]" />
              <div className="w-10 h-10 rounded-lg border border-slate-200" style={{ background: primaryColor }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Logo URL</Label>
            <Input placeholder="https://..." value={logoUrl} onChange={e => setLogoUrl(e.target.value)} />
            {logoUrl && <img src={logoUrl} alt="Logo preview" className="h-10 object-contain mt-1 rounded border border-slate-200 p-1" />}
          </div>
        </CardContent>
      </Card>

      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardContent className="p-6">
          <h2 className={cn('font-semibold mb-4', lightTheme.text.primary)}>Enabled Features</h2>
          <div className="grid grid-cols-2 gap-3">
            {FEATURE_OPTIONS.map(f => (
              <label key={f.key} className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                <input type="checkbox" checked={features.includes(f.key)} onChange={() => toggleFeature(f.key)}
                  className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm text-slate-700">{f.label}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save Settings
      </Button>
    </div>
  );
};
