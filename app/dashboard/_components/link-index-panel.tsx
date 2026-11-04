'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { Database, RefreshCw, Upload, Download, Trash2, Loader2, CalendarRange } from 'lucide-react';
import { UtcTime } from '@/components/utc-datetime';
import { inputCls, btnCls, btnSecondaryCls, btnDangerCls, Badge } from './voucher-v2/ui';
import { ERC20_ABI, LinkStatus, ZERO, downloadCsv } from '@/lib/contracts/link';
import { ETHERSCAN_API_KEY, NETWORKS } from '@/lib/contracts/config';
import {
  fetchRange, syncIndex, refreshStates, loadMeta, loadRecords, loadActivity, clearIndex, trackLinks, importReportsCache,
  checkEtherscanKey, involves, isExpired, connectionRows, activityRows, CONNECTION_COLUMNS, ACTIVITY_COLUMNS,
  type IndexMeta, type LinkRecord, type SyncProgress,
} from '@/lib/contracts/link/indexer';

const AUTO_MS = 60_000;
const rpcKey = (chainId: number) => `dg_linkLogsRpc:${chainId}`;
const ES_KEY = 'dg_etherscanKey'; // page override of NEXT_PUBLIC_ETHERSCAN_API_KEY (one key serves every chain)

export interface LinkIndex {
  meta: IndexMeta | null | undefined; // undefined = still loading from IndexedDB
  records: LinkRecord[];
  mine: LinkRecord[];
  syncing: boolean;
  progress: SyncProgress | null;
  error: string;
  sync: () => Promise<void>;
  /** Add (or re-read right now) specific link addresses — used after our own txs and for manual adds. */
  track: (addresses: string[]) => Promise<{ added: number; rejected: string[] }>;
}

const read = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } };

/**
 * IndexedDB-backed on-chain link index for the selected network (chainId). Everything — stored
 * links, range, cursor, RPC override — is per chain; switching network in the wallet swaps the
 * whole index and stops any scan running for the old one.
 */
export function useLinkIndex(chainId: number, factory: string | undefined, provider: ethers.providers.Provider | null, address: string) {
  const [meta, setMeta] = useState<IndexMeta | null | undefined>(undefined);
  const [records, setRecords] = useState<LinkRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [auto, setAuto] = useState(true);
  const [customRpc, setCustomRpcState] = useState('');
  const [keyOverride, setKeyOverrideState] = useState('');
  const busy = useRef(false);
  const stopRef = useRef(false);
  const etherscanKey = keyOverride || ETHERSCAN_API_KEY;
  const ctx = useRef({ chainId, factory, provider, address, customRpc, etherscanKey });
  ctx.current = { chainId, factory, provider, address, customRpc, etherscanKey };

  useEffect(() => { setCustomRpcState(read(rpcKey(chainId))); setKeyOverrideState(read(ES_KEY)); }, [chainId]);
  const setCustomRpc = (v: string) => { setCustomRpcState(v); write(rpcKey(chainId), v); };
  const setKeyOverride = (v: string) => { setKeyOverrideState(v); write(ES_KEY, v); };

  const reload = useCallback(async () => {
    const [m, rs] = await Promise.all([loadMeta(chainId), loadRecords(chainId)]);
    if (ctx.current.chainId !== chainId) return; // network switched meanwhile
    setMeta(m ?? null);
    setRecords(rs);
  }, [chainId]);

  /** Runs one index job at a time, bound to the chain it started on. */
  const job = useCallback(async (fn: (c: typeof ctx.current, opts: { onProgress: (p: SyncProgress) => void; shouldStop: () => boolean }) => Promise<unknown>) => {
    const c = ctx.current;
    if (busy.current || !c.provider) return;
    busy.current = true; stopRef.current = false;
    setSyncing(true); setError(''); setWarning('');
    try {
      await fn(c, { onProgress: setProgress, shouldStop: () => stopRef.current || ctx.current.chainId !== c.chainId });
    } catch (e: any) {
      if (ctx.current.chainId === c.chainId) setError(e?.message?.slice(0, 300) || String(e));
    } finally {
      busy.current = false;
      setSyncing(false);
      setProgress(null);
      if (ctx.current.chainId === c.chainId) await reload().catch(() => {});
    }
  }, [reload]);

  const sync = useCallback(() => job(async (c, o) => {
    const r = await syncIndex({ chainId: c.chainId, provider: c.provider!, customRpc: c.customRpc || undefined, etherscanKey: c.etherscanKey || undefined, focus: c.address, ...o });
    if (r.warning) setWarning(r.warning);
  }), [job]);

  // Network change: stop the old chain's job, load this chain's index, catch up if live.
  useEffect(() => {
    stopRef.current = true;
    setMeta(undefined); setRecords([]); setError(''); setWarning('');
    let live = true;
    (async () => {
      try {
        await reload();
        const m = await loadMeta(chainId);
        if (live && m && (m.endBlock === null || (!!m.endTs && m.endTs > Date.now() / 1000))) sync();
      } catch (e: any) { setError(`IndexedDB unavailable: ${e?.message || e}`); setMeta(null); }
    })();
    return () => { live = false; };
  }, [chainId, reload, sync]);

  // Auto-refresh only for a live range (no end date); a fixed past range doesn't grow.
  useEffect(() => {
    if (!auto || !meta || meta.endBlock !== null) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, AUTO_MS);
    return () => clearInterval(id);
  }, [auto, meta, sync]);

  const fetch = (startTs: number, endTs: number | null) => job(async (c, o) => {
    if (!c.factory) throw new Error('Factory address not loaded yet');
    const r = await fetchRange({ chainId: c.chainId, factory: c.factory, provider: c.provider!, customRpc: c.customRpc || undefined, etherscanKey: c.etherscanKey || undefined, focus: c.address, startTs, endTs, ...o });
    if (r.warning) setWarning(r.warning);
  });

  const refreshAll = () => job(async (c, o) => {
    await refreshStates({ chainId: c.chainId, provider: c.provider!, focus: c.address, ...o });
  });

  const track = async (addresses: string[]) => {
    if (!provider || !factory) return { added: 0, rejected: addresses };
    const r = await trackLinks(chainId, factory, provider, addresses);
    await reload();
    return r;
  };

  const importJson = (text: string) => job(async (c, o) => {
    if (!c.factory) throw new Error('Factory address not loaded yet');
    await importReportsCache(c.chainId, c.factory, text);
    const r = await syncIndex({ chainId: c.chainId, provider: c.provider!, customRpc: c.customRpc || undefined, etherscanKey: c.etherscanKey || undefined, focus: c.address, ...o });
    if (r.warning) setWarning(r.warning);
  });

  const clear = async () => {
    stopRef.current = true;
    await clearIndex(chainId);
    await reload();
  };

  const decimalsFor = async (recs: LinkRecord[]) => {
    const tokens = Array.from(new Set(recs.map((r) => r.token.toLowerCase()).filter(Boolean)));
    const out: Record<string, number> = {};
    await Promise.all(tokens.map(async (t) => {
      out[t] = t === ZERO || !provider ? 18 : Number(await new ethers.Contract(t, ERC20_ABI, provider).decimals().catch(() => 18));
    }));
    return out;
  };

  /** cc_connections.csv / cc_activity.csv layout from fetch_connections.py, for this chain's stored range. */
  const exportCsv = async (kind: 'connections' | 'mine' | 'activity') => {
    const [recs, acts] = await Promise.all([loadRecords(chainId), loadActivity(chainId)]);
    const tag = `${chainId === 56 ? 'bsc' : chainId === 97 ? 'bsc-testnet' : chainId}`;
    if (kind === 'activity') return downloadCsv(`cc_activity_${tag}.csv`, [ACTIVITY_COLUMNS, ...activityRows(acts, recs)]);
    if (kind === 'mine') {
      const me = address.toLowerCase();
      const mineRecs = recs.filter((r) => r.known && involves(r, me));
      return downloadCsv(`cc_wallet_${me.slice(2, 10)}_${tag}.csv`, [[...CONNECTION_COLUMNS, 'role'],
        ...connectionRows(mineRecs, acts, await decimalsFor(mineRecs), (r) => [r.userA.toLowerCase() === me ? 'A' : r.userB.toLowerCase() === me ? 'B' : 'creator'])]);
    }
    return downloadCsv(`cc_connections_${tag}.csv`, [CONNECTION_COLUMNS, ...connectionRows(recs, acts, await decimalsFor(recs))]);
  };

  const mine = useMemo(() => (address ? records.filter((r) => r.known && involves(r, address)) : []), [records, address]);

  const index: LinkIndex = { meta, records, mine, syncing, progress, error, sync, track };
  return {
    index, fetch, refreshAll, importJson, clear, exportCsv, auto, setAuto, customRpc, setCustomRpc,
    etherscanKey, keyOverride, setKeyOverride, envKey: !!ETHERSCAN_API_KEY, warning, stop: () => { stopRef.current = true; },
  };
}

const dayInput = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const daysAgoInput = (d: number) => dayInput(Date.now() / 1000 - d * 86400);
const dayTs = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

export function LinkIndexPanel({ ctl, chainId, factory, address }: { ctl: ReturnType<typeof useLinkIndex>; chainId: number; factory: string; address: string }) {
  const { index, fetch, refreshAll, importJson, clear, exportCsv, auto, setAuto, customRpc, setCustomRpc, etherscanKey, keyOverride, setKeyOverride, envKey, warning, stop } = ctl;
  const { meta, records, mine, syncing, progress, error } = index;
  const [start, setStart] = useState(daysAgoInput(30));
  const [end, setEnd] = useState(''); // blank = up to now and keep following new blocks
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const netName = NETWORKS[chainId]?.chainName || `chain ${chainId}`;

  // Show the stored range in the inputs when switching to a network that already has one.
  useEffect(() => {
    if (!meta) return;
    setStart(dayInput(meta.sinceTs));
    setEnd(meta.endTs ? dayInput(meta.endTs - 86400) : '');
  }, [meta?.chainId, meta?.sinceTs, meta?.endTs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Key check per network (a plan can cover one chain and not another).
  useEffect(() => {
    if (!etherscanKey) { setKeyStatus(null); return; }
    let live = true;
    setKeyStatus('checking');
    checkEtherscanKey(etherscanKey, chainId).then((err) => { if (live) setKeyStatus(err ? err : 'ok'); });
    return () => { live = false; };
  }, [etherscanKey, chainId]);

  const me = address.toLowerCase();
  const stats = useMemo(() => {
    const asA = mine.filter((r) => r.userA.toLowerCase() === me);
    const asB = mine.filter((r) => r.userB.toLowerCase() === me);
    return {
      asA: asA.length, asB: asB.length,
      toApprove: asB.filter((r) => r.status === LinkStatus.INITED).length,
      connected: mine.filter((r) => r.status === LinkStatus.AGREED || r.status === LinkStatus.PLEDGED).length,
      expired: mine.filter((r) => r.status !== LinkStatus.CLOSED && isExpired(r)).length,
    };
  }, [mine, me]);
  const stale = records.filter((r) => r.stale).length;
  const factoryMismatch = meta && meta.factory.toLowerCase() !== factory.toLowerCase();
  const live = meta ? meta.endBlock === null : !end;

  const prog = progress?.phase === 'scanning' ? `fetching logs via ${progress.source === 'etherscan' ? 'Etherscan' : 'RPC'} ${Math.round(100 * (progress.scanned || 0) / Math.max(1, progress.total || 1))}% (${(progress.scanned || 0).toLocaleString()} / ${(progress.total || 0).toLocaleString()} blocks)`
    : progress?.phase === 'reading' ? `reading link state ${progress.read}/${progress.toRead}`
    : progress?.phase === 'locating' ? 'finding blocks for the dates…' : syncing ? 'working…' : '';

  const go = () => {
    if (!start) return;
    // End date is inclusive: fetch up to 00:00 UTC of the following day.
    fetch(dayTs(start), end ? dayTs(end) + 86400 : null);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader(); r.onload = () => importJson(String(r.result || '')); r.readAsText(f);
  };

  const sourceBadge = etherscanKey
    ? keyStatus === 'ok' ? <Badge tone="good">Etherscan</Badge> : keyStatus === 'checking' ? <Badge tone="muted">checking key…</Badge> : <Badge tone="warn">Etherscan key not usable — RPC</Badge>
    : <Badge tone="muted">public RPC</Badge>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Database className="w-4 h-4 text-accent" />
        <h4 className="font-semibold text-sm">Link index — {netName}</h4>
        {sourceBadge}
        {syncing && <span className="flex items-center gap-1 text-xs text-yellow-300"><Loader2 className="w-3 h-3 animate-spin" /> {prog}</span>}
      </div>
      <p className="text-xs text-txt-secondary">
        Fetches every Factory <code>LinkCreated</code> / <code>LinkActive</code> log in the date range (no ATM API), reads each link&apos;s current state on chain,
        and stores it in this browser for <b>{netName}</b> only. Widening the range later fetches just the missing part; leave the end date empty to keep following new blocks.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-txt-secondary space-y-1">Start date (UTC)
          <input type="date" className={`${inputCls} w-40`} value={start} onChange={(e) => setStart(e.target.value)} disabled={syncing} />
        </label>
        <label className="text-xs text-txt-secondary space-y-1">End date (UTC, inclusive — empty = now, live)
          <input type="date" className={`${inputCls} w-40`} value={end} onChange={(e) => setEnd(e.target.value)} disabled={syncing} />
        </label>
        <button className={btnCls} disabled={syncing || !start || !factory} onClick={go}>
          <span className="flex items-center gap-2"><CalendarRange className="w-4 h-4" /> {meta ? 'Fetch range' : 'Fetch & store'}</span>
        </button>
        {syncing && <button className="text-xs text-red-300 hover:underline" onClick={stop}>stop</button>}
        {chainId === 56 && (
          <button className={btnSecondaryCls} disabled={syncing} onClick={() => fileRef.current?.click()}>
            <span className="flex items-center gap-2"><Upload className="w-4 h-4" /> Import cc_connections_bsc.json</span>
          </button>
        )}
      </div>

      {meta === undefined ? <p className="text-xs text-txt-secondary">Loading local index…</p> : meta && (
        <div className="space-y-2 text-xs">
          <p className="text-txt-secondary">
            Stored: <UtcTime localFirst ts={meta.sinceTs} inline /> → {meta.endTs ? <UtcTime localFirst ts={meta.endTs} inline /> : <b>now (live)</b>} ·
            blocks {meta.fromBlock.toLocaleString()} → {meta.toBlock.toLocaleString()}{meta.endBlock !== null && meta.toBlock < meta.endBlock ? ` (target ${meta.endBlock.toLocaleString()})` : ''}
            {meta.source ? ` · last logs via ${meta.source === 'etherscan' ? 'Etherscan' : 'RPC'}` : ''}
            {meta.syncedAt ? <> · updated <UtcTime localFirst ts={Math.floor(meta.syncedAt / 1000)} time inline /></> : null}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Stored links" value={records.length.toLocaleString()} sub={stale ? `${stale} pending re-read` : 'all current'} />
            <Stat label="Your links" value={mine.length} sub={address ? `A ${stats.asA} · B ${stats.asB}` : 'connect a wallet'} />
            <Stat label="Waiting for your approval" value={stats.toApprove} sub="pending, you are userB" />
            <Stat label="Connected / expired" value={`${stats.connected} / ${stats.expired}`} sub="expired = ready to close" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {live && <button className={btnSecondaryCls} disabled={syncing} onClick={() => index.sync()}><span className="flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Sync new blocks</span></button>}
            {live && <label className="flex items-center gap-2 text-txt-secondary"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto every minute</label>}
            <button className={btnSecondaryCls} disabled={syncing || !records.length} onClick={refreshAll} title="Re-read every non-closed link's state (getLinkInfo/getCloseInfo)">
              <span className="flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Refresh all states</span>
            </button>
            <span className="text-txt-secondary">Export:</span>
            <button className="flex items-center gap-1 text-accent hover:underline disabled:opacity-40" disabled={!records.length} onClick={() => exportCsv('connections')}><Download className="w-3.5 h-3.5" /> connections CSV</button>
            <button className="flex items-center gap-1 text-accent hover:underline disabled:opacity-40" disabled={!records.length} onClick={() => exportCsv('activity')}><Download className="w-3.5 h-3.5" /> activity CSV</button>
            <button className="flex items-center gap-1 text-accent hover:underline disabled:opacity-40" disabled={!mine.length} onClick={() => exportCsv('mine')}><Download className="w-3.5 h-3.5" /> my links CSV</button>
            <button className={`${btnDangerCls} ml-auto py-1`} disabled={syncing} onClick={() => { if (confirm(`Delete the stored link index for ${netName}?`)) clear(); }}>
              <span className="flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Clear</span>
            </button>
          </div>
          <p className="text-[11px] text-txt-secondary">CSV columns match onchain-reports&apos; <code>cc_connections.csv</code> / <code>cc_activity.csv</code>. Status is as of the last read; CSV times are UTC (blank for logs fetched over RPC, which has no timestamps).</p>
          {meta.unverified && <p className="text-yellow-300">Part of this range was fetched over public RPC, which can silently miss logs. For complete data: Clear, then fetch again with the Etherscan key set.</p>}
          {factoryMismatch && <p className="text-yellow-300">This index was built for Factory {meta.factory}, not the current {factory}. Clear it and fetch again.</p>}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
      {warning && <p className="text-xs text-yellow-300 break-all">{warning}</p>}
      {error && <p className="text-xs text-red-300 break-all">{error}</p>}

      <details className="text-xs text-txt-secondary">
        <summary className="cursor-pointer">Log source settings</summary>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">Etherscan API key {envKey ? '(override — .env key in use)' : '(not set in .env)'}
            <input className={inputCls} type="password" autoComplete="off" placeholder={envKey ? 'using NEXT_PUBLIC_ETHERSCAN_API_KEY' : 'paste key (stored in this browser only)'}
              value={keyOverride} onChange={(e) => setKeyOverride(e.target.value.trim())} />
            <span className="block">{keyStatus === 'ok' ? `Key works for ${netName}.` : keyStatus && keyStatus !== 'checking' ? `${keyStatus}` : ''}</span>
          </label>
          <label className="space-y-1">RPC for logs (fallback / no key)
            <input className={inputCls} placeholder="optional paid RPC with eth_getLogs (tried before publicnode)" value={customRpc} onChange={(e) => setCustomRpc(e.target.value.trim())} />
            <span className="block">Saved per network. Default: publicnode, the only free BSC RPCs that serve 50k-block log ranges.</span>
          </label>
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="bg-surface-tertiary/50 rounded-lg px-3 py-2">
      <p className="text-txt-secondary">{label}</p>
      <p className="text-base font-semibold">{value}</p>
      <p className="text-[11px] text-txt-secondary">{sub}</p>
    </div>
  );
}
