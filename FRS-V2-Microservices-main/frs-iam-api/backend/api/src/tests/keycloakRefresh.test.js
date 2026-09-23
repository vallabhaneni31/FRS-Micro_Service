/**
 * Bug: users on a tenant whose KEYCLOAK_URL includes a `/auth` context path
 * (e.g. "https://dev-frs.motivitylabs.com/auth", the value this project's own
 * env.js default and .env.example both use) get force-logged-out mid-session
 * with "[apiClient] Backend-proxy Keycloak refresh failed: ApiError: Token
 * refresh failed" even though their session/refresh token is still valid.
 *
 * Every other Keycloak-URL-consuming route in authRoutes.js builds its base
 * URL with `env.keycloak.url.replace(/\/$/, "")` (strips only a trailing
 * slash, keeps `/auth`). POST /keycloak-refresh alone strips the `/auth`
 * segment too, so it calls a different host path than every other route —
 * hitting something that isn't Keycloak's token endpoint and getting back a
 * non-JSON response, which the handler reports as the generic
 * "Token refresh failed".
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { authRoutes } from "../routes/authRoutes.js";
import { env } from "../config/env.js";

function makeServer() {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  return http.createServer(app);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("POST /keycloak-refresh calls the same Keycloak base URL as the other auth routes (preserves a configured /auth path)", async (t) => {
  const originalAuthMode = env.authMode;
  const originalKeycloakUrl = env.keycloak.url;
  const originalFetch = global.fetch;

  env.authMode = "keycloak";
  env.keycloak.url = "https://dev-frs.motivitylabs.com/auth";

  let capturedUrl = null;
  global.fetch = async (url, init) => {
    // Only intercept the route's outbound call to Keycloak — pass the test's
    // own request to its local server through to the real fetch.
    if (typeof url === "string" && url.startsWith("http://127.0.0.1")) {
      return originalFetch(url, init);
    }
    capturedUrl = url;
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 300 }),
    };
  };

  const server = makeServer();
  const port = await listen(server);

  t.after(() => {
    env.authMode = originalAuthMode;
    env.keycloak.url = originalKeycloakUrl;
    global.fetch = originalFetch;
    server.close();
  });

  const res = await originalFetch(`http://127.0.0.1:${port}/auth/keycloak-refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: "some-refresh-token", realm: "motivity-internal" }),
  });

  assert.strictEqual(res.status, 200, "refresh should succeed when it hits the real KC token endpoint");
  assert.strictEqual(
    capturedUrl,
    "https://dev-frs.motivitylabs.com/auth/realms/motivity-internal/protocol/openid-connect/token",
    "must build the token URL under the configured /auth path, exactly like every other Keycloak-URL-consuming route in this file"
  );
});
