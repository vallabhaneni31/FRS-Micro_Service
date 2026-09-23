import React from 'react';
import { EmployeeLifecycleManagement } from '../hr/EmployeeLifecycleManagement';

/**
 * Corporate "Employees" page. EmployeeLifecycleManagement already renders its own
 * hero band (title, KPIs, primary actions), so this is a thin wrapper — no extra
 * PageHeader, which previously stacked a second redundant title above the hero.
 */
export const PeopleManagement: React.FC = () => (
  <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
    <EmployeeLifecycleManagement />
  </div>
);
