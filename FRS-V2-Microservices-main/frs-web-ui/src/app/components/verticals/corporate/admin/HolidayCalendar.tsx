import React, { useEffect, useState } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../ui/dialog';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, CalendarDays, Globe } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

interface Holiday {
  id: string;
  name: string;
  date: string;
  type: 'public' | 'company' | 'optional';
  recurring: boolean;
}

const TYPE_STYLES: Record<string, string> = {
  public:   'bg-blue-50 text-blue-700 border-blue-200',
  company:  'bg-violet-50 text-violet-700 border-violet-200',
  optional: 'bg-amber-50 text-amber-700 border-amber-200',
};

const EMPTY: Omit<Holiday, 'id'> = { name: '', date: '', type: 'public', recurring: false };

const currentYear = new Date().getFullYear();

export const HolidayCalendar: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Omit<Holiday, 'id'>>(EMPTY);
  const [yearFilter, setYearFilter] = useState(currentYear);

  const load = async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ data: Holiday[] }>(`/site/holidays?year=${yearFilter}`, { accessToken, scopeHeaders });
      setHolidays(res.data ?? []);
    } catch { setHolidays([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [accessToken, yearFilter]);

  const set = (k: keyof typeof form, v: any) => setForm(f => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    if (!form.name || !form.date) { toast.error('Name and date are required'); return; }
    setSaving(true);
    try {
      await apiRequest('/site/holidays', { method: 'POST', accessToken, scopeHeaders, body: JSON.stringify(form) });
      toast.success('Holiday added');
      setOpen(false);
      setForm(EMPTY);
      load();
    } catch { toast.error('Failed to add holiday'); }
    finally { setSaving(false); }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDelete = async (id: string, name: string) => {
    setConfirmConfig({
      title: `Remove "${name}" from the calendar?`,
      description: 'The holiday will be removed from attendance rules.',
      confirmText: 'Remove Holiday',
      onConfirm: async () => {
        try {
          await apiRequest(`/site/holidays/${id}`, { method: 'DELETE', accessToken, scopeHeaders });
          setHolidays(prev => prev.filter(h => h.id !== id));
          toast.success('Holiday removed');
        } catch { toast.error('Delete failed'); }
      },
    });
  };

  const byMonth = holidays.reduce<Record<string, Holiday[]>>((acc, h) => {
    const month = new Date(h.date).toLocaleString('default', { month: 'long' });
    (acc[month] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-black text-slate-800 dark:text-white">Holiday Calendar</h3>
          <p className="text-xs text-slate-400 mt-0.5">Public, company, and optional holidays</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border rounded-xl overflow-hidden">
            <Button variant="ghost" size="sm" className="h-8 px-2 rounded-none" onClick={() => setYearFilter(y => y - 1)}>‹</Button>
            <span className="text-sm font-bold px-2 text-slate-700">{yearFilter}</span>
            <Button variant="ghost" size="sm" className="h-8 px-2 rounded-none" onClick={() => setYearFilter(y => y + 1)}>›</Button>
          </div>
          <Button size="sm" onClick={() => setOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl gap-1.5">
            <Plus className="w-4 h-4" /> Add Holiday
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-blue-500 w-5 h-5" /></div>
      ) : holidays.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="p-12 flex flex-col items-center gap-3 text-slate-400">
            <CalendarDays className="w-10 h-10 opacity-20" />
            <p className="text-sm font-medium">No holidays for {yearFilter}</p>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="rounded-xl gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add First Holiday
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(byMonth).map(([month, items]) => (
            <div key={month}>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">{month}</p>
              <div className="space-y-2">
                {items.map(h => (
                  <Card key={h.id} className="border-none shadow-sm">
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-50 flex flex-col items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-slate-400 leading-none uppercase">
                          {new Date(h.date).toLocaleString('default', { month: 'short' })}
                        </span>
                        <span className="text-base font-black text-slate-700 leading-none">
                          {new Date(h.date).getDate()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-slate-800 dark:text-white">{h.name}</span>
                          <Badge className={cn("text-[9px] font-black border rounded-full px-2 py-0", TYPE_STYLES[h.type])}>
                            {h.type.toUpperCase()}
                          </Badge>
                          {h.recurring && (
                            <span className="flex items-center gap-0.5 text-[9px] font-bold text-slate-400">
                              <Globe className="w-2.5 h-2.5" /> Annual
                            </span>
                          )}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-rose-400 hover:bg-rose-50 rounded-lg shrink-0"
                        onClick={() => handleDelete(h.id, h.name)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader><DialogTitle className="font-black text-lg">Add Holiday</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Holiday Name</Label>
              <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Independence Day" className="rounded-xl" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Date</Label>
              <Input type="date" value={form.date} onChange={e => set('date', e.target.value)} className="rounded-xl" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Type</Label>
              <div className="flex gap-2">
                {(['public', 'company', 'optional'] as const).map(t => (
                  <button key={t} onClick={() => set('type', t)}
                    className={cn("flex-1 text-[10px] font-black uppercase py-1.5 rounded-lg border transition-colors",
                      form.type === t ? TYPE_STYLES[t] : 'border-slate-200 text-slate-400 hover:border-slate-300'
                    )}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.recurring} onChange={e => set('recurring', e.target.checked)} className="rounded" />
              <span className="text-sm text-slate-600">Recurring annually</span>
            </label>
            <Button onClick={handleCreate} disabled={saving} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl h-11 font-bold gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add Holiday
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
