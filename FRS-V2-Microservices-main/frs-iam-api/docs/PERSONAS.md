# Application personas

> Mirrored in `frs-web-ui/docs/PERSONAS.md` — keep both copies in sync (same pattern as
> `docs/ESTATE.md`). Source of truth for the roles: `backend/api/src/middleware/authz.js`'s
> `ROLE_PERMISSIONS` table (`:495-558`) — the permission lists below are cited from there, not
> guessed. If this drifts from that file, the file wins.

## Why this doc exists

Six RBAC roles exist in code but nothing previously explained *who* each one represents or *what
they're trying to do* — which matters for API/UI design decisions (what a new endpoint's
authorization should require, what a new page should show which role). This is that context.

## The six roles (by scope, broadest first)

| Role | Scope | Who they are | Can't do (vs. the role above) |
|---|---|---|---|
| `super_admin` | Global — `tenantId = null` (`authz.js:164`) | Motivity's own platform operators. Manage tenants, customers, tenant types across the whole estate — the `platform/` UI tree in `frs-web-ui` is exclusively theirs. | N/A — has every permission any tenant role has, plus platform-level ones (`authz.js:497-508`). |
| `tenant_admin` | One tenant, all sites | The customer-side admin for an entire tenant (a company/school/retail chain using FRS). Configures sites, overtime/break policy, manages all users within their tenant. | Platform-level operations (creating other tenants, `system.settings.write` — `authz.js:509-523` lacks it while `super_admin` has it). |
| `site_admin` | One tenant, scoped to specific sites | Manages one or more physical sites/locations within a tenant — device provisioning, shift assignment, employee management for their site(s). | `sites.delete`, `system.settings.read`, `overtime.configure`/`breaks.configure` (site-level, not policy-level) — `authz.js:524-535`. |
| `hr_manager` | One tenant, HR-scoped | The primary user of the corporate vertical's HR pages — employee lifecycle, attendance correction requests, shift/overtime, reports. No device-management permissions at all (`authz.js:536-546` has no `devices.*`). | Device management, site management, alert configuration. |
| `device_operator` | Devices only | A narrow, read-only-on-devices role (`authz.js:547-549`) — likely for an ops/facilities person who needs to check device status without touching HR or attendance data. | Everything except `devices.read`. |
| `viewer` | Read-only across attendance/devices/employees/reports/sites/users | An auditor/stakeholder role — read access broad enough to see the whole picture, zero write permissions (`authz.js:550-557`). | Every write/manage permission. |

## Vertical-specific personas (a different axis — which app, not which role)

The six roles above apply within a vertical; which vertical a user operates in determines *what*
they see (via the manifest-driven UI, see `frs-web-ui/docs/ARCHITECTURE.md`), not their
permissions. Roughly, by vertical:

- **Corporate** (default) — HR/attendance/security. Primary personas: `hr_manager` (day-to-day),
  `site_admin`/`tenant_admin` (configuration), plus corporate-specific reviewer personas implied
  by the UI structure: an **AI/confidence reviewer** (`verticals/corporate/aiReview/` — reviews
  low-confidence face-match results) and a **watchlist operator**
  (`verticals/corporate/watchlist/` — security/safety, not HR).
- **Education** — a thin relabeling of corporate (Employees→Students, per
  `frs-web-ui/docs/ARCHITECTURE.md`) for school administrators tracking student attendance.
- **Retail** — store-level personas: a **store manager** (occupancy/analytics for one store,
  `RetailStoreManagement.tsx`) and a **regional/multi-store viewer** (`RetailAnalytics.tsx`).
- **Transport** — an **Operations Manager** persona distinct from the corporate roles above
  (`verticals/transport/Operations*.tsx` — bus stops, routes, passenger enrollment, fleet
  attendance) — this vertical's permission model hasn't been traced against `authz.js` in this
  pass; confirm before assuming it maps 1:1 onto the six roles.

## How to use this

- **Designing a new endpoint's authorization**: pick the narrowest role in the table above that
  legitimately needs the new permission, add it to that role's array in `ROLE_PERMISSIONS`
  (`authz.js`) — don't default to `tenant_admin`/`super_admin` for convenience.
- **Designing a new UI page**: decide which persona it's for before deciding which vertical/manifest
  key it lives under (see `frs-web-ui/docs/ARCHITECTURE.md`'s `PAGE_REGISTRY` section) — a page for
  `hr_manager` and one for `site_admin` may both be "corporate" but need different nav placement.
- **Writing a spec**: name the persona(s) affected in the spec's problem statement — "as a
  `site_admin`, I want..." is more testable than "as a user."

## Not yet resolved (flagged, not guessed)

- Transport vertical's actual role mapping — the six roles above are confirmed from `authz.js`;
  whether/how they apply to `verticals/transport/*` specifically wasn't traced this pass.
- Whether `device_operator` and `viewer` map to any real-world job title the product team uses, or
  are purely technical/audit roles — worth a product conversation, not inferable from code.
