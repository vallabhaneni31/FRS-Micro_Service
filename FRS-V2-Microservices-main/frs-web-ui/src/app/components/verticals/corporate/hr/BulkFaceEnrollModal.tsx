import React, { useState, useRef, useCallback } from 'react';
import { Upload, X, CheckCircle, AlertTriangle, Camera, FileArchive, Users } from 'lucide-react';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { toast } from 'sonner';
import { authConfig } from '../../../../config/authConfig';

interface EnrollResult {
  employeeCode: string;
  fullName: string;
  status: 'enrolled' | 'failed' | 'not_found' | 'pending';
  confidence?: number;
  message: string;
}

interface BulkFaceEnrollProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const BulkFaceEnrollModal: React.FC<BulkFaceEnrollProps> = ({ onClose, onSuccess }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const fileRef = useRef<HTMLInputElement>(null);

  const [files, setFiles]       = useState<{ name: string; file: File; code: string }[]>([]);
  const [results, setResults]   = useState<EnrollResult[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [current, setCurrent]   = useState('');
  const [progress, setProgress] = useState(0);

  const BACKEND = authConfig.apiBaseUrl;

  // Parse filename → employee_code
  // Supports: ML001_Name.jpg, ML001.jpg, ML001-Name.jpg
  const parseCode = (filename: string) => {
    const base = filename.replace(/\.[^.]+$/, '');
    const match = base.match(/^([A-Za-z0-9]+)/);
    return match ? match[1].toUpperCase() : base.toUpperCase();
  };

  const processFiles = (fileList: FileList) => {
    const images = Array.from(fileList).filter(f =>
      f.type.startsWith('image/') || f.name.match(/\.(jpg|jpeg|png|webp)$/i)
    );
    if (!images.length) { toast.error('No image files found'); return; }
    setFiles(images.map(f => ({ name: f.name, file: f, code: parseCode(f.name) })));
    setResults([]);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    processFiles(e.dataTransfer.files);
  }, []);

  const handleEnroll = async () => {
    if (!files.length || !accessToken) return;
    setEnrolling(true);
    const res: EnrollResult[] = files.map(f => ({
      employeeCode: f.code, fullName: f.name, status: 'pending', message: 'Waiting...'
    }));
    setResults([...res]);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setCurrent(f.name);
      setProgress(Math.round((i / files.length) * 100));

      try {
        // Find employee by code
        const empResp = await fetch(`${BACKEND}/employees/search?q=${f.code}&limit=1`, {
          headers: { 'Authorization': `Bearer ${accessToken}`, ...scopeHeaders }
        });
        const empData = await empResp.json();
        const emp = empData?.data?.[0] ?? empData?.[0];

        if (!emp) {
          res[i] = { employeeCode: f.code, fullName: f.name, status: 'not_found', message: `No employee with code ${f.code}` };
          setResults([...res]); continue;
        }

        // Enroll face
        const fd = new FormData();
        fd.append('photo', f.file, f.name);
        const enrollResp = await fetch(`${BACKEND}/employees/${emp.pk_employee_id}/enroll-face`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, ...scopeHeaders },
          body: fd,
        });
        const enrollData = await enrollResp.json();

        if (enrollResp.ok && enrollData.success) {
          res[i] = {
            employeeCode: f.code, fullName: emp.full_name, status: 'enrolled',
            confidence: enrollData.confidence,
            message: `Enrolled (conf: ${(enrollData.confidence * 100).toFixed(0)}%)`
          };
        } else {
          res[i] = {
            employeeCode: f.code, fullName: emp.full_name, status: 'failed',
            message: enrollData.message ?? 'Enrollment failed'
          };
        }
      } catch (e: any) {
        res[i] = { employeeCode: f.code, fullName: f.name, status: 'failed', message: e.message };
      }
      setResults([...res]);
      // Small delay between enrollments
      await new Promise(r => setTimeout(r, 500));
    }

    setProgress(100); setCurrent('');
    setEnrolling(false);
    const enrolled = res.filter(r => r.status === 'enrolled').length;
    if (enrolled > 0) { toast.success(`${enrolled} employee${enrolled>1?'s':''} enrolled`); onSuccess(); }
    else toast.warning('No employees enrolled');
  };

  const statusIcon = (s: string) => {
    if (s === 'enrolled')  return <CheckCircle className="w-4 h-4 text-emerald-500" />;
    if (s === 'pending')   return <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />;
    return <AlertTriangle className="w-4 h-4 text-rose-500" />;
  };

  const statusCls = (s: string) => ({
    enrolled:  'bg-emerald-500/10 text-emerald-600',
    failed:    'bg-rose-500/10 text-rose-600',
    not_found: 'bg-amber-500/10 text-amber-600',
    pending:   'bg-primary/10 text-primary',
  }[s] ?? 'bg-muted text-muted-foreground');

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-lg"><Camera className="w-5 h-5 text-emerald-500" /></div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Bulk Face Enrollment</h2>
              <p className="text-xs text-muted-foreground">Upload photos named by employee code (e.g. ML001_Name.jpg)</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-accent/50 transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Naming convention */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
            <p className="text-xs font-semibold text-primary mb-2">📋 File Naming Convention</p>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              {['ML001_Karthik.jpg', 'ML002_SaiDinesh.jpg', 'ML003.jpg', 'ML004_yeshwanth.png'].map(n => (
                <span key={n} className="font-mono bg-muted/50 px-2 py-1 rounded">{n}</span>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">Employee code must match exactly. One face per photo.</p>
          </div>

          {/* Upload zone */}
          <div
            onDrop={onDrop}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all',
              dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/30'
            )}>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={e => { if (e.target.files) processFiles(e.target.files); }} />
            <Upload className={cn('w-8 h-8 mx-auto mb-3', dragOver ? 'text-primary' : 'text-muted-foreground')} />
            {files.length > 0 ? (
              <div>
                <p className="text-sm font-semibold text-foreground">{files.length} photos selected</p>
                <p className="text-xs text-muted-foreground mt-1">Click to change selection</p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-foreground">Drop photos here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">JPG, PNG, WebP — multiple files supported</p>
              </div>
            )}
          </div>

          {/* Progress bar */}
          {enrolling && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>{current}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* File list / results */}
          {(files.length > 0 || results.length > 0) && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="bg-muted/40 px-4 py-2.5 border-b border-border">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {results.length > 0 ? 'Enrollment Results' : 'Files to Enroll'}
                </p>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-border/40">
                {results.length > 0 ? results.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/20">
                    {statusIcon(r.status)}
                    <span className="font-mono text-xs text-muted-foreground w-16">{r.employeeCode}</span>
                    <span className="text-sm text-foreground flex-1">{r.fullName}</span>
                    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase', statusCls(r.status))}>
                      {r.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{r.message}</span>
                  </div>
                )) : files.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/20">
                    <Camera className="w-4 h-4 text-muted-foreground" />
                    <span className="font-mono text-xs text-primary w-16">{f.code}</span>
                    <span className="text-sm text-foreground flex-1">{f.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-between items-center bg-muted/20">
          <p className="text-xs text-muted-foreground">
            {results.length > 0
              ? `${results.filter(r=>r.status==='enrolled').length} enrolled · ${results.filter(r=>r.status==='failed'||r.status==='not_found').length} failed`
              : files.length > 0 ? `${files.length} photos ready` : 'No photos selected'}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
              {results.length > 0 ? 'Close' : 'Cancel'}
            </button>
            {results.length === 0 && (
              <button onClick={handleEnroll} disabled={files.length === 0 || enrolling}
                className="px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg transition-all disabled:opacity-50 flex items-center gap-2">
                {enrolling
                  ? <><span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> Enrolling...</>
                  : <><Users className="w-4 h-4" /> Enroll {files.length > 0 ? files.length : ''} Faces</>
                }
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
