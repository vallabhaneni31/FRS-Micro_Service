import React, { useState } from 'react';
import { FileText, Settings, ShieldAlert, Sliders, Mail, Video, RefreshCw, Check } from 'lucide-react';
import { LiveAuditLog } from './LiveAuditLog';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import { toast } from 'sonner';

export const LogsAndSettings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'logs' | 'settings'>('logs');
  const [saving, setSaving] = useState(false);

  // Facility settings state
  const [threshold, setThreshold] = useState('0.75');
  const [emailRecipients, setEmailRecipients] = useState('admin@facility.com, sec-ops@facility.com');
  const [cameraSyncLimit, setCameraSyncLimit] = useState('15');
  const [purgeInterval, setPurgeInterval] = useState('90');
  const [offlineTimeout, setOfflineTimeout] = useState('5');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    // Simulate API Call
    setTimeout(() => {
      setSaving(false);
      toast.success('Facility settings updated successfully!');
    }, 800);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Logs & Facility Settings"
        icon={FileText}
        subtitle="Audit global operations and adjust device configurations"
        actions={
        <div className="flex bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl w-fit border border-slate-200/40">
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg transition-all duration-300 ${
              activeTab === 'logs'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Activity Logs
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg transition-all duration-300 ${
              activeTab === 'settings'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-white'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            Facility Settings
          </button>
        </div>
        }
      />

      {/* Tab Contents */}
      {activeTab === 'logs' ? (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <LiveAuditLog />
        </div>
      ) : (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Card className="border-none shadow-sm max-w-2xl bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
            <CardHeader className="pb-4">
              <CardTitle className={cn("text-sm font-black flex items-center gap-2", lightTheme.text.primary)}>
                <Sliders className="w-4 h-4 text-blue-500" /> General Parameters
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-5">
                {/* Threshold Slider */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Biometric Similarity Match Threshold
                    </Label>
                    <span className="text-xs font-black text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded-md">
                      {threshold}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.50"
                    max="0.95"
                    step="0.01"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <p className={cn("text-[10px]", lightTheme.text.muted)}>
                    Determines facial match sensitivity. Higher value reduces false positives but increases false negatives.
                  </p>
                </div>

                {/* Email Recipients */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                    <Mail className="w-3.5 h-3.5 text-slate-400" /> Alert E-mail Recipients
                  </Label>
                  <Input
                    type="text"
                    value={emailRecipients}
                    onChange={(e) => setEmailRecipients(e.target.value)}
                    placeholder="alerts@company.com"
                    className="rounded-xl"
                  />
                  <p className={cn("text-[10px]", lightTheme.text.muted)}>
                    Comma-separated email addresses to notify instantly for VIP or high-risk alert triggers.
                  </p>
                </div>

                {/* Camera Sync Limits & Offline Timeout */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                      <Video className="w-3.5 h-3.5 text-slate-400" /> Camera Sync Limit
                    </Label>
                    <Input
                      type="number"
                      value={cameraSyncLimit}
                      onChange={(e) => setCameraSyncLimit(e.target.value)}
                      min="1"
                      max="100"
                      className="rounded-xl"
                    />
                    <p className={cn("text-[10px]", lightTheme.text.muted)}>
                      Maximum parallel camera streams allowed to synchronize concurrently per facility.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                      <ShieldAlert className="w-3.5 h-3.5 text-slate-400" /> Node Offline Timeout
                    </Label>
                    <Input
                      type="number"
                      value={offlineTimeout}
                      onChange={(e) => setOfflineTimeout(e.target.value)}
                      min="1"
                      max="60"
                      className="rounded-xl"
                    />
                    <p className={cn("text-[10px]", lightTheme.text.muted)}>
                      Minutes after which a silent/unresponsive Jetson box is flagged as 'Offline'.
                    </p>
                  </div>
                </div>

                {/* GDPR Retention Purge Interval */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5 text-slate-400" /> GDPR Face Photo Purge Age
                  </Label>
                  <Input
                    type="number"
                    value={purgeInterval}
                    onChange={(e) => setPurgeInterval(e.target.value)}
                    min="7"
                    max="365"
                    className="rounded-xl"
                  />
                  <p className={cn("text-[10px]", lightTheme.text.muted)}>
                    Days after which visitor and employee enrollment photos are purged from storage to maintain privacy compliance.
                  </p>
                </div>

                {/* Action button */}
                <div className="pt-2">
                  <Button type="submit" disabled={saving} className="w-full md:w-auto font-bold rounded-xl h-10 px-6 gap-2">
                    {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Save Changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};
