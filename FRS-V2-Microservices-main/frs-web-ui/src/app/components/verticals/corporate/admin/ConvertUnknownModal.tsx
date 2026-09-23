import React, { useState, useEffect } from 'react';
import { X, UserCheck, Info, RefreshCw } from 'lucide-react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';

// /uploads and /api/jetson/photos both require a Bearer token, so a plain
// <img src> would 401 — fetch authenticated and render the resulting blob URL.
const AuthedFaceThumb: React.FC<{ photoPath: string | null | undefined }> = ({ photoPath }) => {
  const { url } = useAuthedPhotoUrl(photoPath);
  if (!photoPath || !url) {
    return <div className="w-full h-full flex items-center justify-center text-xs font-black text-amber-600">UNK</div>;
  }
  return <img src={url} alt="Face Sighting" className="w-full h-full object-cover" />;
};

interface ConvertUnknownModalProps {
  personId: string;
  onClose: () => void;
}

export const ConvertUnknownModal: React.FC<ConvertUnknownModalProps> = ({ personId, onClose }) => {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Unknown person metadata preview
  const [unknownCode, setUnknownCode] = useState('');
  const [visitCount, setVisitCount] = useState(0);
  const [firstSeen, setFirstSeen] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [facePhotos, setFacePhotos] = useState<any[]>([]);

  // Form input fields
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [designation, setDesignation] = useState('');
  const [visitorType, setVisitorType] = useState('guest');
  
  // Host lookup
  const [hostSearch, setHostSearch] = useState('');
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [visitPurpose, setVisitPurpose] = useState('');
  const [validFromDate, setValidFromDate] = useState('');
  const [validFromTime, setValidFromTime] = useState('09:00');
  const [validToDate, setValidToDate] = useState('');
  const [validToTime, setValidToTime] = useState('18:00');

  // Load details
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);

        // Fetch employees
        const empRes = await apiRequest<{ data: any[] }>('/employees', { accessToken });
        if (empRes && empRes.data) setEmployees(empRes.data);

        // Fetch Unknown person profile & metrics
        const res = await apiRequest<{ success: boolean; profile: any; metrics: any; faces: any[] }>('/people/' + personId, { accessToken });
        if (res.success && res.profile) {
          setUnknownCode(`UNK-${personId.slice(0, 8).toUpperCase()}`);
          setVisitCount(res.metrics.visitCount);
          setFirstSeen(res.metrics.firstSeen);
          setLastSeen(res.metrics.lastSeen);
          if (res.faces && res.faces.length > 0) {
            setFacePhotos(res.faces.slice(0, 3)); // show top 3 face crops
          } else if (res.profile.photoUrl) {
            setFacePhotos([{ id: 'profile-photo', photoPath: res.profile.photoUrl, createdAt: res.profile.createdAt || new Date().toISOString() }]);
          } else {
            setFacePhotos([]);
          }

          // Pre-populate validity dates
          if (res.metrics.firstSeen) {
            const d = new Date(res.metrics.firstSeen);
            setValidFromDate(d.toISOString().split('T')[0]);
            setValidFromTime(d.toTimeString().slice(0, 5));
          }
          if (res.metrics.lastSeen) {
            const d = new Date(res.metrics.lastSeen);
            // Default expected exit to 2 hours after last seen
            const exitTime = new Date(d.getTime() + 2 * 60 * 60 * 1000);
            setValidToDate(exitTime.toISOString().split('T')[0]);
            setValidToTime(exitTime.toTimeString().slice(0, 5));
          }
        }
      } catch (err: any) {
        toast.error(err.message || 'Failed to load unknown details');
        onClose();
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [personId, accessToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing = [
      !fullName && 'Full Name',
      !organization && 'Company',
      !selectedHostId && 'Host Employee (select a suggestion from the list)',
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      toast.error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`);
      return;
    }

    setSaving(true);
    try {
      const validFrom = `${validFromDate}T${validFromTime}:00Z`;
      const validTo = `${validToDate}T${validToTime}:00Z`;

      const payload = {
        fullName,
        phone,
        email,
        organization,
        designation,
        visitorType,
        hostEmployeeId: selectedHostId,
        visitPurpose,
        validFrom,
        validTo
      };

      const res = await apiRequest<{ success: boolean }>(`/people/convert/${personId}`, {
        method: 'POST',
        body: JSON.stringify(payload),
        accessToken
      });

      if (res.success) {
        toast.success(`Successfully converted ${unknownCode} to Visitor: ${fullName}`);
        onClose();
      }
    } catch (err: any) {
      toast.error(err.message || 'Conversion failed');
    } finally {
      setSaving(false);
    }
  };

  const filteredHosts = employees.filter(e => 
    e.full_name.toLowerCase().includes(hostSearch.toLowerCase()) ||
    e.employee_code.toLowerCase().includes(hostSearch.toLowerCase())
  ).slice(0, 5);

  if (!personId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-955/40 dark:bg-slate-950/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col my-8">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50">
          <div className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-md font-black text-slate-800 dark:text-slate-100">Identify & Convert Unknown Person</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-550">Fetching unknown details...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col overflow-hidden">
            {/* Modal Body */}
            <div className="p-6 flex-1 overflow-y-auto max-h-[55vh] space-y-5">
              
              {/* Unknown Identity Preview Card */}
              <div className="bg-slate-50 dark:bg-slate-950 border border-slate-150 dark:border-slate-800 p-4 rounded-2xl flex flex-col md:flex-row gap-4 items-center">
                {/* Captured Face Gallery Crops */}
                <div className="flex gap-2">
                  {facePhotos.map(f => (
                    <div key={f.id} className="w-16 h-16 rounded-xl bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 overflow-hidden flex-shrink-0">
                      <AuthedFaceThumb photoPath={f.photoPath} />
                    </div>
                  ))}
                </div>
                {/* Metrics info */}
                <div className="flex-1 text-center md:text-left">
                  <p className="text-sm font-black text-amber-600 font-mono leading-none mb-1">{unknownCode}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">
                    First seen: {firstSeen ? format(new Date(firstSeen), 'MMM d, yyyy h:mm a') : 'N/A'}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold">
                    SIGHTED {visitCount} TIME{visitCount > 1 ? 'S' : ''} ACROSS SECURITY CAMERAS
                  </p>
                </div>
              </div>

              {/* Info Notification Callout */}
              <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 text-blue-800 dark:text-blue-400 rounded-xl p-3 flex gap-2.5 items-start text-xs font-bold">
                <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <p>
                  Converting this profile preserves their historical movement logs and check-in timeline under their new Visitor profile.
                </p>
              </div>

              {/* Name & Company Input */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Full Name <span className="text-rose-500">*</span></Label>
                  <Input 
                    placeholder="Jane Doe" 
                    value={fullName}
                    onChange={e => setFullName(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Company / Organization <span className="text-rose-500">*</span></Label>
                  <Input 
                    placeholder="e.g. Acme Corp" 
                    value={organization}
                    onChange={e => setOrganization(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {/* Phone, Email & Classification */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Phone</Label>
                  <Input 
                    placeholder="+91 98765 43210" 
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Email</Label>
                  <Input 
                    placeholder="jane@company.com" 
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Visitor Type</Label>
                  <select 
                    value={visitorType} 
                    onChange={e => setVisitorType(e.target.value)}
                    className="w-full h-10 px-3 bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm rounded-xl focus:outline-none"
                  >
                    <option value="guest">Guest</option>
                    <option value="vendor">Vendor</option>
                    <option value="contractor">Contractor</option>
                    <option value="consultant">Consultant</option>
                  </select>
                </div>
              </div>

              <div className="w-full h-[1px] bg-slate-100 dark:bg-slate-800 my-2" />

              {/* Host Lookup Combobox */}
              <div className="space-y-1.5 relative">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Host Employee <span className="text-rose-500">*</span></Label>
                <Input
                  placeholder="Type to search employees..."
                  value={hostSearch}
                  onChange={e => {
                    setHostSearch(e.target.value);
                    if (selectedHostId) setSelectedHostId(null);
                  }}
                  onKeyDown={e => {
                    // A plain text input inside a <form> submits on Enter by default,
                    // which would submit before a suggestion is ever clicked and leave
                    // selectedHostId null. Select the top match instead.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (!selectedHostId && filteredHosts.length > 0) {
                        setSelectedHostId(filteredHosts[0].pk_employee_id);
                        setHostSearch(filteredHosts[0].full_name);
                      }
                    }
                  }}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                
                {hostSearch && !selectedHostId && (
                  <div className="absolute z-10 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl mt-1 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 shadow-lg">
                    {filteredHosts.length === 0 ? (
                      <div className="p-3 text-slate-400 dark:text-slate-550 text-xs font-semibold">No employees found</div>
                    ) : (
                      filteredHosts.map(h => (
                        <button
                          key={h.pk_employee_id}
                          type="button"
                          onClick={() => {
                            setSelectedHostId(h.pk_employee_id);
                            setHostSearch(h.full_name);
                          }}
                          className="w-full p-3 text-left text-xs text-slate-655 hover:bg-slate-50 dark:hover:bg-slate-850/50 transition flex justify-between"
                        >
                          <div>
                            <p className="font-bold text-slate-800 dark:text-slate-100">{h.full_name}</p>
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">{h.employee_code}</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Purpose & Schedule */}
              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-550">Visit Purpose <span className="text-rose-500">*</span></Label>
                <Input 
                  placeholder="Reason for conversion (e.g. Scheduled meeting)" 
                  value={visitPurpose}
                  onChange={e => setVisitPurpose(e.target.value)}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-955 text-slate-900 dark:text-slate-100"
                />
              </div>

              {/* Validity bounds */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid From</Label>
                  <div className="flex gap-2">
                    <Input type="date" value={validFromDate} onChange={e => setValidFromDate(e.target.value)} className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs" />
                    <Input type="time" value={validFromTime} onChange={e => setValidFromTime(e.target.value)} className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid To</Label>
                  <div className="flex gap-2">
                    <Input type="date" value={validToDate} onChange={e => setValidToDate(e.target.value)} className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs" />
                    <Input type="time" value={validToTime} onChange={e => setValidToTime(e.target.value)} className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs" />
                  </div>
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex justify-between items-center">
              <Button type="button" variant="ghost" onClick={onClose} className="rounded-xl text-slate-500 dark:text-slate-400 font-bold hover:bg-slate-100 dark:hover:bg-slate-800" disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl px-6">
                {saving ? 'Converting...' : 'Save & Convert →'}
              </Button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
};
