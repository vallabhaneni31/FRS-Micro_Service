import React, { useState, useEffect, useRef } from 'react';
import {
  X, Cpu, Shield, CheckCircle2, Loader2, Copy, Check, Clock, Radio,
  Globe, Hash, Building2, Terminal, ChevronRight, AlertCircle
} from 'lucide-react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Checkbox } from '../../../ui/checkbox';
import { toast } from 'sonner';
import { apiRequest } from '../../../../services/http/apiClient';

interface Site {
  pk_site_id: number | string;
  site_name: string;
}

interface ZtpActivationModalProps {
  isOpen: boolean;
  onClose: () => void;
  accessToken: string | null;
  scopeHeaders: Record<string, string>;
  onActivated: () => void;
  tenantId?: string | null;
}

// One-line copy chip
function CopyRow({ label, value, icon: Icon }: { label: string; value: string; icon: React.ElementType }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-slate-800/60 last:border-0">
      <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 w-24 shrink-0">{label}</span>
      <span className="flex-1 font-mono text-xs text-blue-300 truncate">{value}</span>
      <button
        onClick={copy}
        className="shrink-0 p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
        title="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

export const ZtpActivationModal: React.FC<ZtpActivationModalProps> = ({
  isOpen,
  onClose,
  accessToken,
  scopeHeaders,
  onActivated,
  tenantId,
}) => {
  const [step, setStep] = useState(1);
  const [sites, setSites] = useState<Site[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 1 fields
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [deviceCode, setDeviceCode] = useState('');

  // Step 2 output
  const [activationPin, setActivationPin] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [timeLeft, setTimeLeft] = useState('30:00');
  const [activatedDevice, setActivatedDevice] = useState<any>(null);
  const [assignedSites, setAssignedSites] = useState<string[]>([]);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const backendUrl = window.location.origin;

  // Reset on open/close
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setActivationPin('');
      setActivatedDevice(null);
      setAssignedSites([]);
      setTimeLeft('30:00');
      setSelectedSiteIds([]);
      setDeviceCode('');
    } else {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    }
  }, [isOpen]);

  // Load sites
  useEffect(() => {
    if (!isOpen || !accessToken) return;
    setIsLoadingSites(true);
    apiRequest<{ success: boolean; sites: Site[] }>('/site-management/sites', { accessToken, scopeHeaders })
      .then(res => setSites(res.sites || []))
      .catch(() => toast.error('Failed to load sites'))
      .finally(() => setIsLoadingSites(false));
  }, [isOpen, accessToken, scopeHeaders]);

  // Countdown + polling on Step 2
  useEffect(() => {
    if (step !== 2 || !activationPin) return;

    const expiryTime = new Date(expiresAt).getTime();
    const timer = setInterval(() => {
      const distance = expiryTime - Date.now();
      if (distance < 0) {
        clearInterval(timer);
        setTimeLeft('Expired');
        toast.error('Activation PIN expired');
        handleBack();
        return;
      }
      const m = Math.floor((distance % 3_600_000) / 60_000);
      const s = Math.floor((distance % 60_000) / 1000);
      setTimeLeft(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    }, 1000);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await apiRequest<{ success: boolean; claimed: boolean; device: any }>(
          `/device-management/devices/activation-code/${activationPin}/status`,
          { accessToken, scopeHeaders, noCache: true }
        );
        if (res.success && res.claimed) {
          clearInterval(pollIntervalRef.current!);
          clearInterval(timer);
          setActivatedDevice(res.device);

          // Auto-assign the activated device to all selected sites
          const code = res.device.external_device_id;
          const siteNames: string[] = [];
          for (const siteId of selectedSiteIds) {
            try {
              await apiRequest(`/device-management/sites/${siteId}/devices`, {
                method: 'POST',
                accessToken,
                scopeHeaders,
                body: JSON.stringify({ device_code: code, device_role: 'edge_ai', zone_name: null }),
              });
              const s = sites.find(x => String(x.pk_site_id) === siteId);
              if (s) siteNames.push(s.site_name);
            } catch {
              // site may have already been assigned via PIN — continue
            }
          }
          setAssignedSites(siteNames);
          setStep(3);
          toast.success('Device activated and assigned to sites!');
          onActivated();
        }
      } catch {
        // silently continue polling
      }
    }, 3000);

    return () => {
      clearInterval(timer);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [step, activationPin, expiresAt]);

  if (!isOpen) return null;

  const toggleSite = (id: string) => {
    setSelectedSiteIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedSiteIds.length === sites.length) {
      setSelectedSiteIds([]);
    } else {
      setSelectedSiteIds(sites.map(s => String(s.pk_site_id)));
    }
  };

  const handleGenerate = async () => {
    if (selectedSiteIds.length === 0) return toast.error('Select at least one site');
    setIsSubmitting(true);
    try {
      // Generate PIN without a site restriction so the Jetson can register at
      // tenant level; we assign to all selected sites after activation polling.
      const res = await apiRequest<{ success: boolean; pin: string; expires_at: string }>(
        '/device-management/devices/activation-code',
        {
          method: 'POST',
          accessToken,
          scopeHeaders,
          body: JSON.stringify({ device_role: 'edge_ai', zone_name: null }),
        }
      );
      if (res.success) {
        setActivationPin(res.pin);
        setExpiresAt(res.expires_at);
        setStep(2);
      } else {
        toast.error('Failed to generate PIN');
      }
    } catch (e: any) {
      toast.error(e.message || 'Generation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setStep(1);
    setActivationPin('');
    setActivatedDevice(null);
    setAssignedSites([]);
  };

  const selectedSiteNames = selectedSiteIds
    .map(id => sites.find(s => String(s.pk_site_id) === id)?.site_name)
    .filter(Boolean)
    .join(', ');

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[80] flex items-center justify-center p-4 animate-in fade-in duration-300">
      <div className="w-full max-w-lg rounded-3xl overflow-hidden shadow-2xl border bg-slate-900 border-slate-800 text-white">

        {/* Header */}
        <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/40">
          <div>
            <h3 className="text-xl font-black tracking-tight flex items-center gap-2">
              <Cpu className="w-5 h-5 text-blue-500 animate-pulse" />
              Zero-Touch Provisioning (ZTP)
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mt-1">
              Secure Edge Box Handshake Activation
            </p>
          </div>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5 mr-4">
            {[1, 2, 3].map(n => (
              <div
                key={n}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  n === step ? 'w-6 bg-blue-500' : n < step ? 'w-3 bg-emerald-500' : 'w-3 bg-slate-700'
                }`}
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-slate-500 hover:text-white hover:bg-slate-800 rounded-full"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-6 min-h-[340px] flex flex-col justify-center">

          {/* ── Step 1: Configure ── */}
          {step === 1 && (
            <div className="space-y-5 animate-in slide-in-from-right-10 duration-300">
              <div className="text-xs text-slate-400 bg-slate-950/50 p-3.5 border border-slate-800 rounded-2xl flex gap-3">
                <Clock className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <span>Select the sites this Jetson will serve. It will sync face embeddings from all selected sites and mark attendance across all of them.</span>
              </div>

              {/* Site multi-select */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Target Sites <span className="text-blue-400">(multi-select)</span>
                  </Label>
                  <button
                    onClick={toggleAll}
                    className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    {selectedSiteIds.length === sites.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                {isLoadingSites ? (
                  <div className="h-24 flex items-center justify-center bg-slate-950/50 border border-slate-800 rounded-xl">
                    <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
                  </div>
                ) : (
                  <div className="bg-slate-950/50 border border-slate-800 rounded-xl divide-y divide-slate-800/50 max-h-36 overflow-y-auto">
                    {sites.map(s => {
                      const id = String(s.pk_site_id);
                      const checked = selectedSiteIds.includes(id);
                      return (
                        <label
                          key={id}
                          className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-800/40 transition-colors"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggleSite(id)}
                            className="h-4 w-4 rounded border-slate-600 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                          />
                          <Building2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="text-sm text-slate-200">{s.site_name}</span>
                          {checked && (
                            <span className="ml-auto text-[10px] font-bold text-blue-400 uppercase tracking-wider">Selected</span>
                          )}
                        </label>
                      );
                    })}
                    {sites.length === 0 && (
                      <div className="px-4 py-4 text-xs text-slate-500 text-center">No active sites found</div>
                    )}
                  </div>
                )}
                {selectedSiteIds.length > 0 && (
                  <p className="text-[10px] text-emerald-400 font-medium">
                    {selectedSiteIds.length} site{selectedSiteIds.length > 1 ? 's' : ''} selected: {selectedSiteNames}
                  </p>
                )}
              </div>

              {/* Optional device code */}
              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Device Code <span className="text-slate-600 font-normal normal-case tracking-normal">(optional — Jetson sets its own if left blank)</span>
                </Label>
                <div className="relative">
                  <Terminal className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                  <Input
                    value={deviceCode}
                    onChange={e => setDeviceCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    placeholder="e.g. jetson-63d4"
                    className="h-11 bg-slate-950 border-slate-800 rounded-xl text-white pl-9 font-mono placeholder:text-slate-600"
                  />
                </div>
              </div>

              <Button
                onClick={handleGenerate}
                disabled={isSubmitting || selectedSiteIds.length === 0}
                className="w-full bg-blue-600 hover:bg-blue-500 font-bold rounded-xl h-11 text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Shield className="w-4 h-4 mr-2" />}
                Generate Secure Activation Token
              </Button>
            </div>
          )}

          {/* ── Step 2: PIN + Connection Details ── */}
          {step === 2 && (
            <div className="space-y-4 animate-in slide-in-from-right-10 duration-300">

              {/* Send-to-team card */}
              <div className="bg-slate-950/60 border border-slate-700 rounded-2xl p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                  <ChevronRight className="w-3 h-3 text-blue-500" />
                  Send these 4 values to your Jetson team
                </p>
                <CopyRow label="Token" value={activationPin} icon={Shield} />
                <CopyRow label="Backend URL" value={backendUrl} icon={Globe} />
                <CopyRow label="Tenant ID" value={tenantId || '—'} icon={Hash} />
                {deviceCode && <CopyRow label="Device Code" value={deviceCode} icon={Terminal} />}
                <CopyRow
                  label="Sites"
                  value={selectedSiteIds
                    .map(id => sites.find(s => String(s.pk_site_id) === id)?.site_name)
                    .filter(Boolean)
                    .join(', ')}
                  icon={Building2}
                />
              </div>

              {/* Polling indicator */}
              <div className="py-3 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 flex flex-col items-center gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Radio className="w-4 h-4 text-blue-500 animate-pulse" />
                  <span>Awaiting handshake from your edge box…</span>
                </div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                  Token expires in: <span className="text-yellow-400 font-mono">{timeLeft}</span>
                </p>
              </div>

              {/* Instructions */}
              <div className="text-[10px] text-slate-400 space-y-1 p-3.5 bg-slate-950/40 border border-slate-800 rounded-2xl">
                <p className="font-black uppercase tracking-wider text-slate-300 mb-1.5">Jetson Setup Steps:</p>
                <p>1. Power on the Jetson and open <span className="font-mono text-blue-300">http://&lt;jetson-ip&gt;:1234</span></p>
                <p>2. Go to the <span className="font-mono text-white">Activate</span> tab and paste the token above.</p>
                <p>3. Fill in device name, IP, and serial from the hardware label.</p>
                <p>4. Click <span className="font-mono text-white">Activate Device</span> — this page will auto-advance when the handshake completes.</p>
              </div>

              <Button
                variant="ghost"
                onClick={handleBack}
                className="w-full bg-transparent text-slate-400 hover:text-white hover:bg-slate-800/50 text-xs"
              >
                Reset Configuration
              </Button>
            </div>
          )}

          {/* ── Step 3: Success ── */}
          {step === 3 && (
            <div className="space-y-5 text-center animate-in zoom-in-95 duration-500">
              <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto shadow-lg shadow-emerald-950/50">
                <CheckCircle2 className="w-9 h-9 animate-bounce" />
              </div>

              <div>
                <h4 className="text-2xl font-black text-white">Edge Box Registered!</h4>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-400 mt-1">
                  Secure cloud authorization established
                </p>
              </div>

              {/* Device detail card */}
              <div className="p-4 bg-slate-950/50 border border-slate-800 rounded-2xl text-left text-sm space-y-2.5">
                <div className="flex justify-between border-b border-slate-800/60 pb-2">
                  <span className="text-slate-500 text-xs">Device Code</span>
                  <span className="font-bold font-mono text-blue-400">{activatedDevice.external_device_id}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/60 pb-2">
                  <span className="text-slate-500 text-xs">Name</span>
                  <span className="font-bold text-white">{activatedDevice.name}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/60 pb-2">
                  <span className="text-slate-500 text-xs">IP Address</span>
                  <span className="font-bold font-mono text-white">{activatedDevice.ip_address}</span>
                </div>
                {activatedDevice.serial_number && (
                  <div className="flex justify-between border-b border-slate-800/60 pb-2">
                    <span className="text-slate-500 text-xs">Serial</span>
                    <span className="font-bold font-mono text-white">{activatedDevice.serial_number}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500 text-xs">Assigned Sites</span>
                  <div className="text-right">
                    {assignedSites.length > 0 ? (
                      assignedSites.map(s => (
                        <span key={s} className="block text-xs font-bold text-emerald-400">{s}</span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </div>
                </div>
              </div>

              {assignedSites.length === 0 && (
                <div className="flex items-start gap-2 text-xs text-yellow-400 bg-yellow-400/5 border border-yellow-400/20 rounded-xl p-3 text-left">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>Site auto-assignment failed — assign the device to sites manually from the Device Management page.</span>
                </div>
              )}

              <Button
                onClick={onClose}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold h-11 rounded-xl"
              >
                Launch Fleet Console
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
