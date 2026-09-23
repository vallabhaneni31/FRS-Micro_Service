import React, { useState, useEffect, useRef } from 'react';
import { X, UserCheck, Camera, Upload, CheckCircle2 } from 'lucide-react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';

interface VisitorRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const VisitorRegistrationModal: React.FC<VisitorRegistrationModalProps> = ({ isOpen, onClose }) => {
  const { accessToken } = useAuth();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  // Form State
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [designation, setDesignation] = useState('');
  const [visitorType, setVisitorType] = useState('guest');
  
  // Visit Params
  const [hostSearch, setHostSearch] = useState('');
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [employees, setEmployees] = useState<any[]>([]);
  const [visitPurpose, setVisitPurpose] = useState('');
  const [visitDate, setVisitDate] = useState(new Date().toISOString().split('T')[0]);
  const [validFromTime, setValidFromTime] = useState('09:00');
  const [validToTime, setValidToTime] = useState('18:00');
  const [vehicleNumber, setVehicleNumber] = useState('');

  // Biometric Enrollment State
  const [enrollMode, setEnrollMode] = useState<'upload' | 'camera'>('upload');
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [faceConfidence, setFaceConfidence] = useState<number | null>(null);
  const [sendInvite, setSendInvite] = useState(false);
  
  // Camera state
  const [cameraActive, setCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Fetch employees list for host combobox
  useEffect(() => {
    const fetchEmployees = async () => {
      try {
        const res = await apiRequest<{ data: any[] }>('/employees', { accessToken });
        if (res && res.data) {
          setEmployees(res.data);
        }
      } catch (_) {}
    };
    fetchEmployees();
  }, [accessToken]);

  // Handle camera activation
  const startCamera = async () => {
    setCameraActive(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 480 } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      toast.error('Unable to access webcam');
      setCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, 480, 480);
        const base64 = canvas.toDataURL('image/jpeg');
        setPhotoBase64(base64);
        setFaceConfidence(0.96); // Mock high confidence for testing
        stopCamera();
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoBase64(reader.result as string);
        setFaceConfidence(0.89); // Mock confidence
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async () => {
    if (!fullName || !organization || !selectedHostId) {
      toast.error('Please complete all required fields');
      return;
    }

    if (sendInvite && !email) {
      toast.error('Email is required to send remote enrollment invitation');
      return;
    }

    setLoading(true);
    try {
      const validFrom = `${visitDate}T${validFromTime}:00Z`;
      const validTo = `${visitDate}T${validToTime}:00Z`;

      const payload: any = {
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

      if (sendInvite) {
        payload.sendInvite = true;
      } else {
        // Mock a 512 embedding vector for the test snapshot
        const mockEmbedding = Array.from({ length: 512 }, () => Math.random() * 2 - 1);
        payload.photoUrl = photoBase64;
        payload.embedding = mockEmbedding;
      }

      const res = await apiRequest<{ success: boolean }>('/people/visitors', {
        method: 'POST',
        body: JSON.stringify(payload),
        accessToken
      });

      if (res.success) {
        toast.success(
          sendInvite 
            ? `Visitor ${fullName} registered and invitation email sent!`
            : `Visitor ${fullName} registered successfully!`
        );
        onClose();
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to register visitor');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  // Filtered employees for Combobox
  const filteredHosts = employees.filter(e => 
    e.full_name.toLowerCase().includes(hostSearch.toLowerCase()) ||
    e.employee_code.toLowerCase().includes(hostSearch.toLowerCase())
  ).slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-955/40 dark:bg-slate-950/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col my-8">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50">
          <div className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-md font-black text-slate-800 dark:text-slate-100">Register Visitor</h2>
          </div>
          <button 
            onClick={() => {
              stopCamera();
              onClose();
            }} 
            className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Wizard Steps indicator */}
        <div className="px-6 py-4 bg-slate-50/20 dark:bg-slate-950/20 border-b border-slate-100 dark:border-slate-800 flex items-center justify-center gap-8">
          <div className={cn("flex items-center gap-2 text-xs font-bold", step >= 1 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-550')}>
            <span className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black", step === 1 ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400')}>1</span>
            Profile Info
          </div>
          <div className="w-8 h-[1px] bg-slate-200 dark:bg-slate-800" />
          <div className={cn("flex items-center gap-2 text-xs font-bold", step >= 2 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-550')}>
            <span className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black", step === 2 ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400')}>2</span>
            Visit Schedule
          </div>
          <div className="w-8 h-[1px] bg-slate-200 dark:bg-slate-800" />
          <div className={cn("flex items-center gap-2 text-xs font-bold", step >= 3 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-550')}>
            <span className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black", step === 3 ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400')}>3</span>
            Biometrics
          </div>
        </div>

        {/* Form Body */}
        <div className="p-6 flex-1 overflow-y-auto max-h-[50vh]">
          
          {/* STEP 1: Profile Details */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Full Name <span className="text-rose-500">*</span></Label>
                  <Input 
                    placeholder="John Doe" 
                    value={fullName} 
                    onChange={e => setFullName(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Organization / Company <span className="text-rose-500">*</span></Label>
                  <Input 
                    placeholder="e.g. Acme Corp" 
                    value={organization} 
                    onChange={e => setOrganization(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Phone Number</Label>
                  <Input 
                    type="tel"
                    placeholder="+91 98765 43210" 
                    value={phone} 
                    onChange={e => setPhone(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Email Address</Label>
                  <Input 
                    type="email"
                    placeholder="john@example.com" 
                    value={email} 
                    onChange={e => setEmail(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Designation / Role</Label>
                  <Input 
                    placeholder="e.g. Consultant" 
                    value={designation} 
                    onChange={e => setDesignation(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Visitor Classification</Label>
                  <select 
                    value={visitorType} 
                    onChange={e => setVisitorType(e.target.value)}
                    className="w-full h-10 px-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm rounded-xl focus:outline-none"
                  >
                    <option value="guest">Guest / Personal</option>
                    <option value="vendor">Vendor / Supplier</option>
                    <option value="contractor">Contractor</option>
                    <option value="consultant">Consultant</option>
                    <option value="candidate">Candidate</option>
                    <option value="auditor">Auditor</option>
                    <option value="delivery">Delivery</option>
                    <option value="temp_worker">Temporary Worker</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: Visit Schedule */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-1.5 relative">
                <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Host Employee <span className="text-rose-500">*</span></Label>
                <Input 
                  placeholder="Type to search employees..." 
                  value={hostSearch}
                  onChange={e => {
                    setHostSearch(e.target.value);
                    if (selectedHostId) setSelectedHostId(null);
                  }}
                  className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
                
                {/* Search result dropdown */}
                {hostSearch && !selectedHostId && (
                  <div className="absolute z-10 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl mt-1 overflow-hidden shadow-lg divide-y divide-slate-100 dark:divide-slate-800">
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
                          className="w-full p-3 text-left text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850/50 transition flex justify-between items-center"
                        >
                          <div>
                            <p className="font-bold text-slate-800 dark:text-slate-100">{h.full_name}</p>
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">{h.employee_code} | {h.department_name || 'No Dept'}</p>
                          </div>
                          <span className="text-[9px] text-blue-600 dark:text-blue-400 font-bold">Select</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Date of Visit</Label>
                  <Input 
                    type="date" 
                    value={visitDate}
                    onChange={e => setVisitDate(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid From</Label>
                  <Input 
                    type="time" 
                    value={validFromTime}
                    onChange={e => setValidFromTime(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Valid To</Label>
                  <Input 
                    type="time" 
                    value={validToTime}
                    onChange={e => setValidToTime(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Vehicle Number (Optional)</Label>
                  <Input 
                    placeholder="e.g. KA-01-AB-1234" 
                    value={vehicleNumber}
                    onChange={e => setVehicleNumber(e.target.value.toUpperCase())}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400 dark:text-slate-500">Purpose of Visit <span className="text-rose-500">*</span></Label>
                  <Input 
                    placeholder="e.g. Vendor onboarding meeting" 
                    value={visitPurpose}
                    onChange={e => setVisitPurpose(e.target.value)}
                    className="rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Biometrics (Face Photo) */}
          {step === 3 && (
            <div className="space-y-6 flex flex-col items-center w-full">
              
              {/* Option to send remote invitation via email */}
              <div className="w-full max-w-sm bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 rounded-xl p-4 mb-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendInvite}
                    onChange={(e) => {
                      setSendInvite(e.target.checked);
                      if (e.target.checked) {
                        stopCamera();
                      }
                    }}
                    className="mt-1 w-4 h-4 text-blue-600 border-slate-300 dark:border-slate-700 rounded focus:ring-blue-500 dark:bg-slate-950"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">Enroll remotely via Email</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Send a secure self-enrollment link to the visitor's email address ({email || <span className="text-red-500 font-bold">missing email address</span>}) to let them capture their own face photo.
                    </p>
                  </div>
                </label>
              </div>

              {!sendInvite ? (
                <>
                  {/* Selector */}
                  <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl w-60 justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        stopCamera();
                        setEnrollMode('upload');
                      }}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-bold rounded-lg transition",
                        enrollMode === 'upload' ? 'bg-blue-600 text-white' : 'text-slate-500 dark:text-slate-400'
                      )}
                    >
                      <Upload className="w-3.5 h-3.5 inline mr-1" />
                      Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEnrollMode('camera');
                        startCamera();
                      }}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-bold rounded-lg transition",
                        enrollMode === 'camera' ? 'bg-blue-600 text-white' : 'text-slate-500 dark:text-slate-400'
                      )}
                    >
                      <Camera className="w-3.5 h-3.5 inline mr-1" />
                      Webcam
                    </button>
                  </div>

                  {/* Upload Zone */}
                  {enrollMode === 'upload' ? (
                    <div className="w-64 h-64 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl flex flex-col items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 relative overflow-hidden">
                      {photoBase64 ? (
                        <>
                          <img src={photoBase64} alt="Preview" className="w-full h-full object-cover rounded-xl" />
                          <button 
                            onClick={() => setPhotoBase64(null)}
                            className="absolute top-2 right-2 bg-red-600 text-white p-1 rounded-full hover:bg-red-700 shadow-md"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <label className="flex flex-col items-center justify-center gap-2 cursor-pointer w-full h-full">
                          <Upload className="w-8 h-8 text-slate-400 dark:text-slate-500" />
                          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Select Image File</span>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">JPG, PNG or WEBP (Max 5MB)</span>
                          <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                        </label>
                      )}
                    </div>
                  ) : (
                    /* Webcam Zone */
                    <div className="w-64 h-64 border border-slate-200 dark:border-slate-800 rounded-2xl flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-950 relative overflow-hidden">
                      {photoBase64 ? (
                        <>
                          <img src={photoBase64} alt="Captured" className="w-full h-full object-cover rounded-xl" />
                          <button 
                            onClick={() => {
                              setPhotoBase64(null);
                              startCamera();
                            }}
                            className="absolute top-2 right-2 bg-red-655 text-white p-1 rounded-full hover:bg-red-700 shadow-md"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : cameraActive ? (
                        <>
                          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover rounded-xl" />
                          <div className="absolute inset-0 border-4 border-blue-500/30 rounded-full scale-75 border-dashed pointer-events-none" />
                          
                          <Button 
                            size="sm"
                            onClick={capturePhoto}
                            className="absolute bottom-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl h-8 px-4 font-bold text-xs"
                          >
                            Capture Snap
                          </Button>
                        </>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <Camera className="w-8 h-8 text-slate-400 dark:text-slate-500" />
                          <Button size="sm" onClick={startCamera} className="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-xl h-8 text-slate-700 dark:text-slate-300 font-bold border border-transparent dark:border-slate-700">
                            Activate WebCam
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Quality Indicators */}
                  {photoBase64 && faceConfidence && (
                    <div className="w-full max-w-sm bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/30 rounded-xl p-3 flex items-center justify-between text-xs font-bold text-emerald-800 dark:text-emerald-400">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-450" />
                        <span>Biometric Quality Check Passed</span>
                      </div>
                      <span className="font-black text-emerald-600 dark:text-emerald-450 bg-white dark:bg-slate-950 px-2 py-0.5 rounded-md border border-emerald-250 dark:border-emerald-900/30">
                        {(faceConfidence * 100).toFixed(0)}% Match
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-blue-200 dark:border-blue-900/30 rounded-2xl bg-blue-50/20 dark:bg-blue-950/10 max-w-sm text-center">
                  <UserCheck className="w-12 h-12 text-blue-600 dark:text-blue-400 mb-3" />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200">Remote Registration Active</span>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                    Upon completing registration, a secure email invitation will be dispatched to <strong>{email}</strong>.
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-550 mt-1">
                    The visitor can open the link on their mobile device or laptop to submit their enrollment photos.
                  </p>
                </div>
              )}

            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={() => {
              if (step === 1) {
                stopCamera();
                onClose();
              } else {
                setStep(step - 1);
              }
            }}
            className="text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl font-bold"
            disabled={loading}
          >
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>

          <Button
            onClick={() => {
              if (step < 3) {
                if (step === 1 && (!fullName || !organization)) {
                  toast.error('Name and Organization are required');
                  return;
                }
                if (step === 2 && !selectedHostId) {
                  toast.error('Please select a valid Host Employee');
                  return;
                }
                setStep(step + 1);
              } else {
                handleSubmit();
              }
            }}
            className="bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl px-6"
            disabled={loading}
          >
            {loading ? 'Processing...' : step === 3 ? (sendInvite ? 'Register & Send Invite' : 'Register Visitor') : 'Next Step'}
          </Button>
        </div>

      </div>
    </div>
  );
};

