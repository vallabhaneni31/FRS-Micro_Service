import { z } from 'zod';

export const createAlertSchema = z.object({
  alertType: z.string().min(1).max(100),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional().nullable(),
  entityType: z.string().max(50).optional().nullable(),
  entityId: z.union([z.string(), z.number()]).optional().nullable(),
  snapshotUrl: z.string().max(1000).optional().nullable(),
  siteId: z.union([z.string(), z.number()]).optional().nullable(),
  metadata: z.record(z.any()).default({}),
});

export const assignAlertSchema = z.object({
  userId: z.union([z.string(), z.number()]).optional().nullable(),
});
