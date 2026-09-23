import { z } from "zod";

// Common schemas
const positiveInt = z.coerce.number().int().positive().max(50000);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");
const optionalPositiveInt = positiveInt.optional();
const optionalString = z.string().max(255).optional();

// Employee list query params
export const listEmployeesSchema = z.object({
  limit: optionalPositiveInt.default(200),
  department: optionalString,
  status: optionalString.refine(
    (val) => !val || ["active", "inactive"].includes(val),
    { message: "status must be one of: active, inactive" }
  ),
});

// Attendance list query params
export const listAttendanceSchema = z.object({
  fromDate: dateString.optional(),
  toDate: dateString.optional(),
  limit: optionalPositiveInt.default(500),
}).refine(
  (data) => {
    if (data.fromDate && data.toDate) {
      return data.fromDate <= data.toDate;
    }
    return true;
  },
  { message: "fromDate must be before or equal to toDate", path: ["fromDate"] }
);

// Devices list query params
export const listDevicesSchema = z.object({
  limit: optionalPositiveInt.default(200),
});

// Alerts list query params
export const listAlertsSchema = z.object({
  unreadOnly: z
    .coerce.boolean()
    .default(false)
    .transform((val) => (typeof val === "string" ? val === "true" : val)),
  limit: optionalPositiveInt.default(200),
});

// Dashboard metrics query params
export const getMetricsSchema = z.object({
  forDate: dateString.optional(),
});

// Device metrics history query params
export const deviceMetricsQuerySchema = z.object({
  hours: z.coerce.number().int().positive().max(24 * 90).default(24),
});

// Alert acknowledgement body
export const acknowledgeAlertSchema = z.object({
  resolution_notes: z.string().max(2000).optional().nullable(),
});

// Device token revoke body
export const revokeDeviceTokenSchema = z.object({
  reason: z.string().max(255).optional().nullable(),
});

// Auth schemas
export const loginSchema = z.object({
  email: z.string().email("Invalid email format").max(255),
  password: z.string().min(1, "Password is required").max(128),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required").max(1024),
});

export const logoutSchema = z.object({
  refreshToken: z.string().max(1024).optional(),
});

// Helper function to validate query params
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        message: "Validation failed",
        errors: result.error.flatten().fieldErrors,
      });
    }
    req.validatedQuery = result.data;
    next();
  };
}

// Helper function to validate body
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Validation failed",
        errors: result.error.flatten().fieldErrors,
      });
    }
    req.validatedBody = result.data;
    next();
  };
}
