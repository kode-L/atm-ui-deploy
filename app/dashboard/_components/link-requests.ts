'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { involves, type LinkRecord, type IndexMeta } from '@/lib/contracts/link/indexer';
import { connectionView, type ConnView } from '@/lib/contracts/link/view';

// Requests waiting on the connected wallet — someone wants to connect (pending link where we
// are userB) or the other side asked to disconnect — and which of them are new since the user
// last looked. "Seen" is per chain + wallet in localStorage. Keys include the link's last
// activity block, so a request that is withdrawn and made again shows up as new again.

export type RequestKind = 'connect' | 'disconnect';
export interface IncomingRequest { key: string; kind: RequestKind; view: ConnView }

const storeKey = (chainId: number, wallet: string) => `dg_linkSeen:${chainId}:${wallet.toLowerCase()}`;

export function incomingRequests(records: LinkRecord[], wallet: string, nowSec = Date.now() / 1000): IncomingRequest[] {
  if (!wallet) return [];
  const out: IncomingRequest[] = [];
  for (const r of records) {
    if (!r.known || !involves(r, wallet)) continue;
    const v = connectionView(r, wallet, nowSec);
    const kind: RequestKind | null = v.state === 'pendingIncoming' ? 'connect' : v.state === 'cancellationRequestIncoming' ? 'disconnect' : null;
    if (kind) out.push({ key: `${r.address.toLowerCase()}:${kind}:${r.lastActivityBlock}`, kind, view: v });
  }
  return out;
}

export function useLinkRequests(chainId: number, wallet: string, records: LinkRecord[], meta: IndexMeta | null | undefined, syncing: boolean) {
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const loadedFor = useRef('');
  const current = useMemo(() => incomingRequests(records, wallet), [records, wallet]);
  // Only trust the list once the index has completed a sync — before that it may be partial.
  const ready = !!meta && meta.syncedAt > 0 && !syncing;

  useEffect(() => {
    const id = `${chainId}:${wallet.toLowerCase()}`;
    if (!wallet || loadedFor.current === id) return;
    loadedFor.current = id;
    try {
      const raw = localStorage.getItem(storeKey(chainId, wallet));
      setSeen(raw ? new Set(JSON.parse(raw)) : null);
    } catch { setSeen(null); }
  }, [chainId, wallet]);

  const save = useCallback((s: Set<string>) => {
    setSeen(s);
    try { localStorage.setItem(storeKey(chainId, wallet), JSON.stringify(Array.from(s))); } catch { /* ignore */ }
  }, [chainId, wallet]);

  // First run for this wallet: what's already waiting counts as seen; only later arrivals are "new".
  useEffect(() => {
    if (ready && wallet && seen === null) save(new Set(current.map((c) => c.key)));
  }, [ready, wallet, seen, current, save]);

  const fresh = seen ? current.filter((c) => !seen.has(c.key)) : [];
  const newKeys = useMemo(() => new Set(fresh.map((c) => c.key)), [fresh.map((c) => c.key).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Mark everything waiting now as seen (keeps the stored set to current requests only). */
  const markAllSeen = useCallback(() => save(new Set(current.map((c) => c.key))), [current, save]);

  return {
    current,
    newKeys,
    newConnect: fresh.filter((c) => c.kind === 'connect').length,
    newDisconnect: fresh.filter((c) => c.kind === 'disconnect').length,
    waitingConnect: current.filter((c) => c.kind === 'connect').length,
    waitingDisconnect: current.filter((c) => c.kind === 'disconnect').length,
    markAllSeen,
  };
}

export type LinkRequests = ReturnType<typeof useLinkRequests>;
