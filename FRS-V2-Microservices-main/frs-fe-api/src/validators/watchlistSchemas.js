import { z } from 'zod';

const PRIORITIES = ['critical', 'high', 'medium', 'low'];

const nonBlank = (msg) => z.string().max(255).refine((v) => v.trim().length > 0, msg);

export const createWatchlistSchema = z.object({
  name: nonBlank('name is required'),
  description: z.string().max(2000).optional().nullable(),
  category: z.string().max(50).default('general'),
  priority: z.enum(PRIORITIES).default('medium'),
  alertOnMatch: z.boolean().default(true),
  notifyEmails: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
});

export const addWatchlistPersonSchema = z.object({
  fullName: nonBlank('fullName is required'),
  aliases: z.array(z.string()).default([]),
  photoUrl: z.string().max(1000).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  expiresAt: z.string().optional().nullable(),
  metadata: z.record(z.any()).default({}),
});
