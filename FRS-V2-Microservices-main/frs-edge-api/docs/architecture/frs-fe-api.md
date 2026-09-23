# Architecture Shard: frs-fe-api (Frontend Business Service)

> Applies to: `frs-fe-api/**`
> Port: `8080` | Entry: `frs-fe-api/src/server.js` | Stack: Node.js (ESM), Express, PostgreSQL, Redis, Socket.IO

## Depends on / Used by
- **Used by:** `frs-web-ui` (via Vite proxy `:8080` for all business endpoints `/api/*`, `/api/me/manifest`, `/api/me/preferences`, and Socket.IO `/socket.io/`)
- **Calls:** `face-quality` (`http://localhost:5050/score` for enrollment face quality check)
- **Depends on:** Keycloak (token verification via JWKS), PostgreSQL (business domain tables), Redis (Socket.IO adapter & pub/sub)

## Responsibilities & Boundaries
`frs-fe-api` serves all end-user UI business requirements:
1. **Employees:** CRUD, departments, face registration, image upload (`/api/employees/*`)
2. **Visitors:** Visitor pre-registration, passes, check-in/out, face logs (`/api/visitors/*`)
3. **Attendance:** Daily attendance logs, shift definitions, manual overrides, CSV/Excel export (`/api/attendance/*`)
4. **Cameras & Sites:** Camera registration, RTSP configs, RTSP stream URLs, site grouping (`/api/cameras/*`, `/api/sites/*`)
5. **Analytics & Reports:** Aggregated recognition stats, demographic analytics, heatmaps (`/api/analytics/*`)
6. **Notifications & WebSocket:** Real-time recognition event broadcasting via Socket.IO rooms
7. **UI Manifest & Preferences:** Client navigation manifest (`/api/me/manifest`) and user preferences (`/api/me/preferences`)

> [!IMPORTANT]
> `frs-fe-api` does NOT handle Jetson direct enrollment (`POST /api/employees/:id/enroll-face-direct`) or camera raw frame ingest (`POST /api/frames/*`). Those belong strictly to `frs-edge-api`.

## Key Files & Entry Points
- Server entry: `frs-fe-api/src/server.js:1`
- Express app config: `frs-fe-api/src/app.js:1`
- Route index: `frs-fe-api/src/routes/index.js:1`
- Employee routes: `frs-fe-api/src/routes/employeeRoutes.js:1`
- Visitor routes: `frs-fe-api/src/routes/visitorRoutes.js:1`
- Attendance routes: `frs-fe-api/src/routes/attendanceRoutes.js:1`
- Camera routes: `frs-fe-api/src/routes/cameraRoutes.js:1`
- UI Manifest controller: `frs-fe-api/src/controllers/manifestController.js:1`
- WebSocket hub: `frs-fe-api/src/websocket/socketServer.js:1`
- Face quality integration: `frs-fe-api/src/services/faceQualityClient.js:1`

## Tests & Quality Gates
- Test command: `cd frs-fe-api && npm test` (`node --test src/tests/*.test.js`)
