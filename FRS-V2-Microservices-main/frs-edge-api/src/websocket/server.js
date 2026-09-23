import shutdownManager from "../core/managers/ShutdownManager.js";
import logger from "../utils/logger.js";
import { getRedisEmitter } from "./redisEmitter.js";

class SocketServer {
  io = null;
  connections = new Map();
  tenantRooms = new Map();

  async initialize(httpServer) {
    // Dynamic import works correctly in ESM (require() does not)
    const { Server } = await import("socket.io");

    // S-01: support comma-separated CLIENT_ORIGIN list
    const wsOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
      .split(",").map(o => o.trim()).filter(Boolean);

    // Attach the Redis adapter so broadcasts published from OTHER processes
    // (e.g. workers/deviceEventConsumer.js, via redisEmitter.js) reach the
    // clients connected to THIS process, and vice versa. Without this, each
    // process's Socket.IO server is an island — fine for the current single
    // frs-backend instance, but required the moment a separate consumer
    // process (or, later, multiple clustered instances) needs to notify
    // clients connected elsewhere.
    let adapter;
    if (process.env.REDIS_URL) {
      try {
        const { createAdapter } = await import('@socket.io/redis-adapter');
        const { default: Redis } = await import('ioredis');
        const pubClient = new Redis(process.env.REDIS_URL);
        const subClient = pubClient.duplicate();
        pubClient.on('error', (err) => logger.error({ err }, '[websocket] Redis adapter pub client error'));
        subClient.on('error', (err) => logger.error({ err }, '[websocket] Redis adapter sub client error'));
        adapter = createAdapter(pubClient, subClient);
        logger.info('[websocket] Redis adapter attached — broadcasts now work across processes');
      } catch (err) {
        logger.error({ err }, '[websocket] Failed to attach Redis adapter — broadcasts limited to this process only');
      }
    } else {
      logger.warn('[websocket] REDIS_URL not configured — WebSocket broadcasts are single-process only');
    }

    this.io = new Server(httpServer, {
      ...(adapter ? { adapter } : {}),
      cors: {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (wsOrigins.includes("*") || wsOrigins.includes(origin)) {
            return callback(null, true);
          }
          if (/^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/i.test(origin)) {
            return callback(null, true);
          }
          const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
          if (appUrl) {
            try {
              const domain = new URL(appUrl).hostname;
              const escapedDomain = domain.replace(/\./g, '\\.');
              const regex = new RegExp(`^https?:\\/\\/([a-z0-9-]+\\.)*${escapedDomain}(:\\d+)?$`, 'i');
              if (regex.test(origin)) {
                return callback(null, true);
              }
            } catch (e) {
              // ignore
            }
          }
          logger.warn({ origin }, '[websocket] Request from blocked origin');
          return callback(new Error("Not allowed by CORS"));
        },
        methods: ["GET", "POST"],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.io.use(async (socket, next) => {
      // S-01: access token is in httpOnly cookie — read it from handshake headers.
      // withCredentials:true on the client sends cookies with the WS upgrade request.
      let token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        const cookieHeader = socket.handshake.headers?.cookie || '';
        const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
        if (match) token = decodeURIComponent(match[1]);
      }
      if (!token) {
        logger.warn({ socketId: socket.id }, '[ws-auth] Reconnecting socket blocked: missing token');
        return next(new Error("Authentication error: token required"));
      }

      try {
        let authPayload;
        const { env } = await import("../config/env.js");

        if (env.authMode === "keycloak") {
          const { verifyKeycloakToken } = await import("../middleware/keycloakVerifier.js");
          const { findUserByKeycloakSub, getRbacPermissionsForUser, getMembershipsByUserId } = await import("../repositories/authRepository.js");
          const { provisionKeycloakUser } = await import("../services/provisionUser.js");
          
          const jwtPayload = await verifyKeycloakToken(token);
          let user = await findUserByKeycloakSub(jwtPayload.sub);
          if (!user) {
            user = await provisionKeycloakUser(jwtPayload);
          }
          let rawMemberships = await getRbacPermissionsForUser(user.pk_user_id);
          if (!rawMemberships || rawMemberships.length === 0) {
            rawMemberships = await getMembershipsByUserId(user.pk_user_id);
          }
          const memberships = rawMemberships.map((row) => ({
            id: String(row.pk_membership_id),
            userId: String(row.fk_user_id),
            role: row.role,
            scope: {
              tenantId: row.tenant_id != null ? String(row.tenant_id) : null,
              customerId: row.customer_id != null ? String(row.customer_id) : null,
              siteId: row.site_id != null ? String(row.site_id) : null,
              unitId: row.unit_id != null ? String(row.unit_id) : null,
            },
            permissions: row.permissions || [],
          }));
          authPayload = { user, memberships };
        } else {
          const { bootstrapWithAccessToken } = await import("../services/authService.js");
          let ip = socket.handshake.address || "";
          if (ip.startsWith("::ffff:")) ip = ip.slice(7);
          const context = {
            ipAddress: ip,
            userAgent: socket.handshake.headers["user-agent"] || "unknown",
          };
          authPayload = await bootstrapWithAccessToken(token, context);
        }

        if (!authPayload) {
          logger.warn({ socketId: socket.id }, '[ws-auth] Reconnecting socket blocked: invalid token');
          return next(new Error("Authentication error: invalid token"));
        }

        // Attach auth context to socket
        socket.auth = authPayload;
        next();
      } catch (err) {
        logger.error({ err }, '[ws-auth] connection auth error');
        return next(new Error("Authentication error: " + err.message));
      }
    });

    this.io.on("connection", (socket) => {
      this.connections.set(socket.id, { socket, ts: Date.now() });
      socket.on("joinTenant", (tenantId) => this.joinTenant(socket, String(tenantId)));
      socket.on("leaveTenant", (tenantId) => this.leaveTenant(socket, String(tenantId)));
      socket.on("disconnect", () => {
        this.connections.delete(socket.id);
      });
    });

    shutdownManager.registerShutdownHandler("socket.io", async () => {
      await this.shutdown();
    });
  }

  joinTenant(socket, tenantId) {
    const memberships = socket.auth?.memberships || [];
    const isSuperAdmin = memberships.some(m => m.scope.tenantId === null);
    const hasTenantAccess = memberships.some(m => String(m.scope.tenantId) === String(tenantId));
    
    if (!isSuperAdmin && !hasTenantAccess) {
      logger.warn({ userId: socket.auth?.user?.id, tenantId }, '[ws-auth] Unauthorized attempt to join tenant room');
      socket.emit("error", { message: "Unauthorized tenant access" });
      return;
    }

    socket.join(`tenant:${tenantId}`);
    if (!this.tenantRooms.has(tenantId)) this.tenantRooms.set(tenantId, new Set());
    this.tenantRooms.get(tenantId).add(socket.id);
  }

  leaveTenant(socket, tenantId) {
    socket.leave(`tenant:${tenantId}`);
    const set = this.tenantRooms.get(tenantId);
    if (set) set.delete(socket.id);
  }

  // Falls back to the Redis emitter when this process has no local `io`
  // (e.g. the Kafka consumer worker) — see redisEmitter.js.
  emitToUser(userId, event, payload) {
    const target = this.io || getRedisEmitter();
    if (!target) return;
    target.to(`user:${userId}`).emit(event, payload);
  }
  emitToTenant(tenantId, event, payload) {
    const target = this.io || getRedisEmitter();
    if (!target) return;
    target.to(`tenant:${tenantId}`).emit(event, payload);
  }
  emitToRoom(room, event, payload) {
    const target = this.io || getRedisEmitter();
    if (!target) return;
    target.to(room).emit(event, payload);
  }
  emitToAll(event, payload) {
    const target = this.io || getRedisEmitter();
    if (!target) return;
    target.emit(event, payload);
  }

  broadcastAttendance(payload) {
    if (!payload) return;
    if (payload.tenantId) {
      this.emitToTenant(payload.tenantId, "attendance.update", payload);
    }
    this.emitToAll("attendance.update", payload);
  }
  broadcastAlert(payload) {
    if (!payload) return;
    if (payload.tenantId) {
      this.emitToTenant(payload.tenantId, "alert", payload);
    }
    this.emitToAll("alert", payload);
  }

  getStats() {
    return {
      connections: this.connections.size,
      rooms: Array.from(this.tenantRooms.keys()),
    };
  }

  async shutdown() {
    if (this.io) {
      await new Promise((resolve) => this.io.close(() => resolve()));
      this.io = null;
      this.connections.clear();
      this.tenantRooms.clear();
    }
  }
}

const socketServer = new SocketServer();
export default socketServer;

