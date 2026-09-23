# Azure Boards Bug-Fix Workflow

This is the exact, repeatable process used in this repo to take an Azure Boards bug/task from
"assigned to me" to "merged and verified," including every git and Azure DevOps command shape.
It applies to every `AB#<id>` item — bugs and follow-on tasks alike.

**Org / Project:** `ML-AIML-COE` / `Motivity-Face_Recognition_System`
**Base integration branch:** `allbugfix` (bug branches cut from here — **never** from `dev` directly;
`allbugfix` periodically merges into `dev` separately)

---

## 0. Before touching code: is it even still a bug?

Before opening a branch, check whether the reported behavior is already fixed in current source.
This repo has hit this **three times** in one pass (AB#3125, AB#3216, and half of AB#2793) — all
were valid reports at filing time, but a later, unrelated commit had already fixed the underlying
code, and nobody had re-verified before the ticket was picked up.

How to check:
- `git log --all -S"<distinctive string from the described bug>" -- <suspected file>` to find the
  commit that plausibly fixed it.
- Compare that commit's date to the ticket's `System.CreatedDate`. If the fix landed *after* the
  ticket was filed, it's very likely stale.
- Confirm by reading the current code directly — don't assume from the commit message alone.

If confirmed stale, skip straight to a comment (see step 9) explaining the root cause and citing
the commit that already fixed it, without opening a branch.

---

## 1. Triage — pull the ticket

```bash
az boards work-item show --id <id> --org https://dev.azure.com/ML-AIML-COE
```

Read the title, repro steps, and current `System.State`. If severity/priority fields are
uninformative (common in this project — most items carry identical values), triage by actual
impact instead: does it block a core flow, is it security-relevant, how many users does it touch.

---

## 2. Open the ticket

**2a. Set to Active** (only if not already Active — this one transition is pre-authorized, no
need to ask each time; every other state change below still requires explicit confirmation):

```bash
az boards work-item update --id <id> --state Active --org https://dev.azure.com/ML-AIML-COE
```

**2b. Log an hours estimate** — set `Original Estimate` and `Remaining Work` to the same starting
number:

```bash
az boards work-item update --id <id> \
  --fields "Microsoft.VSTS.Scheduling.OriginalEstimate=<hours>" "Microsoft.VSTS.Scheduling.RemainingWork=<hours>" \
  --org https://dev.azure.com/ML-AIML-COE
```

**2c. Branch off `allbugfix`** (confirm local `allbugfix` isn't behind `origin` first — bugs get
pushed directly by others mid-session):

```bash
git checkout allbugfix
git fetch origin allbugfix
git pull --ff-only origin allbugfix   # only if behind
> [!IMPORTANT]
> **CRITICAL WORKFLOW RULE**: You MUST checkout, edit, and commit on the `bugfix/<id>/<slug>` branch FIRST. Never make changes directly on `allbugfix`. Always complete all code changes and commits on the bugfix branch first, push the bugfix branch, and only then merge into `allbugfix`.

Branch naming: `bugfix/<work-item-id>/<slug>` — e.g. `bugfix/3191/attendance-override-correction`.

---

## 3. Investigate — find the real root cause

Dispatch a read-only research pass (an Explore-type agent, or direct grep/read for something
small) with as much already-known context as possible, and demand **exact `file:line` citations**,
not paraphrased summaries. Never accept "should be fixed now" without a citation to the specific
line that was wrong and the specific line that fixes it.

For anything load-bearing, verify independently rather than trusting the investigation's word:
- AB#2730 (Keycloak lockout): queried Keycloak's own Admin API directly to confirm the realm's
  actual `bruteForceProtected`/`failureFactor` values, rather than trusting that the code *should*
  have set them.
- AB#2793 (reset email): ran a live `nodemailer` SMTP auth check against the real credentials
  before concluding the email pipeline was fine.
- AB#3191 (attendance 500): confirmed the exact Postgres column type (`timestamp with time zone`)
  in the schema file directly rather than assuming from the error message alone.

---

## 4. Scope gate — stop before silently expanding

If investigation reveals the fix touches more surface than the ticket describes (a new API
contract, a second unrelated bug in the same code path, a decision that needs a human call), ask
before proceeding — this repo uses a small set of grounded options with a recommendation, not an
open-ended question.

If the answer is "yes, but track it separately," open a **new**, linked Azure Boards item rather
than overloading the original one:

```bash
az boards work-item create --title "<title>" --type "Task" \
  --org https://dev.azure.com/ML-AIML-COE --project Motivity-Face_Recognition_System \
  --description "<context, references the parent AB#id>"

az boards work-item relation add --id <new-id> --relation-type "Related" --target-id <original-id> \
  --org https://dev.azure.com/ML-AIML-COE
```

Then run steps 2–10 for the new item independently. This happened twice this pass:
- **AB#2730** (lockout not syncing) → spun off **AB#3267** ("show remaining attempts") once it was
  clear that was a distinct, separately-testable feature, not part of the original defect.
- **AB#2793** (reset popup) → spun off **AB#3270** ("send a reset link instead of admin-set
  password") once the requested change turned out to be a flow redesign, not a notification fix.

---

## 5. Implement — delegate with full context, not a vague ask

Dispatch an implementation pass (a coder-type agent) with the diagnosis already fully spelled out:
exact file:line, exact root cause, exact shape of the fix, exact existing conventions to match
(error handling style, test-mocking style, naming). The goal is that the agent does not have to
re-derive anything already known — it only has to execute and test.

Requirements given to every implementation pass:
- Match this repo's existing conventions in the touched files (don't introduce a new pattern where
  one already exists nearby).
- Tests are mandatory, using the project's existing test framework/mocking style
  (`node:test` + manual mocks on the backend, Vitest + Testing Library on the frontend).
- Commit locally only — reference `AB#<id>` in the commit message. No pushing from inside the
  implementation pass.
- Explicitly told which unrelated uncommitted files in the working tree to leave untouched (this
  repo often has a teammate's in-progress edits sitting uncommitted alongside the fix).

---

## 6. Verify — don't just trust the report

Never take an agent's "tests pass" claim as final. Independently, in order:

1. **Read the actual diff**: `git show <commit> --stat` then the full diff on any file whose logic
   changed in a way that matters (not pure test-file additions).
2. **Re-run the new tests directly**, not the whole suite blindly:
   ```bash
   node --test src/tests/<newTestFile>.test.js      # backend
   npx vitest run <path/to/NewTest>.test.tsx         # frontend
   ```
3. **Confirm any "pre-existing" failures are actually pre-existing**, not caused by this change:
   ```bash
   git diff <base-commit> HEAD --stat -- <failing-test-file>   # zero output = definitely untouched
   # or, if an unrelated uncommitted file is muddying the run:
   git stash push -- <unrelated-file>
   npm test
   git stash pop
   ```

---

## 7. Merge into `allbugfix` and re-test the merged result

```bash
git checkout allbugfix
git fetch origin allbugfix
git log --oneline -1 allbugfix
git log --oneline -1 origin/allbugfix   # confirm not behind; pull --ff-only if so
git merge --no-ff bugfix/<id>/<slug> -m "Merge branch 'bugfix/<id>/<slug>' into allbugfix

AB#<id>"
```

Then run the **full** suite again on the merged tree — not just the branch in isolation. A clean,
conflict-free `git merge` can still produce semantically broken code when two branches touch the
same function; textual cleanliness is not correctness.

```bash
cd backend/api && npm test
cd frontend && npx vitest run
```

---

## 8. Ship

Push the individual bug branch and the updated integration branch to `origin`:

```bash
git push origin bugfix/<id>/<slug>
git push origin allbugfix
```

---

## 9. Record on Azure Boards

**9a. Link the branch** as an `ArtifactLink` on the work item relations:

```bash
curl -s -u ":$AZURE_DEVOPS_EXT_PAT" -X PATCH \
  "https://dev.azure.com/ML-AIML-COE/Motivity-Face_Recognition_System/_apis/wit/workitems/<id>?api-version=7.1" \
  -H "Content-Type: application/json-patch+json" \
  -d '[{"op":"add","path":"/relations/-","value":{"rel":"ArtifactLink","url":"vstfs:///Git/Ref/84cdfa02-24b4-4b39-961e-e752a937630a%2F27ca3004-a8b0-46fe-a32a-74283b70dc21%2FGBbugfix%2F<id>%2F<slug>","attributes":{"name":"Branch"}}}]'
```

**9b. Upload Test Cases & Verification Artifacts**:
Upload the test output log file or execution summary screenshot to ADO attachments and link it to the work item relations:
```bash
# Upload attachment
attachmentUrl=$(curl -s -u ":$AZURE_DEVOPS_EXT_PAT" -X POST \
  "https://dev.azure.com/ML-AIML-COE/Motivity-Face_Recognition_System/_apis/wit/attachments?fileName=test_results.log&api-version=7.1" \
  -H "Content-Type: application/octet-stream" --data-binary "@test_results.log" | jq -r .url)

# Link attachment to work item
curl -s -u ":$AZURE_DEVOPS_EXT_PAT" -X PATCH \
  "https://dev.azure.com/ML-AIML-COE/Motivity-Face_Recognition_System/_apis/wit/workitems/<id>?api-version=7.1" \
  -H "Content-Type: application/json-patch+json" \
  -d "[{\"op\":\"add\",\"path\":\"/relations/-\",\"value\":{\"rel\":\"AttachedFile\",\"url\":\"$attachmentUrl\",\"attributes\":{\"comment\":\"Test execution verification log\"}}}]"
```

**9c. Post Discussion Comment with Mandatory User Tags**:
Every comment MUST tag Kalyan Bapanapalli, Ramya Yeluri, and Prashanth Pittla using Azure DevOps mentions:
`<a href="#" data-vss-mention="version:2.0,55501b8b-1612-6679-8db8-9a2a26809118">@Kalyan Bapanapalli</a> <a href="#" data-vss-mention="version:2.0,5c837c39-c72c-61a2-b0d9-c9bf3e39adc3">@Ramya Yeluri</a> <a href="#" data-vss-mention="version:2.0,0a3fce53-ac20-6371-a518-3f4915be378e">@Prashanth Pittla</a>`

**9d. Update Completed Work / Remaining Work**, remaining driven to 0:

```bash
az boards work-item update --id <id> \
  --fields "Microsoft.VSTS.Scheduling.CompletedWork=<hours>" "Microsoft.VSTS.Scheduling.RemainingWork=0" \
  --org https://dev.azure.com/ML-AIML-COE
```

---

## 10. Hold the gate

**Never move a ticket to Resolved or Closed without the assignee's explicit, per-bug confirmation
that they've verified the fix themselves** (a running-environment test, not just green CI). Leave
`System.State` exactly where step 2a put it — everything above (Active, hours, branch link,
comment) can be done proactively without re-asking; this one transition cannot.

Once confirmed:

```bash
az boards work-item update --id <id> --state Resolved --org https://dev.azure.com/ML-AIML-COE
# Bug type: Resolved. Task type: Closed (Task has no Resolved state — New/Active/Closed/Removed only)
```

Post a short closing comment first if the fix needed any final correction after the user's own
testing (e.g. "verified — account now locks after N attempts").

---

## Quick reference

### Azure Boards fields used

| Field (reference name) | Display name | When set |
|---|---|---|
| `System.State` | State | Active on pickup (step 2a); Resolved/Closed only on explicit confirmation (step 10) |
| `Microsoft.VSTS.Scheduling.OriginalEstimate` | Original Estimate | Once, when work starts (step 2b) |
| `Microsoft.VSTS.Scheduling.CompletedWork` | Completed Work | When the fix is done and tested (step 9c) |
| `Microsoft.VSTS.Scheduling.RemainingWork` | Remaining Work | Set with the estimate, driven to 0 when done |
| Relations → `ArtifactLink` | — | Links the git branch to the work item (step 9a) |
| Relations → `Related` | — | Links a spun-off item back to its parent (step 4) |

Bug work-item states: `New → Active → Resolved → Closed`.
Task work-item states: `New → Active → Closed` (no `Resolved`).

### Naming templates

```
branch:        bugfix/<work-item-id>/<slug>
commit:        <type>: <summary> (AB#<id>)
merge commit:  Merge branch 'bugfix/<id>/<slug>' into allbugfix

               AB#<id>
```

### This session's examples, end to end

| Item | What it was | Outcome |
|---|---|---|
| AB#2812 | super_admin stale `customer_id` → 500 on site creation | Fixed, tested, resolved |
| AB#3125 / AB#3216 | reported UI bug | Stale — already fixed in source, closed with citation |
| AB#2730 | Keycloak brute-force lockout not applied on one provisioning path | Fixed across 2 commits (incl. a second bug the fix uncovered), resolved after live verification |
| AB#3267 | show remaining login attempts | Spun off from AB#2730, implemented, closed |
| AB#2793 | reset popup missing show/hide + no email | Half stale (toggle already shipped), half real (silent email failures) — fixed the real half |
| AB#3270 | admin reset should send a self-service link, not set the password directly | Spun off from AB#2793, implemented, replaces the flow entirely |
| AB#3191 | attendance override 500 | Root-caused to a bare `"HH:MM"` string hitting a `timestamptz` column, fixed on both insert/update paths |
