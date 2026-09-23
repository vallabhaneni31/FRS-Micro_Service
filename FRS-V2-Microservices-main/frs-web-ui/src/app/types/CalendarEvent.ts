export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  type: 'shift-change' | 'birthday' | 'training' | 'meeting' | 'alert' | 'custom';
  title: string;
  description?: string;
  employeeId?: string;
  employeeName?: string;
  status?: 'pending' | 'approved' | 'rejected';
  color?: string;
  icon?: string;
  allDay?: boolean;
  startTime?: string;
  endTime?: string;
  priority?: 'low' | 'medium' | 'high';
}

export interface EventsResponse {
  data: CalendarEvent[];
  year: number;
  month: number;
}
