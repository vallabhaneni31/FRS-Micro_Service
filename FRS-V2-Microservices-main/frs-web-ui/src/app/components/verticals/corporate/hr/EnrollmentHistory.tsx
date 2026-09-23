import React, { useState, useEffect } from 'react';
import { Clock, User, Trash2, MonitorSmartphone, CheckCircle2 } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { authConfig } from '../../../../config/authConfig';
import { useAuth } from '../../../../contexts/AuthContext';

interface HistoryEvent {
  id: string;
  action: string;
  details: string;
  beforeData?: any;
  afterData?: any;
  performedBy: string;
  role?: string;
  source?: string;
  timestamp: string;
}

interface EnrollmentHistoryProps {
  employeeId: string;
  employeeName: string;
}

export const EnrollmentHistory: React.FC<EnrollmentHistoryProps> = ({ employeeId, employeeName }) => {
  const { accessToken } = useAuth();
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHistory();
  }, [employeeId]);

  const loadHistory = async () => {
    if (!accessToken) {
      console.warn('No access token available');
      setLoading(false);
      return;
    }
    
    setLoading(true);
    try {
      const response = await fetch(`${authConfig.apiBaseUrl}/employees/${employeeId}/enrollment-history`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (response.ok) {
        const data = await response.json();
        setHistory(data.history || []);
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoading(false);
    }
  };

  const getActionIcon = (action: string, source?: string) => {
    if (source === 'kiosk' || source === 'device') return MonitorSmartphone;
    if (action.includes('delete')) return Trash2;
    if (action.includes('enroll')) return CheckCircle2;
    return Clock;
  };

  const getActionColor = (action: string, source?: string) => {
    if (source === 'kiosk' || source === 'device') return 'text-violet-600 bg-violet-50 border-violet-200';
    if (action.includes('delete')) return 'text-red-600 bg-red-50 border-red-200';
    if (action.includes('enroll')) return 'text-green-600 bg-green-50 border-green-200';
    return 'text-blue-600 bg-blue-50 border-blue-200';
  };

  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-slate-500">
        Loading history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-slate-500">
        No enrollment history found
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 max-h-96 overflow-y-auto">
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
        Enrollment History for {employeeName}
      </h3>

      <div className="space-y-2">
        {history.map((event, idx) => {
          const Icon = getActionIcon(event.action, event.source);
          const colorClass = getActionColor(event.action, event.source);

          return (
            <div key={event.id} className="relative">
              {/* Timeline line */}
              {idx < history.length - 1 && (
                <div className="absolute left-4 top-8 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-700" />
              )}

              <div className="flex gap-3">
                {/* Icon */}
                <div className={cn('w-8 h-8 rounded-full border flex items-center justify-center shrink-0 z-10', colorClass)}>
                  <Icon className="w-4 h-4" />
                </div>

                {/* Content */}
                <div className="flex-1 pb-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                        {event.details}
                      </p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                        <User className="w-3 h-3" />
                        <span>{event.performedBy}</span>
                        {event.role && (
                          <span className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-[10px]">
                            {event.role}
                          </span>
                        )}
                        {(event.source === 'kiosk' || event.source === 'device') && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded text-[10px] font-semibold">
                            <MonitorSmartphone className="w-3 h-3" />
                            Kiosk
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-xs text-slate-400 whitespace-nowrap">
                      {new Date(event.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

