import smartSearchService from "../../core/services/SmartSearchValidationService.js";
import { query } from "../../db/pool.js";
import logger from "../../utils/logger.js";

/**
 * SearchService
 * Wraps smart search and event retrieval; records search history in Postgres.
 *
 * PERF-0005: history was previously two in-process Maps (lost on restart, invisible
 * across workers, and never written to). It is now the `search_history` table,
 * scoped by (tenant_id, fk_user_id) and holding query CRITERIA ONLY.
 */
class SearchService {

  /**
   * Basic event search.
   * @param {{deviceId?:string, eventType?:string, startDate?:string, endDate?:string, limit?:number}} params
   */
  async searchEvents({ deviceId, eventType, startDate, endDate, limit = 100 }) {
    let sql = `select * from device_events where 1=1`;
    const params = [];
    let idx = 1;
    if (deviceId) { sql += ` and fk_device_id = $${idx++}`; params.push(deviceId); }
    if (eventType) { sql += ` and event_type = $${idx++}`; params.push(eventType); }
    if (startDate) { sql += ` and occurred_at >= $${idx++}`; params.push(startDate); }
    if (endDate) { sql += ` and occurred_at <= $${idx++}`; params.push(endDate); }
    sql += ` order by occurred_at desc limit ${limit}`;
    const res = await query(sql, params);
    return res.rows;
  }

  /**
   * Advanced event search placeholder.
   * @param {{filters:any, limit?:number}} params
   */
  async advancedEventSearch({ filters, limit = 100 }) {
    return this.searchEvents({ ...filters, limit });
  }

  /**
   * Get event by ID.
   * @param {{eventId:string}} params
   */
  async getEventById({ eventId }) {
    const rows = await query(`select * from device_events where pk_event_id = $1`, [eventId]);
    return rows.rows[0] || null;
  }

  /**
   * Record a search that was just run. BEST-EFFORT: a failure here must never
   * fail the search itself (spec §4.4 / AC9), so it logs and resolves null.
   * @param {{tenantId:string, userId:string|number, params:object}} args
   */
  async recordSearch({ tenantId, userId, params }) {
    try {
      const res = await query(
        `insert into search_history (tenant_id, fk_user_id, params)
         values ($1, $2, $3::jsonb)
         returning pk_search_id, tenant_id, params, created_at`,
        [tenantId, userId, JSON.stringify(params ?? {})]
      );
      return res.rows[0] || null;
    } catch (err) {
      logger.warn({ err }, "[SearchService] failed to record search history (non-fatal)");
      return null;
    }
  }

  /**
   * List a user's recent searches, newest first. Honours pagination.
   * @param {{tenantId:string, userId:string|number, limit?:number, offset?:number}} args
   */
  async listSearchHistory({ tenantId, userId, limit = 20, offset = 0 }) {
    const res = await query(
      `select pk_search_id, params, created_at
         from search_history
        where tenant_id = $1 and fk_user_id = $2
        order by created_at desc
        limit $3 offset $4`,
      [tenantId, userId, limit, offset]
    );
    const countRes = await query(
      `select count(*)::int as total from search_history where tenant_id = $1 and fk_user_id = $2`,
      [tenantId, userId]
    );
    return { data: res.rows, total: countRes.rows[0]?.total ?? 0 };
  }

  /**
   * Fetch one history entry, scoped to its owner.
   * @param {{tenantId:string, userId:string|number, searchId:string}} args
   */
  async getSearchHistoryEntry({ tenantId, userId, searchId }) {
    const res = await query(
      `select pk_search_id, params, created_at
         from search_history
        where tenant_id = $1 and fk_user_id = $2 and pk_search_id = $3::uuid`,
      [tenantId, userId, searchId]
    );
    return res.rows[0] || null;
  }

  /**
   * Delete one history entry, scoped to its owner.
   * @returns {boolean} whether a row was removed
   */
  async deleteSearchHistory({ tenantId, userId, searchId }) {
    const res = await query(
      `delete from search_history
        where tenant_id = $1 and fk_user_id = $2 and pk_search_id = $3::uuid`,
      [tenantId, userId, searchId]
    );
    return res.rowCount > 0;
  }

  /**
   * Face search using SmartSearch.
   * @param {{embedding:number[], profile?:string, cameraId?:string}} params
   */
  async searchByFace({ embedding, profile, cameraId }) {
    return smartSearchService.searchFace({ embedding, profile, cameraId });
  }

  /**
   * Batch face search.
   * @param {{embeddings:number[][]}} params
   */
  async batchFaceSearch({ embeddings }) {
    const out = [];
    for (const e of embeddings || []) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.searchByFace({ embedding: e });
      out.push(r);
    }
    return out;
  }

  /**
   * Appearance search.
   * @param {{attributes:any, profile?:string}} params
   */
  async searchByAppearance({ attributes, profile }) {
    return smartSearchService.searchAppearance({ attributes, profile });
  }

  /**
   * Attribute-based search alias.
   * @param {{attributes:any}} params
   */
  async searchByAttributes({ attributes }) {
    return this.searchByAppearance({ attributes });
  }

  /**
   * Vehicle search.
   * @param {{attributes:any}} params
   */
  async searchByVehicle({ attributes }) {
    return smartSearchService.searchVehicle({ attributes });
  }

  /**
   * License plate search placeholder.
   * @param {{plate:string}} params
   */
  async searchByLicensePlate({ plate }) {
    return [];
  }
}

const searchService = new SearchService();
export default searchService;

