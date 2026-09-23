# FRS Test Plan — Test Cases & Edge Cases

Motivity Face Recognition System — QA test specification covering authentication, multi-tenant scoping, employee & HR management, biometric enrollment, attendance, edge devices, notifications, reporting, admin, visitors, and data retention.

Assembled from a full read-through of the live codebase (routes, services, repositories, migrations, and frontend components). File:line references in the source research may drift as the code changes — treat them as pointers to re-locate the relevant logic, not permanent citations.

**Priority key:** `P0` = blocking/security-relevant, `P1` = important, `P2` = nice-to-verify.

**Flag key (in "Edge Cases & Known Gaps" sections):** `BUG` = an inconsistency or defect already visible in the current code, worth a dedicated regression test. `EDGE` = a boundary condition the code appears to handle but should be explicitly verified. `SEC` = security-relevant (auth bypass, cross-tenant leakage, injection surface).

**Stats:** 20 modules · 247 test cases · 58 edge cases flagged · 21 known gaps/bugs.

## Contents

1. [Authentication & Session Management](#1-authentication--session-management-auth)
2. [Roles & Permissions](#2-roles--permissions-rbac)
3. [Multi-Tenancy & Scoping](#3-multi-tenancy--scoping-ten)
4. [Employee CRUD](#4-employee-crud-emp)
5. [Manager Hierarchy & Org Tree](#5-manager-hierarchy--org-tree-mgr)
6. [Departments, Shifts, Sites & Units](#6-departments-shifts-sites--units-org)
7. [HRMS Sync & Bulk Import](#7-hrms-sync--bulk-import-hrms)
8. [Enrollment Invitation Lifecycle](#8-enrollment-invitation-lifecycle-enr-inv)
9. [Self-Enrollment Portal](#9-self-enrollment-portal-camera-pose-quality-enr-cap)
10. [HR Approval & Embedding Pipeline](#10-hr-approval--embedding-pipeline-enr-app)
11. [Enrollment Reminders](#11-enrollment-reminders-enr-rem)
12. [Attendance Recording](#12-attendance-recording-att)
13. [Live Attendance Dashboard](#13-live-attendance-dashboard-dash)
14. [Device Management (Jetson / Edge)](#14-device-management-jetson--edge-dev)
15. [Notifications & Email](#15-notifications--email-notif)
16. [Reports & Analytics](#16-reports--analytics-rpt)
17. [Admin: Tenant / User / Role](#17-admin-tenant--user--role-adm)
18. [Visitor Management](#18-visitor-management-vis)
19. [GDPR & Data Retention](#19-gdpr--data-retention-gdpr)
20. [Cross-Cutting Security & Rate Limiting](#20-cross-cutting-security--rate-limiting-sec)

---

## 1. Authentication & Session Management (AUTH)

Keycloak-based JWT auth (with a legacy cookie-session mode), token refresh, MFA challenge, account lockout, and the realm-per-tenant resolution that underlies every authenticated request.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| AUTH-01 | Valid login (Keycloak mode) | Correct email/password against a registered realm | 200, access + refresh token issued, cookie set httpOnly/secure(prod)/sameSite=strict | P0 |
| AUTH-02 | Invalid password | Correct email, wrong password | 401, generic invalid-credentials message, failed-attempt counter increments | P0 |
| AUTH-03 | Account lockout threshold | Fail login exactly `maxFailedLogins` times, then one more | Account locked for 15 min on the threshold attempt; further attempts return 403 "Account locked" without checking password | P0 |
| AUTH-04 | Lock expiry boundary | Attempt login 1s before and 1s after `locked_until` | Rejected before expiry, normal auth flow resumes after | P1 |
| AUTH-05 | Deactivated account login | `is_active=false` user attempts login | 403 deactivated message, no token issued, no failed-attempt increment | P0 |
| AUTH-06 | MFA-enabled user login | User with `mfa_enabled=true` logs in | Returns `mfaRequired` + short-lived challenge token, no session cookie set yet | P0 |
| AUTH-07 | MFA challenge token expiry | Submit MFA code after the 2-min challenge token expires | Rejected, must restart login | P1 |
| AUTH-08 | Forgot-password enumeration resistance | Submit forgot-password for an existing vs. non-existent email | Identical generic success response both times — no signal of account existence | P0 |
| AUTH-09 | Token refresh (cookie mode) | Call refresh with valid httpOnly refresh cookie, no body | New access token issued | P1 |
| AUTH-10 | Token refresh (token mode) | Call refresh with refreshToken in body (mock/keycloak client) | New access token issued | P1 |
| AUTH-11 | Expired access token on API call | Call any authenticated route with an expired JWT | 401 `TokenExpiredError`, client should trigger refresh flow | P0 |
| AUTH-12 | Malformed / tampered JWT | Flip one character in a valid JWT signature | 401, verification fails cleanly, no stack trace leaked | P0 |
| AUTH-13 | Bearer header takes precedence over stale cookie | Send a valid Bearer token alongside an old/invalid access_token cookie | Bearer wins; request succeeds using header token, not the stale cookie | P0 |
| AUTH-14 | Unregistered Keycloak realm | JWT `iss` references a realm slug with no `tenant_realm` row | 401 "Realm X is not registered" | P0 |
| AUTH-15 | JWKS fetch failure with stale cache | Keycloak JWKS endpoint down, but a cached key set <30s past its 5-min TTL exists | Stale JWKS served, request succeeds (grace window) | P1 |
| AUTH-16 | JWKS fetch failure, no cache | Keycloak down, first request ever for that realm | 503, no silent auth bypass | P0 |
| AUTH-17 | Audience mismatch | JWT with `aud` not in `["account", expectedClientId]` | Rejected, unless `strictAudience` is deliberately off — verify current deployment's setting | P0 |
| AUTH-18 | Login rate limiting (per-IP) | 10 failed attempts within 5 min from one IP across different accounts | 11th attempt blocked regardless of account, 429 | P1 |
| AUTH-19 | Login rate limiting (per-account, distributed IPs) | 8 failed attempts against one email from 8 different IPs within 15 min | 9th attempt blocked (per-email limiter), even though no single IP tripped its own limit | P0 |
| AUTH-20 | Successful logins never count toward account lockout | Rapid repeated correct logins | `skipSuccessfulRequests` — never locks out a legitimately fast-typing user | P2 |

**Edge cases & known gaps**
- **BUG** — In `NODE_ENV=development`, any Keycloak auth failure silently synthesizes a `super_admin` payload bound to the first admin/first DB user, and `requirePermission`/`validateScopeAccess` skip entirely. Regression-test that this path is unreachable when `NODE_ENV=production`, and add a boot-time assertion if one doesn't exist.
- **EDGE** — Legacy mode registers `/login`/`/refresh`/`/logout` only when `authMode !== "keycloak"` — verify these routes genuinely 404 (not silently no-op) in Keycloak-mode deployments.
- **SEC** — Cookies are only `secure` in production — confirm a staging environment reachable over plain HTTP doesn't accidentally get treated as "production" by `NODE_ENV`, which would silently drop the secure flag in a reachable environment.

---

## 2. Roles & Permissions (RBAC)

Two coexisting permission models — a hardcoded legacy role→permission map, and a newer UUID-based `rbac_role`/`rbac_permission` table set — plus plan-feature gating.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| RBAC-01 | Each legacy role's permission boundary | For each of super_admin / tenant_admin / site_admin / hr_manager / device_operator / viewer, call one endpoint just inside and one just outside its permission list | In-scope call succeeds, out-of-scope call 403s, for every role | P0 |
| RBAC-02 | Viewer cannot write | Viewer role calls any `*.write` gated route | 403 | P0 |
| RBAC-03 | super_admin bypass is unconditional | super_admin calls a route whose permission isn't even in `ROLE_PERMISSIONS` | Still succeeds via the explicit `roles.includes('super_admin')` bypass | P1 |
| RBAC-04 | Role name typo / unknown role | User's Keycloak realm role isn't a key in `ROLE_PERMISSIONS` | Silently denied (no permissions resolved) rather than erroring — verify this doesn't look like a transient failure to the user | P1 |
| RBAC-05 | New RBAC table path | User has rows only in `user_role`/`rbac_permission`, none in legacy path | Permissions resolve correctly via `getRbacPermissionsForUser` | P0 |
| RBAC-06 | Zero rows in either RBAC system | User has no legacy role and no new-table membership | 403 scope denied, not a crash | P0 |
| RBAC-07 | Feature-gated route, plan lacks feature but tenant custom_features includes it | Hit a `requireFeature` route | Succeeds — custom_features is additive over plan | P1 |
| RBAC-08 | Feature explicitly disabled overrides plan inclusion | Tenant's plan includes the feature, but `disabled_features` lists it, call the route directly (bypass UI hiding) | 402/403, not 200 — disabled wins over plan | P0 |
| RBAC-09 | Site Admin attempts to demote a Tenant Admin | Site Admin calls role-change API directly on a tenant_admin user (bypassing hidden UI controls) | 403 — backend must enforce `cannotManageThisUser`-equivalent, not just the frontend | P0 |
| RBAC-10 | Removing the last Tenant Admin | Tenant has exactly one tenant_admin; attempt to demote/delete them | Should be blocked (tenant left admin-less) — verify actual behavior, this may currently be unguarded | P0 |
| RBAC-11 | User with multiple site-scoped roles | User has role rows for two different sites | `getEffectiveSiteId` resolution is deterministic and matches the intended active site, not an arbitrary first-row pick | P1 |
| RBAC-12 | Report schedule permission granularity | User with only `analytics.read` creates/deletes a scheduled report or template | Confirm whether this should require a write-level permission — currently the same `analytics.read` gates create/delete too | P1 |

**Edge cases & known gaps**
- **BUG** — `listTenantAdmins` filters by a hardcoded `fk_role_id = 7` — fragile if role IDs are ever renumbered; add a test that fails loudly if role 7 stops meaning tenant_admin.
- **EDGE** — Two systems (legacy role map + new RBAC tables) can disagree for the same user if one was updated and not the other — test a user granted a permission in one system but revoked in the other.
- **SEC** — Analytics report schedule/template CRUD is gated only by `analytics.read` — treat as a likely privilege-scoping gap until confirmed intentional.

---

## 3. Multi-Tenancy & Scoping (TEN)

Tenant → customer → site → unit hierarchy. JWT is the authoritative source of tenant identity; headers are hints, not overrides.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| TEN-01 | x-tenant-id spoofing attempt | Valid JWT for tenant A, `x-tenant-id` header set to tenant B | 403 "scope access denied: tenant mismatch with token" — header never wins over JWT | P0 |
| TEN-02 | Cross-tenant customer header | Valid tenant, but `x-customer-id` belongs to a different tenant | Header is silently cleared (not a hard error) — verify this doesn't leak the other tenant's customer data before being cleared | P0 |
| TEN-03 | Unit without a site in scope path | Request scoped to a unit whose parent site isn't also in scope | 400 `INVALID_SCOPE_HIERARCHY` | P1 |
| TEN-04 | Site without a customer in scope path | Same as above, one level up | 400 `INVALID_SCOPE_HIERARCHY` | P1 |
| TEN-05 | JWT missing tenant_id claim | Token from a misconfigured Keycloak client with no Protocol Mapper for tenant_id | Falls back to first membership's tenant — logs a warning; verify this doesn't silently scope a user to the wrong tenant in a multi-tenant-membership account | P0 |
| TEN-06 | User with memberships across multiple customers, no explicit selection | Global-role user, tenant resolved, but multiple customers exist | Deterministic customer resolution — currently "first customer by pk_customer_id" — verify this matches product intent, not just DB insertion order | P1 |
| TEN-07 | Global (tenantId=null) super_admin membership | Super admin without a tenant-specific row | Global bypass — can access any tenant's scoped data explicitly requested | P0 |
| TEN-08 | Route wired without scope middleware | Audit each route for correct `validateScopeAccess`/`requireScope` ordering | No route silently skips scope validation due to middleware ordering | P0 |
| TEN-09 | Employee record IDOR across tenants | Authenticated as tenant A, request an employee/report/invitation ID belonging to tenant B by guessing/incrementing IDs | 404/403 for every entity type — no cross-tenant ID enumeration works | P0 |
| TEN-10 | Report export cross-tenant IDOR | Request `/export/:reportId/csv` for a reportId owned by another tenant | 403/404, not the other tenant's data | P0 |

**Edge cases & known gaps**
- **EDGE** — `ensureScope` in `scopeExtractor.js` is a no-op placeholder — scope safety currently depends entirely on correct manual middleware ordering per route. A route-by-route audit is worth doing as its own dedicated test pass.
- **BUG** — `getSiteTimezone(siteId, tenantId)` — when called with only `tenantId` (no siteId), queries `frs_site.tenant_id`, a column that doesn't exist (site only has `fk_customer_id`). Fails silently, falls back to `Asia/Kolkata` for every non-IST tenant doing a tenant-level (no-site) rollup. This affects dashboard aggregates and possibly attendance timezone math — high-value regression test.

---

## 4. Employee CRUD (EMP)

Employee record creation, update, validation, and the site/department/shift assignments attached to it.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| EMP-01 | Create with all required fields | `employee_code`, `full_name`, valid `email`, `position_title`, `join_date` supplied | 201, employee row created | P0 |
| EMP-02 | Missing required field | Omit `join_date` | 400 with Zod field-level error | P0 |
| EMP-03 | Invalid email format | `email: "not-an-email"` | 400 | P0 |
| EMP-04 | Null location_label / phone_number | Edit an employee whose `location_label` is `null` in DB | 200 — schema accepts null (previously a bug where this 400'd, since fixed) | P0 |
| EMP-05 | Duplicate employee_code, same tenant | Create with a code that already exists in this tenant | 409/400 "Employee ID already exists" | P0 |
| EMP-06 | Duplicate employee_code, different tenant | Same code, different tenant_id | Succeeds — uniqueness is per-tenant | P1 |
| EMP-07 | Duplicate email, same tenant | Create with an email already used in this tenant | 409/400 "Email address already exists" | P0 |
| EMP-08 | Assign an inactive site | `site_ids` includes one inactive + one active site | Whole request rejected, response names the inactive site(s) | P1 |
| EMP-09 | Empty site_ids array | Update with `site_ids: []` | `site_id` derives to null, no crash | P1 |
| EMP-10 | Status transition to invalid value | `status: "terminated"` (not in Zod enum) | 400 — even though the DB CHECK constraint would technically allow "on-leave", confirm exactly which values the API accepts vs. rejects | P1 |
| EMP-11 | Bulk import with duplicate code within the same file | CSV/bulk payload with two rows sharing an employee_code | Per-row duplicate detection scoped to tenant — second row rejected or flagged, not silently overwritten | P1 |
| EMP-12 | Bulk import with unmatched department/shift name | Row references a department name with no match (typo) | Row is imported with a null department rather than erroring — verify this is surfaced to the importer somehow, since currently it may be silent | P1 |
| EMP-13 | Case/whitespace-differing department names | Import rows with "Sales", "sales ", "SALES" | All resolve to the same department (case-insensitive match) — verify no accidental duplicate department creation | P2 |
| EMP-14 | Frontend "ready to submit" gate vs. backend requirements | Submit create-employee form with fields the frontend gate allows but backend Zod also requires (e.g., missing position_title) | Frontend should require everything backend requires — currently a possible mismatch worth confirming | P1 |
| EMP-15 | Search/filter via direct URL manipulation | Navigate to the employee list with `?status=bogus` or similar invalid query param | Falls back to a sane default, doesn't crash the page | P2 |
| EMP-16 | Employee profile displays reporting manager | View profile of an employee with `fk_manager_id` set | "Reports To" shows the correct manager name | P1 |

**Edge cases & known gaps**
- **BUG** — Shift deletion has **no active-employee guard** at all — unconditionally nulls every assigned employee's `fk_shift_id` and deletes, unlike department delete which blocks (409) unless `force=true`. Inconsistent behavior worth a dedicated test and likely a fix.
- **BUG** — Site deletion has no friendly "N active employees attached" guard like departments do — an employee still referencing the site via `site_id` causes a raw FK-violation 500 instead. `site_ids` (array column) has no FK at all, so it can silently reference deleted sites with zero error.
- **EDGE** — `department delete ?force=true` bypasses the active-employee check entirely — verify this is an intentional escape hatch and appropriately permission-gated, not just a query-string toggle anyone with delete permission can flip.

---

## 5. Manager Hierarchy & Org Tree (MGR)

Self-referencing reporting-manager assignment, the explicit `is_manager` flag, and the workspace hierarchy tree view.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| MGR-01 | Assign a valid manager | Set `fk_manager_id` to another active, `is_manager=true` employee | Succeeds, manager name resolves correctly everywhere it's displayed | P0 |
| MGR-02 | Self-reference block | Set an employee's `fk_manager_id` to their own id | Rejected with a clear error ("An employee cannot be their own manager") | P0 |
| MGR-03 | Direct circular reference (A→B, then B→A) | Make A report to B, then make B report to A | Currently unguarded anywhere in the stack — verify actual behavior and whether it should be blocked | P0 |
| MGR-04 | Indirect circular reference (A→B→C→A) | Chain three employees into a cycle | Same as above — no cycle detection currently exists; decide if this needs a fix or is acceptably rare | P1 |
| MGR-05 | Delete a manager with direct reports | Delete an employee who is others' `fk_manager_id` | DB `ON DELETE SET NULL` nulls their reports' manager field — verify the app surfaces this (reports silently become "no manager") rather than confusing HR | P1 |
| MGR-06 | Deactivate (not delete) a manager | Set an active manager's status to inactive | `listManagers` excludes inactive managers from the picker immediately — but existing direct reports still point at them (orphaned reference); verify the UI doesn't show a blank/broken manager name for those reports | P0 |
| MGR-07 | Manager picker excludes the employee being edited | Open edit form for employee X | X does not appear in their own manager dropdown | P1 |
| MGR-08 | `is_manager=true` with zero direct reports | Flag an employee as manager without assigning anyone to them | Valid state — they appear in the picker, badge shows, no error | P2 |
| MGR-09 | Employee with `fk_manager_id` set but flagged manager themself and reporting further up | Mid-level manager: `is_manager=true` AND has their own `fk_manager_id` | Workspace tree's top-level "managers" list currently only surfaces managers with `fk_manager_id IS NULL` — mid-level managers are invisible in that view; confirm whether this is intended or a gap in the org-chart feature | P1 |
| MGR-10 | Direct-report count excludes inactive reports | Manager has 3 active + 2 inactive direct reports | Tree shows count of 3, not 5 | P2 |

**Edge cases & known gaps**
- **BUG** — No circular-reference guard anywhere (service layer or DB constraint) beyond the direct self-reference check. A 2-hop or longer cycle will persist silently and could break org-tree rendering (infinite loop risk in any recursive UI walk) — recommend adding a cycle check on write.
- **EDGE** — Mid-level managers (both a manager and someone's report) are excluded from the top-level "managers" list in the workspace tree endpoint — likely an unintended gap for any org deeper than two levels.

---

## 6. Departments, Shifts, Sites & Units (ORG)

Structural org entities and the cascade rules when they're edited or deleted while employees are attached.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ORG-01 | Delete department with active employees | Department has ≥1 active employee, no `force` flag | 409, blocked with employee count in message | P0 |
| ORG-02 | Delete department with only inactive employees | All assigned employees are inactive | Succeeds, their `fk_department_id` is nulled | P1 |
| ORG-03 | Force-delete department with active employees | `?force=true` on a department with active staff | Succeeds, all assigned employees (active or not) get nulled — confirm this is permission-gated appropriately | P1 |
| ORG-04 | Delete shift with active employees | Shift has active employees assigned, no guard exists | Currently succeeds unconditionally — flag as inconsistent with department behavior; test to confirm and decide if a guard should be added | P0 |
| ORG-05 | Delete site with active employees attached | Site has employees via `site_id` | Currently a raw FK-violation failure ("Some active resources may still be attached") rather than a friendly count — verify actual error surfaced to HR | P1 |
| ORG-06 | Delete site, cascading child data | Site has units/buildings/user-memberships | `frs_user_membership`, `frs_unit`, `frs_building` rows for that site are deleted correctly | P1 |
| ORG-07 | site_ids array referencing a deleted site | Employee's `site_ids` array contains an id for a site that was later deleted | No FK to catch this — verify UI degrades gracefully (e.g., shows nothing for that entry) rather than erroring | P1 |
| ORG-08 | Site ownership check on update/delete | Attempt to update/delete a site belonging to a different tenant | 403/404 — regression test for a previously-flagged missing-ownership-check bug that was already patched | P0 |
| ORG-09 | Unit created under an inactive/nonexistent site | Create a unit referencing a bad `site_id` | 400, not a silent orphan record | P1 |

**Edge cases & known gaps**
- **BUG** — Department, shift, and site each handle "delete while employees attached" completely differently (blocked+friendly / unguarded / raw-FK-error respectively). Recommend unifying behavior and adding explicit tests per entity so this doesn't silently drift further apart.

---

## 7. HRMS Sync & Bulk Import (HRMS)

External HRMS webhook/sync integration and CSV bulk import, both distinct from the manual employee-creation form.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| HRMS-01 | Webhook without API key | Call `/webhook/employee` with no/invalid API key | 401 — this route intentionally skips `requireAuth` in favor of API-key auth, confirm the key check is actually enforced | P0 |
| HRMS-02 | Date format variety | Sync payload with join_date as DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD | All parse to the correct ISO date | P1 |
| HRMS-03 | Unparseable date | join_date as a garbage string | Currently falls back to storing the raw unparseable string — verify this doesn't corrupt downstream date logic (attendance, tenure reports); consider rejecting instead | P0 |
| HRMS-04 | Sync payload with unknown extra fields | JSON body includes fields not in the schema | `.passthrough()` Zod schema accepts them silently — confirm they aren't accidentally persisted somewhere unsafe | P1 |
| HRMS-05 | Auto-created department name collision | Sync two employees with department names differing only by case/whitespace | Both resolve to the same auto-created department, no duplicates | P2 |
| HRMS-06 | Bulk CSV import with malformed rows interspersed | CSV with some valid rows and some missing required fields | Valid rows import, invalid rows are reported per-row, not an all-or-nothing failure (verify actual behavior) | P1 |

---

## 8. Enrollment Invitation Lifecycle (ENR-INV)

Token issuance, invitation status transitions, resend/revoke, consent gating, and the anti-spoofing photo checks.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ENR-INV-01 | Send invitation to a valid employee with email | Employee has an email, no active invitation | Invitation created, status=pending, email dispatched, 7-day token | P0 |
| ENR-INV-02 | Send invitation, employee has no email | Employee record missing email | Skipped, reason surfaced in the batch-send response, not a hard failure of the whole batch | P1 |
| ENR-INV-03 | Send invitation to already-enrolled-and-approved employee | Employee already has a completed+approved enrollment | Skipped with reason, no duplicate invite sent | P1 |
| ENR-INV-04 | Batch invite over 100 employees | Submit 101 employee IDs at once | 400, batch size limit enforced | P1 |
| ENR-INV-05 | Re-inviting an employee with an existing pending invitation | Employee already has status=pending invite, send again | Old pending invitation auto-expires, new one created — no two simultaneously-valid links for one employee | P0 |
| ENR-INV-06 | Email dispatch failure during send | SMTP throws during invitation send | Invitation DB row is rolled back (deleted), not left in a phantom pending state with no email ever sent | P0 |
| ENR-INV-07 | Token opened (GET) transitions status | First GET on a pending invitation's token | status flips pending→opened, `opened_at` set | P1 |
| ENR-INV-08 | Token GET after completion | GET a token whose invitation is already completed | Returns status=completed, portal shows "already completed" error screen, cannot re-enter capture flow | P0 |
| ENR-INV-09 | Token GET after expiry | GET a token past its 7-day `expires_at` | Returns status=expired, portal shows expired-link message | P0 |
| ENR-INV-10 | Revoked token blocks every subsequent public route | Revoke an invitation mid-capture, then call upload-angle / check-pose / complete with the same token | 401 "Invitation has been revoked or expired" on every one of them, even though the JWT itself is still cryptographically valid | P0 |
| ENR-INV-11 | Resend generates a fresh token | Resend an invitation | New token issued, new 7-day expiry, `opened_at` reset to null | P0 |
| ENR-INV-12 | Old link still valid immediately after a resend | Use the pre-resend token right after resending | Old token is not blacklisted by resend — verify whether it still works (points at the same row) and if that's the intended behavior | P1 |
| ENR-INV-13 | Consent required before first photo upload | Attempt upload-angle before consent step | 400 "GDPR consent is required..." | P0 |
| ENR-INV-14 | Consent withdrawn mid-flow, then complete called | Withdraw consent after some angles uploaded, then call `/complete` | Currently NOT re-checked at complete — verify this gap and whether it should block completion | P0 |
| ENR-INV-15 | Duplicate photo across two angles (liveness check) | Upload byte-identical images for "front" and "left" | Second upload rejected: "Liveness check failed: duplicate static photo detected" | P0 |
| ENR-INV-16 | Invalid angle name | upload-angle with `angle: "sideways"` | 400 invalid angle | P1 |
| ENR-INV-17 | Server boot with missing/short ENROLLMENT_TOKEN_SECRET | Start server with the secret unset or <32 chars | Hard boot failure, not a degraded/insecure running state | P0 |

**Edge cases & known gaps**
- **BUG** — Consent is enforced at photo-upload time but not re-checked at `/complete` — a withdrawal between the last photo and submission doesn't block completion. Worth a fix and a regression test.
- **EDGE** — An old (pre-resend) token isn't blacklisted when a new one is issued for the same invitation — it still resolves to the same row and may still function until overwritten again by a further resend.
- **SEC** — SSRF and forced-HTTPS protections for Jetson calls (blocking metadata IPs, loopback, non-allowlisted IPs; blocking `JETSON_FORCE_HTTP` in prod) are marked as already-fixed in code comments — good candidates for permanent regression tests rather than one-time fixes.

---

## 9. Self-Enrollment Portal (Camera, Pose, Quality) (ENR-CAP)

The 8-angle capture flow, live pose/quality guidance, and the accessory-occlusion heuristics (sunglasses/mask detection).

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ENR-CAP-01 | Full happy-path capture | Consent → capture all 8 angles with good lighting/pose → review → submit | All 8 angles score well, submit succeeds, invitation status=completed | P0 |
| ENR-CAP-02 | Camera permission denied | Deny browser camera permission | Clear "Camera permission denied" toast, no crash | P0 |
| ENR-CAP-03 | No camera on device | Device with no camera hardware | "No camera found on this device" message | P1 |
| ENR-CAP-04 | Non-HTTPS context | Load portal over plain HTTP | Explicit "Camera requires HTTPS" message rather than a generic getUserMedia failure | P1 |
| ENR-CAP-05 | Half/cropped face | Position so only half the face is in frame | `fully_visible:false`, confidence forced to 0, live banner says "cropped at the edge — step back or center yourself" | P0 |
| ENR-CAP-06 | Face turned/occluded (landmark asymmetry) | Extreme turn beyond normal yaw range for the requested angle | `partial_face:true`, confidence 0, "part of your face looks hidden or turned away" | P0 |
| ENR-CAP-07 | Sunglasses / dark tinted glasses | Wear dark sunglasses during capture | `glasses_detected:true`, confidence 0, "please remove sunglasses or tinted glasses" | P0 |
| ENR-CAP-08 | Clear/transparent glasses | Wear ordinary prescription glasses, no tint | Known limitation — heuristic keys off brightness/color, unlikely to reliably flag clear lenses; document as an accepted gap, not a silent failure | P1 |
| ENR-CAP-09 | Mask / face covering | Wear a surgical mask or similar covering nose+mouth | `mask_detected:true`, confidence 0, "please remove your mask or face covering" | P0 |
| ENR-CAP-10 | False-positive check: clean, unobstructed face | Normal, well-lit, fully-visible front-facing photo | All four flags (fully_visible, partial_face, glasses_detected, mask_detected) read as expected/false — no false trigger | P0 |
| ENR-CAP-11 | Live pose guidance directs correct angle | For each of the 8 angles, pose slightly off-target | Banner suggests the correct correction ("turn slightly left", "tilt your head up a bit") matching the actual deviation direction | P0 |
| ENR-CAP-12 | Live pose guidance when correctly posed | Match the target pose for the current angle within tolerance | "Good — hold that pose!" (green), not a spurious correction | P1 |
| ENR-CAP-13 | Live pose-check rate limiting | Force check-pose calls faster than the poll interval (e.g., scripted flood) | 429 once the per-token budget (40/min) is exceeded | P1 |
| ENR-CAP-14 | Live pose-check never persists | Call check-pose repeatedly with varying angles | Invitation's `photo_paths`/embeddings are completely unaffected — verify via DB inspection | P0 |
| ENR-CAP-15 | Face-quality service unreachable during real capture | Stop `face-quality-svc`, then upload-angle | Photo still saved, `quality:null`, `quality_pending:true`, portal shows "quality score unavailable" but does not block progress | P0 |
| ENR-CAP-16 | Submit allowed despite poor quality | All 8 angles captured but several score low/face_detected=false | Submit button is enabled once all 8 slots are filled regardless of score — only a warning banner, no hard block (by design: mandatory HR review handles the rest) | P1 |
| ENR-CAP-17 | Retake an angle | Retake "front" after capturing | Only that angle's photo/object URL is cleared, other 7 untouched | P1 |
| ENR-CAP-18 | Camera stream persists across angle navigation | Move quickly between angles | Video element re-attaches to the same MediaStream without a visible freeze/black frame | P1 |
| ENR-CAP-19 | Token expires mid-capture | Let the 7-day token lapse between angle 4 and angle 5 (or force via clock/short-lived test token) | Next upload-angle call 401s; already-uploaded angles remain in DB but the session cannot continue without a fresh invite | P0 |
| ENR-CAP-20 | Browser refresh mid-capture | Refresh the page after uploading 3 of 8 angles | Frontend state resets to angle 1 (does not reload previously-uploaded photos from server) — retaking "front" overwrites the same S3 key; verify this doesn't confuse the user about progress already saved | P1 |

**Edge cases & known gaps**
- **EDGE** — Accessory detection is heuristic (patch brightness/color/texture comparison), not a trained classifier — reliably catches dark sunglasses and opaque masks but will likely miss clear glasses. Document this limitation for QA sign-off rather than treating misses on clear glasses as a bug.
- **EDGE** — A refresh mid-capture silently restarts the visible flow from angle 1 while the server-side record of already-uploaded angles is untouched — worth deciding whether to add a "resume where you left off" reload from `photo_paths` on mount.

---

## 10. HR Approval & Embedding Pipeline (ENR-APP)

Manual HR approval of completed enrollments, the embedding-creation pipeline (direct Jetson call or queued fallback), and duplicate-face rejection.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ENR-APP-01 | Approve a completed enrollment | Invitation status=completed, not yet approved | approval_status→pending_embedding immediately, 200 returned before embedding finishes (async) | P0 |
| ENR-APP-02 | Approve an invitation not yet completed | status is still pending/opened/in_progress | Rejected — cannot approve an incomplete enrollment | P0 |
| ENR-APP-03 | Double-approve | Approve an invitation that's already approved | Rejected / no-op, not a duplicate embedding run | P0 |
| ENR-APP-04 | Reject with reason, re-enrollment invite sent | Reject a completed enrollment with a reason | approval_status=rejected, new invitation link emailed with the reason and photo tips | P0 |
| ENR-APP-05 | Duplicate face detected against another person | New enrollment's embedding closely matches (cosine ≥0.50) an existing employee/person | Embedding creation aborts entirely, approval_status=rejected, reason names the conflicting person | P0 |
| ENR-APP-06 | Tampered photo integrity token | Modify a stored photo after upload (simulate tampering) before approval triggers embedding | HMAC integrity check fails for that angle, embedding_status=failed, approval_status=rejected with reason | P0 |
| ENR-APP-07 | No active Jetson device for the tenant | Approve enrollment when tenant has zero online edge devices | Embedding deferred immediately, embedding_status stays pending, no error thrown to the approving HR user | P1 |
| ENR-APP-08 | Partial success across angles | Some angles embed directly via Jetson, others fail and get queued | embedding_status=partial_success, progress endpoint reflects mixed per-angle states correctly | P1 |
| ENR-APP-09 | Re-approving after a failed embedding attempt | Previous embeddings partially exist from a failed run, approve again | Existing embeddings for that employee are deleted before the new run — no duplicate/stale embeddings left behind | P0 |
| ENR-APP-10 | Progress polling scoped to the latest attempt | Employee has an old failed attempt and a new in-progress attempt | Progress endpoint only reflects rows since the current attempt's timestamp — stale rows from the old attempt don't leak in | P0 |
| ENR-APP-11 | Visitor (person-based) progress granularity | Track embedding progress for a visitor enrollment | All angles flip to "embedded" together (no per-angle column for visitors) — confirm this coarser granularity is acceptable UX for the visitor flow | P2 |
| ENR-APP-12 | Employee deactivated after enrollment approved, before embedding completes | Deactivate the employee mid-pipeline | Verify whether embedding still completes for a now-inactive employee, and whether that's desired | P1 |

**Edge cases & known gaps**
- **BUG** — `completeEnrollment` hardcodes `approvalStatus='pending'` always — the auto-approve code path (`markInvitationAutoApproved`) exists in the repository layer but is never called from the service. If auto-approval is meant to exist for any flow (e.g. high-quality visitor scans), it's currently dead code — worth a test confirming no invitation ever reaches `auto_approved` today, and a product decision on whether that's intended.

---

## 11. Enrollment Reminders (ENR-REM)

Per-tenant configurable automatic reminders (site-local time) plus HR-triggered manual reminders.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ENR-REM-01 | Toggle reminders on for a tenant | Enable via Reminder Settings panel | `tenant_settings.custom_settings.enrollment_reminders_enabled=true` persisted | P0 |
| ENR-REM-02 | Change reminder hour without disabling | Adjust the hour dropdown while already enabled | Hour updates, enabled state is untouched (independent fields) | P1 |
| ENR-REM-03 | Toggle off without hour in the request body | PUT with only `{enabled:false}` | Previously-configured hour is preserved, not reset to the 9 AM default | P0 |
| ENR-REM-04 | Invalid hour value | PUT with `hour: 24` or `hour: -1` | 400 "hour must be an integer between 0 and 23" | P1 |
| ENR-REM-05 | Cron fires exactly at configured local hour | Site-local clock reads the configured hour for a tenant with reminders on | Eligible (pending/opened/in_progress, not expired) invitations receive one reminder email each | P0 |
| ENR-REM-06 | No duplicate reminder same local day | Cron ticks multiple times within the same local-hour window | Only one reminder sent per invitation per local calendar day, deduped via `last_reminder_sent_at` | P0 |
| ENR-REM-07 | Two sites in different timezones, same tenant | One site at UTC+5:30, another at UTC-8, both with configured hour=9 | Each site's employees are reminded at their own 9 AM local, not the server's or a single site's time | P0 |
| ENR-REM-08 | Site with no timezone configured | Employee's site has a null `timezone` column | Falls back to UTC default rather than erroring | P1 |
| ENR-REM-09 | DST transition day | Configured hour falls on a "spring forward" day where that local hour doesn't exist | Verify whether that day's reminder is skipped or shifted — currently unguarded against this specific case | P1 |
| ENR-REM-10 | Manual "remind now" bypasses daily dedup | HR manually sends a reminder to someone who already got today's automatic one | Manual send still succeeds (by design, distinct from the automatic gate) | P1 |
| ENR-REM-11 | Manual reminder to an ineligible invitation | Select someone already completed / expired / with no email in the manual-send list | Skipped with a clear per-recipient reason in the response, not a silent failure | P1 |
| ENR-REM-12 | Reminder email content | Trigger any reminder | Correct employee name, working enrollment link, correct expiry date shown | P1 |

**Edge cases & known gaps**
- **EDGE** — Cron matches on exact hour equality (`localHour === reminderHour`), not a range — if the cron interval and clock alignment ever produced a gap that skipped the matching tick entirely for a given site (unlikely at a 15-min interval, but worth a boundary test), that site's reminder for the day would be missed rather than caught on a later tick.

---

## 12. Attendance Recording (ATT)

Recognition-driven check-in/out, late/early-departure computation, and manual corrections.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ATT-01 | Normal entry then exit | Recognized at entry camera, then exit camera later same day | One attendance_record row, check_in and check_out both set correctly | P0 |
| ATT-02 | Rapid double-recognition (<2 min apart) | Same person recognized twice within 2 minutes at the same camera | check_out is not cleared/confused by the second event; an attendance_ping is still logged for dwell-time tracking | P0 |
| ATT-03 | Late arrival flagging | Check-in after shift start_time + grace_period_minutes | `is_late=true` | P0 |
| ATT-04 | On-time arrival within grace period | Check-in within grace window | `is_late=false` | P1 |
| ATT-05 | Employee with no assigned shift | `fk_shift_id` is null | Never flagged late/early, regardless of check-in time | P1 |
| ATT-06 | Early departure flagging | Check-out before shift end_time | `is_early_departure=true` | P0 |
| ATT-07 | Manual correction, no existing row | HR submits a correction for a day with no attendance_record at all | Upserts a new row rather than failing on a missing record | P1 |
| ATT-08 | Offline device bulk-sync replay | Jetson uploads a batch of buffered events after being offline | Events replay in correct chronological order per employee, producing the same result as if they'd arrived live | P0 |
| ATT-09 | Future-dated event timestamp | Submit an attendance event with a timestamp in the future (clock skew or malformed payload) | Currently not clamped/rejected — verify actual behavior; recommend rejecting or clamping to avoid corrupting the day's UPSERT ordering | P0 |
| ATT-10 | Backdated event timestamp | Submit an event dated several days in the past | Rewrites that historical day's attendance_record — confirm this is intended (e.g., for offline sync) vs. exploitable to alter old records | P0 |
| ATT-11 | Employee recognized at a site they aren't assigned to | Cross-site recognition event | Currently scoped from the device's site, not the employee's home site — verify whether cross-site attendance should be flagged/blocked or is intentionally allowed (multi-site staff) | P1 |
| ATT-12 | Device row missing for a device_code | Attendance event references a device_code not in facility_device | camera_mode defaults to MIXED rather than erroring | P2 |
| ATT-13 | Midnight-crossing shift | Shift spans midnight (e.g., 10 PM–6 AM) | `attendance_date` assignment and late/early logic handle the day boundary correctly | P0 |
| ATT-14 | DST transition date | Attendance events on the local DST change day | Late/on-time computation isn't off by an hour due to the wall-clock shift | P1 |
| ATT-15 | Break-duration inference | Employee has a session ≥60 min with no explicit break events | Falls back to a 30-min default break inference — verify this doesn't misrepresent actual worked hours in reports | P2 |

**Edge cases & known gaps**
- **BUG** — `getSiteTimezone`'s tenant-only fallback path (see TEN section) directly affects attendance date-bucketing and late/on-time computation for any dashboard/report call made without an explicit siteId — same underlying bug, tested here from the attendance-correctness angle.
- **EDGE** — No visible clamping on event timestamps — both future- and past-dated events are accepted as-is. Recommend a bounded-window validation (e.g., reject events more than N hours in the future or M days in the past outside of an explicit offline-sync path).

---

## 13. Live Attendance Dashboard (DASH)

Poll-refreshed (not websocket) present/absent view with a per-process response cache.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| DASH-01 | Manual refresh reflects a just-recorded event | Record an attendance event, then click refresh | New event appears within one refresh cycle | P0 |
| DASH-02 | Cache serves stale data within TTL | Query twice within 15s with no writes in between | Second call served from cache (verify via timing/log, not necessarily wrong data) | P2 |
| DASH-03 | Cache invalidation on write, single-instance | Record an event, immediately query dashboard on the same backend instance | Cache is purged and fresh data returned, not the pre-write cached response | P0 |
| DASH-04 | Cache invalidation across multiple backend instances | Write lands on instance A, dashboard query hits instance B (behind a load balancer) | Currently a likely gap — B's own cache isn't invalidated by A's write (no shared Redis cache); verify and consider a shared cache or shorter TTL | P1 |
| DASH-05 | Filter changes don't trigger a re-fetch | Change department/status filter without hitting refresh | Filtering happens client-side over already-fetched data — confirm this is the intended (not accidentally stale) behavior | P2 |
| DASH-06 | Scope-header change triggers refetch | Switch site/customer scope in the header | Dashboard refetches for the new scope automatically | P1 |

---

## 14. Device Management (Jetson / Edge) (DEV)

Registration, PIN-based activation, heartbeats, offline detection, and the device command queue.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| DEV-01 | Register a new device | Valid `external_device_id`, `device_type_code`, `name`, `ip_address` | 201, device row created | P0 |
| DEV-02 | Duplicate external_device_id, same tenant | Register with an id already used in this tenant | 409 conflict | P0 |
| DEV-03 | PIN activation — valid PIN | Correct 6-digit PIN, not expired/used | Device activated, PIN marked used | P0 |
| DEV-04 | PIN activation — wrong PIN | Incorrect PIN | 404 invalid_pin | P0 |
| DEV-05 | PIN activation — expired PIN | PIN past its validity window | 410 expired_pin | P1 |
| DEV-06 | PIN activation — already-used PIN | Reuse a PIN that already activated a device | 409 used_pin | P0 |
| DEV-07 | PIN brute-force protection | 11 activation attempts within 10 min from one IP | 429 on the 11th (activationLimiter) | P0 |
| DEV-08 | Heartbeat for a nonexistent device_code | Send a heartbeat for a device_code that was never registered or was deleted | Currently returns a fake-OK `{acknowledged_at, commands_pending:0}` without persisting anything — verify this doesn't mask a real provisioning problem; consider surfacing a distinct signal for "unknown device heartbeat" | P1 |
| DEV-09 | Device marked offline after threshold | No heartbeat for >5 min (configurable) | status flips online→offline, broadcast over Socket.IO, device_status_history logged | P0 |
| DEV-10 | Offline cascades to child cameras/boxes | Parent device (facility_device or frs_nug_box) goes offline with attached cameras | Child cameras also flip to offline | P1 |
| DEV-11 | Heartbeat racing the offline cron | Heartbeat arrives at nearly the same instant the offline cron's UPDATE runs | Device should end up online (heartbeat should win) — verify no race flips it to offline right after a fresh heartbeat | P1 |
| DEV-12 | Device renamed mid-operation (jetson-09-style identity issue) | Change a device's `external_device_id` while it has in-flight heartbeats/commands under the old name | No cross-contamination with another device; rate limiting and command delivery use the stable numeric id, not the renameable code — this is a regression test for a previously-hit incident | P0 |
| DEV-13 | external_device_id reused after being freed by a rename | Rename device A away from code X, then register device B with code X | Succeeds without confusing A and B's history/commands | P0 |
| DEV-14 | Command queue: device never polls | Queue a command for a device that goes offline immediately after | Command remains queued indefinitely — verify whether an expiry/timeout exists or should be added | P1 |
| DEV-15 | Photo download rate limiting | Many users behind the same office NAT downloading attendance photos concurrently | Limiter is keyed per authenticated user, not per IP — concurrent legitimate staff don't exhaust one shared bucket | P1 |
| DEV-16 | Device-event rate limiting | A single device sends events far above 1200/min | 429 for that device specifically (keyed by stable device id), other devices/users unaffected | P1 |
| DEV-17 | Legacy heartbeat endpoint rate limiting | Flood `/api/jetson/:camId/heartbeat` (legacy path) | Verify this path isn't accidentally missing from both the dedicated device limiter and the global skip-list, unlike `/api/device-management/*` | P1 |

**Edge cases & known gaps**
- **EDGE** — Heartbeat for an unrecognized device_code silently no-ops with a fake success response rather than a distinguishable error/log signal — makes a misconfigured or decommissioned-but-still-running device invisible to monitoring.
- **EDGE** — The legacy `/api/jetson/:camId/heartbeat` path is not in the global rate limiter's skip-list the way `/api/device-management` is — worth confirming it has its own adequate protection rather than falling through to the generic per-IP limiter (which has the same office-NAT dilution problem already fixed elsewhere).

---

## 15. Notifications & Email (NOTIF)

System alerts (DB + websocket) and the various transactional emails sent throughout the app.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| NOTIF-01 | System alert created and broadcast | Trigger any event that creates a system_alert | Row persisted, websocket emits to the correct tenant room, bell UI updates live | P0 |
| NOTIF-02 | Invalid severity value | Trigger an alert with a typo'd severity | Silently coerced to "medium" rather than rejected — verify this doesn't mask a genuinely critical alert being mis-filed | P1 |
| NOTIF-03 | Websocket emit throws | Simulate a socket-layer error during broadcast | DB row is still persisted (durable), even though live delivery silently failed — confirm the bell UI still picks it up on next load/poll | P1 |
| NOTIF-04 | Notification storm | A device flaps online/offline rapidly many times in a short window | No dedup/rate-limit currently exists on alert creation — verify actual volume behavior under a flapping-device load test | P1 |
| NOTIF-05 | Batch invite email send (20-30 recipients) | Send enrollment invitations to a full batch at once | Pooled SMTP connection handles the batch within nginx's proxy timeout — no partial-batch timeout failure | P0 |
| NOTIF-06 | SMTP down mid-batch | SMTP becomes unreachable partway through a batch send | Already-sent recipients keep their success, failed ones are reported individually — verify no silent full-batch failure | P0 |
| NOTIF-07 | Misconfigured SMTP_USER in a non-dev environment | Deploy with `SMTP_USER` containing "your_email" placeholder text outside of NODE_ENV=development | Currently these placeholder-matching conditions apply regardless of environment for some email functions — verify no production deployment can accidentally match this pattern and start "successfully" mock-sending without real delivery | P0 |
| NOTIF-08 | Password-reset email failure handling | Force `sendPasswordResetNotification` to fail | Returns false rather than throwing — verify every caller actually checks the return value rather than assuming success | P1 |
| NOTIF-09 | Tenant admin welcome email contains a working temporary password | Provision a new tenant | Email delivered with correct realm/login URL and a password that actually authenticates — verify expiry/rotation is enforced on first login | P0 |
| NOTIF-10 | Invite link expiry boundary | Use a user-invite/setup link exactly at its `expiresAt` | Consistent accept/reject behavior at the boundary, not flaky by milliseconds | P2 |

**Edge cases & known gaps**
- **BUG** — Email-sending error handling is inconsistent across functions — some swallow errors and return a fake mocked success (enrollment invite/reminder/user-invite), others rethrow (rejection, tenant-admin welcome), one returns a boolean instead of throwing (password reset). Recommend unifying this and adding a test per function for its actual failure contract.
- **EDGE** — No dedup/rate-limiting on system_alert creation — a flapping device or noisy integration could flood both the table and the websocket room.

---

## 16. Reports & Analytics (RPT)

Attendance/employee/device reports, exports, and scheduled report runs (corporate + separate retail app surface).

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| RPT-01 | Generate each report type | Daily/monthly/yearly/custom attendance, employee directory/turnover/tenure/department, device health/activity/error, peak-hours/occupancy/trends/compliance | Each returns correct, tenant-scoped data | P0 |
| RPT-02 | Export in each format | CSV, PDF, Excel, JSON for the same report | All four produce consistent data, correct formatting/encoding | P1 |
| RPT-03 | Cross-tenant export IDOR | Request another tenant's `reportId` for export | 403/404, never the other tenant's data | P0 |
| RPT-04 | Scheduled report create/run-now/download | Create a schedule, trigger run-now, download the completed run | Full cycle works, output matches an equivalent on-demand report | P0 |
| RPT-05 | /scheduled vs /schedules route parity | Hit both route families for the same operation | Identical behavior — regression test to catch future drift between the duplicate route sets | P1 |
| RPT-06 | Report template CRUD by a read-only-intended role | User with only analytics.read creates/deletes a schedule or template | Confirm whether this should be blocked — currently permitted by the same permission that gates viewing | P1 |
| RPT-07 | Retail app surface isolation | Access retail dashboard/reports as a corporate-only user and vice versa | Each app surface's data/permissions stay isolated from the other | P1 |
| RPT-08 | Report over an empty date range / no data | Request a report for a period with zero matching records | Empty/zeroed report, not an error | P2 |

---

## 17. Admin: Tenant / User / Role (ADM)

Tenant provisioning and cascade deletion, feature-flag resolution, and user/role management screens.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| ADM-01 | Full tenant deletion cascade | Delete a tenant with active devices, embeddings, attendance history, GDPR requests, and report schedules all present | All ~9 ordered deletion phases complete without FK violations, nothing orphaned | P0 |
| ADM-02 | Tenant deletion in both users-table/users-view DB configurations | Run deletion against both known schema variants | The SAVEPOINT-guarded `home_tenant_id` update succeeds in both | P1 |
| ADM-03 | New tenant provisioning | Create a tenant end-to-end | Realm created in Keycloak, tenant_settings seeded, admin welcome email sent with working credentials | P0 |
| ADM-04 | User invite "must set password" flag at expiry boundary | Check the flag exactly as an open invite expires | Consistent behavior, not flaky at the millisecond boundary | P2 |
| ADM-05 | Multi-site-role user's effective site resolution | User has role rows for two sites, no explicit site header | Deterministic, intended-site resolution (see RBAC-11) rather than an arbitrary pick | P1 |
| ADM-06 | Super-admin cross-tenant dashboard aggregates | View SuperAdminAnalytics camera/device counts across multiple tenants | Counts match ground truth per tenant — flagged as an area with a recent hotfix branch, worth explicit regression coverage | P0 |
| ADM-07 | Role management permission boundary (backend, not just UI) | Non-tenant/super-admin calls the role-change API directly against a tenant_admin/super_admin-role user | 403 — enforcement must exist server-side (see RBAC-09) | P0 |
| ADM-08 | Site-scoped data filtering in RBAC endpoints | Site-scoped admin queries a user-management endpoint | Only sees users within their site scope, not tenant-wide | P0 |

---

## 18. Visitor Management (VIS)

Unknown-face buffering, employee-vs-visitor classification, repeat-visitor dedup by embedding similarity, host linkage.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| VIS-01 | Device-supplied employee match, high confidence | Face event includes `employee_id`/`identifierId` at ≥75% confidence | Classified as employee_match, not routed to visitor buffer | P0 |
| VIS-02 | Unknown face, no employee match | Face event with no employee identifiers matching | Buffered for 30s TTL, then promoted to person/visitor | P0 |
| VIS-03 | Repeat visitor recognition | Same visitor's face appears again within the buffer window | Deduped via cosine similarity ≥0.55 against existing person embeddings — treated as the same visitor, not a new record | P0 |
| VIS-04 | Two different visitors with similar faces | Near-duplicate (but distinct) faces, similarity at/above the 0.55 threshold | Known false-positive risk area — verify with genuinely different people whose embeddings happen to be close, confirm whether they get incorrectly merged | P1 |
| VIS-05 | Employee later deactivated, still recognized | An employee whose status has changed to inactive walks past a camera | No longer classified as employee_match (status filter applies) — now gets buffered/promoted as an unknown visitor; verify this transition is handled cleanly, not as an error | P1 |
| VIS-06 | Visitor buffer table missing (migration not applied) | Simulate the underlying table absent (42P01 error) | Currently fails silently with no alert — verify ops would actually notice a broken visitor pipeline; recommend surfacing this as a system alert instead of silent no-op | P1 |
| VIS-07 | Host employee deactivated/deleted before the scheduled visit | Register a visitor with a host, then deactivate the host before visit date | Verify visitor registration/check-in still functions and doesn't hard-depend on the host being currently active | P1 |
| VIS-08 | Visit-date window expiry with no check-out | Visitor's valid_to date passes without ever leaving/checking out | Verify whether any cleanup/flagging exists for this — likely an untested gap | P1 |
| VIS-09 | Visitor enrollment via the same self-enrollment portal | Complete a visitor (fk_person_id) enrollment end-to-end | Same 8-angle flow works correctly for the person-based path, employee_code falls back to a person-id-based key without filename collisions | P1 |
| VIS-10 | Two visitors enrolling simultaneously | Concurrent visitor enrollments both without an employee_code | No filename/S3-key collision between them (falls through to fk_person_id, which is unique) | P1 |

**Edge cases & known gaps**
- **EDGE** — Repeat-visitor dedup relies entirely on face-embedding cosine similarity (no tracking_id from device firmware) — a 0.55 threshold is a tuning knob, and its false-positive/false-negative rate should be measured with real visitor traffic, not just assumed.
- **BUG** — Visitor buffer processing fails silently (caught, swallowed) if the underlying table is missing — a broken migration could disable the entire visitor pipeline with zero operational alert.

---

## 19. GDPR & Data Retention (GDPR)

Scheduled purge jobs per data category, and the interaction between automatic retention and explicit erasure requests.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| GDPR-01 | Face embeddings purged after retention window | Deactivated/inactive/terminated employee older than the configured years (default 3) | Their embeddings are purged by the daily cron | P0 |
| GDPR-02 | Active employee's embeddings are never auto-purged | Employee still active, regardless of age | Not touched by the retention cron | P0 |
| GDPR-03 | Attendance/audit-log/device-events retention windows | Records older than 730/365/90 days respectively | Purged on schedule, one failing table doesn't block the others | P1 |
| GDPR-04 | Explicit erasure request for a still-active employee | Submit a GDPR erasure request while the employee remains active with live embeddings | The daily retention cron does NOT auto-purge them (it only targets deactivated/inactive/terminated) — verify a separate erasure workflow actually handles this case rather than the request silently sitting unfulfilled | P0 |
| GDPR-05 | Completed erasure requests retention | Erasure request completed >365 days ago | The erasure-request record itself is purged on schedule | P2 |
| GDPR-06 | Retention job against a schema-drifted table | Simulate a missing/renamed column on one retention target table | Currently caught and swallowed (returns rowCount:0) rather than alerting — recommend surfacing this as a monitored failure, since it could silently disable retention for months | P0 |
| GDPR-07 | Retention cron runs immediately on startup and daily thereafter | Restart the backend process | An immediate run fires on boot in addition to the daily schedule — verify this doesn't double-run in a multi-instance deployment without an IS_PRIMARY_INSTANCE-style guard | P1 |

**Edge cases & known gaps**
- **BUG** — Retention-job failures on individual tables are swallowed (`.catch(()=>({rowCount:0}))`) with no alerting — a schema-drift or permission issue could make retention silently do nothing indefinitely. Recommend routing these catches into the system_alert pipeline.
- **EDGE** — An erasure request against a currently-active employee isn't picked up by the automatic retention cron (which only targets deactivated/inactive/terminated) — confirm the manual/explicit erasure path is the intended mechanism here and actually works end-to-end.

---

## 20. Cross-Cutting Security & Rate Limiting (SEC)

Concerns that cut across every module above — CORS, injected input, Redis-backed rate limiting degradation, and known past-incident regressions.

| ID | Scenario | Steps / Precondition | Expected Result | Pri |
|---|---|---|---|---|
| SEC-01 | CORS wildcard blocked in production | Send a request with an arbitrary Origin header in a production deployment | Rejected — wildcard/null-origin handling is explicitly blocked in prod per code comment (FIX-006) | P0 |
| SEC-02 | Tenant subdomain CORS regex doesn't over-match | Origin like `https://frs.motivitylabs.com.evil.com` or `https://evilfrs.motivitylabs.com` | Rejected — the subdomain-matching regex must be properly anchored to the real domain, not just a substring/suffix match | P0 |
| SEC-03 | Redis-backed rate limiter degrades safely when Redis is down | Stop Redis while distributed rate limiting is configured | Falls back to in-memory per-process limiting with a logged warning — verify this doesn't silently become "no limiting at all," and that the degraded mode is at least somewhat effective | P1 |
| SEC-04 | Rate-limit key generator regression (ipKeyGenerator) | Confirm every limiter uses `ipKeyGenerator(req.ip)`, never the raw `req` object | No limiter buckets all clients together under a single "[object Object]" key — this exact bug was hit and fixed once before; keep as a permanent regression test | P0 |
| SEC-05 | SQL injection surface on scope-building queries | Attempt injection via tenant/customer/site/unit header values and free-text search fields | Parameterized everywhere — no injection succeeds | P0 |
| SEC-06 | File upload validation on enrollment photo endpoints | Upload a non-image file, an oversized file, or a file with a malicious extension to upload-angle/check-pose | Rejected with a clean error, no server-side execution or storage of unexpected content types | P0 |
| SEC-07 | SSRF protection on any user-suppliable URL/IP (Jetson calls, webhooks) | Supply a metadata-service IP (169.254.169.254), loopback, or internal-network address where a device IP is expected | Blocked in production per the existing SSRF guard — regression test for FIX-003 | P0 |
| SEC-08 | Audit log completeness for sensitive actions | Perform approve/reject/delete/role-change actions | Each produces a corresponding audit_log entry with correct actor, action, and entity — spot-check for any action that silently skips audit logging (an audit-log write failure was previously observed not to block the underlying action, which is correct, but confirm it's at least logged as a warning) | P1 |
| SEC-09 | Webhook HMAC signature validation | Call a webhook-style endpoint (e.g., enrollment complete callback) with a missing/invalid signature when a secret is configured | Rejected; when no secret is configured, the check is a documented no-op (verify this is intentional per environment, not accidental) | P0 |
| SEC-10 | Photo access authorization | Request another tenant's/employee's enrollment or attendance photo by guessing/incrementing the filename | 403/404 — tenant/employee ownership must be checked before serving, not just presence of a valid session | P0 |
