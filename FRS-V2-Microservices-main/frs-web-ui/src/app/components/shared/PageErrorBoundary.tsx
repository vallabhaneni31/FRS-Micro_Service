/**
 * PageErrorBoundary — W-05
 * Wraps ErrorBoundary and resets when the route changes (via location.key),
 * so navigating to a different page automatically clears a previous error.
 */
import React from 'react';
import { useLocation } from 'react-router';
import { ErrorBoundary } from './ErrorBoundary';

interface Props {
  children: React.ReactNode;
  pageName?: string;
}

export const PageErrorBoundary: React.FC<Props> = ({ children, pageName }) => {
  const location = useLocation();
  // Keying on location.pathname forces a full remount — and therefore boundary reset —
  // only when the page path changes (not when search parameters change).
  return (
    <ErrorBoundary key={location.pathname} pageName={pageName}>
      {children}
    </ErrorBoundary>
  );
};
