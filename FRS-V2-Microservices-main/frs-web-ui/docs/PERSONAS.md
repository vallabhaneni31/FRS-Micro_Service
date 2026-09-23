# Application personas

> Mirrored from `../frs-core-api/docs/PERSONAS.md` — keep both copies in sync (same pattern as
> `docs/ESTATE.md`). Source of truth for the roles is `backend/api/src/middleware/authz.js`'s
> `ROLE_PERMISSIONS` table in `frs-core-api`, not this repo — this copy adds the **UI-side view**
> (what each persona sees) on top of the backend copy's permission tables.

## Why this doc exists

Six RBAC roles exist in the backend but nothing previously explained *who* each one represents,
and separately, *which vertical/pages* they see is decided entirely by the server-driven manifest
(`GET /me/manifest` → `DashboardRenderer.tsx`'s `PAGE_REGISTRY`, see `docs/ARCHITECTURE.md`) — not
by anything client-side. This doc exists so a new page's persona and its manifest key are designed
together, not as two disconnected decisions.

## The six roles (full permission detail lives in `frs-core-api/docs/PERSONAS.md`)

| Role | Scope | Who they are |
|---|---|---|
| `super_admin` | Global | Motivity's own platform operators — the `src/app/components/platform/` tree is exclusively theirs. |
| `tenant_admin` | One tenant, all sites | Customer-side admin for an entire tenant. |
| `site_admin` | One tenant, scoped sites | Manages one or more physical sites within a tenant. |
| `hr_manager` | One tenant, HR-scoped | Primary user of `verticals/corporate/hr/*` pages. |
| `device_operator` | Devices only | Narrow, device-status-only role. |
| `viewer` | Read-only, broad | Auditor/stakeholder role. |

`useAuth().role` and `useAuth().vertical` are how components read these client-side (see
`src/app/contexts/AuthContext.tsx`) — `vertical` is a separate axis from `role` (see below), used
for label/branch decisions, never for routing.

## Verticals are a second, orthogonal axis

A role determines *what a user can do*; the vertical (corporate/education/retail/transport)
determines *which app they're in* and is set per-tenant, surfaced to the frontend as
`useAuth().vertical`. The two combine: a `hr_manager` in the `education` vertical sees
`StudentsPage.tsx` instead of `PeopleManagement` for the same `employees` manifest key
(`DashboardRenderer.tsx:130-134`, `EmployeesOrWorkspace`) — same role, different vertical, different
page. When adding a page, decide **both** which role(s) it's for and which vertical(s) it applies
to; most pages are corporate-only (102 of ~130 vertical files), so assume corporate-only unless the
feature is explicitly cross-vertical.

## Vertical-specific personas (UI-visible, not necessarily separate RBAC roles)

- **Corporate** (default) — `hr_manager` day-to-day; `site_admin`/`tenant_admin` for
  configuration; plus two UI-implied personas not confirmed against `authz.js` in this pass: an
  **AI/confidence reviewer** (`verticals/corporate/aiReview/`) and a **watchlist operator**
  (`verticals/corporate/watchlist/`).
- **Education** — school administrators; UI is corporate relabeled (Employees→Students), single
  dedicated page (`StudentsPage.tsx`) rather than a full parallel tree — thin by design.
- **Retail** — a **store manager** (`RetailStoreManagement.tsx`, one store) and a
  **regional/multi-store viewer** (`RetailAnalytics.tsx`).
- **Transport** — an **Operations Manager** persona with its own page set
  (`verticals/transport/Operations*.tsx`) — routes, bus stops, fleet, passenger enrollment. Not
  confirmed to map onto the six roles above; treat as a UI-only persona until backend-verified.

## How to use this

- **Designing a new page**: name the persona (role) and vertical(s) it's for before deciding its
  `PAGE_REGISTRY` key — see `docs/ARCHITECTURE.md`.
- **Writing a spec**: "as a `site_admin` in the retail vertical, I want..." is testable; "as a
  user" is not.
- If a UI change implies a *new* permission, that's a backend change first
  (`frs-core-api/docs/PERSONAS.md` + `authz.js`) — don't gate a feature purely client-side.

## Not yet resolved (flagged, not guessed)

- Whether the AI-reviewer/watchlist-operator/store-manager/operations-manager personas above
  correspond to distinct backend roles or are just UI groupings of the existing six — not traced
  against `authz.js` this pass.
