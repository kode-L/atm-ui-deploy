'use client';
import React, { useEffect, useState } from 'react';
import { Book, emptyBook, parseBookImport, sameAddr, shortAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { btnCls, btnDangerCls, btnSecondaryCls, inputCls } from './ui';

// Test-contract sets: quick switching between deployments on TEST networks only.
// Built-in: the shared BSC testnet set (voucher repo deployments/bscTestnet.all-conditions.json),
// published as public/examples/voucher-v2-bsc-testnet.json. Plus any sets the user saves
// from the current address book (kept per chain in this browser).
export const TEST_CHAINS = new Set([97, 31337]);
export const SHARED_TESTNET_CHAIN = 97;
export const SHARED_TESTNET_NFT = '0xA1010B445db17C3d754B048dd40Cae4471290170';
const SHARED_TESTNET_URL = '/examples/voucher-v2-bsc-testnet.json';
const SHARED_ID = 'shared';

export async function fetchSharedTestnetBook(chainId: number): Promise<Book> {
  const res = await fetch(SHARED_TESTNET_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the shared testnet set (HTTP ${res.status})`);
  return parseBookImport(await res.text(), chainId);
}

interface SavedSet { id: string; name: string; savedAt: string; book: Book }
const setsKey = (chainId: number) => `dg_voucherV2TestSets:${chainId}`;
function loadSets(chainId: number): SavedSet[] {
  try {
    return JSON.parse(localStorage.getItem(setsKey(chainId)) || '[]') as SavedSet[];
  } catch {
    return [];
  }
}
function storeSets(chainId: number, sets: SavedSet[]) {
  try {
    localStorage.setItem(setsKey(chainId), JSON.stringify(sets));
  } catch {
    // storage unavailable — sets last for this session only
  }
}

/** Test networks only: pick a test-contract set and load it into the address book in one click. */
export function TestSetsBar() {
  const ctx = useVoucherV2();
  const [sets, setSets] = useState<SavedSet[]>([]);
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isTest = TEST_CHAINS.has(ctx.chainId);
  const hasShared = ctx.chainId === SHARED_TESTNET_CHAIN;

  useEffect(() => {
    if (!isTest) return;
    setSets(loadSets(ctx.chainId));
    setMsg(null);
  }, [ctx.chainId, isTest]);

  if (!isTest) return null;

  const nft = ctx.book.contracts.VoucherNFT;
  const activeSaved = sets.find((s) => sameAddr(s.book.contracts.VoucherNFT, nft));
  const activeName = !nft ? 'none (address book is empty)'
    : hasShared && sameAddr(nft, SHARED_TESTNET_NFT) ? 'Shared BSC testnet set'
    : activeSaved ? activeSaved.name
    : `unsaved book (VoucherNFT ${shortAddr(nft)})`;
  const options = [
    ...(hasShared ? [{ id: SHARED_ID, label: `Shared BSC testnet set (VoucherNFT ${shortAddr(SHARED_TESTNET_NFT)})` }] : []),
    ...sets.map((s) => ({ id: s.id, label: `${s.name} (VoucherNFT ${shortAddr(s.book.contracts.VoucherNFT || '')})` })),
  ];
  const selected = pick && options.some((o) => o.id === pick) ? pick : options[0]?.id || '';

  const save = (name: string, book: Book, list = sets) => {
    const next = [...list.filter((s) => !sameAddr(s.book.contracts.VoucherNFT, book.contracts.VoucherNFT)), { id: `${Date.now()}`, name, savedAt: new Date().toISOString(), book }];
    storeSets(ctx.chainId, next);
    setSets(next);
    return next;
  };

  const doSave = () => {
    if (!nft) return setMsg({ ok: false, text: 'Nothing to save: the address book has no contracts.' });
    const name = window.prompt('Name for this test set:', activeSaved?.name || `My test set ${new Date().toLocaleDateString()}`);
    if (!name?.trim()) return;
    save(name.trim(), ctx.book);
    setMsg({ ok: true, text: `Saved "${name.trim()}".` });
  };

  const doLoad = async () => {
    try {
      const book = selected === SHARED_ID ? await fetchSharedTestnetBook(ctx.chainId) : sets.find((s) => s.id === selected)?.book;
      if (!book) return;
      // never lose the current addresses: keep an unsaved, non-shared book as a backup set first
      const isShared = hasShared && sameAddr(nft, SHARED_TESTNET_NFT);
      if (nft && !activeSaved && !isShared) save(`Backup ${new Date().toLocaleString()}`, ctx.book);
      ctx.replaceBook({ ...emptyBook(), ...book });
      setMsg({ ok: true, text: `Loaded ${options.find((o) => o.id === selected)?.label}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const doDelete = () => {
    const s = sets.find((x) => x.id === selected);
    if (!s || !window.confirm(`Delete the saved set "${s.name}" from this browser? The contracts on-chain are not affected.`)) return;
    const next = sets.filter((x) => x.id !== s.id);
    storeSets(ctx.chainId, next);
    setSets(next);
    setPick('');
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-surface-secondary p-3 text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-txt-primary">Test contracts</span>
        <span className="text-[10px] uppercase tracking-wider text-yellow-300 border border-yellow-300/40 rounded px-1.5">testnet only</span>
        <span className="text-txt-secondary">Active: <span className="text-txt-primary">{activeName}</span></span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputCls} max-w-md`} value={selected} onChange={(e) => setPick(e.target.value)} disabled={!options.length}>
          {!options.length && <option value="">No saved sets yet: deploy or import, then Save current</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <button className={btnCls} onClick={doLoad} disabled={!selected}>Load</button>
        <button className={btnSecondaryCls} onClick={doSave} disabled={!nft}>Save current as…</button>
        {selected && selected !== SHARED_ID && <button className={btnDangerCls} onClick={doDelete}>Delete</button>}
      </div>
      {msg && <p className={msg.ok ? 'text-green-300' : 'text-red-300'}>{msg.text}</p>}
    </div>
  );
}
