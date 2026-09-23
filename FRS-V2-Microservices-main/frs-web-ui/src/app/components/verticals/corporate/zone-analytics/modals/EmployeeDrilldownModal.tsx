import React from 'react';
import { X, LogIn, LogOut, Footprints, ArrowRight, DoorOpen, MapPin, Activity } from 'lucide-react';
import type { EmployeeZoneRow, MovementDetail } from '../lib/types';
import { fmtConfidence, fmtDateTime, fmtMinutes, fmtTime } from '../lib/format';
import { Avatar } from '../lib/Avatar';
import { EvidencePhoto } from '../lib/EvidencePhoto';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  employee: EmployeeZoneRow;
  detail: MovementDetail | null;
  error?: string | null;
  loading?: boolean;
  /** Human label of the date range shown, e.g. "Today" or "2026-09-01 to 2026-09-21". */
  rangeLabel: string;
  onClose: () => void;
}

/** Employee Drilldown (Req 9.5): metrics, entrance usage, zone-transition history and the event timeline with evidence photos. */
export const EmployeeDrilldownModal: React.FC<Props> = ({ employee, detail, error, loading, rangeLabel, onClose }) => {
  // Consecutive visits in different zones become "From -> To" moves.
  const visits = detail?.transitions ?? [];
  const moves = visits.map((v, i) => ({ v, from: i > 0 && visits[i - 1].zone !== v.zone ? visits[i - 1].zone : null }));

  return (
    <div id="employee-drilldown-modal-backdrop" role="presentation" className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div id="employee-drilldown-modal-container" role="dialog" aria-modal="true" aria-label={`Drilldown for ${employee.name}`} className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-6 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="bg-slate-900 text-white p-5 flex items-start justify-between">
          <div className="flex items-center gap-4">
            <Avatar name={employee.name} size="lg" seed={employee.employeeId} />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold tracking-tight text-white">{employee.name}</h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">{employee.employeeCode}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300 mt-1">
                <span>{employee.role ?? '—'}</span><span>•</span>
                <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-200 font-medium">{employee.department ?? '—'}</span><span>•</span>
                <span className="text-emerald-400 flex items-center gap-1"><MapPin className="w-3 h-3" /> Period: {rangeLabel}</span>
              </div>
            </div>
          </div>
          <button id="close-employee-drilldown-btn" type="button" aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 divide-y divide-slate-100">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Zone Activity Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200"><span className="text-slate-500 block mb-1">Total Zone Visits</span><span data-testid="dd-visits" className="text-xl font-extrabold text-slate-900 font-mono">{employee.totalZoneVisits}</span><span className="text-[10px] text-slate-400 block mt-0.5">times entering a zone</span></div>
              <div className="p-3 rounded-xl bg-blue-50/60 border border-blue-200"><span className="text-blue-700 block mb-1">Total Time Inside</span><span data-testid="dd-time" className="text-xl font-extrabold text-blue-900 font-mono">{fmtMinutes(employee.totalTimeInsideMinutes)}</span><span className="text-[10px] text-blue-600/80 block mt-0.5">across all zones</span></div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200"><span className="text-slate-500 block mb-1">Average Visit</span><span data-testid="dd-avg" className="text-xl font-extrabold text-slate-900 font-mono">{fmtMinutes(employee.avgVisitMinutes)}</span><span className="text-[10px] text-slate-400 block mt-0.5">per visit</span></div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200"><span className="text-slate-500 block mb-1">Entries / Exits</span><div className="flex items-baseline gap-2"><span className="text-lg font-bold text-emerald-600 font-mono">+{employee.entries} In</span><span className="text-sm font-bold text-orange-600 font-mono">-{employee.exits} Out</span></div><span className="text-[10px] text-slate-400 block mt-0.5">at the entrances</span></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                <div><span className="text-slate-500 block text-[11px]">First Seen</span><span className="font-mono font-bold text-slate-800 text-sm">{fmtDateTime(employee.firstSeen)}</span></div>
                <div className="text-right"><span className="text-slate-500 block text-[11px]">Last Seen</span><span className="font-mono font-bold text-slate-800 text-sm">{fmtDateTime(employee.lastSeen)}</span></div>
              </div>
              <div className="p-3 rounded-xl bg-emerald-50/50 border border-emerald-200 flex items-center justify-between">
                <div><span className="text-emerald-800 font-medium block text-[11px]">Mean Match Confidence</span><span data-testid="dd-confidence" className="text-lg font-bold text-emerald-900 font-mono">{fmtConfidence(employee.avgMatchConfidence)}</span><span className="text-[10px] text-emerald-700 block">how sure the system was of the match</span></div>
              </div>
            </div>
          </div>

          <div className="pt-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5"><DoorOpen className="w-3.5 h-3.5 text-blue-600" />Entrance Usage</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {employee.entranceUsage.map((ep) => (
                <div key={ep.entrance} className="p-3 rounded-lg border border-slate-200 bg-slate-50/80 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800">{ep.entrance}</span>
                  <span className="font-mono font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">{ep.count} passages</span>
                </div>
              ))}
              {employee.entranceUsage.length === 0 && <span className="text-xs text-slate-400">No entrance activity recorded.</span>}
            </div>
          </div>

          <div className="pt-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5"><Footprints className="w-3.5 h-3.5 text-purple-600" />Zone Movement History</h3>
            <WidgetState error={error} loading={loading} empty={!loading && !error && moves.length === 0} emptyText="No zone visits recorded for this period." />
            <div className="space-y-2" data-testid="dd-transitions">
              {moves.map(({ v, from }, idx) => (
                <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg bg-purple-50/30 border border-purple-100 text-xs">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-purple-700 font-bold text-[11px] bg-purple-100 px-1.5 py-0.5 rounded">{fmtTime(v.enteredAt)}</span>
                    {from && (<><span className="text-slate-800 font-medium">{from}</span><ArrowRight className="w-3.5 h-3.5 text-purple-500" /></>)}
                    <span className="text-slate-900 font-bold">{v.zone}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">{v.exitedAt ? `left ${fmtTime(v.exitedAt)}` : 'no exit recorded'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-slate-600" />Event Timeline with Evidence Photos</h3>
            <WidgetState error={error} loading={loading} empty={!loading && !error && (detail?.events.length ?? 0) === 0} emptyText="No events recorded for this period." />
            <div className="relative pl-6 border-l-2 border-slate-200 space-y-3.5 text-xs" data-testid="dd-timeline">
              {(detail?.events ?? []).map((ev) => (
                <div key={ev.id} data-testid="dd-event" className="relative group">
                  <span className={`absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full border-2 border-white shadow-xs ${ev.eventType === 'entry' ? 'bg-emerald-500' : 'bg-orange-500'}`}></span>
                  <div className="p-3 rounded-lg border border-slate-200 bg-white shadow-2xs hover:border-blue-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-900 text-xs">{fmtDateTime(ev.timestamp)}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${ev.eventType === 'entry' ? 'bg-emerald-100 text-emerald-800' : 'bg-orange-100 text-orange-800'}`}>{ev.eventType === 'entry' ? <LogIn className="w-3 h-3 inline mr-0.5" /> : <LogOut className="w-3 h-3 inline mr-0.5" />}{ev.eventType === 'entry' ? 'Entry' : 'Exit'}</span>
                        <span className="font-semibold text-slate-800">{ev.zone ?? '—'}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">Entrance: {ev.entrance ?? '—'} • Camera: <span className="font-mono">{ev.cameraId ?? '—'}</span></div>
                    </div>
                    <div className="flex items-center gap-3 self-end sm:self-center">
                      <span className="font-mono text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">{fmtConfidence(ev.confidence)} Match</span>
                      <EvidencePhoto photoUrl={ev.photoUrl} kind="Event photo" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {(detail?.dailyPhotos.length ?? 0) > 0 && (
              <div className="mt-5" data-testid="dd-daily-photos">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Daily Check-in and Check-out Photos</h4>
                <div className="space-y-2">
                  {detail!.dailyPhotos.map((d) => (
                    <div key={d.date} className="flex items-center gap-4 p-2.5 rounded-lg border border-slate-200 bg-slate-50/60 text-xs">
                      <span className="font-mono font-semibold text-slate-700 w-24">{d.date}</span>
                      <EvidencePhoto photoUrl={d.checkInPhotoUrl} kind="Check-in" />
                      <EvidencePhoto photoUrl={d.checkOutPhotoUrl} kind="Check-out" />
                      <span className="text-[10px] text-slate-400">One photo per day, not per zone move</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span className="text-[11px]">Zone movement and match information only</span>
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs shadow-xs cursor-pointer">Close Drilldown</button>
        </div>
      </div>
    </div>
  );
};
