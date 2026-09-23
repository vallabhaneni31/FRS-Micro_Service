import { Device, FacilityEvent, LiveOfficePresence, DeviceAlert } from '../data/enhancedMockData';
import { authConfig } from '../config/authConfig';
import keycloak from '../services/auth/keycloakInstance';
import { createLogger } from '../utils/logger';
import {
  AttendanceUpdateSchema,
  PresenceUpdateSchema,
  DeviceHeartbeatSchema,
  DeviceStatusSchema,
  EnrollmentCompletedSchema,
  EnrollmentFailedSchema,
  validateWsEvent,
} from '../services/realtime/wsSchemas';

const log = createLogger('RTE');

export type WsConnectionStatus = 'connected' | 'reconnecting' | 'simulation' | 'disconnected';

// Event Types
export enum RteEventType {
    DEVICE_HEARTBEAT = 'DEVICE_HEARTBEAT',
    DEVICE_STATUS_CHANGE = 'DEVICE_STATUS_CHANGE',
    EMPLOYEE_ENTRY = 'EMPLOYEE_ENTRY',
    EMPLOYEE_EXIT = 'EMPLOYEE_EXIT',
    DEVICE_ALERT = 'DEVICE_ALERT',
    AREA_OCCUPANCY_CHANGE = 'AREA_OCCUPANCY_CHANGE',
    SYSTEM_ALERT = 'SYSTEM_ALERT',
    ENROLLMENT_PROGRESS = 'ENROLLMENT_PROGRESS'
}

type EventCallback = (payload: any) => void;

class RealTimeEngine {
    private static instance: RealTimeEngine;
    private listeners: Map<RteEventType, Set<EventCallback>> = new Map();

    // Simulated State (used in mock mode and as fallback)
    private devices: Map<string, Device> = new Map();
    private presenceMap: Map<string, LiveOfficePresence> = new Map();
    private activeEvents: FacilityEvent[] = [];
    private activeAlerts: DeviceAlert[] = [];

    // Simulation timers
    private heartbeatTimer: any = null;
    private eventTimer: any = null;

    // Real WebSocket (socket.io-client) — only active in api/keycloak mode
    private socket: any = null;
    private socketConnected = false;
    private currentTenantId: string | null = null;

    // Connection status observable
    private _connectionStatus: WsConnectionStatus = 'disconnected';
    private _lastConnectedAt: Date | null = null;
    private _statusListeners: Set<(status: WsConnectionStatus) => void> = new Set();

    private constructor() {
        this.initializeState();
    }

    public static getInstance(): RealTimeEngine {
        if (!RealTimeEngine.instance) {
            RealTimeEngine.instance = new RealTimeEngine();
        }
        return RealTimeEngine.instance;
    }

    private initializeState() {
        // devices loaded from real API
        // presence loaded from real API
        this.activeAlerts = [];
    }

    // ── Socket.io real connection ────────────────────────────────────────────

    /**
     * Connect to the backend socket.io server.
     * Call this after a successful login in AuthContext.
     * In mock mode this is a no-op — simulation keeps running.
     */
    public async connectSocket(token?: string | null, tenantId?: string) {
        if (authConfig.mode === 'mock') {
            this._emitStatusChange('simulation');
            return;
        }
        if (this.socket?.connected) {
            if (tenantId && tenantId !== this.currentTenantId) {
                if (this.currentTenantId) {
                    this.socket.emit('leaveTenant', this.currentTenantId);
                }
                this.socket.emit('joinTenant', tenantId);
                this.currentTenantId = tenantId;
            }
            return;
        }

        try {
            // Dynamic import keeps socket.io-client out of the bundle in mock mode
            const { io } = await import('socket.io-client');

            const wsUrl = window.location.origin;

            this.socket = io(wsUrl, {
                // A plain object here would be captured once and resent verbatim on
                // every automatic reconnect — once the token expires, every
                // reconnect attempt (and the live feed with it) would keep dying
                // forever on a stale JWT since nothing else refreshes it in the
                // background. Using a function makes socket.io call this fresh
                // immediately before each (re)connection attempt.
                auth: async (cb: (data: { token: string | null }) => void) => {
                    if (authConfig.mode === 'mock') { cb({ token: null }); return; }
                    try {
                        await keycloak.updateToken(30);
                    } catch {
                        // fall through with whatever's on the instance, if anything
                    }
                    cb({ token: keycloak.token ?? token ?? null });
                },
                withCredentials: true,   // S-01: sends httpOnly session cookie in handshake
                transports:      ['websocket', 'polling'],
                reconnection:    true,
                reconnectionDelay:     2000,
                reconnectionAttempts:  10,
            });

            this.socket.on('connect', () => {
                this.socketConnected = true;
                log.info('WebSocket connected');
                // Join tenant room so backend can target events at this user
                if (tenantId) {
                    this.socket.emit('joinTenant', tenantId);
                    this.currentTenantId = tenantId;
                }
                this._emitStatusChange('connected');
                // Stop simulation — real events take over
                this.stop();
            });

            this.socket.on('disconnect', (reason: string) => {
                this.socketConnected = false;
                log.warn('WebSocket disconnected', { reason });
                this._emitStatusChange('reconnecting');
                // DO NOT start simulation here — wait for reconnect_failed
            });

            this.socket.on('reconnect_failed', () => {
                log.warn('WebSocket reconnect failed — starting simulation fallback');
                this._emitStatusChange('simulation');
                if (!this.heartbeatTimer) this.start();
            });

            this.socket.on('connect_error', (err: Error) => {
                log.warn('WebSocket connection error', { error: err.message });
            });

            // ── Backend event handlers ─────────────────────────────────────

            // Fired by backend after attendanceService.markAttendance()
            this.socket.on('attendance.update', (raw: unknown) => {
                const payload = validateWsEvent(AttendanceUpdateSchema, 'attendance.update', raw);
                if (!payload) return;
                const isEntry = !payload.direction || !['out', 'exit', 'checkout'].includes(payload.direction.toLowerCase());
                const event: FacilityEvent = {
                    id:           `evt-live-${Date.now()}`,
                    type:         isEntry ? 'entry' : 'exit',
                    employeeId:   String(payload.employeeId || ''),
                    employeeName: payload.fullName || 'Unknown',
                    cameraId:     payload.deviceId || '',
                    cameraName:   payload.deviceId || 'Camera',
                    floorId:      payload.siteId   || '',
                    timestamp:    payload.timestamp || new Date().toISOString(),
                    coordinates:  { x: 50, y: 50 },
                };
                this.activeEvents = [event, ...this.activeEvents].slice(0, 100);

                // Update presence map
                const prev = this.presenceMap.get(event.employeeId);
                const presenceStatus = isEntry ? 'Present' : 'Checked-In Only';
                const presenceUpdate: any = {
                    ...(prev || {
                        employeeId:   event.employeeId,
                        employeeName: event.employeeName,
                        department:   payload.department || '',
                        duration:     '0h 0m',
                        status:       presenceStatus,
                        shiftEndTime: '17:00',
                        entryCamera:  isEntry ? event.cameraName : '',
                        floor:        '',
                        area:         '',
                    }),
                    status:          presenceStatus,
                };

                if (isEntry) {
                    presenceUpdate.checkInTime = prev?.checkInTime || new Date().toLocaleTimeString();
                    presenceUpdate.lastSeenCamera = event.cameraName ?? '';
                    presenceUpdate.lastSeenTime = new Date().toLocaleTimeString();
                    presenceUpdate.deviceUsed = event.cameraName ?? '';
                    presenceUpdate.location = payload.location || '';
                } else {
                    presenceUpdate.checkOutTime = new Date().toLocaleTimeString();
                }

                this.presenceMap.set(event.employeeId, presenceUpdate);

                if (isEntry) {
                    this.emit(RteEventType.EMPLOYEE_ENTRY, event);
                } else {
                    this.emit(RteEventType.EMPLOYEE_EXIT, event);
                }
            });

            // Fired by backend presence service
            this.socket.on('presence.update', (raw: unknown) => {
                const payload = validateWsEvent(PresenceUpdateSchema, 'presence.update', raw);
                if (!payload) return;
                this.emit(RteEventType.AREA_OCCUPANCY_CHANGE, payload);
            });

            // Device heartbeat forwarded from Kafka consumer
            this.socket.on('device.heartbeat', (raw: unknown) => {
                const payload = validateWsEvent(DeviceHeartbeatSchema, 'device.heartbeat', raw);
                if (!payload) return;
                const device = this.devices.get(payload.deviceId);
                if (device) {
                    device.cpuUsage     = payload.cpuUsage     ?? device.cpuUsage;
                    device.memoryUsage  = payload.memoryUsage  ?? device.memoryUsage;
                    device.temperature  = payload.temperature  ?? device.temperature;
                    device.status       = 'Online';
                    device.lastActive   = 'Just now';
                }
                this.emit(RteEventType.DEVICE_HEARTBEAT, Array.from(this.devices.values()));
            });

            // Device status change
            this.socket.on('device.status', (raw: unknown) => {
                const payload = validateWsEvent(DeviceStatusSchema, 'device.status', raw);
                if (!payload) return;
                const device = this.devices.get(payload.deviceId);
                if (device) {
                    device.status = payload.status === 'online' ? 'Online' : 'Offline';
                }
                this.emit(RteEventType.DEVICE_STATUS_CHANGE, payload);
            });

            // System notifications
            this.socket.on('system.alert.new', (payload: any) => {
                this.emit(RteEventType.SYSTEM_ALERT, payload);
            });

            // Enrollment pipeline — fired per-angle by DeviceEventService's
            // handleEnrollmentCompleted/handleEnrollmentFailed once a Jetson
            // reports a face-embedding result back for one angle. Consumed by
            // useEnrollmentProgress to nudge an immediate re-poll instead of
            // waiting for the next tick — the panel's real data still comes
            // from GET /enroll/invitations/:id/progress, this is just the
            // "refresh now" signal.
            this.socket.on('enrollment.completed', (raw: unknown) => {
                const payload = validateWsEvent(EnrollmentCompletedSchema, 'enrollment.completed', raw);
                if (!payload) return;
                this.emit(RteEventType.ENROLLMENT_PROGRESS, { ...payload, stage: 'embedded' });
            });
            this.socket.on('enrollment.failed', (raw: unknown) => {
                const payload = validateWsEvent(EnrollmentFailedSchema, 'enrollment.failed', raw);
                if (!payload) return;
                this.emit(RteEventType.ENROLLMENT_PROGRESS, { ...payload, stage: 'failed' });
            });

        } catch (e) {
            log.warn('socket.io-client not available, falling back to simulation', { error: String(e) });
        }
    }

    /**
     * Disconnect from backend socket. Call this on logout.
     */
    public disconnectSocket() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.socketConnected = false;
            this.currentTenantId = null;
            log.info('WebSocket disconnected by logout');
        }
        this._emitStatusChange('disconnected');
        // Restart simulation so UI keeps updating while logged out / in mock mode
        if (authConfig.mode === 'mock') this.start();
    }

    public isSocketConnected() {
        return this.socketConnected;
    }

    public getConnectionStatus(): WsConnectionStatus {
        return this._connectionStatus;
    }

    public getLastConnectedAt(): Date | null {
        return this._lastConnectedAt;
    }

    public onConnectionStatusChange(cb: (status: WsConnectionStatus) => void): () => void {
        this._statusListeners.add(cb);
        // Immediately call with current status
        cb(this._connectionStatus);
        return () => this._statusListeners.delete(cb);
    }

    private _emitStatusChange(status: WsConnectionStatus) {
        this._connectionStatus = status;
        if (status === 'connected') this._lastConnectedAt = new Date();
        this._statusListeners.forEach(cb => cb(status));
    }

    // ── Simulation (mock mode & reconnect fallback) ──────────────────────────

    public start() {
        if (this.heartbeatTimer) return;
        log.info('Starting simulation engine');
        this.heartbeatTimer = setInterval(() => this.simulateHeartbeats(), 3000);
        this.eventTimer = setInterval(() => this.simulateRandomEvent(), 5000 + Math.random() * 3000);
    }

    public stop() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.eventTimer)     clearInterval(this.eventTimer);
        this.heartbeatTimer = null;
        this.eventTimer     = null;
        log.info('Stopped simulation engine');
    }

    // ── Pub/Sub ──────────────────────────────────────────────────────────────

    public subscribe(eventType: RteEventType, callback: EventCallback) {
        if (!this.listeners.has(eventType)) {
            this.listeners.set(eventType, new Set());
        }
        this.listeners.get(eventType)!.add(callback);
        return () => this.unsubscribe(eventType, callback);
    }

    public unsubscribe(eventType: RteEventType, callback: EventCallback) {
        if (this.listeners.has(eventType)) {
            this.listeners.get(eventType)!.delete(callback);
        }
    }

    private emit(eventType: RteEventType, payload: any) {
        if (this.listeners.has(eventType)) {
            this.listeners.get(eventType)!.forEach(cb => cb(payload));
        }
    }

    // ── Simulators ───────────────────────────────────────────────────────────

    private simulateHeartbeats() {
        const updatedDevices: Device[] = [];
        this.devices.forEach(device => {
            if (device.type === 'Edge Device' || device.cpuUsage !== undefined) {
                const fluctuate = (val: number, max: number) => Math.max(0, Math.min(max, val + (Math.random() * 4 - 2)));
                device.cpuUsage    = fluctuate(device.cpuUsage    || 40, 100);
                device.memoryUsage = fluctuate(device.memoryUsage || 50, 100);
                device.temperature = fluctuate(device.temperature || 45, 90);
                if (device.temperature > 80 && !this.activeAlerts.find(a => a.deviceId === device.id && a.type === 'Overheating' && !a.resolved)) {
                    const alert: DeviceAlert = {
                        id: `alt-${Date.now()}`, deviceId: device.id, deviceName: device.name,
                        floorName: device.floorId || 'Unknown', type: 'Overheating', severity: 'Critical',
                        timestamp: new Date().toISOString(), resolved: false,
                        message: `Critical temperature threshold exceeded: ${device.temperature.toFixed(1)}°C`
                    };
                    this.activeAlerts = [alert, ...this.activeAlerts];
                    this.emit(RteEventType.DEVICE_ALERT, alert);
                }
            }
            if (Math.random() < 0.01) {
                device.status = device.status === 'Online' ? 'Offline' : 'Online';
                this.emit(RteEventType.DEVICE_STATUS_CHANGE, { deviceId: device.id, status: device.status });
            }
            updatedDevices.push({ ...device });
        });
        this.emit(RteEventType.DEVICE_HEARTBEAT, updatedDevices);
    }

    private simulateRandomEvent() {
        const devicesArray = Array.from(this.devices.values()).filter(d => d.status === 'Online');
        if (devicesArray.length === 0) return;
        const randomDevice = devicesArray[Math.floor(Math.random() * devicesArray.length)];
        const isEntry = Math.random() > 0.5;
        const employeeId = `emp-00${Math.floor(Math.random() * 9) + 1}`;
        const event: FacilityEvent = {
            id: `evt-sim-${Date.now()}`, type: isEntry ? 'entry' : 'exit',
            employeeId, employeeName: `Simulated Employee ${employeeId.split('-')[1]}`,
            cameraId: randomDevice.id, cameraName: randomDevice.name,
            floorId: randomDevice.floorId || 'fl-001',
            timestamp: new Date().toISOString(),
            coordinates: randomDevice.coordinates || { x: 50, y: 50 }
        };
        const presence = this.presenceMap.get(employeeId) || {
            employeeId, employeeName: event.employeeName, department: 'Operations',
            checkInTime: new Date().toLocaleTimeString(), duration: '0h 0m',
            location: randomDevice.location, deviceUsed: randomDevice.name,
            status: 'Present', shiftEndTime: '17:00', lastSeenCamera: randomDevice.name,
            lastSeenTime: new Date().toLocaleTimeString(), entryCamera: randomDevice.name,
            floor: randomDevice.floorId, area: randomDevice.areaId || ''
        };
        if (isEntry) {
            presence.lastSeenCamera = randomDevice.name;
            presence.lastSeenTime   = new Date().toLocaleTimeString();
            presence.status = 'Present';
            this.presenceMap.set(employeeId, presence);
            this.emit(RteEventType.EMPLOYEE_ENTRY, event);
        } else {
            presence.status       = 'Checked-In Only';
            presence.checkOutTime = new Date().toLocaleTimeString();
            this.presenceMap.set(employeeId, presence);
            this.emit(RteEventType.EMPLOYEE_EXIT, event);
        }
        this.activeEvents = [event, ...this.activeEvents].slice(0, 50);
        if (this.eventTimer) clearInterval(this.eventTimer);
        this.eventTimer = setInterval(() => this.simulateRandomEvent(), 5000 + Math.random() * 5000);
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    public getDevices()  { return Array.from(this.devices.values()); }
    public getPresence() { return Array.from(this.presenceMap.values()); }
    public getEvents()   { return [...this.activeEvents]; }
    public getAlerts()   { return [...this.activeAlerts]; }

    public addDevice(device: Device) {
        this.devices.set(device.id, device);
        this.emit(RteEventType.DEVICE_STATUS_CHANGE, { deviceId: device.id, status: device.status });
    }

    public checkoutEmployee(employeeId: string) {
        const presence = this.presenceMap.get(employeeId);
        if (presence) {
            presence.status       = 'Checked-In Only';
            presence.checkOutTime = new Date().toLocaleTimeString();
            this.presenceMap.set(employeeId, presence);
            const event: FacilityEvent = {
                id: `evt-manual-${Date.now()}`, type: 'exit',
                employeeId, employeeName: presence.employeeName,
                cameraId: 'dev-manual', cameraName: 'System Checkout',
                floorId: presence.floor || 'Unknown',
                timestamp: new Date().toISOString(), coordinates: { x: 50, y: 50 }
            };
            this.activeEvents = [event, ...this.activeEvents].slice(0, 50);
            this.emit(RteEventType.EMPLOYEE_EXIT, event);
        }
    }
}

export const realtimeEngine = RealTimeEngine.getInstance();

// In mock mode start simulation immediately; in api/keycloak mode
// simulation starts as a fallback and stops once socket connects.
if (authConfig.mode === 'mock') {
    realtimeEngine.start();
    // connectSocket() in mock mode emits 'simulation' status immediately
    realtimeEngine.connectSocket();
}

