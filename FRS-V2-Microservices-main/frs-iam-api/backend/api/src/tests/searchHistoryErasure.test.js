/**
 * PERF-0005 AC10 — erasure & retention for search history.
 *
 * Erasure is enforced at the SCHEMA level: search_history.fk_user_id is
 * `REFERENCES frs_user(pk_user_id) ON DELETE CASCADE`, so deleting a user account
 * removes their rows no matter which code path (or raw SQL) does the delete —
 * stronger than an application-level hook that a future caller could forget.
 *
 * Employee erasure (executeGdprErasure) is deliberately NOT wired to this table:
 * it erases a data subject's biometric data, whereas search_history records which
 * OPERATOR ran a search, and its params hold no employee PII (spec §4.6).
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { runDataRetentionCleanup } from "../jobs/dataRetentionCron.js";
import { pool } from "../db/pool.js";

const migration = fs.readFileSync(
  path.join(process.cwd(), "src/db/migrations/009_search_history.sql"), "utf8"
);

test("AC10 — deleting a user cascades to their search history (FK ON DELETE CASCADE)", () => {
  assert.match(
    migration.replace(/\s+/g, " "),
    /fk_user_id\s+BIGINT\s+NOT NULL REFERENCES public\.frs_user\(pk_user_id\) ON DELETE CASCADE/i,
    "search_history must cascade from frs_user so Art.17 erasure cannot be bypassed"
  );
});

test("AC10 — employee erasure is NOT wired to search_history (no employee PII there)", () => {
  const erasure = fs.readFileSync(
    path.join(process.cwd(), "src/services/gdprErasureService.js"), "utf8"
  );
  assert.ok(!/search_history/i.test(erasure),
    "executeGdprErasure is employee-centric; search_history is operator activity");
});

test("AC10 — tenant_id is constrained to uuid-or-_platform at the schema level", () => {
  assert.match(migration, /CONSTRAINT search_history_tenant_id_check CHECK/i,
    "a CHECK must stop arbitrary client-supplied tenant keys reaching storage");
  assert.match(migration, /'_platform'/, "the platform bucket is allowed");
});

test("retention — the cron sweeps search_history by age", async () => {
  const origQuery = pool.query;
  const seen = [];
  pool.query = async (sql, params) => {
    seen.push({ sql: String(sql).replace(/\s+/g, " "), params });
    return { rows: [], rowCount: 0 };
  };
  try {
    await runDataRetentionCleanup();
  } catch { /* other purges may no-op against the stub; we only assert ours ran */ } finally {
    pool.query = origQuery;
  }
  const purge = seen.find((c) => /DELETE FROM search_history/i.test(c.sql));
  assert.ok(purge, "the retention cycle must include a search_history sweep");
  assert.match(purge.sql, /created_at < NOW\(\) - \(\$1 \|\| ' days'\)::interval/i);
  assert.strictEqual(purge.params[0], 90, "defaults to the 90-day retention window");
});
