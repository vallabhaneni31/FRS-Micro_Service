import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Download, X, CheckCircle, AlertTriangle, SkipForward, FileSpreadsheet, Users } from 'lucide-react';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { toast } from 'sonner';

interface BulkRow {
  employee_code: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  department?: string;
  designation?: string;
  site_id?: string;
  status?: string;
  hire_date?: string;
}

interface ImportResult {
  row: BulkRow;
  status: 'created' | 'skipped' | 'error';
  message: string;
}

interface BulkImportProps {
  onClose: () => void;
  onSuccess: () => void;
}

const TEMPLATE_HEADERS = [
  'employee_code', 'first_name', 'last_name', 'email', 'phone',
  'department', 'designation', 'site_id', 'status', 'hire_date'
];

const SAMPLE_ROWS = [
  ['EMP001', 'John', 'Smith', 'john@company.com', '+919999999991', 'Engineering', 'Software Engineer', '1', 'active', '2026-01-15'],
  ['EMP002', 'Jane', 'Doe', 'jane@company.com', '+919999999992', 'Human Resources', 'HR Manager', '2', 'active', '2026-02-01'],
];

function parseCSV(text: string): BulkRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj: any = {};
    headers.forEach((h, i) => { if (vals[i] !== undefined) obj[h] = vals[i]; });
    return obj as BulkRow;
  });
}

export const BulkImportModal: React.FC<BulkImportProps> = ({ onClose, onSuccess }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows]         = useState<BulkRow[]>([]);
  const [results, setResults]   = useState<ImportResult[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState('');
  const [fileObject, setFileObject] = useState<File | null>(null);
  const [sites, setSites] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    if (!accessToken) return;
    apiRequest<{ success: boolean; sites: any[] }>('/site-management/sites', { accessToken, scopeHeaders })
      .then(res => {
        if (res?.success) {
          setSites((res.sites || []).map((s: any) => ({ id: Number(s.pk_site_id), name: s.site_name })));
        }
      })
      .catch(() => setSites([]));
  }, [accessToken, scopeHeaders]);

  const downloadTemplate = () => {
    const csv = [TEMPLATE_HEADERS.join(','), ...SAMPLE_ROWS.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'employee_import_template.csv'; a.click();
  };

  const processFile = (file: File) => {
    setFilename(file.name);
    setFileObject(file);
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseCSV(e.target?.result as string);
      setRows(parsed);
      setResults(null);
    };
    reader.readAsText(file);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) processFile(file);
    else toast.error('Please upload a CSV file');
  }, []);

  const handleImport = async () => {
    if (!fileObject || !accessToken) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', fileObject);

      const data = await apiRequest<any>('/hrms/employees/bulk-import', {
        accessToken, 
        scopeHeaders,
        method: 'POST',
        body: formData,
      });

      // Transform response to match UI format
      const summary = data.summary || { total: 0, inserted: 0, updated: 0, failed: 0 };
      
      const mappedResults: ImportResult[] = [
        ...data.inserted.map((code: string) => ({ 
          row: rows.find(r => r.employee_code === code) || { employee_code: code, first_name: 'Imported', last_name: '' },
          status: 'created' as const, 
          message: 'Saved successfully' 
        })),
        ...data.updated.map((code: string) => ({ 
          row: rows.find(r => r.employee_code === code) || { employee_code: code, first_name: 'Updated', last_name: '' },
          status: 'skipped' as const, 
          message: 'Existing record updated' 
        })),
        ...(data.failed || []).map((f: any) => ({
          row: { employee_code: f.employee_code, first_name: 'Failed', last_name: 'Record' },
          status: 'error' as const,
          message: f.error || 'Database error'
        }))
      ];

      setResults(mappedResults);

      if (summary.inserted > 0 || summary.updated > 0) {
        toast.success(`Processed ${summary.total} records`);
        onSuccess();
      }
    } catch (e: any) {
      toast.error('Import failed: ' + (e.message ?? 'Unknown error'));
    } finally {
      setImporting(false);
    }
  };

  const statusIcon = (s: string) => {
    if (s === 'created') return <CheckCircle className="w-4 h-4 text-emerald-500" />;
    if (s === 'skipped') return <SkipForward className="w-4 h-4 text-amber-500" />;
    return <AlertTriangle className="w-4 h-4 text-rose-500" />;
  };

  const statusCls = (s: string) => {
    if (s === 'created') return 'bg-emerald-500/10 text-emerald-600';
    if (s === 'skipped') return 'bg-amber-500/10 text-amber-600';
    return 'bg-rose-500/10 text-rose-600';
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg"><FileSpreadsheet className="w-5 h-5 text-primary" /></div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Bulk Employee Import</h2>
              <p className="text-xs text-muted-foreground">Import multiple employees from a CSV file</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent/50 transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Step 1 — Download template */}
          <div>
            <p className="text-sm font-medium text-foreground mb-2">Step 1 — Download Template</p>
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-xl border border-border">
              <p className="text-xs text-muted-foreground">Fill in employee details and save as CSV</p>
              <button onClick={downloadTemplate}
                className="flex items-center gap-2 px-4 py-2 border border-primary text-primary rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors shrink-0">
                <Download className="w-4 h-4" /> Template
              </button>
            </div>
          </div>

          {/* Step 2 — Valid Site IDs */}
          <div>
            <p className="text-sm font-medium text-foreground mb-2">Step 2 — Valid Site IDs (Reminder)</p>
            <div className="p-4 bg-muted/30 rounded-xl border border-border">
              <p className="text-xs text-muted-foreground mb-2">
                Use one of these Site IDs when filling out the <code>site_id</code> column in the CSV template:
              </p>
              {sites.length > 0 ? (
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 max-h-36 overflow-y-auto pl-1">
                  {sites.map(s => (
                    <li key={s.id} className="text-xs text-foreground flex items-center gap-2">
                      <span className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-bold rounded-md text-[10px]">
                        {s.id}
                      </span>
                      <span className="truncate">{s.name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">No sites configured or loading failed.</p>
              )}
            </div>
          </div>

          {/* Step 3 — Upload */}
          <div>
            <p className="text-sm font-medium text-foreground mb-2">Step 3 — Upload CSV</p>
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all',
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/30'
              )}>
              <input ref={fileRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); }} />
              <Upload className={cn('w-8 h-8 mx-auto mb-3', dragOver ? 'text-primary' : 'text-muted-foreground')} />
              {filename ? (
                <div>
                  <p className="text-sm font-semibold text-foreground">{filename}</p>
                  <p className="text-xs text-emerald-500 mt-1">{rows.length} rows parsed</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-foreground">Drop CSV here or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-1">Supports .csv files only</p>
                </div>
              )}
            </div>
          </div>

          {/* Preview table */}
          {rows.length > 0 && !results && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-foreground">
                  Preview <span className="text-muted-foreground text-xs ml-1">({rows.length} rows)</span>
                </p>
                <button onClick={() => {
                  setRows([]);
                  setFilename('');
                  setFileObject(null);
                  if (fileRef.current) {
                    fileRef.current.value = '';
                  }
                }}
                  className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
              </div>
              <div className="border border-border rounded-xl overflow-auto max-h-52">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>{['Code','First Name','Last Name','Email','Phone','Department','Designation','Site ID','Status','Hire Date'].map(h => (
                      <th key={h} className="px-3 py-2.5 font-semibold text-muted-foreground uppercase tracking-wider text-[10px]">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {rows.map((r, i) => (
                      <tr key={i} className="hover:bg-accent/30 transition-colors">
                        <td className="px-3 py-2 font-mono text-primary">{r.employee_code || <span className="text-rose-500">missing</span>}</td>
                        <td className="px-3 py-2 font-medium text-foreground">{r.first_name || <span className="text-rose-500">missing</span>}</td>
                        <td className="px-3 py-2 font-medium text-foreground">{r.last_name || <span className="text-rose-500">missing</span>}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.email || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.phone || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.department || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.designation || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.site_id || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase',
                            r.status === 'inactive' ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500')}>
                            {r.status || 'active'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.hire_date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Results */}
          {results && (
            <div>
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  ['Created', results.filter(r=>r.status==='created').length, 'text-emerald-500 bg-emerald-500/10'],
                  ['Skipped', results.filter(r=>r.status==='skipped').length, 'text-amber-500 bg-amber-500/10'],
                  ['Failed',  results.filter(r=>r.status==='error').length,   'text-rose-500 bg-rose-500/10'],
                ].map(([l,v,cls]) => (
                  <div key={l as string} className={cn('rounded-xl p-4 text-center', (cls as string).split(' ')[1])}>
                    <p className={cn('text-2xl font-bold', (cls as string).split(' ')[0])}>{v as number}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{l}</p>
                  </div>
                ))}
              </div>
              <div className="border border-border rounded-xl overflow-auto max-h-48">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase">Status</th>
                      <th className="px-3 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase">Code</th>
                      <th className="px-3 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase">Name</th>
                      <th className="px-3 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {results.map((r, i) => (
                      <tr key={i} className="hover:bg-accent/30">
                        <td className="px-3 py-2">
                          <span className={cn('flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase w-fit', statusCls(r.status))}>
                            {statusIcon(r.status)} {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{r.row.employee_code}</td>
                        <td className="px-3 py-2 text-foreground">{r.row.first_name} {r.row.last_name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-between items-center bg-muted/20">
          <p className="text-xs text-muted-foreground">
            {results
              ? `Import complete — ${results.filter(r=>r.status==='created').length} employees added`
              : rows.length > 0 ? `${rows.length} rows ready to import` : 'No file selected'}
          </p>
          <div className="flex gap-2">
            {results ? (
              <>
                <button onClick={() => {
                  setResults(null);
                  setRows([]);
                  setFilename('');
                  setFileObject(null);
                  if (fileRef.current) {
                    fileRef.current.value = '';
                  }
                }}
                  className="px-4 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                  Import Another
                </button>
                <button onClick={onClose}
                  className="px-6 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold rounded-lg transition-all">
                  Close
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose}
                  className="px-4 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                  Cancel
                </button>
                <button onClick={handleImport} disabled={rows.length === 0 || importing}
                  className="px-6 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold rounded-lg transition-all disabled:opacity-50 flex items-center gap-2">
                  {importing ? (
                    <><span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> Importing...</>
                  ) : (
                    <><Users className="w-4 h-4" /> Import {rows.length > 0 ? rows.length : ''} Employees</>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
