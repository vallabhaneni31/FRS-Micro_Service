import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Building2, Users } from 'lucide-react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';

/**
 * Generic, vertical-agnostic hierarchy node. Corporate uses it for
 * Organization -> Department(Manager); Education uses it for School -> Class.
 * Pattern (local Set-based expand/collapse, recursive render) generalized
 * from FacilityHierarchyManager.tsx's Building/Floor/Area tree.
 */
export interface WorkspaceTreeNode {
  id: string;            // stable key, e.g. dept id, "unassigned", or "10-A"
  label: string;          // "Engineering", "Class 10 - A"
  sublabel?: string;       // "Manager: Jane Doe", "34 students"
  count?: number;          // member count badge
  children?: WorkspaceTreeNode[];
}

interface WorkspaceTreeProps {
  rootLabel: string;       // "Organization" / school/tenant name
  rootCount?: number;
  nodes: WorkspaceTreeNode[];
  selectedId?: string;     // '' / undefined = root selected (no filter)
  onSelect: (node: WorkspaceTreeNode | null) => void; // null = root ("All")
  isLoading?: boolean;
  title?: string;          // panel heading, e.g. "Workspace"
}

export const WorkspaceTree: React.FC<WorkspaceTreeProps> = ({
  rootLabel,
  rootCount,
  nodes,
  selectedId,
  onSelect,
  isLoading = false,
  title = 'Workspace',
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const isRootSelected = !selectedId;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-2">
        <h3 className={cn('text-[10px] font-black uppercase tracking-widest', lightTheme.text.muted, 'dark:text-slate-500')}>
          {title}
        </h3>
      </div>

      <div className="space-y-1">
        <button
          onClick={() => onSelect(null)}
          className={cn(
            'w-full flex items-center justify-between p-2 rounded-lg transition-all group',
            isRootSelected
              ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400'
              : cn(lightTheme.text.primary, lightTheme.background.hover, 'dark:text-slate-300 dark:hover:bg-slate-800/50')
          )}
        >
          <div className="flex items-center gap-2">
            <Building2 className={cn('w-4 h-4', lightTheme.text.secondary, 'dark:text-slate-500')} />
            <span className="text-sm font-medium">{rootLabel}</span>
          </div>
          {typeof rootCount === 'number' && (
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', lightTheme.background.secondary, lightTheme.text.secondary, 'dark:bg-slate-800 dark:text-slate-400')}>
              {rootCount}
            </span>
          )}
        </button>

        {isLoading && (
          <div className={cn('px-4 py-3 text-xs', lightTheme.text.muted, 'dark:text-slate-500')}>Loading hierarchy…</div>
        )}

        {!isLoading && (
          <div className={cn('ml-6 border-l pl-2 space-y-1', lightTheme.border.default, 'dark:border-border')}>
            {nodes.map((node) => {
              const isSelected = selectedId === node.id;
              const isExpanded = expanded.has(node.id);
              const hasChildren = !!node.children?.length;

              return (
                <div key={node.id} className="space-y-1">
                  <button
                    onClick={() => onSelect(node)}
                    className={cn(
                      'w-full flex items-center justify-between p-2 rounded-lg transition-all group',
                      isSelected
                        ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400'
                        : cn(lightTheme.text.secondary, lightTheme.background.hover, 'dark:text-slate-400 dark:hover:bg-slate-800/50')
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        onClick={(e) => toggle(node.id, e)}
                        className={cn('p-1 rounded shrink-0', hasChildren ? 'cursor-pointer' : 'opacity-0', lightTheme.background.hover, 'dark:hover:bg-white/10')}
                      >
                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </div>
                      <Users className={cn('w-3 h-3 shrink-0', lightTheme.text.secondary, 'dark:text-slate-500')} />
                      <span className="text-xs font-medium truncate">{node.label}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {node.sublabel && (
                        <span className={cn('text-[10px] hidden md:inline', lightTheme.text.muted, 'dark:text-slate-500')}>{node.sublabel}</span>
                      )}
                      {typeof node.count === 'number' && (
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', lightTheme.background.secondary, lightTheme.text.secondary, 'dark:bg-slate-800 dark:text-slate-400')}>
                          {node.count}
                        </span>
                      )}
                    </div>
                  </button>

                  {isExpanded && hasChildren && (
                    <div className={cn('ml-6 border-l pl-2 space-y-1 mt-1', lightTheme.border.default, 'dark:border-border/50')}>
                      {node.children!.map((leaf) => (
                        <div
                          key={leaf.id}
                          className={cn('flex items-center justify-between p-2 rounded-lg', lightTheme.background.hover, lightTheme.text.muted, 'dark:hover:bg-slate-800/30 dark:text-slate-500')}
                        >
                          <span className="text-[10px] font-medium truncate">{leaf.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
