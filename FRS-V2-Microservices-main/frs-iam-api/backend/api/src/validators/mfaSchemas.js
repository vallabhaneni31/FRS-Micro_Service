import { z } from "zod";

export const enableMfaSchema = z.object({
  totp: z.string().regex(/^\d{6}$/, "totp must be a 6-digit code"),
  backupCodes: z.array(z.string().min(4).max(64)).max(20).optional(),
});

export const disableMfaSchema = z.object({
  password: z.string().min(1, "password is required").max(128),
});

export const verifyMfaSchema = z.object({
  mfaChallengeToken: z.string().min(16).max(128),
  totp: z.string().regex(/^\d{6}$/, "totp must be a 6-digit code").optional(),
  backupCode: z.string().min(4).max(64).optional(),
}).refine((data) => Boolean(data.totp || data.backupCode), {
  message: "Either totp or backupCode is required",
  path: ["totp"],
});
