/**
 * UnsavedChangesProvider — W-04
 * Provides the useUnsavedChanges context to all protected pages and
 * auto-renders the dialog when navigation is blocked.
 *
 * Usage in a form:
 *   const { markDirty, markClean, isDirty } = useUnsavedCtx();
 *   <input onChange={() => markDirty()} />
 *   <button onClick={() => { save(); markClean(); }}>Save</button>
 */
import React, { createContext, useContext, ReactNode } from 'react';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

type UnsavedCtx = ReturnType<typeof useUnsavedChanges>;
const Ctx = createContext<UnsavedCtx | undefined>(undefined);

export const UnsavedChangesProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const value = useUnsavedChanges();
  return (
    <Ctx.Provider value={value}>
      {children}
      <UnsavedChangesDialog blocker={value.blocker} />
    </Ctx.Provider>
  );
};

export const useUnsavedCtx = (): UnsavedCtx => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUnsavedCtx must be used inside UnsavedChangesProvider');
  return ctx;
};
