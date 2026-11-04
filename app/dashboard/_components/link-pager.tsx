'use client';
import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export const PAGE_SIZES = [10, 20, 50, 100];

/** Page state for a list; resets to page 1 whenever `resetKey` changes (filters, tab, wallet…). */
export function usePager<T>(items: T[], resetKey: string, initialSize = 20) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(initialSize);
  useEffect(() => { setPage(0); }, [resetKey, size]);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const now = Math.min(page, pages - 1);
  return { rows: items.slice(now * size, now * size + size), page: now, pages, size, setSize, setPage, total: items.length };
}

export function Pager({ p, label = 'rows' }: { p: ReturnType<typeof usePager<any>>; label?: string }) {
  if (p.total <= PAGE_SIZES[0]) return null;
  const from = p.page * p.size + 1;
  const to = Math.min(p.total, from + p.size - 1);
  const btn = 'p-1 rounded hover:bg-surface-tertiary disabled:opacity-30';
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-txt-secondary">
      <span>{from}–{to} of {p.total} {label}</span>
      <button className={btn} disabled={p.page === 0} onClick={() => p.setPage(0)} title="First"><ChevronsLeft className="w-4 h-4" /></button>
      <button className={btn} disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)} title="Previous"><ChevronLeft className="w-4 h-4" /></button>
      <span>Page {p.page + 1} / {p.pages}</span>
      <button className={btn} disabled={p.page >= p.pages - 1} onClick={() => p.setPage(p.page + 1)} title="Next"><ChevronRight className="w-4 h-4" /></button>
      <button className={btn} disabled={p.page >= p.pages - 1} onClick={() => p.setPage(p.pages - 1)} title="Last"><ChevronsRight className="w-4 h-4" /></button>
      <select className="bg-surface-tertiary rounded px-1.5 py-0.5" value={p.size} onChange={(e) => p.setSize(Number(e.target.value))}>
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
      </select>
    </div>
  );
}
