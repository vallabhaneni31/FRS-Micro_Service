# Spec-Driven Development (SDD)

Every non-trivial change starts with a **spec** — a reviewable document that defines
*what* and *why* before any *how* is written. The spec is the contract Claude implements
against, and the artifact a human reviews **before** code exists.

> One-line / trivial fixes don't need a spec. Anything touching an API, a data model,
> an event, cross-service behavior, or more than ~one file does.

## The loop

```
  1. SPECIFY   →   2. PLAN   →   3. IMPLEMENT   →   4. VERIFY
   (write spec)   (approve)     (code + tests)    (review + CI)
```

1. **Specify** — `/spec <ticket-or-description>`
   Claude explores the relevant code, then does two things **before** the spec reaches you:

   - **Asks you the blocking questions up front**, batched, as concrete options with a
     recommendation. A question is blocking if its answer would change a contract (API shape, data
     model, error codes, scope, compatibility). Answering four of these in one pass is cheap;
     discovering them one revision at a time is not.
   - **Runs an adversarial pass over its own draft** (the `edith-spec-reviewer` agent, fresh context)
     and fixes what it finds — contract gaps, untestable criteria, unnamed ripple. Hole-finding is
     the agent's job, not yours.

   Then it writes the spec folder `specs/NNNN-slug/` — three files:
   - **`requirements.md`** — user stories with **EARS-notation** acceptance criteria
     (`WHEN <trigger> THE SYSTEM SHALL <response>`), numbered so tasks and tests reference them.
     This is the contract you approve.
   - **`design.md`** — current behavior (cited `file:line`), API/data/event contracts, flow,
     cross-module ripple, and the test strategy incl. the final-acceptance gate.
   - **`tasks.md`** — discrete ordered tasks, each mapped to the criteria it satisfies, each
     carrying its own tests.

   **No implementation code is written in this step.** The requirements are the source of truth.

   You should be approving, not QA-ing. If a review keeps turning up holes, that's a bug in the
   loop — not a reason to review harder.

   `/spec-review specs/NNNN-slug/` runs that same adversarial pass on demand. `/spec` already
   does it, so reach for the command when a spec was hand-written, heavily edited, or came from
   someone else.

   **If you send a spec back:** Claude records what changed in the spec's **Revisions** table, so
   round two is a diff read rather than another full read.

2. **Plan** — Claude proposes an implementation plan from the approved spec (plan mode).
   You approve before edits begin.

3. **Implement** — `/spec-build specs/NNNN-slug/`
   Claude executes **`tasks.md` one task at a time, in order**: implements the task with the
   tests it names (Java `*Test.java`/`*IT.java`; React/Node Jest/Vitest + Testing Library /
   Supertest / `@nestjs/testing`), gets them green, checks the task off, then moves to the next —
   so the build is auditable and resumable mid-feature. Every user-facing or contract-level
   criterion also gets a **functional/E2E test** (HTTP black-box, or Playwright/Cypress UI flow).
   Anything not in the requirements is out of scope — if a gap surfaces, update the spec first,
   then continue.

4. **Verify** — run the **final acceptance** pass (`design.md` §4.1): the project's *full* test
   suite, including the functional/E2E tests, green end to end — not just the new tests. Then
   `/code-review` (and `/security-review` where relevant) and the normal CI pipeline. The spec's
   acceptance criteria are the review checklist. Only then set the spec's Status to `Verified`.

## Conventions

- Specs are numbered folders: `specs/0001-add-coupon-expiry/`, `specs/0002-.../` — each holding
  `requirements.md`, `design.md`, `tasks.md`. (Legacy single-file specs `specs/NNNN-*.md` remain
  readable by every command; new specs use the folder form.)
- Keep the spec folder in the **same PR/branch** as the implementation — it documents intent and
  lives next to the code it describes.
- A spec is "done" (`Verified`) when every task in `tasks.md` is checked, every EARS criterion
  has a passing test — including a functional/E2E test for each user-facing/contract-level
  criterion — and the project's full test suite passes end to end (the final-acceptance run,
  `design.md` §4.1).
- Update the spec if reality diverges; a stale spec is worse than none.

## Why this works across many repos and stacks

The same template + the same `/spec` and `/spec-build` commands work in every repo, whatever
the stack (Java, React, Node/Express, NestJS) and database (MySQL, PostgreSQL, MongoDB). The
spec captures the contract — API/interface, data model, events, and any cross-service calls —
explicitly, so changes that ripple between modules or services are designed on paper before
they're coded.
