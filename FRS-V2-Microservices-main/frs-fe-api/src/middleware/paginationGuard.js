/**
 * S-06: Prevent unbounded pagination attacks.
 * Clamps `limit` to [1, maxLimit] and validates `page`/`offset`.
 */
export function paginationGuard({ maxLimit = 100, defaultLimit = 20 } = {}) {
  return (req, _res, next) => {
    const rawLimit  = parseInt(req.query.limit  ?? req.body?.limit  ?? String(defaultLimit), 10);
    const rawPage   = parseInt(req.query.page   ?? req.body?.page   ?? '1',                 10);
    const rawOffset = parseInt(req.query.offset ?? req.body?.offset ?? '0',                 10);

    req.pagination = {
      limit:  Number.isFinite(rawLimit)  ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit,
      page:   Number.isFinite(rawPage)   ? Math.max(rawPage, 1)  : 1,
      offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0): 0,
    };

    next();
  };
}

/**
 * S-06: Enforce a maximum date range on query parameters.
 * Supports configurable param names via fromParam/toParam (also startDate/endDate via startKey/endKey).
 * Returns 400 if the range exceeds maxDays.
 */
export function dateRangeGuard({ maxDays = 180, startKey, endKey, fromParam, toParam } = {}) {
  // Support both naming conventions
  const startParam = fromParam || startKey || 'startDate';
  const endParam   = toParam   || endKey   || 'endDate';

  return (req, res, next) => {
    const start = req.query[startParam] || req.body?.[startParam];
    const end   = req.query[endParam]   || req.body?.[endParam];

    if (start && end) {
      const startMs = Date.parse(start);
      const endMs   = Date.parse(end);

      if (isNaN(startMs) || isNaN(endMs)) {
        return res.status(400).json({ message: `Invalid date format for ${startParam}/${endParam}` });
      }
      if (endMs < startMs) {
        return res.status(400).json({ message: `${endParam} must be after ${startParam}` });
      }

      const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
      if (diffDays > maxDays) {
        return res.status(400).json({
          message: `Date range cannot exceed ${maxDays} days (requested ${Math.ceil(diffDays)} days)`,
        });
      }
    }

    next();
  };
}
