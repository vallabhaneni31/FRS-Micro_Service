/**
 * Validates password complexity:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 * - No empty spaces
 * @param {string} password
 * @returns {string[]} List of complexity violation messages, or empty array if valid.
 */
export function validatePasswordComplexity(password, minLength = 8) {
  const errors = [];
  if (password.length < minLength) errors.push(`Password must be at least ${minLength} characters long.`);
  if (!/[A-Z]/.test(password)) errors.push("Password must contain at least one uppercase letter.");
  if (!/[a-z]/.test(password)) errors.push("Password must contain at least one lowercase letter.");
  if (!/[0-9]/.test(password)) errors.push("Password must contain at least one number.");
  if (!/[^A-Za-z0-9]/.test(password)) errors.push("Password must contain at least one special character.");
  if (/\s/.test(password)) errors.push("Password must not contain any spaces.");
  return errors;
}
