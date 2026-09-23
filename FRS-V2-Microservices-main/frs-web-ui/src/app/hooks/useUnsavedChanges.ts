/**
 * useUnsavedChanges — W-04
 * Blocks React Router navigation when there are unsaved changes.
 * Also warns on browser tab close (beforeunload).
 *
 * Usage:
 *   const { markDirty, markClean, isDirty } = useUnsavedChanges();
 *   // call markDirty() on any form change; markClean() on save or cancel
 */
import { useCallback, useEffect, useState } from 'react';
import { useBlocker } from 'react-router';

export function useUnsavedChanges() {
  const [isDirty, setIsDirty] = useState(false);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname
  );

  // Warn on browser tab / window close
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const markDirty = useCallback(() => setIsDirty(true), []);
  const markClean = useCallback(() => setIsDirty(false), []);

  return { isDirty, markDirty, markClean, blocker };
}
