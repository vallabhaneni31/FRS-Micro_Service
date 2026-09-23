## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Estate Role & Shared Knowledge Layer

> Service in the FRS Microservices Estate (`frs-web-ui`).
> Port: 5173 | Default Branch: `develop2` | Bugfix Branch: `allbugfix`
> Architecture Shard: `../docs/architecture/frs-web-ui.md`

This frontend SPA is part of the multi-service estate rooted at `../`.
- **Estate Memory & Working Agreement:** `../CLAUDE.md`
- **Estate Architecture Router:** `../docs/ARCHITECTURE.md`
- **House Coding Patterns:** `../docs/PATTERNS.md`
- **Cross-Service Contract Index:** `../docs/ESTATE.md`
- **Bug-Fix Workflow:** `../docs/BUGFIX_WORKFLOW.md`
- **Active Specs:** `../specs/` (e.g. `../specs/0002-prune-duplicate-and-unwanted-codebase/`)

## Service Stack & Commands
- **Stack:** React 18, TypeScript 5.9, Vite 6, TailwindCSS 4, Radix UI
- **Start Dev Server:** `npm run dev` (`vite --force` on port 5173)
- **Build:** `npm run build`
- **Test:** `npm test` (`vitest run`)
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`)

## Proxy Routing
Configured in `vite.config.ts`:
- `/api/auth`, `/api/me/bootstrap`, `/api/users`, `/api/admin/rbac`, `/api/internal` → `http://localhost:8082` (`frs-core-api`)
- `/api/*` (all other endpoints) & `/socket.io` → `http://localhost:8080` (`frs-fe-api`)
