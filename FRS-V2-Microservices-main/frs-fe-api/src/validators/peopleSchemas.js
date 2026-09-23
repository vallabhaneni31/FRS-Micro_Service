import { z } from 'zod';

// personService.createVisitor inserts fullName/validFrom/validTo directly with
// no presence check of its own — a missing value hits a raw NOT NULL/date-cast
// DB error (500) instead of a clean 400. This only guards presence/shape for
// those fields; everything else stays as loose as the service already treats it.
export const createVisitorSchema = z.object({
  fullName: z.string().max(255).refine((v) => v.trim().length > 0, 'fullName is required'),
  organization: z.string().max(255).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().max(255).optional().nullable(),
  designation: z.string().max(150).optional().nullable(),
  photoUrl: z.string().optional().nullable(),
  visitorType: z.string().max(30).optional(),
  hostEmployeeId: z.union([z.string(), z.number()]).optional().nullable(),
  visitPurpose: z.string().max(1000).optional().nullable(),
  validFrom: z.string().min(1, 'validFrom is required'),
  validTo: z.string().min(1, 'validTo is required'),
  sendInvite: z.boolean().optional(),
  embedding: z.array(z.number()).optional(),
  photoPath: z.string().optional().nullable(),
}).passthrough();
