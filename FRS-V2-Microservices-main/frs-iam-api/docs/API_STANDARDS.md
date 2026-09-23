# API standards (OpenAPI)

> Standard for `backend/api`'s HTTP contract and how it's documented. Written because
> `docs/PATTERNS.md` already flagged the response-envelope inconsistency as an anti-pattern —
> this is where "the standard to converge on," not just "what exists," lives.

## What already exists — don't reinvent it

`backend/api` has a **custom static OpenAPI generator**, not a library like `swagger-jsdoc`:
`backend/api/scripts/generate-openapi.js` parses every `router.get/post/put/patch/delete(...)`
call in `src/routes/*.js` plus the `app.use()` mount table in `server.js`, and writes
`backend/api/src/docs/openapi.generated.json` (OpenAPI 3.0.0). It's static analysis, not
introspection of a running app — deliberately, so it runs in CI without booting the server or a
database (see the file's header comment for why).

**Run `npm run generate-openapi` after adding/removing a route or changing a mount prefix.**
There is no CI check that the committed `openapi.generated.json` matches current routes — treat a
stale generated spec as a bug, not a formality.

## Standard for new/changed endpoints

1. **Response envelope — pick ONE shape and use it everywhere new.** `docs/PATTERNS.md` documents
   three different envelopes already in use (`{success, message}`, raw resource, `{valid, ...}`).
   Don't add a fourth. Until the team ratifies one, match the **route file you're editing**, and
   raise the inconsistency rather than silently picking your favorite.
2. **Validate every request body with Zod** (`src/validators/schemas.js`, `validateBody()`
   middleware) — this is already the standard, not new. A route without a schema isn't
   documentable by the generator in a meaningful way either.
3. **Status codes**: use the existing vocabulary before inventing a new one — `200`/`204` success,
   `400` validation, `401` auth, `403` forbidden/locked, `404` not found, `410` gone
   (expired/used token), `500` unhandled. See `docs/PATTERNS.md` for real examples of each.
4. **Never hand-write OpenAPI YAML/JSON.** The generator derives the spec from the route
   definitions themselves — if the generated spec is wrong, the fix is the route's shape (JSDoc
   comment, validated body, response type), not editing `openapi.generated.json` directly.
5. **Path prefixes are load-bearing for consumers** — `frs-web-ui`'s `apiRequest()` prepends
   `apiBaseUrl` (which already ends in `/api`). At least two frontend call sites embed a literal
   `/api` in the path on top of that (see `docs/ESTATE.md`'s "Known likely bug") — when adding a
   route, check the mount prefix in `server.js`'s `app.use()` table so this doesn't happen again.

## The DTO-drift problem this standard is meant to close

`docs/ESTATE.md` flags that `frs-web-ui` hand-mirrors backend response shapes per-endpoint (e.g.
`DashboardManifest` in `frs-web-ui/src/app/types/manifest.ts:26-38`) with no shared/generated
types package — a backend response-shape change silently breaks the frontend's type safety.
**The generated `openapi.generated.json` is the fix path**: once response shapes are consistent
(see point 1), it becomes viable to generate a frontend TypeScript client/types from it instead of
hand-mirroring. Not done yet — flagged here as the standard to work toward, not a completed state.

## Reference

- Motivity's Azure DevOps wiki, `04_Development/Coding_Standards_and_Guidelines` — the org-level
  coding standards page (currently a stub; this doc is more current for the API contract specifically
  until that page is populated — see `CLAUDE.md`'s wiki section).
