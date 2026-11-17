'use client';
// "DailySessionManagers" group of the section Overview: one DSM contract per operator, each with
// its on-chain version + implementation, labelled with the operator's name and wallet.
// Starts instantly from chain.json's operators ({ dsm, operator } per name), then checks GameHub
// on-chain as soon as the UI loads: the list becomes the on-chain one (removed operators drop out,
// new ones appear) and any difference is flagged so chain.json gets updated in the next commit.
import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { getExplorerAddressUrl, chainOperators } from '@/lib/contracts/config';
import { readContractLive } from '@/components/contract-overview';

interface Row { name: string; operator: string; dsm: string; active: boolean | null; version?: string; implementation?: string; loading?: boolean }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const HUB_ABI = [
  'function getOperators() view returns (address[])',
  'function getOperatorRecord(address) view returns (tuple(address instance,bool active,uint256 registeredAt,string name))',
];

export default function OperatorsOverview({ provider, chainId, hubAddress, selectedDsm }: {
  provider: ethers.providers.Provider | null | undefined; chainId: number; hubAddress: string; selectedDsm?: string;
}) {
  const known = chainOperators(chainId);
  const fromJson = (): Row[] => known.map(k => ({ name: k.name, operator: k.operator, dsm: k.dsm, active: null, loading: true }));
  const [rows, setRows] = useState<Row[]>(fromJson);
  const [checked, setChecked] = useState(false);
  const [diff, setDiff] = useState<{ added: Row[]; removed: Row[] }>({ added: [], removed: [] });
  const [copied, setCopied] = useState('');

  useEffect(() => {
    setRows(fromJson()); setChecked(false); setDiff({ added: [], removed: [] });
    if (!provider) return;
    let cancelled = false;
    (async () => {
      let list: Row[] = fromJson();
      // 1. the on-chain operator list from GameHub (falls back to chain.json if the hub can't be read)
      if (hubAddress && ethers.utils.isAddress(hubAddress)) {
        try {
          const hub = new ethers.Contract(hubAddress, HUB_ABI, provider);
          const ops: string[] = await hub.getOperators();
          const live: Row[] = await Promise.all(ops.map(async op => {
            const rec = await hub.getOperatorRecord(op);
            return { name: rec.name, operator: op, dsm: rec.instance, active: rec.active, loading: true };
          }));
          if (cancelled) return;
          setDiff({
            added: live.filter(l => !known.some(k => same(k.dsm, l.dsm))),
            removed: fromJson().filter(k => !live.some(l => same(l.dsm, k.dsm))),
          });
          list = live;
          setChecked(true);
        } catch { /* keep chain.json's list */ }
      }
      setRows(list);
      // 2. each DSM's version + implementation, live
      const withVersions = await Promise.all(list.map(async r => ({ ...r, ...(await readContractLive(provider, r.dsm)), loading: false })));
      if (!cancelled) setRows(withVersions);
    })();
    return () => { cancelled = true; };
  }, [provider, chainId, hubAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length && !checked) return null;
  const copy = (a: string) => { navigator.clipboard?.writeText?.(a); setCopied(a); setTimeout(() => setCopied(''), 1500); };

  return (
    <div className="mt-2">
      <p className="text-[11px] text-txt-secondary mb-1">
        <abbr title="DailySessionManager" className="no-underline cursor-help">DSMs</abbr> — one DailySessionManager per operator ({rows.length}) · {checked ? 'checked on-chain' : 'from chain.json, checking on-chain…'}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {rows.map(r => {
          const sel = same(r.dsm, selectedDsm);
          return (
            <div key={r.dsm} className={`bg-surface-tertiary rounded-lg px-3 py-2 text-xs ${sel ? 'ring-1 ring-accent/60' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-txt-primary">
                  <abbr title="DailySessionManager" className="no-underline cursor-help">DSM</abbr> · {r.name}
                  {sel && <span className="ml-1 text-[10px] bg-accent/20 text-accent px-1.5 rounded">selected</span>}
                  {r.active === false && <span className="ml-1 text-[10px] text-yellow-400">inactive</span>}
                </span>
                <span className={`font-mono ${r.version ? 'text-accent font-semibold' : 'text-txt-secondary'}`}>
                  {r.loading ? '…' : r.version ? (r.version.startsWith('v') ? r.version : `v${r.version}`) : 'no version()'}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-0.5 text-txt-secondary">
                <code className="font-mono">{short(r.dsm)}</code>
                <button onClick={() => copy(r.dsm)}>{copied === r.dsm ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}</button>
                <a href={getExplorerAddressUrl(chainId, r.dsm)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
                {r.implementation && <span className="ml-auto" title={r.implementation}>impl {short(r.implementation)}</span>}
              </div>
              <p className="mt-0.5 text-[10px] text-txt-secondary">operator <span className="font-mono">{short(r.operator)}</span></p>
            </div>
          );
        })}
      </div>
      {checked && (diff.added.length > 0 || diff.removed.length > 0) && (
        <p className="text-[11px] text-yellow-300 mt-1">
          chain.json is out of date:{' '}
          {diff.added.length > 0 && <>new on-chain {diff.added.map(r => `${r.name} (DSM ${short(r.dsm)})`).join(', ')}{diff.removed.length ? '; ' : ''}</>}
          {diff.removed.length > 0 && <>no longer on-chain {diff.removed.map(r => `${r.name} (DSM ${short(r.dsm)})`).join(', ')}</>}
          {' '}— update &quot;operators&quot; in chain.json.
        </p>
      )}
    </div>
  );
}
