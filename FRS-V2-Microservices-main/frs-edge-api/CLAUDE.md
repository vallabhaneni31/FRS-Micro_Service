# frs-edge-api — Edge Box & Device Ingest Service

> Service in the FRS Microservices Estate.
> Port: 8081 | Default Branch: `develop` | Bugfix Branch: `allbugfix`
> Architecture Shard: `../docs/architecture/frs-edge-api.md`

## Knowledge Layer & Specs
This service contains in-repo docs and specs for team collaboration, synchronized with the estate root:
- **Service Memory & Agreement:** `CLAUDE.md`
- **Architecture Router:** `docs/ARCHITECTURE.md` (Shard: `docs/architecture/frs-edge-api.md`)
- **House Coding Patterns:** `docs/PATTERNS.md`
- **Cross-Service Contract Index:** `docs/ESTATE.md`
- **Bug-Fix Workflow:** `docs/BUGFIX_WORKFLOW.md`
- **Active Specs:** `specs/` (e.g., `specs/0002-prune-duplicate-and-unwanted-codebase/`)

## Service Stack & Commands
- **Stack:** Node.js (ES Modules), Express 4.21, PostgreSQL, Redis
- **Start:** `npm run dev` (`nodemon src/server.js`) or `npm start`
- **Test:** `npm test` (`node --test src/tests/*.test.js`)

## Scope & Boundaries
- Owns all edge-device and camera-facing endpoints:
  - Device auth (`authenticateDevice` middleware, `req.device.pk_device_id`)
  - Direct 512-d ArcFace vector enrollment (`POST /api/employees/:employeeId/enroll-face-direct`)
  - Device registration, heartbeats, sync (`/api/devices/*`, `/api/cameras/*`, `/api/device-management/*`)
  - Edge recognition logs & attendance ingest (`/api/attendance/*`, `/api/events/*`)
  - Retail device ingest (`/api/v1/retail/devices/*`)
- Does NOT own user/browser sessions or IAM.
