import socketServer from "./server.js";
import shutdownManager from "../core/managers/ShutdownManager.js";
import { getRedisEmitter } from "./redisEmitter.js";
import { cacheGetOrSet } from "../services/cache.js";

// FRS-ARCH-002 C7: employee/department display info barely changes, but
// every attendance check-in/check-out broadcast was re-querying it from
// Postgres. 5-minute TTL — this only feeds a live notification's display
// name/department, not an authorization decision, so brief staleness is
// harmless.
const EMPLOYEE_LOOKUP_TTL_SECONDS = 300;

async function lookupEmployeeDisplay(employeeId) {
  return cacheGetOrSet(`frs:cache:employee-display:${employeeId}`, EMPLOYEE_LOOKUP_TTL_SECONDS, async () => {
    const { pool } = await import('../db/pool.js');
    const { rows } = await pool.query(
      `SELECT e.full_name, e.employee_code, d.name as department_name
       FROM hr_employee e
       LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
       WHERE e.pk_employee_id = $1`,
      [employeeId]
    );
    if (rows.length) {
      return { fullName: rows[0].full_name, employeeCode: rows[0].employee_code, department: rows[0].department_name || '' };
    }
    const { rows: stdRows } = await pool.query(
      `SELECT name, roll_number FROM edu_student WHERE pk_student_id = $1`,
      [employeeId]
    );
    if (stdRows.length) {
      return { fullName: stdRows[0].name, employeeCode: stdRows[0].roll_number, department: '' };
    }
    return { fullName: 'Unknown', employeeCode: '', department: '' };
  });
}

class WebSocketManager {
  initialized = false;

  async initialize(httpServer) {
    if (this.initialized) return;
    await socketServer.initialize(httpServer);
    this.initialized = true;
    shutdownManager.registerShutdownHandler("ws-manager", async () => this.shutdown());
  }

  // Real io instance if this process has one (frs-backend), otherwise the
  // Redis-backed emitter fallback (e.g. the Kafka consumer worker) — both
  // implement `.to(room).emit(event, payload)`, so every method below that
  // calls getIO() works correctly in either process without change.
  getIO() {
    return socketServer.io || getRedisEmitter();
  }

  async emitAttendanceUpdate(payload) {
    let normalized = {};
    if (payload.record) {
      const rec = payload.record;
      let fullName = 'Unknown';
      let employeeCode = '';
      let department = '';
      try {
        const display = await lookupEmployeeDisplay(rec.fk_employee_id);
        fullName = display.fullName;
        employeeCode = display.employeeCode;
        department = display.department;
      } catch (_) {}

      normalized = {
        tenantId: rec.tenant_id,
        employeeId: rec.fk_employee_id,
        employeeCode: employeeCode,
        fullName: fullName,
        direction: rec.check_out ? 'out' : 'in',
        timestamp: rec.check_out || rec.check_in || new Date().toISOString(),
        deviceId: rec.fk_device_id || '',
        department: department,
        location: rec.location_label || '',
      };
    } else {
      let fullName = payload.fullName || 'Unknown';
      let employeeCode = payload.employeeCode || payload.rollNumber || '';
      let department = payload.department || '';

      if (fullName === 'Unknown' && payload.employeeId) {
        try {
          const display = await lookupEmployeeDisplay(payload.employeeId);
          fullName = display.fullName;
        } catch (_) {}
      }

      normalized = {
        tenantId: payload.tenantId,
        employeeId: payload.employeeId || '',
        employeeCode: employeeCode,
        fullName: fullName,
        direction: payload.direction || 'in',
        timestamp: payload.timestamp || new Date().toISOString(),
        deviceId: payload.deviceId || payload.deviceCode || '',
        department: department,
        location: payload.location || '',
      };
    }
    socketServer.broadcastAttendance(normalized);
  }
  broadcastToTenant(tenantId, event, payload) {
    try {
      this.getIO()?.to(`tenant:${tenantId}`).emit(event, payload);
    } catch (_) {}
  }
  broadcastDeviceStatus(tenantId, devices) {
    try {
      this.getIO()?.to(`tenant:${tenantId}`).emit('deviceStatusUpdate', devices);
    } catch (_) {}
  }
  emitDeviceUpdate(tenantId, device) {
    try {
      this.getIO()?.to(`tenant:${tenantId}`).emit('deviceUpdate', device);
    } catch (_) {}
  }

  emitAuditEvent(tenantId, entry) {
    try {
      this.getIO()?.to(`tenant:${tenantId}`).emit("auditEvent", entry);
    } catch (_) {}
  }

  emitNewAlert(tenantId, alert) {
    try {
      this.io?.to(`tenant:${tenantId}`).emit('newAlert', alert);
    } catch (_) {}
  }

  emitPresenceUpdate(payload) {
    socketServer.emitToTenant(payload?.tenantId ?? "all", "presence.update", payload);
  }
  emitAlert(payload) {
    socketServer.broadcastAlert(payload);
  }
  emitDashboardUpdate(payload) {
    socketServer.emitToTenant(payload?.tenantId ?? "all", "dashboard.update", payload);
  }

  async broadcastDeviceChange(req) {
    // Legacy: broadcasts full list. Avoid using in heartbeats.
    try {
      const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || '1';
      const { rows: devices } = await (await import('../db/pool.js')).pool.query(
        `SELECT pk_device_id, external_device_id, name, status, last_active,
                host(ip_address::inet) as ip_address, location_label,
                recognition_accuracy, total_scans, model
         FROM facility_device WHERE tenant_id = $1`,
        [tenantId]
      );
      this.broadcastDeviceStatus(tenantId, devices);
    } catch (_) {}
  }

  async broadcastSingleDevice(tenantId, deviceCode) {
    try {
      const { rows } = await (await import('../db/pool.js')).pool.query(
        `SELECT pk_device_id, external_device_id, name, status, last_active,
                host(ip_address::inet) as ip_address, location_label,
                recognition_accuracy, total_scans, model
         FROM facility_device WHERE external_device_id = $1`,
        [deviceCode]
      );
      if (rows.length) {
        const device = rows[0];
        this.emitDeviceUpdate(tenantId, device);
        // Also emit deviceStatusUpdate to trigger dashboard refreshes
        this.getIO()?.to(`tenant:${tenantId}`).emit('deviceStatusUpdate', [device]);
      }
    } catch (_) {}
  }

  getStats() {
    return socketServer.getStats();
  }

  async shutdown() {
    await socketServer.shutdown();
    this.initialized = false;
  }
}

const wsManager = new WebSocketManager();
export default wsManager;

