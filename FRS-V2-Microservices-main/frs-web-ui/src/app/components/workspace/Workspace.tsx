import React, { Suspense } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useQueryParam } from '../../hooks/useQueryParam';
import { useCorporateWorkspaceTree, useEducationWorkspaceTree } from '../../hooks/useWorkspaceTree';
import { WorkspaceTree, WorkspaceTreeNode } from '../shared/WorkspaceTree';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Loader2, UserCog, X } from 'lucide-react';

// Loaded lazily, same chunk-splitting behavior as the previous EmployeesOrStudents
// dispatcher in DashboardRenderer.tsx: only the panel for the active vertical loads.
const LazyPeopleManagement = React.lazy(() =>
  import('../verticals/corporate/admin/PeopleManagement').then((m) => ({ default: m.PeopleManagement }))
);
const LazyStudentsPage = React.lazy(() => import('../verticals/education/StudentsPage'));

const PanelFallback = () => (
  <div className="flex items-center justify-center h-64">
    <Loader2 className="w-6 h-6 animate-spin text-primary" aria-hidden="true" />
  </div>
);

/**
 * Corporate: Organization -> Manager -> Direct reports, driven by the real
 * fk_manager_id/is_manager hierarchy. Tree selection writes into the `manager`
 * URL query param, which required one small additive filter in
 * EmployeeLifecycleManagement.tsx (mirroring its existing `dept` filter) —
 * see that file's filterManager.
 */
const CorporateWorkspacePanel: React.FC = () => {
  const { rootLabel, rootCount, nodes, isLoading } = useCorporateWorkspaceTree();
  const [managerParam, setManagerParam] = useQueryParam('manager', 'all');

  const selectedId = managerParam === 'all' ? undefined : managerParam;
  const selectedManager = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;

  const handleSelect = (node: WorkspaceTreeNode | null) => {
    if (!node) { setManagerParam('all'); return; }
    setManagerParam(node.id);
  };

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start">
      <Card className="w-full xl:w-72 shrink-0 xl:sticky xl:top-24">
        <CardContent className="p-4">
          <WorkspaceTree
            rootLabel={rootLabel}
            rootCount={rootCount}
            nodes={nodes}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={isLoading}
          />
        </CardContent>
      </Card>
      <div className="flex-1 min-w-0 w-full space-y-4">
        {selectedManager && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10">
            <div className="w-9 h-9 rounded-xl bg-white dark:bg-slate-900 flex items-center justify-center shrink-0 border border-blue-200 dark:border-blue-500/30">
              <UserCog className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-black text-blue-800 dark:text-blue-200 truncate">
                {selectedId === 'unassigned'
                  ? 'Viewing employees with no manager set'
                  : `Viewing ${selectedManager.label}'s direct reports`}
                {typeof selectedManager.count === 'number' ? ` (${selectedManager.count})` : ''}
              </p>
              {selectedManager.sublabel && (
                <p className="text-[11px] font-bold text-blue-600/70 dark:text-blue-400/70">{selectedManager.sublabel}</p>
              )}
            </div>
            <Button
              size="sm" variant="ghost"
              onClick={() => handleSelect(null)}
              className="ml-auto text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-500/20 rounded-xl text-xs font-bold shrink-0"
            >
              <X className="w-3.5 h-3.5 mr-1" />Clear
            </Button>
          </div>
        )}
        <Suspense fallback={<PanelFallback />}>
          <LazyPeopleManagement />
        </Suspense>
      </div>
    </div>
  );
};

/**
 * Education: School -> Class (class_label + section grouping, labeled "Class"
 * — no teacher entity exists in the schema yet, see plan doc). Tree selection
 * writes into `class_label`/`section` URL params that StudentsPage.tsx reads.
 */
const EducationWorkspacePanel: React.FC = () => {
  const { rootLabel, rootCount, nodes, isLoading } = useEducationWorkspaceTree();
  const [classLabelParam, setClassLabelParam] = useQueryParam('class_label', '');
  const [sectionParam, setSectionParam] = useQueryParam('section', '');

  const selectedId = classLabelParam ? `${classLabelParam}::${sectionParam}` : undefined;

  const handleSelect = (node: WorkspaceTreeNode | null) => {
    if (!node) { setClassLabelParam(''); setSectionParam(''); return; }
    const [classLabel, section] = node.id.split('::');
    setClassLabelParam(classLabel === 'unassigned' ? '' : classLabel);
    setSectionParam(section || '');
  };

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start">
      <Card className="w-full xl:w-72 shrink-0 xl:sticky xl:top-24">
        <CardContent className="p-4">
          <WorkspaceTree
            rootLabel={rootLabel}
            rootCount={rootCount}
            nodes={nodes}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={isLoading}
            title="Classes"
          />
        </CardContent>
      </Card>
      <div className="flex-1 min-w-0 w-full">
        <Suspense fallback={<PanelFallback />}>
          <LazyStudentsPage />
        </Suspense>
      </div>
    </div>
  );
};

/**
 * Single adaptive Workspace page, wired into both the `employees` and
 * `workforce` PAGE_REGISTRY entries in DashboardRenderer.tsx. Branches on
 * vertical exactly like the previous EmployeesOrStudents dispatcher did for
 * `employees` only — pointing `workforce` here too is what fixes the
 * pre-existing bug where Site Admin/Principal (workforce key) never got
 * vertical dispatch and always saw the corporate Employee UI.
 */
export const Workspace: React.FC = () => {
  const { vertical } = useAuth();
  return vertical === 'education' ? <EducationWorkspacePanel /> : <CorporateWorkspacePanel />;
};

export default Workspace;
