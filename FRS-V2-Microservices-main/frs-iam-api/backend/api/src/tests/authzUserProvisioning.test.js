import test from "node:test";
import assert from "node:assert/strict";
import { assertUserProvisioned } from "../middleware/authz.js";

test("AB#2812 - assertUserProvisioned: throws a clear error when legacyUser is null (JWT missing email/sub)", () => {
  assert.throws(
    () => assertUserProvisioned(null, { sub: "kc-sub-123" }),
    /Unable to resolve or provision user identity.*kc-sub-123/
  );
});

test("AB#2812 - assertUserProvisioned: throws even if jwtPayload itself is missing sub", () => {
  assert.throws(
    () => assertUserProvisioned(null, {}),
    /Unable to resolve or provision user identity/
  );
});

test("AB#2812 - assertUserProvisioned: does not throw for a real resolved user", () => {
  assert.doesNotThrow(() => assertUserProvisioned({ pk_user_id: 42 }, { sub: "kc-sub-123" }));
});
