'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { isAddr } from '@/lib/contracts/voucher-v2';
import { inputCls } from './ui';

// Bulk-mint recipient list, same look as the v1 "Mint Batch" card: CSV links, then editable rows.
// CSV: "address, amount[, tokenId]" per line; a first line whose first column isn't an address is a
// header and is skipped; "#" lines are comments.
export const MAX_PER_CALL = 50; // VoucherConstants.MAX_MINT_PER_CALL (mintBatch / proposeBulkMint)
const PAGE = 50; // rows rendered at once, so a CSV with thousands of lines stays responsive

export interface EditRow { to: string; amount: string; tokenId: string }
export interface MintRow { row: number; to: string; amount: string; tokenId: string }

export const blankRow = (): EditRow => ({ to: '', amount: '', tokenId: '' });

export function csvToRows(text: string): EditRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
    .map((l) => l.trim().split(/[,;\t]+|\s+/).map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean))
    .filter((cols) => cols.length && !cols[0].startsWith('#'));
  if (lines.length && !isAddr(lines[0][0])) lines.shift();
  return lines.map(([to = '', amount = '', tokenId = '']) => ({ to, amount, tokenId }));
}

// fungible: amounts are token units (decimals ok); otherwise whole numbers. needsId: ERC721/ERC1155 → token id required.
// Fully blank rows are ignored; bad ones are listed as "row N: …" and returned in `bad` (0-based) for highlighting.
export function checkRows(list: EditRow[], fungible: boolean, needsId: boolean) {
  const rows: MintRow[] = [];
  const errors: string[] = [];
  const bad = new Set<number>();
  list.forEach((r, i) => {
    const to = r.to.trim(), amount = r.amount.trim(), tokenId = r.tokenId.trim();
    if (!to && !amount && !tokenId) return;
    const fail = (why: string) => { errors.push(`row ${i + 1}: ${why}`); bad.add(i); };
    if (!isAddr(to)) return fail(`bad address "${to}"`);
    if (!(fungible ? /^\d+(\.\d{1,18})?$/ : /^\d+$/).test(amount) || /^0*\.?0*$/.test(amount)) return fail(`bad amount "${amount}"`);
    if (needsId && !/^\d+$/.test(tokenId)) return fail('missing token id');
    rows.push({ row: i + 1, to: ethers.utils.getAddress(to), amount, tokenId: needsId ? tokenId : '0' });
  });
  return { rows, errors, bad };
}

export const chunk = <T,>(xs: T[], n = MAX_PER_CALL) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function downloadTemplate(needsId: boolean) {
  const body = needsId
    ? 'address,amount,tokenId\n0x1234567890123456789012345678901234567890,1,7\n'
    : 'address,amount\n0x1234567890123456789012345678901234567890,10\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd,2.5\n';
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'voucher-mint-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

const linkCls = 'flex items-center gap-1 text-xs text-accent hover:underline';

/** CSV links + Recipient / Amount (/ Token id) rows + "Add recipient", with a live summary underneath. */
export function RecipientRows({ rows, onChange, needsId, amountLabel, check, total, perTx, onLoaded }: {
  rows: EditRow[];
  onChange: (rows: EditRow[]) => void;
  needsId: boolean;
  amountLabel: string;
  check: ReturnType<typeof checkRows>;
  total?: string; // e.g. "37.5 tLUCA"
  perTx: string; // "transaction" | "proposal"
  onLoaded: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const [errorsOnly, setErrorsOnly] = useState(false);
  // indexes into `rows` that are on screen: one page of everything, or every row with a problem
  const visible = errorsOnly ? [...check.bad].sort((a, b) => a - b) : rows.map((_, i) => i);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageNow = Math.min(page, pages - 1);
  const shown = visible.slice(pageNow * PAGE, pageNow * PAGE + PAGE);
  useEffect(() => { if (!check.bad.size) setErrorsOnly(false); }, [check.bad.size]);
  const update = (i: number, k: keyof EditRow, v: string) => onChange(rows.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const cols = needsId ? 'grid-cols-[1fr_120px_100px_40px]' : 'grid-cols-[1fr_140px_40px]';
  const n = check.rows.length;
  const txs = Math.ceil(n / MAX_PER_CALL);
  const dupes = n - new Set(check.rows.map((r) => r.to.toLowerCase())).size;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same file name
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const loaded = csvToRows(String(reader.result || ''));
      if (!loaded.length) return onLoaded('CSV: no data rows found.');
      onChange(loaded);
      setPage(0);
      onLoaded(`Loaded ${loaded.length} recipient(s) from ${file.name} — review below before minting.`);
    };
    reader.onerror = () => onLoaded('Failed to read CSV file.');
    reader.readAsText(file);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => downloadTemplate(needsId)} className={linkCls}><Download className="w-3.5 h-3.5" /> Download template CSV</button>
        <button type="button" onClick={() => fileRef.current?.click()} className={linkCls}><Upload className="w-3.5 h-3.5" /> Upload CSV</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        {rows.length > 1 && <button type="button" onClick={() => onChange([blankRow()])} className="ml-auto text-xs text-txt-secondary hover:text-red-300">Clear all</button>}
      </div>
      <div className={`grid ${cols} gap-2 text-xs text-txt-secondary font-semibold px-1`}>
        <span>Recipient</span><span>{amountLabel}</span>{needsId && <span>Token id</span>}<span></span>
      </div>
      <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
        {shown.map((i) => { const r = rows[i]; return (
          <div key={i} className={`grid ${cols} gap-2 items-center`}>
            <input value={r.to} onChange={(e) => update(i, 'to', e.target.value)} placeholder="0x..." className={`${inputCls} ${check.bad.has(i) ? 'ring-1 ring-red-400' : ''}`} />
            <input value={r.amount} onChange={(e) => update(i, 'amount', e.target.value)} placeholder="10" className={inputCls} />
            {needsId && <input value={r.tokenId} onChange={(e) => update(i, 'tokenId', e.target.value)} placeholder="7" className={inputCls} />}
            {rows.length > 1 ? (
              <button type="button" title={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
            ) : <div />}
          </div>
        ); })}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => { onChange([...rows, blankRow()]); if (!errorsOnly) setPage(Math.floor(rows.length / PAGE)); }} className={`${linkCls} mt-1`}><Plus className="w-3.5 h-3.5" /> Add recipient</button>
        {pages > 1 && (
          <span className="flex items-center gap-2 text-xs text-txt-secondary">
            <button type="button" disabled={pageNow === 0} onClick={() => setPage(pageNow - 1)} className="text-accent disabled:opacity-30">‹ Prev</button>
            rows {shown[0] + 1}–{shown[shown.length - 1] + 1}{errorsOnly ? ' (with errors)' : ''} · page {pageNow + 1}/{pages}
            <button type="button" disabled={pageNow >= pages - 1} onClick={() => setPage(pageNow + 1)} className="text-accent disabled:opacity-30">Next ›</button>
          </span>
        )}
        {check.bad.size > 0 && (
          <label className="flex items-center gap-1 text-xs text-txt-secondary ml-auto">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => { setErrorsOnly(e.target.checked); setPage(0); }} className="w-3.5 h-3.5 accent-accent" /> Show only rows with errors
          </label>
        )}
      </div>
      {(n > 0 || check.errors.length > 0) && (
        <div className="text-xs space-y-1">
          <p className="text-txt-secondary">
            {n} recipient{n === 1 ? '' : 's'}{total && <> · total {total}</>}
            {n > 0 && <> · {txs} {perTx}{txs === 1 ? '' : 's'} of up to {MAX_PER_CALL}</>}
            {dupes > 0 && <span className="text-yellow-300"> · {dupes} repeated address{dupes === 1 ? '' : 'es'} (each row mints its own voucher)</span>}
          </p>
          {check.errors.length > 0 && <p className="text-red-300">{check.errors.slice(0, 5).join('; ')}{check.errors.length > 5 ? ` (+${check.errors.length - 5} more)` : ''} — fix these rows before minting.</p>}
        </div>
      )}
    </div>
  );
}
