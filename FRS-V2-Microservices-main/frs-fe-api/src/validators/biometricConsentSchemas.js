import { z } from "zod";

export const recordConsentSchema = z.object({
  employeeId: z.string().uuid("employeeId must be a valid UUID"),
  consentMethod: z.string().max(64).optional(),
  consentVersion: z.string().max(32).optional(),
});

export const withdrawConsentSchema = z.object({
  employeeId: z.string().uuid("employeeId must be a valid UUID"),
  reason: z.string().max(500).optional(),
});

export const employeeIdParamSchema = z.object({
  employeeId: z.string().uuid("employeeId must be a valid UUID"),
});
