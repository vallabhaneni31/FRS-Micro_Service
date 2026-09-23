import test from "node:test";
import assert from "node:assert";
import { validatePasswordComplexity } from "../utils/validatePassword.js";

test("Password Complexity Validation", () => {
  // Valid strong passwords
  assert.deepStrictEqual(validatePasswordComplexity("StrongP@ss123"), []);
  assert.deepStrictEqual(validatePasswordComplexity("Enterprise!2026"), []);

  // Too short
  assert.ok(validatePasswordComplexity("Short1!").some(e => e.includes("at least 8 characters")));

  // Missing uppercase
  assert.ok(validatePasswordComplexity("weakpassword1!").some(e => e.includes("uppercase letter")));

  // Missing lowercase
  assert.ok(validatePasswordComplexity("WEAKPASSWORD1!").some(e => e.includes("lowercase letter")));

  // Missing number
  assert.ok(validatePasswordComplexity("NoNumberPass!").some(e => e.includes("at least one number")));

  // Missing special character
  assert.ok(validatePasswordComplexity("NoSpecialChar123").some(e => e.includes("special character")));

  // Contains spaces
  assert.ok(validatePasswordComplexity("Strong P@ss 123").some(e => e.includes("spaces")));

  // Custom min length
  assert.ok(validatePasswordComplexity("Strong!12", 12).some(e => e.includes("at least 12 characters")));
  assert.deepStrictEqual(validatePasswordComplexity("StrongPass!12", 12), []);
});
