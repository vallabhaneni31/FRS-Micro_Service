import { useSyncExternalStore } from 'react';

/**
 * ── Attendance regularization / approval store ───────────────────────────────
 *
 * A lightweight, localStorage-backed workflow store so the request → approve
 * flow works end-to-end without a backend. Swap the read/write internals for
 * real API calls (e.g. POST /attendance/regularizations) when the backend
 * endpoints exist — the component API (list/add/decide/subscribe) stays the same.
 */

export type RegStatus = 'pending' | 'approved' | 'rejected';

export interface RegRequest {
    id: string;
    employeeId: string;
    employeeName: string;
    department?: string;
    date: string;            // YYYY-MM-DD
    fromStatus: string;      // status at request time (display label)
    toStatus: string;        // requested: present | late | absent
    checkIn?: string;
    checkOut?: string;
    reason: string;
    requestedBy: string;
    status: RegStatus;
    createdAt: string;       // ISO
    decidedAt?: string;
    decisionNote?: string;
}

const KEY = 'attendance.regularizations.v1';
type Listener = () => void;
const listeners = new Set<Listener>();

function readFromDisk(): RegRequest[] {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

// In-memory cache gives useSyncExternalStore a stable snapshot reference.
let cache: RegRequest[] = typeof window !== 'undefined' ? readFromDisk() : [];

function commit(next: RegRequest[]) {
    cache = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    listeners.forEach(l => l());
}

let _seq = 0;

export const regStore = {
    list: (): RegRequest[] => cache,
    subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; },

    add: (r: Omit<RegRequest, 'id' | 'status' | 'createdAt'>): string => {
        const id = `req_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
        commit([{ ...r, id, status: 'pending', createdAt: new Date().toISOString() }, ...cache]);
        return id;
    },

    decide: (id: string, status: Exclude<RegStatus, 'pending'>, note?: string) => {
        commit(cache.map(x => x.id === id
            ? { ...x, status, decidedAt: new Date().toISOString(), decisionNote: note }
            : x));
    },

    // Log an already-decided change (direct override / bulk) straight into the trail.
    record: (r: Omit<RegRequest, 'id' | 'status' | 'createdAt' | 'decidedAt' | 'decisionNote'>,
             status: Exclude<RegStatus, 'pending'>, note?: string) => {
        const now = new Date().toISOString();
        const id = `log_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
        commit([{ ...r, id, status, createdAt: now, decidedAt: now, decisionNote: note }, ...cache]);
    },
};

export function useRegularizations(): RegRequest[] {
    return useSyncExternalStore(regStore.subscribe, regStore.list, regStore.list);
}
