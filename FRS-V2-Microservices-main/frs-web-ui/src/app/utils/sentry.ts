import * as Sentry from '@sentry/react';

let _initialized = false;

/**
 * Initialize Sentry. Gated on VITE_SENTRY_DSN — no-ops when not configured.
 * Call once from main.tsx before rendering.
 */
export function initSentry() {
    const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
    if (!dsn) return;

    Sentry.init({
        dsn,
        environment: import.meta.env.MODE,
        release:     import.meta.env.VITE_APP_VERSION as string | undefined,
        // Capture 100% of errors; adjust sample rate for performance monitoring if needed
        tracesSampleRate: 0,
        // Redact sensitive data from breadcrumbs
        beforeBreadcrumb(breadcrumb) {
            if (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') {
                const url = breadcrumb.data?.url as string | undefined;
                // Don't send auth endpoint breadcrumbs
                if (url && (url.includes('/auth/') || url.includes('/enroll/'))) return null;
            }
            return breadcrumb;
        },
    });
    _initialized = true;
}

export function captureError(error: Error, context?: Record<string, unknown>) {
    if (!_initialized) return;
    Sentry.captureException(error, { extra: context });
}

export function captureMessage(msg: string, level: Sentry.SeverityLevel = 'error') {
    if (!_initialized) return;
    Sentry.captureMessage(msg, level);
}
