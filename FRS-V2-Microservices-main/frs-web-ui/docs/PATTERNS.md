# FRS Microservices Estate — Code Patterns & Conventions

> Learned from the active codebase by `/edith-init`. This is the agent's "house style" memory:
> how THIS workspace actually writes code, so new code matches what's already here.
> Token budget: ~200 lines. Cite `file:line` — do not paste code blocks.

## Stack Snapshot
- **Backend Services:** Node.js (v20+, ES Modules `"type": "module"`), Express 4.21, PostgreSQL (`pg` pool / Sequelize), Redis (ioredis), Socket.IO
- **Frontend App:** React 18, TypeScript 5.9, Vite 6, TailwindCSS 4, Radix UI, Sonner, Vitest
- **Auxiliary/Sidecars:** Python 3 (Flask, Mediapipe, ONNX) on :5050; Java 17 Spring Boot Maven on :4002
- **Testing:** `node --test` for Node.js backends; Vitest for React frontend

## Directory Layout (Per-Service Convention)
```
frs-core-api/backend/api/src/
  routes/             # Express routers (authRoutes.js, meRoutes.js, userRoutes.js, rbacRoutes.js)
  controllers/        # Route handlers (UserController.js)
  services/           # Core domain & external clients (keycloakService.js)
  middleware/         # authz.js, asyncHandler.js, rateLimiter.js
  config/             # db.js, env.js
frs-fe-api/src/
  routes/             # Business & retail routes (attendanceRoutes.js, employeeRoutes.js, manifestRoutes.js)
  controllers/        # Business controllers & validators
  services/           # Domain business logic & S3 storage
  websocket/          # Socket.IO connection manager & rooms
frs-edge-api/src/
  routes/             # Device ingest routes (jetsonRoutes.js, faceSyncRoutes.js, frameRoutes.js)
  middlewares/        # authDevice.js (HMAC/Bearer device authentication)
frs-web-ui/src/
  components/         # Radix UI primitives & domain widgets
  pages/              # Route view components
  hooks/              # Custom React hooks (useSocket.ts, useAuth.ts)
  lib/                # API client wrappers (api.ts)
```

## Naming Conventions
- **Files:** `camelCase.js` for Node modules (`meRoutes.js`, `authz.js`), `PascalCase.tsx` for React components (`Button.tsx`), `useCamelCase.ts` for React hooks (`useSocket.ts`).
- **Classes / Types:** `PascalCase` (`AppError`, `KeycloakService`, `UserDto`).
- **Functions / Methods / Variables:** `camelCase` (`authenticateDevice`, `calculateAttendance`).
- **Constants & Env Vars:** `SCREAMING_SNAKE_CASE` (`JWT_SECRET`, `KEYCLOAK_REALM`, `PORT`).
- **Tests:** `*.test.js` under `src/tests/` (backend) or `*.test.tsx` (frontend).
- Example: `frs-core-api/backend/api/src/routes/meRoutes.js:7`

## Layered Flow (Entry → Handler → Service → DB)
1. **Route definition:** Mounts HTTP verb + path + auth middleware (`frs-core-api/backend/api/src/routes/meRoutes.js:7-10`)
2. **Middleware:** Validates JWT / device token, attaches `req.auth` or `req.device` (`frs-core-api/backend/api/src/middleware/authz.js:20`)
3. **Controller / Handler:** Wrapped in `asyncHandler`, unpacks request parameters, delegates to service (`frs-core-api/backend/api/src/routes/meRoutes.js:10-24`)
4. **Data Access:** Queries PostgreSQL via parameterized SQL pool (`pg.query`) or Sequelize models (`frs-core-api/backend/api/src/config/db.js:15`)
5. **Response Envelope:** Returns JSON payload `{ success: true, data: ... }` or standard DTO (`frs-core-api/backend/api/src/routes/meRoutes.js:18-23`)

## Data Access & Transactions
- **Database Engine:** PostgreSQL.
- **Query Style:** Use parameterized queries (`$1, $2`) for all raw SQL to prevent injection (`frs-core-api/backend/api/src/config/db.js:35`).
- **Transactions:** Wrap multi-table mutations in `BEGIN ... COMMIT / ROLLBACK` using client from pool.
- **Migrations:** Managed in `migrations/` directories; never alter production columns directly.

## API / Interface Contracts
- **Auth Tokens:** Bearer JWT in `Authorization: Bearer <token>` header or `accessToken` cookie.
- **Edge Devices:** Device authentication via `x-device-id` and `x-device-token` headers (`frs-edge-api/src/middlewares/authDevice.js:1`).
- **Standard HTTP Codes:** `200` OK, `201` Created, `400` Bad Request (validation failure), `401` Unauthorized, `403` Forbidden, `404` Not Found, `409` Conflict, `500` Internal Error.

## Error Handling
- Use `AppError` subclassing standard `Error` with HTTP status code: `new AppError("Not found", 404)`.
- Wrap asynchronous route functions in `asyncHandler(fn)` to catch unhandled rejections automatically (`frs-core-api/backend/api/src/middleware/asyncHandler.js:1`).
- Central error middleware formats consistent JSON error responses: `{ success: false, error: message }`.

## Validation, Config & Secrets
- **Validation:** Request body and query params validated using `zod` or `joi` schemas before hitting business services (`frs-fe-api/package.json:33,50`).
- **Environment & Secrets:** Read via `process.env` backed by `dotenv` (`.env`); never commit `.env` or hardcode credentials (`up.sh:58-70`).

## Logging & Observability
- Backend structured logging via `winston` or standardized logger (`console.info`/`console.error` with timestamps and request IDs).
- Audit trails for user modifications recorded in PostgreSQL audit logs.

## Testing Patterns
- **Backend (Node.js):** Built-in test runner: `node --test src/tests/*.test.js`.
- **Frontend (React):** Vitest + Testing Library: `npm test` (`vitest run`).
- **Mocks:** Mock external HTTP calls (Keycloak, Face-Quality) using `node:test` mocking or manual stubs.

## Don'ts (Project-Specific Anti-Patterns)
- **Do NOT** cross-route IAM requests into `frs-fe-api` or business requests into `frs-core-api`.
- **Do NOT** put edge-box frame ingestion or direct ArcFace vector endpoints into `frs-fe-api` (keep them in `frs-edge-api`).
- **Do NOT** delete or modify `backend/api-transport` (Java Spring Boot module is preserved).
- **Do NOT** create new repositories; all services and sidecars belong to the 4 existing repositories.
- **Do NOT** commit hardcoded database credentials, Keycloak secrets, or AWS keys.
