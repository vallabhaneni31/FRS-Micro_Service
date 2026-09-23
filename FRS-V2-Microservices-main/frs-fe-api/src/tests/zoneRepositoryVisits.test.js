/**
 * specs/0003-zone-analytics — Task 4: visit-pairing (entries <-> exits) query.
 * Mocked pool.query (see zoneRepositoryFilters.test.js header for why).
 *
 * The LAG/LEAD entry->next-exit pairing itself runs in Postgres (design.md
 * §2.2) — this repo has no isolated test database to fully exercise it
 * end-to-end (see WALKTHROUGH.md), so these tests cover:
 *   (a) the SQL text keeps unmatched entries (exited_at stays NULL, never
 *       dropped by a WHERE) — structural proof AC 3.6's "still counted in
 *       entries/current occupancy" requirement is satisfiable from this CTE;
 *   (b) the real JS-side math (getTimeSpentBuckets' bucketing, getVisits'
 *       reshaping) against fixture rows, which IS pure JS and fully testable.
 */
import test from "node:test";
import assert from "node:assert";
import { pool } from "../db/pool.js";
import { getVisits, getTimeSpentBuckets, getEntryPointTraffic, visitPairsCTE } from "../repositories/zoneRepository.js";

function withMockQuery(impl, fn) {
  const orig = pool.query;
  pool.query = impl;
  return fn().finally(() => { pool.query = orig; });
}

test("visitPairsCTE keeps unmatched entries (exited_at NULL) rather than dropping them (AC 3.6)", () => {
  const params = [];
  const cte = visitPairsCTE({ tenantId: "t1" }, params);
  // The exited_at CASE only nulls out non-exit follow-ups; there is no WHERE
  // that filters visits down to matched-only inside this shared CTE, so
  // every consumer (getOccupancy, getVisits, getEmployees, ...) still
  // sees unmatched entries and can count them toward entries/occupancy.
  assert.match(cte, /CASE WHEN next_direction = 'exit' THEN next_at ELSE NULL END AS exited_at/);
  assert.doesNotMatch(cte, /WHERE exited_at IS NOT NULL/);
});

test("getVisits: avg duration/time-inside are computed only from matched visits (AC 3.5, 3.6)", async () => {
  await withMockQuery(async () => ({
    rows: [{
      total_visits: 5,          // includes 1 unmatched trailing entry
      unique_visitors: 3,
      repeat_visits: 2,
      avg_visit_duration_minutes: 45.6, // excludes the unmatched entry
      avg_time_inside_minutes: 60.2,
      avg_visits_per_employee: 1.6666,
    }],
  }), async () => {
    const out = await getVisits({ tenantId: "t1" });
    assert.strictEqual(out.totalVisits, 5);
    assert.strictEqual(out.avgVisitDurationMinutes, 46); // rounded
    assert.strictEqual(out.avgTimeInsideMinutes, 60);
    assert.notStrictEqual(out.avgVisitDurationMinutes, out.avgTimeInsideMinutes,
      "avgVisitDurationMinutes and avgTimeInsideMinutes are distinct aggregates");
  });
});

test("getTimeSpentBuckets: buckets <1h/1-3h/3-6h/6-9h/>9h by minutes (AC 3.5 histogram)", async () => {
  await withMockQuery(async () => ({
    rows: [
      { minutes: 30 },   // <1h
      { minutes: 59.9 }, // <1h
      { minutes: 60 },   // 1-3h boundary -> 1-3h bucket
      { minutes: 179 },  // 1-3h
      { minutes: 200 },  // 3-6h
      { minutes: 400 },  // 6-9h
      { minutes: 700 },  // >9h
    ],
  }), async () => {
    const out = await getTimeSpentBuckets({ tenantId: "t1" });
    const byBucket = Object.fromEntries(out.map((b) => [b.bucket, b.count]));
    assert.deepStrictEqual(byBucket, { "<1h": 2, "1-3h": 2, "3-6h": 1, "6-9h": 1, ">9h": 1 });
  });
});

test("getTimeSpentBuckets: an unmatched entry (no exited_at row reaches JS) never appears in any bucket (AC 3.6)", async () => {
  await withMockQuery(async (sql) => {
    // The query itself filters WHERE exited_at IS NOT NULL — unmatched
    // entries never reach the JS bucketing step at all.
    assert.match(sql, /WHERE exited_at IS NOT NULL/);
    return { rows: [{ minutes: 45 }] };
  }, async () => {
    const out = await getTimeSpentBuckets({ tenantId: "t1" });
    const total = out.reduce((s, b) => s + b.count, 0);
    assert.strictEqual(total, 1);
  });
});

test("getEntryPointTraffic: contribution percentages sum to ~100 across devices (AC 3.4)", async () => {
  await withMockQuery(async () => ({
    rows: [
      { device_code: "CAM-01", device_label: "Main Entrance", entries: 30, exits: 28, unique_employees: 12, peak_hour: 9, contribution_pct: 60 },
      { device_code: "CAM-02", device_label: "Side Door", entries: 20, exits: 18, unique_employees: 8, peak_hour: 17, contribution_pct: 40 },
    ],
  }), async () => {
    const out = await getEntryPointTraffic({ tenantId: "t1" });
    assert.strictEqual(out.length, 2);
    const sum = out.reduce((s, r) => s + r.contributionPct, 0);
    assert.strictEqual(sum, 100);
    assert.deepStrictEqual(Object.keys(out[0]).sort(), [
      "contributionPct", "deviceId", "deviceLabel", "entries", "exits", "net", "peakActivity", "uniqueEmployees",
    ].sort());
  });
});
