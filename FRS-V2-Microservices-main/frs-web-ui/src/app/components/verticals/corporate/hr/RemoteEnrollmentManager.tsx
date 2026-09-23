import React, { useState, useEffect, useRef } from 'react';
import { Search, Mail, RefreshCw, Clock, CheckCircle2, XCircle, BellRing } from 'lucide-react';
import { PendingEnrollmentApprovals } from './PendingEnrollmentApprovals';
import { EnrollmentWizard } from './EnrollmentWizard';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useQueryParam } from '../../../../hooks/useQueryParam';
import { apiRequest } from '../../../../services/http/apiClient';
import { Button } from '../../../ui/button';
import { toast } from 'sonner';
import { useAuth } from '../../../../contexts/AuthContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../ui/dialog';

interface Employee {
  pk_employee_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  phone_number?: string;
  enrolled: boolean;
  embeddingCount: number;
}

interface Invitation {
  pk_invitation_id: number;
  fk_employee_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  status: string;
  display_status: string;
  approval_status: string;
  average_quality?: number;
  sent_at: string;
  expires_at: string;
  opened_at?: string;
  completed_at?: string;
}

export const RemoteEnrollmentManager: React.FC = () => {
  const scopeHeaders = useScopeHeaders();
  const { verticalLabel, can } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [selectedEmployees, setSelectedEmployees] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'not_enrolled' | 'all'>('not_enrolled');
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [reminderHour, setReminderHour] = useState(9);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [showReminderSettings, setShowReminderSettings] = useState(true);
  const [selectedInvitations, setSelectedInvitations] = useState<Set<number>>(new Set());
  const [sendingReminders, setSendingReminders] = useState(false);
  const [invitationStatusFilter, setInvitationStatusFilter] = useState<'all' | 'pending' | 'completed' | 'approved' | 'pending_embedding' | 'expired'>('all');
  const [isTimeDialogOpen, setIsTimeDialogOpen] = useState(false);
  const [pendingHour, setPendingHour] = useState<number | null>(null);
  const selectedTimeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isTimeDialogOpen) {
      // Radix dialogs might delay mounting the portal slightly.
      // We check the ref inside the timeout to ensure it's attached.
      setTimeout(() => {
        selectedTimeRef.current?.scrollIntoView({ block: 'center' });
      }, 100);
    } else {
      setPendingHour(null);
    }
  }, [isTimeDialogOpen]);
  // Deep-linkable so notification clicks (e.g. an enrollment-submitted alert)
  // can land directly on the Pending Approvals tab via ?tab=pending-approvals.
  const [activeTabParam, setActiveTabParam] = useQueryParam('tab', 'select');
  const activeTab = (['select', 'invitations', 'pending-approvals'].includes(activeTabParam)
    ? activeTabParam
    : 'select') as 'select' | 'invitations' | 'pending-approvals';
  const setActiveTab = (tab: 'select' | 'invitations' | 'pending-approvals') => setActiveTabParam(tab);
  
  useEffect(() => {
    loadAll();
    loadReminderSettings();
  }, [scopeHeaders]);

  const loadAll = async () => {
    setIsRefreshing(true);
    await Promise.all([loadEmployees(), loadInvitations()]);
    setIsRefreshing(false);
  };

  const loadReminderSettings = async () => {
    try {
      const data = await apiRequest<{ enabled: boolean; hour: number }>('/enroll/reminder-settings', {
        scopeHeaders,
      });
      setRemindersEnabled(!!data.enabled);
      if (typeof data.hour === 'number') setReminderHour(data.hour);
    } catch (err) {
      console.error('Failed to load reminder settings:', err);
    }
  };

  const saveReminderSettings = async (enabled: boolean, hour: number, changedField: 'toggle' | 'time' = 'toggle') => {
    setRemindersLoading(true);
    try {
      await apiRequest('/enroll/reminder-settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled, hour }),
        scopeHeaders,
      });
      setRemindersEnabled(enabled);
      setReminderHour(hour);
      if (changedField === 'time') {
        toast.success(`Reminder time updated to ${formatHour(hour)}`);
      } else {
        toast.success(enabled
          ? `Enrollment reminders enabled — emails go out daily at ${formatHour(hour)} in each employee's local timezone.`
          : 'Enrollment reminders disabled');
      }
    } catch (err: any) {
      toast.error('Failed to update reminder setting', {
        description: err?.message || 'Please try again.',
      });
    } finally {
      setRemindersLoading(false);
    }
  };

  const handleToggleReminders = () => saveReminderSettings(!remindersEnabled, reminderHour, 'toggle');
  const handleChangeReminderHour = (hour: number) => saveReminderSettings(remindersEnabled, hour, 'time');

  const formatHour = (hour: number) => {
    const period = hour < 12 ? 'AM' : 'PM';
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    return `${displayHour}:00 ${period}`;
  };
  
  const loadEmployees = async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ employees: Employee[] }>('/enroll/employees', {
        scopeHeaders,
        noCache: true,
      });
      setEmployees(data.employees || []);
    } catch (err) {
      console.error('Failed to load employees:', err);
      toast.error('Failed to load employees', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadInvitations = async () => {
    try {
      const data = await apiRequest<{ invitations: Invitation[] }>('/enroll/invitations?limit=100', {
        scopeHeaders,
        noCache: true,
      });
      setInvitations(data.invitations || []);
    } catch (err) {
      console.error('Failed to load invitations:', err);
      toast.error('Failed to load invitations', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };
  
  const handleSelectAll = () => {
    const filtered = getFilteredEmployees();
    if (selectedEmployees.size === filtered.length) {
      setSelectedEmployees(new Set());
    } else {
      setSelectedEmployees(new Set(filtered.map(e => e.pk_employee_id)));
    }
  };
  
  const toggleEmployee = (id: number) => {
    const newSelected = new Set(selectedEmployees);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedEmployees(newSelected);
  };
  
  const getFilteredEmployees = () => {
    let filtered = employees;
    
    // Filter by enrollment status. Threshold matches the full 8-angle capture
    // set from the remote enrollment link (see SelfEnrollmentPortal ANGLES /
    // EmployeeLifecycleManagement's embedding_count checks) — was previously
    // hardcoded to 5, which silently excluded employees who completed 5-7 of
    // the 8 angles (e.g. a partial_success embedding run) from this "still
    // needs enrollment" list.
    if (filterStatus === 'not_enrolled') {
      filtered = filtered.filter(e => !e.enrolled || e.embeddingCount < 8);
    }
    
    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(e => 
        e.full_name.toLowerCase().includes(term) ||
        e.employee_code.toLowerCase().includes(term) ||
        e.email?.toLowerCase().includes(term)
      );
    }
    
    return filtered;
  };
  
  const handleSendInvitations = () => {
    if (selectedEmployees.size === 0) {
      toast.error('Please select at least one employee');
      return;
    }
    setWizardOpen(true);
  };
  
  const handleResend = async (invitationId: number) => {
    try {
      await apiRequest(`/enroll/invitations/${invitationId}/resend`, {
        method: 'POST',
        scopeHeaders,
      });
      toast.success('Invitation resent');
      await loadInvitations();
    } catch (err: any) {
      toast.error('Failed to resend invitation', {
        description: err?.status === 403
          ? "You don't have permission to resend invitations."
          : (err?.message || 'Please try again.'),
      });
    }
  };
  
  // Only invitations still in progress (sent but not yet completed) are
  // eligible for a reminder — matches the backend's automatic-cron criteria.
  const isReminderEligible = (inv: Invitation) => ['pending', 'opened', 'in_progress'].includes(inv.display_status);

  const toggleInvitation = (id: number) => {
    const next = new Set(selectedInvitations);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedInvitations(next);
  };

  const eligibleInvitations = () => filteredInvitationsList.filter(isReminderEligible);

  const handleSelectAllInvitations = () => {
    const eligible = eligibleInvitations();
    if (selectedInvitations.size === eligible.length && eligible.length > 0) {
      setSelectedInvitations(new Set());
    } else {
      setSelectedInvitations(new Set(eligible.map(i => i.pk_invitation_id)));
    }
  };

  const handleSendReminders = async (invitationIds: number[]) => {
    if (invitationIds.length === 0) return;
    setSendingReminders(true);
    try {
      const result = await apiRequest<{ summary: { sent: number; failed: number; skipped: number } }>('/enroll/reminders/send', {
        method: 'POST',
        body: JSON.stringify({ invitationIds }),
        scopeHeaders,
      });
      const { sent, failed, skipped } = result.summary;
      if (sent > 0) {
        toast.success(`Reminder${sent === 1 ? '' : 's'} sent successfully${sent > 1 ? ` to ${sent} people` : ''}`, {
          description: (failed || skipped) ? `${failed} failed, ${skipped} skipped` : undefined,
        });
      } else {
        toast.error('Failed to send reminder', {
          description: failed > 0 ? 'Email delivery failed. Please check SMTP configuration.' : skipped > 0 ? 'Selected invitation is not eligible for a reminder.' : 'Please try again.',
        });
      }
      setSelectedInvitations(new Set());
    } catch (err: any) {
      toast.error('Failed to send reminders', {
        description: err?.message || 'Please try again.',
      });
    } finally {
      setSendingReminders(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const badges = {
      pending: { label: 'Pending', class: 'bg-slate-100 text-slate-700', icon: Clock },
      opened: { label: 'Opened', class: 'bg-blue-100 text-blue-700', icon: Mail },
      in_progress: { label: 'In Progress', class: 'bg-yellow-100 text-yellow-700', icon: RefreshCw },
      completed: { label: 'Completed', class: 'bg-green-100 text-green-700', icon: CheckCircle2 },
      expired: { label: 'Expired', class: 'bg-red-100 text-red-700', icon: XCircle },
      approved: { label: 'Approved', class: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
      pending_embedding: { label: 'Awaiting Jetson', class: 'bg-orange-100 text-orange-700', icon: RefreshCw },
    };
    
    const badge = Object.prototype.hasOwnProperty.call(badges, status)
      ? badges[status as keyof typeof badges]
      : badges.pending;
    const Icon = badge.icon;
    
    return (
      <span className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded', badge.class)}>
        <Icon className="w-3 h-3" />
        {badge.label}
      </span>
    );
  };
  
  const [empPage, setEmpPage] = useState(1);
  const EMP_PER = 10;
  useEffect(() => { setEmpPage(1); }, [searchTerm, filterStatus]);
  const empTotal = getFilteredEmployees().length;
  const empPages = Math.ceil(empTotal / EMP_PER);
  const pagedEmployeesList = getFilteredEmployees().slice((empPage - 1) * EMP_PER, empPage * EMP_PER);

  const [invPage, setInvPage] = useState(1);
  const INV_PER = 10;
  useEffect(() => {
    setInvPage(1);
    setSelectedInvitations(new Set());
  }, [invitationStatusFilter]);
  const filteredInvitationsList = invitations.filter(i => invitationStatusFilter === 'all' || i.display_status === invitationStatusFilter);
  const invTotal = filteredInvitationsList.length;
  const invPages = Math.ceil(invTotal / INV_PER);
  const pagedInvitationsList = filteredInvitationsList.slice((invPage - 1) * INV_PER, invPage * INV_PER);

  return (
    <div className="space-y-4 p-6 glass-card rounded-lg">
      {/* Header */}
      <PageHeader
        title={verticalLabel("Remote Enrollment", "Remote Registration")}
        icon={Mail}
        subtitle={verticalLabel("Send enrollment invitations to employees", "Send registration invitations to students")}
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setShowReminderSettings(v => !v)}
              variant={showReminderSettings ? 'default' : 'outline'}
              size="sm"
            >
              <BellRing className="w-4 h-4 mr-2" />
              Reminder Settings
            </Button>
            <Button onClick={loadAll} variant="outline" size="sm" disabled={isRefreshing}>
              <RefreshCw className={cn("w-4 h-4 mr-2", isRefreshing && "animate-spin")} />
              {isRefreshing ? 'Fetching...' : 'Refresh'}
            </Button>
          </div>
        }
      />

      {/* Reminder Settings Panel */}
      {showReminderSettings && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-800 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className={cn("text-sm font-semibold", lightTheme.text.primary)}>
                Automatic daily reminders
              </p>
              <p className={cn("text-xs mt-1", lightTheme.text.secondary)}>
                When enabled, anyone with an unfinished enrollment (invitation sent but not yet
                completed) gets one reminder email per day, sent at <strong>{formatHour(reminderHour)} in
                their own site's local timezone</strong>. Reminders stop automatically once they
                complete enrollment or their invitation expires.
              </p>
            </div>
            <Button
              onClick={handleToggleReminders}
              disabled={remindersLoading}
              variant={remindersEnabled ? 'default' : 'outline'}
              size="sm"
              className="shrink-0"
            >
              {remindersEnabled ? 'On' : 'Off'}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <label className={cn("text-xs font-medium", lightTheme.text.secondary)} htmlFor="reminder-hour-select">
              Send time (each employee's local time):
            </label>
            <Dialog open={isTimeDialogOpen} onOpenChange={setIsTimeDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  id="reminder-hour-select"
                  variant="outline"
                  className="w-[120px] h-8 text-xs glass-card border-slate-300 dark:border-slate-700"
                  disabled={remindersLoading}
                >
                  {formatHour(reminderHour)}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[320px] p-4 max-h-[90vh] overflow-hidden flex flex-col" onCloseAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                  <DialogTitle className="text-center font-semibold text-sm">Select Reminder Time</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-1 mt-2 flex-1 overflow-y-auto pr-2">
                  {Array.from({ length: 24 }).map((_, h) => (
                    <Button
                      key={h}
                      ref={h === (pendingHour ?? reminderHour) ? selectedTimeRef : null}
                      variant={h === (pendingHour ?? reminderHour) ? "default" : "ghost"}
                      size="sm"
                      onClick={() => {
                        setPendingHour(h);
                      }}
                      className={cn("text-sm justify-start font-normal", h === (pendingHour ?? reminderHour) ? "font-semibold" : "")}
                    >
                      {formatHour(h)}
                    </Button>
                  ))}
                </div>
                <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <Button variant="outline" size="sm" onClick={() => setIsTimeDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      handleChangeReminderHour(pendingHour ?? reminderHour);
                      setIsTimeDialogOpen(false);
                    }}
                  >
                    Save
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
            <p className={cn("text-sm font-semibold", lightTheme.text.primary)}>
              Send a reminder right now
            </p>
            <p className={cn("text-xs mt-1 mb-2", lightTheme.text.secondary)}>
              Pick specific people from the Invitations tab below (only those still pending/opened/in
              progress can be reminded) and send an immediate one-off reminder, independent of the
              daily schedule above.
            </p>
            {selectedInvitations.size > 0 ? (
              <Button
                size="sm"
                onClick={() => handleSendReminders(Array.from(selectedInvitations))}
                disabled={sendingReminders}
              >
                <Mail className="w-4 h-4 mr-2" />
                Send Reminder to {selectedInvitations.size} selected
              </Button>
            ) : (
              <p className={cn("text-xs italic", lightTheme.text.secondary)}>
                No one selected yet — go to the Invitations tab and check the people you want to remind.
              </p>
            )}
          </div>
        </div>
      )}
      
      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setActiveTab('select')}
          className={cn(
            'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            activeTab === 'select'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-600 hover:text-slate-800'
          )}
        >
          {verticalLabel("Select Employees", "Select Students")}
        </button>
        <button
          onClick={() => setActiveTab('invitations')}
          className={cn(
            'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            activeTab === 'invitations'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-600 hover:text-slate-800'
          )}
        >
        Invitations ({invitations.filter(i => !['expired'].includes(i.display_status)).length})
        </button>
        <button
          onClick={() => setActiveTab('pending-approvals')}
          className={cn(
            'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            activeTab === 'pending-approvals'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-600 hover:text-slate-800'
          )}
        >
          Pending Approvals
        </button>
      </div>
      
      {/* Select Employees Tab */}
      {activeTab === 'select' && (
        <>
          {/* Filters */}
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", lightTheme.text.muted)} />
              <input
                type="text"
                placeholder="Search by name, code, or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 dark:border-slate-700 rounded-lg glass-card text-slate-900 dark:text-white"
              />
            </div>
            
            <Select
              value={filterStatus}
              onValueChange={(val) => setFilterStatus(val as any)}
            >
              <SelectTrigger className="w-[240px] px-4 py-2 border border-slate-300 dark:border-slate-700 rounded-lg glass-card text-slate-900 dark:text-white h-auto bg-transparent">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="not_enrolled">{verticalLabel("Not Enrolled / Incomplete", "Not Registered / Incomplete")}</SelectItem>
                <SelectItem value="all">{verticalLabel("All Employees", "All Students")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          {/* Employee List */}
          {loading ? (
            <div className={cn("text-center py-8", lightTheme.text.secondary)}>Loading...</div>
          ) : getFilteredEmployees().length === 0 ? (
            <div className={cn("text-center py-8", lightTheme.text.secondary)}>{verticalLabel("No employees found", "No students found")}</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-200 dark:border-slate-700">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEmployees.size === getFilteredEmployees().length && getFilteredEmployees().length > 0}
                    onChange={handleSelectAll}
                    className="w-4 h-4 rounded border-slate-300"
                  />
                  <span className={cn("text-sm font-medium", lightTheme.text.primary)}>
                    Select All ({getFilteredEmployees().length})
                  </span>
                </label>
                
                {selectedEmployees.size > 0 && (
                  <Button onClick={handleSendInvitations}>
                    <Mail className="w-4 h-4 mr-2" />
                    {verticalLabel(`Send to ${selectedEmployees.size} employee(s)`, `Send to ${selectedEmployees.size} student(s)`)}
                  </Button>
                )}
              </div>
              
              <div className="space-y-2">
                {pagedEmployeesList.map((employee) => (
                  <label
                    key={employee.pk_employee_id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                      selectedEmployees.has(employee.pk_employee_id)
                        ? 'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-700'
                        : 'bg-white border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedEmployees.has(employee.pk_employee_id)}
                      onChange={() => toggleEmployee(employee.pk_employee_id)}
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("font-medium", lightTheme.text.primary)}>
                          {employee.full_name}
                        </span>
                        <span className={cn("text-xs", lightTheme.text.secondary)}>
                          ({employee.employee_code})
                        </span>
                      </div>
                      <div className={cn("text-sm", lightTheme.text.secondary)}>
                        {employee.email || 'No email'}
                      </div>
                    </div>
                    
                    <div className="text-right">
                      {employee.enrolled ? (
                        <span className="text-xs text-green-600 dark:text-green-400">
                          {/* embeddingCount varies by how the employee was enrolled (5-angle
                              kiosk flow vs the 8-angle remote link), so show the raw count
                              rather than a fixed denominator that misrepresents either case. */}
                          ✓ {verticalLabel("Enrolled", "Registered")} ({employee.embeddingCount} photo{employee.embeddingCount === 1 ? '' : 's'})
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {verticalLabel("Not enrolled", "Not registered")}
                        </span>
                      )}
                    </div>
                  </label>
                ))}
              </div>

              {/* Pagination Controls */}
              {empTotal > EMP_PER && (
                <div className="flex items-center justify-between p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <p className="text-xs text-slate-500">
                    Showing {Math.min((empPage - 1) * EMP_PER + 1, empTotal)}–{Math.min(empPage * EMP_PER, empTotal)} of {empTotal} entries
                  </p>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEmpPage(p => Math.max(1, p - 1))}
                      disabled={empPage === 1}
                      className="h-8 text-xs"
                    >
                      Prev
                    </Button>
                    {Array.from({ length: empPages }).map((_: any, i: number) => (
                      <Button
                        key={i + 1}
                        variant={empPage === i + 1 ? "default" : "outline"}
                        size="sm"
                        onClick={() => setEmpPage(i + 1)}
                        className="h-8 text-xs font-bold"
                      >
                        {i + 1}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEmpPage(p => Math.min(empPages, p + 1))}
                      disabled={empPage >= empPages}
                      className="h-8 text-xs"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
      
      {/* Invitations Tab */}
      {activeTab === 'invitations' && (
        <div className="space-y-3">
          {/* Status filter */}
          <div className="flex items-center gap-2">
            {(['all', 'pending', 'completed', 'approved', 'pending_embedding', 'expired'] as const).map((s) => {
              const count = s === 'all'
                ? invitations.length
                : invitations.filter(i => i.display_status === s).length;
              return (
                <button
                  key={s}
                  onClick={() => setInvitationStatusFilter(s)}
                  className={cn(
                    'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                    invitationStatusFilter === s
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                  )}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)} ({count})
                </button>
              );
            })}
          </div>

          {filteredInvitationsList.length === 0 ? (
            <div className={cn("text-center py-8", lightTheme.text.secondary)}>No invitations found</div>
          ) : (
            <div className="space-y-3">
              <div className={cn("border rounded-lg overflow-x-auto", lightTheme.table.border)}>
                <table className="w-full min-w-[780px]">
                  <thead className={lightTheme.table.header}>
                    <tr>
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={eligibleInvitations().length > 0 && selectedInvitations.size === eligibleInvitations().length}
                          onChange={handleSelectAllInvitations}
                          className="w-4 h-4 rounded border-slate-300"
                          title="Select all reminder-eligible invitations"
                        />
                      </th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>{verticalLabel("Employee", "Student")}</th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>Email</th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>Status</th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>Quality</th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>Sent</th>
                      <th className={cn("text-left px-4 py-3 text-xs font-semibold", lightTheme.text.secondary)}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {pagedInvitationsList.map((inv) => (
                      <tr key={inv.pk_invitation_id} className={lightTheme.table.rowHover}>
                        <td className="px-4 py-3">
                          {isReminderEligible(inv) && (
                            <input
                              type="checkbox"
                              checked={selectedInvitations.has(inv.pk_invitation_id)}
                              onChange={() => toggleInvitation(inv.pk_invitation_id)}
                              className="w-4 h-4 rounded border-slate-300"
                            />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className={cn("font-medium", lightTheme.text.primary)}>{inv.full_name}</div>
                          <div className={cn("text-xs", lightTheme.text.secondary)}>{inv.employee_code}</div>
                        </td>
                        <td className={cn("px-4 py-3 text-sm", lightTheme.text.secondary)}>
                          {inv.email}
                        </td>
                        <td className="px-4 py-3">
                          {getStatusBadge(inv.display_status)}
                        </td>
                        <td className={cn("px-4 py-3 text-sm", lightTheme.text.secondary)}>
                          {inv.average_quality != null ? `${(Number(inv.average_quality) * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className={cn("px-4 py-3 text-xs", lightTheme.text.secondary)}>
                          {new Date(inv.sent_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {(inv.display_status === 'pending' || inv.display_status === 'expired') && can('employees.write') && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleResend(inv.pk_invitation_id)}
                              >
                                <RefreshCw className="w-3 h-3 mr-1" />
                                Resend
                              </Button>
                            )}
                            {isReminderEligible(inv) && can('employees.write') && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={sendingReminders}
                                onClick={() => handleSendReminders([inv.pk_invitation_id])}
                              >
                                <BellRing className="w-3 h-3 mr-1" />
                                Remind
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {invTotal > INV_PER && (
                <div className="flex items-center justify-between p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800">
                  <p className="text-xs text-slate-500">
                    Showing {Math.min((invPage - 1) * INV_PER + 1, invTotal)}–{Math.min(invPage * INV_PER, invTotal)} of {invTotal} invitations
                  </p>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInvPage(p => Math.max(1, p - 1))}
                      disabled={invPage === 1}
                      className="h-8 text-xs"
                    >
                      Prev
                    </Button>
                    {Array.from({ length: invPages }).map((_: any, i: number) => (
                      <Button
                        key={i + 1}
                        variant={invPage === i + 1 ? "default" : "outline"}
                        size="sm"
                        onClick={() => setInvPage(i + 1)}
                        className="h-8 text-xs font-bold"
                      >
                        {i + 1}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInvPage(p => Math.min(invPages, p + 1))}
                      disabled={invPage >= invPages}
                      className="h-8 text-xs"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      
      {/* Pending Approvals Tab */}
      {activeTab === 'pending-approvals' && (
        <PendingEnrollmentApprovals onDataChanged={loadAll} />
      )}

      {wizardOpen && (
        <EnrollmentWizard
          employees={employees.filter(e => selectedEmployees.has(e.pk_employee_id))}
          onClose={() => setWizardOpen(false)}
          onComplete={() => {
            setSelectedEmployees(new Set());
            loadInvitations();
            setActiveTab('invitations');
          }}
        />
      )}
    </div>
  );
};
