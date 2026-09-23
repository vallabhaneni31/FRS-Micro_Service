/**
 * passwordResetEmail.test.js — AB#3270
 *
 * "Admin Reset Password should send a self-service reset link instead of
 * setting the password directly." UserService.resetPassword() no longer
 * accepts/sets a password at all — it now creates a `user_invite` row
 * (role_label = "Password Reset") and emails the target user a setup-link,
 * following the exact same pattern as the self-service POST /forgot-password
 * flow in authRoutes.js. The user's password is only ever changed once they
 * complete that link via the existing /api/auth/invite/:token/setup
 * endpoint — this service must NOT touch Keycloak or the local
 * `password_hash` column directly.
 *
 * Covers:
 *   1. A reset request for a valid active user inserts a `user_invite` row
 *      (role_label = 'Password Reset') and sends an email (via
 *      sendUserInvite -> transporter.sendMail) with a correctly-shaped
 *      `/setup-password/:token` link.
 *   2. A reset request for a nonexistent user is rejected with NotFoundError
 *      (same as before this ticket).
 *   3. A reset request for a deactivated user is rejected with
 *      ValidationError (same as before this ticket).
 *   4. No Keycloak password-set call (no fetch() call at all) and no
 *      `UPDATE frs_user SET password_hash` happen — this is the core
 *      behavior change, verified rather than assumed.
 *   5. UserController.resetPassword no longer requires a `password` in the
 *      request body and returns a plain `{ success: true }` (no more
 *      `emailSent` nuance — a failure now surfaces as a thrown/mapped
 *      error instead of a silently-swallowed flag).
 *
 * Mocking approach: unchanged from the AB#2793 version of this file — mock
 * at the pool.query / prototype level (see remainingLoginAttempts.test.js,
 * s3Storage.test.js) rather than reassigning ES module namespace exports
 * (which Node rejects as read-only). sendUserInvite() ultimately calls
 * nodemailer's shared `Mail.prototype.sendMail` — mocking that prototype
 * method (exactly like s3Storage.test.js mocks S3Client.prototype.send)
 * lets us control/inspect the SMTP outcome without touching module bindings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Mailer from "nodemailer/lib/mailer/index.js";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import * as UserService from "../services/business/UserService.js";
import UserController from "../controllers/UserController.js";
import { NotFoundError, ValidationError } from "../services/business/UserService.js";

const originalPoolQuery = pool.query;
const originalAuthMode = env.authMode;
const originalFetch = globalThis.fetch;

function restore() {
  pool.query = originalPoolQuery;
  env.authMode = originalAuthMode;
  globalThis.fetch = originalFetch;
}

function mockUserRow(overrides = {}) {
  return {
    email: "alice@example.com",
    username: "alice",
    role: "hr_manager",
    keycloak_sub: null,
    password_hash: null,
    is_active: true,
    ...overrides,
  };
}

function installPoolMock({ userRow, calls }) {
  pool.query = async (text, params) => {
    calls.push({ text, params });
    if (/SELECT email, username, role, keycloak_sub, password_hash, is_active FROM frs_user/.test(text)) {
      return { rows: userRow ? [userRow] : [] };
    }
    // INSERT INTO user_invite, audit_log, etc.
    return { rows: [] };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. UserService.resetPassword — valid active user sends a reset link
// ─────────────────────────────────────────────────────────────────────────────

test("AB#3270 - UserService.resetPassword: inserts a user_invite row (role_label = 'Password Reset') and sends a setup-link email for a valid active user", async (t) => {
  env.authMode = "api"; // local-auth branch — this function no longer branches on authMode at all, but keep parity with the rest of the suite
  const calls = [];
  installPoolMock({ userRow: mockUserRow({ email: "alice@example.com", username: "alice" }), calls });

  let sentMailOptions = null;
  t.mock.method(Mailer.prototype, "sendMail", async function (mailOptions) {
    sentMailOptions = mailOptions;
    return { messageId: "mock-message-1" };
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Keycloak must not be contacted for an admin-triggered reset-link request");
  });

  try {
    const result = await UserService.resetPassword({ id: 42 });

    assert.strictEqual(result.user.email, "alice@example.com");

    const inviteInsert = calls.find((c) => /INSERT INTO user_invite/.test(c.text));
    assert.ok(inviteInsert, "a user_invite row must be inserted");
    const [fkUserId, inviteToken, invitedById, invitedByName, roleLabel, tenantName, expiresAt] = inviteInsert.params;
    assert.strictEqual(fkUserId, 42);
    assert.ok(typeof inviteToken === "string" && inviteToken.length === 64, "invite_token must be a sha256 hex digest");
    assert.strictEqual(invitedById, null);
    assert.strictEqual(invitedByName, "FRS Security System");
    assert.strictEqual(roleLabel, "Password Reset");
    assert.strictEqual(tenantName, null);
    assert.ok(expiresAt instanceof Date);

    assert.ok(sentMailOptions, "sendUserInvite must send an email");
    assert.strictEqual(sentMailOptions.to, "alice@example.com");
    assert.match(sentMailOptions.html, /\/setup-password\//, "email must contain a /setup-password/:token link");
    assert.match(sentMailOptions.text, /\/setup-password\//, "email text body must contain a /setup-password/:token link");

    assert.strictEqual(fetchMock.mock.calls.length, 0, "no Keycloak/identity-provider HTTP call may be made");
    assert.ok(
      !calls.some((c) => /UPDATE frs_user SET password_hash/.test(c.text)),
      "the password hash must NOT be updated by an admin-triggered reset-link request"
    );
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. UserService.resetPassword — nonexistent user is rejected
// ─────────────────────────────────────────────────────────────────────────────

test("AB#3270 - UserService.resetPassword: rejects with NotFoundError for a nonexistent user, and never creates an invite or sends an email", async (t) => {
  env.authMode = "api";
  const calls = [];
  installPoolMock({ userRow: null, calls });
  const sendMail = t.mock.method(Mailer.prototype, "sendMail", async () => ({ messageId: "should-not-be-called" }));

  try {
    await assert.rejects(() => UserService.resetPassword({ id: 999 }), NotFoundError);
    assert.ok(!calls.some((c) => /INSERT INTO user_invite/.test(c.text)), "no invite row for a nonexistent user");
    assert.strictEqual(sendMail.mock.calls.length, 0, "no email for a nonexistent user");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. UserService.resetPassword — deactivated user is rejected
// ─────────────────────────────────────────────────────────────────────────────

test("AB#3270 - UserService.resetPassword: rejects with ValidationError for a deactivated user, and never creates an invite or sends an email", async (t) => {
  env.authMode = "api";
  const calls = [];
  installPoolMock({ userRow: mockUserRow({ email: "bob@example.com", is_active: false }), calls });
  const sendMail = t.mock.method(Mailer.prototype, "sendMail", async () => ({ messageId: "should-not-be-called" }));

  try {
    await assert.rejects(() => UserService.resetPassword({ id: 43 }), ValidationError);
    assert.ok(!calls.some((c) => /INSERT INTO user_invite/.test(c.text)), "no invite row for a deactivated user");
    assert.strictEqual(sendMail.mock.calls.length, 0, "no email for a deactivated user");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. UserController.resetPassword — no password required, plain success response
// ─────────────────────────────────────────────────────────────────────────────

function mockReqRes({ id = 44 } = {}) {
  const req = {
    params: { id: String(id) },
    body: {},
    auth: {
      scope: { tenantId: "tenant-1" },
      memberships: [{ role: "super_admin" }], // skip assertUserInTenant lookup
      user: { id: 1, name: "admin", role: "super_admin" },
    },
    headers: {},
    method: "PUT",
  };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
  };
  return { req, res };
}

test("AB#3270 - UserController.resetPassword: succeeds with just an id (no password in the body) and returns a plain { success: true }", async (t) => {
  env.authMode = "api";
  const calls = [];
  installPoolMock({ userRow: mockUserRow({ email: "carol@example.com" }), calls });
  t.mock.method(Mailer.prototype, "sendMail", async () => ({ messageId: "mock-message-2" }));

  const { req, res } = mockReqRes({ id: 44 });

  try {
    await UserController.resetPassword(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { success: true });
  } finally {
    restore();
  }
});

test("AB#3270 - UserController.resetPassword: returns 404 for a nonexistent user", async (t) => {
  env.authMode = "api";
  const calls = [];
  installPoolMock({ userRow: null, calls });

  const { req, res } = mockReqRes({ id: 45 });

  try {
    await UserController.resetPassword(req, res);
    assert.strictEqual(res.statusCode, 404);
  } finally {
    restore();
  }
});
