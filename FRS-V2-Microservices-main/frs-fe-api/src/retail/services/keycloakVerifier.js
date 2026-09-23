import { createLocalJWKSet, jwtVerify, decodeJwt } from 'jose';

// KEYCLOAK_REALM_URL looks like "https://<host>/auth/realms/<default-realm>".
// Retail users can live in per-tenant realms (see authenticateUser.js path 3),
// so we derive the base Keycloak URL (protocol+host+/auth) and fetch JWKS
// dynamically per-realm, the same pattern backend/api's keycloakVerifier.js
// uses — never trust the realm in an unverified token without checking its
// signature against that realm's own signing keys first.
function getKeycloakBaseUrl() {
  const raw = process.env.KEYCLOAK_REALM_URL;
  if (!raw) throw new Error('KEYCLOAK_REALM_URL is required to verify Keycloak tokens');
  const idx = raw.indexOf('/realms/');
  return idx === -1 ? raw : raw.slice(0, idx);
}

/**
 * Dynamic per-realm JWKS cache, mirroring backend/api's keycloakVerifier.js.
 * Key -> realmSlug, Value -> { jwks, expiry }
 */
const jwksCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getSigningJWKSForRealm(realmSlug) {
  const cached = jwksCache.get(realmSlug);
  if (cached && Date.now() < cached.expiry) {
    return cached.jwks;
  }

  const url = `${getKeycloakBaseUrl()}/realms/${realmSlug}/protocol/openid-connect/certs`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`Failed to fetch JWKS: ${resp.status}`);

    const jwks = await resp.json();
    const signingKeys = (jwks.keys || []).filter((k) => !k.use || k.use === 'sig');
    if (signingKeys.length === 0) throw new Error('No signing keys found in Keycloak JWKS');

    const localJWKSet = createLocalJWKSet({ keys: signingKeys });
    jwksCache.set(realmSlug, { jwks: localJWKSet, expiry: Date.now() + CACHE_TTL_MS });
    return localJWKSet;
  } catch (err) {
    if (cached) {
      console.warn(`[keycloakVerifier] JWKS fetch failed for realm ${realmSlug} (${err.message}), using stale cache`);
      cached.expiry = Date.now() + 30_000; // extend 30s
      return cached.jwks;
    }
    throw Object.assign(err, { _jwksFetchFailed: true });
  }
}

/**
 * Verify a Keycloak JWT access token dynamically across whichever realm it
 * claims to be from. Throws if the signature/issuer don't check out — the
 * caller must not trust any claim from the token until this resolves.
 *
 * @returns {Promise<{payload: object, realmSlug: string}>}
 */
export async function verifyKeycloakToken(accessToken) {
  // 1. Decode header/payload WITHOUT verifying signature, only to learn which
  //    realm's JWKS to check it against.
  const decoded = decodeJwt(accessToken);
  if (!decoded.iss) throw new Error('JWT missing issuer (iss) claim');

  const issMatch = decoded.iss.match(/\/realms\/([^/]+)/);
  const realmSlug = issMatch ? issMatch[1] : null;
  if (!realmSlug) throw new Error(`Invalid Keycloak issuer format: ${decoded.iss}`);

  // 2. Fetch that realm's real signing keys and verify signature + issuer.
  const jwks = await getSigningJWKSForRealm(realmSlug);
  const { payload } = await jwtVerify(accessToken, jwks, {
    issuer: decoded.iss,
    clockTolerance: 5,
  });

  if (!payload.sub) throw new Error('JWT missing required claim: sub');

  return { payload, realmSlug };
}
