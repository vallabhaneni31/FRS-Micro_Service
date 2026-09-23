# Tasks: <short title>

> The ordered execution plan for `requirements.md` + `design.md` (same folder). `/spec-build`
> executes these **one task at a time**, in order, checking each off — with its tests passing —
> before starting the next. That makes progress auditable and the build resumable mid-feature.
>
> Rules for writing tasks:
> - Each task is one discrete, codeable step (roughly one commit's worth) with a clear "done".
> - Each task names the **requirement criteria it satisfies** (`Req: 1.1, 1.2`) — a task that
>   maps to no requirement is scope creep; a requirement no task covers is a gap.
> - A task that produces behavior includes **its tests** — testing is not a separate final task
>   (only the final-acceptance run is).
> - Order tasks so every task builds on completed ones (data layer → logic → interface → wiring).
> - Mark blocked/skipped tasks explicitly with a reason — never silently reorder.

## Status

| | |
|---|---|
| **Tasks completed** | 0 / N |
| **Last executed** | — |

## Task list

- [ ] **1. <short imperative title>** — Req: <1.1>
  <1–3 lines: what to build/change, which files/modules, what test proves it.>

- [ ] **2. <short imperative title>** — Req: <1.2, 2.1>
  <...>

- [ ] **N. Final acceptance** — Req: all
  Run the full suite including functional/E2E per `design.md` §4.1; report real results.
  On green, set requirements Status to `Implemented` and check off the EARS criteria.
