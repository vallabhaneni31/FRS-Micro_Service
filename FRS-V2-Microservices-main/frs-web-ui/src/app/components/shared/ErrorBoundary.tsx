/**
 * ErrorBoundary — W-05
 * Per-page error boundary. Catches render errors in child components and
 * shows a recovery UI instead of crashing the entire dashboard.
 *
 * Usage:
 *   <ErrorBoundary pageName="Attendance">
 *     <AttendancePage />
 *   </ErrorBoundary>
 */
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { captureError } from '../../utils/sentry';

interface Props {
  children: ReactNode;
  /** Page label shown in the error message */
  pageName?: string;
  /** Called after user clicks "Try again" */
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureError(error, {
      componentStack: info.componentStack,
      page: this.props.pageName,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-slate-400 p-8">
        <AlertTriangle className="w-10 h-10 text-rose-400 opacity-80" />
        <div className="text-center">
          <p className="text-slate-200 font-medium mb-1">
            {this.props.pageName
              ? `Something went wrong on the ${this.props.pageName} page`
              : 'Something went wrong'}
          </p>
          <p className="text-sm text-slate-500 max-w-sm">
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
        </div>
        <button
          onClick={this.handleReset}
          className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
      </div>
    );
  }
}
