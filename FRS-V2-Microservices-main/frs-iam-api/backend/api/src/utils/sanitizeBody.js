/**
 * sanitizeBody.js — FIX-019: Mass assignment protection
 *
 * pickAllowed(obj, allowedKeys) returns a new object with only the specified
 * keys, discarding any extra fields the client may have injected.
 *
 * Usage in route handlers:
 *   const body = pickAllowed(req.body, ['name', 'email', 'role']);
 *
 * Express middleware variant:
 *   router.post('/employees', allowFields(['name', 'email', 'department']), handler);
 *
 * This prevents:
 *   - Injecting admin flags: { "is_admin": true }
 *   - Overriding tenant_id: { "tenant_id": "attacker-uuid" }
 *   - Polluting internal fields: { "created_at": "...", "row_hash": "..." }
 */

/**
 * Returns a shallow copy of `obj` containing only keys in `allowed`.
 * Nested objects are preserved by reference (not deep-cloned).
 *
 * @param {object} obj       - Input object (usually req.body)
 * @param {string[]} allowed - Whitelist of permitted top-level keys
 * @returns {object}
 */
export function pickAllowed(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Express middleware factory — strips any keys not in `allowedFields` from req.body.
 * Logs a warning if unknown fields were stripped (helps surface client bugs / attacks).
 *
 * @param {string[]} allowedFields - Whitelist of permitted request body keys
 * @returns {import('express').RequestHandler}
 */
export function allowFields(allowedFields) {
  return (req, _res, next) => {
    if (!req.body || typeof req.body !== 'object') return next();

    const incoming  = Object.keys(req.body);
    const stripped  = incoming.filter(k => !allowedFields.includes(k));

    if (stripped.length > 0) {
      // Import lazily to avoid circular dep during module load
      import('../utils/logger.js').then(({ default: logger }) => {
        logger.warn({
          path:    req.path,
          method:  req.method,
          stripped,
        }, '[sanitizeBody] Stripped unexpected fields from request body');
      }).catch(() => {});
    }

    req.body = pickAllowed(req.body, allowedFields);
    next();
  };
}

/**
 * Deep-sanitize: removes fields matching a denylist pattern from a nested object.
 * Useful for sanitizing before logging (redact passwords, tokens, embeddings).
 *
 * @param {object} obj
 * @param {string[]} [denylist] - Field names to redact (case-insensitive match)
 * @param {string}   [replacement]
 * @returns {object}
 */
const DEFAULT_DENY = [
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'authorization', 'auth_token', 'access_token', 'refresh_token',
  'embedding', 'face_embedding', 'face_data', 'biometric',
  'credit_card', 'card_number', 'cvv', 'ssn',
];

export function redactSensitive(obj, denylist = DEFAULT_DENY, replacement = '[REDACTED]') {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => redactSensitive(item, denylist, replacement));

  const denySet = new Set(denylist.map(k => k.toLowerCase()));
  const result  = {};

  for (const [key, value] of Object.entries(obj)) {
    if (denySet.has(key.toLowerCase())) {
      result[key] = replacement;
    } else if (value && typeof value === 'object') {
      result[key] = redactSensitive(value, denylist, replacement);
    } else {
      result[key] = value;
    }
  }
  return result;
}
