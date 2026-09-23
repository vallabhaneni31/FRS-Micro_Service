// specs/0003-zone-analytics — Req 11.1/11.2: HR-friendly wording (design.md 2.7).
// Every KPI / summary tile takes its title and one-line plain description from
// this single reviewable module. No device or engineering jargon, no capacity,
// no attendance or shift wording.

export interface KpiCopy { title: string; description: string }

export const KPI_COPY = {
  headcount: { title: 'Zone Headcount', description: 'How many employees are inside the selected zones right now.' },
  flow: { title: 'Net Entry/Exit Flow', description: 'People who came in compared with people who left, in the selected period.' },
  dwell: { title: 'Average Time Inside', description: 'How long employees usually stay in a zone during one visit.' },

  activeCount: { title: 'Active Count', description: 'Employees inside a zone at this moment.' },
  highestPeak: { title: 'Highest Peak', description: 'The most employees seen inside a single zone at the same time.' },
  activeZones: { title: 'Active Zones', description: 'Zones that have at least one employee inside right now.' },
  camerasOnline: { title: 'Cameras Online', description: 'Cameras currently sending activity, out of all installed cameras.' },

  highestTraffic: { title: 'Highest Traffic Window', description: 'The busiest one-hour period, counting everyone who came in or left.' },
  lowestTraffic: { title: 'Lowest Traffic Window', description: 'The quietest one-hour period that still had some activity.' },
  peakMoment: { title: 'Peak Headcount Moment', description: 'The exact time the most employees were inside at once.' },

  trackedEmployees: { title: 'Tracked Employees', description: 'Employees seen in the selected zones during the period.' },
  meanTime: { title: 'Mean Time in Zone', description: 'The average time each employee spent inside zones.' },
  mostActive: { title: 'Most Active Employee', description: 'The employee with the most zone visits in the period.' },
  meanConfidence: { title: 'Mean Match Confidence', description: 'On average, how sure the system was that it matched the right person.' },

  timeInZone: { title: 'Time in Zone', description: 'Total time this employee spent inside zones.' },
  zoneVisits: { title: 'Zone Visits', description: 'How many times this employee entered a zone.' },
  matchConfidence: { title: 'Match Confidence', description: 'How sure the system was about the match, on average.' },
  lastSeen: { title: 'Last Seen', description: 'The most recent time this employee was recorded.' },
} satisfies Record<string, KpiCopy>;

export type KpiKey = keyof typeof KPI_COPY;

export const EVENT_TYPE_LABELS: Record<string, string> = {
  entry: 'Entry',
  exit: 'Exit',
  unknown_face: 'Unknown Face',
  camera_offline: 'Camera Offline',
};

/** Person-type selector labels (AC 5.6, HR wording map). */
export const PERSON_TYPE_LABELS: Record<string, string> = {
  all: 'All',
  employee: 'Employees',
  visitor: 'Visitors',
};

export const UNREGISTERED_VISITOR_LABEL = 'Visitor (unregistered)';

export const RECOGNITION_STATUS_LABELS: Record<string, string> = {
  verified: 'Verified',
  unrecognized: 'Unrecognized',
  system: 'System',
};

/** Data-quality notes shown next to security counts (Req 5.5): recorded events are a lower bound. */
export const RECORDED_EVENTS_NOTE = 'Shows recorded events only. Some unknown faces and camera outages may not be captured.';
export const NO_PHOTO_TEXT = 'No photo recorded';
