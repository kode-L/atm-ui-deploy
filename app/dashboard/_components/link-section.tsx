'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { Link2, Link2Off, CheckCheck, RefreshCw, ExternalLink, Upload, Download, Square, AlertTriangle, Loader2, Layers } from 'lucide-react';
import { getBatchSupport, sendBatch, waitForBatch, type BatchCall, type BatchReceipt, type BatchSupport } from '@/lib/contracts/wallet-batch';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import { NETWORKS, getExplorerAddressUrl, getExplorerTxUrl } from '@/lib/contracts/config';
import { inputCls, btnCls, btnSecondaryCls, btnDangerCls, Badge } from './voucher-v2/ui';
import {
  LINK_ADDRESSES, KNOWN_SYMBOLS, FILE_ABI, FACTORY_ABI, LINK_ABI, ERC20_ABI, LINK_STATUS_LABELS, LinkStatus,
  ZERO, isNative, approveCheck, disconnectCheck, decodeLinkError, parseAddressList, downloadCsv,
  type LinkState,
} from '@/lib/contracts/link';
import { toLinkState } from '@/lib/contracts/link/indexer';
import { connectionView } from '@/lib/contracts/link/view';
import { usePager, Pager } from './link-pager';
import { useLinkIndex, LinkIndexPanel, type LinkIndex } from './link-index-panel';
import LinkConnections from './link-connections';
import { useLinkRequests } from './link-requests';

// ─── shared ──────────────────────────────────────────────────────────────────

type RowRun = { state: 'idle' | 'pending' | 'done' | 'failed' | 'skipped'; hash?: string; note?: string };
const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const fmt = (v: ethers.BigNumberish, d: number) => {
  const s = ethers.utils.formatUnits(v, d);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

interface TokenInfo { symbol: string; addr: string; minAmount: ethers.BigNumber; decimals: number }
export interface BatchMode { on: boolean; size: number }

const erc20Iface = new ethers.utils.Interface(ERC20_ABI);
const factoryIface = new ethers.utils.Interface(FACTORY_ABI);
const linkIface = new ethers.utils.Interface(LINK_ABI);

/** approve(trader, need) calls for every ERC20 whose current allowance is short — prepended to the first batch. */
async function approvalCalls(provider: ethers.providers.Provider, owner: string, trader: string, needs: { token: string; need: ethers.BigNumber }[]): Promise<BatchCall[]> {
  const out: BatchCall[] = [];
  for (const n of needs) {
    if (isNative(n.token) || n.need.isZero()) continue;
    const allow: ethers.BigNumber = await new ethers.Contract(n.token, ERC20_ABI, provider).allowance(owner, trader);
    if (allow.lt(n.need)) out.push({ to: n.token, data: erc20Iface.encodeFunctionData('approve', [trader, n.need]) });
  }
  return out;
}

/** eth_call the exact call as the user; returns the revert reason, or null if it would succeed. */
const simulateAs = (provider: ethers.providers.Provider, from: string) => (c: BatchCall) =>
  provider.call({ from, to: c.to, data: c.data, value: c.value }).then(() => null, (e: any) => decodeLinkError(e));

/** Estimate, pad 20%, send, wait for 1 confirmation. Keeps msg.value overrides intact. */
async function send(c: ethers.Contract, method: string, args: any[], value?: ethers.BigNumber) {
  const ov: ethers.PayableOverrides = value && value.gt(0) ? { value } : {};
  const est = await c.estimateGas[method](...args, ov);
  const tx: ethers.ContractTransaction = await c[method](...args, { ...ov, gasLimit: est.mul(120).div(100) });
  const receipt = await tx.wait(1);
  return { tx, receipt };
}

function RunCell({ r, chainId }: { r?: RowRun; chainId: number }) {
  if (!r || r.state === 'idle') return <span className="text-txt-secondary">—</span>;
  const tone = r.state === 'done' ? 'text-green-300' : r.state === 'failed' ? 'text-red-300' : r.state === 'pending' ? 'text-yellow-300' : 'text-txt-secondary';
  return (
    <span className={`flex items-center gap-1 ${tone}`}>
      {r.state === 'pending' && <Loader2 className="w-3 h-3 animate-spin" />}
      {r.state}
      {r.hash && <a href={getExplorerTxUrl(chainId, r.hash)} target="_blank" rel="noopener noreferrer" className="text-accent"><ExternalLink className="w-3 h-3" /></a>}
      {r.note && <span className="text-[11px] opacity-80 truncate max-w-[220px]" title={r.note}>{r.note}</span>}
    </span>
  );
}

function Progress({ runs, total }: { runs: Record<string, RowRun>; total: number }) {
  const v = Object.values(runs);
  const done = v.filter((r) => r.state === 'done').length;
  const failed = v.filter((r) => r.state === 'failed').length;
  if (!v.length) return null;
  return <p className="text-xs text-txt-secondary">{done} done · {failed} failed · {total - done - failed} remaining</p>;
}

/** Sequential runner: one wallet tx per item, waits for each receipt, stoppable between items. */
function useRunner() {
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);
  const run = useCallback(async <T,>(items: T[], key: (t: T) => string, exec: (t: T) => Promise<{ hash: string; note?: string }>, set: React.Dispatch<React.SetStateAction<Record<string, RowRun>>>) => {
    stopRef.current = false;
    setRunning(true);
    try {
      for (const it of items) {
        const k = key(it);
        if (stopRef.current) { set((s) => ({ ...s, [k]: { state: 'skipped', note: 'stopped' } })); continue; }
        set((s) => ({ ...s, [k]: { state: 'pending', note: 'confirm in wallet…' } }));
        try {
          const r = await exec(it);
          set((s) => ({ ...s, [k]: { state: 'done', hash: r.hash, note: r.note } }));
        } catch (e: any) {
          set((s) => ({ ...s, [k]: { state: 'failed', hash: e?.transactionHash || e?.receipt?.transactionHash, note: decodeLinkError(e) } }));
        }
      }
    } finally {
      setRunning(false);
    }
  }, []);

  // Batch mode: one wallet confirmation per `size` calls via EIP-5792. Each call is simulated
  // first (unless an approval it depends on is still in `prefix`) so one bad row can't sink an
  // atomic batch. `prefix` (token approvals) rides in the first chunk and is retried if it fails.
  const runBatch = useCallback(async <T,>(o: {
    items: T[]; key: (t: T) => string; build: (t: T) => BatchCall; prefix: BatchCall[]; size: number;
    signer: ethers.Signer; from: string; chainId: number;
    simulate?: (c: BatchCall) => Promise<string | null>;
    afterChunk?: (ok: T[], receipts: BatchReceipt[]) => Record<string, string>;
    set: React.Dispatch<React.SetStateAction<Record<string, RowRun>>>;
  }) => {
    const { key, set } = o;
    const mark = (ts: T[], r: RowRun) => set((s) => { const n = { ...s }; ts.forEach((t) => { n[key(t)] = r; }); return n; });
    stopRef.current = false;
    setRunning(true);
    try {
      let todo = o.items;
      mark(todo, { state: 'pending', note: 'queued' });
      if (o.simulate && !o.prefix.length) {
        mark(todo, { state: 'pending', note: 'pre-checking…' });
        const keep: T[] = [];
        for (let i = 0; i < todo.length; i += 10) {
          const part = todo.slice(i, i + 10);
          const why = await Promise.all(part.map((t) => o.simulate!(o.build(t))));
          part.forEach((t, j) => { if (why[j]) set((s) => ({ ...s, [key(t)]: { state: 'failed', note: `would revert: ${why[j]}` } })); else keep.push(t); });
        }
        todo = keep;
      }
      let prefix = o.prefix;
      for (let i = 0; i < todo.length;) {
        const room = Math.max(1, o.size - prefix.length);
        const chunk = todo.slice(i, i + room);
        i += room;
        if (stopRef.current) { mark(chunk, { state: 'skipped', note: 'stopped' }); continue; }
        mark(chunk, { state: 'pending', note: `confirm batch of ${chunk.length + prefix.length} in wallet…` });
        const calls = [...prefix, ...chunk.map(o.build)];
        try {
          const id = await sendBatch(o.signer, o.from, o.chainId, calls);
          mark(chunk, { state: 'pending', note: 'batch submitted, waiting…' });
          const res = await waitForBatch(o.signer, id);
          const perCall = res.receipts.length === calls.length; // one receipt per call (non-atomic) vs one for all
          const okItems: T[] = [];
          const next: Record<string, RowRun> = {};
          chunk.forEach((t, j) => {
            const r = perCall ? res.receipts[prefix.length + j] : res.receipts[0];
            const good = perCall ? !!r?.status : res.ok;
            if (good) okItems.push(t);
            next[key(t)] = { state: good ? 'done' : 'failed', hash: r?.transactionHash, note: good ? undefined : res.message };
          });
          const notes = o.afterChunk?.(okItems, res.receipts.filter((r) => r.status)) || {};
          Object.entries(notes).forEach(([k, v]) => { if (next[k]) next[k].note = v; });
          set((s) => ({ ...s, ...next }));
          if (res.ok || (perCall && prefix.every((_, k) => res.receipts[k].status))) prefix = [];
        } catch (e: any) {
          mark(chunk, { state: 'failed', note: decodeLinkError(e) });
        }
      }
    } finally {
      setRunning(false);
    }
  }, []);

  return { running, run, runBatch, stop: () => { stopRef.current = true; } };
}

function CsvButtons({ onText, template, templateName }: { onText: (t: string) => void; template: string; templateName: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const cls = 'flex items-center gap-1 text-xs text-accent hover:underline';
  return (
    <div className="flex items-center gap-4">
      <button type="button" className={cls} onClick={() => {
        const url = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8;' }));
        const a = document.createElement('a'); a.href = url; a.download = templateName; a.click(); URL.revokeObjectURL(url);
      }}><Download className="w-3.5 h-3.5" /> Template CSV</button>
      <button type="button" className={cls} onClick={() => ref.current?.click()}><Upload className="w-3.5 h-3.5" /> Upload CSV</button>
      <input ref={ref} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        const r = new FileReader(); r.onload = () => onText(String(r.result || '')); r.readAsText(f);
      }} />
    </div>
  );
}

/** ERC20 allowance to Trader vs what the batch needs, with an approve button. Native coin needs none. */
function AllowanceRow({ token, need, decimals, symbol, trader, batched }: { token: string; need: ethers.BigNumber; decimals: number; symbol: string; trader: string; batched?: boolean }) {
  const { provider, signer, address } = useWeb3();
  const [bal, setBal] = useState<ethers.BigNumber | null>(null);
  const [allow, setAllow] = useState<ethers.BigNumber | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const native = isNative(token);

  const refresh = useCallback(async () => {
    if (!provider || !address) return;
    try {
      if (native) { setBal(await provider.getBalance(address)); setAllow(null); return; }
      const c = new ethers.Contract(token, ERC20_ABI, provider);
      const [b, a] = await Promise.all([c.balanceOf(address), c.allowance(address, trader)]);
      setBal(b); setAllow(a);
    } catch (e: any) { setErr(decodeLinkError(e)); }
  }, [provider, address, token, trader, native]);
  useEffect(() => { refresh(); }, [refresh]);

  const approve = async () => {
    if (!signer) return;
    setBusy(true); setErr('');
    try {
      await send(new ethers.Contract(token, ERC20_ABI, signer), 'approve', [trader, need]);
      await refresh();
    } catch (e: any) { setErr(decodeLinkError(e)); } finally { setBusy(false); }
  };

  const enoughBal = bal ? bal.gte(need) : true;
  const enoughAllow = native || (allow ? allow.gte(need) : false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm bg-surface-tertiary/50 rounded-lg px-3 py-2">
      <span className="font-semibold">{symbol}</span>
      <span>needs <span className="font-mono">{fmt(need, decimals)}</span></span>
      <span className={enoughBal ? 'text-txt-secondary' : 'text-red-300'}>balance {bal ? fmt(bal, decimals) : '…'}</span>
      {native ? <Badge tone="muted">sent as tx value — no approval</Badge> : (
        <>
          <span className={enoughAllow ? 'text-green-300' : 'text-yellow-300'}>allowance to Trader {allow ? fmt(allow, decimals) : '…'}</span>
          {!enoughAllow && batched && <Badge tone="muted">approval is added to the first batch</Badge>}
          {!enoughAllow && !batched && <button className={btnSecondaryCls} disabled={busy || !signer || need.isZero()} onClick={approve}>{busy ? 'Approving…' : `Approve ${fmt(need, decimals)} ${symbol}`}</button>}
        </>
      )}
      <button className="text-xs text-accent hover:underline ml-auto" onClick={refresh}>refresh</button>
      {err && <span className="w-full text-xs text-red-300">{err}</span>}
    </div>
  );
}

// ─── Bulk Connect: Factory.createLink ────────────────────────────────────────

interface ConnectRow { line: number; userB: string; total: string; percent: string; lockDays: string }
interface ConnectCheck { row: ConnectRow; ok: boolean; why: string; totalWei: ethers.BigNumber; amountA: ethers.BigNumber; percent: number; days: number; auto: boolean }

function ConnectTab({ net, minLock, maxLock, active, batch, onDone }: { net: { factory: string; trader: string }; minLock: number; maxLock: number; active: boolean; batch: BatchMode; onDone?: () => void }) {
  const { provider, signer, address, netChainId } = useWeb3();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [symbol, setSymbol] = useState('LUCA');
  const [defPercent, setDefPercent] = useState('50');
  const [defDays, setDefDays] = useState('30');
  const [text, setText] = useState('');
  const [runs, setRuns] = useState<Record<string, RowRun>>({});
  const [created, setCreated] = useState<Record<string, string>>({});
  const { running, run, runBatch, stop } = useRunner();

  useEffect(() => {
    if (!provider) return;
    const f = new ethers.Contract(net.factory, FACTORY_ABI, provider);
    (async () => {
      const out: TokenInfo[] = [];
      for (const s of KNOWN_SYMBOLS) {
        try {
          const t = await f.tokenMap(s);
          if (!t.isActive) continue;
          const decimals = isNative(t.addr) ? 18 : await new ethers.Contract(t.addr, ERC20_ABI, provider).decimals();
          out.push({ symbol: s, addr: t.addr, minAmount: t.minAmount, decimals: Number(decimals) });
        } catch { /* skip */ }
      }
      setTokens(out);
      if (out.length && !out.some((t) => t.symbol === symbol)) setSymbol(out[0].symbol);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, net.factory]);

  const token = tokens.find((t) => t.symbol === symbol);

  const rows: ConnectRow[] = useMemo(() => text.split(/\r\n|\r|\n/).map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l }) => l && !l.startsWith('#'))
    .map(({ l, i }) => {
      const [userB = '', total = '', percent = '', lockDays = ''] = l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      return { line: i + 1, userB, total, percent, lockDays };
    })
    .filter((r) => /^0x/i.test(r.userB) || r.total), [text]); // drops a header line

  const checks: ConnectCheck[] = useMemo(() => rows.map((row) => {
    const bad = (why: string): ConnectCheck => ({ row, ok: false, why, totalWei: ethers.constants.Zero, amountA: ethers.constants.Zero, percent: 0, days: 0, auto: false });
    if (!token) return bad('pick a token');
    if (!ethers.utils.isAddress(row.userB)) return bad('bad userB address');
    if (same(row.userB, address)) return bad('userB is your own wallet');
    const percent = Number(row.percent || defPercent);
    const days = Number(row.lockDays || defDays);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return bad('percentA must be 1–100');
    if (!Number.isInteger(days) || days < minLock || days > maxLock) return bad(`lockDays must be ${minLock}–${maxLock}`);
    let totalWei: ethers.BigNumber;
    try { totalWei = ethers.utils.parseUnits(row.total, token.decimals); } catch { return bad('bad amount'); }
    if (totalWei.lt(token.minAmount) || totalWei.isZero()) return bad(`amount below min ${fmt(token.minAmount, token.decimals)}`);
    return { row, ok: true, why: '', totalWei, amountA: totalWei.mul(percent).div(100), percent, days, auto: percent === 100 };
  }), [rows, token, address, defPercent, defDays, minLock, maxLock]);

  const valid = checks.filter((c) => c.ok);
  const need = valid.reduce((s, c) => s.add(c.amountA), ethers.constants.Zero);
  const key = (c: ConnectCheck) => `L${c.row.line}`;

  // New links land in the index on the next sync; trigger one right after the run.
  const execute = async () => {
    const todo = valid.filter((c) => runs[key(c)]?.state !== 'done');
    const pay = token ? `${fmt(todo.reduce((t, c) => t.add(c.amountA), ethers.constants.Zero), token.decimals)} ${symbol}` : '';
    if (!confirm(`Create ${todo.length} link${todo.length === 1 ? '' : 's'} (createLink) from ${short(address)} on ${NETWORKS[netChainId]?.chainName || netChainId}?\n\nYou deposit: ${pay}\nAuto-connected (percentA 100): ${todo.filter((c) => c.auto).length}`)) return;
    await executeRows(); onDone?.();
  };
  const executeRows = async () => {
    if (!signer || !token || !provider) return;
    const f = new ethers.Contract(net.factory, FACTORY_ABI, signer);
    const todo = valid.filter((c) => runs[key(c)]?.state !== 'done');
    if (batch.on) {
      const native = isNative(token.addr);
      const left = todo.reduce((s, c) => s.add(c.amountA), ethers.constants.Zero);
      let prefix: BatchCall[] = [];
      try { prefix = await approvalCalls(provider, address, net.trader, [{ token: token.addr, need: left }]); } catch (e: any) { return setRuns((s) => ({ ...s, _: { state: 'failed', note: decodeLinkError(e) } })); }
      return runBatch({
        items: todo, key, prefix, size: batch.size, signer, from: address, chainId: netChainId,
        build: (c) => ({ to: net.factory, data: factoryIface.encodeFunctionData('createLink', [ethers.utils.getAddress(c.row.userB), symbol, c.totalWei, c.percent, c.days]), value: native ? c.amountA : undefined }),
        simulate: simulateAs(provider, address),
        // Each successful createLink emits exactly one LinkCreated, in call order.
        afterChunk: (ok, receipts) => {
          const links: string[] = [];
          receipts.forEach((r) => r.logs.forEach((log) => {
            if (!same(log.address, net.factory)) return;
            try { const p = factoryIface.parseLog(log); if (p.name === 'LinkCreated') links.push(p.args[2]); } catch { /* not ours */ }
          }));
          const notes: Record<string, string> = {};
          const made: Record<string, string> = {};
          ok.forEach((c, i) => { if (links[i]) { made[key(c)] = links[i]; notes[key(c)] = `link ${short(links[i])}`; } });
          setCreated((s) => ({ ...s, ...made }));
          return notes;
        },
        set: setRuns,
      });
    }
    return run(todo, key, async (c) => {
      const { tx, receipt } = await send(f, 'createLink', [ethers.utils.getAddress(c.row.userB), symbol, c.totalWei, c.percent, c.days], isNative(token.addr) ? c.amountA : undefined);
      let link = '';
      for (const log of receipt.logs) {
        try { const p = f.interface.parseLog(log); if (p.name === 'LinkCreated') link = p.args[2]; } catch { /* other contract's log */ }
      }
      if (link) setCreated((s) => ({ ...s, [key(c)]: link }));
      return { hash: tx.hash, note: link ? `link ${short(link)}` : undefined };
    }, setRuns);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-txt-secondary">
        You are <b>userA</b>. Each row calls <code>Factory.createLink</code> and locks your share (<i>amount × percentA / 100</i>) into a new Link.
        The other wallet then accepts it on the <b>Approve</b> tab — except at percentA = 100, which connects immediately.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs text-txt-secondary space-y-1">Token
          <select className={inputCls} value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={running}>
            {tokens.length === 0 && <option>loading…</option>}
            {tokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol} (min {fmt(t.minAmount, t.decimals)})</option>)}
          </select>
        </label>
        <label className="text-xs text-txt-secondary space-y-1">Default percentA (your share, %)
          <input className={inputCls} value={defPercent} onChange={(e) => setDefPercent(e.target.value)} disabled={running} />
        </label>
        <label className="text-xs text-txt-secondary space-y-1">Default lock days ({minLock}–{maxLock})
          <input className={inputCls} value={defDays} onChange={(e) => setDefDays(e.target.value)} disabled={running} />
        </label>
      </div>

      <div className="space-y-2">
        <CsvButtons onText={setText} templateName="link-bulk-connect.csv"
          template={'userB,amount,percentA,lockDays\n0x1234567890123456789012345678901234567890,200,50,30\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd,100,,\n'} />
        <textarea className={`${inputCls} h-36`} value={text} onChange={(e) => setText(e.target.value)} disabled={running}
          placeholder={'userB, amount[, percentA][, lockDays]  — one per line; blank columns use the defaults\n0x1234…7890, 200, 50, 30'} />
      </div>

      {token && valid.length > 0 && <AllowanceRow token={token.addr} need={need} decimals={token.decimals} symbol={symbol} trader={net.trader} batched={batch.on} />}
      {!active && <p className="text-sm text-red-300">File.active() is false — the Factory is in emergency shutdown and createLink will revert.</p>}

      {checks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-txt-secondary text-left"><tr>
              <th className="py-1 pr-2">Line</th><th className="pr-2">userB</th><th className="pr-2">Total</th><th className="pr-2">%A</th><th className="pr-2">Days</th><th className="pr-2">You pay</th><th className="pr-2">Check</th><th>Result</th>
            </tr></thead>
            <tbody>
              {checks.map((c) => (
                <tr key={key(c)} className="border-t border-white/5">
                  <td className="py-1 pr-2">{c.row.line}</td>
                  <td className="pr-2 font-mono">{ethers.utils.isAddress(c.row.userB) ? short(c.row.userB) : c.row.userB || '—'}</td>
                  <td className="pr-2">{c.row.total}</td>
                  <td className="pr-2">{c.ok ? c.percent : c.row.percent || defPercent}</td>
                  <td className="pr-2">{c.ok ? c.days : c.row.lockDays || defDays}</td>
                  <td className="pr-2">{c.ok && token ? fmt(c.amountA, token.decimals) : '—'}</td>
                  <td className="pr-2">{c.ok ? <Badge tone="good">{c.auto ? 'ok · auto-connects' : 'ok'}</Badge> : <span className="text-red-300">{c.why}</span>}</td>
                  <td>
                    <RunCell r={runs[key(c)]} chainId={netChainId} />
                    {created[key(c)] && <a className="text-accent font-mono" target="_blank" rel="noopener noreferrer" href={getExplorerAddressUrl(netChainId, created[key(c)])}>{short(created[key(c)])}</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={running || !signer || !valid.length || !active} onClick={execute}>
          <span className="flex items-center gap-2"><Link2 className="w-4 h-4" /> Connect {valid.length} link{valid.length === 1 ? '' : 's'}</span>
        </button>
        {running && <button className={btnDangerCls} onClick={stop}><span className="flex items-center gap-2"><Square className="w-3.5 h-3.5" /> Stop after current</span></button>}
        {Object.keys(created).length > 0 && (
          <button className={btnSecondaryCls} onClick={() => downloadCsv('created-links.csv', [['line', 'userB', 'link', 'tx'], ...checks.filter((c) => created[key(c)]).map((c) => [c.row.line, c.row.userB, created[key(c)], runs[key(c)]?.hash || ''])])}>
            Download created links
          </button>
        )}
        <Progress runs={runs} total={valid.length} />
      </div>
      <BatchNote batch={batch} />
    </div>
  );
}

// ─── Bulk Approve (Link.agree) / Bulk Disconnect (Link.close) ────────────────

type Mode = 'approve' | 'disconnect' | 'accept';
// kind (accept mode): which incoming request this row answers — connect → agree(), disconnect → close()
// kind (accept mode): what this row does — connect → agree(), reject → reject(), cancel / disconnect → close()
type RowKind = 'connect' | 'disconnect' | 'reject' | 'cancel';
interface Loaded { address: string; link: LinkState; ok: boolean; why: string; effect?: string; kind?: RowKind; from?: string }
// Bulk Accept action chips — each says the exact call it sends. Accept/reject act on the same rows (incoming connect requests).
const KIND_LABEL: Record<RowKind, string> = { connect: 'Accept connect requests', reject: 'Reject connect requests', disconnect: 'Agree to disconnect', cancel: 'Cancel my requests' };
const KIND_CALL: Record<RowKind, string> = { connect: 'agree()', reject: 'reject()', disconnect: 'close()', cancel: 'close()' };
const KIND_ROW: Record<RowKind, string> = { connect: 'Accept connect', reject: 'Reject connect', disconnect: 'Agree disconnect', cancel: 'Cancel my request' };
const KIND_ORDER: RowKind[] = ['connect', 'reject', 'disconnect', 'cancel'];
const KIND_NOTE: Record<RowKind, string> = { connect: 'connected', disconnect: 'closed', reject: 'rejected', cancel: 'cancelled' };

/** Share returned on an early mutual close, as Link._liquidation computes it right now (85–99%). */
function earlyReturnPct(r: { startTime: number; lockDays: number }, nowSec = Date.now() / 1000) {
  if (!r.lockDays) return 100;
  const day = Math.floor(Math.max(0, nowSec - r.startTime) / 86400);
  const dayFactor = Math.floor(Math.max(0, r.lockDays - day) * 10000 / r.lockDays);
  return dayFactor <= 100 ? 99 : dayFactor >= 1500 ? 85 : Math.floor((10000 - dayFactor) / 100);
}

// Rows come from the on-chain index (your links as userA/userB), kept fresh by its auto-sync.
// Pasted addresses are added to the index (validated with Factory.isLink), not loaded one-off.
function LinkListTab({ mode, net, batch, index }: { mode: Mode; net: { factory: string; trader: string }; batch: BatchMode; index: LinkIndex }) {
  const { provider, signer, address, netChainId } = useWeb3();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [onlyActionable, setOnlyActionable] = useState(true);
  // accept mode: answer incoming requests 'yes' (accept) or close/reject everything pending

  // Filters: request types switched off (accept mode) and a counterparty / link / token search (all modes).
  // Bulk Accept: action chips that are on. Default = say yes to what's waiting on you; reject/cancel are opt-in.
  const [kindOn, setKindOn] = useState<Set<RowKind>>(new Set<RowKind>(['connect', 'disconnect']));
  const toggleKind = (k: RowKind) => setKindOn((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else { n.add(k); if (k === 'connect') n.delete('reject'); if (k === 'reject') n.delete('connect'); } // same rows: one or the other
    return n;
  });
  const [search, setSearch] = useState('');
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [runs, setRuns] = useState<Record<string, RowRun>>({});
  const [note, setNote] = useState('');
  const { running, run, runBatch, stop } = useRunner();

  useEffect(() => { setDeselected(new Set()); setRuns({}); }, [address, netChainId]);

  const loaded: Loaded[] = useMemo(() => {
    const me = address.toLowerCase();
    if (mode === 'accept') {
      // Connections → Pending items this wallet can act on, each tagged with the action its chip sends.
      const connectKind: RowKind = kindOn.has('reject') ? 'reject' : 'connect';
      return index.mine
        .map((r) => ({ r, v: connectionView(r, address) }))
        .filter(({ v }) => v.state === 'pendingIncoming' || v.state === 'pendingOutgoing' || v.state === 'cancellationRequestIncoming')
        .sort((a, b) => b.r.lastActivityBlock - a.r.lastActivityBlock)
        .map(({ r, v }): Loaded => {
          const link = toLinkState(r);
          const base = { address: r.address, link, from: v.counterparty };
          if (v.state === 'pendingIncoming') {
            if (connectKind === 'reject') return { ...base, ok: true, why: '', kind: 'reject', effect: `refunds ${short(v.counterparty)}` };
            const c = approveCheck(link, address);
            return { ...base, ok: c.ok, why: c.why, kind: 'connect', effect: 'you deposit your share' };
          }
          if (v.state === 'pendingOutgoing') return { ...base, ok: true, why: '', kind: 'cancel', effect: 'refunds you' };
          const c = disconnectCheck(link, address);
          return { ...base, ok: c.ok, why: c.why, kind: 'disconnect', effect: c.ok ? `closes now · ~${earlyReturnPct(r)}% returned` : undefined };
        });
    }
    return index.mine
      .filter((r) => mode === 'approve' ? r.userB.toLowerCase() === me : r.status !== LinkStatus.CLOSED)
      .sort((a, b) => b.lastActivityBlock - a.lastActivityBlock || b.createdBlock - a.createdBlock)
      .map((r) => {
        const link = toLinkState(r);
        if (mode === 'approve') { const c = approveCheck(link, address); return { address: r.address, link, ok: c.ok, why: c.why }; }
        const c = disconnectCheck(link, address); return { address: r.address, link, ok: c.ok, why: c.why, effect: c.effect };
      });
  }, [index.mine, mode, address, kindOn]);

  // decimals for every token in the list (native = 18)
  const tokenKey = Array.from(new Set(loaded.map((l) => l.link.token.toLowerCase()))).sort().join(',');
  useEffect(() => {
    if (!provider || !tokenKey) return;
    (async () => {
      const dec: Record<string, number> = {};
      await Promise.all(tokenKey.split(',').map(async (t) => {
        dec[t] = t === ZERO ? 18 : Number(await new ethers.Contract(t, ERC20_ABI, provider).decimals().catch(() => 18));
      }));
      setDecimals(dec);
    })();
  }, [provider, tokenKey]);

  const q = search.trim().toLowerCase();
  const passes = (l: Loaded) => (!l.kind || kindOn.has(l.kind)) && (!q || l.address.toLowerCase().includes(q)
    || l.link.userA.toLowerCase().includes(q) || l.link.userB.toLowerCase().includes(q) || l.link.symbol.toLowerCase() === q);
  // Only rows that pass the filters are shown AND sent — what you see is what runs.
  const shown = (onlyActionable || mode === 'accept' ? loaded.filter((l) => l.ok || runs[l.address]) : loaded).filter(passes);
  const eligible = loaded.filter((l) => l.ok && passes(l));
  const pager = usePager(shown, `${mode}|${q}|${Array.from(kindOn).join(',')}|${onlyActionable}|${address}|${netChainId}`);
  const chosen = eligible.filter((l) => !deselected.has(l.address) && runs[l.address]?.state !== 'done');
  const dOf = (t: string) => decimals[t.toLowerCase()] ?? 18;

  // approve: sum of amountB per token (what you deposit)
  const needs = useMemo(() => {
    if (mode === 'disconnect') return [];
    const m = new Map<string, { token: string; symbol: string; need: ethers.BigNumber }>();
    for (const l of chosen) {
      if (mode === 'accept' && l.kind !== 'connect') continue; // only accepting a connection deposits
      const k = l.link.token.toLowerCase();
      const cur = m.get(k) || { token: l.link.token, symbol: l.link.symbol, need: ethers.constants.Zero };
      cur.need = cur.need.add(l.link.amountB);
      m.set(k, cur);
    }
    return Array.from(m.values());
  }, [chosen, mode]);

  const addManual = async () => {
    const { addresses, bad } = parseAddressList(text);
    if (!addresses.length) return setNote(bad.length ? `No valid addresses (${bad.length} invalid).` : 'No addresses found.');
    setAdding(true); setNote('');
    try {
      const r = await index.track(addresses);
      setNote(`Added/refreshed ${r.added} link(s).${r.rejected.length ? ` ${r.rejected.length} rejected (not a Link from this Factory): ${r.rejected.slice(0, 3).map(short).join(', ')}${r.rejected.length > 3 ? '…' : ''}` : ''}${bad.length ? ` ${bad.length} invalid ignored.` : ''}`);
      setText('');
    } catch (e: any) { setNote(decodeLinkError(e)); } finally { setAdding(false); }
  };

  // Plain-language list of the calls a run will send, shown above the button and in the confirm dialog.
  const plan = useMemo(() => {
    const call = (l: Loaded) => l.kind === 'reject' ? 'reject()' : (mode === 'approve' || l.kind === 'connect') ? 'agree()' : 'close()';
    const what = (l: Loaded) => l.kind ? KIND_ROW[l.kind].toLowerCase() : mode === 'approve' ? 'accept connection' : (l.effect || 'close');
    const groups = new Map<string, number>();
    chosen.forEach((l) => { const k = `${call(l)} — ${what(l)}`; groups.set(k, (groups.get(k) || 0) + 1); });
    const parts = Array.from(groups.entries()).map(([k, n]) => `${n} × ${k}`);
    const deposit = needs.filter((n) => !n.need.isZero()).map((n) => `${fmt(n.need, dOf(n.token))} ${n.symbol}`).join(' + ');
    return { parts, deposit };
  }, [chosen, needs, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const execute = async () => {
    if (!signer || !provider) return;
    const items = chosen;
    const msg = `Send ${items.length} transaction${items.length === 1 ? '' : 's'} from ${short(address)} on ${NETWORKS[netChainId]?.chainName || netChainId}?\n\n${plan.parts.join('\n')}${plan.deposit ? `\n\nYou deposit: ${plan.deposit}` : ''}`;
    if (!confirm(msg)) return;
    if (batch.on) {
      let prefix: BatchCall[] = [];
      if (mode !== 'disconnect') {
        try { prefix = await approvalCalls(provider, address, net.trader, needs); } catch (e: any) { setNote(decodeLinkError(e)); return; }
      }
      await runBatch({
        items, key: (l) => l.address, prefix, size: batch.size, signer, from: address, chainId: netChainId,
        build: (l) => l.kind === 'reject'
          ? { to: l.address, data: linkIface.encodeFunctionData('reject') }
          : (mode === 'approve' || l.kind === 'connect')
          ? { to: l.address, data: linkIface.encodeFunctionData('agree'), value: isNative(l.link.token) ? l.link.amountB : undefined }
          : { to: l.address, data: linkIface.encodeFunctionData('close') },
        simulate: simulateAs(provider, address),
        afterChunk: (ok) => Object.fromEntries(ok.map((l) => [l.address, l.kind ? KIND_NOTE[l.kind] : mode === 'approve' ? 'connected' : l.effect?.startsWith('sends') ? 'close requested' : 'closed'])),
        set: setRuns,
      });
    } else {
      await run(items, (l) => l.address, async (l) => {
        const c = new ethers.Contract(l.address, LINK_ABI, signer);
        if (l.kind === 'reject') {
          const { tx } = await send(c, 'reject', []);
          return { hash: tx.hash, note: KIND_NOTE.reject };
        }
        if (mode === 'approve' || l.kind === 'connect') {
          const { tx } = await send(c, 'agree', [], isNative(l.link.token) ? l.link.amountB : undefined);
          return { hash: tx.hash, note: 'connected' };
        }
        const { tx } = await send(c, 'close', []);
        return { hash: tx.hash, note: l.kind ? KIND_NOTE[l.kind] : l.effect?.startsWith('sends') ? 'close requested' : 'closed' };
      }, setRuns);
    }
    // Re-read the links we just touched so their new status shows straight away.
    index.track(items.map((l) => l.address)).catch(() => {});
  };

  const toggle = (a: string) => setDeselected((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; });
  const allOn = eligible.length > 0 && eligible.every((l) => !deselected.has(l.address));

  return (
    <div className="space-y-4">
      <p className="text-sm text-txt-secondary">
        {mode === 'accept'
          ? <>Everything in <b>Connections → Pending</b> you can act on. Pick the actions with the chips — each sends one call per link: accept a connect request (<code>agree()</code>, deposits your share) <i>or</i> reject it (<code>reject()</code>, refunds the creator); agree to a disconnect (<code>close()</code>, ends the link now — before expiry the contract keeps a 1–15% fee); cancel your own unaccepted requests (<code>close()</code>, refunds you).</>
          : mode === 'approve'
          ? <>You are <b>userB</b>. Each selected link calls <code>Link.agree()</code> and deposits your share (amountB). Listed: every indexed link where your wallet is userB.</>
          : <>You are <b>userA or userB</b>. Each selected link calls <code>Link.close()</code>. A connected, unexpired link only closes once <b>both</b> sides call close — the first call records a request. Pledged links must be depledged first.</>}
      </p>

      {index.meta === null && <p className="text-sm text-yellow-300">Build the link index above first — the list comes from it.</p>}
      {!address && <p className="text-xs text-yellow-300">Connect a wallet — the list is the links of the connected wallet.</p>}

      <div className="flex flex-wrap items-center gap-4 text-xs">
        {mode === 'accept' ? (
          <div className="flex flex-wrap items-center gap-2">
            {KIND_ORDER.map((k) => {
              const group = (l: Loaded) => (k === 'connect' || k === 'reject') ? (l.kind === 'connect' || l.kind === 'reject') : l.kind === k;
              const n = loaded.filter(group).length;
              if (!n) return null;
              const on = kindOn.has(k);
              const danger = k !== 'connect';
              return (
                <button key={k} disabled={running} onClick={() => toggleKind(k)}
                  className={`px-2.5 py-1 rounded-full border text-xs ${on ? (danger ? 'border-red-400 text-red-200 bg-red-500/10' : 'border-accent text-accent bg-accent/10') : 'border-white/15 text-txt-secondary'}`}>
                  {on ? '✓ ' : ''}{KIND_LABEL[k]} ({n}) <span className="opacity-60 font-mono">{KIND_CALL[k]}</span>
                </button>
              );
            })}
            {!loaded.length && <span className="text-txt-secondary">nothing pending</span>}
          </div>
        ) : (
        <label className="flex items-center gap-2 text-txt-secondary"><input type="checkbox" checked={onlyActionable} onChange={(e) => setOnlyActionable(e.target.checked)} /> only links you can {mode === 'approve' ? 'approve' : 'disconnect'} now</label>
        )}
        {mode !== 'accept' && <span className="text-txt-secondary">{eligible.length} actionable of {loaded.length}</span>}
        <input className={`${inputCls} w-64 py-1 ml-auto`} placeholder="filter: counterparty / link / token" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {needs.map((n) => <AllowanceRow key={n.token} token={n.token} need={n.need} decimals={dOf(n.token)} symbol={n.symbol} trader={net.trader} batched={batch.on} />)}

      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-txt-secondary">{chosen.length} selected{eligible.length ? ` of ${eligible.length}` : ''} (all pages)</span>
          <Pager p={pager} label="links" />
        </div>
      )}
      {shown.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-txt-secondary text-left sticky top-0 bg-surface-secondary"><tr>
              <th className="py-1 pr-2"><input type="checkbox" disabled={running || !eligible.length} checked={allOn}
                onChange={(e) => setDeselected(e.target.checked ? new Set() : new Set(eligible.map((l) => l.address)))} /></th>
              {mode === 'accept' && <th className="pr-2">Request</th>}
              <th className="pr-2">Link</th><th className="pr-2">Token</th><th className="pr-2">userA</th><th className="pr-2">userB</th>
              <th className="pr-2">{mode === 'approve' ? 'You deposit' : mode === 'accept' ? 'You deposit / your amount' : 'Amounts A / B'}</th><th className="pr-2">Status</th><th className="pr-2">Check</th><th>Result</th>
            </tr></thead>
            <tbody>
              {pager.rows.map((l) => {
                const k = l.link;
                const d = dOf(k.token);
                return (
                  <tr key={l.address} className="border-t border-white/5">
                    <td className="py-1 pr-2"><input type="checkbox" disabled={!l.ok || running} checked={l.ok && !deselected.has(l.address)} onChange={() => toggle(l.address)} /></td>
                    {mode === 'accept' && (
                      <td className="pr-2 whitespace-nowrap">
                        {l.kind && <Badge tone={l.kind === 'connect' ? 'good' : l.kind === 'cancel' ? 'muted' : 'bad'}>{KIND_ROW[l.kind]}</Badge>}
                      </td>
                    )}
                    <td className="pr-2 font-mono"><a className="text-accent" target="_blank" rel="noopener noreferrer" href={getExplorerAddressUrl(netChainId, l.address)}>{short(l.address)}</a></td>
                    <td className="pr-2">{k.symbol}</td>
                    <td className={`pr-2 font-mono ${same(k.userA, address) ? 'text-accent' : ''}`}>{short(k.userA)}</td>
                    <td className={`pr-2 font-mono ${same(k.userB, address) ? 'text-accent' : ''}`}>{k.userB === ZERO ? 'open' : short(k.userB)}</td>
                    <td className="pr-2">{mode === 'approve' || l.kind === 'connect' ? `deposit ${fmt(k.amountB, d)}` : mode === 'accept' ? fmt(same(k.userA, address) ? k.amountA : k.amountB, d) : `${fmt(k.amountA, d)} / ${fmt(k.amountB, d)}`}</td>
                    <td className="pr-2">
                      {LINK_STATUS_LABELS[k.status]}{k.expired && k.status !== LinkStatus.CLOSED ? ' · expired' : ''}
                      {k.status === LinkStatus.AGREED && (k.closeReqA || k.closeReqB) && <span className="text-yellow-300"> · close req by {k.closeReqA ? 'A' : ''}{k.closeReqA && k.closeReqB ? '+' : ''}{k.closeReqB ? 'B' : ''}</span>}
                    </td>
                    <td className="pr-2">{l.ok ? <Badge tone="good">{l.effect || 'ok'}</Badge> : <span className="text-txt-secondary">{l.why}</span>}</td>
                    <td><RunCell r={runs[l.address]} chainId={netChainId} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2"><Pager p={pager} label="links" /></div>
        </div>
      ) : index.meta && address ? (
        <p className="text-xs text-txt-secondary">{index.syncing ? 'Index is syncing — links appear as their state is read.' : mode === 'accept' ? 'Nothing is waiting on this wallet — no incoming connect or disconnect requests.' : `No ${onlyActionable ? 'actionable ' : ''}links for this wallet in the index.`}</p>
      ) : null}

      {chosen.length > 0 && (
        <div className="text-xs bg-surface-tertiary/50 rounded-lg px-3 py-2">
          <span className="text-txt-secondary">Will send ({chosen.length} selected{eligible.length !== chosen.length ? ` of ${eligible.length}` : ''}): </span>
          {plan.parts.join(' · ')}
          {plan.deposit && <span className="text-yellow-300"> · you deposit {plan.deposit}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className={mode === 'disconnect' || (mode === 'accept' && chosen.some((l) => l.kind !== 'connect')) ? btnDangerCls : btnCls} disabled={running || !signer || !chosen.length} onClick={execute}>
          <span className="flex items-center gap-2">
            {mode === 'disconnect' ? <Link2Off className="w-4 h-4" /> : <CheckCheck className="w-4 h-4" />}
            {mode === 'accept' ? `Send ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}` : <>{mode === 'approve' ? 'Approve' : 'Disconnect'} {chosen.length} link{chosen.length === 1 ? '' : 's'}</>}
          </span>
        </button>
        {running && <button className={btnDangerCls} onClick={stop}><span className="flex items-center gap-2"><Square className="w-3.5 h-3.5" /> Stop after current</span></button>}
        {Object.keys(runs).length > 0 && !running && (
          <button className={btnSecondaryCls} onClick={() => downloadCsv(`link-${mode}-results.csv`, [['link', 'result', 'tx', 'note'], ...Object.entries(runs).map(([a, r]) => [a, r.state, r.hash || '', r.note || ''])])}>
            Download results
          </button>
        )}
        <Progress runs={runs} total={chosen.length + Object.values(runs).filter((r) => r.state === 'done').length} />
      </div>
      <BatchNote batch={batch} />

      <details className="text-xs">
        <summary className="cursor-pointer text-txt-secondary">Add link addresses manually (e.g. links older than the index start that haven&apos;t had activity since)</summary>
        <div className="mt-2 space-y-2">
          <CsvButtons onText={setText} templateName={`link-addresses.csv`} template={'link\n0x1234567890123456789012345678901234567890\n'} />
          <textarea className={`${inputCls} h-24`} value={text} onChange={(e) => setText(e.target.value)} disabled={adding}
            placeholder="Link contract addresses — one per line, or comma/space separated" />
          <div className="flex items-center gap-3">
            <button className={btnSecondaryCls} disabled={adding || !provider || !text.trim()} onClick={addManual}>
              <span className="flex items-center gap-2">{adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Add to index</span>
            </button>
          </div>
        </div>
      </details>
      {note && <p className="text-xs text-yellow-300">{note}</p>}
    </div>
  );
}

function BatchNote({ batch }: { batch: BatchMode }) {
  return (
    <p className="text-xs text-txt-secondary">
      {batch.on
        ? <>Batch mode: one wallet confirmation per {batch.size} calls. Every call is pre-checked first and rows that would revert are skipped, so they can&apos;t fail the whole batch. Rows that already succeeded are skipped if you run again.</>
        : <>One wallet confirmation per link. Rows that already succeeded are skipped if you run again.</>}
    </p>
  );
}

function SendModePicker({ support, batch, setBatch, disabled }: { support: BatchSupport | null; batch: BatchMode; setBatch: (b: BatchMode) => void; disabled: boolean }) {
  const can = !!support?.supported;
  const opt = (on: boolean, label: string) => (
    <button disabled={disabled || (on && !can)} onClick={() => setBatch({ ...batch, on })}
      className={`px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-40 ${batch.on === on ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>{label}</button>
  );
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="flex items-center gap-1 text-txt-secondary"><Layers className="w-3.5 h-3.5" /> Send mode</span>
      <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1">{opt(true, 'Batch')}{opt(false, 'One by one')}</div>
      {batch.on && (
        <label className="flex items-center gap-2 text-txt-secondary">calls per batch
          <input className={`${inputCls} w-16 py-1`} type="number" min={1} max={50} value={batch.size} disabled={disabled}
            onChange={(e) => setBatch({ ...batch, size: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} />
        </label>
      )}
      <span className={can ? 'text-green-300' : 'text-txt-secondary'}>
        {support === null ? 'checking wallet…' : can ? `Wallet supports ${support.detail}.` : `${support.detail} — sending one tx per link.`}
      </span>
    </div>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

interface Live { chainId: number; factory: string; trader: string; luca: string; linkTemp: string; active: boolean; minLock: number; maxLock: number; totalLink: string; factoryFile: string }

export default function LinkSection() {
  const { provider, signer, address, netChainId, isConnected, chainId } = useWeb3();
  const [tab, setTab] = useState<'connections' | 'accept' | 'connect' | 'approve' | 'disconnect'>('connections');
  const [support, setSupport] = useState<BatchSupport | null>(null);
  const [batchPref, setBatchPref] = useState<BatchMode>({ on: true, size: 10 });

  useEffect(() => {
    if (!signer || !address) { setSupport({ supported: false, atomic: false, detail: 'no wallet connected' }); return; }
    let live = true;
    setSupport(null);
    getBatchSupport(signer, address, netChainId).then((s) => { if (live) setSupport(s); });
    return () => { live = false; };
  }, [signer, address, netChainId]);
  const batch: BatchMode = { on: batchPref.on && !!support?.supported, size: batchPref.size };
  const [liveRaw, setLive] = useState<Live | null>(null);
  // File reads are per network; ignore a result from the previous network for the render after a switch.
  const live = liveRaw?.chainId === netChainId ? liveRaw : null;
  const [liveErr, setLiveErr] = useState('');
  const defaults = LINK_ADDRESSES[netChainId];
  // Local on-chain index of links (IndexedDB), per chain — hooks run before the early return below.
  const indexCtl = useLinkIndex(netChainId, live?.factory || defaults?.factory, defaults ? provider : null, address);
  const requests = useLinkRequests(netChainId, address, indexCtl.index.records, indexCtl.index.meta, indexCtl.index.syncing);
  const newRequests = requests.newConnect + requests.newDisconnect;

  // "(2) …" in the browser tab title while new requests are waiting, so they're noticed from other tabs.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = newRequests > 0 ? `(${newRequests}) ${base}` : base;
    return () => { document.title = document.title.replace(/^\(\d+\) /, ''); };
  }, [newRequests]);

  const refresh = useCallback(async () => {
    if (!provider || !defaults) return;
    setLiveErr('');
    try {
      const file = new ethers.Contract(defaults.file, FILE_ABI, provider);
      const [factory, trader, luca, linkTemp, active, minLock, maxLock] = await Promise.all([
        file.factory(), file.trader(), file.luca(), file.linkTemp(), file.active(), file.minLockDay(), file.maxLockDay(),
      ]);
      const f = new ethers.Contract(factory, FACTORY_ABI, provider);
      const [totalLink, factoryFile] = await Promise.all([f.totalLink(), f.file()]);
      setLive({ chainId: netChainId, factory, trader, luca, linkTemp, active, minLock: minLock.toNumber(), maxLock: maxLock.toNumber(), totalLink: totalLink.toString(), factoryFile });
    } catch (e: any) { setLiveErr(decodeLinkError(e)); }
  }, [provider, defaults, netChainId]);
  useEffect(() => { setLive(null); refresh(); }, [refresh]);

  if (!defaults) return <Card title="Link"><p className="text-sm text-txt-secondary">Link contracts are configured for BNB Testnet and BSC Mainnet only — switch network.</p></Card>;

  // The File contract is the source of truth; hard-coded values are only the fallback.
  const net = { factory: live?.factory || defaults.factory, trader: live?.trader || defaults.trader };
  const mismatch = live && (!same(live.factory, defaults.factory) || !same(live.trader, defaults.trader) || !same(live.factoryFile, defaults.file));
  const wrongChain = isConnected && chainId && chainId !== netChainId;

  const addrRows: [string, string][] = [
    ['File', defaults.file], ['Factory', net.factory], ['Trader (ERC20 spender)', net.trader],
    ['LUCA', live?.luca || defaults.luca], ['Link template', live?.linkTemp || defaults.linkTemplate],
  ];

  const tabs = [
    { id: 'connections', label: 'Connections', icon: <Layers className="w-4 h-4" /> },
    { id: 'accept', label: 'Bulk Accept', icon: <CheckCheck className="w-4 h-4" /> },
    { id: 'connect', label: 'Bulk Connect', icon: <Link2 className="w-4 h-4" /> },
    { id: 'approve', label: 'Bulk Approve', icon: <CheckCheck className="w-4 h-4" /> },
    { id: 'disconnect', label: 'Bulk Disconnect', icon: <Link2Off className="w-4 h-4" /> },
  ] as const;

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-3">Link — {NETWORKS[netChainId]?.chainName}</span>} icon={<Link2 className="w-5 h-5 text-accent" />}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {addrRows.map(([label, a]) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-txt-secondary">{label}</span>
              <a className="font-mono text-accent hover:underline flex items-center gap-1" target="_blank" rel="noopener noreferrer" href={getExplorerAddressUrl(netChainId, a)}>{short(a)} <ExternalLink className="w-3 h-3" /></a>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2"><span className="text-txt-secondary">Factory status</span>
            <span>{live ? (live.active ? <Badge tone="good">active</Badge> : <Badge tone="bad">shutdown</Badge>) : '…'}</span></div>
          <div className="flex items-center justify-between gap-2"><span className="text-txt-secondary">Lock days / total links</span>
            <span>{live ? `${live.minLock}–${live.maxLock} · ${live.totalLink}` : '…'}</span></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-txt-secondary">Testnet Factory 0x5024…099F · Mainnet Factory 0x8f82…7cdA — switch network in your wallet to change.</span>
          <button className="text-accent hover:underline ml-auto" onClick={refresh}>refresh</button>
        </div>
        {mismatch && <p className="mt-2 text-xs text-yellow-300 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> On-chain File points to different modules than the built-in list — using the on-chain values. Update lib/contracts/link/index.ts.</p>}
        {liveErr && <p className="mt-2 text-xs text-red-300">Could not read File contract: {liveErr}</p>}
        {wrongChain && <p className="mt-2 text-xs text-yellow-300">Wallet is on chain {chainId}; switch to {NETWORKS[netChainId]?.chainName} before sending.</p>}
      </Card>

      <Card><LinkIndexPanel ctl={indexCtl} chainId={netChainId} factory={net.factory} address={address} /></Card>

      <div className="flex gap-1 bg-surface-secondary rounded-xl p-1.5 w-fit">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-tertiary'}`}>
            {t.icon} {t.label}
            {t.id === 'connections' && newRequests > 0 && <span className="rounded-full bg-red-500 text-white px-1.5 text-[10px]">{newRequests} new</span>}
            {t.id === 'accept' && requests.current.length > 0 && <span className={`rounded-full px-1.5 text-[10px] ${newRequests ? 'bg-red-500 text-white' : 'bg-white/10'}`}>{requests.current.length}</span>}
            {t.id === 'approve' && requests.waitingConnect > 0 && <span className={`rounded-full px-1.5 text-[10px] ${requests.newConnect ? 'bg-red-500 text-white' : 'bg-white/10'}`}>{requests.waitingConnect}</span>}
            {t.id === 'disconnect' && requests.waitingDisconnect > 0 && <span className={`rounded-full px-1.5 text-[10px] ${requests.newDisconnect ? 'bg-red-500 text-white' : 'bg-white/10'}`}>{requests.waitingDisconnect}</span>}
          </button>
        ))}
      </div>

      <Card>
        {tab !== 'connections' && <div className="mb-4 pb-3 border-b border-white/5"><SendModePicker support={support} batch={batch} setBatch={setBatchPref} disabled={false} /></div>}
        {tab === 'connections' && <LinkConnections key={`c${netChainId}`} index={indexCtl.index} requests={requests} onGo={setTab} />}
        {/* key=netChainId resets each tab's lists when the network changes */}
        {tab === 'connect' && <ConnectTab key={netChainId} net={net} minLock={live?.minLock ?? 1} maxLock={live?.maxLock ?? 1825} active={live?.active ?? true} batch={batch} onDone={() => indexCtl.index.sync()} />}
        {tab === 'accept' && <LinkListTab key={`x${netChainId}`} mode="accept" net={net} batch={batch} index={indexCtl.index} />}
        {tab === 'approve' && <LinkListTab key={`a${netChainId}`} mode="approve" net={net} batch={batch} index={indexCtl.index} />}
        {tab === 'disconnect' && <LinkListTab key={`d${netChainId}`} mode="disconnect" net={net} batch={batch} index={indexCtl.index} />}
      </Card>
    </div>
  );
}
