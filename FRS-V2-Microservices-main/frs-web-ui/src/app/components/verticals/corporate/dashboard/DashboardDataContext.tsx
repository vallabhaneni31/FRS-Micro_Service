import React, { createContext, useContext } from 'react';
import { useApiData } from '../../../../hooks/useApiData';

/**
 * Single shared instance of useApiData for every widget on a SmartDashboard.
 *
 * Before this, each role-overview page (and several widgets) called useApiData
 * independently — duplicate /live polling and a KPI bar whose tiles and rate
 * came from different fetches. Providing one instance here makes all attendance
 * widgets read the same employees / attendance / metrics / devices snapshot.
 */
type ApiData = ReturnType<typeof useApiData>;

const DashboardDataContext = createContext<ApiData | null>(null);

export const DashboardDataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const data = useApiData({ autoRefreshMs: 60000 });
  return <DashboardDataContext.Provider value={data}>{children}</DashboardDataContext.Provider>;
};

export function useDashboardData(): ApiData {
  const ctx = useContext(DashboardDataContext);
  if (!ctx) throw new Error('useDashboardData must be used within a DashboardDataProvider');
  return ctx;
}
