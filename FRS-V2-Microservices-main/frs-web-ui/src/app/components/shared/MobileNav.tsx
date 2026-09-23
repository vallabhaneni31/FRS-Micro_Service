import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { Button } from '../ui/button';
import { LogOut, Moon, Sun, Menu, X } from 'lucide-react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';
import { NotificationsBell, LiveAlert } from './NotificationsBell';

interface MobileNavProps {
  title: string;
  unreadAlerts?: number;
  navigationItems: Array<{
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    value: string;
  }>;
  activeTab: string;
  onNavigate: (value: string) => void;
  liveAlerts?: LiveAlert[];
  onMarkRead?: (ids?: number[]) => Promise<void>;
  onDismiss?: (id: number) => Promise<void>;
  onDismissAll?: () => Promise<void>;
}

const initialsOf = (name: string) =>
  (name || '?')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

/**
 * Mobile (<md) navigation. Mirrors the desktop Sidebar + AppHeader: a fixed,
 * frosted top bar with quick notifications, and a slide-in drawer holding the
 * workspace identity, nav items (same primary-accent active style as the
 * sidebar) and the user actions that live in AppHeader on desktop.
 */
export const MobileNav: React.FC<MobileNavProps> = ({
  title,
  unreadAlerts = 0,
  navigationItems,
  activeTab,
  onNavigate,
  liveAlerts = [],
  onMarkRead,
  onDismiss,
  onDismissAll,
}) => {
  const { user, logout, translateRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const workspaceName = title || 'FRS Platform';
  const portalLabel = `${translateRole(user?.role || '')} Portal`.trim();

  const handleNavigate = (value: string) => {
    onNavigate(value);
    setIsMenuOpen(false);
  };

  return (
    <>
      {/* Mobile Top Bar */}
      <header
        className={cn(
          'md:hidden fixed top-0 left-0 right-0 h-16 z-50 flex items-center justify-between gap-2 px-4 border-b shadow-sm',
          'bg-white/95 dark:bg-slate-950/95 backdrop-blur-md',
        )}
      >
        <img src="/motivity-logo.png" alt="MotivityFRS" className="h-7 w-auto object-contain" />

        <div className="flex items-center gap-1">
          <NotificationsBell
            unreadAlerts={unreadAlerts}
            liveAlerts={liveAlerts}
            onMarkRead={onMarkRead}
            onDismiss={onDismiss}
            onDismissAll={onDismissAll}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMenuOpen((o) => !o)}
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
          >
            {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </Button>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      {isMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          onClick={() => setIsMenuOpen(false)}
        >
          <div
            className={cn(
              'w-[85vw] max-w-sm ml-auto h-full overflow-y-auto flex flex-col',
              'glass-panel border-l rounded-l-2xl',
              'motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-300',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Workspace + user identity */}
            <div className={cn('p-4 border-b', lightTheme.border.default)}>
              <div className="flex items-center justify-between mb-3">
                <p className={cn('text-sm font-semibold truncate', lightTheme.text.primary)}>
                  {workspaceName}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsMenuOpen(false)}
                  aria-label="Close menu"
                  className="-mr-1 shrink-0"
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>
              <div
                className={cn(
                  'flex items-center gap-3 p-2.5 rounded-xl border',
                  'bg-sidebar-accent/40 border-sidebar-border',
                )}
              >
                <span className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold shrink-0">
                  {initialsOf(user?.name || user?.email || '')}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={cn('text-sm font-medium truncate', lightTheme.text.primary)}>{user?.name}</p>
                  <p className={cn('text-[11px] truncate', lightTheme.text.muted)}>{portalLabel}</p>
                </div>
              </div>
            </div>

            {/* Navigation Items */}
            <nav className="flex-1 overflow-y-auto p-3">
              <div className="space-y-1">
                {navigationItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.value;

                  return (
                    <button
                      key={item.value}
                      onClick={() => handleNavigate(item.value)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'group relative w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-colors outline-none',
                        'focus-visible:ring-2 focus-visible:ring-primary/50',
                        isActive
                          ? 'bg-primary/10 text-primary font-semibold'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-primary" />
                      )}
                      <Icon
                        className={cn('w-5 h-5 shrink-0', isActive ? 'text-primary' : 'text-sidebar-foreground/60')}
                      />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            {/* Actions */}
            <div className={cn('p-3 border-t space-y-2', lightTheme.border.default)}>
              <NotificationsBell
                variant="full"
                unreadAlerts={unreadAlerts}
                liveAlerts={liveAlerts}
                onMarkRead={onMarkRead}
                onDismiss={onDismiss}
                onDismissAll={onDismissAll}
              />

              <Button variant="outline" size="sm" className="w-full justify-start" onClick={toggleTheme}>
                {theme === 'light' ? (
                  <>
                    <Moon className="w-4 h-4 mr-2" />
                    Dark Mode
                  </>
                ) : (
                  <>
                    <Sun className="w-4 h-4 mr-2" />
                    Light Mode
                  </>
                )}
              </Button>

              <Button variant="destructive" size="sm" className="w-full justify-start" onClick={logout}>
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
