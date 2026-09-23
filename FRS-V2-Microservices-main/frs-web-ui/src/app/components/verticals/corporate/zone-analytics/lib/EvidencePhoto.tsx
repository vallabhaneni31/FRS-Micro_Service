import React from 'react';
import { Camera, ImageOff } from 'lucide-react';
import { useAuthedPhotoUrl } from '../../../../../services/http/authedPhoto';
import { NO_PHOTO_TEXT } from './copy';

export type PhotoKind = 'Event photo' | 'Check-in' | 'Check-out';

/**
 * Evidence photo (Req 9.6/9.7). `photoUrl` is the bare filename the API returns;
 * it is served through the existing authorised /uploads path (no direct URL).
 * A null photo shows "No photo recorded" — never an error, never a stock image.
 */
export const EvidencePhoto: React.FC<{ photoUrl: string | null | undefined; kind: PhotoKind; compact?: boolean }> = ({ photoUrl, kind, compact }) => {
  const { url, loading, error } = useAuthedPhotoUrl(photoUrl ? `/uploads/${photoUrl}` : null);
  const size = compact ? 'w-10 h-10' : 'w-16 h-16';
  return (
    <figure data-testid="evidence-photo" data-kind={kind} className="inline-flex flex-col items-center gap-0.5 m-0">
      {!photoUrl ? (
        <div className={`${size} rounded-lg bg-slate-50 border border-dashed border-slate-200 flex flex-col items-center justify-center text-[8px] leading-tight text-slate-400 text-center p-0.5`}>
          <ImageOff className="w-3.5 h-3.5" />
          {!compact && <span>{NO_PHOTO_TEXT}</span>}
        </div>
      ) : url ? (
        <img src={url} alt={`${kind} evidence`} className={`${size} rounded-lg object-cover border border-slate-200`} />
      ) : (
        <div className={`${size} rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-300`} aria-busy={loading}>
          <Camera className="w-4 h-4" />
          {error && <span className="sr-only">Photo unavailable</span>}
        </div>
      )}
      <figcaption className="text-[9px] text-slate-400 font-medium">{kind}</figcaption>
      {!photoUrl && compact && <span className="sr-only">{NO_PHOTO_TEXT}</span>}
    </figure>
  );
};
