import { z } from 'zod';

// Field requirements differ by event_type (employee.terminated only needs
// employee_code), so this only enforces type/format on whatever is present —
// completeness per event_type stays the handler's responsibility, unchanged.
const employeeDataSchema = z.object({
  employee_code: z.string().min(1).max(100),
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  email: z.string().email().max(255).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  department: z.string().max(100).optional().nullable(),
  designation: z.string().max(150).optional().nullable(),
  hire_date: z.string().optional().nullable(),
  tenant_id: z.string().optional().nullable(),
}).passthrough();

export const webhookEmployeeSchema = z.object({
  event_type: z.string().min(1).max(100),
  employee_data: employeeDataSchema,
  api_key: z.string().min(1),
});

const syncEmployeeSchema = z.object({
  employee_code: z.string().min(1).max(100).optional(),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  department: z.string().max(100).optional().nullable(),
  designation: z.string().max(150).optional().nullable(),
  hire_date: z.string().optional().nullable(),
  site_id: z.union([z.string(), z.number()]).optional().nullable(),
  status: z.string().max(30).optional(),
}).passthrough();

export const employeesSyncSchema = z.object({
  employees: z.array(syncEmployeeSchema),
});
