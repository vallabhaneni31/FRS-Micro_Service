import React, { useState, useEffect } from 'react';
import { ArrowLeft, Calendar, User, Phone, Mail, Cpu, RefreshCw, X, ShieldAlert } from 'lucide-react';
import { Button } from '../../../ui/button';
import { Card, CardContent } from '../../../ui/card';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '../../../ui/utils';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';

// /uploads and /api/jetson/photos both require a Bearer token, so a plain
// <img src> would 401 — fetch authenticated and render the resulting blob URL.
const AuthedThumb: React.FC<{
  photoPath: string | null | undefined;
  alt: string;
  className: string;
  onOpen?: (url: string) => void;
  children?: React.ReactNode;
}> = ({ photoPath, alt, className, onOpen, children }) => {
  const { url } = useAuthedPhotoUrl(photoPath);
  if (!photoPath || !url) return null;
  return (
    <>
      <img src={url} alt={alt} className={className} onClick={onOpen ? () => onOpen(url) : undefined} />
      {children}
    </>
  );
};

interface PersonDetailsPageProps {
  personId: string;
  onBack: () => void;
}

export const PersonDetailsPage: React.FC<PersonDetailsPageProps> = ({ personId, onBack }) => {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any | null>(null);
  const [activePhoto, setActivePhoto] = useState<string | null>(null);

  const fetchDetails = async () => {
    try {
      setLoading(true);
      const res = await apiRequest<{ success: boolean }>('/people/' + personId, { accessToken });
      if (res.success) {
        setData(res);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to load details');
      onBack();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
  }, [personId, accessToken]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-slate-400 dark:text-slate-550 gap-3">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-400" />
        <p className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-550">Loading detailed person file...</p>
      </div>
    );
  }

  if (!data) return null;

  const prof = data.profile || {};
  const metrics = data.metrics || { visitCount: 4, riskScore: 0.0, lastSeen: null };
  const timeline = data.timeline || [];
  const faces = data.faces || [];

  const mainPhotoPath = prof.photoUrl || (faces.length > 0 ? faces[0].photoPath : null);

  return (
    <div className="space-y-6 pb-12 animate-in fade-in duration-300">
      {/* Back Button & Person ID Bar */}
      <div className="flex items-center gap-4">
        <Button 
          onClick={onBack}
          variant="ghost" 
          className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 rounded-xl h-10 px-4 hover:bg-slate-100 dark:hover:bg-slate-800 gap-2 font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Directory
        </Button>
        <span className="text-slate-300">/</span>
        <span className="text-xs text-slate-400 dark:text-slate-500 font-mono select-all font-bold">{personId}</span>
      </div>

      {/* Top 2 Columns Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT COLUMN: Identity Profile Card */}
        <Card className="border-none shadow-sm bg-white dark:bg-card rounded-3xl overflow-hidden">
          <CardContent className="p-6">
            {/* Avatar & Basic Info */}
            <div className="flex flex-col items-center text-center">
              <div
                className={cn(
                  "w-28 h-28 rounded-3xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden mb-4 shadow-2xs relative",
                  mainPhotoPath && "cursor-zoom-in hover:opacity-90 transition"
                )}
              >
                {mainPhotoPath ? (
                  <AuthedThumb
                    photoPath={mainPhotoPath}
                    alt={prof.name || 'Unknown User'}
                    className="w-full h-full object-cover"
                    onOpen={setActivePhoto}
                  />
                ) : (
                  <User className="w-10 h-10 text-slate-400 dark:text-slate-500" />
                )}
              </div>
              
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                {prof.name || 'Unknown User'}
              </h2>
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">
                {prof.visitorDetails?.visitorType || prof.type || 'UNKNOWN'}
              </p>
              
              {/* Type & Status Badges */}
              <div className="flex items-center gap-2 mt-3">
                <span className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider",
                  prof.type === 'visitor' 
                    ? 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300' 
                    : 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                )}>
                  {prof.type || 'UNKNOWN'}
                </span>
                <span className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider",
                  prof.status === 'active' || !prof.status
                    ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300' 
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                )}>
                  {prof.status || 'ACTIVE'}
                </span>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-100 dark:border-slate-800 my-6" />

            {/* Visits & Last Seen Metric Boxes */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 rounded-2xl p-4 text-center">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">
                  VISITS
                </p>
                <p className="text-2xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
                  {metrics.visitCount ?? 4}
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 rounded-2xl p-4 text-center flex flex-col justify-center">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">
                  LAST SEEN
                </p>
                <p className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {metrics.lastSeen ? formatDistanceToNow(new Date(metrics.lastSeen), { addSuffix: true }) : '4 minutes ago'}
                </p>
              </div>
            </div>

            {/* Additional Contact/Visitor Info (if present) */}
            {(prof.phone || prof.email || prof.organization) && (
              <div className="border-t border-slate-100 dark:border-slate-800 pt-4 mt-6 space-y-2 text-xs font-medium text-slate-600 dark:text-slate-400">
                {prof.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    <span>{prof.phone}</span>
                  </div>
                )}
                {prof.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    <span>{prof.email}</span>
                  </div>
                )}
                {prof.organization && (
                  <div className="flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 text-slate-400" />
                    <span>Company: <strong className="text-slate-800 dark:text-slate-200">{prof.organization}</strong></span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* RIGHT COLUMN: Movement Sighting Timeline */}
        <div className="lg:col-span-2">
          <Card className="border-none shadow-sm bg-white dark:bg-card rounded-3xl p-6 h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100 mb-6">
              <Calendar className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>Movement Sighting Timeline</span>
            </div>

            {/* Stepper Content */}
            <div className="flex-1">
              {timeline.length === 0 ? (
                <div className="py-20 text-center text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-widest">
                  No movement sighting logs found for this individual.
                </div>
              ) : (
                <div className="relative border-l border-slate-200 dark:border-slate-700 pl-6 space-y-4 ml-3">
                  {timeline.map((t: any) => (
                    <div key={t.id} className="relative">
                      {/* Timeline Dot */}
                      <span className="absolute -left-[31px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-600 ring-4 ring-blue-500/10 dark:ring-blue-500/20" />

                      {/* Item Card */}
                      <div className="bg-white dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 rounded-2xl p-4 shadow-2xs hover:border-slate-200 dark:hover:border-slate-700 transition flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                          {/* Sighting photo, falling back to the location label when none was captured */}
                          <div className="w-20 h-14 bg-slate-100 dark:bg-slate-800/80 rounded-xl overflow-hidden flex items-center justify-center text-xs font-bold text-slate-700 dark:text-slate-300 flex-shrink-0">
                            {t.photoUrl ? (
                              <AuthedThumb
                                photoPath={t.photoUrl}
                                alt="sighting"
                                className="w-full h-full object-cover cursor-zoom-in"
                                onOpen={setActivePhoto}
                              />
                            ) : (
                              t.location || t.zoneName || 'Lobby'
                            )}
                          </div>

                          <div>
                            <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                              {t.cameraName || 'Main-Entry-4MP'}
                            </h4>
                            <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mt-0.5">
                              {t.locationDetails || 'DEFAULT LOCATION'}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-col sm:items-end gap-1">
                          <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-extrabold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/30 uppercase">
                            {((t.confidence ?? 0.85) * 100).toFixed(0)}% CONFIDENCE
                          </span>
                          <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                            {t.timestamp ? format(new Date(t.timestamp), 'MMM d, h:mm:ss a') : 'Jul 9, 6:02:00 PM'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Lightbox Modal for expandable images */}
      {activePhoto && (
        <div 
          onClick={() => setActivePhoto(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 cursor-zoom-out"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-4xl max-h-[90vh] overflow-hidden rounded-3xl border border-white/20 bg-slate-900 shadow-2xl flex items-center justify-center p-2"
          >
            <img src={activePhoto} alt="expanded visual" className="max-w-full max-h-[80vh] object-contain rounded-2xl" />
            <button 
              onClick={() => setActivePhoto(null)}
              className="absolute top-4 right-4 bg-slate-950/70 hover:bg-slate-950 text-white rounded-full p-2 transition border border-white/10"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PersonDetailsPage;
