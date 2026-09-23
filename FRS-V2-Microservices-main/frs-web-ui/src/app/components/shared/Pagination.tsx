import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../ui/utils';

interface PaginationProps {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    className?: string;
}

function buildPages(page: number, totalPages: number): (number | '...')[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

    const pages: (number | '...')[] = [1];

    if (page > 3) pages.push('...');

    const start = Math.max(2, page - 1);
    const end   = Math.min(totalPages - 1, page + 1);
    for (let i = start; i <= end; i++) pages.push(i);

    if (page < totalPages - 2) pages.push('...');
    pages.push(totalPages);

    return pages;
}

export const Pagination: React.FC<PaginationProps> = ({ page, totalPages, onPageChange, className }) => {
    if (totalPages <= 1) return null;

    const pages = buildPages(page, totalPages);

    const btn = (content: React.ReactNode, target: number | null, disabled: boolean, active = false) => (
        <button
            key={typeof content === 'string' ? content + target : target}
            onClick={() => target !== null && onPageChange(target)}
            disabled={disabled}
            className={cn(
                'h-8 min-w-[2rem] px-2 rounded text-sm font-medium transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
                active
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed'
            )}
        >
            {content}
        </button>
    );

    return (
        <nav className={cn('flex items-center gap-1', className)} aria-label="Pagination">
            {btn(<ChevronLeft className="w-4 h-4" />, page - 1, page === 1)}
            {pages.map((p, i) =>
                p === '...'
                    ? <span key={`ellipsis-${i}`} className="h-8 px-1 flex items-center text-slate-400 text-sm select-none">…</span>
                    : btn(p, p, false, p === page)
            )}
            {btn(<ChevronRight className="w-4 h-4" />, page + 1, page === totalPages)}
        </nav>
    );
};
