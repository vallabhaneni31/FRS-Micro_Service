import React from 'react';
import { Search, HelpCircle, Video, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { EventType, PersonType, RecognitionStatus, ZoneEventRow } from '../lib/types';
import { fmtConfidence, fmtDateTime } from '../lib/format';
import { EVENT_TYPE_LABELS, PERSON_TYPE_LABELS, RECORDED_EVENTS_NOTE, RECOGNITION_STATUS_LABELS, UNREGISTERED_VISITOR_LABEL } from '../lib/copy';
import { EvidencePhoto } from '../lib/EvidencePhoto';
import { WidgetState } from '../lib/ViewHeader';

export interface EventControls {
  eventType: 'all' | EventType;
  status: 'all' | RecognitionStatus;
  q: string;
  page: number;
  pageSize: number;
  onChange: (next: Partial<Pick<EventControls, 'eventType' | 'status' | 'q' | 'page'>>) => void;
}

interface Props {
  rows: ZoneEventRow[];
  total: number;
  error?: string | null;
  loading?: boolean;
  title?: string;
  subtitle?: string;
  /** Present on the Deep-Dive (server-side type/status/search/page); absent on the Overview (latest 5, read-only). */
  controls?: EventControls;
  /** All / Employees / Visitors (AC 5.6). Shown on the Overview and the Deep-Dive; changing it resets to page 1. */
  personType?: PersonType;
  onPersonTypeChange?: (next: PersonType) => void;
}

const EventBadge: React.FC<{ type: EventType }> = ({ type }) => {
  switch (type) {
    case 'entry':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Entry</span>;
    case 'exit':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-orange-50 text-orange-700 border border-orange-200"><span className="w-1.5 h-1.5 rounded-full bg-orange-500"></span> Exit</span>;
    case 'unknown_face':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><HelpCircle className="w-3 h-3 text-amber-600" /> Unknown Face</span>;
    case 'visitor_detected':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-sky-50 text-sky-700 border border-sky-200"><span className="w-1.5 h-1.5 rounded-full bg-sky-500"></span> Visitor</span>;
    case 'camera_offline':
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-300"><Video className="w-3 h-3 text-slate-500" /> Camera Offline</span>;
    default:
      return <span>{type}</span>;
  }
};

const StatusBadge: React.FC<{ status: RecognitionStatus }> = ({ status }) => {
  if (status === 'verified') return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 className="w-3 h-3 text-emerald-500" /> {RECOGNITION_STATUS_LABELS.verified}</span>;
  if (status === 'unrecognized') return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700"><HelpCircle className="w-3 h-3 text-amber-500" /> {RECOGNITION_STATUS_LABELS.unrecognized}</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600"><AlertTriangle className="w-3 h-3 text-slate-400" /> {RECOGNITION_STATUS_LABELS.system}</span>;
};

/** Recent Zone Events: real Entry / Exit / Unknown Face / Camera Offline rows (Req 5.2). */
export const RecentEventsTable: React.FC<Props> = ({ rows, total, error, loading, controls, personType, onPersonTypeChange, title = 'Recent Zone Events', subtitle = 'Latest entries, exits, unknown faces and camera outages across the zones' }) => {
  const totalPages = controls ? Math.max(1, Math.ceil(total / controls.pageSize)) : 1;
  const filtered = controls ? controls.eventType !== 'all' || controls.status !== 'all' || controls.q !== '' || (personType ?? 'all') !== 'all' : false;

  return (
    <div id="table-recent-zone-events" className="glass-card rounded-xl overflow-hidden transition-all flex flex-col justify-between">
      <div className="p-4 sm:p-5 border-b border-slate-200/60 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="w-2.5 h-2.5 rounded-full bg-rose-600"></div>
            <h3 className="text-sm font-medium text-slate-900 tracking-tight">{title}</h3>
            <span data-testid="events-total" className="text-xs bg-slate-100 text-slate-600 font-medium px-2 py-0.5 rounded-full border border-slate-200">{total} Records</span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>

        {(controls || onPersonTypeChange) && (
          <div className="flex flex-wrap items-center gap-2">
            {onPersonTypeChange && (
              <div role="group" aria-label="Person type" data-testid="person-type" className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                {(['all', 'employee', 'visitor'] as PersonType[]).map((p) => (
                  <button key={p} type="button" aria-pressed={(personType ?? 'all') === p} onClick={() => onPersonTypeChange(p)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${(personType ?? 'all') === p ? 'bg-white text-blue-700 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'}`}>
                    {PERSON_TYPE_LABELS[p]}
                  </button>
                ))}
              </div>
            )}
            {controls && (<>
            <select
              aria-label="Event type"
              value={controls.eventType}
              onChange={(e) => controls.onChange({ eventType: e.target.value as any, page: 1 })}
              className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 font-medium outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="all">All Event Types</option>
              {(Object.keys(EVENT_TYPE_LABELS) as EventType[]).map((t) => <option key={t} value={t}>{EVENT_TYPE_LABELS[t]}</option>)}
            </select>
            <select
              aria-label="Recognition status"
              value={controls.status}
              onChange={(e) => controls.onChange({ status: e.target.value as any, page: 1 })}
              className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 font-medium outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="all">All Statuses</option>
              {(Object.keys(RECOGNITION_STATUS_LABELS) as RecognitionStatus[]).map((s) => <option key={s} value={s}>{RECOGNITION_STATUS_LABELS[s]}</option>)}
            </select>
            <div className="relative w-48">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search events"
                value={controls.q}
                onChange={(e) => controls.onChange({ q: e.target.value, page: 1 })}
                placeholder="Search events..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
            </>)}
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wider bg-slate-50/70">
              <th className="py-3 px-3">Timestamp</th>
              <th className="py-3 px-3">Event</th>
              <th className="py-3 px-3">Employee</th>
              <th className="py-3 px-3">Entrance</th>
              <th className="py-3 px-3">Zone</th>
              <th className="py-3 px-3">Recognition Status</th>
              <th className="py-3 px-3 text-right">Match Confidence</th>
              <th className="py-3 px-3">Camera</th>
              <th className="py-3 px-3">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-normal">
            {rows.map((evt) => (
              <tr key={evt.id} data-testid="event-row" className={`hover:bg-slate-50/90 transition-colors ${evt.eventType === 'unknown_face' ? 'bg-amber-50/15' : ''}`}>
                <td className="py-2.5 px-3 font-mono font-medium text-slate-600 whitespace-nowrap">{fmtDateTime(evt.timestamp)}</td>
                <td className="py-2.5 px-3"><EventBadge type={evt.eventType} /></td>
                <td className="py-2.5 px-3">
                  {evt.employeeName ? (
                    <div>
                      <div className="font-semibold text-slate-900">{evt.employeeName}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{evt.employeeCode}</div>
                    </div>
                  ) : evt.eventType === 'unknown_face' ? (
                    <span className="text-slate-400 italic text-[11px]">{UNREGISTERED_VISITOR_LABEL}</span>
                  ) : evt.eventType === 'visitor_detected' ? (
                    <span className="text-slate-500 italic text-[11px]">Visitor (registered)</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-slate-700 font-medium">{evt.entrance ?? '—'}</td>
                <td className="py-2.5 px-3 text-slate-700">{evt.zone ?? '—'}</td>
                <td className="py-2.5 px-3"><StatusBadge status={evt.recognitionStatus} /></td>
                <td className="py-2.5 px-3 text-right">
                  {evt.confidence !== null ? (
                    <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded ${evt.confidence >= 0.9 ? 'bg-emerald-50 text-emerald-700' : evt.confidence >= 0.75 ? 'bg-blue-50 text-blue-700' : 'bg-rose-50 text-rose-700'}`}>
                      {fmtConfidence(evt.confidence)}
                    </span>
                  ) : (
                    <span className="text-slate-400 font-mono text-[11px]">—</span>
                  )}
                </td>
                <td className="py-2.5 px-3 font-mono text-slate-600 text-[11px]">{evt.cameraId ?? '—'}</td>
                <td className="py-2.5 px-3 text-slate-500 max-w-xs" title={evt.details ?? undefined}>
                  <div className="flex items-center gap-2">
                    {evt.eventType === 'unknown_face' || evt.photoUrl ? <EvidencePhoto photoUrl={evt.photoUrl} kind="Event photo" compact /> : null}
                    <span className="truncate">{evt.details ?? ''}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No events recorded for this selection." />}
      </div>

      <div className="p-3 bg-slate-50/70 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between text-xs text-slate-500 gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {controls ? (
            <span>Page <strong>{controls.page}</strong> of <strong>{totalPages}</strong> ({total} total events)</span>
          ) : (
            <span>Showing the latest {rows.length} of {total} events</span>
          )}
          {filtered && controls && (
            <button type="button" onClick={() => { controls.onChange({ eventType: 'all', status: 'all', q: '', page: 1 }); onPersonTypeChange?.('all'); }} className="text-blue-600 hover:text-blue-800 font-medium underline text-[11px] cursor-pointer">
              Clear Event Filters
            </button>
          )}
          <span className="text-slate-400 text-[11px]">{RECORDED_EVENTS_NOTE}</span>
        </div>
        {controls && (
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous page" onClick={() => controls.onChange({ page: Math.max(1, controls.page - 1) })} disabled={controls.page <= 1} className="p-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-mono text-xs px-2 font-semibold text-slate-700">{controls.page} / {totalPages}</span>
            <button type="button" aria-label="Next page" onClick={() => controls.onChange({ page: Math.min(totalPages, controls.page + 1) })} disabled={controls.page >= totalPages} className="p-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
