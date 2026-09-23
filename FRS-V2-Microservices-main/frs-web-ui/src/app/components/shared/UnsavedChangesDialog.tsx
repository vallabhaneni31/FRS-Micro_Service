/**
 * UnsavedChangesDialog — W-04
 * Renders when the router blocker fires (user tries to navigate away
 * from a dirty form). Offers "Stay" or "Leave anyway".
 */
import React from 'react';
import type { Blocker } from 'react-router';

interface Props {
  blocker: Blocker;
}

export const UnsavedChangesDialog: React.FC<Props> = ({ blocker }) => {
  if (blocker.state !== 'blocked') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <h2 className="text-slate-100 font-semibold text-base mb-2">Unsaved changes</h2>
        <p className="text-slate-400 text-sm mb-6">
          You have unsaved changes that will be lost if you leave this page.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => blocker.reset?.()}
            className="px-4 py-2 text-sm rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Stay
          </button>
          <button
            onClick={() => blocker.proceed?.()}
            className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition-colors"
          >
            Leave anyway
          </button>
        </div>
      </div>
    </div>
  );
};
