import React from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';
import { SidebarNavEntry, isGroupedNavEntry } from './navGrouping';

interface SidebarProps {
  title: string;
  navigationItems?: SidebarNavEntry[];
  activeTab?: string;
  onNavigate?: (value: string) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
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
 * Primary navigation rail. Branding + workspace identity + nav items only —
 * the user/notifications/theme/logout actions live in the global <AppHeader>,
 * so this stays a pure navigation region.
 *
 * Modern dashboard styling: a workspace identity card, pill active states with
 * a primary accent bar, tinted active icons, subtle hover micro-interactions,
 * a floating edge collapse toggle, and an icon-only collapsed mode with tooltips.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  title,
  navigationItems = [],
  activeTab,
  onNavigate,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const { user, translateRole } = useAuth();
  const portalLabel = `${translateRole(user?.role || '')} Portal`.trim();
  const workspaceName = title || 'FRS Platform';
  const initials = initialsOf(workspaceName);

  const [hoveredItem, setHoveredItem] = React.useState<{ label: string; top: number; children?: string[] } | null>(null);

  React.useEffect(() => {
    setHoveredItem(null);
  }, [isCollapsed]);

  // AC 1.2: grouped sections start expanded (as in the prototype); AC 1.3: the group
  // containing the active child is always expanded.
  const activeGroupLabel = React.useMemo(() => {
    const group = navigationItems.find(
      (entry) => isGroupedNavEntry(entry) && entry.children.some((c) => c.value === activeTab)
    );
    return group ? group.label : null;
  }, [navigationItems, activeTab]);

  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(
    () => new Set(navigationItems.filter(isGroupedNavEntry).map((entry) => entry.label))
  );

  React.useEffect(() => {
    if (activeGroupLabel) {
      setExpandedGroups((prev) => (prev.has(activeGroupLabel) ? prev : new Set(prev).add(activeGroupLabel)));
    }
  }, [activeGroupLabel]);

  const toggleGroup = (label: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const renderLeafButton = (item: { label: string; icon: React.ComponentType<{ className?: string }>; value: string }, isGroupChild: boolean) => {
    const Icon = item.icon;
    const isActive = activeTab === item.value;
    return (
      <button
        key={item.value}
        onClick={() => {
          setHoveredItem(null);
          onNavigate?.(item.value);
        }}
        onMouseEnter={(e) => {
          if (isCollapsed) {
            const rect = e.currentTarget.getBoundingClientRect();
            const asideRect = e.currentTarget.closest('aside')?.getBoundingClientRect();
            const relativeTop = rect.top - (asideRect?.top || 0) + (rect.height / 2);
            setHoveredItem({
              label: item.label,
              top: relativeTop,
            });
          }
        }}
        onMouseLeave={() => {
          setHoveredItem(null);
        }}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'group relative w-full flex items-center rounded-xl text-sm font-medium transition-colors duration-150 outline-none',
          'focus-visible:ring-2 focus-visible:ring-primary/50',
          isCollapsed ? 'justify-center h-11 w-11 mx-auto px-0' : 'gap-3 px-3 py-2.5',
          isGroupChild && !isCollapsed && 'text-xs py-2',
          // An active group child is a filled accent pill with white text (prototype Sidebar.tsx, AC 1.2).
          isActive && isGroupChild && !isCollapsed && 'bg-primary text-primary-foreground font-semibold shadow-2xs',
          isActive && !(isGroupChild && !isCollapsed) && 'bg-primary/10 text-primary font-semibold',
          !isActive && 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
        )}
        title={isCollapsed ? item.label : undefined}
      >
        {/* Active accent bar */}
        {isActive && !(isGroupChild && !isCollapsed) && (
          <span
            className={cn(
              'absolute top-1/2 -translate-y-1/2 rounded-r-full bg-primary',
              isCollapsed ? 'left-0 h-5 w-1' : 'left-0 h-6 w-1',
            )}
          />
        )}
        <span
          className={cn(
            'flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-110',
          )}
        >
          <Icon
            className={cn(
              isCollapsed ? 'w-6 h-6' : isGroupChild ? 'w-4 h-4' : 'w-5 h-5',
              isActive ? (isGroupChild && !isCollapsed ? 'text-primary-foreground' : 'text-primary') : 'text-sidebar-foreground/60 group-hover:text-primary',
            )}
          />
        </span>
        {!isCollapsed && <span className="truncate">{item.label}</span>}
      </button>
    );
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-screen border-r flex flex-col z-50 hidden md:flex transition-[width] duration-300 ease-in-out',
        isCollapsed ? 'w-20' : 'w-64',
        'glass-panel text-sidebar-foreground',
      )}
    >
      {/* Floating edge collapse toggle */}
      <button
        onClick={onToggleCollapse}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'absolute top-5 -right-3 z-30 w-6 h-6 rounded-full flex items-center justify-center',
          'border shadow-sm transition-colors',
          'bg-card text-muted-foreground hover:text-primary hover:border-primary/40',
          lightTheme.border.default,
        )}
      >
        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>

      {/* Brand header */}
      <div
        className={cn(
          'h-16 flex items-center border-b border-sidebar-border shrink-0',
          isCollapsed ? 'justify-center px-2' : 'px-5',
        )}
      >
        {isCollapsed ? (
          <img src="/motivity-icon.png" alt="Motivity" className="w-9 h-9 object-contain rounded-lg" />
        ) : (
          <img src="/motivity-logo.png" alt="MotivityFRS" className="h-7 w-auto object-contain" />
        )}
      </div>

      {/* Workspace identity */}
      <div className={cn('shrink-0', isCollapsed ? 'px-2 py-3 flex justify-center' : 'p-3')}>
        {isCollapsed ? (
          <span
            className="w-10 h-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center text-xs font-bold"
            title={`${workspaceName} · ${portalLabel}`}
          >
            {initials}
          </span>
        ) : (
          <div
            className={cn(
              'flex items-center gap-2.5 rounded-xl border p-2.5',
              'bg-sidebar-accent/40 border-sidebar-border',
            )}
          >
            <span className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center text-xs font-bold shrink-0">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-semibold truncate', lightTheme.text.primary)}>{workspaceName}</p>
              <p className={cn('text-[11px] truncate', lightTheme.text.muted)}>{portalLabel}</p>
            </div>
          </div>
        )}
      </div>

      {/* Section label */}
      {!isCollapsed && (
        <div className="px-5 pt-1 pb-1.5">
          <span className={cn('text-[10.5px] font-semibold uppercase tracking-[0.12em]', lightTheme.text.muted)}>
            Menu
          </span>
        </div>
      )}

      {/* Navigation */}
      {navigationItems.length > 0 && (
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-1 [scrollbar-width:thin]">
          <div className="space-y-1">
            {navigationItems.map((item) => {
              if (isGroupedNavEntry(item)) {
                const GroupIcon = item.icon;
                const isExpanded = expandedGroups.has(item.label);
                const isChildActive = item.children.some((c) => c.value === activeTab);

                if (isCollapsed) {
                  // AC 1.7: collapsed sidebar shows the group icon with a hover
                  // tooltip listing its child views (matching the existing
                  // collapsed-sidebar single-item tooltip pattern).
                  return (
                    <button
                      key={`group-${item.label}`}
                      data-testid="sidebar-group-collapsed"
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const asideRect = e.currentTarget.closest('aside')?.getBoundingClientRect();
                        const relativeTop = rect.top - (asideRect?.top || 0) + (rect.height / 2);
                        setHoveredItem({
                          label: item.label,
                          top: relativeTop,
                          children: item.children.map((c) => c.label),
                        });
                      }}
                      onMouseLeave={() => setHoveredItem(null)}
                      className={cn(
                        'group relative w-11 h-11 mx-auto flex items-center justify-center rounded-xl outline-none',
                        'focus-visible:ring-2 focus-visible:ring-primary/50',
                        isChildActive
                          ? 'bg-blue-600/10 text-blue-600'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60',
                      )}
                    >
                      <GroupIcon className={cn('w-6 h-6', isChildActive ? 'text-blue-600' : 'text-sidebar-foreground/60')} />
                    </button>
                  );
                }

                return (
                  <div key={`group-${item.label}`} data-testid="sidebar-group" className="space-y-1">
                    {/* Rounded group container, blue leading accent, zone icon, "4 VIEWS" badge, chevron */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.label)}
                      aria-expanded={isExpanded}
                      className={cn(
                        'group relative w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
                        'border-l-2 border-l-blue-600',
                        isChildActive ? 'bg-blue-600/10 text-blue-600' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60',
                      )}
                    >
                      <GroupIcon className={cn('w-5 h-5 shrink-0', isChildActive ? 'text-blue-600' : 'text-sidebar-foreground/60')} />
                      <span className="flex-1 truncate text-left">{item.label}</span>
                      {item.badge && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-600/15 text-blue-600 shrink-0">
                          {item.badge}
                        </span>
                      )}
                      <ChevronDown
                        className={cn('w-4 h-4 shrink-0 transition-transform', isExpanded ? 'rotate-0' : '-rotate-90')}
                      />
                    </button>

                    {isExpanded && (
                      <div className="ml-4 border-l pl-3 space-y-1 border-sidebar-border">
                        {item.children.map((child) => renderLeafButton(child, true))}
                      </div>
                    )}
                  </div>
                );
              }

              return renderLeafButton(item, false);
            })}
          </div>
        </nav>
      )}

      {/* Floating Tooltip outside scrolling container */}
      {isCollapsed && hoveredItem && (
        <span
          role="tooltip"
          style={{ top: hoveredItem.top }}
          className={cn(
            'pointer-events-none absolute left-full -translate-y-1/2 ml-3 z-50 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium shadow-md',
            'bg-popover text-popover-foreground border border-border',
          )}
        >
          {hoveredItem.children && hoveredItem.children.length > 0 ? (
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold">{hoveredItem.label}</span>
              {hoveredItem.children.map((child) => (
                <span key={child} className="text-popover-foreground/70">{child}</span>
              ))}
            </span>
          ) : (
            hoveredItem.label
          )}
        </span>
      )}
    </aside>
  );
};
