import { useNavigate } from 'react-router';

/** Page paths of the four Zone Analytics views (manifest keys seeded by frs-fe-api migration 028). */
export const ZONE_PATHS = {
  overview: '/dashboard/zone_analytics.overview',
  deepDive: '/dashboard/zone_analytics.deep_dive',
  compare: '/dashboard/zone_analytics.compare',
  movement: '/dashboard/zone_analytics.movement',
} as const;

/** Anchor id of the Deep-Dive Recent Zone Events table ("View all" destination, Req 6.8). */
export const ZONE_EVENTS_ANCHOR = 'zone-events';

export function useZoneNav() {
  const navigate = useNavigate();
  return {
    toDeepDive: () => navigate(ZONE_PATHS.deepDive),
    toDeepDiveEvents: () => navigate(`${ZONE_PATHS.deepDive}#${ZONE_EVENTS_ANCHOR}`),
  };
}
