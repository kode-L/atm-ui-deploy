'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { ArrowLeft, ArrowRight, ExternalLink, Download, Bell, RefreshCw, Loader2 } from 'lucide-react';
import { usePager, Pager } from './link-pager';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { getExplorerAddressUrl, getExplorerTxUrl } from '@/lib/contracts/config';
import { UtcTime } from '@/components/utc-datetime';
import { inputCls, Badge } from './voucher-v2/ui';
import { ERC20_ABI, ZERO, downloadCsv } from '@/lib/contracts/link';
import { involves } from '@/lib/contracts/link/indexer';
import { connectionView, CONN_ACTIONS, CONN_TONE, type ConnTab, type ConnView } from '@/lib/contracts/link/view';
import type { LinkIndex } from './link-index-panel';
import type { LinkRequests } from './link-requests';

const TABS: { key: ConnTab; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'pending', label: 'Pending' },
  { key: 'inactive', label: 'Inactive' },
];
const short = (a: string) => (a && a !== ZERO ? `${a.slice(0, 6)}…${a.slice(-4)}` : a === ZERO ? 'open link' : '—');
const fmt = (v: ethers.BigNumberish, d: number) => {
  const n = Number(ethers.utils.formatUnits(v, d));
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const isoDay = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ') : '');

function Remaining({ v }: { v: ConnView }) {
  if (v.daysRemaining === null) return <span className="text-txt-secondary">starts on accept</span>;
  if (v.tab === 'inactive') return <span className="text-txt-secondary">—</span>;
  if (v.daysRemaining <= 0) return <span className="text-green-300">expired {Math.abs(v.daysRemaining)}d ago</span>;
  return <span className={v.daysRemaining <= 7 ? 'text-yellow-300' : ''}>{v.daysRemaining}d left</span>;
}

/**
 * Connection list for one wallet, like atm-prod's Consensus Connection page (Active / Pending /
 * Inactive, same status labels) — built only from the on-chain index, so dates and expiry are
 * the contract's own startTime / expiredTime / closeTime. Any wallet can be looked up.
 */
export default function LinkConnections({ index, requests, onGo }: { index: LinkIndex; requests: LinkRequests; onGo: (tab: 'accept' | 'approve' | 'disconnect') => void }) {
  const { provider, address, netChainId } = useWeb3();
  const [walletInput, setWalletInput] = useState('');
  const [tab, setTab] = useState<ConnTab>('active');
  const [query, setQuery] = useState('');
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now() / 1000);

  // Countdown/expiry re-evaluated every minute (expiry has no on-chain event).
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 60_000); return () => clearInterval(id); }, []);

  const wallet = ethers.utils.isAddress(walletInput.trim()) ? walletInput.trim() : address;
  const isSelf = !!address && wallet.toLowerCase() === address.toLowerCase(); // "new" tracking is for the connected wallet

  // Opening Pending marks new requests as seen, but they stay highlighted until you leave the tab.
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const newLinks = useMemo(() => new Set(Array.from(requests.newKeys).map((k) => k.split(':')[0])), [requests.newKeys]);
  useEffect(() => {
    if (tab !== 'pending') { setHighlight(new Set()); return; }
    if (isSelf && newLinks.size) {
      setHighlight((h) => new Set([...Array.from(h), ...Array.from(newLinks)]));
      requests.markAllSeen();
    }
  }, [tab, isSelf, newLinks]); // eslint-disable-line react-hooks/exhaustive-deps
  const isNew = (v: ConnView) => isSelf && (highlight.has(v.r.address.toLowerCase()) || newLinks.has(v.r.address.toLowerCase()));
  const newCount = isSelf ? requests.newConnect + requests.newDisconnect : 0;
  const live = index.meta ? index.meta.endBlock === null : false;

  const views = useMemo(() => {
    if (!wallet) return [];
    return index.records
      .filter((r) => r.known && involves(r, wallet))
      .map((r) => connectionView(r, wallet, now))
      .sort((a, b) => b.createdAt - a.createdAt || b.r.createdBlock - a.r.createdBlock);
  }, [index.records, wallet, now]);

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, views.filter((v) => v.tab === t.key).length])) as Record<ConnTab, number>, [views]);
  const q = query.trim().toLowerCase();
  const filtered = views.filter((v) => v.tab === tab && (!q || v.counterparty.toLowerCase().includes(q) || v.r.address.toLowerCase().includes(q) || v.r.symbol.toLowerCase() === q));
  const pager = usePager(filtered, `${tab}|${q}|${wallet}|${netChainId}`);
  const rows = pager.rows;

  const tokenKey = Array.from(new Set(views.map((v) => v.r.token.toLowerCase()))).sort().join(',');
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
  const dOf = (t: string) => decimals[t.toLowerCase()] ?? 18;

  const exportTab = () => downloadCsv(`connections_${tab}_${wallet.slice(2, 10).toLowerCase()}_${netChainId}.csv`, [
    ['status', 'direction', 'counterparty', 'symbol', 'my_amount', 'other_amount', 'total', 'lock_days', 'created_at', 'start_time', 'expires_at', 'days_remaining', 'closed_at', 'pledged', 'link', 'create_tx'],
    ...filtered.map((v) => {
      const d = dOf(v.r.token);
      return [v.label, v.direction, v.counterparty, v.r.symbol, ethers.utils.formatUnits(v.myAmount, d), ethers.utils.formatUnits(v.otherAmount, d), ethers.utils.formatUnits(v.total, d),
        v.r.lockDays, isoDay(v.createdAt), isoDay(v.r.startTime), isoDay(v.r.expiredTime), v.daysRemaining ?? '', isoDay(v.r.closeTime), v.pledged ? 'yes' : '', v.r.address, v.r.createdTx];
    }),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button className="flex items-center gap-1.5 bg-surface-tertiary hover:bg-surface-tertiary/70 border border-accent/30 text-accent font-medium px-3 py-1.5 rounded-lg disabled:opacity-40"
          disabled={index.syncing || !index.meta} onClick={() => index.sync()}>
          {index.syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {index.syncing ? 'Refreshing…' : 'Refresh now'}
        </button>
        <span className="text-txt-secondary">
          {index.meta?.syncedAt ? <>Updated <UtcTime localFirst ts={Math.floor(index.meta.syncedAt / 1000)} time inline /></> : 'Not fetched yet'}
          {index.meta && (live ? ' · checks the chain for new requests every minute' : ' · fixed date range — clear the end date in the index panel to keep watching for new requests')}
        </span>
      </div>

      {newCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-red-500/10 border border-red-400/40 rounded-lg px-3 py-2 text-sm">
          <Bell className="w-4 h-4 text-red-300 animate-pulse" />
          <span className="text-red-200">
            {requests.newConnect > 0 && <><b>{requests.newConnect}</b> new connect request{requests.newConnect === 1 ? '' : 's'}</>}
            {requests.newConnect > 0 && requests.newDisconnect > 0 && ' · '}
            {requests.newDisconnect > 0 && <><b>{requests.newDisconnect}</b> new disconnect request{requests.newDisconnect === 1 ? '' : 's'}</>}
          </span>
          <button className="text-accent hover:underline text-xs" onClick={() => setTab('pending')}>view</button>
          <button className="text-accent hover:underline text-xs font-semibold" onClick={() => onGo('accept')}>accept all →</button>
          {requests.newConnect > 0 && <button className="text-accent hover:underline text-xs" onClick={() => onGo('approve')}>approve →</button>}
          {requests.newDisconnect > 0 && <button className="text-accent hover:underline text-xs" onClick={() => onGo('disconnect')}>disconnect →</button>}
          <button className="ml-auto text-xs text-txt-secondary hover:underline" onClick={requests.markAllSeen}>mark all seen</button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-txt-secondary space-y-1 flex-1 min-w-[260px]">Wallet (empty = connected wallet)
          <input className={inputCls} placeholder={address || '0x…'} value={walletInput} onChange={(e) => setWalletInput(e.target.value)} />
        </label>
        <label className="text-xs text-txt-secondary space-y-1 w-64">Search counterparty / link / token
          <input className={inputCls} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="0x… or LUCA" />
        </label>
      </div>
      {walletInput && !ethers.utils.isAddress(walletInput.trim()) && <p className="text-xs text-yellow-300">Not a valid address — showing the connected wallet.</p>}
      {index.meta === null && <p className="text-sm text-yellow-300">Fetch a date range in the index above first — the list is built from it.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium ${tab === t.key ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
              {t.label} <span className="opacity-70">({counts[t.key] ?? 0})</span>
              {t.key === 'pending' && newCount > 0 && tab !== 'pending' && <span className="ml-1.5 rounded-full bg-red-500 text-white px-1.5 text-[10px]">{newCount} new</span>}
            </button>
          ))}
        </div>
        <span className="text-xs text-txt-secondary">{views.length} connections for {short(wallet)}</span>
        {tab === 'pending' && isSelf && requests.current.length > 0 && (
          <button className="text-xs font-semibold text-accent hover:underline" onClick={() => onGo('accept')}>Accept {requests.current.length} incoming in Bulk Accept →</button>
        )}
        <button className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40" disabled={!filtered.length} onClick={exportTab}>
          <Download className="w-3.5 h-3.5" /> export this tab
        </button>
      </div>

      <Pager p={pager} label="connections" />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-txt-secondary text-left"><tr>
              <th className="py-1.5 pr-3">Counterparty</th><th className="pr-3">Amount (mine / total)</th><th className="pr-3">Lock-up</th>
              <th className="pr-3">Created</th><th className="pr-3">Started</th><th className="pr-3">{tab === 'inactive' ? 'Closed' : 'Expires'}</th>
              <th className="pr-3">Remaining</th><th className="pr-3">Status</th><th>Link</th>
            </tr></thead>
            <tbody>
              {rows.map((v) => {
                const d = dOf(v.r.token);
                return (
                  <tr key={v.r.address} className={`border-t border-white/5 align-top ${isNew(v) ? 'bg-red-500/5' : ''}`}>
                    <td className="py-1 pr-3">
                      <span className="flex items-center gap-1.5 font-mono whitespace-nowrap" title={v.direction === 'inbound' ? 'Incoming — they created it' : 'Outgoing — this wallet created it'}>
                        {isNew(v) && <span className="rounded bg-red-500 text-white px-1.5 text-[10px] font-sans animate-pulse">NEW</span>}
                        {v.direction === 'inbound' ? <ArrowLeft className="w-3.5 h-3.5 text-green-400" /> : <ArrowRight className="w-3.5 h-3.5 text-blue-400" />}
                        {v.counterparty && v.counterparty !== ZERO
                          ? <a className="text-accent hover:underline" target="_blank" rel="noopener noreferrer" href={getExplorerAddressUrl(netChainId, v.counterparty)}>{short(v.counterparty)}</a>
                          : short(v.counterparty)}
                      </span>
                    </td>
                    <td className="pr-3 whitespace-nowrap" title={`${v.r.percentA}% / ${100 - v.r.percentA}% split`}>{fmt(v.myAmount, d)} / {fmt(v.total, d)} {v.r.symbol}</td>
                    <td className="pr-3 whitespace-nowrap">{v.r.lockDays} days</td>
                    <td className="pr-3 whitespace-nowrap">{v.r.createdAt ? <UtcTime localFirst ts={v.r.createdAt} /> : v.r.createdBlock ? <span className="text-txt-secondary">block {v.r.createdBlock}</span> : <span className="text-txt-secondary" title="Created before the stored date range — found through later activity">before range</span>}</td>
                    <td className="pr-3 whitespace-nowrap"><UtcTime localFirst ts={v.r.startTime} empty="not accepted" /></td>
                    <td className="pr-3 whitespace-nowrap">{tab === 'inactive' ? <UtcTime localFirst ts={v.r.closeTime} /> : <UtcTime localFirst ts={v.r.expiredTime} empty={`+${v.r.lockDays}d after accept`} />}</td>
                    <td className="pr-3 whitespace-nowrap"><Remaining v={v} /></td>
                    <td className="pr-3">
                      <Badge tone={CONN_TONE[v.state]}>{v.label}{v.pledged ? ' · pledged' : ''}</Badge>
                      {CONN_ACTIONS[v.state] && <div className="text-[10px] text-txt-secondary mt-1">{v.pledged && v.state !== 'pendingIncoming' ? 'depledge first' : CONN_ACTIONS[v.state]}</div>}
                    </td>
                    <td className="whitespace-nowrap">
                      <a className="font-mono text-accent hover:underline inline-flex items-center gap-1" target="_blank" rel="noopener noreferrer" href={getExplorerAddressUrl(netChainId, v.r.address)}>{short(v.r.address)} <ExternalLink className="w-3 h-3" /></a>
                      {v.r.createdTx && <div><a className="text-[10px] text-txt-secondary hover:underline" target="_blank" rel="noopener noreferrer" href={getExplorerTxUrl(netChainId, v.r.createdTx)}>create tx</a></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-txt-secondary">{index.syncing ? 'Index is updating…' : wallet ? `No ${tab} connections for this wallet in the stored range.` : 'Connect a wallet or enter an address.'}</p>
      )}

      <Pager p={pager} label="connections" />
      <p className="text-[11px] text-txt-secondary">
        Times are from the chain: Created = LinkCreated block time, Started = startTime (set on accept), Expires = expiredTime (start + lock days), Closed = closeTime.
        Shown in your local time with UTC underneath. Early redemption = closed before expiry (the contract keeps a 1–15% fee).
      </p>
    </div>
  );
}
