import test from "node:test";
import assert from "node:assert";
import { validateIp, validateNugIp } from "../utils/validateIp.js";

test("IP Validation Utility - validateIp", () => {
  // Valid IPs
  assert.strictEqual(validateIp("127.0.0.1"), true);
  assert.strictEqual(validateIp("192.168.1.1"), true);
  assert.strictEqual(validateIp("8.8.8.8"), true);

  // Invalid / Malformed IPs (Command Injection attempts)
  assert.strictEqual(validateIp("127.0.0.1; id"), false);
  assert.strictEqual(validateIp("192.168.1.1 && whoami"), false);
  assert.strictEqual(validateIp("not-an-ip"), false);
  assert.strictEqual(validateIp(""), false);
  assert.strictEqual(validateIp(null), false);
});

test("SSRF Validation Utility - validateNugIp", () => {
  // Safe / Outbound Public IPs
  assert.strictEqual(validateNugIp("8.8.8.8"), true);
  assert.strictEqual(validateNugIp("104.244.42.1"), true);

  // Loopback / Link-Local ranges (SSRF blocked)
  assert.strictEqual(validateNugIp("127.0.0.1"), false);
  assert.strictEqual(validateNugIp("169.254.169.254"), false);

  // Private RFC 1918 ranges (SSRF blocked)
  assert.strictEqual(validateNugIp("10.0.0.1"), false);
  assert.strictEqual(validateNugIp("172.16.0.1"), false);
  assert.strictEqual(validateNugIp("192.168.1.1"), false);
  
  // Malformed IPs
  assert.strictEqual(validateNugIp("invalid-ip"), false);
  assert.strictEqual(validateNugIp(""), false);
  assert.strictEqual(validateNugIp(null), false);
});
