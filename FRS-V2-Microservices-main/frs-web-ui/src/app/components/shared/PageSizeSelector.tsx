import React from 'react';
import { cn } from '../ui/utils';

interface PageSizeSelectorProps {
    pageSize: number;
    options?: number[];
    onChange: (size: number) => void;
    className?: string;
}

const DEFAULT_OPTIONS = [10, 20, 50, 100];

export const PageSizeSelector: React.FC<PageSizeSelectorProps> = ({
    pageSize,
    options = DEFAULT_OPTIONS,
    onChange,
    className,
}) => (
    <div className={cn('flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400', className)}>
        <span className="whitespace-nowrap">Rows per page</span>
        <select
            value={pageSize}
            onChange={e => onChange(Number(e.target.value))}
            className={cn(
                'h-8 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 text-sm text-slate-800 dark:text-slate-200',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
                'cursor-pointer'
            )}
        >
            {options.map(o => (
                <option key={o} value={o}>{o}</option>
            ))}
        </select>
    </div>
);
