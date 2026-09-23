/**
 * specs/0003-zone-analytics — Task 3: occupancy/traffic/heatmap queries.
 * Mocked pool.query (see zoneRepositoryFilters.test.js header for why no
 * live-DB fixture rows are used here).
 */
import test from "node:test";
import assert from "node:assert";
import { pool } from "../db/pool.js";
import { getOccupancy, getTraffic, getHeatmap } from "../repositories/zoneRepository.js";

function withMockQuery(impl, fn) {
  const orig = pool.query;
  pool.query = impl;
  return fn().finally(() => { pool.query = orig; });
}

test("getOccupancy: no capacity value anywhere in the shape (AC 3.1)", async () => {
  await withMockQuery(async () => ({
    rows: [{ current_occupancy: 4, peak_occupancy: 9, average_occupancy: 5, lowest_occupancy: 1 }],
  }), async () => {
    const out = await getOccupancy({ tenantId: "t1" }); // open range includes today
    assert.deepStrictEqual(out, {
      current_occupancy: 4, peak_occupancy: 9, average_occupancy: 5, lowest_occupancy: 1,
    });
    assert.ok(!("capacity" in out));
  });
});

test("getOccupancy: query text pairs entries/exits by employee+zone via window functions", async () => {
  let capturedSql = "";
  await withMockQuery(async (sql) => {
    capturedSql = sql;
    return { rows: [{}] };
  }, () => getOccupancy({ tenantId: "t1" }));
  assert.match(capturedSql, /LEAD\(occurred_at\) OVER \(PARTITION BY employee_id, zone, day ORDER BY occurred_at\)/);
  assert.match(capturedSql, /LEAD\(direction\) OVER/);
});

test("getOccupancy: a range entirely in the past reports no 'current' occupancy, never a fake zero (AC 3.6)", async () => {
  await withMockQuery(async () => ({
    rows: [{ current_occupancy: 4, peak_occupancy: 9, average_occupancy: 5, lowest_occupancy: 1 }],
  }), async () => {
    const out = await getOccupancy({ tenantId: "t1", fromDate: "2026-09-01", toDate: "2026-09-02" });
    assert.strictEqual(out.current_occupancy, null);
    assert.strictEqual(out.peak_occupancy, 9);
  });
});

test("getOccupancy: an open entry only counts as inside on the current day (AC 3.6)", async () => {
  let sql = "";
  await withMockQuery(async (s) => { sql = s; return { rows: [{}] }; }, () => getOccupancy({ tenantId: "t1" }));
  assert.match(sql, /WHERE next_at IS NULL AND entered_at >= \(\(date_trunc\('day', NOW\(\) AT TIME ZONE/);
  assert.match(sql, /COALESCE\(next_at, \(\(date_trunc\('day', entered_at AT TIME ZONE/);
});

test("getTraffic: totals and peak traffic derived from the hourly series (AC 3.2)", async () => {
  await withMockQuery(async () => ({
    rows: [
      { ts: "2026-09-01T09:00:00Z", entries: 5, exits: 1 },
      { ts: "2026-09-01T10:00:00Z", entries: 2, exits: 6 },
    ],
  }), async () => {
    const out = await getTraffic({ tenantId: "t1", tz: "UTC" });
    assert.strictEqual(out.totalEntries, 7);
    assert.strictEqual(out.totalExits, 7);
    assert.strictEqual(out.peakTraffic, 8); // max(5+1, 2+6)
    assert.strictEqual(out.series.length, 2);
  });
});

test("getHeatmap: returns a day x hour matrix with maxCell (AC 3.3, temporal only)", async () => {
  await withMockQuery(async () => ({
    rows: [
      { dow: 1, hour: 9, count: 3 },
      { dow: 1, hour: 10, count: 12 },
      { dow: 2, hour: 9, count: 5 },
    ],
  }), async () => {
    const out = await getHeatmap({ tenantId: "t1", tz: "UTC" });
    assert.strictEqual(out.maxCell, 12);
    assert.strictEqual(out.cells.length, 3);
    // Never a spatial coordinate field (map_x/map_y/map_angle) anywhere in
    // the shape — this is a temporal heatmap only (Non-goals).
    for (const cell of out.cells) {
      assert.ok(!("map_x" in cell) && !("map_y" in cell));
      assert.ok("dow" in cell && "hour" in cell);
    }
  });
});
