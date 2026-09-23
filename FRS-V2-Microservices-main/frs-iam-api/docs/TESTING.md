# Testing strategy

> The mechanics (frameworks, file naming, per-service commands) live in `docs/PATTERNS.md`'s
> Testing sections — this doc is the strategy those mechanics serve: what should be tested at
> which level, and the gap between what CI actually gates and what "tested" should mean.

## The gap to know about before writing a test plan

**`npm test` is not what CI checks.** `backend/api` has 27 test files under `src/tests/`; CI
(`azure-pipelines.yml:96-99`) runs exactly 2 of them (`password.test.js`, `security.test.js`) as
the merge gate — the other ~24 need a live stack and are deferred to post-deploy. When a spec's
acceptance criteria cite "tests pass" as evidence, be explicit about **which** run they mean:
local `npm test` (all 27, needs local setup), or the CI gate (2 files, what actually blocks a
merge). Conflating the two is how a spec gets marked `Verified` on weaker evidence than it claims.

## Test levels (by service)

### `backend/api`, `backend/api-retail` (Node)
- **Unit** — pure logic in isolation, Node's built-in `node:test` + `node:assert/strict`.
- **Integration** — module + real Postgres, same `node:test` runner, distinguished by needing a
  live DB rather than a separate directory (no `tests/unit/` vs `tests/integration/` split exists
  — see `docs/PATTERNS.md`). This is most of the 27 files CI doesn't run.
- **Functional/E2E** — **does not exist**. No Playwright/Cypress/Supertest-driven black-box HTTP
  suite against a running instance. `testing/` at the repo root has cross-cutting API integration
  scripts, but they're not wired into CI or `npm test` — treat them as manual/ad hoc tooling, not
  an automated gate, until confirmed otherwise.

### `backend/api-transport` (Java/Spring)
- JUnit test classes under `src/test/java/.../controller/` (`AttendanceApiTest.java`,
  `EnrollmentApiTest.java`, `ManagementApiTest.java`) — controller-level tests, run via `mvn test`.
  Not built by this repo's CI at all (excluded, moving to its own repo).

## What a spec's test plan should actually require

1. **Every acceptance criterion gets at least a unit or integration test** using the
   framework already in use for that service (don't introduce a new test framework in a spec).
2. **User-facing/contract-level criteria need a functional/E2E test** per the general spec
   template — but since none of the automated kind exists here yet, either (a) add one using the
   existing `testing/` scripts as a starting point and wire it into CI, or (b) explicitly note in
   the spec's §6.1 that verification is manual until that gap is closed. Don't silently claim
   functional coverage that's actually just a unit test.
3. **If a criterion can only be verified by one of the ~24 CI-skipped suites**, say so in the
   spec's Rollout/final-acceptance section — that criterion's "done" status depends on someone
   running the local suite, not on the merge gate going green.

## Coverage gaps worth closing (not blocking, but real)

- No functional/E2E automation for `backend/api` despite it being the highest-traffic, CI-gated
  service.
- CI's 2-file gate covers auth/security only — a regression in, say, attendance logic wouldn't be
  caught by CI, only by someone remembering to run the full local suite.
- `backend/api-transport`'s JUnit suite isn't part of any CI pipeline in this repo (it's excluded
  entirely) — verify it runs *somewhere* (its own future repo's CI) before assuming it's a safety net.

## Reference

- Motivity's Azure DevOps wiki, `06_Quality_Assurance` and `03_Design/testing` — both currently
  stubs; this doc + `docs/PATTERNS.md` are more current until those are populated (see
  `CLAUDE.md`'s wiki section).
