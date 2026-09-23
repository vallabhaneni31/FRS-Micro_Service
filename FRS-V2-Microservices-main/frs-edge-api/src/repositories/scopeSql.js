/**
 * buildScopeWhere — generate a parameterized WHERE fragment from a resolved scope.
 *
 * Super admin scope has tenantId = null.  In that case the tenant_id predicate is
 * omitted entirely so the query returns rows across all tenants (global visibility).
 * Sub-tenant filters (customer/site/unit) are still applied when provided.
 */
export function buildScopeWhere(scope, alias = "", useArrayForSite = false) {
  const s = scope || {};
  const prefix = alias ? `${alias}.` : "";
  const clauses = [];
  const values = [];

  // tenant_id is UUID — skip clause for super admin (null = global access)
  if (s.tenantId !== null && s.tenantId !== undefined) {
    values.push(s.tenantId);
    clauses.push(`${prefix}tenant_id = $${values.length}::uuid`);
  }

  // customer_id, site_id, unit_id are bigints
  // Match exact value OR NULL (tenant-level records visible to all sites within tenant)
  if (s.customerId) {
    values.push(Number(s.customerId));
    clauses.push(`(${prefix}customer_id = $${values.length} OR ${prefix}customer_id IS NULL)`);
  }
  if (s.siteId) {
    values.push(Number(s.siteId));
    if (useArrayForSite) {
      clauses.push(`($${values.length} = ANY(${prefix}site_ids))`);
    } else {
      clauses.push(`(${prefix}site_id = $${values.length})`);
    }
  } else if (s.allowedSiteIds && s.allowedSiteIds.length > 0) {
    const siteIdsList = s.allowedSiteIds.join(',');
    if (useArrayForSite) {
      clauses.push(`(ARRAY[${siteIdsList}]::bigint[] && ${prefix}site_ids)`);
    } else {
      clauses.push(`(${prefix}site_id IN (${siteIdsList}))`);
    }
  }
  if (s.unitId) {
    values.push(Number(s.unitId));
    clauses.push(`(${prefix}unit_id = $${values.length} OR ${prefix}unit_id IS NULL)`);
  }

  // If no clauses at all (super admin, no sub-scope filters) return TRUE so
  // the query compiles: "WHERE TRUE" or the caller can omit the WHERE entirely.
  if (clauses.length === 0) {
    return { whereSql: "TRUE", values: [] };
  }

  return { whereSql: clauses.join(" AND "), values };
}
