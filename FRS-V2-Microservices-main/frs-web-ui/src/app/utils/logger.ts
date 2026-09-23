type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN_LEVEL: Level = import.meta.env.PROD ? 'info' : 'debug';

// Last correlation ID seen from any API response — set by apiClient
let _correlationId: string | null = null;
export function setLogCorrelationId(id: string | null) { _correlationId = id; }
export function getLogCorrelationId() { return _correlationId; }

function log(level: Level, namespace: string, message: string, meta?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

    const entry: Record<string, unknown> = {
        ts:  new Date().toISOString(),
        lvl: level,
        ns:  namespace,
        msg: message,
        ...(meta ?? {}),
    };
    if (_correlationId) entry.cid = _correlationId;

    const line = import.meta.env.PROD
        ? JSON.stringify(entry)
        : `[${entry.ts}] [${level.toUpperCase().padEnd(5)}] [${namespace}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}${_correlationId ? ` (cid=${_correlationId})` : ''}`;

    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'debug' : level](line);
}

export interface Logger {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info:  (msg: string, meta?: Record<string, unknown>) => void;
    warn:  (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
}

export function createLogger(namespace: string): Logger {
    return {
        debug: (msg, meta) => log('debug', namespace, msg, meta),
        info:  (msg, meta) => log('info',  namespace, msg, meta),
        warn:  (msg, meta) => log('warn',  namespace, msg, meta),
        error: (msg, meta) => log('error', namespace, msg, meta),
    };
}
