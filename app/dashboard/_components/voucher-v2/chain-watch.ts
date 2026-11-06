import { ethers } from 'ethers';
import { sameAddr } from '@/lib/contracts/voucher-v2';

// Wallets (and RPCs) are often slower to report a transaction than the chain is to include it. While
// a propose is waiting on the wallet, these helpers watch the chain directly and finish as soon as
// the new proposal is there — so the page doesn't sit on a loader for a tx that already landed.

export interface BulkMatch {
  typeId: number;
  recipients: string[];
  faces: string[]; // raw uint strings
  startDate: number;
  expiryDate: number;
  token: string;
}

/** A bulk proposal created at or after id `fromId` that is exactly this batch, else null. */
export async function findNewBulkProposal(dao: ethers.Contract, fromId: number, m: BulkMatch, skip: Set<number> = new Set()): Promise<number | null> {
  const n = (await dao.nextBulkProposalId()).toNumber();
  const want = m.recipients.map((a) => a.toLowerCase()).join(',');
  for (let id = fromId; id < n; id++) {
    if (skip.has(id)) continue;
    const p = await dao.bulkMintProposals(id);
    if (Number(p.typeId) !== m.typeId || Number(p.startDate) !== m.startDate || Number(p.expiryDate) !== m.expiryDate || !sameAddr(p.token, m.token)) continue;
    const recips: string[] = await dao.getBulkMintRecipients(id);
    if (recips.map((a) => a.toLowerCase()).join(',') !== want) continue;
    const faces: ethers.BigNumber[] = await dao.getBulkMintFaceValues(id);
    if (faces.map(String).join(',') === m.faces.join(',')) return id;
  }
  return null;
}

export type Raced<T> = { via: 'wallet'; value: T } | { via: 'chain'; proposalId: number };

/**
 * Resolve with whichever comes first: the wallet's result, or the chain showing the proposal
 * (checked `firstAfterMs` after the click, then every `everyMs`). A wallet error still rejects
 * unless the chain already answered; a late wallet error after that is swallowed.
 */
export function raceWithChain<T>(send: Promise<T>, detect: () => Promise<number | null>, firstAfterMs = 3000, everyMs = 3000): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(); };
    send.then((value) => finish(() => resolve({ via: 'wallet', value })), (e) => finish(() => reject(e)));
    const tick = async () => {
      if (done) return;
      const id = await detect().catch(() => null);
      if (id !== null) finish(() => resolve({ via: 'chain', proposalId: id }));
      else if (!done) timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, firstAfterMs);
  });
}
