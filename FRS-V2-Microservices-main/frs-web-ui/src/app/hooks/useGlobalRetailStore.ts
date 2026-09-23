import { useState, useEffect } from 'react';

const STORAGE_KEY = 'active_retail_store_id';

export function getGlobalRetailStoreId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'all';
  } catch {
    return 'all';
  }
}

export function setGlobalRetailStoreId(storeId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, storeId);
    window.dispatchEvent(new CustomEvent('retail-store-change', { detail: { storeId } }));
  } catch {}
}

export function useGlobalRetailStore() {
  const [selectedStoreId, setSelectedStoreId] = useState<string>(getGlobalRetailStoreId);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ storeId: string }>).detail;
      if (detail && detail.storeId !== undefined) {
        setSelectedStoreId(detail.storeId);
      }
    };
    window.addEventListener('retail-store-change', handler);
    return () => window.removeEventListener('retail-store-change', handler);
  }, []);

  const setStoreId = (id: string) => {
    setSelectedStoreId(id);
    setGlobalRetailStoreId(id);
  };

  return { selectedStoreId, setSelectedStoreId: setStoreId };
}
