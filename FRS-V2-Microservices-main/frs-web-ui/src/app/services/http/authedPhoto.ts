import { useEffect, useState } from "react";
import { authConfig } from "../../config/authConfig";
import { tokenStorage } from "../auth/tokenStorage";
import keycloak from "../auth/keycloakInstance";

/**
 * Resolve a stored photo path (as returned by the API — e.g.
 * checkin_photo_url, photo_path) to an absolute URL against the backend.
 * Does NOT attach auth — the /uploads mount requires a Bearer token
 * (see server.js), so callers must fetch via useAuthedPhotoUrl below rather
 * than dropping this straight into an <img src>.
 */
export const resolvePhotoPath = (p: string): string => {
  if (!p) return "";
  if (p.startsWith("http")) return p;
  const cleanPath = p.startsWith("/") ? p : `/${p}`;
  if (cleanPath.startsWith("/uploads")) {
    return `${authConfig.apiBaseUrl.replace(/\/api$/, "")}${cleanPath}`;
  }
  // Already a fully-qualified API path (e.g. a specific embedding's own
  // /api/employees/:id/embeddings/:embeddingId/photo route) — pass
  // through as-is. Must NOT fall into the bare-filename branch below,
  // which strips everything but the last path segment; that's correct
  // for a raw filename but would mangle an already-complete route.
  if (cleanPath.startsWith("/api/")) {
    return `${authConfig.apiBaseUrl.replace(/\/api$/, "")}${cleanPath}`;
  }
  return `${authConfig.apiBaseUrl}/jetson/photos/${p.split("/").pop()}`;
};


// The rest of the app (apiClient.ts) is httpOnly-cookie based in api/keycloak
// mode — tokenStorage.getTokens() always returns null there by design. The
// live access token in Keycloak mode only ever lives on the keycloak-js
// instance (keycloak.token), refreshed via keycloak.updateToken(). /uploads
// requires an actual Authorization header (cookies alone 401 — see
// server.js's requireAuth), so we must pull the token from there, not
// tokenStorage, which is mock-mode-only.
//
// A single page (e.g. an attendance table) can mount dozens of thumbnails at
// once, each calling this concurrently. keycloak-js's updateToken() isn't
// safe to fire dozens of times in parallel — overlapping refresh calls were
// observed racing and occasionally resolving with no token at all, producing
// sporadic 401s alongside otherwise-successful sibling requests. Collapse
// concurrent callers onto one in-flight refresh, same pattern as apiClient's
// _refreshPromise.
let _tokenPromise: Promise<string | null> | null = null;

async function getBearerToken(): Promise<string | null> {
  if (authConfig.mode === "mock") return tokenStorage.getTokens().accessToken;
  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    try {
      await keycloak.updateToken(30);
    } catch {
      // refresh failed (expired refresh token / KC unreachable) — fall through
      // with whatever's on the instance, if anything.
    }
    return keycloak.token ?? null;
  })();

  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

// Small in-memory cache so the same photo isn't re-fetched (and re-decoded
// into a new blob) every time a component re-renders or remounts.
const blobUrlCache = new Map<string, string>();

// A table row of thumbnails mounts dozens of these at once (e.g. the Visitor
// Directory fires ~50 concurrently on load, with no limit), which was
// implicated in browser-side HTTP/2 stream exhaustion (net::ERR_HTTP2_PROTOCOL_ERROR)
// and unrelated requests getting stuck queued behind the flood. Cap how many
// photo fetches are actually in flight at once; the rest wait their turn.
const MAX_CONCURRENT_PHOTO_FETCHES = 6;
let activePhotoFetches = 0;
const photoFetchQueue: Array<() => void> = [];

function acquirePhotoFetchSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      activePhotoFetches++;
      resolve(() => {
        activePhotoFetches--;
        const next = photoFetchQueue.shift();
        if (next) next();
      });
    };
    if (activePhotoFetches < MAX_CONCURRENT_PHOTO_FETCHES) {
      tryAcquire();
    } else {
      photoFetchQueue.push(tryAcquire);
    }
  });
}

// A 401 here can be a genuinely stale/expired token rather than a real
// access denial (e.g. a Keycloak silent-refresh hiccup between two clicks,
// not covered by the concurrent-call dedup above since the calls aren't
// overlapping). Force a fresh token and retry exactly once before giving up —
// mirrors apiClient.ts's 401-triggers-refresh-and-retry pattern.
async function fetchPhotoBlob(resolved: string): Promise<Blob> {
  const release = await acquirePhotoFetchSlot();
  try {
    const token = await getBearerToken();
    // no-store: a photo can genuinely 404 for the first second or two after an
    // event lands (S3 write + DB write happen asynchronously in a Kafka
    // consumer, off the request path — see workers/deviceEventConsumer.js).
    // The backend now avoids caching that 404 (see jetsonRoutes.js /
    // server.js's /uploads S3 fallback), but no-store here is defense in
    // depth against any intermediary that would otherwise cache it anyway.
    let res = await fetch(resolved, {
      credentials: "include",
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (res.status === 401) {
      try {
        await keycloak.updateToken(-1); // force: always fetch a new token
      } catch {
        // fall through — retry with whatever's on the instance, if anything
      }
      const retryToken = keycloak.token ?? null;
      res = await fetch(resolved, {
        credentials: "include",
        cache: "no-store",
        headers: retryToken ? { Authorization: `Bearer ${retryToken}` } : {},
      });
    }

    if (!res.ok) throw new Error(`photo fetch failed: ${res.status}`);
    return res.blob();
  } finally {
    release();
  }
}

/**
 * Fetches a protected photo (attendance/enrollment snapshot under /uploads)
 * with the current Bearer token and exposes it as an object URL suitable
 * for <img src>. The /uploads mount requires requireAuth + scope/permission
 * checks (locked down as part of the IDOR fix), so a plain <img src="/uploads/...">
 * always 401s — the browser has no way to attach an Authorization header to
 * an <img> request.
 */
export function useAuthedPhotoUrl(path: string | null | undefined): {
  url: string | null;
  loading: boolean;
  error: boolean;
} {
  const resolved = path ? resolvePhotoPath(path) : null;
  const [url, setUrl] = useState<string | null>(
    resolved ? blobUrlCache.get(resolved) ?? null : null
  );
  const [loading, setLoading] = useState(!!resolved && !blobUrlCache.has(resolved));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!resolved) {
      setUrl(null);
      setLoading(false);
      setError(false);
      return;
    }

    const cached = blobUrlCache.get(resolved);
    if (cached) {
      setUrl(cached);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(false);

    // Bounded retry with backoff: the photo for a just-happened punch can
    // still be a second or two from landing in S3 (async Kafka-consumer
    // upload pipeline, not part of the request that created the attendance
    // row). Without this, a fetch that lost that race set `error` once and
    // never tried again for this component instance, since this effect only
    // re-runs when `resolved` itself changes — leaving the thumbnail stuck
    // on the placeholder icon even after the photo became available.
    const RETRY_DELAYS_MS = [1000, 2000, 4000];

    const attempt = async (retryIndex: number) => {
      try {
        const blob = await fetchPhotoBlob(resolved);
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        blobUrlCache.set(resolved, objectUrl);
        setUrl(objectUrl);
        setLoading(false);
        setError(false);
      } catch {
        if (cancelled) return;
        if (retryIndex < RETRY_DELAYS_MS.length) {
          timer = setTimeout(() => attempt(retryIndex + 1), RETRY_DELAYS_MS[retryIndex]);
          return;
        }
        setError(true);
        setLoading(false);
      }
    };

    attempt(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [resolved]);

  return { url, loading, error };
}

/**
 * Non-hook variant for imperative call sites (e.g. a click handler that
 * builds a DOM node directly rather than rendering React).
 */
export async function fetchAuthedPhotoBlobUrl(path: string): Promise<string | null> {
  const resolved = resolvePhotoPath(path);
  const cached = blobUrlCache.get(resolved);
  if (cached) return cached;
  try {
    const objectUrl = URL.createObjectURL(await fetchPhotoBlob(resolved));
    blobUrlCache.set(resolved, objectUrl);
    return objectUrl;
  } catch {
    return null;
  }
}
