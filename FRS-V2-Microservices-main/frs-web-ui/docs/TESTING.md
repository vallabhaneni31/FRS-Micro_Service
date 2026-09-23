# Testing strategy

> The mechanics (Vitest config, file naming, commands) live in `docs/PATTERNS.md`'s Testing
> section — this doc is the strategy those mechanics serve.

## Current state

- **Unit/component**: Vitest + Testing Library, colocated `*.test.ts(x)` files, `npm test` →
  `vitest run`. This is the only automated test layer in this repo.
- **No functional/E2E suite exists** — no Playwright, no Cypress. The root `test-canNext.js`,
  `test-csc.js`, `test-csc.mjs` scripts are ad hoc debugging scripts outside the Vitest `include`
  glob, not an E2E layer (see `docs/PATTERNS.md`).
- **CI's real gate is opaque from this repo** — `azure-pipelines.yml` delegates to an external
  shared template (`npmbuild.yml@templates`); don't assume `npm test` is what actually blocks a
  merge without checking that template.

## What a spec's test plan should actually require

1. **Every acceptance criterion gets at least a component test** — render, interact via
   `@testing-library/user-event`, assert via `screen.getByRole`/`getByLabelText`, following the
   shape in `docs/PATTERNS.md`'s Testing section.
2. **User-facing/contract-level criteria nominally need a functional/E2E test** per the general
   spec template — but since no E2E framework exists here, a spec touching a full user flow
   (login, enrollment, a manifest-driven page load) should either (a) add Playwright/Cypress as
   part of that spec's scope, explicitly, or (b) note in §6.1 that verification is manual until
   that gap is closed. Don't claim E2E coverage that's actually a component test with everything
   mocked.
3. **Mocking boundary**: component tests mock `apiRequest`/context providers (see
   `LoginPage.test.tsx` for the pattern) — this proves the component's logic, not the real
   contract with `frs-core-api`. A test that only asserts against a mocked `apiRequest` response
   doesn't catch a real backend contract change; see `docs/ESTATE.md`'s DTO-drift note.

## Coverage gaps worth closing (not blocking, but real)

- No E2E coverage of the manifest-driven page-loading flow (`/me/manifest` → `PAGE_REGISTRY` →
  lazy-loaded page) — the single most load-bearing piece of this app's architecture has no
  end-to-end test.
- No test coverage confirming the raw-`fetch()` bypass flows (`docs/ESTATE.md`'s "Bypasses"
  section — enrollment photo upload, face-enroll) behave correctly on 401/token-refresh, since
  they skip `apiClient.ts`'s tested refresh logic entirely.
- CI's actual gate is unknown from this repo alone (external template) — worth confirming what it
  runs before assuming `npm test`/`npm run build` passing locally means CI is green.

## Reference

- Motivity's Azure DevOps wiki, `06_Quality_Assurance` and `03_Design/testing` — both currently
  stubs; this doc + `docs/PATTERNS.md` are more current until those are populated (see
  `CLAUDE.md`'s wiki section).
