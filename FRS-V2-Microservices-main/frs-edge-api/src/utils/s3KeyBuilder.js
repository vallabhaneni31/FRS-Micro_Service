/**
 * s3KeyBuilder.js — shared helpers for building the FRS S3 key layout:
 *
 *   motivity-frs-logs:      tenant-{tenantId}/employee/{employeeCode}/{date}/{in|out}/{Name}_{date}_{HH-MM-SS}-{nonce}.jpg
 *                           tenant-{tenantId}/visitor/{visitorId}/{date}/{in|out}/{VisitorId}_{date}_{HH-MM-SS}-{nonce}.jpg
 *   motivity-frs-user-data: tenant-{tenantId}/users/{employeeCode}/profile/{filename}
 *                           tenant-{tenantId}/users/{employeeCode}/enrollment/{filename}
 *
 * Keys are rooted at the tenant's stable UUID, not its (renameable) display
 * name — see the jetson-09 external_device_id rename incident, where a
 * renameable string identifier baked into a long-lived reference silently
 * broke lookups. Same risk applies to a tenant name embedded in S3 keys.
 */

/**
 * Strip a value down to characters safe for both an S3 key segment and the
 * photo-serving routes' filename regex (/^[\w\-]+\.(jpg|...)$/i — word chars
 * and hyphens only). Spaces become underscores; anything else disallowed is
 * dropped outright rather than percent-encoded, so the result stays readable
 * in the AWS console and matches cleanly against stored values via ILIKE.
 */
export function sanitizeForKey(value) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'unknown';
}

/**
 * Derive {dateStr, timeStr} for a photo key from the event's own capture
 * time (payload.event_time) rather than upload/processing time — Jetson
 * devices can deliver events well after capture (offline queue drain), so
 * using "now" would misfile a photo under the wrong day and show a
 * misleading capture time.
 *
 * event_time only carries second precision on the wire (Jetson always sends
 * ".000" milliseconds), so a 3-digit random nonce is appended to the time
 * component — otherwise two frames captured in the same second would
 * resolve to the identical S3 key and silently overwrite each other.
 */
export function eventDateTimeParts(eventTimeIso) {
  const parsed = eventTimeIso ? new Date(eventTimeIso) : null;
  const d = parsed && !isNaN(parsed) ? parsed : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const nonce = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const timeStr = `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}-${nonce}`;
  return { dateStr, timeStr };
}

/** tenant-{tenantId}/users/{employeeCode}/{section}/{filename} */
export function buildUserDataKey({ tenantId, employeeCode, section, filename }) {
  return `tenant-${tenantId}/users/${sanitizeForKey(employeeCode)}/${section}/${filename}`;
}

/** tenant-{tenantId}/{employee|visitor}/{safeId}/{dateStr}/{direction}/{filename} */
export function buildEventPhotoKey({ tenantId, kind, safeId, dateStr, direction, filename }) {
  const kindFolder = kind === 'visitor' ? 'visitor' : 'employee';
  return `tenant-${tenantId}/${kindFolder}/${safeId}/${dateStr}/${direction}/${filename}`;
}

/**
 * Employee: {Name}_{dateStr}_{timeStr}.jpg
 * Visitor:  Visitor_{id}_{dateStr}_{timeStr}.jpg
 * (timeStr already carries the collision-safety -{nonce} suffix from eventDateTimeParts)
 */
export function buildEventPhotoFilename({ kind, name, id, dateStr, timeStr }) {
  const label = kind === 'visitor' ? `Visitor_${sanitizeForKey(id)}` : sanitizeForKey(name);
  return `${label}_${dateStr}_${timeStr}.jpg`;
}
