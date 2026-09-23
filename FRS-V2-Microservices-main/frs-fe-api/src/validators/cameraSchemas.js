import { z } from 'zod';

export const registerCameraSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(150),
  ipAddress: z.string().max(45).optional().nullable(),
  location: z.string().max(255).optional().nullable(),
  role: z.string().max(30).optional(),
});

export const systemConfigSchema = z.object({
  threshold: z.coerce.number().min(0).max(1),
  cooldown: z.coerce.number().int().min(0),
});

export const cameraStatusSchema = z.object({
  status: z.string().min(1).max(30),
});
