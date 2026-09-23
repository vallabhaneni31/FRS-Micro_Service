import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Loader2, Check, Upload, Trash2, User, Phone, Mail, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest, ApiError } from '../../../services/http/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { cn } from '../../ui/utils';

const TRANSPORT_BASE = '/transport';
const CALENDAR_DAYS = 30;

// Exact slugs face_quality_service.py validates pose against — must match
// EnrollmentService.VALID_ANGLES on the backend.
const ANGLES: { slug: string; label: string }[] = [
  { slug: 'front', label: 'Front' },
  { slug: 'left', label: 'Left' },
  { slug: 'right', label: 'Right' },
  { slug: 'up', label: 'Up' },
  { slug: 'down', label: 'Down' },
  { slug: 'left_up', label: 'Left-Up' },
  { slug: 'right_up', label: 'Right-Up' },
  { slug: 'up_deep', label: 'Look Up High' },
];

interface PassengerDetail {
  id: string; passengerCode: string; fullName: string; phone: string | null; email: string | null;
  boardingStop: string | null; deboardingStop: string | null; status: string;
}
interface EmbeddingSummary { id: string; angle: string; qualityScore: number | null; modelVersion: string; createdAt: string; }
interface BoardingEventRow { id: string; eventType: string; passengerId: string | null; eventTime: string; }

interface PassengerProfilePanelProps {
  passengerId: string;
  busId: string;
  open: boolean;
  onClose: () => void;
  onEnrollmentChanged?: () => void;
}

export const PassengerProfilePanel: React.FC<PassengerProfilePanelProps> = ({
  passengerId, busId, open, onClose, onEnrollmentChanged,
}) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [passenger, setPassenger] = useState<PassengerDetail | null>(null);
  const [embeddings, setEmbeddings] = useState<EmbeddingSummary[]>([]);
  const [events, setEvents] = useState<BoardingEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingAngle, setUploadingAngle] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(() => {
    if (!accessToken || !passengerId) return;
    setLoading(true);
    const from = new Date(Date.now() - CALENDAR_DAYS * 24 * 3600 * 1000).toISOString();
    Promise.all([
      apiRequest<PassengerDetail>(`${TRANSPORT_BASE}/passengers/${passengerId}`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<EmbeddingSummary[]>(`${TRANSPORT_BASE}/passengers/${passengerId}/photos`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ content: BoardingEventRow[] }>(
        `${TRANSPORT_BASE}/events?busId=${busId}&from=${encodeURIComponent(from)}&size=200`,
        { method: 'GET', accessToken, scopeHeaders, noCache: true }
      ),
    ])
      .then(([p, e, ev]) => {
        setPassenger(p);
        setEmbeddings(e ?? []);
        setEvents((ev?.content ?? []).filter(x => x.passengerId === passengerId));
      })
      .catch(() => toast.error('Failed to load passenger profile'))
      .finally(() => setLoading(false));
  }, [accessToken, passengerId, busId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const angleCaptured = useMemo(() => new Set(embeddings.map(e => e.angle)), [embeddings]);

  const handleFileSelected = async (slug: string, file: File) => {
    setUploadingAngle(slug);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      formData.append('angle', slug);
      await apiRequest(`${TRANSPORT_BASE}/passengers/${passengerId}/photos`, {
        method: 'POST', accessToken, scopeHeaders, body: formData,
      });
      toast.success(`${ANGLES.find(a => a.slug === slug)?.label} captured`);
      const fresh = await apiRequest<EmbeddingSummary[]>(`${TRANSPORT_BASE}/passengers/${passengerId}/photos`, { method: 'GET', accessToken, scopeHeaders, noCache: true });
      setEmbeddings(fresh ?? []);
      onEnrollmentChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Capture failed — retake the photo');
    } finally {
      setUploadingAngle(null);
    }
  };

  const resetEnrollment = async () => {
    try {
      await apiRequest(`${TRANSPORT_BASE}/passengers/${passengerId}/photos`, { method: 'DELETE', accessToken, scopeHeaders });
      setEmbeddings([]);
      toast.success('Enrollment reset');
      onEnrollmentChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to reset enrollment');
    }
  };

  // Day -> boarded/deboarded pairing, last CALENDAR_DAYS days, oldest first.
  const calendarDays = useMemo(() => {
    const byDay = new Map<string, BoardingEventRow[]>();
    events.forEach(e => {
      const day = e.eventTime.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), e]);
    });
    const days: { date: string; label: string; present: boolean }[] = [];
    for (let i = CALENDAR_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      days.push({ date: iso, label: String(d.getDate()), present: (byDay.get(iso) ?? []).length > 0 });
    }
    return days;
  }, [events]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        {loading || !passenger ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <DialogTitle>{passenger.fullName}</DialogTitle>
                  <DialogDescription>
                    <span className="font-mono">{passenger.passengerCode}</span>
                    {' · '}
                    <Badge variant={angleCaptured.size > 0 ? 'default' : 'outline'} className="ml-1">
                      {angleCaptured.size > 0 ? 'Enrolled' : 'Not Enrolled'}
                    </Badge>
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-2">
              {/* Identity */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Passenger Details</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-muted-foreground" /> {passenger.phone ?? '—'}</div>
                  <div className="flex items-center gap-2"><Mail className="w-3.5 h-3.5 text-muted-foreground" /> {passenger.email ?? '—'}</div>
                  <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-muted-foreground" /> {passenger.boardingStop ?? '—'} → {passenger.deboardingStop ?? '—'}</div>
                </div>

                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground pt-2">Biometric Enrollment</h3>
                <div className="grid grid-cols-4 gap-2">
                  {ANGLES.map(a => {
                    const captured = angleCaptured.has(a.slug);
                    const isUploading = uploadingAngle === a.slug;
                    return (
                      <div key={a.slug} className="text-center">
                        <button
                          type="button"
                          disabled={isUploading}
                          onClick={() => fileInputs.current[a.slug]?.click()}
                          className={cn(
                            'w-full aspect-square rounded-xl border-2 border-dashed flex items-center justify-center transition-colors',
                            captured ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30' : 'border-border hover:border-primary'
                          )}
                        >
                          {isUploading ? (
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          ) : captured ? (
                            <Check className="w-5 h-5 text-emerald-600" />
                          ) : (
                            <Upload className="w-4 h-4 text-muted-foreground" />
                          )}
                        </button>
                        <input
                          ref={(el) => { fileInputs.current[a.slug] = el; }}
                          type="file"
                          accept="image/*"
                          capture="user"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelected(a.slug, f); e.target.value = ''; }}
                        />
                        <p className="text-[10px] font-medium mt-1 text-muted-foreground">{a.label}</p>
                      </div>
                    );
                  })}
                </div>
                {angleCaptured.size > 0 && (
                  <Button variant="outline" size="sm" className="w-full text-red-600 hover:text-red-700" onClick={resetEnrollment}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Reset Enrollment
                  </Button>
                )}
              </div>

              {/* Attendance calendar */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Last {CALENDAR_DAYS} Days</h3>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">No boarding activity in this window yet.</p>
                ) : (
                  <div className="grid grid-cols-10 gap-1.5">
                    {calendarDays.map(d => (
                      <div
                        key={d.date}
                        title={d.date}
                        className={cn(
                          'aspect-square rounded-md flex items-center justify-center text-[10px] font-semibold',
                          d.present ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {d.label}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {calendarDays.filter(d => d.present).length} of {CALENDAR_DAYS} days with boarding activity
                </p>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PassengerProfilePanel;
