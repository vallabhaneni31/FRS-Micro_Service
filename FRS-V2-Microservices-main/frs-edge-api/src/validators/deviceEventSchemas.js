/**
 * deviceEventSchemas.js — Joi validation for Jetson → AWS device events.
 *
 * IMPORTANT: These schemas match the ACTUAL event taxonomy emitted by edge
 * devices and consumed by deviceEventsRoutes.js (snake_case, dotted names).
 * An earlier version of this file defined a different, unused taxonomy
 * (FACE_DETECTED, etc.) that never matched the routes — it has been replaced.
 */
import Joi from 'joi';

// Max events accepted in a single POST /api/events/batch call (DoS guard).
export const MAX_BATCH_EVENTS = 100;

// Known event types the dispatcher in deviceEventsRoutes.js handles.
// NOTE: live Jetson firmware emits `device.heartbeat` and `face.unrecognized`;
// these are treated as aliases of `heartbeat` / `face.unknown`.
export const KNOWN_EVENT_TYPES = [
  'heartbeat',
  'device.heartbeat',
  'health.check',
  'face.recognized',
  'face.unknown',
  'face.unrecognized',
  'access.granted',
  'access.denied',
  'enrollment.completed',
  'enrollment.failed',
];

const isoOrDate = Joi.alternatives().try(
  Joi.string().isoDate(),
  Joi.date()
);

// Identifiers may arrive as string codes or numeric/uuid ids depending on device.
const identifier = Joi.alternatives().try(Joi.string().max(128), Joi.number());

const heartbeatSchema = Joi.object({
  status: Joi.string().valid('online', 'offline', 'degraded', 'error').default('online'),
  metrics: Joi.object().default({}),
  firmware_version: Joi.string().max(64),
  ip_address: Joi.string().ip({ version: ['ipv4', 'ipv6'] }),
  event_time: isoOrDate,
}).unknown(true);

// Lightweight liveness ping distinct from a full heartbeat — no telemetry,
// just confirms the device's network/pipeline is up. Purely informational.
const healthCheckSchema = Joi.object({
  status: Joi.string().max(32).default('checking'),
  event_time: isoOrDate,
}).unknown(true);

const faceRecognizedSchema = Joi.object({
  employee_code: identifier,
  employee_id: identifier,
  student_code: identifier,
  student_id: identifier,
  confidence: Joi.number().min(0).max(1),
  direction: Joi.string().valid('in', 'out', 'checkin', 'checkout').default('in'),
  photo_url: Joi.string().uri({ allowRelative: true }).max(1024),
  photo_base64: Joi.string(),
  box: Joi.array().items(Joi.number()).length(4).optional(),
  event_time: isoOrDate,
})
  .or('employee_code', 'employee_id', 'student_code', 'student_id')
  .unknown(true);

const faceUnknownSchema = Joi.object({
  confidence: Joi.number().min(0).max(1),
  photo_url: Joi.string().uri({ allowRelative: true }).max(1024),
  photo_base64: Joi.string(),
  box: Joi.array().items(Joi.number()).length(4).optional(),
  event_time: isoOrDate,
}).unknown(true);

const accessEventSchema = Joi.object({
  event_time: isoOrDate,
}).unknown(true);

const enrollmentCompletedSchema = Joi.object({
  employee_code: identifier,
  employee_id: identifier,
  student_code: identifier,
  student_id: identifier,
  embedding: Joi.array().items(Joi.number()).max(2048),
  confidence: Joi.number().min(0).max(1),
  photo_path: Joi.string().max(1024),
  photo_base64: Joi.string(),
  event_time: isoOrDate,
})
  .or('employee_code', 'employee_id', 'student_code', 'student_id')
  .unknown(true);

const enrollmentFailedSchema = Joi.object({
  employee_code: identifier,
  employee_id: identifier,
  student_code: identifier,
  student_id: identifier,
  reason: Joi.string().max(512),
  event_time: isoOrDate,
}).unknown(true);

const SCHEMA_BY_TYPE = {
  heartbeat: heartbeatSchema,
  'device.heartbeat': heartbeatSchema,
  'health.check': healthCheckSchema,
  'face.recognized': faceRecognizedSchema,
  'face.unknown': faceUnknownSchema,
  'face.unrecognized': faceUnknownSchema,
  'access.granted': accessEventSchema,
  'access.denied': accessEventSchema,
  'enrollment.completed': enrollmentCompletedSchema,
  'enrollment.failed': enrollmentFailedSchema,
};

/**
 * Validate a single device event payload against its type schema.
 *
 * @returns {{ known: boolean, value?: object, error?: string }}
 *   - known=false  → event_type is not in KNOWN_EVENT_TYPES (caller decides)
 *   - error set    → payload failed validation for a known type
 *   - value set    → sanitized/defaulted payload to use downstream
 */
export function validateEventPayload(eventType, payload = {}) {
  const schema = SCHEMA_BY_TYPE[eventType];
  if (!schema) {
    return { known: false };
  }
  const { error, value } = schema.validate(payload, {
    abortEarly: false,
    stripUnknown: false,
  });
  if (error) {
    return { known: true, error: error.details.map((d) => d.message).join('; ') };
  }
  return { known: true, value };
}
