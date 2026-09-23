import React from 'react';
import { Pagination } from './Pagination';
import { PageSizeSelector } from './PageSizeSelector';
import { cn } from '../ui/utils';

interface PaginationBarProps {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
    pageSizeOptions?: number[];
    className?: string;
}

export const PaginationBar: React.FC<PaginationBarProps> = ({
    page,
    pageSize,
    total,
    totalPages,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions,
    className,
}) => {
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end   = Math.min(page * pageSize, total);

    return (
        <div className={cn('flex flex-wrap items-center justify-between gap-3 py-3', className)}>
            <div className="flex items-center gap-4">
                <PageSizeSelector
                    pageSize={pageSize}
                    options={pageSizeOptions}
                    onChange={onPageSizeChange}
                />
                <span className="text-sm text-slate-500 whitespace-nowrap">
                    {total === 0 ? 'No results' : `${start}–${end} of ${total}`}
                </span>
            </div>
            <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={onPageChange}
            />
        </div>
    );
};
