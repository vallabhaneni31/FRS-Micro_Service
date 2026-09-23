/**
 * logger.js — FIX-016: Structured Pino-compatible logger
 *
 * Drop-in wrapper that:
 *   1. Uses real Pino when available (preferred in production).
 *   2. Falls back to a structured JSON/colorised custom logger that supports
 *      BOTH calling conventions:
 *        • logger.info('message')                   — simple string
 *        • logger.info('message', { meta })         — original convention
 *        • logger.info({ field, err }, 'message')  — Pino convention (new)
 *
 * This keeps existing callers working while letting new code use the Pino idiom.
 */

let pinoLogger = null;

// Try to load Pino — it's listed in package.json so should be available.
try {
  const { default: pino } = await import('pino');
  pinoLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['*.password', '*.token', '*.secret', '*.embedding', '*.face_embedding',
              'req.headers.authorization', 'req.headers.cookie'],
      censor: '[REDACTED]',
    },
    ...(process.env.NODE_ENV !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    }),
  });
} catch (_) {
  // Pino not installed — use fallback logger below
}

// ── Fallback structured logger ────────────────────────────────────────────────
class FallbackLogger {
  #nodeEnv = process.env.NODE_ENV || 'development';

  #normalise(args) {
    // Pino style: (object, message)
    if (args.length >= 2 && typeof args[0] === 'object' && typeof args[1] === 'string') {
      return { message: args[1], meta: args[0] };
    }
    // Classic style: (message, object?)
    if (typeof args[0] === 'string') {
      return { message: args[0], meta: args[1] || {} };
    }
    // Error object first
    if (args[0] instanceof Error) {
      return { message: args[0].message, meta: { stack: args[0].stack, ...args[1] } };
    }
    return { message: String(args[0]), meta: {} };
  }

  #format(level, message, meta = {}) {
    const ts = new Date().toISOString();
    const cleanMeta = { ...meta };

    // Redact sensitive fields
    for (const key of ['password', 'token', 'secret', 'embedding', 'face_embedding', 'authorization']) {
      if (key in cleanMeta) cleanMeta[key] = '[REDACTED]';
    }

    if (this.#nodeEnv === 'production') {
      return JSON.stringify({ ts, level, message, ...cleanMeta });
    }

    const colors = { INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', DEBUG: '\x1b[36m' };
    const reset  = '\x1b[0m';
    const color  = colors[level] || reset;
    const metaStr = Object.keys(cleanMeta).length ? ` ${JSON.stringify(cleanMeta)}` : '';
    return `[${ts}] ${color}${level}${reset}: ${message}${metaStr}`;
  }

  info(...args)  { const { message, meta } = this.#normalise(args); console.log(this.#format('INFO',  message, meta)); }
  warn(...args)  { const { message, meta } = this.#normalise(args); console.warn(this.#format('WARN',  message, meta)); }
  error(...args) { const { message, meta } = this.#normalise(args); console.error(this.#format('ERROR', message, meta)); }
  debug(...args) { if ((process.env.LOG_LEVEL || 'info') === 'debug') {
    const { message, meta } = this.#normalise(args); console.debug(this.#format('DEBUG', message, meta)); } }

  child(bindings) {
    const child = new FallbackLogger();
    const origInfo  = child.info.bind(child);
    const origWarn  = child.warn.bind(child);
    const origError = child.error.bind(child);
    child.info  = (...a) => { const n = child.#normalise(a); origInfo({ ...bindings, ...n.meta }, n.message); };
    child.warn  = (...a) => { const n = child.#normalise(a); origWarn({ ...bindings, ...n.meta }, n.message); };
    child.error = (...a) => { const n = child.#normalise(a); origError({ ...bindings, ...n.meta }, n.message); };
    return child;
  }
}

const logger = pinoLogger ?? new FallbackLogger();
export default logger;
