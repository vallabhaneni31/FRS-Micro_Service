# frs-fe-api — Frontend Business API Service

> Service in the FRS Microservices Estate.
> Port: 8080 | Default Branch: `develop` | Bugfix Branch: `allbugfix`
> Architecture Shard: `../docs/architecture/frs-fe-api.md`

## Knowledge Layer & Specs
This service contains in-repo docs and specs for team collaboration, synchronized with the estate root:
- **Service Memory & Agreement:** `CLAUDE.md`
- **Architecture Router:** `docs/ARCHITECTURE.md` (Shard: `docs/architecture/frs-fe-api.md`)
- **House Coding Patterns:** `docs/PATTERNS.md`
- **Cross-Service Contract Index:** `docs/ESTATE.md`
- **Bug-Fix Workflow:** `docs/BUGFIX_WORKFLOW.md`
- **Active Specs:** `specs/` (e.g., `specs/0002-prune-duplicate-and-unwanted-codebase/`)

## Service Stack & Commands
- **Stack:** Node.js (ES Modules), Express 4.21, PostgreSQL, Redis, Socket.IO
- **Start:** `npm run dev` (`nodemon src/server.js`) or `npm start`
- **Test:** `npm test` (`node --test src/tests/*.test.js`)
- **OpenAPI:** `npm run generate-openapi`

## Scope & Boundaries
- Owns all user-facing business endpoints: Employees, Visitors, Attendance, Cameras, Sites, Analytics, Notifications, UI Manifest (`/api/me/manifest`), UI Preferences (`/api/me/preferences`), Socket.IO hub.
- Does NOT own IAM (`/api/auth/*`, `/api/me/bootstrap` belong to `:8082` `frs-core-api`).
- Does NOT own Jetson device endpoints (`POST /api/employees/:id/enroll-face-direct` and camera heartbeats belong to `:8081` `frs-edge-api`).
