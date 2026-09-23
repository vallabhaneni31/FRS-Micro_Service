import { z } from 'zod';

export const createSiteSchema = z.object({
  name: z.string().min(1).max(150),
  timezone: z.string().max(60).optional(),
  address: z.string().max(500).optional(),
  status: z.string().max(30).optional(),
  customerId: z.union([z.string(), z.number()]).optional(),
});

export const updateSiteSettingsSchema = z.object({
  siteId: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1).max(150).optional(),
  timezone: z.string().max(60).optional(),
  timezone_label: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  status: z.string().max(30).optional(),
});

export const createHolidaySchema = z.object({
  name: z.string().min(1).max(150),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  type: z.string().max(30).optional(),
  recurring: z.boolean().optional(),
});

// Notification settings are stored as a loosely-typed JSONB blob merged onto
// existing values; this only enforces that whatever fields ARE sent are the
// right primitive type, not full completeness.
export const notificationSettingsSchema = z.object({
  email_enabled: z.boolean().optional(),
  email_recipients: z.string().max(2000).optional(),
  smtp_host: z.string().max(255).optional(),
  smtp_port: z.union([z.string(), z.number()]).optional(),
  smtp_user: z.string().max(255).optional(),
  smtp_pass: z.string().max(255).optional(),
  sms_enabled: z.boolean().optional(),
  sms_recipients: z.string().max(2000).optional(),
  inapp_enabled: z.boolean().optional(),
  alert_on_device_offline: z.boolean().optional(),
  alert_on_low_accuracy: z.boolean().optional(),
  alert_on_unauthorized_access: z.boolean().optional(),
  alert_on_late_arrival: z.boolean().optional(),
  low_accuracy_threshold: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const testEmailSchema = z.object({
  recipients: z.union([z.string().min(1).max(2000), z.array(z.string()).min(1)]),
});
