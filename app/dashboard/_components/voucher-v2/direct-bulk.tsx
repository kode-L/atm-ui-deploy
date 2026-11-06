'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { UtcTime } from '@/components/utc-datetime';
import { getExplorerTxUrl } from '@/lib/contracts/config';
import { TokenStandard, VoucherMode, VoucherType, fromUnits, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { Badge, btnCls, btnDangerCls, btnSecondaryCls, linkBtnCls } from './ui';
import { MAX_PER_CALL, chunk } from './mint-csv';
import { BatchGroup, BatchPreview, readBatchFiles } from './batch-files';
import { StoredBatch, StoredRow, StoredUpload, deleteUpload, listUploads, newUploadId, saveUpload } from './upload-store';

// Bulk uploads for DIRECT minting (VoucherNFT.mintBatch from the connected wallet) — the
// counterpart of the VoucherDAO tab's bulk uploads. Saved in the same IndexedDB store, keyed by the
// VoucherNFT address instead of the DAO's, so the two lists never mix. One batch = one mintBatch tx
// (max MAX_PER_CALL rows). `minted` is keyed by batch index here (there are no proposal ids).
// A batch that was sent but never confirmed back (page closed, wallet stuck) is looked up on-chain
// by its recipients before it can be sent again, so it is never minted twice.

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
const showFace = (t: VoucherType | undefined, v: ethers.BigNumberish) => (fungible(t) ? fromUnits(v, 18) : String(v));
const LOG_CHUNK = 5000; // blocks per getLogs call (public RPC limits)
const SEARCH_SLACK = 600; // extra blocks searched before a batch's send time

type Ctx = ReturnType<typeof useVoucherV2>;
type BatchState = 'done' | 'unknown' | 'todo';
const stateOf = (b: StoredBatch): BatchState => (b.completedAt ? 'done' : b.fromTs ? 'unknown' : 'todo');

export interface DirectParams { token: string; startDate: number; expiryDate: number }

/** New direct upload from rows (already on-chain values), split into mintBatch-sized batches. */
export function makeDirectUpload(ctx: Ctx, type: VoucherType, name: string, rows: StoredRow[], p: DirectParams, source?: string, files?: { file: string; rows: StoredRow[] }[]): StoredUpload {
  const all: StoredRow[] = [];
  const batches: StoredBatch[] = [];
  for (const f of files ?? [{ file: '', rows }]) {
    const parts = chunk(f.rows, MAX_PER_CALL);
    parts.forEach((part, k) => {
      batches.push({ start: all.length, end: all.length + part.length, proposalId: null, file: f.file ? (parts.length > 1 ? `${f.file} (${k + 1}/${parts.length})` : f.file) : undefined });
      all.push(...part);
    });
  }
  return {
    id: newUploadId(), chainId: ctx.chainId, dao: (ctx.book.contracts.VoucherNFT || '').toLowerCase(), typeId: type.id, token: p.token,
    startDate: p.startDate, expiryDate: p.expiryDate, createdAt: Math.floor(Date.now() / 1000), name, source, rows: all, batches, minted: {},
  };
}

/** Look for batch i's mintBatch on-chain (sent but never confirmed back). Marks it done when found. */
async function findOnChain(ctx: Ctx, u: StoredUpload, i: number): Promise<boolean> {
  const b = u.batches[i];
  const nft = ctx.read('VoucherNFT');
  const provider = ctx.reader!;
  const rows = u.rows.slice(b.start, b.end);
  const latest = await provider.getBlock('latest');
  const older = await provider.getBlock(Math.max(0, latest.number - 1000));
  const secsPerBlock = Math.max(0.5, (latest.timestamp - older.timestamp) / 1000);
  const from = Math.max(0, latest.number - Math.ceil((latest.timestamp - (b.fromTs || latest.timestamp)) / secsPerBlock) - SEARCH_SLACK);
  const topic = nft.interface.getEventTopic('VoucherMinted');
  const pad = (v: ethers.BigNumberish) => ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 32);
  const topics = [topic, null, pad(u.typeId), ethers.utils.hexZeroPad(rows[0].to.toLowerCase(), 32)];
  const seen = new Set<string>();
  for (let start = from; start <= latest.number; start += LOG_CHUNK) {
    const logs = await provider.getLogs({ address: nft.address, topics, fromBlock: start, toBlock: Math.min(latest.number, start + LOG_CHUNK - 1) });
    for (const log of logs) {
      if (seen.has(log.transactionHash)) continue;
      seen.add(log.transactionHash);
      const rc = await provider.getTransactionReceipt(log.transactionHash);
      const minted = rc.logs.filter((l) => sameAddr(l.address, nft.address) && l.topics[0] === topic).map((l) => nft.interface.parseLog(l));
      if (minted.length !== rows.length || minted.some((m, k) => !sameAddr(m.args.to, rows[k].to) || Number(m.args.typeId) !== u.typeId)) continue;
      const ids = minted.map((m) => m.args.voucherId.toString());
      // same recipients in the same order: confirm the values too before calling it ours
      const faces = await Promise.all(ids.map((id) => nft.vouchers(id).then((v: any) => v.faceValue.toString())));
      if (faces.some((f, k) => f !== rows[k].face)) continue;
      const blk = await provider.getBlock(rc.blockNumber);
      u.batches[i] = { ...b, execTx: rc.transactionHash, completedAt: blk.timestamp };
      u.minted = { ...(u.minted || {}), [i]: ids };
      await saveUpload(u);
      return true;
    }
  }
  return false;
}

/**
 * Mints every batch of `u` that isn't minted yet, in order. A batch with unknown status is looked up
 * on-chain first and skipped if it already went through. Returns how many batches it minted now.
 */
export async function runDirectUpload(ctx: Ctx, u: StoredUpload, only?: number): Promise<number> {
  const nft = ctx.write('VoucherNFT');
  const todo = u.batches.map((b, i) => i).filter((i) => (only === undefined || i === only) && stateOf(u.batches[i]) !== 'done');
  const labels = todo.map((i) => `Bulk mint ${u.name} · batch ${i + 1}/${u.batches.length} (${u.batches[i].end - u.batches[i].start} vouchers)`);
  if (todo.length > 1) ctx.beginFlow(`Bulk mint ${u.name}`, labels);
  let sent = 0;
  for (const [k, i] of todo.entries()) {
    if (stateOf(u.batches[i]) === 'unknown' && (await findOnChain(ctx, u, i))) continue;
    const b = u.batches[i];
    const rows = u.rows.slice(b.start, b.end);
    u.batches[i] = { ...b, fromTs: Math.floor(Date.now() / 1000) };
    await saveUpload(u);
    let receipt: ethers.ContractReceipt;
    try {
      receipt = await ctx.send(labels[k], nft, 'mintBatch', [u.typeId, rows.map((r) => r.to), rows.map((r) => r.face), u.startDate, u.expiryDate, u.token, rows.map((r) => r.tokenId || '0')]);
    } catch (e: any) {
      // ctx.send rewraps errors, so ask the chain (a short search: it was sent moments ago).
      // Found: it went through after all. Not found: nothing minted, back to "to do".
      // Search failed: stays "sent, not confirmed" until checked, so it can't be sent twice.
      const found = await findOnChain(ctx, u, i).catch(() => null);
      if (found) continue;
      if (found === false) {
        u.batches[i] = { ...u.batches[i], fromTs: undefined };
        await saveUpload(u);
      }
      throw e;
    }
    const ids = receipt.logs.filter((l) => sameAddr(l.address, nft.address)).map((l) => { try { return nft.interface.parseLog(l); } catch { return null; } })
      .filter((x) => x?.name === 'VoucherMinted').map((x) => x!.args.voucherId.toString());
    const blk = await ctx.reader!.getBlock(receipt.blockNumber);
    u.batches[i] = { ...u.batches[i], execTx: receipt.transactionHash, completedAt: blk.timestamp };
    u.minted = { ...(u.minted || {}), [i]: ids };
    await saveUpload(u);
    sent++;
  }
  return sent;
}

/** Saved bulk uploads for direct minting of `type`: import zip/CSV, mint batch by batch, track, export. */
export default function DirectBulkUploads({ type, params, version, onChange }: {
  type: VoucherType;
  params: () => DirectParams; // payout token + dates from the Mint form, fixed into an upload when it's saved
  version: number;
  onChange: () => void;
}) {
  const ctx = useVoucherV2();
  const nftAddr = ctx.book.contracts.VoucherNFT;
  const [uploads, setUploads] = useState<StoredUpload[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [claims, setClaims] = useState<Record<string, { claimed: boolean; revoked: boolean }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fung = fungible(type);
  const needsId = type.mode === VoucherMode.Reward && (type.tokenStandard === TokenStandard.ERC721 || type.tokenStandard === TokenStandard.ERC1155);

  const reload = useCallback(() => {
    if (!nftAddr) return;
    listUploads(ctx.chainId, nftAddr).then((l) => setUploads(l.filter((u) => u.typeId === type.id))).catch(() => setUploads([]));
  }, [ctx.chainId, nftAddr, type.id]);
  useEffect(() => { reload(); }, [reload, version]);

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setMsg(null);
    try {
      setPreview(await readBatchFiles(list, fung, needsId));
    } catch (e: any) {
      setPreview(null);
      setMsg({ ok: false, text: `Import failed: ${e.message}` });
    }
  };

  const saveImport = async () => {
    if (!preview) return;
    try {
      const picked = preview.groups.filter((g) => g.pick).map((g) => ({ ...g, files: g.files.filter((f) => f.pick) })).filter((g) => g.files.length);
      if (!picked.length) throw new Error('Tick at least one file');
      const bad = picked.flatMap((g) => g.files.filter((f) => f.errors.length || f.sha === 'bad').map((f) => `${g.name}/${f.file}`));
      if (bad.length) throw new Error(`Fix or untick these files first: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`);
      let first = '';
      for (const g of picked) {
        const name = `${preview.source} · ${g.name}`;
        if (uploads.some((u) => u.name === name) && !window.confirm(`"${name}" was imported before. Import it again as a separate upload?`)) continue;
        const u = makeDirectUpload(ctx, type, name, [], params(), preview.source, g.files);
        await saveUpload(u);
        first ||= u.id;
      }
      setPreview(null);
      if (first) setOpen(first);
      setMsg({ ok: true, text: 'Saved. Open an upload and mint its batches.' });
      onChange();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const run = async (u: StoredUpload, only?: number) => {
    setBusy(u.id);
    setMsg(null);
    try {
      const n = await runDirectUpload(ctx, u, only);
      const left = u.batches.filter((b) => stateOf(b) !== 'done').length;
      setMsg({ ok: true, text: `${n ? `Minted ${n} batch${n === 1 ? '' : 'es'}.` : 'Nothing new to send.'}${left ? ` ${left} batch${left === 1 ? '' : 'es'} left.` : ' Upload complete.'}` });
    } catch (e: any) {
      setMsg({ ok: false, text: `${e.message} Minted batches are kept; Mint remaining continues from where it stopped.` });
    } finally {
      setBusy(null);
      onChange();
    }
  };

  const recheck = async (u: StoredUpload, i: number) => {
    setBusy(u.id);
    try {
      const found = await findOnChain(ctx, u, i);
      if (!found) {
        u.batches[i] = { ...u.batches[i], fromTs: undefined };
        await saveUpload(u);
      }
      setMsg({ ok: true, text: found ? `Batch ${i + 1} was minted on-chain — marked done.` : `Batch ${i + 1} is not on-chain — it can be minted.` });
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not search the chain: ${e.message}` });
    } finally {
      setBusy(null);
      onChange();
    }
  };

  const checkClaims = async (u: StoredUpload) => {
    setBusy(u.id);
    try {
      const nft = ctx.read('VoucherNFT');
      const ids = Object.values(u.minted || {}).flat();
      const out = await Promise.all(ids.map((id) => nft.vouchers(id).then((v: any) => [id, { claimed: v.claimed, revoked: v.revoked }] as const)));
      setClaims((c) => ({ ...c, ...Object.fromEntries(out) }));
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not read vouchers: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = (u: StoredUpload) => {
    const lines = ['address,amount,tokenId,voucherId,status,tx'];
    u.batches.forEach((b, i) => {
      const ids = u.minted?.[i] || [];
      u.rows.slice(b.start, b.end).forEach((r, k) => {
        const id = ids[k] || '';
        const c = id ? claims[id] : undefined;
        const status = !id ? 'not minted' : c?.revoked ? 'revoked' : c?.claimed ? 'claimed' : c ? 'open' : 'minted';
        lines.push([r.to, showFace(type, r.face), r.tokenId || '0', id, status, b.execTx || ''].join(','));
      });
    });
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${u.name.replace(/[^\w.-]+/g, '_')}-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const remove = async (u: StoredUpload) => {
    if (!window.confirm(`Remove "${u.name}" from this browser? Vouchers already minted are not affected.`)) return;
    await deleteUpload(u.id);
    if (open === u.id) setOpen(null);
    onChange();
  };

  const setGroup = (gi: number, patch: Partial<BatchGroup>) => setPreview((pv) => pv && { ...pv, groups: pv.groups.map((x, i) => (i === gi ? { ...x, ...patch } : x)) });

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">Bulk uploads <span className="text-txt-secondary font-normal">· type #{type.id}</span></span>
        <span className="text-[11px] text-txt-secondary">Saved in this browser. Each batch = one mintBatch (max {MAX_PER_CALL}).</span>
      </div>

      <div className="bg-surface-tertiary rounded-lg p-3 text-xs space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">Import batch files</span>
          <input type="file" accept=".zip,.csv" multiple className="text-xs" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-txt-secondary">
          A zip or CSVs (<code>address,amount{needsId ? ',tokenId' : ''}</code>). One upload per folder, one batch per file. A <code>files.csv</code> with sha256s is checked.
          Payout token and dates come from the form above and are fixed when you save.
        </p>
        {preview && (
          <div className="border-t border-white/10 pt-2 space-y-2">
            {preview.summary && <pre className="whitespace-pre-wrap text-[11px] text-txt-secondary">{preview.summary.trim()}</pre>}
            {preview.missing.length > 0 && <p className="text-yellow-300">Listed in files.csv but not in the upload (left out): {preview.missing.join(', ')}</p>}
            {preview.groups.map((g, gi) => {
              const on = g.files.filter((f) => f.pick);
              const total = on.reduce((t, f) => t.add(f.total), ethers.BigNumber.from(0));
              const bad = on.filter((f) => f.errors.length || f.sha === 'bad');
              return (
                <div key={g.name}>
                  <label className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" checked={g.pick} onChange={(e) => setGroup(gi, { pick: e.target.checked })} />
                    <b>{g.name}</b>
                    <span>{on.length}/{g.files.length} files · {on.reduce((t, f) => t + f.rows.length, 0)} rows · {showFace(type, total)}</span>
                    {bad.length > 0 && <Badge tone="bad">{bad.length} with problems</Badge>}
                  </label>
                  {g.pick && (
                    <div className="ml-6 mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4">
                      {g.files.map((f, fi) => {
                        const problem = f.sha === 'bad' ? 'sha256 does not match files.csv' : f.errors.slice(0, 2).join('; ');
                        return (
                          <label key={f.file} className={`flex items-start gap-2 py-0.5 ${f.pick ? '' : 'opacity-50 line-through'}`}>
                            <input type="checkbox" className="mt-0.5" checked={f.pick} onChange={(e) => setGroup(gi, { files: g.files.map((x, i) => (i === fi ? { ...x, pick: e.target.checked } : x)) })} />
                            <span className="break-all">{f.file} <span className="text-txt-secondary">· {f.rows.length} rows · {showFace(type, f.total)}{f.sha === 'ok' ? ' · sha ✓' : ''}</span>{problem && <span className="text-red-300"> · {problem}</span>}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex gap-2">
              <button className={btnCls} onClick={saveImport}>Save for type #{type.id}</button>
              <button className={btnSecondaryCls} onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {!uploads.length && <p className="text-xs text-txt-secondary">No uploads for this type yet. Import files above, or use “Many (list or CSV)” and Mint all — that list is saved here too.</p>}
      {uploads.map((u) => {
        const done = u.batches.filter((b) => stateOf(b) === 'done');
        const unknown = u.batches.filter((b) => stateOf(b) === 'unknown').length;
        const mintedRows = done.reduce((t, b) => t + b.end - b.start, 0);
        const isOpen = open === u.id;
        const ids = Object.values(u.minted || {}).flat();
        const claimed = ids.filter((id) => claims[id]?.claimed).length;
        return (
          <div key={u.id} className={`rounded-lg text-xs ${isOpen ? 'bg-accent/10 border border-accent/40' : 'bg-surface-tertiary'}`}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button className="font-semibold hover:underline text-left" onClick={() => setOpen(isOpen ? null : u.id)}>{isOpen ? '▾' : '▸'} {u.name}</button>
              <span className="text-txt-secondary">{u.rows.length} rows · {u.batches.length} batch{u.batches.length === 1 ? '' : 'es'} · {showFace(type, u.rows.reduce((t, r) => t.add(r.face), ethers.BigNumber.from(0)))}</span>
              <Badge tone={done.length === u.batches.length ? 'good' : done.length ? 'warn' : 'muted'}>{done.length}/{u.batches.length} batches · {mintedRows}/{u.rows.length} minted</Badge>
              {unknown > 0 && <Badge tone="warn">{unknown} unconfirmed</Badge>}
              {ids.some((id) => claims[id]) && <Badge tone="muted">{claimed}/{ids.length} claimed</Badge>}
              <span className="ml-auto flex flex-wrap gap-2">
                {done.length < u.batches.length && <button className={btnCls} disabled={busy !== null} onClick={() => run(u)}>{busy === u.id ? 'Working…' : done.length ? 'Mint remaining' : 'Mint all'}</button>}
                {ids.length > 0 && <button className={btnSecondaryCls} disabled={busy !== null} onClick={() => checkClaims(u)}>Check claims</button>}
                <button className={btnSecondaryCls} onClick={() => exportCsv(u)}>Results CSV</button>
                <button className={btnDangerCls} disabled={busy !== null} onClick={() => remove(u)}>Remove</button>
              </span>
            </div>
            {isOpen && (
              <div className="px-3 pb-3 overflow-x-auto">
                <p className="text-txt-secondary mb-2">
                  Token {sameAddr(u.token, ethers.constants.AddressZero) ? 'native / none' : ctx.nameOf(u.token)} · claimable from <UtcTime ts={u.startDate} empty="now" /> · expires <UtcTime ts={u.expiryDate} empty="never" />{u.source ? ` · from ${u.source}` : ''}
                </p>
                <table className="w-full">
                  <thead><tr className="text-left text-txt-secondary border-b border-white/10">{['Batch', 'File', 'Rows', 'Status', 'Vouchers', 'Tx', ''].map((h) => <th key={h} className="py-1.5 pr-3">{h}</th>)}</tr></thead>
                  <tbody>
                    {u.batches.map((b, i) => {
                      const st = stateOf(b);
                      const vid = u.minted?.[i] || [];
                      return (
                        <tr key={i} className="border-b border-white/5">
                          <td className="py-1.5 pr-3">{i + 1}</td>
                          <td className="py-1.5 pr-3 break-all">{b.file || '—'}</td>
                          <td className="py-1.5 pr-3">{b.start + 1}–{b.end}</td>
                          <td className="py-1.5 pr-3">
                            {st === 'done' && <Badge tone="good">Minted</Badge>}
                            {st === 'unknown' && <Badge tone="warn">Sent, not confirmed</Badge>}
                            {st === 'todo' && <Badge tone="muted">To do</Badge>}
                          </td>
                          <td className="py-1.5 pr-3">{vid.length ? (vid.length > 1 ? `#${vid[0]}–#${vid[vid.length - 1]}` : `#${vid[0]}`) : '—'}</td>
                          <td className="py-1.5 pr-3">{b.execTx ? <a className="text-accent hover:underline" href={getExplorerTxUrl(ctx.chainId, b.execTx)} target="_blank" rel="noreferrer">{b.execTx.slice(0, 10)}…</a> : '—'}</td>
                          <td className="py-1.5 text-right whitespace-nowrap">
                            {st === 'todo' && <button className={linkBtnCls} disabled={busy !== null} onClick={() => run(u, i)}>Mint this batch</button>}
                            {st === 'unknown' && <button className={linkBtnCls} disabled={busy !== null} onClick={() => recheck(u, i)}>Check on-chain</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}
