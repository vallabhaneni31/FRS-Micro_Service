import { z } from 'zod';

const positiveIntId = z.coerce.number().int().positive();
const SHIFT_TYPES = ['morning', 'afternoon', 'evening', 'night', 'flexible', 'fixed', 'rotational', 'custom'];

export const createDepartmentSchema = z.object({
  name: z.string().min(2).max(30),
  code: z.string().min(1).max(30),
  color: z.string().max(30).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  head_employee_id: positiveIntId.optional().nullable(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(2).max(30).optional(),
  code: z.string().min(1).max(30).optional(),
  color: z.string().max(30).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  head_employee_id: positiveIntId.optional().nullable(),
});

export const assignEmployeesSchema = z.object({
  employee_ids: z.array(positiveIntId),
});

export const createShiftSchema = z.object({
  name: z.string().min(1).max(150),
  shift_type: z.enum(SHIFT_TYPES),
  start_time: z.string().max(20).optional().nullable(),
  end_time: z.string().max(20).optional().nullable(),
  grace_period_minutes: z.coerce.number().int().min(0).max(240).default(10),
  is_flexible: z.boolean().default(false),
  break_duration_minutes: z.coerce.number().int().min(0).max(480).default(0),
  work_days: z.array(z.string().max(10)).optional(),
});

// Partial update — fields stay optional/undefined so the route's COALESCE
// against existing DB values is unaffected by fields the caller omitted.
export const updateShiftSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  shift_type: z.enum(SHIFT_TYPES).optional(),
  start_time: z.string().max(20).optional().nullable(),
  end_time: z.string().max(20).optional().nullable(),
  grace_period_minutes: z.coerce.number().int().min(0).max(240).optional().nullable(),
  is_flexible: z.boolean().optional().nullable(),
  break_duration_minutes: z.coerce.number().int().min(0).max(480).optional().nullable(),
  work_days: z.array(z.string().max(10)).optional().nullable(),
});

const rosterEntrySchema = z.object({
  employee_id: positiveIntId,
  shift_id: positiveIntId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  notes: z.string().max(1000).optional().nullable(),
});

export const createRosterSchema = z.object({
  entries: z.array(rosterEntrySchema).min(1).max(1000),
});

export const createRecurringRosterSchema = z.object({
  employee_id: positiveIntId,
  shift_id: positiveIntId,
  day_of_week: z.coerce.number().int().min(0).max(6),
  weeks_ahead: z.coerce.number().int().min(1).max(52).default(4),
  notes: z.string().max(1000).optional().nullable(),
});

export const swapRosterSchema = z.object({
  swap_with_employee_id: positiveIntId,
});
