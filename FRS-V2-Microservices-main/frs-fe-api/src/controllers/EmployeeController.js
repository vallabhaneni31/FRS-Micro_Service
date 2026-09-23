import { z } from "zod";
import { writeAudit } from "../middleware/auditLog.js";
import employeeService from "../services/business/EmployeeService.js";
import logger from "../utils/logger.js";

// tenantId must come from the authenticated (JWT-verified) scope resolved by
// requireAuth — never from the client-controlled x-tenant-id header, or any
// tenant could read/write another tenant's employees by setting that header.
// customer/site/unit narrow scope *within* that tenant and are already
// validated against the caller's memberships by requireAuth, so req.auth.scope
// is preferred there too; the raw header is only a defensive fallback for the
// (should-never-happen) case where req.auth.scope wasn't populated.
const scopeHeaders = (req) => ({
  // null/undefined must stay null, not "" — buildScopeWhere() treats null as
  // "no tenant filter" (global/super_admin access) but "" fails the ::uuid
  // cast in Postgres ("invalid input syntax for type uuid: \"\"").
  tenantId: req.auth?.scope?.tenantId != null ? String(req.auth.scope.tenantId) : null,
  customerId: req.auth?.scope?.customerId
    ? String(req.auth.scope.customerId)
    : (req.headers["x-customer-id"] ? String(req.headers["x-customer-id"]) : undefined),
  siteId: req.auth?.scope?.siteId
    ? String(req.auth.scope.siteId)
    : (req.headers["x-site-id"] ? String(req.headers["x-site-id"]) : undefined),
  unitId: req.auth?.scope?.unitId
    ? String(req.auth.scope.unitId)
    : (req.headers["x-unit-id"] ? String(req.headers["x-unit-id"]) : undefined),
});

const createSchema = z.object({
  employee_code: z.string(),
  full_name: z.string(),
  email: z.string().email(),
  position_title: z.string(),
  location_label: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  join_date: z.string(),
  phone_number: z.string().nullable().optional(),
  fk_department_id: z.number().optional(),
  fk_shift_id: z.number().optional(),
  fk_manager_id: z.number().nullable().optional(),
  is_manager: z.boolean().optional(),
  site_ids: z.array(z.number()).optional(),
  site_id: z.number().nullable().optional(),
});

const updateSchema = createSchema.partial();

const EmployeeController = {
  async getAllEmployees(req, res) {
    const qs = z.object({
      limit: z.coerce.number().optional(),
      department: z.string().optional(),
      status: z.enum(["active", "inactive"]).optional(),
    }).safeParse(req.query);
    if (!qs.success) return res.status(400).json({ message: "invalid query" });
    const data = await employeeService.getAllEmployees({
      scope: scopeHeaders(req),
      limit: qs.data.limit,
      department: qs.data.department,
      status: qs.data.status,
    });
    return res.json({ data });
  },

  async searchEmployees(req, res) {
    const qs = z.object({ q: z.string(), limit: z.coerce.number().optional() }).safeParse(req.query);
    if (!qs.success) return res.status(400).json({ message: "invalid query" });
    const data = await employeeService.searchEmployees({ scope: scopeHeaders(req), q: qs.data.q, limit: qs.data.limit });
    return res.json({ data });
  },

  async listManagers(req, res) {
    const data = await employeeService.listManagers({ scope: scopeHeaders(req) });
    return res.json({ data });
  },

  async getEmployeeById(req, res) {
    const data = await employeeService.getEmployeeById({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    if (!data) return res.status(404).json({ message: "not found" });
    return res.json(data);
  },

  async getEmployeePhoto(req, res) {
    const data = await employeeService.getEmployeePhoto({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    return res.json(data);
  },

  async serveProfilePhoto(req, res) {
    const result = await employeeService.getProfilePhotoStream({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    if (!result) return res.status(404).json({ message: "Profile photo not found" });
    if (result.contentType) res.setHeader('Content-Type', result.contentType);
    if (result.contentLength) res.setHeader('Content-Length', String(result.contentLength));
    result.stream.pipe(res);
  },

  async getEmployeeAttendance(req, res) {
    const qs = z.object({ fromDate: z.string().optional(), toDate: z.string().optional() }).safeParse(req.query);
    if (!qs.success) return res.status(400).json({ message: "invalid query" });
    const data = await employeeService.getEmployeeAttendance({
      employeeId: String(req.params.id),
      fromDate: qs.data.fromDate,
      toDate: qs.data.toDate,
      scope: scopeHeaders(req),
    });
    return res.json({ data });
  },

  async getEmployeeActivity(req, res) {
    const data = await employeeService.getEmployeeActivity({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    return res.json(data);
  },

  async createEmployee(req, res) {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.info({ errors: parsed.error.format() }, "Zod validation failed");
      return res.status(400).json({ message: "invalid payload", errors: parsed.error.format() });
    }
    try {
      const row = await employeeService.createEmployee({ scope: scopeHeaders(req), data: parsed.data });
      await writeAudit({ req, action: 'employee.create',
        details: `Employee created: ${row.full_name} (${row.employee_code})`,
        entity_type: 'employee', entity_id: String(row.pk_employee_id), entity_name: row.full_name,
        after_data: JSON.stringify({ name: row.full_name, code: row.employee_code, department: row.fk_department_id }) }).catch(() => {});
      return res.status(201).json(row);
    } catch (err) {
      if (err.code === '23505') {
        const msg = err.constraint === 'hr_employee_tenant_id_employee_code_key'
          ? 'Employee ID already exists'
          : 'Email address already exists';
        return res.status(400).json({ message: msg });
      }
      if (err.message && err.message.startsWith('Cannot onboard employee to an inactive site')) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }
  },

  async updateEmployee(req, res) {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.info({ errors: parsed.error.format(), body: req.body }, "Zod validation failed (updateEmployee)");
      return res.status(400).json({ message: "invalid payload", errors: parsed.error.format() });
    }
    try {
      const row = await employeeService.updateEmployee({
        employeeId: String(req.params.id),
        patch: parsed.data,
        scope: scopeHeaders(req),
      });
      if (!row) return res.status(404).json({ message: "not found" });
      await writeAudit({ req, action: 'employee.update',
        details: `Employee updated: ${row.full_name}`,
        entity_type: 'employee', entity_id: String(row.pk_employee_id), entity_name: row.full_name,
        after_data: JSON.stringify(parsed.data) }).catch(() => {});
      return res.json(row);
    } catch (err) {
      if (err.message && err.message.startsWith('Cannot assign employee to an inactive site')) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }
  },

  async deleteEmployee(req, res) {
    const out = await employeeService.deleteEmployee({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    return res.json(out);
  },

  async activateEmployee(req, res) {
    await writeAudit({ req, action: 'employee.activate',
      details: `Employee ${req.params.id} activated` }).catch(() => {});
    const row = await employeeService.activateEmployee({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    return res.json(row);
  },

  async deactivateEmployee(req, res) {
    await writeAudit({ req, action: 'employee.deactivate',
      details: `Employee ${req.params.id} deactivated` }).catch(() => {});
    const row = await employeeService.deactivateEmployee({ employeeId: String(req.params.id), scope: scopeHeaders(req) });
    return res.json(row);
  },

  async assignDevice(req, res) {
    const parsed = z.object({ deviceId: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const out = await employeeService.assignDevice({ employeeId: String(req.params.id), deviceId: parsed.data.deviceId });
    return res.json(out);
  },

  async bulkImport(req, res) {
    const bulkRowSchema = z.object({
      employee_code:  z.string(),
      full_name:      z.string(),
      email:          z.string().email().optional().or(z.literal('')),
      position_title: z.string().optional().default(''),
      location_label: z.string().optional(),
      status:         z.enum(["active","inactive"]).optional().default('active'),
      join_date:      z.string().optional(),
      phone_number:   z.string().optional(),
      fk_department_id: z.coerce.number().optional(),
      fk_shift_id:    z.coerce.number().optional(),
      department_name: z.string().optional(),
      shift_name:     z.string().optional(),
    });
    const parsed = z.object({ rows: z.array(bulkRowSchema) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload", errors: parsed.error.errors });
    const out = await employeeService.bulkImport({ rows: parsed.data.rows, scope: scopeHeaders(req) });
    return res.json(out);
  },
};

export default EmployeeController;

