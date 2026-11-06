'use client';
import React, { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { btnCls, btnSecondaryCls, inputCls } from './ui';

// Review dialog shown before a mint / propose is sent: every detail that goes on-chain, warnings,
// and the full wallet list (searchable) to cross-check against the source file. Promise based:
//   const { ask, dialog } = useConfirmDialog();   ...   const res = await ask({...}); if (!res) return;   ...   {dialog}
// With `allowRemove`, the admin can drop wallets from the list; `res.removed` = their indexes in `rows`.

export interface ConfirmRow { to: string; amount: string; group?: string } // amount: display units
export interface ConfirmResult { removed: number[] }
export interface ConfirmDetails {
  title: string;
  intro?: ReactNode;
  fields: { label: string; value: ReactNode; warn?: boolean }[];
  rows?: ConfirmRow[];
  amountLabel?: string; // column header, e.g. "Amount (tLUCA)"
  total?: string; // shown under the wallet list
  allowRemove?: boolean; // ✕ per wallet row: send without it (the caller drops it from its list)
  totalUnit?: string; // with allowRemove: amounts are decimal token units — recompute the total as rows are removed
  warnings?: string[];
  confirmLabel?: string;
}

const lower = (a: string) => a.toLowerCase();

function ConfirmModal({ d, nameOf, onClose }: { d: ConfirmDetails; nameOf?: (a: string) => string; onClose: (res: ConfirmResult | false) => void }) {
  const [showRows, setShowRows] = useState(false);
  const [q, setQ] = useState('');
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const allRows = useMemo(() => d.rows ?? [], [d.rows]);
  const rows = useMemo(() => allRows.filter((_, i) => !removed.has(i)), [allRows, removed]); // what will be sent
  const toggle = (i: number) => setRemoved((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const keptTotal = useMemo(() => {
    if (!d.totalUnit || !removed.size) return d.total;
    const t = rows.reduce((acc, r) => { try { return acc.add(ethers.utils.parseUnits(r.amount, 18)); } catch { return acc; } }, ethers.BigNumber.from(0));
    const s = ethers.utils.formatUnits(t, 18);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s} ${d.totalUnit}`;
  }, [rows, removed, d.total, d.totalUnit]);

  // checks on the list itself
  const checks = useMemo(() => {
    const seen = new Map<string, number>();
    rows.forEach((r) => seen.set(lower(r.to), (seen.get(lower(r.to)) ?? 0) + 1));
    const dup = new Set(Array.from(seen.entries()).filter(([, n]) => n > 1).map(([a]) => a));
    const zero = rows.filter((r) => !/[1-9]/.test(r.amount)).length;
    const nums = rows.map((r) => Number(r.amount)).filter((n) => Number.isFinite(n));
    return { dup, zero, unique: seen.size, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null };
  }, [rows]);

  const warnings = [
    ...(d.warnings ?? []),
    ...(checks.dup.size ? [`${checks.dup.size} wallet${checks.dup.size === 1 ? ' appears' : 's appear'} more than once (highlighted in the list) — each row mints its own voucher.`] : []),
    ...(checks.zero ? [`${checks.zero} row${checks.zero === 1 ? ' has' : 's have'} a zero amount.`] : []),
  ];

  const shown = q.trim()
    ? allRows.map((r, i) => ({ r, i })).filter(({ r }) => lower(r.to).includes(lower(q.trim())) || r.amount.includes(q.trim()) || (r.group ?? '').toLowerCase().includes(lower(q.trim())))
    : allRows.map((r, i) => ({ r, i }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <div role="dialog" aria-modal="true" className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl border border-white/10 bg-surface-secondary p-5 shadow-2xl">
        <h3 className="text-lg font-semibold">{d.title}</h3>
        {d.intro && <div className="text-xs text-txt-secondary mt-1">{d.intro}</div>}

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {d.fields.map((f) => (
            <div key={f.label} className="flex flex-col">
              <span className="text-[11px] uppercase tracking-wide text-txt-secondary">{f.label}</span>
              <span className={`break-all ${f.warn ? 'text-yellow-300' : ''}`}>{f.value}</span>
            </div>
          ))}
          {rows.length > 0 && (
            <div className="flex flex-col">
              <span className="text-[11px] uppercase tracking-wide text-txt-secondary">Wallets</span>
              <span>
                {rows.length} rows · {checks.unique} unique wallets
                {removed.size > 0 && <span className="text-red-300"> · {removed.size} removed</span>}
                {checks.min !== null && checks.max !== null && <span className="text-txt-secondary"> · per wallet {checks.min} – {checks.max}</span>}
              </span>
            </div>
          )}
        </div>

        {removed.size > 0 && (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-900/20 p-3 text-xs">
            {removed.size} wallet{removed.size === 1 ? '' : 's'} removed — {rows.length} will be sent{keptTotal ? `, total ${keptTotal}` : ''}. For a saved file, the removed wallets move into a new batch “… — removed wallets” (not proposed), so you can still track, propose or remove them later.
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mt-4 rounded-lg border border-yellow-400/40 bg-yellow-900/20 p-3 text-xs space-y-1">
            {warnings.map((w) => <div key={w}>⚠ {w}</div>)}
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-4">
            <button type="button" className={btnSecondaryCls} onClick={() => setShowRows((s) => !s)}>
              {showRows ? '▾ Hide wallets' : `▸ Show all ${allRows.length} wallets with amounts${d.allowRemove ? ' (remove any here)' : ''}`}
            </button>
            {showRows && (
              <div className="mt-2 space-y-2">
                <input className={inputCls} placeholder="Search wallet, amount or file…" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="max-h-72 overflow-auto rounded-lg border border-white/10">
                  <table className="w-full text-xs text-left">
                    <thead className="sticky top-0 bg-surface-tertiary text-txt-secondary">
                      <tr>
                        <th className="py-1.5 px-2">#</th>
                        <th className="px-2">Wallet</th>
                        <th className="px-2 text-right">{d.amountLabel ?? 'Amount'}</th>
                        {allRows.some((r) => r.group) && <th className="px-2">File</th>}
                        {d.allowRemove && <th className="px-2" />}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map(({ r, i }) => (
                        <tr key={i} className={`border-t border-white/5 ${removed.has(i) ? 'opacity-40 line-through' : checks.dup.has(lower(r.to)) ? 'bg-yellow-900/20' : ''}`}>
                          <td className="py-1 px-2 text-txt-secondary">{i + 1}</td>
                          <td className="px-2 font-mono break-all">
                            {r.to}
                            {nameOf && nameOf(r.to) !== r.to && !/…|\.\.\./.test(nameOf(r.to)) && <span className="ml-1 text-txt-secondary">({nameOf(r.to)})</span>}
                          </td>
                          <td className="px-2 text-right font-mono">{r.amount}</td>
                          {allRows.some((x) => x.group) && <td className="px-2 text-txt-secondary">{r.group}</td>}
                          {d.allowRemove && (
                            <td className="px-2 text-right no-underline">
                              <button type="button" className={`text-xs ${removed.has(i) ? 'text-accent' : 'text-red-300'} hover:underline`} title={removed.has(i) ? 'Put this wallet back' : 'Do not send to this wallet'}
                                onClick={() => toggle(i)} disabled={!removed.has(i) && rows.length <= 1}>
                                {removed.has(i) ? 'undo' : '✕ remove'}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {!shown.length && <tr><td colSpan={5} className="py-2 px-2 text-txt-secondary">No match.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {keptTotal && <div className="text-xs text-right">Total{removed.size ? ' after removing' : ''}: <b>{keptTotal}</b></div>}
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnSecondaryCls} onClick={() => onClose(false)}>Cancel</button>
          <button type="button" className={btnCls} autoFocus disabled={!!allRows.length && !rows.length} onClick={() => onClose({ removed: Array.from(removed).sort((a, b) => a - b) })}>
            {d.confirmLabel ?? 'Confirm & send'}{removed.size ? ` ${rows.length} wallet${rows.length === 1 ? '' : 's'}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useConfirmDialog(nameOf?: (a: string) => string) {
  const [state, setState] = useState<{ d: ConfirmDetails; resolve: (res: ConfirmResult | false) => void } | null>(null);
  const ask = useCallback((d: ConfirmDetails) => new Promise<ConfirmResult | false>((resolve) => setState({ d, resolve })), []);
  const close = useCallback((res: ConfirmResult | false) => {
    setState((s) => { s?.resolve(res); return null; });
  }, []);
  const dialog = state ? <ConfirmModal d={state.d} nameOf={nameOf} onClose={close} /> : null;
  return { ask, dialog };
}
