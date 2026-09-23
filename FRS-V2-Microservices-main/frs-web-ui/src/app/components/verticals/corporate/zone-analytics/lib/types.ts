/**
 * Zone Analytics — API response types and filter state (specs/0003-zone-analytics,
 * design.md 2.1). These mirror the real /api/zones responses; there is no mock
 * data anywhere in this module. Optional/null fields are real "no data" states.
 */

export type DatePreset = 'today' | 'week' | 'month' | 'custom';
export type TimeRange = 'full' | 'morning' | 'afternoon' | 'evening' | 'peak';

/** Deep-Dive filter state (Req 7.1, 3.9). Empty string = "all". */
export interface DeepDiveFilters {
  selectedZones: string[];
  entryPointId: string;
  departmentId: string;
  timeRange: TimeRange;
  datePreset: DatePreset;
  fromDate: string;
  toDate: string;
  cameraId: string;
  /** Percent 50-98 in the UI; null = off (default). The API takes 0-1. */
  minConfidence: number | null;
  securityOnly: boolean;
}

export interface ZoneListItem {
  zone: string;
  zoneType: string;
  siteId: number | null;
  liveHeadcount: number;
  peak: number;
  entries: number;
}
export interface EntryPointOption { deviceId: string; deviceLabel: string; zone: string }
export interface DepartmentOption { departmentId: number; name: string }
export interface CameraOption { cameraId: string; name: string; entrance: string; zone: string }

export interface HourWindow { startHour: number; endHour: number; count: number }

export interface ZoneSummary {
  hasData: boolean;
  headcount: {
    current: number | null; peak: number | null; average: number | null; lowest: number | null;
    pctOfPeak: number | null; changeVs1hPct: number | null;
  };
  flow: {
    entries: number | null; exits: number | null; net: number | null;
    pctIn: number | null; pctOut: number | null; uniqueEmployees: number | null;
  };
  dwell: {
    avgVisitMinutes: number | null; avgTimeInsideMinutes: number | null;
    peakInflowWindow: HourWindow | null; peakEgressWindow: HourWindow | null; totalVisits: number | null;
  };
  cameras: { online: number; total: number };
}

export interface OccupancySeriesPoint { ts: string; zone: string; count: number }
export interface OccupancyData {
  current: number | null; peak: number | null; average: number | null; lowest: number | null;
  series: OccupancySeriesPoint[];
}

export interface HourlyRow { hour: number; entries: number; exits: number; traffic: number; avgOccupancy: number; peakOccupancy: number }
export interface PeakHoursData {
  highestWindow: HourWindow | null;
  lowestWindow: HourWindow | null;
  peakHeadcountMoment: { at: string; count: number } | null;
  hourly: HourlyRow[];
  byZone: { zone: string; hour: number; entries: number; exits: number }[];
}

export interface HeatmapData {
  maxCell: number;
  cells: { dow: number; hour: number; count: number; pctOfPeak: number }[];
}

export interface EntryPointTrafficRow {
  deviceId: string; deviceLabel: string; entries: number; exits: number; net: number;
  uniqueEmployees: number; contributionPct: number; peakActivity: number | null;
}

export interface DepartmentDistributionRow {
  departmentId: number; name: string; employeesDetected: number; visits: number;
  avgTimeSpentMinutes: number | null; trafficPct: number;
}

export interface TimeSpentBucket { bucket: string; count: number; pct: number }

export interface TransitionRow { fromZone: string; toZone: string; count: number; pct: number; isPrimary: boolean }
export interface MovementMatrix { matrix: TransitionRow[]; mostVisited: { zone: string; visits: number }[] }

// 'visitor_detected' = a registered visitor's detection (only reachable through the person-type filter)
export type EventType = 'entry' | 'exit' | 'unknown_face' | 'camera_offline' | 'visitor_detected';
/** Person-type selector of Recent Zone Activity (AC 5.6). */
export type PersonType = 'all' | 'employee' | 'visitor';
export type RecognitionStatus = 'verified' | 'unrecognized' | 'system';
export interface ZoneEventRow {
  id: string; timestamp: string; eventType: EventType;
  employeeId: number | null; employeeCode: string | null; employeeName: string | null;
  entrance: string | null; zone: string | null; recognitionStatus: RecognitionStatus;
  confidence: number | null; cameraId: string | null; details: string | null; photoUrl: string | null;
}
export interface ZoneEventsPage { rows: ZoneEventRow[]; total: number }

export interface EmployeeZoneRow {
  employeeId: number; employeeCode: string; name: string; role: string | null; department: string | null;
  primaryZone: string | null; totalZoneVisits: number; totalTimeInsideMinutes: number;
  avgVisitMinutes: number | null; entries: number; exits: number;
  firstSeen: string; lastSeen: string; avgMatchConfidence: number | null; currentlyInZone: boolean;
  zoneMinutes: { zone: string; minutes: number }[]; recentFlow: string[];
  entranceUsage: { entrance: string; count: number }[];
}
export interface EmployeesData {
  rows: EmployeeZoneRow[]; total: number;
  summary: {
    trackedEmployees: number; meanTimeInZoneMinutes: number | null;
    mostActiveEmployee: { name: string; zoneVisits: number } | null; meanMatchConfidence: number | null;
  };
}

export interface MovementEvent {
  id: string; timestamp: string; eventType: 'entry' | 'exit'; zone: string | null;
  entrance: string | null; confidence: number | null; cameraId: string | null; photoUrl: string | null;
}
export interface MovementDetail {
  transitions: { zone: string; enteredAt: string | null; exitedAt: string | null }[];
  events: MovementEvent[];
  dailyPhotos: { date: string; checkInPhotoUrl: string | null; checkOutPhotoUrl: string | null }[];
}

export type CompareMetric = 'occupancy' | 'traffic' | 'dwell';
export type CompareGranularity = 'hour' | 'dow' | 'week';
export interface CompareSeriesPoint { bucket: number | string; value?: number; entries?: number; exits?: number }
export interface CompareZoneProfile {
  primaryDepartment: string | null; liveHeadcount: number | null; peak: number | null; pctOfPeak: number | null;
  entries: number; exits: number; avgDwellMinutes: number | null; entrances: number;
}
export interface CompareData {
  zones: Record<string, { profile: CompareZoneProfile; series: CompareSeriesPoint[] }>;
  matrix: { zone: string; liveHeadcount: number | null; peak: number | null; entries: number; exits: number; net: number; avgDwellMinutes: number | null }[];
  aggregate: { liveHeadcount: number | null; peak: number | null; entries: number; exits: number; net: number; avgDwellMinutes: number | null };
  metric: CompareMetric; granularity: CompareGranularity;
}
