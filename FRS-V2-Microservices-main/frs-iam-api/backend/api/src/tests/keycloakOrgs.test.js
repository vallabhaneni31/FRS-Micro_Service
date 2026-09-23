import test from "node:test";
import assert from "node:assert";
import { createKeycloakOrganization, addUserToOrganization } from "../services/keycloakProvisioner.js";

// Save original global.fetch
const originalFetch = global.fetch;

test("createKeycloakOrganization provisions organization successfully", async () => {
  let calledUrl = null;
  let calledBody = null;
  
  global.fetch = async (url, options) => {
    // Mock master token authentication
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "mock-admin-token" }),
      };
    }
    
    // Mock Organization creation
    if (url.includes("/admin/realms/acme/organizations")) {
      calledUrl = url;
      calledBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 201,
        text: async () => "Created",
      };
    }
  };

  try {
    const result = await createKeycloakOrganization({
      realmSlug: "acme",
      orgSlug: "acme-hq",
      orgName: "ACME Headquarters",
    });

    assert.strictEqual(result, true);
    assert.ok(calledUrl.endsWith("/admin/realms/acme/organizations"));
    assert.strictEqual(calledBody.alias, "acme-hq");
    assert.strictEqual(calledBody.name, "ACME Headquarters");
    assert.deepStrictEqual(calledBody.domains, [{ name: "acme-hq.local", verified: false }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("addUserToOrganization adds user successfully", async () => {
  let calledUrl = null;
  let calledBody = null;

  global.fetch = async (url, options) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "mock-admin-token" }),
      };
    }

    if (url.includes("/admin/realms/acme/organizations?search=acme-hq")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "acme-hq-uuid", alias: "acme-hq" }],
      };
    }

    if (url.includes("/admin/realms/acme/organizations/acme-hq-uuid/members")) {
      calledUrl = url;
      calledBody = options.body; // raw string in Keycloak 26
      return {
        ok: true,
        status: 201,
        text: async () => "Added",
      };
    }
  };

  try {
    const result = await addUserToOrganization({
      realmSlug: "acme",
      orgSlug: "acme-hq",
      userId: "mock-user-id",
    });

    assert.strictEqual(result, true);
    assert.ok(calledUrl.endsWith("/admin/realms/acme/organizations/acme-hq-uuid/members"));
    assert.strictEqual(calledBody, "mock-user-id");
  } finally {
    global.fetch = originalFetch;
  }
});
