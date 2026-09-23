import { createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import logger from '../utils/logger.js';

/**
 * Dynamic per-realm JWKS cache.
 * Key -> realmSlug
 * Value -> { jwks, expiry }
 */
const jwksCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getSigningJWKSForRealm(realmSlug) {
    const cached = jwksCache.get(realmSlug);
    if (cached && Date.now() < cached.expiry) {
        return cached.jwks;
    }

    const url = `${env.keycloak.url}/realms/${realmSlug}/protocol/openid-connect/certs`;
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) throw new Error(`Failed to fetch JWKS: ${resp.status}`);

        const jwks = await resp.json();
        const signingKeys = (jwks.keys || []).filter(k => !k.use || k.use === 'sig');
        if (signingKeys.length === 0) throw new Error('No signing keys found in Keycloak JWKS');

        const localJWKSet = createLocalJWKSet({ keys: signingKeys });
        jwksCache.set(realmSlug, {
            jwks: localJWKSet,
            expiry: Date.now() + CACHE_TTL_MS
        });
        return localJWKSet;
    } catch (err) {
        if (cached) {
            logger.warn(`[keycloakVerifier] JWKS fetch failed for realm ${realmSlug} (${err.message}), using stale cache`);
            cached.expiry = Date.now() + 30_000; // Extend 30s
            return cached.jwks;
        }
        throw Object.assign(err, { _jwksFetchFailed: true });
    }
}

/**
 * Verify a Keycloak JWT access token dynamically across multiple realms.
 */
export async function verifyKeycloakToken(accessToken) {
    // 1. Decode token header/payload without verifying signature to extract issuer
    const decoded = decodeJwt(accessToken);
    if (!decoded.iss) throw new Error("JWT missing issuer (iss) claim");

    // 2. Parse realm slug from issuer URL
    const issMatch = decoded.iss.match(/\/realms\/([^/]+)/);
    const realmSlug = issMatch ? issMatch[1] : null;
    if (!realmSlug) throw new Error(`Invalid Keycloak issuer format: ${decoded.iss}`);

    // 3. Validate realm in database and resolve tenant_id
    let tenantId = decoded.tenant_id ?? null;
    if (realmSlug !== env.keycloak.realm) {
        const dbRes = await query(
            'SELECT fk_tenant_id FROM tenant_realm WHERE realm_slug = $1 LIMIT 1',
            [realmSlug]
        );
        if (dbRes.rows.length === 0) {
            throw new Error(`Realm ${realmSlug} is not registered in this system`);
        }
        tenantId = dbRes.rows[0].fk_tenant_id;
    }

    // 4. Retrieve certs dynamically for this realm
    const jwks = await getSigningJWKSForRealm(realmSlug);

    // 5. Verify signature + issuer
    const { payload } = await jwtVerify(accessToken, jwks, {
        issuer: decoded.iss,
        clockTolerance: env.keycloak.clockToleranceSec ?? 5,
    });

    // 6. Audience check. In strict mode the configured audience is required;
    //    otherwise Keycloak's default "account" audience is also accepted so
    //    realms without an audience mapper keep working (see env.strictAudience).
    if (payload.aud !== undefined) {
        const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        const expected = env.keycloak.audience || "attendance-api";
        const allowed = env.keycloak.strictAudience ? [expected] : ["account", expected];
        if (!audList.some(a => allowed.includes(a))) {
            throw new Error(`JWT audience mismatch: got [${audList.join(", ")}], expected ${expected}`);
        }
    }

    if (!payload.sub) throw new Error("JWT missing required claim: sub");

    // 7. Inject validated tenant_id into payload
    payload.tenant_id = tenantId;

    return payload;
}

