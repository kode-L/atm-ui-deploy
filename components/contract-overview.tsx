'use client';
// Overview shown at the top of every dashboard section: the contracts that section works with,
// each with its version and implementation READ LIVE FROM THE CHAIN - so the page always tells you
// which version is actually deployed (rule: every section/contract shows its on-chain version).
import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Layers, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import { getExplorerAddressUrl } from '@/lib/contracts/config';

export interface OverviewItem { label: string; address: string; note?: string }

interface Live { code: boolean; version: string; implementation: string; loading: boolean }

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967 implementation
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'; // EIP-1967 beacon
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const slotAddr = (v: string) => (v && v !== ethers.constants.HashZero ? ethers.utils.getAddress('0x' + v.slice(26)) : '');

export async function readContractLive(provider: ethers.providers.Provider, address: string): Promise<Omit<Live, 'loading'>> {
  const code = await provider.getCode(address).catch(() => '0x');
  if (!code || code === '0x') return { code: false, version: '', implementation: '' };
  let version = '';
  for (const fn of ['version', 'VERSION']) {
    try {
      version = await new ethers.Contract(address, [`function ${fn}() view returns (string)`], provider)[fn]();
      if (version) break;
    } catch { /* no such getter */ }
  }
  let implementation = slotAddr(await provider.getStorageAt(address, IMPL_SLOT).catch(() => ''));
  if (!implementation) {
    // beacon proxy (e.g. every operator DailySessionManager): implementation comes from the beacon
    const beacon = slotAddr(await provider.getStorageAt(address, BEACON_SLOT).catch(() => ''));
    if (beacon) {
      implementation = await new ethers.Contract(beacon, ['function implementation() view returns (address)'], provider)
        .implementation().catch(() => '');
    }
  }
  return { code: true, version, implementation };
}

export default function ContractOverview({ items, provider, chainId, title = 'Overview' }: {
  items: OverviewItem[]; provider: ethers.providers.Provider | null | undefined; chainId: number; title?: string;
}) {
  const [live, setLive] = useState<Record<string, Live>>({});
  const [copied, setCopied] = useState('');
  const [nonce, setNonce] = useState(0);
  const valid = items.filter(i => i.address && ethers.utils.isAddress(i.address));
  const key = valid.map(i => i.address.toLowerCase()).join(',');

  useEffect(() => {
    if (!provider || !valid.length) return;
    let cancelled = false;
    setLive(Object.fromEntries(valid.map(i => [i.address.toLowerCase(), { code: false, version: '', implementation: '', loading: true }])));
    Promise.all(valid.map(async i => [i.address.toLowerCase(), { ...(await readContractLive(provider, i.address)), loading: false }] as const))
      .then(rows => { if (!cancelled) setLive(Object.fromEntries(rows)); });
    return () => { cancelled = true; };
  }, [provider, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return null;
  const copy = (a: string) => { navigator.clipboard?.writeText?.(a); setCopied(a); setTimeout(() => setCopied(''), 1500); };

  return (
    <div className="bg-surface-secondary rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold"><Layers className="w-4 h-4 text-accent" /> {title}</div>
        <button onClick={() => setNonce(n => n + 1)} className="flex items-center gap-1 text-[11px] text-txt-secondary hover:text-accent">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {items.map(i => {
          const ok = i.address && ethers.utils.isAddress(i.address);
          const l = ok ? live[i.address.toLowerCase()] : undefined;
          return (
            <div key={i.label + i.address} className="bg-surface-tertiary rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-txt-primary">{i.label}</span>
                <span className={`font-mono ${l?.version ? 'text-accent font-semibold' : 'text-txt-secondary'}`}>
                  {!ok ? '' : l?.loading ? '…' : !l?.code ? 'no contract' : l.version ? (l.version.startsWith('v') ? l.version : `v${l.version}`) : 'no version()'}
                </span>
              </div>
              {ok ? (
                <div className="flex items-center gap-1 mt-0.5 text-txt-secondary">
                  <code className="font-mono">{short(i.address)}</code>
                  <button onClick={() => copy(i.address)}>{copied === i.address ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}</button>
                  <a href={getExplorerAddressUrl(chainId, i.address)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
                  {l?.implementation && <span className="ml-auto" title={l.implementation}>impl {short(l.implementation)}</span>}
                </div>
              ) : (
                <p className="mt-0.5 text-yellow-400/80">not set for this network</p>
              )}
              {i.note && <p className="mt-0.5 text-[10px] text-txt-secondary">{i.note}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
