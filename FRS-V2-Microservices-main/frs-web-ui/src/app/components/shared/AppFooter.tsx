import React from 'react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';

interface AppFooterProps {
  /** Whether the sidebar is collapsed — keeps the footer aligned with content. */
  collapsed?: boolean;
}

const APP_VERSION = 'v1.0.0';

/**
 * Global content footer — the fourth layout region after Header, Sidebar, and
 * content. Sits at the bottom of the content column, offset by the sidebar
 * width, and follows the same theme tokens as the rest of the shell.
 */
export const AppFooter: React.FC<AppFooterProps> = ({ collapsed = false }) => {
  const year = new Date().getFullYear();

  return (
    <footer
      className={cn(
        'fixed bottom-0 left-0 right-0 z-10 border-t px-4 md:px-8 py-3 transition-all duration-300',
        'glass-panel',
        collapsed ? 'md:left-20' : 'md:left-64',
      )}
    >
      <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
        <p className={cn('text-xs', lightTheme.text.secondary)}>
          © {year} Motivity Labs. All rights reserved.
        </p>
        <div className={cn('flex items-center gap-4 text-xs', lightTheme.text.muted)}>
          <a href="#" className="hover:text-primary transition-colors">Privacy</a>
          <a href="#" className="hover:text-primary transition-colors">Terms</a>
          <a href="#" className="hover:text-primary transition-colors">Support</a>
          <span className="opacity-60">{APP_VERSION}</span>
        </div>
      </div>
    </footer>
  );
};
