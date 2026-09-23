import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Switch } from '../../../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../ui/dialog';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Clock, Mail, FileText, Play, Download } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

interface ScheduledReport {
  id: string;
  name: string;
  report_type: 'attendance' | 'employees' | 'audit' | 'device_health';
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  recipients: string;
  enabled: boolean;
  last_run?: string;
  next_run?: string;
}

interface CompletedRun {
  id: string;
  name: string;
  report_type: string;
  file_format: string;
  file_size: number;
  run_at: string;
  status: string;
}

const EMPTY: Omit<ScheduledReport, 'id'> = {
  name: '', report_type: 'attendance', frequency: 'daily',
  time: '08:00', recipients: '', enabled: true,
};

const FREQ_COLORS: Record<string, string> = {
  daily: 'bg-blue-50 text-blue-700 border-blue-200',
  weekly: 'bg-violet-50 text-violet-700 border-violet-200',
  monthly: 'bg-amber-50 text-amber-700 border-amber-200',
};

function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs  = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs  = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const past = diff < 0;
  if (mins < 1)  return 'just now';
  if (hrs  < 1)  return past ? `${mins}m ago`  : `in ${mins}m`;
  if (days < 1)  return past ? `${hrs}h ago`   : `in ${hrs}h`;
  if (days < 30) return past ? `${days}d ago`  : `in ${days}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const TYPE_LABELS: Record<string, string> = {
  attendance: 'Attendance Report',
  employees: 'Employee Roster',
  audit: 'Audit Log',
  device_health: 'Device Health',
};

export const ScheduledReports: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Omit<ScheduledReport, 'id'>>(EMPTY);
  const [history, setHistory] = useState<CompletedRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ data: ScheduledReport[] }>('/reports/schedules', { accessToken, scopeHeaders });
      setReports(res.data ?? []);
    } catch { setReports([]); }
    finally { setLoading(false); }
  };

  const loadHistory = async () => {
    if (!isAuthenticated) return;
    setHistoryLoading(true);
    try {
      const res = await apiRequest<{ data: CompletedRun[] }>('/reports/completed', { accessToken, scopeHeaders });
      setHistory(res.data ?? []);
    } catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  };

  useEffect(() => { load(); loadHistory(); }, [accessToken]);

  const set = (k: keyof typeof form, v: any) => setForm(f => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    if (!form.name || !form.recipients) { toast.error('Name and recipients are required'); return; }
    setSaving(true);
    try {
      await apiRequest('/reports/schedules', {
        method: 'POST', accessToken, scopeHeaders, body: JSON.stringify(form),
      });
      toast.success('Schedule created');
      setOpen(false);
      setForm(EMPTY);
      load();
    } catch { toast.error('Failed to create schedule'); }
    finally { setSaving(false); }
  };

  const handleToggle = async (r: ScheduledReport) => {
    try {
      await apiRequest(`/reports/schedules/${r.id}`, {
        method: 'PATCH', accessToken, scopeHeaders,
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      setReports(prev => prev.map(x => x.id === r.id ? { ...x, enabled: !x.enabled } : x));
    } catch { toast.error('Update failed'); }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDelete = async (id: string) => {
    setConfirmConfig({
      title: 'Delete this scheduled report?',
      description: 'The automated report schedule will be permanently removed.',
      confirmText: 'Delete Schedule',
      onConfirm: async () => {
        try {
          await apiRequest(`/reports/schedules/${id}`, { method: 'DELETE', accessToken, scopeHeaders });
          setReports(prev => prev.filter(r => r.id !== id));
          toast.success('Schedule deleted');
        } catch { toast.error('Delete failed'); }
      },
    });
  };

  const handleRunNow = async (r: ScheduledReport) => {
    setRunningId(r.id);
    try {
      await apiRequest(`/reports/schedules/${r.id}/run`, { method: 'POST', accessToken, scopeHeaders });
      toast.success(`"${r.name}" run completed successfully!`);
      loadHistory();
      load();
    } catch { toast.error('Report run failed'); }
    finally { setRunningId(null); }
  };

  const handleDownload = async (run: CompletedRun) => {
    try {
      const url = `${(import.meta as any).env.VITE_API_URL || '/api'}/reports/completed/${run.id}/download`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...Object.fromEntries(
            Object.entries(scopeHeaders).filter(([_, v]) => v !== undefined)
          )
        }
      });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${run.name.replace(/[^a-zA-Z0-9]/g, "_")}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
      toast.success('Report downloaded successfully');
    } catch (err) {
      toast.error('Failed to download report file');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Scheduled Reports"
        icon={FileText}
        subtitle="Automated report delivery via email"
        actions={
          <Button size="sm" onClick={() => setOpen(true)} className="rounded-xl gap-1.5">
            <Plus className="w-4 h-4" /> New Schedule
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-primary w-5 h-5" /></div>
      ) : reports.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className={cn("p-12 flex flex-col items-center gap-3", lightTheme.text.muted)}>
            <Clock className="w-10 h-10 opacity-20" />
            <p className="text-sm font-medium">No scheduled reports yet</p>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="rounded-xl gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Create First Schedule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reports.map(r => (
            <Card key={r.id} className={cn("border-none shadow-sm", !r.enabled && "opacity-60")}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className={cn("p-2.5 rounded-xl", lightTheme.primary.selectedBg)}>
                  <FileText className={cn("w-4 h-4", lightTheme.primary.selectedText)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("font-bold text-sm", lightTheme.text.primary)}>{r.name}</span>
                    <Badge className={cn("text-[9px] font-black border rounded-full px-2 py-0", FREQ_COLORS[r.frequency])}>
                      {r.frequency.toUpperCase()}
                    </Badge>
                    <span className={cn("text-[10px] font-medium", lightTheme.text.muted)}>{TYPE_LABELS[r.report_type]}</span>
                  </div>
                  <div className={cn("flex items-center gap-3 mt-1 text-[11px] flex-wrap", lightTheme.text.muted)}>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{r.time}</span>
                    <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{r.recipients.split(',').length} recipient{r.recipients.split(',').length > 1 ? 's' : ''}</span>
                    {r.last_run && (
                      <span title={new Date(r.last_run).toLocaleString()} className="flex items-center gap-1">
                        Last: <span className={cn("font-medium", lightTheme.text.secondary)}>{relativeTime(r.last_run)}</span>
                      </span>
                    )}
                    {r.next_run && r.enabled && (
                      <span title={new Date(r.next_run).toLocaleString()} className="flex items-center gap-1 text-blue-500">
                        Next: <span className="font-medium">{relativeTime(r.next_run)}</span>
                      </span>
                    )}
                    {!r.last_run && <span className="italic text-slate-300">Never run</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={r.enabled} onCheckedChange={() => handleToggle(r)} />
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-blue-500 hover:bg-blue-50 rounded-lg" title="Run now" disabled={runningId === r.id} onClick={() => handleRunNow(r)}>
                    {runningId === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-rose-500 hover:bg-rose-50 rounded-lg" onClick={() => handleDelete(r.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Completed Runs History Section */}
      <div className={cn("pt-6 border-t dark:border-slate-800 space-y-4", lightTheme.border.default)}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className={cn("text-sm font-bold", lightTheme.text.primary)}>Completed Runs History</h3>
            <p className={cn("text-[11px] mt-0.5", lightTheme.text.muted)}>Download or preview historical generated reports</p>
          </div>
          <Button size="sm" variant="ghost" onClick={loadHistory} className="text-blue-500 hover:bg-blue-50 hover:text-blue-600 rounded-xl h-8 text-[11px] gap-1">
            <Clock className="w-3.5 h-3.5 animate-pulse" /> Refresh History
          </Button>
        </div>

        {historyLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="animate-spin text-primary w-5 h-5" /></div>
        ) : history.length === 0 ? (
          <Card className="border-none shadow-sm">
            <CardContent className={cn("p-8 flex flex-col items-center gap-2 text-center", lightTheme.text.muted)}>
              <FileText className="w-8 h-8 opacity-20" />
              <p className="text-xs font-semibold">No report runs generated yet</p>
              <p className="text-[10px] opacity-75 max-w-xs">Click the play icon on any schedule above to trigger a run instantly.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {history.map(run => (
              <Card key={run.id} className="border-none shadow-sm hover:shadow-md transition-all duration-300">
                <CardContent className="p-3.5 flex items-center gap-3">
                  <div className="p-2 bg-blue-50/60 dark:bg-blue-900/20 text-blue-500 rounded-xl">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn("font-bold text-xs truncate", lightTheme.text.primary)} title={run.name}>{run.name}</p>
                    <div className={cn("flex items-center gap-1.5 mt-0.5 text-[10px] font-medium", lightTheme.text.muted)}>
                      <span>{TYPE_LABELS[run.report_type] || run.report_type}</span>
                      <span className="h-1 w-1 bg-slate-300 rounded-full"></span>
                      <span>{(run.file_size / 1024).toFixed(1)} KB</span>
                    </div>
                    <p className={cn("text-[9px] mt-0.5", lightTheme.text.muted)}>{new Date(run.run_at).toLocaleString()}</p>
                  </div>
                  <Button size="sm" onClick={() => handleDownload(run)} className="h-8 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white font-bold text-xs transition-colors shrink-0 gap-1 px-3">
                    <Download className="w-3 h-3" /> Download
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-black text-lg">New Scheduled Report</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Schedule Name</Label>
              <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Daily Attendance Summary" className="rounded-xl" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Report Type</Label>
                <Select value={form.report_type} onValueChange={v => set('report_type', v)}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="attendance">Attendance</SelectItem>
                    <SelectItem value="employees">Employee Roster</SelectItem>
                    <SelectItem value="audit">Audit Log</SelectItem>
                    <SelectItem value="device_health">Device Health</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Frequency</Label>
                <Select value={form.frequency} onValueChange={v => set('frequency', v)}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Send Time</Label>
              <Input type="time" value={form.time} onChange={e => set('time', e.target.value)} className="rounded-xl" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Recipients (comma-separated emails)</Label>
              <Input value={form.recipients} onChange={e => set('recipients', e.target.value)} placeholder="hr@company.com, admin@company.com" className="rounded-xl" />
            </div>
            <Button onClick={handleCreate} disabled={saving} className="w-full rounded-xl h-11 font-bold gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create Schedule
            </Button>
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
