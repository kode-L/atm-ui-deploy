// Bulk-mint uploads kept in this browser's IndexedDB, so an admin can come back later and see which
// batches of an upload minted, even when the wallet (e.g. a Safe) never returned the transactions.
// Only facts that never change are stored (the rows, which proposal each batch became, the voucher
// ids an executed batch minted); live state (approvals, claimed) is always read from the chain.

export interface StoredRow { to: string; face: string; tokenId: string } // face: raw on-chain uint, as proposed
export interface StoredBatch {
  start: number; // rows[start, end)
  end: number;
  proposalId: number | null;
  file?: string; // batch file it came from (zip / CSV import)
  submittedAt?: number; // sent from a contract wallet (Safe): queued there, proposal id not known yet
  safeTxHash?: string; // the Safe's own hash for the propose tx (followed via the Safe API on mainnet)
  safe?: string; // the Safe that queued it
  safeActions?: { kind: 'approve' | 'execute'; hash: string; safe: string; at: number }[]; // approve / execute queued in a Safe
  proposeTx?: string; // tx that created the proposal (same as execTx when it minted at once)
  execTx?: string; // tx that minted this batch's vouchers
  completedAt?: number; // block time of that tx: every row's voucher found minted to its wallet
  // what this batch was proposed with (from the form at that moment); unset until proposed from here
  token?: string;
  startDate?: number;
  expiryDate?: number;
  fromTs?: number; // earliest time its proposal can exist (when it was proposed from this page): bounds log searches
}
export interface StoredUpload {
  id: string;
  chainId: number;
  dao: string; // VoucherDAO address (lowercase)
  typeId: number;
  // form values when the upload was saved — informational only: proposals use the form's values at
  // propose time and record them on the batch
  token: string;
  startDate: number;
  expiryDate: number;
  createdAt: number; // unix seconds, when it was proposed from this page (0 = added from on-chain)
  name: string;
  source?: string; // imported file name
  rows: StoredRow[];
  batches: StoredBatch[];
  minted?: Record<number, string[]>; // proposalId -> voucher ids in row order
  // claim state per voucher id from the last "Check claims" (claimed / revoked are final on-chain,
  // so those are never re-read); claimsAt = when that check ran
  claims?: Record<string, { claimed: boolean; revoked: boolean; owner: string | null }>;
  claimsAt?: number;
}

const DB = 'dg_voucherV2';
const STORE = 'bulkUploads';
const memory = new Map<string, StoredUpload>(); // used when IndexedDB is unavailable (private window etc.)

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listUploads(chainId: number, dao: string): Promise<StoredUpload[]> {
  const all = ((await tx<StoredUpload[]>('readonly', (s) => s.getAll() as IDBRequest<StoredUpload[]>)) ?? Array.from(memory.values()));
  return all
    .filter((u) => u.chainId === chainId && u.dao === dao.toLowerCase())
    .sort((a, b) => b.createdAt - a.createdAt || (b.batches[0]?.proposalId ?? 0) - (a.batches[0]?.proposalId ?? 0));
}

export async function saveUpload(u: StoredUpload): Promise<void> {
  const copy: StoredUpload = JSON.parse(JSON.stringify({ ...u, dao: u.dao.toLowerCase() }));
  memory.set(copy.id, copy);
  await tx('readwrite', (s) => s.put(copy));
}

export async function deleteUpload(id: string): Promise<void> {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

export const newUploadId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Take rows out of their batches before those are sent (indexes into `u.rows`) and move them into a
 * new batch per source file at the end of the upload — "<file> — removed wallets", not proposed — so
 * they stay tracked: propose it later, or Remove that batch. Batch ranges shift; a batch left empty
 * is dropped. Only for batches not yet sent (their content is what the on-chain match compares).
 * Returns the new upload and, per old batch index, its new index (-1 = dropped).
 */
export function removeRows(u: StoredUpload, rowIdxs: number[]): { upload: StoredUpload; batchMap: number[] } {
  const drop = new Set(rowIdxs);
  const rows: StoredRow[] = [];
  const batchMap: number[] = [];
  const batches: StoredBatch[] = [];
  const moved = new Map<string, StoredRow[]>(); // source file -> removed rows, in order
  u.batches.forEach((b, bi) => {
    const keep: StoredRow[] = [];
    for (let i = b.start; i < b.end; i++) {
      if (!drop.has(i)) keep.push(u.rows[i]);
      else {
        const key = b.file ?? `batch ${bi + 1}`;
        moved.set(key, [...(moved.get(key) || []), u.rows[i]]);
      }
    }
    if (!keep.length) { batchMap.push(-1); return; }
    batchMap.push(batches.length);
    batches.push({ ...b, start: rows.length, end: rows.length + keep.length });
    rows.push(...keep);
  });
  for (const [file, r] of Array.from(moved.entries())) {
    batches.push({ start: rows.length, end: rows.length + r.length, proposalId: null, file: `${file} — removed wallets` });
    rows.push(...r);
  }
  return { upload: { ...u, rows, batches }, batchMap };
}
