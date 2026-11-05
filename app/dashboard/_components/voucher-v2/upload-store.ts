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
}
export interface StoredUpload {
  id: string;
  chainId: number;
  dao: string; // VoucherDAO address (lowercase)
  typeId: number;
  token: string;
  startDate: number;
  expiryDate: number;
  createdAt: number; // unix seconds, when it was proposed from this page (0 = added from on-chain)
  name: string;
  source?: string; // imported file name
  rows: StoredRow[];
  batches: StoredBatch[];
  minted?: Record<number, string[]>; // proposalId -> voucher ids in row order
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
