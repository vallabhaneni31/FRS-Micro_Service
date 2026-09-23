import React, { useMemo, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../ui/table';
import { Badge } from '../../../ui/badge';
import { Input } from '../../../ui/input';
import { Employee, AttendanceRecord, FilterOptions } from '../../../../types';
import { getStatusBadgeColor } from '../../../../utils/analytics';
import { formatTimeInSiteTz, getSiteTimezone } from '../../../../utils/timezone';
import { Search } from 'lucide-react';
import { EmployeeProfileDashboard } from './EmployeeProfileDashboard';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { useAuth } from '../../../../contexts/AuthContext';

interface AttendanceTableProps {
  employees: Employee[];
  attendanceRecords: AttendanceRecord[];
  filters?: FilterOptions;
}

const formatDuration = (mins?: number) => {
  if (mins === undefined || mins === null) return '-';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const AttendanceTable: React.FC<AttendanceTableProps> = ({
  employees,
  attendanceRecords,
  filters = { dateRange: { start: new Date(0), end: new Date() }, departments: [], employees: [], shifts: [], locations: [], status: [] },
}) => {
  const { activeScope } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);

  useEffect(() => {
    setSelectedEmployee(null);
  }, [activeScope]);

  const [page, setPage] = useState(1);
  const PER_PAGE = 10;

  const filterKey = JSON.stringify({
    d: filters?.departments,
    e: filters?.employees,
    s: filters?.shifts,
    l: filters?.locations,
    st: filters?.status
  });

  useEffect(() => {
    setPage(1);
  }, [searchQuery, filterKey]);

  const filteredData = useMemo(() => {
    // Use site timezone for today's date
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: getSiteTimezone()
    }).format(new Date());

    // Get today's records — support both live API shape and mock shape
    const todayRecords = attendanceRecords.filter(record => {
      const dateVal = (record as any).attendance_date || record.date;
      if (!dateVal) return false;
      let dateStr = String(dateVal).slice(0, 10);
      if (String(dateVal).includes('T')) {
        const d = new Date(dateVal);
        dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: getSiteTimezone() }).format(d);
      }
      return dateStr === todayStr || String(dateVal).slice(0, 10) === todayStr;
    });

    // Match employees with their attendance
    return employees
      .filter(emp => {
        // Apply department filter
        if (filters.departments.length > 0 && !filters.departments.includes(emp.department)) {
          return false;
        }
        // Apply location filter
        if (filters.locations.length > 0 && !filters.locations.includes(emp.location)) {
          return false;
        }
        // Apply search query
        if (searchQuery && !emp.name.toLowerCase().includes(searchQuery.toLowerCase())) {
          return false;
        }
        return true;
      })
      .map(emp => {
        const record = todayRecords.find(r => (r as any).fk_employee_id == emp.id || r.employeeId === emp.id);
        return { employee: emp, record };
      })
      .filter(({ record }) => {
        // Apply status filter
        if (filters.status.length > 0) {
          return record && filters.status.includes(record.status);
        }
        return true;
      });
  }, [employees, attendanceRecords, filters, searchQuery]);

  const total = filteredData.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = filteredData.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  if (selectedEmployee) {
    return (
      <EmployeeProfileDashboard
        employee={selectedEmployee as any}
        onBack={() => setSelectedEmployee(null)}
      />
    );
  }

  return (
    <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Today's Attendance</CardTitle>
          <div className="relative w-64">
            <Search className={cn("absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4", lightTheme.text.muted, "dark:text-gray-400")} />
            <Input
              placeholder="Search employees..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Check-In</TableHead>
                <TableHead>Check-Out</TableHead>
                <TableHead>Working Hours</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {total === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className={cn("text-center py-8", lightTheme.text.secondary, "dark:text-gray-500")}>
                    No records found
                  </TableCell>
                </TableRow>
              ) : (
                  pagedList.map(({ employee, record }) => {
                    const isToday = new Date((record as any)?.attendance_date || record?.attendanceDate || Date.now()).toDateString() === new Date().toDateString();
                    const checkOutFallback = isToday ? 'Active Session' : 'Not Checked Out';
                    return (
                      <TableRow
                        key={employee.id}
                        className={cn("cursor-pointer hover:bg-slate-50 transition-colors", "dark:hover:bg-gray-800/50")}
                        onClick={() => setSelectedEmployee(employee)}
                      >
                        <TableCell>
                          <div>
                            <p className={cn("font-medium", lightTheme.text.primary, "dark:text-gray-200")}>{employee.name}</p>
                            <p className={cn("text-sm", lightTheme.text.secondary, "dark:text-gray-500")}>{employee.employeeId}</p>
                          </div>
                        </TableCell>
                        <TableCell>{(record as any)?.department || employee.department || '—'}</TableCell>
                        <TableCell>
                          {(record as any)?.check_in ? formatTimeInSiteTz((record as any).check_in) : record?.checkIn ? formatTimeInSiteTz(new Date(record.checkIn).toISOString()) : '-'}
                        </TableCell>
                        <TableCell>
                          {(record as any)?.check_out ? formatTimeInSiteTz((record as any).check_out) : record?.checkOut ? formatTimeInSiteTz(new Date(record.checkOut).toISOString()) : (((record as any)?.check_in || record?.checkIn) && record?.status !== 'absent' ? checkOutFallback : '-')}
                        </TableCell>
                    <TableCell>
                      {record?.duration_minutes !== undefined ? formatDuration(record.duration_minutes) : '-'}
                    </TableCell>
                    <TableCell>
                      <Badge className={getStatusBadgeColor(record?.status || 'absent')}>
                        {record?.status.replace('-', ' ') || 'No Record'}
                      </Badge>
                    </TableCell>
                    </TableRow>
                    );
                  })
              )}
            </TableBody>
          </Table>
        </div>
        {total > PER_PAGE && (
          <div className="flex items-center justify-between p-3 border-t border-slate-200/10 bg-slate-50 dark:bg-slate-800 rounded-b-lg mt-4">
            <p className="text-xs text-slate-500 font-medium">
              Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total} entries
            </p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Prev
              </Button>
              {Array.from({ length: totalPages }).map((_, idx: number) => (
                <Button
                  key={idx + 1}
                  variant={page === idx + 1 ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPage(idx + 1)}
                  className="h-8 text-xs font-bold rounded-lg"
                >
                  {idx + 1}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

