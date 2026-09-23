# frs-web-ui

React 18 + TypeScript + Vite single-page app — the frontend for the Motivity Face Recognition
System (FRS). Serves four verticals (corporate, education, retail, transport) from one deployable
app, with which vertical/pages a signed-in user sees decided by a server-driven manifest rather
than by URL. Talks to the `frs-core-api` backend over REST and a Socket.IO websocket.

This repo used to live at `frontend/` inside a combined monorepo with the backend; it now
deploys independently, with its own `package.json`, lockfile, and CI pipeline.

## Getting started

```bash
npm install
cp .env.example .env   # fill in VITE_API_BASE_URL / VITE_KEYCLOAK_* for your environment
npm run dev             # starts the Vite dev server on :5173
```

The dev server proxies `/api`, `/socket.io`, and `/uploads` to `http://localhost:8080` by default
(see `vite.config.ts`) — run `frs-core-api`'s backend locally, or point `VITE_API_BASE_URL` at a
shared environment.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (`predev` syncs MediaPipe assets first) |
| `npm run build` | Production build → `dist/` (`prebuild` syncs MediaPipe assets first) |
| `npm test` | Runs the Vitest suite (`vitest run`) |
| `npm run typecheck` | `tsc --noEmit` |

There is currently no lint script/config in this repo, and no e2e/Playwright/Cypress suite.

## Configuration

All configuration is `VITE_*` environment variables read at build/runtime — see `.env.example`
for the full list (API base URL, websocket URL, Keycloak realm/client, auth mode). Nothing
environment-specific is hardcoded.

## Project structure

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full map — in short:

```
src/
  main.tsx                # entry point (src/app/App.tsx is a dead-code shim, not the real entry)
  app/
    router.tsx              # routes + provider tree
    components/
      verticals/{corporate,education,retail,transport}/   # the four verticals
      platform/              # cross-tenant super-admin tooling
      shared/, ui/            # cross-vertical chrome + design-system primitives
    hooks/, services/, contexts/, engine/
```

Which vertical/pages a user sees is decided by `GET /me/manifest` from the backend, mapped to
lazily-loaded pages in `DashboardRenderer.tsx`'s `PAGE_REGISTRY` — not by URL routing.

## Documentation

This repo's Claude knowledge layer (also useful for a human skimming the codebase):
- [`CLAUDE.md`](CLAUDE.md) — quick orientation: stack, commands, working agreement
- [`docs/PATTERNS.md`](docs/PATTERNS.md) — house style: naming, layering, testing, known anti-patterns
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — structural map, data flow, cross-cutting concerns
- [`docs/ESTATE.md`](docs/ESTATE.md) — the contract between this repo and `frs-core-api` (routes called, websocket, shared types)
- [`specs/`](specs/README.md) — spec-driven development process for non-trivial changes

## Related repos

- `frs-core-api` — the backend (Node/Express + Java/Spring services) this app talks to.
