'use client';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Skeleton } from './feedback';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortKey?: string;
  className?: string;
}

export interface SortState {
  sort: string;
  order: 'asc' | 'desc';
}

/** Accessible table with optional sorting, selection and row navigation. */
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  empty,
  sort,
  onSort,
  selectable,
  selected,
  onSelectedChange,
  onRowClick,
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  empty?: React.ReactNode;
  sort?: SortState;
  onSort?: (s: SortState) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onRowClick?: (row: T) => void;
  caption?: string;
}) {
  const allIds = rows?.map((r) => r.id) ?? [];
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selected?.has(id));
  const toggleAll = () => onSelectedChange?.(allSelected ? new Set() : new Set(allIds));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange?.(next);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-subtle/60 text-left">
            {selectable && (
              <th className="w-10 px-3 py-2.5">
                <input type="checkbox" aria-label="Select all rows" checked={!!allSelected} onChange={toggleAll} className="size-4 accent-[var(--color-brand)]" />
              </th>
            )}
            {columns.map((c) => {
              const active = sort && c.sortKey && sort.sort === c.sortKey;
              return (
                <th key={c.key} scope="col" className={cn('px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted', c.className)} aria-sort={active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 uppercase hover:text-ink"
                      onClick={() => onSort({ sort: c.sortKey!, order: active && sort!.order === 'desc' ? 'asc' : 'desc' })}
                    >
                      {c.header}
                      {active && (sort!.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-line">
                {selectable && <td className="px-3 py-3" />}
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-3">
                    <Skeleton className="h-4 w-full max-w-40" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            rows?.map((row) => (
              <tr
                key={row.id}
                className={cn('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-subtle/60', selected?.has(row.id) && 'bg-brand-soft/50')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {selectable && (
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select row" checked={!!selected?.has(row.id)} onChange={() => toggle(row.id)} className="size-4 accent-[var(--color-brand)]" />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2.5 align-middle text-ink-2', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && rows && rows.length === 0 && empty}
    </div>
  );
}

export function Pagination({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-sm text-muted">
      <span>{total.toLocaleString('en-IN')} total</span>
      <div className="flex items-center gap-2">
        <span>
          Page {page} of {pageCount}
        </span>
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
