import express from "express";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { paginationGuard } from "../middleware/paginationGuard.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import SearchController from "../controllers/SearchController.js";

const router = express.Router();
router.use(requireAuth);

const ac = (fn) => asyncHandler(fn);

// S-06: minimum 2-char query guard applied to text-search endpoints
function minQueryLength(req, res, next) {
  const q = (req.query.q || "").trim();
  if (q.length > 0 && q.length < 2) {
    return res.status(400).json({ error: "Search term must be at least 2 characters" });
  }
  next();
}

router.get(
  "/events",
  requirePermission("analytics.read"),
  minQueryLength,
  paginationGuard({ defaultLimit: 20, maxLimit: 100 }),
  ac(SearchController.searchEvents)
);

router.get(
  "/events/advanced",
  requirePermission("analytics.read"),
  minQueryLength,
  paginationGuard({ defaultLimit: 20, maxLimit: 100 }),
  ac(SearchController.advancedEventSearch)
);

router.get("/events/:id", requirePermission("analytics.read"), ac(SearchController.getEventById));

router.post("/face", requirePermission("analytics.read"), ac(SearchController.searchByFace));
router.post("/face/batch", requirePermission("analytics.read"), ac(SearchController.batchFaceSearch));
router.post("/appearance", requirePermission("analytics.read"), ac(SearchController.searchByAppearance));
router.post("/appearance/attributes", requirePermission("analytics.read"), ac(SearchController.searchByAttributes));
router.post("/vehicle", requirePermission("analytics.read"), ac(SearchController.searchByVehicle));
router.post("/vehicle/plate", requirePermission("analytics.read"), ac(SearchController.searchByLicensePlate));

router.get("/profiles", requirePermission("analytics.read"), ac(SearchController.getSearchProfiles));
router.get("/profiles/:profileId", requirePermission("analytics.read"), ac(SearchController.getSearchProfile));
router.post("/profiles", requirePermission("analytics.read"), ac(SearchController.createSearchProfile));
router.put("/profiles/:profileId", requirePermission("analytics.read"), ac(SearchController.updateSearchProfile));
router.delete("/profiles/:profileId", requirePermission("analytics.read"), ac(SearchController.deleteSearchProfile));

router.get(
  "/history",
  requirePermission("analytics.read"),
  paginationGuard({ defaultLimit: 20, maxLimit: 100 }),
  ac(SearchController.getSearchHistory)
);

// PERF-0005: `/history/:searchId/save` was removed — searches are auto-recorded
// server-side, so an explicit client "save" is redundant (and it discarded its
// :searchId anyway). Register the more specific /results path before /:searchId.
router.get("/history/:searchId/results", requirePermission("analytics.read"), ac(SearchController.getSearchResults));
router.get("/history/:searchId", requirePermission("analytics.read"), ac(SearchController.getSearchHistoryEntry));
router.delete("/history/:searchId", requirePermission("analytics.read"), ac(SearchController.deleteSearchHistory));

export { router as searchRoutes };
