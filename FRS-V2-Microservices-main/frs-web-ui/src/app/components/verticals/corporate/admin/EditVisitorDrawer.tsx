import React, { useState, useEffect } from 'react';
import { X, User, Clock } from 'lucide-react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { toast } from 'sonner';

interface EditVisitorDrawerProps {
  personId: string;
  onClose: () => void;
}

export const EditVisitorDrawer: React.FC<EditVisitorDrawerProps> = ({ personId, onClose }) => {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form State
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [designation, setDesignation] = useState('');
  const [visitorType, setVisitorType] = useState('guest');
  const [status, setStatus] = useState('active');

  // Visit parameters
  const [hostSearch, setHostSearch] = useState('');
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [visitPurpose, setVisitPurpose] = useState('');
  const [validFromDate, setValidFromDate] = useState('');
  const [validFromTime, setValidFromTime] = useState('09:00');
  const [validToDate, setValidToDate] = useState('');
  const [validToTime, setValidToTime] = useState('18:00');

  // Fetch visitor details
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        // Fetch employees
        const empRes = await apiRequest<{ data: any[] }>('/employees', { accessToken });
        if (empRes && empRes.data) setEmployees(empRes.data);

        // Fetch profile details
        const res = await apiRequest<{ success: boolean; profile: any }>('/people/' + personId, { accessToken });
        if (res.success && res.profile) {
          const prof = res.profile;
          setFullName(prof.name);
          setPhone(prof.phone || '');
          setEmail(prof.email || '');
          setOrganization(prof.organization || '');
          setDesignation(prof.designation || '');
          setStatus(prof.status || 'active');

          if (prof.visitorDetails) {
            const v = prof.visitorDetails;
            setVisitorType(v.visitorType || 'guest');
            setSelectedHostId(v.hostEmployeeId);
            setHostSearch(v.hostEmployeeName || '');
            setVisitPurpose(v.visitPurpose || '');
            
            if (v.validFrom) {
              const d = new Date(v.validFrom);
              setValidFromDate(d.toISOString().split('T')[0]);
              setValidFromTime(d.toTimeString().slice(0, 5));
            }
            if (v.validTo) {
              const d = new Date(v.validTo);
              setValidToDate(d.toISOString().split('T')[0]);
              setValidToTime(d.toTimeString().slice(0, 5));
            }
          }
        }
      } catch (err: any) {
        toast.error(err.message || 'Failed to load details');
        onClose();
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [personId, accessToken]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !organization || !selectedHostId) {
      toast.error('Name, Organization, and Host are required');
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
        validTo,
        status
      };

      const res = await apiRequest<{ success: boolean }>(`/people/visitors/${personId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        accessToken
      });

      if (res.success) {
        toast.success('Visitor profile updated successfully!');
        onClose();
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to save updates');
    } finally {
      setSaving(false);
    }
  };

  const filteredHosts = employees.filter(e => 
    e.full_name.toLowerCase().includes(hostSearch.toLowerCase()) ||
    e.employee_code.toLowerCase().includes(hostSearch.toLowerCase())
  ).slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 dark:bg-slate-950/60 backdrop-blur-sm">
      {/* Click outside to close */}
      <div className="flex-1" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border-l border-slate-100 dark:border-slate-800 h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50">
          <h2 className="text-sm font-black text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <User className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            Edit Visitor Profile
          </h2>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-555 hover:text-slate-600 dark:hover:text-slate-300 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
            <Clock className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-550">Loading profile data...</p>
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex-1 flex flex-col overflow-hidden">
            {/* Scrollable Form Body */}
            <div className="p-6 flex-1 overflow-y-auto space-y-5">
              
              {/* Full Name */}
              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Full Name <span className="text-rose-500">*</span></Label>
                <Input 
                  value={fullName} 
                  onChange={e => setFullName(e.target.value)}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              {/* Organization & Designation */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Company <span className="text-rose-500">*</span></Label>
                  <Input 
                    value={organization} 
                    onChange={e => setOrganization(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Role / Designation</Label>
                  <Input 
                    value={designation} 
                    onChange={e => setDesignation(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {/* Contact details */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Phone</Label>
                  <Input 
                    value={phone} 
                    onChange={e => setPhone(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Email</Label>
                  <Input 
                    value={email} 
                    onChange={e => setEmail(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {/* Classification & Status */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Type</Label>
                  <select 
                    value={visitorType} 
                    onChange={e => setVisitorType(e.target.value)}
                    className="w-full h-10 px-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm rounded-xl focus:outline-none"
                  >
                    <option value="guest">Guest</option>
                    <option value="vendor">Vendor</option>
                    <option value="contractor">Contractor</option>
                    <option value="consultant">Consultant</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Status</Label>
                  <select 
                    value={status} 
                    onChange={e => setStatus(e.target.value)}
                    className="w-full h-10 px-3 bg-white dark:bg-slate-955 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm rounded-xl focus:outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              <div className="w-full h-[1px] bg-slate-100 dark:bg-slate-800 my-2" />

              {/* Host lookup */}
              <div className="space-y-1.5 relative">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Host Employee <span className="text-rose-500">*</span></Label>
                <Input 
                  value={hostSearch}
                  onChange={e => {
                    setHostSearch(e.target.value);
                    if (selectedHostId) setSelectedHostId(null);
                  }}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                
                {hostSearch && !selectedHostId && (
                  <div className="absolute z-10 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl mt-1 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 shadow-lg">
                    {filteredHosts.length === 0 ? (
                      <div className="p-3 text-slate-400 dark:text-slate-500 text-xs font-semibold">No employees found</div>
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

              {/* Visit Purpose */}
              <div className="space-y-1.5">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-550">Visit Purpose <span className="text-rose-500">*</span></Label>
                <Input 
                  value={visitPurpose} 
                  onChange={e => setVisitPurpose(e.target.value)}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              {/* Validity windows */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid From Date</Label>
                  <Input 
                    type="date" 
                    value={validFromDate}
                    onChange={e => setValidFromDate(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs"
                  />
                  <Input 
                    type="time" 
                    value={validFromTime}
                    onChange={e => setValidFromTime(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-955 text-slate-900 dark:text-slate-100 text-xs mt-2"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid To Date</Label>
                  <Input 
                    type="date" 
                    value={validToDate}
                    onChange={e => setValidToDate(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs"
                  />
                  <Input 
                    type="time" 
                    value={validToTime}
                    onChange={e => setValidToTime(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-955 text-slate-900 dark:text-slate-100 text-xs mt-2"
                  />
                </div>
              </div>

            </div>

            {/* Sticky Actions Footer */}
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={onClose} className="rounded-xl text-slate-500 dark:text-slate-400 font-bold hover:bg-slate-100 dark:hover:bg-slate-800">
                Cancel
              </Button>
              <Button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl px-6">
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
};
