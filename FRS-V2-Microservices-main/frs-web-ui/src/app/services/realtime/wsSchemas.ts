/**
 * wsSchemas.ts — W-07
 * Zod schemas for every incoming WebSocket event.
 * Invalid payloads are logged and discarded before touching React state.
 */
import { z } from 'zod';

// attendance.update — fired by backend AttendanceService after markAttendance()
export const AttendanceUpdateSchema = z.object({
  employeeId:  z.union([z.string(), z.number()]).optional(),
  fullName:    z.string().optional(),
  deviceId:    z.string().optional(),
  siteId:      z.string().nullable().optional(),
  timestamp:   z.string().optional(),
  department:  z.string().optional(),
  location:    z.string().optional(),
  tenantId:    z.string().optional(),
  direction:   z.string().optional(),
}).passthrough(); // forward-compatible: extra fields from future versions are allowed

// presence.update — fired by LivePresenceService
export const PresenceUpdateSchema = z.object({
  employeeId:   z.union([z.string(), z.number()]).optional(),
  status:       z.string().optional(),
  tenantId:     z.string().optional(),
}).passthrough();

// device.heartbeat — forwarded from Kafka consumer
export const DeviceHeartbeatSchema = z.object({
  deviceId:     z.string(),
  cpuUsage:     z.number().optional(),
  memoryUsage:  z.number().optional(),
  temperature:  z.number().optional(),
  tenantId:     z.string().optional(),
}).passthrough();

// device.status — online/offline state change
export const DeviceStatusSchema = z.object({
  deviceId:  z.string(),
  status:    z.enum(['online', 'offline', 'error']),
  tenantId:  z.string().optional(),
}).passthrough();

// enrollment.completed — fired by DeviceEventService.handleEnrollmentCompleted
// once a single angle's embedding lands (employee_id/employee_code shape
// matches EnrollmentService.js's payload fields, not camelCase like the
// attendance events above).
export const EnrollmentCompletedSchema = z.object({
  employee_id:   z.union([z.string(), z.number()]).nullable().optional(),
  employee_code: z.string().optional(),
  student_id:    z.union([z.string(), z.number()]).nullable().optional(),
  student_code:  z.string().optional(),
  device_code:   z.string().optional(),
  confidence:    z.number().nullable().optional(),
  angle:         z.string().nullable().optional(),
  timestamp:     z.string().optional(),
  vertical:      z.string().optional(),
}).passthrough();

// enrollment.failed — fired by DeviceEventService.handleEnrollmentFailed
export const EnrollmentFailedSchema = z.object({
  employee_id:   z.union([z.string(), z.number()]).nullable().optional(),
  employee_code: z.string().optional(),
  student_id:    z.union([z.string(), z.number()]).nullable().optional(),
  student_code:  z.string().optional(),
  device_code:   z.string().optional(),
  reason:        z.string().nullable().optional(),
  angle:         z.string().nullable().optional(),
  timestamp:     z.string().optional(),
  vertical:      z.string().optional(),
}).passthrough();

// ── Helper ────────────────────────────────────────────────────────────────

/**
 * Validate a raw WebSocket payload against a Zod schema.
 * Returns the parsed value on success, or null if the payload is invalid.
 * Invalid payloads are logged so they can be investigated without crashing.
 */
export function validateWsEvent<T>(
  schema: z.ZodType<T>,
  eventName: string,
  payload: unknown,
): T | null {
  const result = schema.safeParse(payload);
  if (!result.success) {
    console.warn(
      `[WS] Invalid payload for "${eventName}" — discarding`,
      result.error.flatten(),
      payload,
    );
    return null;
  }
  return result.data;
}
