# Production → Development Sync: Three Hotfix Bugs

## Objective
Three hotfixes were applied directly to the Production environment. This document lists the exact code changes so they can be replicated in the Development environment, keeping both environments synchronized.

---

## 1. System Health Dashboard – Avg Accuracy Calculation Fix

### Bug
The **Avg Accuracy** widget averaged all devices' accuracy equally, including offline devices with 0 scans / 0% accuracy, producing 17.6% instead of the expected ~97.5%.

### Fix
Switched from an unweighted average to a **scan-weighted average**: `Σ(accuracy × scans) / Σ(scans)`.

### File: `frontend/src/app/components/verticals/corporate/admin/SystemHealth.tsx`

**Before:**
```tsx
const avgAccuracy = devices.length > 0 
  ? devices.reduce((sum, d) => sum + parseFloat(d.recognition_accuracy || '0'), 0) / devices.length 
  : 0;
```

**After:**
```tsx
const avgAccuracy = totalScans > 0
  ? devices.reduce((sum, d) => sum + parseFloat(d.recognition_accuracy || '0') * (d.total_scans || 0), 0) / totalScans
  : 0;
```

> Note: `totalScans` was already computed a few lines above (`const totalScans = devices.reduce((sum, d) => sum + (d.total_scans || 0), 0);`) — no new variable needed.

---

### File: `frontend/src/app/components/verticals/corporate/admin/FacilityIntelligenceDashboard.tsx`

Same root cause — was filtering out zero-accuracy devices but still using an unweighted average.

**Before:**
```tsx
const recDevices = devices.filter(d => Number(d.recognition_accuracy) > 0);
const avgAccuracy = recDevices.length > 0
  ? (recDevices.reduce((s, d) => s + Number(d.recognition_accuracy), 0) / recDevices.length).toFixed(1)
  : '0.0';
```

**After:**
```tsx
const avgAccuracy = totalScans > 0
  ? (devices.reduce((s, d) => s + Number(d.recognition_accuracy) * (d.total_scans || 0), 0) / totalScans).toFixed(1)
  : '0.0';
```

> `totalScans` already exists in this file too (`const totalScans = devices.reduce((s, d) => s + (d.total_scans || 0), 0);`).

---

### File: `frontend/src/app/components/verticals/corporate/admin/AccuracyLogs.tsx`
**No change.** Contains the same unweighted-average pattern, but the component is not imported/used anywhere in the app (dead code) — left as-is.

---

## 2. HR Enrollment – Resend Invitation Improvements

### File: `frontend/src/app/components/verticals/corporate/hr/RemoteEnrollmentManager.tsx`

### 2a. Pull `can` from AuthContext

**Before:**
```tsx
const { verticalLabel } = useAuth();
```

**After:**
```tsx
const { verticalLabel, can } = useAuth();
```

### 2b. Issue 1 — Permission leak in error toast

**Before:**
```tsx
} catch (err: any) {
  toast.error('Failed to resend invitation', {
    description: err?.message || 'Please try again.',
  });
}
```

**After:**
```tsx
} catch (err: any) {
  toast.error('Failed to resend invitation', {
    description: err?.status === 403
      ? "You don't have permission to resend invitations."
      : (err?.message || 'Please try again.'),
  });
}
```

### 2c. Issue 2 — Resend button shown regardless of permission

**Before:**
```tsx
<td className="px-4 py-3">
  {(inv.display_status === 'pending' || inv.display_status === 'expired') && (
    <Button
      variant="outline"
      size="sm"
      onClick={() => handleResend(inv.pk_invitation_id)}
    >
      <RefreshCw className="w-3 h-3 mr-1" />
      Resend
    </Button>
  )}
</td>
```

**After:**
```tsx
<td className="px-4 py-3">
  {(inv.display_status === 'pending' || inv.display_status === 'expired') && can('employees.write') && (
    <Button
      variant="outline"
      size="sm"
      onClick={() => handleResend(inv.pk_invitation_id)}
    >
      <RefreshCw className="w-3 h-3 mr-1" />
      Resend
    </Button>
  )}
</td>
```

### 2d. Issue 3 — Responsive table layout clipped the Actions column

**Before:**
```tsx
<div className={cn("border rounded-lg overflow-hidden", lightTheme.table.border)}>
  <table className="w-full">
```

**After:**
```tsx
<div className={cn("border rounded-lg overflow-x-auto", lightTheme.table.border)}>
  <table className="w-full min-w-[720px]">
```

> This matches the scroll-wrapper pattern already used elsewhere in the codebase (e.g. `RosterTab.tsx`, `VisitorManagement.tsx`, `HRMSManagement.tsx`).

---

## 3. Pending Approvals – Error State Handling

### File: `frontend/src/app/components/verticals/corporate/hr/PendingEnrollmentApprovals.tsx`

### 3a. Add `loadError` state

**Before:**
```tsx
const [approvals, setApprovals] = useState<PendingApproval[]>([]);
const [loading, setLoading] = useState(true);
const [selectedApproval, setSelectedApproval] = useState<PendingApproval | null>(null);
const [actionLoading, setActionLoading] = useState(false);
```

**After:**
```tsx
const [approvals, setApprovals] = useState<PendingApproval[]>([]);
const [loading, setLoading] = useState(true);
const [loadError, setLoadError] = useState(false);
const [selectedApproval, setSelectedApproval] = useState<PendingApproval | null>(null);
const [actionLoading, setActionLoading] = useState(false);
```

### 3b. Set/clear `loadError` in the fetch function

**Before:**
```tsx
const loadPendingApprovals = async () => {
  setLoading(true);
  try {
    const data = await apiRequest<{ pendingApprovals: PendingApproval[] }>(
      '/enroll/pending-approvals',
      { scopeHeaders }
    );
    setApprovals(data.pendingApprovals || []);
  } catch (err) {
    console.error('Failed to load pending approvals:', err);
    toast.error('Failed to load pending approvals');
  } finally {
    setLoading(false);
  }
};
```

**After:**
```tsx
const loadPendingApprovals = async () => {
  setLoading(true);
  setLoadError(false);
  try {
    const data = await apiRequest<{ pendingApprovals: PendingApproval[] }>(
      '/enroll/pending-approvals',
      { scopeHeaders }
    );
    setApprovals(data.pendingApprovals || []);
  } catch (err) {
    console.error('Failed to load pending approvals:', err);
    toast.error('Failed to load pending approvals');
    setLoadError(true);
  } finally {
    setLoading(false);
  }
};
```

### 3c. Add a dedicated error-state render, checked *before* the empty-state

Insert this block immediately before the existing `if (approvals.length === 0) { ... }` empty-state block (which is left completely unchanged):

```tsx
if (loadError) {
  return (
    <div className="text-center py-12 glass-card rounded-lg border border-slate-200 dark:border-slate-700">
      <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
      <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">Unable to load pending approvals</h3>
      <p className="text-slate-600 dark:text-slate-400 mb-4">Please try again.</p>
      <Button variant="outline" size="sm" onClick={loadPendingApprovals}>
        <RefreshCw className="w-3 h-3 mr-1" />
        Retry
      </Button>
    </div>
  );
}

if (approvals.length === 0) {
  return (
    <div className="text-center py-12 glass-card rounded-lg border border-slate-200 dark:border-slate-700">
      <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
      <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">All caught up!</h3>
      <p className="text-slate-600 dark:text-slate-400">No pending enrollment approvals</p>
    </div>
  );
}
```

> `XCircle`, `CheckCircle2`, `RefreshCw`, and `Button` are already imported at the top of this file — no new imports required.

---

## Summary Table

| # | File | Change |
|---|------|--------|
| 1 | `SystemHealth.tsx` | Avg Accuracy → scan-weighted average |
| 1 | `FacilityIntelligenceDashboard.tsx` | Avg Accuracy → scan-weighted average |
| 1 | `AccuracyLogs.tsx` | No change (dead code) |
| 2 | `RemoteEnrollmentManager.tsx` | Import `can` from `useAuth()` |
| 2 | `RemoteEnrollmentManager.tsx` | 403 → friendly "no permission" message instead of raw backend string |
| 2 | `RemoteEnrollmentManager.tsx` | Resend button gated by `can('employees.write')` |
| 2 | `RemoteEnrollmentManager.tsx` | Table wrapper: `overflow-hidden` → `overflow-x-auto` + `min-w-[720px]` on `<table>` |
| 3 | `PendingEnrollmentApprovals.tsx` | New `loadError` state |
| 3 | `PendingEnrollmentApprovals.tsx` | `loadPendingApprovals()` sets/clears `loadError` |
| 3 | `PendingEnrollmentApprovals.tsx` | New error-state render block, checked before the empty-state |

## Verification After Replication
- Run `npx tsc --noEmit` in `frontend/` — all four files should compile with no new errors.
- System Health: Avg Accuracy reflects scan-weighted value (verify against visible per-device cards).
- Enrollment: user without `employees.write` no longer sees the Resend button; a 403 (if forced) shows the friendly message; narrow viewport (e.g. DevTools open) scrolls the table instead of clipping the Actions column.
- Pending Approvals: force a failed fetch (e.g. block the `/enroll/pending-approvals` request) and confirm the error state + Retry button appears instead of "All caught up!".

## Out of Scope
This document does not cover the production Keycloak role-drift fix applied to one user account (`ramalingeswara.badi@motivitylabs.com`, realm `motivity-internal`) — that was a live data correction (Keycloak realm role assignment), not a code change, and does not need to be replicated in Development.
