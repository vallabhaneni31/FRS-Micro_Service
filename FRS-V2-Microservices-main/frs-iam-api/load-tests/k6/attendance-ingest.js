/**
 * PERF-0001 AC9 — attendance ingest load test.
 *
 * Drives the device-authenticated mark route at 300 events/s for 15 min and
 * asserts: publish p99 < 100ms, 0 device 429s, and event->row lag p95 < 5s.
 *
 * Preconditions (spec §6.1): Postgres + Kafka + Redis up; API running with
 *   ATTENDANCE_WRITE_MODE=async; a valid device JWT; migrations applied.
 *
 * Run:
 *   BASE_URL=http://localhost:8080 DEVICE_JWT=<token> \
 *   k6 run load-tests/k6/attendance-ingest.js
 *
 * The event->row lag check requires a small verification endpoint or a DB probe;
 * here we approximate ingest health via response latency + status, and leave the
 * lag assertion to the operator's consumer-lag dashboard (documented in the spec).
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const DEVICE_JWT = __ENV.DEVICE_JWT || "";

const throttled = new Rate("device_throttled_429");
const publishLatency = new Trend("publish_latency_ms", true);

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: 300, timeUnit: "1s",
      duration: "15m",
      preAllocatedVUs: 100, maxVUs: 400,
    },
  },
  thresholds: {
    "publish_latency_ms": ["p(99)<100"],
    "device_throttled_429": ["rate==0"],
    "http_req_duration": ["p(99)<100"],
  },
};

export default function () {
  const empId = 1 + Math.floor(Math.random() * 100000);
  const res = http.post(
    `${BASE_URL}/api/attendance/direction`,
    JSON.stringify({ employeeId: empId, direction: Math.random() < 0.5 ? "entry" : "exit", timestamp: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_JWT}` } }
  );
  publishLatency.add(res.timings.duration);
  throttled.add(res.status === 429);
  check(res, { "accepted (202)": (r) => r.status === 202 });
}
