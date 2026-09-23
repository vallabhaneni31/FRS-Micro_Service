interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Default TTL in milliseconds for safe GET endpoints. */
export const DEFAULT_TTL_MS = 30_000;

/** Paths where caching is explicitly disabled (auth, write-heavy, real-time, identity/manifest, attendance). */
const NEVER_CACHE = ['/auth/', '/enroll/', '/socket.io/', '/live/', '/me/manifest', '/attendance/'];

export function isCacheable(path: string, method = 'GET'): boolean {
    if (method !== 'GET') return false;
    return !NEVER_CACHE.some(prefix => path.includes(prefix));
}

export function cacheGet<T>(key: string): T | null {
    const entry = store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
    }
    return entry.data;
}

export function cacheSet<T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void {
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Invalidate all cached entries whose key starts with the given prefix. */
export function invalidatePrefix(prefix: string): void {
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
    }
}

/** Clear the entire cache (e.g., on logout). */
export function clearCache(): void {
    store.clear();
}
