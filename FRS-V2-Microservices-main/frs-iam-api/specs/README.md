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
     model, error codes, scope, compatibility).
   - **Runs an adversarial pass over its own draft** (the `edith-spec-reviewer` agent, fresh context)
     and fixes what it finds — contract gaps, untestable criteria, unnamed ripple.

   Then it writes the spec folder `specs/NNNN-slug/` — three files:
   - **`requirements.md`** — user stories with **EARS-notation** acceptance criteria
     (`WHEN <trigger> THE SYSTEM SHALL <response>`), numbered so tasks and tests reference them.
     This is the contract you approve.
   - **`design.md`** — current behavior (cited `file:line`), API/data/event contracts, flow,
     cross-module ripple, and the test strategy incl. the final-acceptance gate.
   - **`tasks.md`** — discrete ordered tasks, each mapped to the criteria it satisfies, each
     carrying its own tests.

   **No implementation code is written in this step.** The requirements are the source of truth.

2. **Plan** — Claude proposes an implementation plan from the approved spec (plan mode).
   You approve before edits begin.

3. **Implement** — `/spec-build specs/NNNN-slug/`
   Claude executes **`tasks.md` one task at a time, in order**: implements the task with the
   tests it names, gets them green, checks the task off, then moves to the next.

4. **Verify** — run the **final acceptance** pass (`design.md` §4.1): the project's *full* test
   suite, including the functional/E2E tests, green end to end — not just the new tests.
