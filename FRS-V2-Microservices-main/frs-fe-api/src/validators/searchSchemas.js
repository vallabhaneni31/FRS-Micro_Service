/**
 * searchSchemas.js — zod schemas + scope rules for search & search history (PERF-0005)
 */
import { z } from "zod";

/** Bucket used for super_admin (global) activity, which has no tenant. */
export const PLATFORM_TENANT = "_platform";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONLY fields persisted to search_history.params.
 * `.strict()` is load-bearing: it rejects any attempt to smuggle result rows,
 * faceIds, embeddings or photos into the history store (spec §4.2 / AC8).
 */
export const searchParamsSchema = z.object({
  deviceId:  z.string().optional(),
  eventType: z.string().optional(),
  startDate: z.string().optional(),
  endDate:   z.string().optional(),
  limit:     z.coerce.number().optional(),
}).strict();

/** Route param `:searchId` must be a uuid — never interpolated unvalidated. */
export const searchIdSchema = z.string().regex(UUID_RE, "searchId must be a uuid");

export function isValidTenantKey(value) {
  return value === PLATFORM_TENANT || UUID_RE.test(String(value || ""));
}

/**
 * Resolve the (tenantId, userId) a history row is scoped to.
 *
 * super_admin ALWAYS records under PLATFORM_TENANT regardless of any x-tenant-id
 * the client sends, so their history is stable across requests instead of
 * flapping with client input. A client-supplied literal '_platform' is rejected
 * so it cannot collide with that bucket (spec §4.3 / AC3).
 *
 * @returns {{tenantId?:string, userId?:string|number, error?:string}}
 */
export function resolveHistoryScope(req) {
  const claimed = req.headers?.["x-tenant-id"] ?? req.query?.["x-tenant-id"];
  if (claimed !== undefined && String(claimed) === PLATFORM_TENANT) {
    return { error: "invalid tenant" };
  }

  const userId = req.auth?.user?.id;
  if (userId === undefined || userId === null) return { error: "unauthenticated" };

  const roles = req.auth?.jwtPayload?.realm_access?.roles || [];
  const isSuperAdmin =
    roles.includes("super_admin") ||
    (Array.isArray(req.auth?.memberships) &&
      req.auth.memberships.length > 0 &&
      req.auth.memberships.every((m) => m?.tenantId == null));

  if (isSuperAdmin) return { tenantId: PLATFORM_TENANT, userId };

  const tenantId = req.auth?.scope?.tenantId ?? null;
  if (!isValidTenantKey(tenantId)) return { error: "invalid tenant" };
  return { tenantId: String(tenantId), userId };
}
