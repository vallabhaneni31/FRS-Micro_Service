# Architecture Shard: frs-web-ui (React Single Page Application)

> Applies to: `frs-web-ui/**`
> Port: `5173` (Vite Dev Server) | Entry: `frs-web-ui/src/main.tsx` | Stack: React 18, TypeScript, Vite, TailwindCSS

## Depends on / Used by
- **Used by:** End-user desktop and mobile browsers
- **Proxies to:**
  - `http://localhost:8082` (frs-core-api / IAM): `/api/auth`, `/api/me/bootstrap`, `/api/users`, `/api/admin/rbac`, `/api/internal`
  - `http://localhost:8080` (frs-fe-api / Business): `/api/*` (all other routes), `/socket.io`

## Responsibilities & Boundaries
`frs-web-ui` provides the user interface for administrative staff, operators, and HR managers:
1. **Authentication Flows:** Login, MFA challenge, password reset dialogs, session renewal
2. **Dashboard & Monitoring:** Real-time camera feeds, recognition alert toasts via Socket.IO, live activity feed
3. **Personnel Management:** Employee directory, photo face enrollment (Mediapipe web-based quality scoring), visitor logs
4. **Attendance Administration:** Time tracking table, punch overrides, holiday calendars, export reports
5. **System Settings:** Site config, camera RTSP URLs, edge box status, RBAC permissions matrix

## Key Files & Entry Points
- Dev proxy config: `frs-web-ui/vite.config.ts:1`
- Main entry: `frs-web-ui/src/main.tsx:1`
- Application router: `frs-web-ui/src/App.tsx:1`
- Auth context & state: `frs-web-ui/src/context/AuthContext.tsx:1`
- API client wrapper: `frs-web-ui/src/lib/api.ts:1`
- Socket client hook: `frs-web-ui/src/hooks/useSocket.ts:1`

## Tests & Quality Gates
- Test command: `cd frs-web-ui && npm test` (`vitest run`)
- Typecheck command: `cd frs-web-ui && npm run typecheck` (`tsc --noEmit`)
- Build command: `cd frs-web-ui && npm run build` (`vite build`)
