# Architecture Shard: frs-core-api (IAM Service)

> Applies to: `frs-core-api/**`
> Port: `8082` | Entry: `frs-core-api/backend/api/src/server.js` | Stack: Node.js (ESM), Express, PostgreSQL, Redis

## Depends on / Used by
- **Used by:** `frs-web-ui` (via Vite proxy `:8082` for `/api/auth`, `/api/me/bootstrap`, `/api/users`, `/api/admin/rbac`, `/api/internal`)
- **Depends on:** Keycloak (OIDC provider/realm), PostgreSQL (user accounts, roles, permissions), Redis (rate limiting & token blacklist)

## Responsibilities & Boundaries
`frs-core-api` (tracked as `frs-iam-api` on remote git) is strictly scoped to Identity and Access Management:
1. **Authentication & Session:** `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/mfa/*`
2. **Session Bootstrap:** `GET /api/me/bootstrap` (returns user identity, role, permissions, active site, and Keycloak profile)
3. **User Management:** `/api/users/*` (CRUD operations on user accounts, password reset, site assignments)
4. **RBAC Administration:** `/api/admin/rbac/*` (roles, permissions, role assignments)
5. **Internal Provisioning:** `/api/internal/*` (Keycloak synchronization, system health, invite validation)

> [!NOTE]
> All business domain logic (Employees, Visitors, Attendance, Cameras, UI manifest) has been decoupled into `frs-fe-api`.

## Key Files & Entry Points
- Server entry: `frs-core-api/backend/api/src/server.js:1`
- Express app config: `frs-core-api/backend/api/src/app.js:1`
- Auth routes: `frs-core-api/backend/api/src/routes/authRoutes.js:1`
- User routes: `frs-core-api/backend/api/src/routes/userRoutes.js:1`
- RBAC routes: `frs-core-api/backend/api/src/routes/rbacRoutes.js:1`
- Bootstrap controller: `frs-core-api/backend/api/src/controllers/meController.js:1`
- DB pool: `frs-core-api/backend/api/src/config/db.js:1`
- Keycloak adapter: `frs-core-api/backend/api/src/services/keycloakService.js:1`

## Tests & Quality Gates
- Test command: `cd frs-core-api/backend/api && npm test` (`node --test src/tests/*.test.js`)
