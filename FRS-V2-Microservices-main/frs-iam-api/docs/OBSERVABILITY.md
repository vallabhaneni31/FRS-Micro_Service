# Observability standard (OpenTelemetry)

> Standard for tracing/metrics/logging across `backend/api`, `backend/api-retail`, and
> `backend/api-transport`. **OpenTelemetry is not implemented anywhere in this repo today** — this
> is the target standard, grounded in what already exists, not a description of current state.

## What already exists

- **Structured logging**: a Pino-backed logger (`backend/api/src/utils/logger.js`) with a
  JSON-fallback when Pino isn't available. Not yet OTel-correlated (see below).
- **Correlation ID, not distributed tracing**: `correlationIdMiddleware`
  (`backend/api/src/middleware/correlationId.js`) attaches an `X-Request-ID` per request (accepts
  an upstream ID or generates one), and `requestLogger`
  (`backend/api/src/middleware/requestLogger.js`) logs `{cid, method, path, status, durationMs}`
  per request. `frs-web-ui`'s `ApiError` already reads this header back for support-visible error
  traces (`docs/ESTATE.md`). **This is a single-hop request ID, not a trace** — it doesn't follow a
  request across the Kafka boundary into `backend/api-retail`/`backend/api-transport`, and it
  carries no span/timing breakdown within a request.
- **No metrics, no traces, no OTel SDK** in any of the three services — confirmed by dependency
  scan, no `@opentelemetry/*` packages anywhere in this repo.

## The gap this standard closes

Three services, two of them exchanging events over Kafka (`backend/api/src/core/kafka/*`), with
no way to trace a request/event across that boundary today — only the single-hop `X-Request-ID`.
When something goes wrong across the Kafka boundary, there's no automated way to correlate the
producer-side log with the consumer-side log beyond manually grepping timestamps.

## Standard (target, to adopt incrementally — don't do it all in one PR)

1. **Adopt OpenTelemetry's Node SDK in `backend/api` first** (highest-traffic, CI-gated service).
   Auto-instrument HTTP (Express) and the Postgres client (`pg`) via
   `@opentelemetry/auto-instrumentations-node` — this gets request spans and DB-query spans with
   minimal code change.
2. **Propagate the existing `X-Request-ID` as the OTel trace ID** rather than running two parallel
   correlation systems — set `correlationIdMiddleware` to read/write the W3C `traceparent` header
   convention, so existing log correlation and new trace correlation are the same identifier.
3. **Instrument the Kafka producer/consumer boundary explicitly** — this is the actual pain point
   (cross-service, not just cross-request). Use OTel's messaging semantic conventions so a trace
   started in `backend/api` continues into `backend/api-retail`/`backend/api-transport` when they
   consume the event.
4. **`backend/api-transport` (Java/Spring)**: use `opentelemetry-spring-boot-starter` — Spring Boot
   auto-configures HTTP + JPA instrumentation with less manual wiring than Node needs.
5. **Export to whatever collector the team picks** — not specified here; this doc defines the
   instrumentation standard (what gets a span, what the trace ID is), not the backend
   (Jaeger/Tempo/vendor). Pick the collector as a separate, infra-level decision before rollout.
6. **Don't block on 100% coverage.** Land the SDK + auto-instrumentation for `backend/api` alone
   first, prove it end-to-end (a real cross-Kafka trace visible in the collector), then extend.

## Non-goals

- This doc does not cover frontend observability (`frs-web-ui` currently uses Sentry for error
  tracking only — see that repo's `docs/PATTERNS.md`). Browser-side RUM/OTel-web is a separate,
  smaller decision once backend tracing exists to connect to.
- Not proposing changes to the existing Pino logger — OTel spans complement structured logs, they
  don't replace them.

## Reference

- Motivity's Azure DevOps wiki, `05_CICD_and_DevSecOps` — currently a stub; this doc should be
  mirrored there once the team ratifies the rollout plan (see `CLAUDE.md`'s wiki section).
