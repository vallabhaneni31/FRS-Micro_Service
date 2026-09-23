import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, canAccessStore } from '../middleware/authenticateUser.js';

const router = express.Router();
router.use(authenticateUser);

/**
 * GET /stores/:id/reports?days=90
 * 90-day daily report data for Table/Timeline/Calendar/Graph views.
 */
router.get('/:id/reports', asyncHandler(async (req, res) => {
  const storeId = req.params.id;
  if (!canAccessStore(req, storeId)) return res.status(404).json({ error: 'store_not_found' });
  const days = Math.min(parseInt(req.query.days ?? '90', 10), 365);

  const { rows: storeRows } = await pool.query(
    `SELECT id, timezone, max_capacity FROM stores
     WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [storeId, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });
  const { timezone, max_capacity } = storeRows[0];

  // Daily aggregates — cast date to text to avoid JS timezone shifting
  const { rows: dailyRows } = await pool.query(
    `SELECT to_char((occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date,
            direction,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND occurred_at >= NOW() - ($2 || ' days')::interval
     GROUP BY date, direction
     ORDER BY date DESC`,
    [storeId, days, timezone]
  );

  // Peak hour per day
  const { rows: peakRows } = await pool.query(
    `SELECT to_char((occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date,
            EXTRACT(HOUR FROM occurred_at AT TIME ZONE $3)::int AS hour,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND occurred_at >= NOW() - ($2 || ' days')::interval
     GROUP BY date, hour
     ORDER BY date DESC, total DESC`,
    [storeId, days, timezone]
  );

  // Avg occupancy per day (from snapshots)
  const { rows: occRows } = await pool.query(
    `SELECT to_char((snapshot_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date,
            ROUND(AVG(current_count))::int AS avg_occupancy
     FROM occupancy_snapshots
     WHERE store_id = $1
       AND snapshot_at >= NOW() - ($2 || ' days')::interval
     GROUP BY date`,
    [storeId, days, timezone]
  );

  // Pivot daily (date is already YYYY-MM-DD string from to_char)
  const dayMap = {};
  for (const r of dailyRows) {
    const d = r.date;
    if (!dayMap[d]) dayMap[d] = { date: d, day: new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'}), entries: 0, exits: 0 };
    if (r.direction === 'in')  dayMap[d].entries = r.total;
    if (r.direction === 'out') dayMap[d].exits   = r.total;
  }

  // Attach peak hour (first row per date = highest total)
  const peakByDay = {};
  for (const r of peakRows) {
    if (!peakByDay[r.date]) peakByDay[r.date] = r.hour;
  }

  // Attach avg occupancy
  const occByDay = {};
  for (const r of occRows) occByDay[r.date] = r.avg_occupancy;

  const reports = Object.values(dayMap).map(d => ({
    ...d,
    peak_hour: peakByDay[d.date] ?? null,
    avg_occupancy: occByDay[d.date] ?? 0,
    avg_occupancy_pct: occByDay[d.date]
      ? Math.round((occByDay[d.date] / max_capacity) * 100)
      : 0,
  })).sort((a,b) => b.date.localeCompare(a.date));

  return res.json({ reports, days });
}));

/**
 * GET /stores/:id/reports/:date — single day drill-down
 */
router.get('/:id/reports/:date', asyncHandler(async (req, res) => {
  const storeId   = req.params.id;
  if (!canAccessStore(req, storeId)) return res.status(404).json({ error: 'store_not_found' });
  const dateParam = req.params.date; // YYYY-MM-DD

  const { rows: storeRows } = await pool.query(
    `SELECT id, timezone, max_capacity FROM stores
     WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [storeId, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });
  const { timezone, max_capacity } = storeRows[0];

  // Totals for the day
  const { rows: totals } = await pool.query(
    `SELECT direction, SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $3)::date = $2::date
     GROUP BY direction`,
    [storeId, dateParam, timezone]
  );

  const entries = totals.find(r => r.direction === 'in')?.total ?? 0;
  const exits   = totals.find(r => r.direction === 'out')?.total ?? 0;

  // Hourly breakdown
  const { rows: hourly } = await pool.query(
    `SELECT EXTRACT(HOUR FROM occurred_at AT TIME ZONE $3)::int AS hour,
            direction,
            SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $3)::date = $2::date
     GROUP BY hour, direction
     ORDER BY hour`,
    [storeId, dateParam, timezone]
  );

  const hourlyMap = {};
  for (const r of hourly) {
    if (!hourlyMap[r.hour]) hourlyMap[r.hour] = { hour: r.hour, entries: 0, exits: 0 };
    if (r.direction === 'in')  hourlyMap[r.hour].entries = r.total;
    if (r.direction === 'out') hourlyMap[r.hour].exits   = r.total;
  }

  // Avg occupancy
  const { rows: occRows } = await pool.query(
    `SELECT ROUND(AVG(current_count))::int AS avg_occ,
            MAX(current_count) AS peak_occ
     FROM occupancy_snapshots
     WHERE store_id = $1
       AND (snapshot_at AT TIME ZONE $3)::date = $2::date`,
    [storeId, dateParam, timezone]
  );

  const avgOcc  = occRows[0]?.avg_occ  ?? 0;
  const peakOcc = occRows[0]?.peak_occ ?? 0;

  // Previous week same day for comparison
  const prevDate = new Date(dateParam);
  prevDate.setDate(prevDate.getDate() - 7);
  const prevStr = prevDate.toISOString().slice(0,10);

  const { rows: prevTotals } = await pool.query(
    `SELECT direction, SUM(count)::int AS total
     FROM people_count_events
     WHERE store_id = $1
       AND (occurred_at AT TIME ZONE $3)::date = $2::date
     GROUP BY direction`,
    [storeId, prevStr, timezone]
  );
  const prevEntries = prevTotals.find(r => r.direction === 'in')?.total ?? 0;

  const hourlyList = Object.values(hourlyMap).sort((a,b) => a.hour - b.hour);
  const peakHour   = hourlyList.reduce((best, h) => h.entries > (best?.entries ?? 0) ? h : best, null);

  return res.json({
    date: dateParam,
    totals: { entries, exits, total_visits: entries },
    avg_occupancy: avgOcc,
    avg_occupancy_pct: Math.round((avgOcc / max_capacity) * 100),
    peak_occupancy: peakOcc,
    hourly: hourlyList,
    peak_hour: peakHour?.hour ?? null,
    vs_last_week: {
      date: prevStr,
      entries: prevEntries,
      change_pct: prevEntries ? Math.round(((entries - prevEntries) / prevEntries) * 100) : null,
    },
  });
}));

export { router as reportRoutes };
