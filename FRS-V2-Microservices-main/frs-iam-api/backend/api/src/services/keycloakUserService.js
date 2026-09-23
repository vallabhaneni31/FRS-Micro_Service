import { env } from "../config/env.js";

function getKeycloakAdminCredentials() {
  return {
    username: process.env.KEYCLOAK_ADMIN_USER || "admin",
    password: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
  };
}

export function buildKeycloakProfile(username, email) {
  const trimmedName = String(username || "").trim();
  const fallbackName = String(email || "User")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim();
  const baseName = trimmedName || fallbackName || "User";
  const parts = baseName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "User";
  const lastName = parts.slice(1).join(" ") || firstName;

  return { firstName, lastName };
}

export function mapRoleToKeycloakRealmRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (["super_admin", "superadmin"].includes(normalized)) return "super_admin";
  if (["tenant_admin", "tenantadmin", "admin"].includes(normalized)) return "tenant_admin";
  if (["site_admin", "siteadmin"].includes(normalized)) return "site_admin";
  if (["hr_manager", "hrmanager", "hr"].includes(normalized)) return "hr_manager";
  if (["viewer", "device_operator"].includes(normalized)) return "viewer";
  return "viewer";
}

async function getKeycloakAdminToken() {
  const { username, password } = getKeycloakAdminCredentials();
  const response = await fetch(
    `${env.keycloak.url}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username,
        password,
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to authenticate with Keycloak admin API (${response.status}): ${detail}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Keycloak admin API did not return an access token");
  }

  return data.access_token;
}

async function keycloakAdminRequest(path, { method = "GET", body, adminToken, realmSlug } = {}) {
  const token = adminToken || await getKeycloakAdminToken();
  const targetRealm = realmSlug || env.keycloak.realm;
  const response = await fetch(`${env.keycloak.url}/admin/realms/${targetRealm}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  return { response, adminToken: token };
}

export async function findKeycloakUser({ keycloakSub, email, adminToken, realmSlug } = {}) {
  let token = adminToken;

  if (keycloakSub) {
    const byId = await keycloakAdminRequest(`/users/${keycloakSub}`, { adminToken: token, realmSlug });
    token = byId.adminToken;
    if (byId.response.ok) {
      const user = await byId.response.json();
      return { user, adminToken: token };
    }
    if (byId.response.status !== 404) {
      const detail = await byId.response.text().catch(() => "");
      throw new Error(`Failed to fetch Keycloak user ${keycloakSub} (${byId.response.status}): ${detail}`);
    }
  }

  if (!email) {
    return { user: null, adminToken: token || await getKeycloakAdminToken() };
  }

  const byEmail = await keycloakAdminRequest(`/users?email=${encodeURIComponent(email)}&exact=true`, {
    adminToken: token,
    realmSlug,
  });
  token = byEmail.adminToken;
  if (!byEmail.response.ok) {
    const detail = await byEmail.response.text().catch(() => "");
    throw new Error(`Failed to query Keycloak user by email (${byEmail.response.status}): ${detail}`);
  }

  const users = await byEmail.response.json();
  return { user: users?.[0] ?? null, adminToken: token };
}

export async function ensureKeycloakUserReady({ keycloakSub, email, username, tenantId, adminToken, realmSlug } = {}) {
  const found = await findKeycloakUser({ keycloakSub, email, adminToken, realmSlug });
  const keycloakUser = found.user;
  const token = found.adminToken;

  if (!keycloakUser?.id) {
    return { keycloakUserId: null, adminToken: token };
  }

  const { firstName, lastName } = buildKeycloakProfile(
    username || keycloakUser.firstName || keycloakUser.username || keycloakUser.email,
    email || keycloakUser.email
  );

  const { response } = await keycloakAdminRequest(`/users/${keycloakUser.id}`, {
    method: "PUT",
    adminToken: token,
    realmSlug,
    body: {
      username: keycloakUser.username || email,
      email: email || keycloakUser.email,
      firstName,
      lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: [],
      attributes: {
        ...(keycloakUser.attributes || {}),
        ...(tenantId ? { tenant_id: [tenantId] } : {}),
      },
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to update Keycloak user ${keycloakUser.id} (${response.status}): ${detail}`);
  }

  return { keycloakUserId: keycloakUser.id, adminToken: token };
}

export async function ensureKeycloakRealmRole({ keycloakUserId, realmRole, adminToken, realmSlug }) {
  if (!keycloakUserId || !realmRole) {
    return { adminToken: adminToken || await getKeycloakAdminToken() };
  }

  let token = adminToken || await getKeycloakAdminToken();
  const roleResponse = await keycloakAdminRequest(`/roles/${encodeURIComponent(realmRole)}`, {
    adminToken: token,
    realmSlug,
  });
  token = roleResponse.adminToken;

  if (!roleResponse.response.ok) {
    const detail = await roleResponse.response.text().catch(() => "");
    throw new Error(`Failed to load Keycloak role ${realmRole} (${roleResponse.response.status}): ${detail}`);
  }

  const role = await roleResponse.response.json();
  const mappingResponse = await keycloakAdminRequest(`/users/${keycloakUserId}/role-mappings/realm`, {
    method: "POST",
    adminToken: token,
    realmSlug,
    body: [role],
  });

  if (!mappingResponse.response.ok && mappingResponse.response.status !== 204) {
    const detail = await mappingResponse.response.text().catch(() => "");
    throw new Error(`Failed to assign Keycloak role ${realmRole} (${mappingResponse.response.status}): ${detail}`);
  }

  return { adminToken: token };
}

export async function setKeycloakPassword({ keycloakUserId, password, adminToken, realmSlug }) {
  if (!keycloakUserId || !password) {
    return { adminToken: adminToken || await getKeycloakAdminToken() };
  }

  const { response, adminToken: token } = await keycloakAdminRequest(`/users/${keycloakUserId}/reset-password`, {
    method: "PUT",
    adminToken,
    realmSlug,
    body: {
      type: "password",
      value: password,
      temporary: false,
    },
  });

  if (!response.ok && response.status !== 204) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to reset Keycloak password (${response.status}): ${detail}`);
  }

  return { adminToken: token };
}

export async function createOrUpdateKeycloakUser({
  email,
  username,
  password,
  realmRole,
  tenantId,
  realmSlug,
}) {
  const token = await getKeycloakAdminToken();
  const found = await findKeycloakUser({ email, adminToken: token, realmSlug });

  if (found.user?.id) {
    const ready = await ensureKeycloakUserReady({
      keycloakSub: found.user.id,
      email,
      username,
      tenantId,
      adminToken: found.adminToken,
      realmSlug,
    });
    let nextToken = ready.adminToken;
    if (password) {
      const passwordResult = await setKeycloakPassword({
        keycloakUserId: ready.keycloakUserId,
        password,
        adminToken: ready.adminToken,
        realmSlug,
      });
      nextToken = passwordResult.adminToken;
    }
    await ensureKeycloakRealmRole({
      keycloakUserId: ready.keycloakUserId,
      realmRole,
      adminToken: nextToken,
      realmSlug,
    });
    return ready.keycloakUserId;
  }

  const { firstName, lastName } = buildKeycloakProfile(username, email);
  const createResponse = await keycloakAdminRequest("/users", {
    method: "POST",
    adminToken: found.adminToken,
    realmSlug,
    body: {
      username: email,
      email,
      firstName,
      lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: password ? [] : ["UPDATE_PASSWORD"],
      attributes: tenantId ? { tenant_id: [tenantId] } : undefined,
      credentials: password ? [{
        type: "password",
        value: password,
        temporary: false,
      }] : undefined,
    },
  });

  if (![201, 204].includes(createResponse.response.status)) {
    const detail = await createResponse.response.text().catch(() => "");
    throw new Error(`Keycloak user creation failed (${createResponse.response.status}): ${detail}`);
  }

  const refetched = await findKeycloakUser({ email, adminToken: createResponse.adminToken, realmSlug });
  if (!refetched.user?.id) {
    throw new Error(`Created Keycloak user for ${email}, but could not look it up afterwards`);
  }

  await ensureKeycloakRealmRole({
    keycloakUserId: refetched.user.id,
    realmRole,
    adminToken: refetched.adminToken,
    realmSlug,
  });

  return refetched.user.id;
}

export async function getAllKeycloakUsers({ realmSlug, adminToken } = {}) {
  const token = adminToken || await getKeycloakAdminToken();
  const { response, adminToken: nextToken } = await keycloakAdminRequest("/users?max=1000", {
    adminToken: token,
    realmSlug,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to list Keycloak users (${response.status}): ${detail}`);
  }

  const users = await response.json();
  return { users, adminToken: nextToken };
}

export async function setKeycloakUserEnabled({ keycloakSub, enabled, realmSlug }) {
  if (!keycloakSub) return;
  const token = await getKeycloakAdminToken();
  const { response } = await keycloakAdminRequest(`/users/${keycloakSub}`, {
    method: "PUT",
    adminToken: token,
    realmSlug,
    body: { enabled },
  });
  if (![200, 204].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to update Keycloak user enabled status to ${enabled} (${response.status}): ${detail}`);
  }
}

export async function deleteKeycloakUser({ keycloakSub, realmSlug }) {
  if (!keycloakSub) return;
  const token = await getKeycloakAdminToken();
  const { response } = await keycloakAdminRequest(`/users/${keycloakSub}`, {
    method: "DELETE",
    adminToken: token,
    realmSlug,
  });
  if (![200, 204, 404].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to delete Keycloak user (${response.status}): ${detail}`);
  }
}

