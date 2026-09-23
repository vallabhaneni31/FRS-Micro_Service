import logger from '../utils/logger.js';

const SKIP_PATHS = new Set(['/api/health', '/api/health/live', '/api/health/ready']);

export function requestLogger(req, res, next) {
    if (SKIP_PATHS.has(req.path)) return next();

    const start = Date.now();

    res.on('finish', () => {
        const durationMs = Date.now() - start;
        const level = res.statusCode >= 500 ? 'error'
                    : res.statusCode >= 400 ? 'warn'
                    : 'info';

        logger[level]({
            cid:        req.correlationId,
            method:     req.method,
            path:       req.path,
            status:     res.statusCode,
            durationMs,
            ip:         req.ip,
        }, `${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`);
    });

    next();
}
