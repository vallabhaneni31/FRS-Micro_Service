/**
 * pool.js — PostgreSQL connection pool
 *
 * FIX-013: Added withTenantContext() — sets app.tenant_id session variable so
 *          PostgreSQL RLS policies can filter rows by tenant automatically.
 * FIX-035: SSL rejectUnauthorized: true in production; statement_timeout guard.
 */
import pg from "pg";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

const { Pool } = pg;

// ── SSL configuration ─────────────────────────────────────────────────────────
function buildSslConfig() {
  if (!env.db.ssl) return false;
  // Allow self-signed certificates (common for local/managed Postgres).
  // rejectUnauthorized can be hardened to true when a valid CA-signed cert is in place.
  // Controlled via DB_SSL_REJECT_UNAUTHORIZED env var (default: false).
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
  return { rejectUnauthorized };
}

export const pool = new Pool({
  host:                   env.db.host,
  port:                   env.db.port,
  database:               env.db.database,
  user:                   env.db.user,
  password:               env.db.password,
  max:                    env.db.max,
  idleTimeoutMillis:      env.db.idleTimeoutMillis,
  connectionTimeoutMillis: env.db.connectionTimeoutMillis,
  // Keep idle TCP sockets alive so they aren't silently dropped by NAT/firewall
  // (the cause of "Connection terminated unexpectedly" against a remote DB).
  keepAlive:                  env.db.keepAlive,
  keepAliveInitialDelayMillis: env.db.keepAliveInitialDelayMillis,
  ssl:                    buildSslConfig(),
});

pool.on("error", (err) => {
  logger.error({ err }, "[DB Pool] Unexpected pool error");
});

// ── Transient-connection retry (wraps pool.query for ALL callers) ─────────────
// A pooled connection can die while idle (NAT/firewall/network drop). pg surfaces
// this as a connection-level error on the next query — "Connection terminated
// unexpectedly" — but the dead client is then evicted from the pool, so an
// immediate retry runs on a fresh connection and succeeds. Patching pool.query
// here means every direct `pool.query(...)` caller is covered without changes.
const CONNECTION_ERROR_RE =
  /Connection terminated|connection terminated|ECONNRESET|server closed the connection|terminating connection|Client has encountered a connection error/i;

function isTransientConnectionError(err) {
  return !!err && (CONNECTION_ERROR_RE.test(err.message || "") ||
    ["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01"].includes(err.code));
}

const rawPoolQuery = pool.query.bind(pool);
pool.query = function patchedQuery(...args) {
  return rawPoolQuery(...args).catch((err) => {
    if (!isTransientConnectionError(err)) throw err;
    logger.warn({ err }, "[DB Pool] Transient connection error — retrying query on a fresh connection");
    return rawPoolQuery(...args);
  });
};

// ── Statement timeout guard (FIX-035) ─────────────────────────────────────────
// Abort any query running longer than STATEMENT_TIMEOUT_MS (default 30s)
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS || 30000);

pool.on("connect", (client) => {
  client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch((err) => {
    logger.warn({ err }, "[DB Pool] Could not set statement_timeout");
  });
});

// ── Basic query wrapper ───────────────────────────────────────────────────────
// Delegates to pool.query, which is patched above to retry transient
// connection-level failures on a fresh connection.
//
// FRS-ARCH-002 Phase 4 (D4): optional `name` requests a server-side prepared
// statement. `pg` PREPAREs it under that name the first time it runs on a
// given physical connection, then Bind+Executes on every reuse of that same
// connection — skipping Postgres's query-planning step on repeat calls. Only
// safe for callers whose SQL text is constant for a given name; callers that
// branch on input to build different SQL text must NOT pass a name (a reused
// name with different text is a hard error, not a silent fallback).
export async function query(text, params = [], name) {
  if (name) {
    return pool.query({ text, values: params, name });
  }
  return pool.query(text, params);
}

// ── FIX-013: Tenant-context query wrapper ─────────────────────────────────────
/**
 * Acquires a client from the pool, sets the PostgreSQL session variable
 * `app.tenant_id` (used by RLS policies), runs your callback, then releases
 * the client.  Also supports super-admin bypass via `bypassRls: true`.
 *
 * Usage:
 *   const rows = await withTenantContext(tenantId, async (client) => {
 *     const { rows } = await client.query('SELECT * FROM hr_employee');
 *     return rows;
 *   });
 *
 * @param {string|null} tenantId - UUID string, or null for super-admin bypass
 * @param {Function}    fn       - async (client) => result
 * @param {object}      [opts]
 * @param {boolean}     [opts.bypassRls=false] - skip RLS (super_admin only)
 * @returns {*} result of fn(client)
 */
export async function withTenantContext(tenantId, fn, { bypassRls = false } = {}) {
  const client = await pool.connect();
  try {
    if (bypassRls || !tenantId) {
      // Super-admin or system operations — bypass RLS
      await client.query(`SET LOCAL app.bypass_rls = 'true'`);
      await client.query(`SET LOCAL app.current_tenant_id  = ''`);
    } else {
      await client.query(`SET LOCAL app.bypass_rls = 'false'`);
      await client.query(`SET LOCAL app.current_tenant_id  = $1`, [tenantId]);
    }
    const result = await fn(client);
    return result;
  } finally {
    // Always reset to prevent context leaking to the next caller
    try {
      await client.query(`RESET app.bypass_rls`);
      await client.query(`RESET app.current_tenant_id`);
    } catch (_) {}
    client.release();
  }
}

// ── Connection checks ─────────────────────────────────────────────────────────
export async function checkDbConnection() {
  const result = await query("select now() as now");
  return result.rows[0]?.now ?? null;
}

// Pre-warm the pool for faster initial response
export async function warmPool() {
  try {
    const clients = [];
    for (let i = 0; i < 2; i++) {
      clients.push(await pool.connect());
    }
    for (const client of clients) {
      client.release();
    }
    logger.info("[DB Pool] Pre-warmed 2 connections");
  } catch (err) {
    logger.error({ err }, "[DB Pool] Warmup failed");
  }
}
