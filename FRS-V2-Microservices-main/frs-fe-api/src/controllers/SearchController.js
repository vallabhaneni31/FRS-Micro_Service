import { z } from "zod";
import searchService from "../services/business/SearchService.js";
import { searchParamsSchema, searchIdSchema, resolveHistoryScope } from "../validators/searchSchemas.js";

const SearchController = {
  async searchEvents(req, res) {
    const qs = searchParamsSchema.safeParse(req.query);
    if (!qs.success) return res.status(400).json({ message: "invalid query" });
    const data = await searchService.searchEvents(qs.data);

    // PERF-0005: auto-record the search server-side (best effort — a history
    // failure must never fail the search, so this is fire-and-forget).
    const scope = resolveHistoryScope(req);
    if (!scope.error) {
      searchService.recordSearch({ ...scope, params: qs.data }).catch(() => {});
    }

    return res.json({ data });
  },

  async advancedEventSearch(req, res) {
    const parsed = z.object({ filters: z.any(), limit: z.coerce.number().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.advancedEventSearch(parsed.data);
    return res.json({ data });
  },

  async getEventById(req, res) {
    const data = await searchService.getEventById({ eventId: String(req.params.id) });
    if (!data) return res.status(404).json({ message: "not found" });
    return res.json(data);
  },

  async searchByFace(req, res) {
    const parsed = z.object({ embedding: z.array(z.number()), profile: z.string().optional(), cameraId: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.searchByFace(parsed.data);
    return res.json({ data });
  },

  async batchFaceSearch(req, res) {
    const parsed = z.object({ embeddings: z.array(z.array(z.number())) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.batchFaceSearch(parsed.data);
    return res.json({ data });
  },

  async searchByAppearance(req, res) {
    const parsed = z.object({ attributes: z.any(), profile: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.searchByAppearance(parsed.data);
    return res.json({ data });
  },

  async searchByAttributes(req, res) {
    const parsed = z.object({ attributes: z.any() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.searchByAttributes(parsed.data);
    return res.json({ data });
  },

  async searchByVehicle(req, res) {
    const parsed = z.object({ attributes: z.any() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.searchByVehicle(parsed.data);
    return res.json({ data });
  },

  async searchByLicensePlate(req, res) {
    const parsed = z.object({ plate: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const data = await searchService.searchByLicensePlate(parsed.data);
    return res.json({ data });
  },

  async getSearchProfiles(_req, res) {
    return res.json({ profiles: [] });
  },
  async getSearchProfile(_req, res) {
    return res.json({ profile: null });
  },
  async createSearchProfile(_req, res) {
    return res.status(201).json({ ok: true });
  },
  async updateSearchProfile(_req, res) {
    return res.json({ ok: true });
  },
  async deleteSearchProfile(_req, res) {
    return res.json({ ok: true });
  },

  // ── Search history (PERF-0005) ───────────────────────────────────────────
  // Scoped by (tenantId, userId); `:searchId` is always uuid-validated so no
  // unvalidated identifier reaches SQL.

  async getSearchHistory(req, res) {
    const scope = resolveHistoryScope(req);
    if (scope.error) return res.status(400).json({ message: scope.error });
    const { limit = 20, offset = 0 } = req.pagination || {};
    const { data, total } = await searchService.listSearchHistory({ ...scope, limit, offset });
    return res.json({ data, total });
  },

  async getSearchHistoryEntry(req, res) {
    const scope = resolveHistoryScope(req);
    if (scope.error) return res.status(400).json({ message: scope.error });
    const id = searchIdSchema.safeParse(req.params.searchId);
    if (!id.success) return res.status(400).json({ message: "invalid searchId" });
    const entry = await searchService.getSearchHistoryEntry({ ...scope, searchId: id.data });
    if (!entry) return res.status(404).json({ message: "not found" });
    return res.json(entry);
  },

  /** Re-runs the stored query — no result rows are persisted (spec §4.2). */
  async getSearchResults(req, res) {
    const scope = resolveHistoryScope(req);
    if (scope.error) return res.status(400).json({ message: scope.error });
    const id = searchIdSchema.safeParse(req.params.searchId);
    if (!id.success) return res.status(400).json({ message: "invalid searchId" });
    const entry = await searchService.getSearchHistoryEntry({ ...scope, searchId: id.data });
    if (!entry) return res.status(404).json({ message: "not found" });
    const data = await searchService.searchEvents(entry.params || {});
    return res.json({ data });
  },

  async deleteSearchHistory(req, res) {
    const scope = resolveHistoryScope(req);
    if (scope.error) return res.status(400).json({ message: scope.error });
    const id = searchIdSchema.safeParse(req.params.searchId);
    if (!id.success) return res.status(400).json({ message: "invalid searchId" });
    const removed = await searchService.deleteSearchHistory({ ...scope, searchId: id.data });
    if (!removed) return res.status(404).json({ message: "not found" });
    return res.json({ success: true });
  },
};

export default SearchController;

