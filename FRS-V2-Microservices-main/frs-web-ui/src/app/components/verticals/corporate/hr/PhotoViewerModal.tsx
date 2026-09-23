import React from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/utils';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';

interface PhotoViewerModalProps {
  photos: Array<{
    id: string;
    photoUrl: string;
    angle?: string;
    qualityScore?: number;
    enrolledAt?: string;
  }>;
  initialIndex: number;
  onClose: () => void;
  onDelete?: (id: string, angle?: string) => void;
}

const ModalPhotoImg: React.FC<{ photoUrl: string; alt: string; className?: string }> = ({ photoUrl, alt, className }) => {
  const { url, loading, error } = useAuthedPhotoUrl(photoUrl);
  if (loading) return <div className={cn("animate-pulse bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-xs text-slate-400", className)}>Loading...</div>;
  if (error || !url) return <div className={cn("bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-xs text-slate-400", className)}>No image</div>;
  return <img src={url} alt={alt} className={className} />;
};

export function PhotoViewerModal({ photos, initialIndex, onClose, onDelete }: PhotoViewerModalProps) {
  const [currentIndex, setCurrentIndex] = React.useState(initialIndex);

  const currentPhoto = photos[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < photos.length - 1;

  const handlePrev = () => {
    if (hasPrev) setCurrentIndex(currentIndex - 1);
  };

  const handleNext = () => {
    if (hasNext) setCurrentIndex(currentIndex + 1);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowLeft') handlePrev();
    if (e.key === 'ArrowRight') handleNext();
  };

  React.useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex]);

  return createPortal(
    <div
      // Portalled to <body> — this card renders inside a glass-card ancestor
      // with backdrop-filter, which creates a CSS containing block for any
      // `position: fixed` descendant. Without the portal, "fixed inset-0"
      // was being trapped inside that small card's own box instead of
      // covering the viewport, so the full-size photo rendered in-place and
      // pushed every card below it down the page instead of overlaying them.
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div 
        className="relative max-w-4xl w-full glass-card rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
          <div>
            <h3 className="font-semibold text-lg">
              {currentPhoto.angle || 'Photo'} 
              {currentPhoto.qualityScore && (
                <span className="ml-2 text-sm text-slate-500">
                  {(currentPhoto.qualityScore * 100).toFixed(0)}% quality
                </span>
              )}
            </h3>
            {currentPhoto.enrolledAt && (
              <p className="text-xs text-slate-500">
                {new Date(currentPhoto.enrolledAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(currentPhoto.id, currentPhoto.angle)}
                className="text-red-500 hover:text-red-600"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Image */}
        <div className="relative bg-slate-100 dark:bg-slate-800 flex items-center justify-center" style={{ minHeight: '400px' }}>
          <ModalPhotoImg
            photoUrl={currentPhoto.photoUrl}
            alt={currentPhoto.angle || 'face'}
            className="max-h-[70vh] max-w-full object-contain"
          />
          
          {/* Navigation */}
          {hasPrev && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute left-4 top-1/2 -translate-y-1/2"
              onClick={handlePrev}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
          )}
          {hasNext && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute right-4 top-1/2 -translate-y-1/2"
              onClick={handleNext}
            >
              <ChevronRight className="w-5 h-5" />
            </Button>
          )}
        </div>

        {/* Footer - Thumbnail strip */}
        <div className="p-4 border-t dark:border-slate-700 flex gap-2 overflow-x-auto">
          {photos.map((photo, idx) => (
            <button
              key={photo.id}
              onClick={() => setCurrentIndex(idx)}
              className={cn(
                "w-16 h-16 rounded border-2 overflow-hidden shrink-0 transition-all",
                idx === currentIndex 
                  ? "border-blue-500 ring-2 ring-blue-500/50" 
                  : "border-slate-300 dark:border-slate-600 hover:border-blue-400"
              )}
            >
              <ModalPhotoImg
                photoUrl={photo.photoUrl}
                alt={photo.angle || 'thumb'}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
