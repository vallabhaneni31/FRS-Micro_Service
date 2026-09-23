export type AuthMode = "mock" | "api" | "keycloak";

const VALID_AUTH_MODES: AuthMode[] = ["mock", "api", "keycloak"];
const rawMode = (import.meta.env.VITE_AUTH_MODE ?? "").toLowerCase();

let authMode: AuthMode;
if ((VALID_AUTH_MODES as string[]).includes(rawMode)) {
  authMode = rawMode as AuthMode;
} else if (import.meta.env.PROD) {
  // Fail closed in production builds — an unset/invalid VITE_AUTH_MODE must
  // not silently boot into mock mode and show fake data as if it were real.
  throw new Error(
    `[authConfig] VITE_AUTH_MODE must be one of: ${VALID_AUTH_MODES.join(", ")}. Got: "${rawMode || "(unset)"}"`
  );
} else {
  // Dev-server convenience default only — never applies to a production build.
  authMode = "mock";
}

export const authConfig = {
  mode: authMode,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api",
  timeoutMs: Number(import.meta.env.VITE_API_TIMEOUT_MS ?? "15000"),
  // Base app domain used to derive the tenant realm from a subdomain.
  // e.g. "frs.motivitylabs.com" → acme.frs.motivitylabs.com resolves to realm "acme",
  // while the bare base domain resolves to no tenant. Leave empty to use the heuristic.
  appBaseDomain: (import.meta.env.VITE_APP_BASE_DOMAIN ?? "").toLowerCase(),
  keycloak: {
    url: import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:9090",
    realm: import.meta.env.VITE_KEYCLOAK_REALM ?? "attendance",
    clientId:
      import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "attendance-frontend",
    redirectUri: import.meta.env.VITE_KEYCLOAK_REDIRECT_URI,
  },
};

export function getRedirectUri(path: string = '/'): string {
  if (authConfig.keycloak.redirectUri) {
    return authConfig.keycloak.redirectUri;
  }
  return window.location.origin + path;
}


