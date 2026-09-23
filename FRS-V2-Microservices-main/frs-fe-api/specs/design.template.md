# Design: <short title>

> The HOW for the requirements in `requirements.md` (same folder). Fill only the subsections that
> apply to this change and this stack; delete the rest. Ground every claim about current behavior
> in real code (`path/to/File.ext:42`) — unverified claims are marked `(unverified)`, never stated
> as fact.

## 1. Current behavior
<How does the relevant part work today? Reference real code: `path/to/File.ext:42`. If new, say "new".>

## 2. Proposed design

### 2.1 API / interface contract
<The contract this change exposes or consumes:>
- **HTTP API**: method + path, request shape, response shape, status codes, error cases.
- **UI component / module** (React): component name, props in/out, state, events/callbacks,
  the data it fetches and from where.
- **Library/function**: signature, inputs, outputs, errors thrown.

| Method/Type | Path / name | Request / props | Response / return | Notes |
|-------------|-------------|-----------------|-------------------|-------|
| | | | | |

### 2.2 Data / state model
- **Relational (MySQL/PostgreSQL):** new/changed tables, columns, types, indexes, constraints,
  and the **migration** (never hand-edited schema). Note transactions where writes must be atomic.
- **Document (MongoDB):** new/changed collections, document shape, validation, indexes, backfill.
- **Client state (React):** new/changed state shape, where it lives, how it's derived/invalidated.

### 2.3 Flow / sequence
<How the pieces interact for the main path and the key error path — a short numbered sequence or
a mermaid diagram. Name the real modules/classes involved.>

### 2.4 Events / side-effects
<Async messages, queues/topics, jobs, webhooks, cache invalidation — payload shape, idempotency,
failure handling. Omit if none.>

### 2.5 External / cross-service calls
<Outbound calls to other services or third parties: what's called, the contract assumed,
failure/timeout behavior. Check `docs/ESTATE.md` for the peer's side. Omit if none.>

### 2.6 Config / feature flags / env
<New config keys, env vars, feature flags gating rollout. Omit if none.>

## 3. Cross-module ripple
<Which other modules/services/consumers does this touch (shared events, APIs, types, tables)?
Name each affected consumer. Check the architecture contract index. "None" only if verified.>

## 4. Test strategy
<Map each EARS criterion from requirements.md to at least one test at the level that proves it:>
- **unit** — pure logic in isolation (Java `*Test.java`; Jest/Vitest).
- **integration** — module + real collaborators / DB (Java `*IT.java`; Supertest, `@nestjs/testing`).
- **functional / E2E** — the behavior end to end from the outside (HTTP black-box; Playwright/
  Cypress). **Every user-facing or contract-level criterion needs at least one functional/E2E
  test**, not just a unit test.

| Criterion | Test type | Test file / class / method |
|-----------|-----------|----------------------------|
| 1.1 | unit | |

### 4.1 Final acceptance (gate before `Verified`)
The spec is **not** `Verified` until the project's **full** suite — including the functional/E2E
tests — runs green end to end. List the command(s) and preconditions:

- Full suite: `<e.g. npm test && npm run test:e2e / mvn verify>`
- Preconditions: `<test DB seeded, service running, env vars — or "none">`

## 5. Rollout & risks
<Deploy order if cross-service, backward compatibility, data-migration risk, rollback plan,
mitigations.>
