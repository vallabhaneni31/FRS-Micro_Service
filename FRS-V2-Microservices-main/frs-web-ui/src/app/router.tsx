/**
 * router.tsx — W-01: React Router v7 deep linking
 *
 * URL structure:
 *   /                          → redirect → /dashboard
 *   /login                     → LoginPage (redirects to /dashboard if already authed)
 *   /setup-password/:token     → public password-setup (invite flow)
 *   /enroll/:token             → public self-enrollment portal
 *   /dashboard                 → DashboardRenderer (redirects to first nav item)
 *   /dashboard/:page           → DashboardRenderer at specific page
 *
 * nginx already serves `try_files $uri $uri/ /index.html` so all deep links
 * survive a hard refresh.
 */
import React, { useEffect } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  ScrollRestoration,
} from 'react-router';
import { Loader2 } from 'lucide-react';

import { ThemeProvider }     from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { UnsavedChangesProvider } from './components/shared/UnsavedChangesProvider';
import { ErrorBoundary }          from './components/shared/ErrorBoundary';
import { ManifestProvider }  from './contexts/ManifestContext';
import { Toaster }           from './components/ui/sonner';
import { OfflineBanner }     from './components/shared/OfflineBanner';
import { LoginPage }         from './components/LoginPage';
import { authConfig, getRedirectUri } from './config/authConfig';
import keycloak              from './services/auth/keycloakInstance';
import { DashboardRenderer } from './components/DashboardRenderer';
import { SelfEnrollmentPortal } from './components/enrollment/SelfEnrollmentPortal';
import { SetupPasswordPage }    from './components/SetupPasswordPage';
import { RetailInviteAcceptPage } from './components/RetailInviteAcceptPage';
import { apiRequest }        from './services/http/apiClient';
import { setSiteTimezone }   from './utils/timezone';
import { useScopeHeaders }   from './hooks/useScopeHeaders';

// ── Public route wrappers (extract token param, pass as prop) ─────────────

function SetupPasswordRoute() {
  const { token } = useParams<{ token: string }>();
  return <SetupPasswordPage token={token!} />;
}

function EnrollmentRoute() {
  const { token } = useParams<{ token: string }>();
  return <SelfEnrollmentPortal token={token!} />;
}

function RetailInviteRoute() {
  const { token } = useParams<{ token: string }>();
  return <RetailInviteAcceptPage token={token!} />;
}

// ── Shared full-screen loader ─────────────────────────────────────────────
// One themed splash for every pre-app phase (session init, KC redirect) so the
// hand-off into DashboardRenderer's matching glass-card loader is seamless —
// no jump from a flat dark screen to a frosted card. Theme-aware via tokens.
const FullScreenStatus: React.FC<{ label: string; role?: string }> = ({ label, role = 'status' }) => (
  <div role={role} aria-label={label} className="app-canvas min-h-screen flex items-center justify-center text-foreground">
    <div className="glass-card flex flex-col items-center gap-3 rounded-2xl border px-10 py-8">
      <Loader2 className="w-8 h-8 animate-spin text-primary" aria-hidden="true" />
      <p className="text-sm tracking-wide uppercase text-muted-foreground">{label}</p>
    </div>
  </div>
);

// ── Root layout — provides all shared context ─────────────────────────────

function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ScrollRestoration />
        <Outlet />
        <Toaster />
        <OfflineBanner />
      </AuthProvider>
    </ThemeProvider>
  );
}

// ── Keycloak redirect — triggers hosted KC login page ─────────────────────

function RedirectToKeycloak() {
  useEffect(() => {
    // Redirect to Keycloak's own login page.
    // After login KC will redirect back to window.location.origin (/).
    if (!keycloak.authenticated) {
      keycloak.login({ redirectUri: getRedirectUri('/') });
    }
  }, []);

  return <FullScreenStatus label="Redirecting to sign in…" />;
}

// ── Login guard — in Keycloak mode, redirect to KC; otherwise show LoginPage

function LoginGuard() {
  const { isAuthenticated, isAuthLoading } = useAuth();

  if (isAuthLoading) {
    return <FullScreenStatus label="Initializing session…" />;
  }

  // If already authenticated, go straight to dashboard
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  return <LoginPage />;
}

// ── Auth guard — bounces unauthenticated users to Keycloak (or /login) ────
// Also loads the site timezone once (S-01: use isAuthenticated, not accessToken,
// because in httpOnly cookie mode accessToken is always null in JS).

function AuthGuard() {
  const { isAuthenticated, isAuthLoading } = useAuth();
  const scopeHeaders = useScopeHeaders();

  useEffect(() => {
    if (!isAuthenticated) return;
    apiRequest<{ timezone: string }>('/site/settings', { scopeHeaders })
      .then(d => { if (d?.timezone) setSiteTimezone(d.timezone); })
      .catch(() => {});
  }, [isAuthenticated, JSON.stringify(scopeHeaders)]);

  if (isAuthLoading) {
    return <FullScreenStatus label="Initializing session…" />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <ErrorBoundary pageName="application">
      <UnsavedChangesProvider>
        <ManifestProvider>
          <Outlet />
        </ManifestProvider>
      </UnsavedChangesProvider>
    </ErrorBoundary>
  );
}

// ── Router ────────────────────────────────────────────────────────────────

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      // ── Public routes (no auth required) ──────────────────────────────
      { path: '/setup-password/:token', element: <SetupPasswordRoute /> },
      { path: '/enroll/:token',         element: <EnrollmentRoute />    },
      { path: '/retail-invite/:token',  element: <RetailInviteRoute />  },
      { path: '/login',                 element: <LoginGuard />         },

      // ── Protected routes ───────────────────────────────────────────────
      {
        element: <AuthGuard />,
        children: [
          // Root → dashboard
          { index: true, element: <Navigate to="/dashboard" replace /> },
          // Dashboard without a page key — DashboardRenderer auto-redirects to first nav item
          { path: '/dashboard',       element: <DashboardRenderer /> },
          // Dashboard with explicit page key — deep-linkable
          { path: '/dashboard/:page', element: <DashboardRenderer /> },
          // Role-scoped page keys contain a slash: /dashboard/hr_manager/dashboard
          { path: '/dashboard/:role/:page', element: <DashboardRenderer /> },
        ],
      },

      // ── Catch-all 404 ─────────────────────────────────────────────────
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
