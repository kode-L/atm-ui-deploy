'use client';
// Voucher V2 -> Overview: the contract set as it is ON-CHAIN right now, read live from VoucherNFT
// (registry, every voucher type's pool / revoke vault / transfer gate, the tokens each pool pays),
// compared with chain.json's voucherV2 entry for this network:
//   - "New on-chain": used on-chain but not in chain.json -> add it in the next commit
//   - "Not found on-chain": in chain.json but no longer used / no contract -> remove it
// "Copy for chain.json" gives the up-to-date voucherV2 object to paste.
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import Card from '@/components/card';
import { getExplorerAddressUrl, chainVoucherV2 } from '@/lib/contracts/config';
import { readContractLive } from '@/components/contract-overview';
import VoucherNFTArtifact from '@/lib/contracts/voucher-v2/VoucherNFT.json';
import SourceRegistryArtifact from '@/lib/contracts/voucher-v2/SourceRegistry.json';
import { useVoucherV2 } from './context';

const ZERO = ethers.constants.AddressZero;
const STANDARDS = ['Native', 'ERC20', 'ERC721', 'ERC1155'];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

interface PoolInfo { address: string; types: number[]; standards: Set<string>; tokens: Map<string, string>; version: string }
interface OnChain {
  voucherNFT: string;
  sourceRegistry: string;
  typeCount: number;
  pools: PoolInfo[];
  revokeDestinations: string[];
  transferGates: string[];
  registryRewardVaults: string[];
  registryPointsLedgers: string[];
  versions: Record<string, string>;
}

export default function ChainSetCard() {
  const ctx = useVoucherV2();
  const provider = ctx.reader;
  const known = chainVoucherV2(ctx.chainId);
  const nftAddr = ctx.book.contracts.VoucherNFT || known.contracts.VoucherNFT || '';
  const [data, setData] = useState<OnChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    if (!provider || !nftAddr || !ethers.utils.isAddress(nftAddr)) return;
    setLoading(true); setErr('');
    try {
      const nft = new ethers.Contract(nftAddr, VoucherNFTArtifact.abi, provider);
      const sourceRegistry: string = await nft.sourceRegistry().catch(() => ZERO);
      const n = Number(await nft.nextTypeId());
      const pools = new Map<string, PoolInfo>();
      const revokes = new Set<string>(), gates = new Set<string>();
      for (let i = 0; i < n; i++) {
        const t = await nft.voucherTypes(i);
        const target: string = t[10], standard = STANDARDS[Number(t[6])] || '?', mode = Number(t[5]);
        if (t[14] !== ZERO) revokes.add(t[14]);
        if (t[13] !== ZERO) gates.add(t[13]);
        if (target === ZERO) continue;
        const key = target.toLowerCase();
        if (!pools.has(key)) pools.set(key, { address: target, types: [], standards: new Set(), tokens: new Map(), version: '' });
        const p = pools.get(key)!;
        p.types.push(i);
        p.standards.add(mode === 0 ? 'Points' : standard);
        if (mode === 1) {
          const toks: string[] = await nft.getApprovedTokens(i).catch(() => []);
          for (const tk of toks) {
            if (p.tokens.has(tk.toLowerCase())) continue;
            const sym = tk === ZERO ? 'BNB'
              : await new ethers.Contract(tk, ['function symbol() view returns (string)'], provider).symbol().catch(() => short(tk));
            p.tokens.set(tk.toLowerCase(), sym);
          }
          if (standard === 'Native' && !toks.length) p.tokens.set(ZERO, 'BNB');
        }
      }
      let registryRewardVaults: string[] = [], registryPointsLedgers: string[] = [];
      if (sourceRegistry !== ZERO) {
        const reg = new ethers.Contract(sourceRegistry, SourceRegistryArtifact.abi, provider);
        const lists = await Promise.all([0, 1, 2, 3].map(s => reg.getApprovedRewardVaults(s).catch(() => [])));
        registryRewardVaults = Array.from(new Set(lists.flat() as string[]));
        registryPointsLedgers = await reg.getApprovedPointsLedgers().catch(() => []);
      }
      const all = [nftAddr, sourceRegistry, ...pools.keys(), ...revokes, ...gates].filter(a => a && a !== ZERO);
      const versions: Record<string, string> = {};
      await Promise.all(all.map(async a => { versions[a.toLowerCase()] = (await readContractLive(provider, ethers.utils.getAddress(a))).version; }));
      setData({
        voucherNFT: nftAddr, sourceRegistry, typeCount: n,
        pools: Array.from(pools.values()), revokeDestinations: Array.from(revokes), transferGates: Array.from(gates),
        registryRewardVaults, registryPointsLedgers, versions,
      });
    } catch (e: any) {
      setErr(e?.message?.slice(0, 160) || String(e));
    } finally {
      setLoading(false);
    }
  }, [provider, nftAddr, ctx.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // ---- compare with chain.json ----
  const listed = new Map<string, string>(); // address -> name in chain.json
  Object.entries(known.contracts).forEach(([k, a]) => a && listed.set(a.toLowerCase(), k));
  known.pools.forEach(p => listed.set(p.address.toLowerCase(), `pool ${p.name || short(p.address)}`));
  const onChain = new Map<string, string>();
  if (data) {
    onChain.set(data.voucherNFT.toLowerCase(), 'VoucherNFT');
    if (data.sourceRegistry !== ZERO) onChain.set(data.sourceRegistry.toLowerCase(), 'SourceRegistry');
    data.pools.forEach(p => onChain.set(p.address.toLowerCase(), `pool (types ${p.types.join(', ')})`));
    data.revokeDestinations.forEach(a => onChain.set(a.toLowerCase(), 'revoke destination'));
    data.transferGates.forEach(a => onChain.set(a.toLowerCase(), 'transfer gate'));
    data.registryRewardVaults.forEach(a => !onChain.has(a.toLowerCase()) && onChain.set(a.toLowerCase(), 'registry-approved reward vault'));
    data.registryPointsLedgers.forEach(a => !onChain.has(a.toLowerCase()) && onChain.set(a.toLowerCase(), 'registry-approved points ledger'));
  }
  const newOnChain = data ? Array.from(onChain.entries()).filter(([a]) => !listed.has(a)) : [];
  // contracts VoucherNFT doesn't reference (DAO, Views, VoucherTransfer...) can't be "found" this way -
  // only pools are expected to be referenced by a type
  const notFound = data ? known.pools.filter(p => !onChain.has(p.address.toLowerCase())).map(p => p.address) : [];

  const chainJson = data ? JSON.stringify({
    contracts: {
      ...known.contracts,
      VoucherNFT: data.voucherNFT,
      ...(data.sourceRegistry !== ZERO ? { SourceRegistry: data.sourceRegistry } : {}),
    },
    pools: data.pools.map(p => ({
      address: p.address,
      name: known.pools.find(k => same(k.address, p.address))?.name || '',
      types: p.types,
      tokens: Array.from(p.tokens.entries()).map(([address, symbol]) => ({ address: address === ZERO ? ZERO : ethers.utils.getAddress(address), symbol })),
    })),
  }, null, 2) : '';

  const copy = (text: string, k: string) => { navigator.clipboard?.writeText?.(text); setCopied(k); setTimeout(() => setCopied(''), 1500); };
  const addr = (a: string) => (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono">{short(a)}</code>
      <button onClick={() => copy(a, a)}>{copied === a ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}</button>
      <a href={getExplorerAddressUrl(ctx.chainId, a)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
    </span>
  );
  const ver = (a: string) => { const v = data?.versions[a.toLowerCase()]; return v ? <span className="text-accent font-mono">{v.startsWith('v') ? v : `v${v}`}</span> : null; };

  if (!nftAddr) return null;
  return (
    <Card title={<span className="flex items-center gap-2">On-chain set <button onClick={load} disabled={loading}><RefreshCw className={`w-4 h-4 text-txt-secondary ${loading ? 'animate-spin' : ''}`} /></button></span>}>
      <p className="text-[11px] text-txt-secondary mb-3">Read live from VoucherNFT on this network and checked against chain.json.</p>
      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
      {data && (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="bg-surface-tertiary rounded-lg p-2 flex justify-between"><span>VoucherNFT · {data.typeCount} types</span><span className="flex gap-2">{ver(data.voucherNFT)}{addr(data.voucherNFT)}</span></div>
            <div className="bg-surface-tertiary rounded-lg p-2 flex justify-between"><span>SourceRegistry</span>{data.sourceRegistry !== ZERO ? <span className="flex gap-2">{ver(data.sourceRegistry)}{addr(data.sourceRegistry)}</span> : <span className="text-txt-secondary">none</span>}</div>
            {data.revokeDestinations.map(a => <div key={a} className="bg-surface-tertiary rounded-lg p-2 flex justify-between"><span>Revoke destination</span><span className="flex gap-2">{ver(a)}{addr(a)}</span></div>)}
            {data.transferGates.map(a => <div key={a} className="bg-surface-tertiary rounded-lg p-2 flex justify-between"><span>Transfer gate</span><span className="flex gap-2">{ver(a)}{addr(a)}</span></div>)}
          </div>
          <div>
            <p className="font-semibold mb-1">Pools ({data.pools.length}) — tokens each one pays</p>
            <div className="space-y-2">
              {data.pools.map(p => (
                <div key={p.address} className="bg-surface-tertiary rounded-lg p-2">
                  <div className="flex justify-between items-center gap-2">
                    <span>{known.pools.find(k => same(k.address, p.address))?.name || 'Pool'} <span className="text-txt-secondary">· types {p.types.join(', ')} · {Array.from(p.standards).join(' / ')}</span></span>
                    <span className="flex gap-2">{ver(p.address)}{addr(p.address)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.tokens.size === 0 && <span className="text-txt-secondary">{p.standards.has('Points') ? 'points (no token)' : 'no approved tokens'}</span>}
                    {Array.from(p.tokens.entries()).map(([a, sym]) => (
                      <span key={a} title={a} className="px-2 py-0.5 rounded-full bg-accent/15 text-accent font-medium">{sym}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {(newOnChain.length > 0 || notFound.length > 0) ? (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2 space-y-1">
              <p className="font-semibold text-yellow-300">chain.json is out of date for this network</p>
              {newOnChain.map(([a, what]) => <p key={a}>➕ New on-chain: {what} {addr(ethers.utils.getAddress(a))}</p>)}
              {notFound.map(a => <p key={a}>➖ Not used on-chain anymore: {addr(a)}</p>)}
              <button onClick={() => copy(chainJson, 'json')} className="mt-1 underline hover:text-accent">{copied === 'json' ? 'Copied ✔' : 'Copy updated voucherV2 for chain.json'}</button>
            </div>
          ) : (
            <p className="text-green-400">✓ chain.json matches what is on-chain.</p>
          )}
        </div>
      )}
    </Card>
  );
}
