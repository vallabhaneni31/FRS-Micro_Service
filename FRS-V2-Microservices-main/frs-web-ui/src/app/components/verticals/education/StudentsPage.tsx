/**
 * StudentsPage.tsx — Edu Tier 1 student list + add-student dialog.
 *
 * Rendered in place of PeopleManagement when tenants.vertical === 'education'.
 * Wired into DashboardRenderer's PAGE_REGISTRY via the EmployeesOrStudents
 * dispatcher.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Plus, Search, Loader2, GraduationCap, CalendarDays, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "../../ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "../../ui/sheet";
import { Label } from "../../ui/label";
import { Badge } from "../../ui/badge";
import { apiRequest, ApiError } from "../../../services/http/apiClient";
import { useAuth } from "../../../contexts/AuthContext";
import { useScopeHeaders } from "../../../hooks/useScopeHeaders";
import { useQueryParam } from "../../../hooks/useQueryParam";
import { cn } from "../../ui/utils";
import { lightTheme } from "../../../../theme/lightTheme";
import { PageHeader } from "../../shared/PageHeader";

interface Student {
  pk_student_id: string;
  fk_tenant_id: string;
  roll_number: string | null;
  admission_number: string | null;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  class_label: string | null;
  section: string | null;
  grade: string | null;
  dob: string | null;
  gender: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  parent_email: string | null;
  is_active: boolean;
  created_at: string;
  face_enrolled: boolean;
  tenant_name: string;
}

interface AttendanceRecord {
  pk_attendance_id: string;
  attendance_date: string;
  status: "present" | "absent" | "late" | "excused" | "half_day";
  check_in_at: string | null;
  check_out_at: string | null;
  marked_by_device: string | null;
  source: string;
  confidence: string | null;
  notes: string | null;
}
interface AttendancePayload {
  student: Pick<Student, "pk_student_id" | "first_name" | "last_name" | "roll_number" | "class_label">;
  summary: { days: number; present: number; late: number; absent: number; excused: number; half_day: number };
  records: AttendanceRecord[];
}

interface NewStudentForm {
  roll_number:    string;
  first_name:     string;
  last_name:      string;
  class_label:    string;
  section:        string;
  grade:          string;
  parent_name:    string;
  parent_phone:   string;
  parent_email:   string;
}

const EMPTY_FORM: NewStudentForm = {
  roll_number: "", first_name: "", last_name: "",
  class_label: "", section: "", grade: "",
  parent_name: "", parent_phone: "", parent_email: "",
};

const StudentsPage: React.FC = () => {
  const { accessToken, hasScope } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const canWrite = hasScope("students.list.write");

  const [students, setStudents] = useState<Student[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  // URL-backed (not local state) so an external control — the Workspace
  // hierarchy tree — can deep-link a search/class filter into this page,
  // the same pattern EmployeeLifecycleManagement.tsx already uses.
  const [query,    setQuery]    = useQueryParam("q", "");
  const [classLabelFilter] = useQueryParam("class_label", "");
  const [sectionFilter]    = useQueryParam("section", "");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form,       setForm]       = useState<NewStudentForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState<string | null>(null);

  // Attendance drawer
  const [drawerStudent,  setDrawerStudent]  = useState<Student | null>(null);
  const [drawerAttendance, setDrawerAttendance] = useState<AttendancePayload | null>(null);
  const [drawerLoading,  setDrawerLoading]  = useState(false);
  const [drawerError,    setDrawerError]    = useState<string | null>(null);

  const canReadAttendance = hasScope("students.attendance.read");

  async function openAttendance(s: Student) {
    setDrawerStudent(s);
    setDrawerAttendance(null);
    setDrawerError(null);
    if (!canReadAttendance) return;
    setDrawerLoading(true);
    try {
      const data = await apiRequest<AttendancePayload>(
        `/students/${s.pk_student_id}/attendance?limit=30`,
        { method: "GET", accessToken, scopeHeaders },
      );
      setDrawerAttendance(data);
    } catch (e) {
      setDrawerError(e instanceof ApiError ? e.message : "Failed to load attendance");
    } finally {
      setDrawerLoading(false);
    }
  }

  const [page, setPage] = useState(1);
  const PER = 10;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<{ students: Student[] }>("/students", {
        method: "GET",
        accessToken,
        scopeHeaders,
      });
      setStudents(data.students ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load students");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { setPage(1); }, [query, classLabelFilter, sectionFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter(s => {
      if (classLabelFilter && (s.class_label ?? "") !== classLabelFilter) return false;
      if (sectionFilter && (s.section ?? "") !== sectionFilter) return false;
      if (!q) return true;
      return (
        `${s.first_name} ${s.last_name ?? ""}`.toLowerCase().includes(q) ||
        (s.roll_number ?? "").toLowerCase().includes(q) ||
        (s.class_label ?? "").toLowerCase().includes(q)
      );
    });
  }, [students, query, classLabelFilter, sectionFilter]);

  const total = filtered.length;
  const pages = Math.ceil(total / PER);
  const pagedStudents = filtered.slice((page - 1) * PER, page * PER);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.first_name.trim()) {
      setSubmitErr("First name is required");
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    try {
      await apiRequest("/students", {
        method: "POST",
        accessToken,
        scopeHeaders,
        body: JSON.stringify(form),
      });
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (e) {
      setSubmitErr(e instanceof ApiError ? e.message : "Failed to add student");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Students"
        icon={GraduationCap}
        subtitle={`${students.length} student${students.length !== 1 ? "s" : ""}`}
        actions={
          <>
            <div className="relative">
              <Search className={cn("absolute left-2 top-2.5 w-4 h-4", lightTheme.text.muted)} aria-hidden="true" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, roll, class…"
                className="pl-8 w-64"
              />
            </div>
            {canWrite && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-1" /> Add Student
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className={cn("flex items-center justify-center h-48", lightTheme.text.secondary)}>
          <Loader2 className="w-5 h-5 animate-spin mr-2 text-primary" /> Loading students…
        </div>
      ) : filtered.length === 0 ? (
        <div className={cn("rounded-md border border-dashed p-12 text-center", lightTheme.border.default, lightTheme.text.secondary)}>
          <GraduationCap className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No students yet.</p>
          {canWrite && (
            <Button variant="outline" className="mt-3" onClick={() => setDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> Add your first student
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className={cn("overflow-x-auto rounded-md border", lightTheme.table.border)}>
            <table className="w-full text-sm">
              <thead className={cn("text-xs uppercase tracking-wide", lightTheme.table.header)}>
                <tr>
                  <th className="px-3 py-2 text-left">Roll</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Class</th>
                  <th className="px-3 py-2 text-left">Section</th>
                  <th className="px-3 py-2 text-left">Parent</th>
                  <th className="px-3 py-2 text-left">Phone</th>
                  <th className="px-3 py-2 text-left">Face</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {pagedStudents.map((s) => (
                  <tr
                    key={s.pk_student_id}
                    className={cn("cursor-pointer", lightTheme.table.rowHover)}
                    onClick={() => openAttendance(s)}
                    title="View attendance"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{s.roll_number ?? "—"}</td>
                    <td className="px-3 py-2">{s.first_name}{s.last_name ? ` ${s.last_name}` : ""}</td>
                    <td className="px-3 py-2">{s.class_label ?? "—"}</td>
                    <td className="px-3 py-2">{s.section ?? "—"}</td>
                    <td className="px-3 py-2">{s.parent_name ?? "—"}</td>
                    <td className="px-3 py-2">{s.parent_phone ?? "—"}</td>
                    <td className="px-3 py-2">
                      {s.face_enrolled ? (
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Enrolled</Badge>
                      ) : (
                        <Badge variant="outline" className="text-slate-500">Pending</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {total > PER && (
            <div className="flex items-center justify-between px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-md bg-muted/10">
              <p className="text-xs text-muted-foreground">
                Showing {Math.min((page - 1) * PER + 1, total)}–{Math.min(page * PER, total)} of {total} students
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="h-8 text-xs"
                >
                  Prev
                </Button>
                {Array.from({ length: pages }).map((_, i) => (
                  <Button
                    key={i + 1}
                    variant={page === i + 1 ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPage(i + 1)}
                    className="h-8 text-xs font-bold"
                  >
                    {i + 1}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(pages, p + 1))}
                  disabled={page >= pages}
                  className="h-8 text-xs"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) { setForm(EMPTY_FORM); setSubmitErr(null); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Student</DialogTitle>
            <DialogDescription>
              Create a new student record. Face enrollment happens later, on a device.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="grid grid-cols-2 gap-3 py-2">
            <div className="col-span-1">
              <Label htmlFor="first_name" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">First name <span className="text-rose-500">*</span></Label>
              <Input id="first_name" value={form.first_name}
                     onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </div>
            <div className="col-span-1">
              <Label htmlFor="last_name" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Last name</Label>
              <Input id="last_name" value={form.last_name}
                     onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </div>
            <div className="col-span-1">
              <Label htmlFor="roll_number" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Roll number</Label>
              <Input id="roll_number" value={form.roll_number}
                     onChange={(e) => setForm({ ...form, roll_number: e.target.value })} />
            </div>
            <div className="col-span-1">
              <Label htmlFor="grade" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Grade</Label>
              <Input id="grade" value={form.grade}
                     onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder="10" />
            </div>
            <div className="col-span-1">
              <Label htmlFor="class_label" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Class</Label>
              <Input id="class_label" value={form.class_label}
                     onChange={(e) => setForm({ ...form, class_label: e.target.value })} placeholder="Class 10A" />
            </div>
            <div className="col-span-1">
              <Label htmlFor="section" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Section</Label>
              <Input id="section" value={form.section}
                     onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="A" />
            </div>
            <div className="col-span-2 border-t border-slate-200 dark:border-slate-800 pt-3 mt-1">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-2 font-semibold">Parent / Guardian</p>
            </div>
            <div className="col-span-1">
              <Label htmlFor="parent_name" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Name</Label>
              <Input id="parent_name" value={form.parent_name}
                     onChange={(e) => setForm({ ...form, parent_name: e.target.value })} />
            </div>
            <div className="col-span-1">
              <Label htmlFor="parent_phone" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Phone</Label>
              <Input id="parent_phone" value={form.parent_phone}
                     onChange={(e) => setForm({ ...form, parent_phone: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="parent_email" className="block mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Email</Label>
              <Input id="parent_email" type="email" value={form.parent_email}
                     onChange={(e) => setForm({ ...form, parent_email: e.target.value })} />
            </div>

            {submitErr && (
              <div className="col-span-2 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-3 py-2 text-xs">
                {submitErr}
              </div>
            )}

            <DialogFooter className="col-span-2 mt-2">
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Saving…</> : "Save Student"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Attendance drawer — opens on row click */}
      <Sheet open={!!drawerStudent} onOpenChange={(o) => { if (!o) { setDrawerStudent(null); setDrawerAttendance(null); setDrawerError(null); } }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-indigo-500" />
              Attendance
            </SheetTitle>
            <SheetDescription>
              {drawerStudent && (
                <>
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {drawerStudent.first_name}{drawerStudent.last_name ? ` ${drawerStudent.last_name}` : ""}
                  </span>
                  {drawerStudent.roll_number && <span className="ml-2 font-mono text-xs">· {drawerStudent.roll_number}</span>}
                  {drawerStudent.class_label && <span className="ml-2 text-xs">· {drawerStudent.class_label}</span>}
                </>
              )}
            </SheetDescription>
          </SheetHeader>

          {!canReadAttendance ? (
            <div className="mt-6 text-sm text-slate-500">You don't have permission to view student attendance.</div>
          ) : drawerLoading ? (
            <div className="flex items-center justify-center h-48 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading attendance…
            </div>
          ) : drawerError ? (
            <div className="mt-6 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-3 py-2 text-sm">
              {drawerError}
            </div>
          ) : drawerAttendance ? (
            <div className="mt-4 space-y-4">
              {/* Summary tiles */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <SummaryTile label="Present" value={drawerAttendance.summary.present} color="text-emerald-600" />
                <SummaryTile label="Late"    value={drawerAttendance.summary.late}    color="text-amber-600" />
                <SummaryTile label="Absent"  value={drawerAttendance.summary.absent}  color="text-rose-600" />
              </div>

              {drawerAttendance.records.length === 0 ? (
                <div className="text-sm text-slate-500 text-center py-8">No attendance records yet.</div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800">
                  {drawerAttendance.records.map((r) => (
                    <AttendanceRow key={r.pk_attendance_id} record={r} />
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
};

function SummaryTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-2 py-3 text-center">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

function AttendanceRow({ record }: { record: AttendanceRecord }) {
  const date = new Date(record.attendance_date).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  const time = record.check_in_at
    ? new Date(record.check_in_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;

  const statusBadge = (() => {
    switch (record.status) {
      case "present":  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="w-3 h-3 mr-1" />Present</Badge>;
      case "late":     return <Badge className="bg-amber-500/15  text-amber-700  dark:text-amber-300" ><Clock        className="w-3 h-3 mr-1" />Late</Badge>;
      case "absent":   return <Badge className="bg-rose-500/15   text-rose-700   dark:text-rose-300"  ><XCircle      className="w-3 h-3 mr-1" />Absent</Badge>;
      case "half_day": return <Badge variant="outline">Half day</Badge>;
      case "excused":  return <Badge variant="outline">Excused</Badge>;
      default:         return <Badge variant="outline">{record.status}</Badge>;
    }
  })();

  return (
    <div className="px-3 py-2.5 flex items-center justify-between gap-3 text-sm">
      <div>
        <div className="font-medium">{date}</div>
        {time && <div className="text-xs text-slate-500 mt-0.5">Checked in {time}</div>}
      </div>
      {statusBadge}
    </div>
  );
}

export default StudentsPage;
