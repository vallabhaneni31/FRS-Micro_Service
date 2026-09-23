import { useState, useMemo } from 'react';

export interface UsePaginationOptions {
    total: number;
    initialPage?: number;
    initialPageSize?: number;
}

export interface UsePaginationResult<T = never> {
    page: number;
    pageSize: number;
    totalPages: number;
    setPage: (p: number) => void;
    setPageSize: (s: number) => void;
    slice: <D>(data: D[]) => D[];
    paginate: <D>(data: D[]) => { items: D[]; total: number; page: number; totalPages: number };
}

export function usePagination({ total, initialPage = 1, initialPageSize = 20 }: UsePaginationOptions): UsePaginationResult {
    const [page, setPageRaw] = useState(initialPage);
    const [pageSize, setPageSizeRaw] = useState(initialPageSize);

    const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

    const setPage = (p: number) => {
        setPageRaw(Math.max(1, Math.min(p, totalPages)));
    };

    const setPageSize = (s: number) => {
        setPageSizeRaw(s);
        setPageRaw(1);
    };

    const slice = <D>(data: D[]): D[] => {
        const start = (page - 1) * pageSize;
        return data.slice(start, start + pageSize);
    };

    const paginate = <D>(data: D[]) => {
        const items = slice(data);
        const computedTotal = data.length;
        const computedPages = Math.max(1, Math.ceil(computedTotal / pageSize));
        return { items, total: computedTotal, page, totalPages: computedPages };
    };

    return { page, pageSize, totalPages, setPage, setPageSize, slice, paginate };
}
