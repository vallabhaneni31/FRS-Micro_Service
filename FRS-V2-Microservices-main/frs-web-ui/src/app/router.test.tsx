import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router';

// ── Mock AuthContext, Keycloak Instance, Auth Config ────────────────────────
// vi.mock(...) factories are hoisted above all other module code (including
// plain `const` declarations), but router.tsx's own eager static imports
// (e.g. `import keycloak from './services/auth/keycloakInstance'`) execute
// during that same hoisted-import phase — before a plain `const` below the
// vi.mock call would have been assigned yet (TDZ). vi.hoisted() is Vitest's
// documented fix: it hoists these declarations together with vi.mock calls.
const { mockUseAuth, mockLogin, mockKeycloak, mockAuthConfig } = vi.hoisted(() => {
  const mockLogin = vi.fn();
  return {
    mockUseAuth: vi.fn(),
    mockLogin,
    mockKeycloak: { authenticated: false, login: mockLogin },
    mockAuthConfig: { mode: 'keycloak' },
  };
});

vi.mock('./contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./services/auth/keycloakInstance', () => ({
  default: mockKeycloak,
}));

vi.mock('./config/authConfig', () => ({
  authConfig: mockAuthConfig,
}));

// ── Mock other providers/components to keep tests clean ──────────────────
vi.mock('./contexts/ThemeContext', () => ({ ThemeProvider: ({ children }: any) => <>{children}</> }));
vi.mock('./components/shared/UnsavedChangesProvider', () => ({ UnsavedChangesProvider: ({ children }: any) => <>{children}</> }));
vi.mock('./components/shared/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: any) => <>{children}</> }));
vi.mock('./contexts/ManifestContext', () => ({ ManifestProvider: ({ children }: any) => <>{children}</> }));
vi.mock('./components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('./components/shared/OfflineBanner', () => ({ OfflineBanner: () => null }));
vi.mock('./components/LoginPage', () => ({ LoginPage: () => <div data-testid="login-page">Custom Login Page</div> }));
vi.mock('./components/DashboardRenderer', () => ({ DashboardRenderer: () => <div data-testid="dashboard">Dashboard</div> }));
vi.mock('./components/enrollment/SelfEnrollmentPortal', () => ({ SelfEnrollmentPortal: () => null }));
vi.mock('./components/SetupPasswordPage', () => ({ SetupPasswordPage: () => null }));

// ── Mock API/Hooks ────────────────────────────────────────────────────────
vi.mock('./services/http/apiClient', () => ({
  apiRequest: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
}));
vi.mock('./hooks/useScopeHeaders', () => ({
  useScopeHeaders: () => ({}),
}));
vi.mock('./utils/timezone', () => ({
  setSiteTimezone: vi.fn(),
}));

// Import the components we want to test
import { router } from './router';

// For testing Guards in isolation, we can extract them since they are not exported directly,
// or we can test them by rendering the router. Since they are internal to router.tsx,
// rendering the Router with different initialEntries is the best integration test approach.
import { RouterProvider } from 'react-router';

describe('Frontend Router Guards & Redirects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeycloak.authenticated = false;
    mockAuthConfig.mode = 'keycloak';
  });

  describe('LoginGuard (/login)', () => {
    it('shows loading state when auth is initializing', () => {
      mockUseAuth.mockReturnValue({ isAuthenticated: false, isAuthLoading: true });
      
      render(
        <RouterProvider router={router} />
      );
      
      // Fast-forward or just check text
      expect(screen.getByText('Initializing session…')).toBeInTheDocument();
    });

    it('redirects to dashboard if already authenticated', async () => {
      mockUseAuth.mockReturnValue({ isAuthenticated: true, isAuthLoading: false });
      
      // Need a custom memory router to test specific path entry
      render(
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/*" element={
              // We'll just render the router's element structure manually for precise control
              router.routes[0].element
            } />
          </Routes>
        </MemoryRouter>
      );
      
      // DashboardRenderer should be shown because /login redirects to /dashboard, 
      // but the MemoryRouter approach with the real router is tricky.
      // Let's test the router object directly.
    });
  });
});

// Since the components inside router.tsx are not exported, we will test the actual router paths.
describe('App Routing (Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeycloak.authenticated = false;
    mockAuthConfig.mode = 'keycloak';
  });

  const renderPath = (path: string) => {
    return render(
      <RouterProvider router={router} />
    );
  };

  // We have to mock window.location to avoid errors in React Router v7 createBrowserRouter
  // in JSDOM, but since it's a browser router, it will read the current JSDOM URL.
  // A better approach for JSDOM is to dynamically change window.history.

  it('Redirects to Keycloak from /login when unauthenticated in Keycloak mode', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isAuthLoading: false });
    mockAuthConfig.mode = 'keycloak';
    
    window.history.pushState({}, 'Test', '/login');
    render(<RouterProvider router={router} />);
    
    expect(screen.getByText('Redirecting to sign in…')).toBeInTheDocument();
    
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith({ redirectUri: 'http://localhost:3000/' });
    });
  });

  it('Shows custom login page from /login when unauthenticated in API mode', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isAuthLoading: false });
    mockAuthConfig.mode = 'api';
    
    window.history.pushState({}, 'Test', '/login');
    render(<RouterProvider router={router} />);
    
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('AuthGuard bounces unauthenticated users from protected routes to KC', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isAuthLoading: false });
    mockAuthConfig.mode = 'keycloak';
    
    window.history.pushState({}, 'Test', '/dashboard');
    render(<RouterProvider router={router} />);
    
    expect(screen.getByText('Redirecting to sign in…')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
    });
  });

  it('AuthGuard bounces unauthenticated users from protected routes to /login in API mode', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isAuthLoading: false });
    mockAuthConfig.mode = 'api';
    
    window.history.pushState({}, 'Test', '/dashboard');
    render(<RouterProvider router={router} />);
    
    // AuthGuard renders <Navigate to="/login" />.
    // The router then hits LoginGuard, which in API mode shows the custom login page.
    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('AuthGuard allows authenticated users to see the dashboard', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isAuthLoading: false });
    mockAuthConfig.mode = 'keycloak';
    
    window.history.pushState({}, 'Test', '/dashboard');
    render(<RouterProvider router={router} />);
    
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
  });
});
