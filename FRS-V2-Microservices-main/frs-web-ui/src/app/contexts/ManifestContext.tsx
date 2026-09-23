import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { DashboardManifest } from '../types/manifest';
import { apiRequest } from '../services/http/apiClient';
import { useAuth } from './AuthContext';

interface ManifestContextType {
  manifest: DashboardManifest | null;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

const ManifestContext = createContext<ManifestContextType | undefined>(undefined);

export const ManifestProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { accessToken, isAuthenticated, activeScope } = useAuth();
  const [manifest, setManifest] = useState<DashboardManifest | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = async () => {
    // S-01: In cookie mode accessToken is null (httpOnly cookie); rely on isAuthenticated only.
    // apiRequest sends credentials: "include" so the cookie is forwarded automatically.
    if (!isAuthenticated) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DashboardManifest>('/me/manifest', { accessToken, noCache: true });
      setManifest(data);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load dashboard manifest');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetch();
    } else {
      setManifest(null);
    }
  }, [isAuthenticated, activeScope?.tenantId, activeScope?.siteId]);

  return (
    <ManifestContext.Provider value={{ manifest, isLoading, error, reload: fetch }}>
      {children}
    </ManifestContext.Provider>
  );
};

export const useManifest = () => {
  const ctx = useContext(ManifestContext);
  if (!ctx) throw new Error('useManifest must be used within ManifestProvider');
  return ctx;
};
