import { ethers } from 'ethers';
import { FACTORY_ABI, LINK_ABI, LinkStatus, LINK_STATUS_LABELS, type LinkState } from './index';

// On-chain index of Links for a date range, kept in IndexedDB and exportable as CSV.
// Same approach as atm-ai-bl/onchain-reports/fetch_connections.py — no ATM backend:
//   - Factory LinkCreated(creator, symbol, link)  -> a new link to index
//   - Factory LinkActive(link, user, methodId)    -> emitted on EVERY state change of a link
//     (setUserB/agree/reject/pledge/depledge/close/…), so only touched links are re-read
//   - Link.getLinkInfo() + getCloseInfo()         -> current state, read in bulk via Multicall3
// "Which txs to fetch" is exactly: the Factory's Link logs in the block range. Logs come from
// Etherscan v2 (1000 logs per request, no range limit, timestamps — BSC needs a paid plan).
// Without a key they come from public RPC eth_getLogs, which is NOT reliable: tested
// 2026-11-04, publicnode returned 0 / 390 / 520 logs for the same mainnet range depending on
// chunk size (Etherscan: 919 every time), with no error. So with a key, Etherscan is the only
// source and an Etherscan error stops the scan (resumable) instead of silently using RPC; an
// index built without a key is flagged `unverified`.
// Range: [start date, end date]. No end date = live: every sync scans up to the chain tip.
// Widening the range later only fetches the missing part; ingest is idempotent.
// Expiry has no event; it's derived from expiredTime on the fly (same rule as Link.isExpire).

export const LINK_CREATED_TOPIC = ethers.utils.id('LinkCreated(address,string,address)');
export const LINK_ACTIVE_TOPIC = ethers.utils.id('LinkActive(address,address,uint256)');
export const LINK_METHODS = ['setUserB', 'agree', 'reject', 'pledge', 'depledge', 'close', 'repealCloseReq', 'rejectClose', 'wtihdrawSelf'];

// Public RPCs that actually serve eth_getLogs over 50k-block ranges (tested 2026-11-04 — the
// binance.org dataseeds, drpc and 1rpc refuse). A custom RPC set on the page is tried first.
export const LOG_RPCS: Record<number, string[]> = {
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'],
  97: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.publicnode.com'],
};
const MAX_SPAN = 50_000;
const MIN_SPAN = 500;
const STATE_BATCH = 60; // links per Multicall3 call (2 sub-calls each)
const RPC_CONFIRMATIONS = 3;
const ETHERSCAN_SAFE_BLOCKS = 30; // Etherscan's log index lags the tip (fetch_connections.py SAFE_BLOCKS)
// Every sync re-fetches this many blocks before the cursor. Etherscan's log index can lag its
// head by more than SAFE_BLOCKS, and a log indexed after we moved past its block would otherwise
// be lost for good (seen 2026-11-04: close() requests not showing after refresh). Re-ingesting is
// idempotent (records keyed by link, activity by tx:logIndex). ~9 min on testnet, ~15 on mainnet.
const RESCAN_BLOCKS = 1200;
const ETHERSCAN_API = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_PAGE = 1000;
const ETHERSCAN_GAP_MS = 250; // ≤ 4 req/s (key limit is 5)

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // deployed on BSC mainnet + testnet
const MULTICALL_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'];
const linkIface = new ethers.utils.Interface(LINK_ABI);
const factoryIface = new ethers.utils.Interface(FACTORY_ABI);

export interface LinkRecord {
  key: string; // `${chainId}:${address}`
  chainId: number;
  address: string;
  creator: string;
  createdBlock: number; // 0 = created before the range (found via LinkActive or added by hand)
  createdTx: string;
  createdAt: number; // unix s; 0 when logs came from RPC (no timestamps there)
  lastActivityBlock: number;
  known: boolean; // state has been read at least once
  stale: boolean; // needs a state read (new, touched since last read, or last read failed)
  readAt: number;
  symbol: string;
  token: string;
  userA: string;
  userB: string;
  amountA: string;
  amountB: string;
  percentA: number;
  totalPlan: string;
  lockDays: number;
  status: number;
  isAward: boolean;
  startTime: number;
  expiredTime: number;
  closeTime: number;
  closer: string;
  closeReqA: boolean;
  closeReqB: boolean;
}

export interface ActivityRow {
  key: string; // `${chainId}:${tx}:${logIndex}`
  chainId: number;
  block: number;
  time: number; // 0 when from RPC
  tx: string;
  logIndex: number;
  link: string;
  user: string;
  methodId: number;
}

export interface IndexMeta {
  chainId: number;
  factory: string;
  sinceTs: number;
  endTs: number | null; // null = live (keeps following the chain tip)
  fromBlock: number; // first block covered
  toBlock: number; // last block covered (contiguous from fromBlock)
  endBlock: number | null; // scan target; null = live
  syncedAt: number;
  source?: 'etherscan' | 'rpc'; // where the last scanned logs came from
  unverified?: boolean; // some blocks were scanned over public RPC — may be missing logs
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────

const DB_NAME = 'atm-link-index';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('links')) d.createObjectStore('links', { keyPath: 'key' }).createIndex('chainId', 'chainId');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'chainId' });
      if (!d.objectStoreNames.contains('activity')) d.createObjectStore('activity', { keyPath: 'key' }).createIndex('chainId', 'chainId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const loadMeta = (chainId: number) => tx<IndexMeta>('meta', 'readonly', (s) => s.get(chainId));
const saveMeta = (m: IndexMeta) => tx('meta', 'readwrite', (s) => { s.put(m); });
const byChain = async <T,>(store: string, chainId: number): Promise<T[]> =>
  (await tx<T[]>(store, 'readonly', (s) => s.index('chainId').getAll(chainId))) || [];
export const loadRecords = (chainId: number) => byChain<LinkRecord>('links', chainId);
export const loadActivity = (chainId: number) => byChain<ActivityRow>('activity', chainId);
const putAll = (store: string, rows: { key: string }[]) => rows.length ? tx(store, 'readwrite', (s) => { rows.forEach((r) => s.put(r)); }) : Promise.resolve(undefined);
const saveRecords = (rs: LinkRecord[]) => putAll('links', rs);

export async function clearIndex(chainId: number) {
  for (const store of ['links', 'activity']) {
    const keys = (await byChain<{ key: string }>(store, chainId)).map((r) => r.key);
    await tx(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); });
  }
  await tx('meta', 'readwrite', (s) => { s.delete(chainId); });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const stub = (chainId: number, address: string): LinkRecord => ({
  key: `${chainId}:${address.toLowerCase()}`, chainId, address: ethers.utils.getAddress(address),
  creator: '', createdBlock: 0, createdTx: '', createdAt: 0, lastActivityBlock: 0, known: false, stale: true, readAt: 0,
  symbol: '', token: '', userA: '', userB: '', amountA: '0', amountB: '0', percentA: 0, totalPlan: '0',
  lockDays: 0, status: -1, isAward: false, startTime: 0, expiredTime: 0, closeTime: 0, closer: '', closeReqA: false, closeReqB: false,
});

export const isExpired = (r: Pick<LinkRecord, 'status' | 'expiredTime'>, nowSec = Date.now() / 1000) =>
  r.status !== LinkStatus.INITED && r.expiredTime !== 0 && nowSec >= r.expiredTime;

export const toLinkState = (r: LinkRecord): LinkState => ({
  address: r.address, isLink: true, symbol: r.symbol, token: r.token, userA: r.userA, userB: r.userB,
  amountA: ethers.BigNumber.from(r.amountA), amountB: ethers.BigNumber.from(r.amountB), percentA: r.percentA,
  totalPlan: ethers.BigNumber.from(r.totalPlan), lockDays: r.lockDays, status: r.status, expiredTime: r.expiredTime,
  closeReqA: r.closeReqA, closeReqB: r.closeReqB, expired: isExpired(r),
});

export const involves = (r: LinkRecord, wallet: string) => {
  const w = wallet.toLowerCase();
  return r.userA.toLowerCase() === w || r.userB.toLowerCase() === w || r.creator.toLowerCase() === w;
};

export const statusLabel = (r: LinkRecord) => (r.known ? LINK_STATUS_LABELS[r.status] ?? String(r.status) : 'unread');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: string | number) => (typeof v === 'number' ? v : v.startsWith('0x') ? parseInt(v, 16) : Number(v));

/** Binary search for the first block with timestamp >= ts (block headers only, no archive state). */
export async function blockAtTime(provider: ethers.providers.Provider, ts: number): Promise<number> {
  let hi = await provider.getBlockNumber();
  let lo = 1;
  if ((await provider.getBlock(hi)).timestamp < ts) return hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getBlock(mid)).timestamp < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ─── Etherscan v2 ────────────────────────────────────────────────────────────

let lastEtherscanAt = 0;
async function etherscan(key: string, chainId: number, params: Record<string, string | number>): Promise<any> {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), chainid: String(chainId), apikey: key });
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastEtherscanAt + ETHERSCAN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastEtherscanAt = Date.now();
    const res = await fetch(`${ETHERSCAN_API}?${q}`).then((r) => r.json());
    if (res.status === '1') return res.result;
    const detail = String(res.result ?? '');
    if (res.message === 'No records found' || (Array.isArray(res.result) && res.result.length === 0)) return [];
    if (/rate limit/i.test(detail)) { await sleep(500 * (attempt + 1)); continue; }
    throw new Error(`Etherscan: ${res.message}${detail ? ` — ${detail}` : ''}`);
  }
  throw new Error('Etherscan: still rate limited after retries');
}

/** Cheap key check for this chain. Returns an error string, or null when the key works. */
export async function checkEtherscanKey(key: string, chainId: number): Promise<string | null> {
  try { await etherscan(key, chainId, { module: 'block', action: 'getblocknobytime', timestamp: Math.floor(Date.now() / 1000) - 3600, closest: 'after' }); return null; }
  catch (e: any) { return e?.message || String(e); }
}

async function resolveBlock(ts: number, o: { chainId: number; provider: ethers.providers.Provider; etherscanKey?: string }): Promise<number> {
  if (o.etherscanKey) {
    try {
      const b = num(await etherscan(o.etherscanKey, o.chainId, { module: 'block', action: 'getblocknobytime', timestamp: Math.floor(ts), closest: 'after' }));
      if (Number.isFinite(b) && b > 0) return b;
    } catch { /* fall back to RPC search */ }
  }
  return blockAtTime(o.provider, ts);
}

// ─── log ingest (shared by both sources) ─────────────────────────────────────

interface RawLog { topics: string[]; data: string; blockNumber: number; logIndex: number; transactionHash: string; time: number }

async function ingest(chainId: number, byAddr: Map<string, LinkRecord>, logs: RawLog[]) {
  const changed = new Map<string, LinkRecord>();
  const acts: ActivityRow[] = [];
  for (const log of logs) {
    let p: ethers.utils.LogDescription;
    try { p = factoryIface.parseLog(log); } catch { continue; }
    const isCreated = log.topics[0].toLowerCase() === LINK_CREATED_TOPIC;
    // Positional: ethers v5 drops the named keys on LinkCreated (indexed string arg).
    // LinkCreated(creator, symbol, link) → [2]; LinkActive(link, user, methodId) → [0].
    const addr: string = isCreated ? p.args[2] : p.args[0];
    const k = addr.toLowerCase();
    const r = byAddr.get(k) || stub(chainId, addr);
    if (isCreated) {
      r.creator = p.args[0]; r.createdBlock = log.blockNumber; r.createdTx = log.transactionHash;
      if (log.time) r.createdAt = log.time;
    } else {
      acts.push({
        key: `${chainId}:${log.transactionHash.toLowerCase()}:${log.logIndex}`, chainId, block: log.blockNumber, time: log.time,
        tx: log.transactionHash, logIndex: log.logIndex, link: r.address, user: p.args[1], methodId: p.args[2].toNumber(),
      });
    }
    r.lastActivityBlock = Math.max(r.lastActivityBlock, log.blockNumber);
    r.stale = true;
    byAddr.set(k, r);
    changed.set(k, r);
  }
  await saveRecords(Array.from(changed.values()));
  await putAll('activity', acts);
}

interface ScanCtx {
  chainId: number; factory: string; customRpc?: string; etherscanKey?: string;
  byAddr: Map<string, LinkRecord>; shouldStop?: () => boolean;
  onPage: (lastDone: number, source: 'etherscan' | 'rpc') => Promise<void>; // block range up to lastDone is complete
}

/** Scan [from, to] inclusive — Etherscan when keyed (errors propagate; cursor stays at the last full page), else RPC. */
async function scanSegment(c: ScanCtx, from: number, to: number): Promise<void> {
  if (c.etherscanKey) {
    while (from <= to && !c.shouldStop?.()) {
      const part: any[] = await etherscan(c.etherscanKey, c.chainId, {
        module: 'logs', action: 'getLogs', address: c.factory, fromBlock: from, toBlock: to, page: 1, offset: ETHERSCAN_PAGE,
      });
      await ingest(c.chainId, c.byAddr, part.map((l) => ({
        topics: l.topics, data: l.data, blockNumber: num(l.blockNumber), logIndex: num(l.logIndex), transactionHash: l.transactionHash, time: num(l.timeStamp),
      })));
      let done: number;
      if (part.length < ETHERSCAN_PAGE) done = to;
      else {
        const last = num(part[part.length - 1].blockNumber);
        if (last <= from) throw new Error(`more than ${ETHERSCAN_PAGE} Factory logs in block ${from}`);
        done = last - 1; // the last block may be cut off mid-page: fetch it again (ingest is idempotent)
      }
      await c.onPage(done, 'etherscan');
      from = done + 1;
    }
    return;
  }
  // No key: public RPC in 50k-block pages, halving the span on errors.
  const ps = [...(c.customRpc ? [c.customRpc] : []), ...(LOG_RPCS[c.chainId] || [])].map((u) => new ethers.providers.StaticJsonRpcProvider(u, c.chainId));
  let span = MAX_SPAN;
  while (from <= to && !c.shouldStop?.()) {
    const upto = Math.min(from + span - 1, to);
    let logs: ethers.providers.Log[] | null = null;
    let lastErr: any;
    for (const p of ps) {
      try { logs = await p.getLogs({ address: c.factory, topics: [[LINK_CREATED_TOPIC, LINK_ACTIVE_TOPIC]], fromBlock: from, toBlock: upto }); break; } catch (e) { lastErr = e; }
    }
    if (!logs) {
      if (span <= MIN_SPAN) throw lastErr;
      span = Math.max(MIN_SPAN, Math.floor(span / 2));
      continue;
    }
    await ingest(c.chainId, c.byAddr, logs.map((l) => ({ topics: l.topics, data: l.data, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash, time: 0 })));
    await c.onPage(upto, 'rpc');
    from = upto + 1;
    if (span < MAX_SPAN) span = Math.min(MAX_SPAN, span * 2);
  }
}

/** getLinkInfo + getCloseInfo for many links, STATE_BATCH links per Multicall3 eth_call. */
async function readStates(provider: ethers.providers.Provider, recs: LinkRecord[]) {
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const infoData = linkIface.encodeFunctionData('getLinkInfo');
  const closeData = linkIface.encodeFunctionData('getCloseInfo');
  for (let i = 0; i < recs.length; i += STATE_BATCH) {
    const part = recs.slice(i, i + STATE_BATCH);
    let res: { success: boolean; returnData: string }[];
    try {
      res = await mc.callStatic.aggregate3(part.flatMap((r) => [
        { target: r.address, allowFailure: true, callData: infoData },
        { target: r.address, allowFailure: true, callData: closeData },
      ]));
    } catch { continue; } // whole batch failed (RPC hiccup) — those stay stale, retried next sync
    part.forEach((r, j) => {
      const a = res[2 * j], b = res[2 * j + 1];
      if (!a?.success || !b?.success) return;
      try {
        const i1 = linkIface.decodeFunctionResult('getLinkInfo', a.returnData);
        const c1 = linkIface.decodeFunctionResult('getCloseInfo', b.returnData);
        Object.assign(r, {
          symbol: i1.symbol_, token: i1.token_, userA: i1.userA_, userB: i1.userB_,
          amountA: i1.amountA_.toString(), amountB: i1.amountB_.toString(), percentA: i1.percentA_.toNumber(),
          totalPlan: i1.totalPlan_.toString(), lockDays: i1.lockDays_.toNumber(), startTime: i1.startTime_.toNumber(),
          status: i1.status_.toNumber(), isAward: i1.isAward_, expiredTime: c1.expiredTime_.toNumber(), closeTime: c1.closeTime_.toNumber(),
          closer: c1.closer_, closeReqA: c1.closeReqA_, closeReqB: c1.closeReqB_,
          known: true, stale: false, readAt: Date.now(),
        });
      } catch { /* undecodable — leave stale */ }
    });
  }
}

async function readStale(provider: ethers.providers.Provider, byAddr: Map<string, LinkRecord>, focus: string | undefined, onProgress?: (p: SyncProgress) => void, shouldStop?: () => boolean) {
  const f = focus?.toLowerCase();
  const stale = Array.from(byAddr.values()).filter((r) => r.stale)
    .sort((a, b) => Number(!!f && !involves(b, f)) - Number(!!f && !involves(a, f))); // caller's links first
  if (!stale.length) return;
  onProgress?.({ phase: 'reading', read: 0, toRead: stale.length });
  for (let i = 0; i < stale.length && !shouldStop?.(); i += STATE_BATCH * 5) {
    const part = stale.slice(i, i + STATE_BATCH * 5);
    await readStates(provider, part);
    await saveRecords(part);
    onProgress?.({ phase: 'reading', read: Math.min(i + part.length, stale.length), toRead: stale.length });
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface SyncProgress { phase: 'locating' | 'scanning' | 'reading' | 'done'; source?: 'etherscan' | 'rpc'; scanned?: number; total?: number; read?: number; toRead?: number }
export interface SyncOpts {
  chainId: number; provider: ethers.providers.Provider; customRpc?: string; etherscanKey?: string; focus?: string;
  onProgress?: (p: SyncProgress) => void; shouldStop?: () => boolean;
}
export interface SyncResult { meta: IndexMeta; records: LinkRecord[]; warning: string }

/**
 * Fetch [startTs, endTs] (endTs null = up to now, then keep following the tip). With an existing
 * index on this chain, only the missing part is fetched: earlier start → backfill before the
 * covered range; later/no end → extend forward. A later start or earlier end keeps what's stored.
 */
export async function fetchRange(o: SyncOpts & { factory: string; startTs: number; endTs: number | null }): Promise<SyncResult> {
  o.onProgress?.({ phase: 'locating' });
  const startBlock = await resolveBlock(o.startTs, o);
  // End date is exclusive (00:00 UTC of the day after). An end that hasn't happened yet stays live
  // until it passes (syncIndex then pins endBlock) — otherwise "until today" would freeze at the
  // block of the click and miss everything after it.
  const endInFuture = o.endTs !== null && o.endTs > Date.now() / 1000;
  const endBlock = o.endTs === null || endInFuture ? null : (await resolveBlock(o.endTs, o)) - 1;
  if (endBlock !== null && endBlock < startBlock) throw new Error('end date is before start date');
  let meta = await loadMeta(o.chainId);
  if (meta && meta.factory.toLowerCase() !== o.factory.toLowerCase()) throw new Error('index was built for a different Factory — clear it first');
  const byAddr = new Map((await loadRecords(o.chainId)).map((r) => [r.address.toLowerCase(), r]));
  const warning = '';

  if (!meta) {
    meta = { chainId: o.chainId, factory: o.factory, sinceTs: o.startTs, endTs: o.endTs, fromBlock: startBlock, toBlock: startBlock - 1, endBlock, syncedAt: 0 };
    await saveMeta(meta);
  } else if (startBlock < meta.fromBlock) {
    // Backfill [startBlock, fromBlock-1]. The cursor only moves on completion; a re-run re-fetches (idempotent).
    const m = meta;
    const total = m.fromBlock - startBlock;
    await scanSegment({
      chainId: o.chainId, factory: m.factory, customRpc: o.customRpc, etherscanKey: o.etherscanKey, byAddr, shouldStop: o.shouldStop,
      onPage: async (done, source) => o.onProgress?.({ phase: 'scanning', source, scanned: done - startBlock + 1, total }),
    }, startBlock, m.fromBlock - 1);
    if (!o.etherscanKey) m.unverified = true;
    if (!o.shouldStop?.()) { m.fromBlock = startBlock; m.sinceTs = o.startTs; }
  }
  meta.endTs = o.endTs;
  meta.endBlock = endBlock;
  await saveMeta(meta);
  const r = await syncIndex(o, byAddr);
  return { ...r, warning: [warning, r.warning].filter(Boolean).join(' · ') };
}

/** Extend the covered range forward to the end block (or the tip when live), then re-read new/touched links. */
export async function syncIndex(o: SyncOpts, preloaded?: Map<string, LinkRecord>): Promise<SyncResult> {
  const meta = await loadMeta(o.chainId);
  if (!meta) throw new Error('index not initialised');
  const byAddr = preloaded || new Map((await loadRecords(o.chainId)).map((r) => [r.address.toLowerCase(), r]));
  const tip = await o.provider.getBlockNumber();
  // Etherscan's log index lags the tip; live ranges follow it ~30 blocks (~20 s) behind.
  const head = tip - (o.etherscanKey ? ETHERSCAN_SAFE_BLOCKS : RPC_CONFIRMATIONS);
  const nowSec = Date.now() / 1000;
  if (meta.endBlock !== null && meta.endTs && meta.endTs > nowSec) meta.endBlock = null; // older index pinned "until today" at click time: follow live again
  if (meta.endBlock === null && meta.endTs !== null && meta.endTs !== undefined && nowSec >= meta.endTs) {
    meta.endBlock = (await resolveBlock(meta.endTs, o)) - 1; // the end date has now passed: pin it
  }
  const to = Math.min(meta.endBlock ?? head, head);
  const start = Math.max(meta.fromBlock, meta.toBlock + 1 - RESCAN_BLOCKS);
  const warning = o.etherscanKey ? '' : 'No Etherscan key: logs come from public RPC, which can silently return incomplete results — set NEXT_PUBLIC_ETHERSCAN_API_KEY for a complete index.';
  if (start <= to) {
    if (!o.etherscanKey) meta.unverified = true;
    await scanSegment({
      chainId: o.chainId, factory: meta.factory, customRpc: o.customRpc, etherscanKey: o.etherscanKey, byAddr, shouldStop: o.shouldStop,
      onPage: async (done, source) => {
        meta.toBlock = Math.max(meta.toBlock, done); meta.source = source; // never move the cursor back (rescans overlap)
        await saveMeta(meta);
        o.onProgress?.({ phase: 'scanning', source, scanned: done - start + 1, total: to - start + 1 });
      },
    }, start, to);
  }
  if (!o.shouldStop?.()) await readStale(o.provider, byAddr, o.focus, o.onProgress, o.shouldStop);
  meta.syncedAt = Date.now();
  await saveMeta(meta);
  o.onProgress?.({ phase: 'done' });
  return { meta, records: Array.from(byAddr.values()), warning };
}

/** Re-read every link that isn't closed (closed is final) — e.g. for a fixed past range, before exporting. */
export async function refreshStates(o: SyncOpts): Promise<LinkRecord[]> {
  const byAddr = new Map((await loadRecords(o.chainId)).map((r) => [r.address.toLowerCase(), r]));
  byAddr.forEach((r) => { if (!r.known || r.status !== LinkStatus.CLOSED) r.stale = true; });
  await readStale(o.provider, byAddr, o.focus, o.onProgress, o.shouldStop);
  o.onProgress?.({ phase: 'done' });
  return Array.from(byAddr.values());
}

/** Add links by hand (e.g. older than the range). Non-links are rejected via Factory.isLink. */
export async function trackLinks(chainId: number, factory: string, provider: ethers.providers.Provider, addresses: string[]): Promise<{ added: number; rejected: string[] }> {
  const f = new ethers.Contract(factory, FACTORY_ABI, provider);
  const existing = new Map((await loadRecords(chainId)).map((r) => [r.address.toLowerCase(), r]));
  const rejected: string[] = [];
  const recs: LinkRecord[] = [];
  for (let i = 0; i < addresses.length; i += 20) {
    const part = addresses.slice(i, i + 20);
    const ok = await Promise.all(part.map((a) => f.isLink(a).catch(() => false)));
    part.forEach((a, j) => {
      if (!ok[j]) { rejected.push(a); return; }
      const r = existing.get(a.toLowerCase()) || stub(chainId, a);
      r.stale = true;
      recs.push(r);
    });
  }
  await readStates(provider, recs);
  await saveRecords(recs);
  return { added: recs.length, rejected };
}

/**
 * Seed from onchain-reports' data/cc_connections_bsc.json (BSC mainnet). Takes the link list,
 * creators, creation tx/time, activity rows and scanned range — link state is re-read on chain
 * because the file's raw amounts are integers beyond JS number precision.
 */
export async function importReportsCache(chainId: number, factory: string, text: string): Promise<{ links: number; activity: number; toBlock: number }> {
  const j = JSON.parse(text);
  if (!Array.isArray(j?.created) || typeof j?.to_block !== 'number') throw new Error('not a fetch_connections.py cache (missing created / to_block)');
  if (chainId !== 56) throw new Error('that cache is BSC mainnet — switch the wallet to BSC Mainnet first');
  const prev = await loadMeta(chainId);
  if (prev && (j.from_block > prev.toBlock + 1 || j.to_block < prev.fromBlock - 1)) {
    throw new Error(`the file covers blocks ${j.from_block}–${j.to_block}, which doesn't touch the stored range ${prev.fromBlock}–${prev.toBlock} — clear the index first or widen the range`);
  }
  const existing = new Map((await loadRecords(chainId)).map((r) => [r.address.toLowerCase(), r]));
  const touch = (addr: string) => {
    const r = existing.get(addr.toLowerCase()) || stub(chainId, addr);
    r.stale = true;
    existing.set(addr.toLowerCase(), r);
    return r;
  };
  for (const c of j.created) {
    if (!ethers.utils.isAddress(c.link)) continue;
    const r = touch(c.link);
    if (c.creator) r.creator = ethers.utils.getAddress(c.creator);
    r.createdBlock = c.block || r.createdBlock; r.createdTx = c.tx || r.createdTx; r.createdAt = c.time || r.createdAt;
    r.lastActivityBlock = Math.max(r.lastActivityBlock, c.block || 0);
  }
  const acts: ActivityRow[] = [];
  for (const a of j.activity || []) {
    if (!ethers.utils.isAddress(a.link) || !a.tx) continue;
    const r = touch(a.link);
    r.lastActivityBlock = Math.max(r.lastActivityBlock, a.block || 0);
    acts.push({ key: `${chainId}:${String(a.tx).toLowerCase()}:${a.log_index}`, chainId, block: a.block, time: a.time || 0, tx: a.tx, logIndex: a.log_index, link: r.address, user: a.user, methodId: a.method_id });
  }
  await saveRecords(Array.from(existing.values()));
  await putAll('activity', acts);
  const sinceTs = j.since ? Date.parse(`${j.since}T00:00:00Z`) / 1000 : 0;
  await saveMeta({
    chainId, factory,
    sinceTs: prev ? Math.min(prev.sinceTs, sinceTs) : sinceTs,
    endTs: prev ? prev.endTs : null, endBlock: prev ? prev.endBlock : null,
    fromBlock: prev ? Math.min(prev.fromBlock, j.from_block) : j.from_block,
    toBlock: prev ? Math.max(prev.toBlock, j.to_block) : j.to_block,
    syncedAt: 0,
  });
  return { links: j.created.length, activity: acts.length, toBlock: j.to_block };
}

// ─── CSV (same columns as fetch_connections.py's cc_connections.csv / cc_activity.csv) ──

const iso = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ') : '');
const units = (raw: string, d: number) => { const s = ethers.utils.formatUnits(raw || '0', d); return s.endsWith('.0') ? s.slice(0, -2) : s; };
const STATUS_NAMES = ['INITED', 'AGREED', 'CLOSED', 'PLEDGED'];

export const CONNECTION_COLUMNS = ['created_at', 'block', 'tx', 'link', 'creator', 'symbol', 'token', 'userA', 'userB', 'totalPlan',
  'amountA', 'amountB', 'percentA', 'lockDays', 'status', 'isAward', 'startTime', 'expiredTime', 'closeTime', 'closer',
  'activity_count', 'last_method', 'last_activity_at'];

/** Rows for cc_connections.csv. `decimals` maps lower-case token → decimals (missing = 18). */
export function connectionRows(records: LinkRecord[], activity: ActivityRow[], decimals: Record<string, number>, extra?: (r: LinkRecord) => (string | number)[]) {
  const byLink = new Map<string, ActivityRow[]>();
  for (const a of activity) {
    const k = a.link.toLowerCase();
    if (!byLink.has(k)) byLink.set(k, []);
    byLink.get(k)!.push(a);
  }
  return [...records].sort((a, b) => (a.createdBlock || Infinity) - (b.createdBlock || Infinity) || a.address.localeCompare(b.address)).map((r) => {
    const acts = (byLink.get(r.address.toLowerCase()) || []).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    const last = acts[acts.length - 1];
    const d = decimals[r.token.toLowerCase()] ?? 18;
    return [
      iso(r.createdAt), r.createdBlock || '', r.createdTx, r.address.toLowerCase(), r.creator.toLowerCase(), r.symbol, r.token.toLowerCase(),
      r.userA.toLowerCase(), r.userB.toLowerCase(),
      r.known ? units(r.totalPlan, d) : '', r.known ? units(r.amountA, d) : '', r.known ? units(r.amountB, d) : '',
      r.known ? r.percentA : '', r.known ? r.lockDays : '', r.known ? STATUS_NAMES[r.status] ?? String(r.status) : '',
      r.known ? (r.isAward ? 'True' : 'False') : '', iso(r.startTime), iso(r.expiredTime), iso(r.closeTime), r.closer.toLowerCase(),
      acts.length, last ? LINK_METHODS[last.methodId] ?? String(last.methodId) : '', last ? iso(last.time) : '',
      ...(extra ? extra(r) : []),
    ];
  });
}

export const ACTIVITY_COLUMNS = ['time', 'block', 'tx', 'link', 'user', 'method_id', 'method', 'link_created_in_range'];

export function activityRows(activity: ActivityRow[], records: LinkRecord[]) {
  const created = new Set(records.filter((r) => r.createdBlock).map((r) => r.address.toLowerCase()));
  return [...activity].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).map((a) => [
    iso(a.time), a.block, a.tx, a.link.toLowerCase(), a.user.toLowerCase(), a.methodId, LINK_METHODS[a.methodId] ?? String(a.methodId),
    created.has(a.link.toLowerCase()) ? 'True' : 'False',
  ]);
}
