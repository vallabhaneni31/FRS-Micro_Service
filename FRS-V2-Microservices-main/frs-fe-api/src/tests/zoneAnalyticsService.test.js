/**
 * specs/0003-zone-analytics — Task 5: ZoneAnalyticsService shaping/validation.
 */
import test from "node:test";
import assert from "node:assert";
import * as svc from "../services/business/ZoneAnalyticsService.js";

test("parseFilters: requires tenant scope (Req 2.4)", () => {
  assert.throws(() => svc.parseFilters({}, { tenantId: null }), svc.ValidationError);
});

test("parseFilters: rejects malformed dates and fromDate after toDate", () => {
  assert.throws(() => svc.parseFilters({ fromDate: "09-01-2026" }, { tenantId: "t1" }), svc.ValidationError);
  assert.throws(
    () => svc.parseFilters({ fromDate: "2026-09-10", toDate: "2026-09-01" }, { tenantId: "t1" }),
    svc.ValidationError
  );
});

test("parseFilters: normalizes repeatable zone/entryPointId/departmentId query params to arrays", () => {
  const out = svc.parseFilters({ zone: "Cafeteria" }, { tenantId: "t1" });
  assert.deepStrictEqual(out.zones, ["Cafeteria"]);

  const out2 = svc.parseFilters({ zone: ["Cafeteria", "Lobby"] }, { tenantId: "t1" });
  assert.deepStrictEqual(out2.zones, ["Cafeteria", "Lobby"]);

  const out3 = svc.parseFilters({}, { tenantId: "t1" });
  assert.deepStrictEqual(out3.zones, []);
  assert.deepStrictEqual(out3.entryPointIds, []);
  assert.deepStrictEqual(out3.departmentIds, []);
});

test("compareZones: throws ValidationError when fewer than 2 zones supplied (AC 8.2)", async () => {
  await assert.rejects(() => svc.compareZones({ tenantId: "t1", zones: ["Lobby"] }), svc.ValidationError);
  await assert.rejects(() => svc.compareZones({ tenantId: "t1", zones: [] }), svc.ValidationError);
});
