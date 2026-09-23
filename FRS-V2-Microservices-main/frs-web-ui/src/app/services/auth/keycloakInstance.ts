import Keycloak from "keycloak-js";
import { authConfig } from "../../config/authConfig";

/**
 * Derive the tenant realm from the host's first subdomain label
 * (e.g. `acme.frs.example.com` → `acme`). Returns null for apex domains,
 * `www`/`app`, localhost, and bare IPs so we fall back to other sources.
 * Exported so the login UI can skip the manual slug prompt when the tenant
 * is already implied by the URL.
 */
export function realmFromSubdomain(): string | null {
  const host = window.location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;

  const reserved = new Set(["www", "app"]);

  // Local dev: browsers resolve *.localhost to loopback, so visiting
  // http://acme.localhost:5173 exercises the real subdomain-tenancy path
  // without DNS. Bare "localhost" has no tenant → manual field.
  if (host === "localhost") return null;
  if (host.endsWith(".localhost")) {
    const sub = host.split(".")[0].toLowerCase();
    return sub && !reserved.has(sub) ? sub : null;
  }

  const base = authConfig.appBaseDomain;

  // Preferred: a configured base domain — only labels in front of it are tenants.
  // host === base → the app's own domain (no tenant). acme.<base> → "acme".
  if (base) {
    if (host === base) return null;
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1)).split(".")[0].toLowerCase();
      return sub && !reserved.has(sub) ? sub : null;
    }
    return null; // host isn't under the configured base domain
  }

  // Fallback heuristic when no base domain is configured: treat the first label
  // as the tenant, but ignore common infra labels and the configured default
  // realm slug (which usually names the base app host, not a tenant).
  const labels = host.split(".");
  if (labels.length < 3) return null; // need sub.domain.tld
  const sub = labels[0].toLowerCase();
  reserved.add("api").add("auth").add("admin");
  if (authConfig.keycloak.realm) reserved.add(authConfig.keycloak.realm.toLowerCase());
  return sub && !reserved.has(sub) ? sub : null;
}

const params = new URLSearchParams(window.location.search);
const urlRealm = params.get("realm") || params.get("tenant");
const subRealm = realmFromSubdomain();

// Detect a Keycloak auth-code callback: Keycloak appends ?code=...&session_state=...
// to the redirectUri after a successful login. When these params are present we must
// NOT clear or override localStorage — the stored realm is what the user entered on
// the login page and it must survive the round-trip so keycloak-js exchanges the code
// against the correct realm (motivity-internal, not the default attendance).
const isKeycloakCallback = params.has("code") && params.has("session_state");

// Realm resolution order: explicit URL param > host subdomain > previously
// stored realm (preserved during KC callback) > configured default.
//
// The subdomain is AUTHORITATIVE over any stored realm: on a per-subdomain
// multi-tenant deployment the URL defines the tenant, so a stale value from a
// previous tenant must never bleed across. We persist the resolved realm so the
// proxy below and later reads stay consistent for the session.
let currentRealm: string;
if (urlRealm) {
  currentRealm = urlRealm;
  localStorage.setItem("frs_current_realm", urlRealm);
} else if (subRealm) {
  currentRealm = subRealm;
  localStorage.setItem("frs_current_realm", subRealm);
} else if (isKeycloakCallback) {
  // Keycloak just redirected back with an auth code. Use whichever realm the
  // user selected on the login page (stored before the redirect). Do NOT clear
  // or replace it — that would make keycloak-js exchange the code against the
  // wrong realm and return authenticated=false, causing the redirect loop.
  currentRealm = localStorage.getItem("frs_current_realm") || authConfig.keycloak.realm;
} else {
  // Normal navigation (dashboard refresh, deep link, etc.).
  // Use whatever realm the user last authenticated with.  The onBaseDomain
  // cleanup that used to live here was clearing frs_current_realm on every
  // page refresh, destroying the session on the base domain because check-sso
  // then ran against the default "attendance" realm instead of the user's
  // actual realm (e.g. "motivity-internal") → always landed back at /login.
  // VITE_APP_BASE_DOMAIN already prevents the old "frs" stale-subdomain bug,
  // so the aggressive cleanup is no longer needed.
  currentRealm = localStorage.getItem("frs_current_realm") || authConfig.keycloak.realm;
}

const keycloakInstance = new Keycloak({
    url: authConfig.keycloak.url,
    realm: currentRealm,
    clientId: authConfig.keycloak.clientId,
});

const keycloakProxy = new Proxy(keycloakInstance, {
    get(target, prop) {
        if (prop === "realm") {
            return localStorage.getItem("frs_current_realm") || authConfig.keycloak.realm;
        }
        const val = Reflect.get(target, prop);
        return typeof val === "function" ? val.bind(target) : val;
    },
    set(target, prop, value) {
        return Reflect.set(target, prop, value);
    }
});

export default keycloakProxy;
