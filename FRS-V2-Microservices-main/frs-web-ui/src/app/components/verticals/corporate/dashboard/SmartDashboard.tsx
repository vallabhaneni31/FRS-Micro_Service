import React, { useMemo } from 'react';
import { LayoutDashboard, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useManifest } from '../../../../contexts/ManifestContext';
import { Button } from '../../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { PageHeader } from '../../../shared/PageHeader';
import { DashboardDataProvider, useDashboardData } from './DashboardDataContext';
import { cn } from '../../../ui/utils';
import { WIDGET_REGISTRY, ROLE_FALLBACK_LAYOUT, type WidgetDef } from './widgets';

interface ResolvedWidget {
  key:  string;
  span: number;
  def:  WidgetDef;
}

// Static class literals so Tailwind keeps them in the build.
const SPAN_CLASS: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
};

const ROLE_TITLE: Record<string, string> = {
  hr_manager:   'HR Overview',
  site_admin:   'Site Operations Overview',
  tenant_admin: 'Dashboard',
  super_admin:  'Application Overview',
};

/**
 * Server-driven, role-aware dashboard. Renders the widget list from
 * `manifest.widgets` (resolved per role/tenant by the backend), filtered to the
 * widgets this build knows about and the user has permission for. Falls back to
 * a per-role layout only when the manifest yields nothing renderable.
 */
export const SmartDashboard: React.FC = () => {
  const { manifest } = useManifest();
  const { can } = useAuth();
  const role = manifest?.role ?? '';

  const resolved = useMemo<ResolvedWidget[]>(() => {
    const fromManifest = manifest?.widgets ?? [];

    const build = (rawEntries: { id: string; span?: number }[]): ResolvedWidget[] => {
      const entries = rawEntries.map(e => ({
        ...e,
        id: e.id === 'weekly_chart' ? 'monthly_trend' : e.id
      }));
      const hasDeviceStatus = entries.some((e) => e.id === 'device_status');
      const hasCalendar = entries.some((e) => e.id === 'calendar');
      return entries
        .map((w) => ({ w, def: WIDGET_REGISTRY[w.id] }))
        // drop unknown widget ids (forward-compat per manifest contract §3)
        .filter((x): x is { w: { id: string; span?: number }; def: WidgetDef } => !!x.def)
        // drop widgets the user lacks permission for (no silent 401s)
        .filter(({ def }) => !def.requiredPermission || can(def.requiredPermission))
        .map(({ w, def }) => {
          let span = w.span ?? def.defaultSpan ?? 4;
          if ((w.id === 'calendar' || w.id === 'device_status') && hasDeviceStatus && hasCalendar) {
            span = 2;
          }
          return {
            key:  w.id,
            span: Math.min(4, Math.max(1, span)),
            def,
          };
        });
    };

    const fromManifestResolved = build(fromManifest.map((w) => ({ id: w.id, span: w.span })));
    if (fromManifestResolved.length > 0) return fromManifestResolved;

    // Graceful fallback: manifest gave nothing this build can render.
    return build((ROLE_FALLBACK_LAYOUT[role] ?? []).map((id) => ({ id })));
  }, [manifest?.widgets, role, can]);

  if (resolved.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2 text-center px-6">
        <LayoutDashboard className="w-8 h-8 opacity-40" />
        <p className="text-sm">No dashboard widgets are available for your role.</p>
      </div>
    );
  }

  // A full-page widget (e.g. cross-tenant platform overview) owns its own chrome.
  if (resolved.some((r) => r.def.fullPage)) {
    return (
      <DashboardDataProvider>
        {resolved.map(({ key, def: { Component } }) => <Component key={key} />)}
      </DashboardDataProvider>
    );
  }

  return (
    <DashboardDataProvider>
      <SmartDashboardBody resolved={resolved} title={ROLE_TITLE[role] ?? 'Dashboard'} />
    </DashboardDataProvider>
  );
};

const SmartDashboardBody: React.FC<{ resolved: ResolvedWidget[]; title: string }> = ({ resolved, title }) => {
  const { isLoading, refresh } = useDashboardData();

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={title}
        icon={LayoutDashboard}
        actions={
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={isLoading}
              className="gap-2 rounded-xl h-9">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
        }
      />

      {isLoading && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      <div className={`grid grid-cols-1 lg:grid-cols-4 gap-6 items-stretch transition-opacity duration-300 ${isLoading ? 'opacity-60 pointer-events-none' : ''}`}>
        {resolved.map(({ key, span, def: { Component } }) => (
          <div key={key} className={cn(SPAN_CLASS[span], "h-full flex flex-col")}>
            <Component />
          </div>
        ))}
      </div>
    </div>
  );
};

export default SmartDashboard;
