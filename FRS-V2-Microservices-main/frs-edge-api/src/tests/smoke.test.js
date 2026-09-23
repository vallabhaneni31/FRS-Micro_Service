/**
 * smoke.test.js — placeholder so `npm test` has something to run.
 *
 * Real test coverage (device auth, event ingest, attendance ingest, etc.)
 * from frs-core-api/backend/api/src/tests/ was NOT ported as part of the
 * repo split — it exercises a live Postgres/Kafka the split task didn't set
 * up. Porting relevant suites (attendance*.test.js, deviceRateLimit.test.js)
 * is a follow-up, not done here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('placeholder — edge-api test suite not yet ported', () => {
  assert.equal(1 + 1, 2);
});
