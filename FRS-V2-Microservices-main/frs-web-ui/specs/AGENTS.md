# The edith agent team

Spec-driven development as a team of subagents, mapped to the loop:

| Agent | Phase | Tools | Job |
|-------|-------|-------|-----|
| `edith-spec-author` | SPECIFY | read + Write | Ticket → reviewable spec folder under `specs/NNNN-slug/` (`requirements.md` with EARS criteria, `design.md`, `tasks.md`). No code. Stops and returns blocking contract questions rather than guessing them. |
| `edith-spec-reviewer` | SPECIFY | read-only + Bash | Adversarially checks the **draft spec** before a human reads it — contracts, EARS criteria testable, requirement↔task coverage, ripple. Fresh context, so it sees what the author can't. |
| `edith-developer` | IMPLEMENT | read + Edit/Write + Bash | Builds ONE approved spec, executing `tasks.md` one task at a time, test-first. |
| `edith-reviewer` | VERIFY | read-only + Bash | Adversarially checks the impl against the spec's acceptance criteria. |
| `pr-author` | VERIFY | read-only + Bash | Completed spec + diff → PR title/body with the criteria as a checklist. |

The two reviewers are deliberately separate: `edith-spec-reviewer` reviews the **paper** (before code
exists, where a fix is a sentence), `edith-reviewer` reviews the **code** against that paper.

Definitions live in `.claude/agents/`. Invoke one by asking for it ("use the edith-developer
agent to build specs/0001-…"), or let Claude pick by description.

## "Three developers working" = parallel implement, isolated

The team had three developers building features concurrently. To mirror that, run **three
`edith-developer` agents in parallel — one spec each — and give each its own git worktree**
so their edits never collide:

```
   ┌─ edith-spec-author  →  specs/0001-a/ ─┐
   ├─ edith-spec-author  →  specs/0002-b/ ─┤   (human reviews/approves the requirements)
   └─ edith-spec-author  →  specs/0003-c/ ─┘
                  │  approved
                  ▼
   ┌─ edith-developer  (worktree A)  builds 0001 ─┐
   ├─ edith-developer  (worktree B)  builds 0002 ─┤   run concurrently
   └─ edith-developer  (worktree C)  builds 0003 ─┘
                  │  each returns diff + test results
                  ▼
   ┌─ edith-reviewer  verifies 0001 ─┐
   ├─ edith-reviewer  verifies 0002 ─┤   verify per spec
   └─ edith-reviewer  verifies 0003 ─┘
                  │
                  ▼   human merges the approved branches
```

### Why worktree isolation matters
Three agents editing the same checkout would clobber each other. Each `edith-developer` runs
in its own git worktree (a separate working copy on its own branch), so the three streams
are independent and merge cleanly — exactly like three developers on three branches.

**Important:** parallelize across *independent* specs. If two specs touch the same files
(e.g. both edit `CouponService`), sequence them instead — paper conflicts are cheaper than
merge conflicts.

## How to kick it off
- One ticket: `/spec DLA-1234 …` → review → `/spec-build specs/NNNN-…/`.
- A batch (the 3-developer pattern): ask Claude to "spec these 3 tickets, then build them in
  parallel with isolated worktrees, then review each against its spec." Claude orchestrates
  the fan-out. For larger batches this is worth running as a structured multi-agent workflow.
