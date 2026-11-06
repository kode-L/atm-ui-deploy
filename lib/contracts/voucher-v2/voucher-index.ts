import { ethers } from 'ethers';

// Local index of VoucherNFT vouchers (IndexedDB), same idea as the Link index:
//   - every voucher read is cached per chain + VoucherNFT address, so a page opens instantly
//     with the last known list and then refreshes in the background
//   - reads go through Multicall3 (vouchers(id) + ownerOf(id) for ~150 ids per RPC call)
//     instead of one request per call; falls back to plain parallel calls where Multicall3
//     isn't deployed
//   - claimed / revoked are final on-chain, so for those only the owner is re-read (a revoked
//     voucher can still be released from the RevocationVault to another address)

export interface IndexedVoucher {
  id: number;
  owner: string;
  typeId: number;
  faceValue: string; // uint256 as decimal string (IndexedDB can't store BigNumber)
  token: string;
  startDate: number;
  expiryDate: number;
  claimed: boolean;
  revoked: boolean;
  reserved: boolean;
}

interface CacheEntry { key: string; at: number; vouchers: Record<number, IndexedVoucher> }

const ZERO = ethers.constants.AddressZero;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // same address on every chain that has it
const MULTICALL_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'];
const IDS_PER_CALL = 150; // 2 sub-calls each → 300 per aggregate3
const PARALLEL = 4; // aggregate3 calls in flight at once
const FALLBACK_CHUNK = 50;

const DB = 'dg_voucherV2Index'; // own DB: bumping dg_voucherV2's version would break upload-store's open()
const STORE = 'vouchers';
const memory = new Map<string, CacheEntry>();

export const indexKey = (chainId: number, nft: string) => `${chainId}:${nft.toLowerCase()}`;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function loadIndex(key: string): Promise<Record<number, IndexedVoucher>> {
  const db = await openDb();
  if (!db) return memory.get(key)?.vouchers || {};
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as CacheEntry | undefined)?.vouchers || {});
      r.onerror = () => resolve({});
    } catch { resolve({}); }
  });
}

/** Merge freshly read vouchers into the stored index (never drops ones read earlier). */
export async function saveToIndex(key: string, fresh: IndexedVoucher[]): Promise<void> {
  if (!fresh.length) return;
  const vouchers = { ...(await loadIndex(key)) };
  for (const v of fresh) vouchers[v.id] = v;
  const entry: CacheEntry = { key, at: Date.now(), vouchers };
  memory.set(key, entry);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function clearIndex(key: string): Promise<void> {
  memory.delete(key);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

// ── bulk reads ──

const hasMulticall = new Map<ethers.providers.Provider, Promise<boolean>>();
function multicallOn(provider: ethers.providers.Provider) {
  let p = hasMulticall.get(provider);
  if (!p) {
    p = provider.getCode(MULTICALL3).then((c) => c !== '0x', () => false);
    hasMulticall.set(provider, p);
  }
  return p;
}

type Call = { target: string; data: string };
type Res = { ok: boolean; data: string };

async function runCalls(provider: ethers.providers.Provider, calls: Call[], direct: (c: Call) => Promise<string>): Promise<Res[]> {
  const out: Res[] = new Array(calls.length);
  if (await multicallOn(provider)) {
    const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
    const size = IDS_PER_CALL * 2;
    const starts: number[] = [];
    for (let i = 0; i < calls.length; i += size) starts.push(i);
    for (let g = 0; g < starts.length; g += PARALLEL) {
      await Promise.all(starts.slice(g, g + PARALLEL).map(async (s) => {
        const part = calls.slice(s, s + size);
        const r: { success: boolean; returnData: string }[] = await mc.callStatic.aggregate3(part.map((c) => ({ target: c.target, allowFailure: true, callData: c.data })));
        r.forEach((x, j) => { out[s + j] = { ok: x.success, data: x.returnData }; });
      }));
    }
    return out;
  }
  for (let i = 0; i < calls.length; i += FALLBACK_CHUNK) {
    const part = await Promise.all(calls.slice(i, i + FALLBACK_CHUNK).map((c) => direct(c).then((data) => ({ ok: true, data }), () => ({ ok: false, data: '0x' }))));
    part.forEach((r, j) => { out[i + j] = r; });
  }
  return out;
}

/**
 * Read vouchers by id. `ownerOnly` ids (known claimed/revoked) only get ownerOf re-read and keep
 * their cached fields. Ids whose ownerOf fails (never minted / burned) come back as null.
 */
export async function readVouchers(
  nft: ethers.Contract,
  ids: number[],
  cached: Record<number, IndexedVoucher> = {},
): Promise<(IndexedVoucher | null)[]> {
  const provider = nft.provider;
  const iface = nft.interface;
  const calls: Call[] = [];
  const plan: { id: number; full: boolean }[] = ids.map((id) => {
    const c = cached[id];
    return { id, full: !(c && (c.claimed || c.revoked)) };
  });
  for (const p of plan) {
    calls.push({ target: nft.address, data: iface.encodeFunctionData('ownerOf', [p.id]) });
    if (p.full) calls.push({ target: nft.address, data: iface.encodeFunctionData('vouchers', [p.id]) });
  }
  const res = await runCalls(provider, calls, (c) => provider.call({ to: c.target, data: c.data }));
  let k = 0;
  return plan.map((p) => {
    const own = res[k++];
    const vr = p.full ? res[k++] : null;
    if (!own?.ok) return null;
    const owner = iface.decodeFunctionResult('ownerOf', own.data)[0] as string;
    if (!p.full) return { ...cached[p.id], owner };
    if (!vr?.ok) return null;
    const v = iface.decodeFunctionResult('vouchers', vr.data);
    return {
      id: p.id, owner, typeId: Number(v.typeId), faceValue: ethers.BigNumber.from(v.faceValue).toString(), token: v.token,
      startDate: Number(v.startDate), expiryDate: Number(v.expiryDate), claimed: v.claimed, revoked: v.revoked, reserved: v.reserved,
    };
  });
}

/** tokenOfOwnerByIndex(owner, 0..n-1) in bulk. */
export async function readOwnerIds(nft: ethers.Contract, owner: string, n: number): Promise<number[]> {
  const iface = nft.interface;
  const calls: Call[] = Array.from({ length: n }, (_, i) => ({ target: nft.address, data: iface.encodeFunctionData('tokenOfOwnerByIndex', [owner, i]) }));
  const res = await runCalls(nft.provider, calls, (c) => nft.provider.call({ to: c.target, data: c.data }));
  return res.filter((r) => r.ok).map((r) => Number(iface.decodeFunctionResult('tokenOfOwnerByIndex', r.data)[0]));
}

export const isMinted = (v: IndexedVoucher | null): v is IndexedVoucher => !!v && v.owner !== ZERO;
