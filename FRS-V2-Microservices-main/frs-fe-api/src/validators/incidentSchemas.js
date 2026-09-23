import { z } from 'zod';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export const createIncidentSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional().nullable(),
  incidentType: z.string().max(50).default('other'),
  severity: z.enum(SEVERITIES).default('medium'),
  siteId: z.union([z.string(), z.number()]).optional().nullable(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
});

export const addIncidentCommentSchema = z.object({
  comment: z.string().max(2000).refine((v) => v.trim().length > 0, 'comment is required'),
});
