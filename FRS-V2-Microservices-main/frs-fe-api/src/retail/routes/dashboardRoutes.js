import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, canAccessStore } from '../middleware/authenticateUser.js';

const router = express.Router();
router.use(authenticateUser);

/**
 * GET /stores/:id/live
 * Returns real-time dashboard data:
 *   current_count, entries_today, exits_today, occupancy_pct,
 *   hourly breakdown, camera list, device list, warning_threshold
 */
router.get('/:id/live', asyncHandler(async (req, res) => {
  const storeId = req.params.id;
  if (!canAccessStore(req, storeId)) return res.status(404).json({ error: 'store_not_found' });

  // Verify store belongs to tenant
  const { rows: storeRows } = await pool.query(
    `SELECT id, name, max_capacity, warning_threshold, timezone
     FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [storeId, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });
  const store = storeRows[0];

  // Shift filter for MANAGER: only show data within shift window
  let shiftFilter = '';
  let shiftParams = [storeId];
  if (req.user.role === 'MANAGER' && req.user.shift_start && req.user.shift_end) {
    shiftFilter = `AND occurred_at::time BETWEEN $2 AND $3`;
    shiftParams = [storeId, req.user.shift_start, req.user.shift_end];
  }

  // Today's entries & exits — calendar day in the STORE's own timezone, not
  // a rolling 24h window. A rolling window silently pulls in yesterday's
  // events for however many hours are left before the store's local
  // midnight, making "Entries Today" match yesterday's totals whenever
  // today's real count is still low/zero. This must stay in sync with
  // /history's day-boundary logic below (also store-tz, not UTC).
  const { rows: todayCounts } = await pool.query(
    `SELECT direction, SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $${shiftParams.length + 1})::date = (NOW() AT TIME ZONE $${shiftParams.length + 1})::date
       ${shiftFilter}
     GROUP BY direction`,
    [...shiftParams, store.timezone]
  );

  const entries = todayCounts.find(r => r.direction === 'in')?.total ?? 0;
  const exits = todayCounts.find(r => r.direction === 'out')?.total ?? 0;

  // Current occupancy (latest snapshot)
  const { rows: occRows } = await pool.query(
    `SELECT current_count FROM occupancy_snapshots
     WHERE store_id = $1 ORDER BY snapshot_at DESC LIMIT 1`,
    [storeId]
  );
  const currentCount = occRows[0]?.current_count ?? 0;

  // Hourly breakdown — same calendar-day-in-store-timezone scope as
  // entries_today/exits_today above, not a rolling 24h window.
  const { rows: hourlyRows } = await pool.query(
    `SELECT EXTRACT(HOUR FROM occurred_at AT TIME ZONE $2)::int AS hour,
            direction,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
     GROUP BY hour, direction
     ORDER BY hour`,
    [storeId, store.timezone]
  );

  // Build hourly map
  const hourlyMap = {};
  for (const row of hourlyRows) {
    if (!hourlyMap[row.hour]) hourlyMap[row.hour] = { hour: row.hour, entries: 0, exits: 0 };
    if (row.direction === 'in') hourlyMap[row.hour].entries = row.total;
    if (row.direction === 'out') hourlyMap[row.hour].exits = row.total;
  }
  const hourly = Object.values(hourlyMap).sort((a, b) => a.hour - b.hour);

  // Cameras
  const { rows: cameras } = await pool.query(
    `SELECT id, name, position, status, last_seen FROM cameras
     WHERE store_id = $1 ORDER BY name`,
    [storeId]
  );

  // Devices
  const { rows: devices } = await pool.query(
    `SELECT id, external_id, status, last_heartbeat FROM edge_devices
     WHERE store_id = $1 ORDER BY external_id`,
    [storeId]
  );

  return res.json({
    store_id: storeId,
    store_name: store.name,
    current_count: currentCount,
    max_capacity: store.max_capacity,
    warning_threshold: store.warning_threshold,
    occupancy_pct: Math.round((currentCount / store.max_capacity) * 100),
    entries_today: entries,
    exits_today: exits,
    hourly,
    cameras,
    devices,
    synced_at: new Date().toISOString(),
  });
}));

/**
 * GET /stores/:id/history?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns aggregated daily counts for analytics charts.
 */
router.get('/:id/history', asyncHandler(async (req, res) => {
  const storeId = req.params.id;
  if (!canAccessStore(req, storeId)) return res.status(404).json({ error: 'store_not_found' });
  const { from, to } = req.query;

  const { rows: storeRows } = await pool.query(
    `SELECT id, timezone FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [storeId, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });
  const tz = storeRows[0].timezone;

  const fromDate = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const toDate = to || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT TO_CHAR((occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date,
            direction,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $3)::date BETWEEN $2::date AND $4::date
     GROUP BY date, direction
     ORDER BY date`,
    [storeId, fromDate, tz, toDate]
  );

  // Pivot into daily rows
  const dayMap = {};
  for (const r of rows) {
    const d = String(r.date);
    if (!dayMap[d]) dayMap[d] = { date: d, entries: 0, exits: 0 };
    if (r.direction === 'in') dayMap[d].entries = r.total;
    if (r.direction === 'out') dayMap[d].exits = r.total;
  }
  const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  // Hourly for range (for AreaChart)
  const { rows: hourlyRows } = await pool.query(
    `SELECT TO_CHAR((occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date,
            EXTRACT(HOUR FROM occurred_at AT TIME ZONE $3)::int AS hour,
            direction,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $3)::date BETWEEN $2::date AND $4::date
     GROUP BY date, hour, direction
     ORDER BY date, hour`,
    [storeId, fromDate, tz, toDate]
  );

  return res.json({ daily, hourly_detail: hourlyRows, from: fromDate, to: toDate });
}));

export { router as dashboardRoutes };
