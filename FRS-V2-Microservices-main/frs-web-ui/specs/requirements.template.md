# Requirements: <short title>

| | |
|---|---|
| **Ticket** | XXX-0000 |
| **Project / service** | <repo or service name> |
| **Stack** | <e.g. Java/Spring, React, Node/Express — fill from the repo> |
| **Status** | Draft | Approved | Implemented | Verified |
| **Author** | <name> |
| **Date** | YYYY-MM-DD |

> One spec = one folder `specs/NNNN-<slug>/` holding `requirements.md` (this file — the WHAT and
> WHY), `design.md` (the HOW), and `tasks.md` (the ordered execution plan). This file is the
> contract the human approves; the other two derive from it.

## Revisions
<Skip this section entirely if the spec was approved first pass. One row per revision, newest
first, so a reviewer re-reads what moved instead of the whole document.>

| # | What changed | Why | Requirements affected |
|---|--------------|-----|-----------------------|
| 1 | <initial draft> | — | — |

## 1. Problem / Goal
<What user/business problem are we solving, and why now? 2–4 sentences. No solution here.>

## 2. Scope
**In scope**
- <bullet>

**Non-goals** (explicitly NOT doing)
- <bullet>

## 3. Requirements

> One numbered requirement per user story. Acceptance criteria use **EARS notation** — each is a
> single testable sentence of one of these shapes:
> - Ubiquitous: `THE SYSTEM SHALL <response>`
> - Event-driven: `WHEN <trigger> THE SYSTEM SHALL <response>`
> - State-driven: `WHILE <state> THE SYSTEM SHALL <response>`
> - Conditional: `IF <condition> THEN THE SYSTEM SHALL <response>`
> - Unwanted behavior: `IF <error condition> THEN THE SYSTEM SHALL <error response>`
>
> Every criterion must be observable from outside (a response, a state change, an emitted event)
> — never an implementation detail. Each becomes at least one test and one row of the review
> checklist. Number them `<req>.<n>` so tasks and tests can reference them.

### Requirement 1 — <short name>
**User story:** As a <role>, I want <capability>, so that <benefit>.

**Acceptance criteria**
- [ ] **1.1** WHEN <trigger> THE SYSTEM SHALL <observable response>.
- [ ] **1.2** IF <error condition> THEN THE SYSTEM SHALL <error response with status/shape>.

### Requirement 2 — <short name>
**User story:** As a <role>, I want <capability>, so that <benefit>.

**Acceptance criteria**
- [ ] **2.1** ...

## 4. Open questions / follow-ups
<**Non-blocking items only** — things whose answer changes nothing in this spec. If an answer
would change an API shape, data model, error code, scope boundary, or compatibility, it is
**blocking**: it must be answered before this spec is written, not parked here. Empty is the
healthy state.>

- <bullet>
