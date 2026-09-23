/**
 * redisEmitter.js — lets a process without its own Socket.IO server (e.g.
 * workers/deviceEventConsumer.js) publish WebSocket events that reach
 * clients connected to a DIFFERENT process (frs-backend).
 *
 * Socket.IO's redis-emitter implements the same `.to(room).emit(event, payload)`
 * interface as a real `io` instance, but only publishes to Redis — it never
 * accepts connections. frs-backend's own `io` has the matching
 * @socket.io/redis-adapter attached (see server.js), which subscribes to
 * that same Redis channel and delivers to its locally-connected sockets.
 * Without this, every wsManager broadcast call made from a process other
 * than frs-backend was a silent no-op (getIO() returned undefined, and the
 * try/catch around every broadcast method swallowed the resulting error) —
 * this was actually happening in production the moment device event
 * processing moved into a separate consumer process (Phase 2).
 */
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import logger from '../utils/logger.js';

let emitter = null;
let attemptedInit = false;

export function getRedisEmitter() {
  if (emitter) return emitter;
  if (attemptedInit) return null;
  attemptedInit = true;

  if (!process.env.REDIS_URL) {
    logger.warn(
      '[websocket] REDIS_URL not configured — WebSocket broadcasts from this ' +
      'process cannot reach clients connected to a different process.'
    );
    return null;
  }

  const client = new Redis(process.env.REDIS_URL);
  client.on('error', (err) => {
    logger.error({ err }, '[websocket] Redis emitter connection error');
  });
  emitter = new Emitter(client);
  return emitter;
}
