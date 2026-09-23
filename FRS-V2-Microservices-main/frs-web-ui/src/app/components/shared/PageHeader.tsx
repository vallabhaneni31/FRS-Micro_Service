import React from 'react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';

interface PageHeaderProps {
  /** Page title, e.g. "Tenant Management". */
  title: string;
  /** Optional sub-text shown under the title (count, description). */
  subtitle?: React.ReactNode;
  /** Optional leading icon rendered in a tinted square next to the title. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Right-aligned action controls (buttons, filters). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Standard in-content page header: leading icon + title + subtitle on the left,
 * action controls on the right. Replaces the per-page hand-rolled title blocks
 * so every screen shares the same spacing, typography, and theme tokens.
 *
 * Pairs with the global <AppHeader> (top app-bar). Use this inside each page's
 * content; the breadcrumb/identity lives in AppHeader.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon: Icon,
  actions,
  className,
}) => (
  <div className={cn('flex items-start justify-between flex-wrap gap-3', className)}>
    <div className="flex items-center gap-3 min-w-0">
      {Icon && (
        <div
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
            lightTheme.primary.selectedBg,
            lightTheme.primary.selectedText,
          )}
        >
          <Icon className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0">
        <h1 className={cn('text-2xl font-bold truncate', lightTheme.text.primary)}>
          {title}
        </h1>
        {subtitle != null && (
          <p className={cn('text-sm mt-0.5', lightTheme.text.secondary)}>{subtitle}</p>
        )}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
  </div>
);
