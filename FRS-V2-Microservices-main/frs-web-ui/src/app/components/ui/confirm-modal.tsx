import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'destructive' | 'default';
  isLoading?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'destructive',
  isLoading = false,
}) => {
  const [isProcessing, setIsProcessing] = React.useState(false);
  const activeLoading = isLoading || isProcessing;

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className="max-w-md shadow-2xl">
        <AlertDialogHeader className="flex flex-col items-center sm:items-start text-center sm:text-left gap-3">
          <div className={`p-2.5 rounded-full ${variant === 'destructive' ? 'bg-red-500/10 text-red-500 dark:text-red-400 border border-red-500/20' : 'bg-blue-500/10 text-blue-500 dark:text-blue-400 border border-blue-500/20'} shrink-0`}>
            {variant === 'destructive' ? <AlertTriangle className="w-6 h-6" /> : <Info className="w-6 h-6" />}
          </div>
          <div>
            <AlertDialogTitle className="text-lg font-bold mb-1">{title}</AlertDialogTitle>
            {description && (
              <AlertDialogDescription className="leading-relaxed text-slate-500 dark:text-slate-400 text-sm">
                {description}
              </AlertDialogDescription>
            )}
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-4 flex gap-2 sm:justify-end">
          <AlertDialogCancel
            onClick={onClose}
            disabled={activeLoading}
            className="mt-2 sm:mt-0"
          >
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={async (e) => {
              e.preventDefault();
              if (activeLoading) return;
              setIsProcessing(true);
              try {
                await onConfirm();
                onClose();
              } catch (error) {
                setIsProcessing(false);
              }
            }}
            disabled={activeLoading}
            className={variant === 'destructive' ? 'bg-red-600 hover:bg-red-700 flex items-center gap-2 text-white font-bold' : 'bg-blue-600 hover:bg-blue-700 flex items-center gap-2 text-white font-bold'}
          >
            {activeLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {activeLoading ? (confirmText.toLowerCase().includes('delete') ? 'Deleting...' : 'Processing...') : confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
