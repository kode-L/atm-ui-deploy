'use client';
// Operators block for the section Overview. Starts instantly from chain.json's operators
// (name -> operator address), then checks GameHub on-chain as soon as the UI loads:
//   - the list shown is the on-chain one (an operator removed on-chain drops out),
//   - new on-chain operators appear, and any difference is flagged so chain.json gets updated
//     in the next commit.
import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Users, ExternalLink } from 'lucide-react';
import { getExplorerAddressUrl, chainOperators } from '@/lib/contracts/config';

interface Op { name: string; operator: string; dsm: string; active: boolean | null }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const HUB_ABI = [
  'function getOperators() view returns (address[])',
  'function getOperatorRecord(address) view returns (tuple(address instance,bool active,uint256 registeredAt,string name))',
];

export default function OperatorsOverview({ provider, chainId, hubAddress }: {
  provider: ethers.providers.Provider | null | undefined; chainId: number; hubAddress: string;
}) {
  const known = chainOperators(chainId);
  const [ops, setOps] = useState<Op[]>(known.map(k => ({ name: k.name, operator: k.address, dsm: '', active: null })));
  const [checked, setChecked] = useState(false);
  const [removed, setRemoved] = useState<{ name: string; operator: string }[]>([]);
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    setOps(known.map(k => ({ name: k.name, operator: k.address, dsm: '', active: null })));
    setChecked(false); setRemoved([]); setAdded([]);
    if (!provider || !hubAddress || !ethers.utils.isAddress(hubAddress)) return;
    let cancelled = false;
    (async () => {
      try {
        const hub = new ethers.Contract(hubAddress, HUB_ABI, provider);
        const list: string[] = await hub.getOperators();
        const live: Op[] = await Promise.all(list.map(async op => {
          const rec = await hub.getOperatorRecord(op);
          return { name: rec.name, operator: op, dsm: rec.instance, active: rec.active };
        }));
        if (cancelled) return;
        const has = (a: string, arr: { operator?: string; address?: string }[]) => arr.some(x => (x.operator || x.address || '').toLowerCase() === a.toLowerCase());
        setOps(live);
        setRemoved(known.filter(k => !has(k.address, live)).map(k => ({ name: k.name, operator: k.address })));
        setAdded(live.filter(l => !has(l.operator, known)).map(l => l.operator));
        setChecked(true);
      } catch { /* keep the chain.json list */ }
    })();
    return () => { cancelled = true; };
  }, [provider, chainId, hubAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ops.length && !checked) return null;
  return (
    <div className="bg-surface-tertiary rounded-lg px-3 py-2 text-xs mt-2">
      <div className="flex items-center gap-2 font-medium mb-1">
        <Users className="w-3.5 h-3.5 text-accent" /> Operators ({ops.length})
        <span className="text-[10px] text-txt-secondary font-normal">{checked ? 'checked on-chain' : 'from chain.json — checking on-chain…'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1">
        {ops.map(o => (
          <div key={o.operator} className="flex items-center gap-2">
            <span className={o.active === false ? 'text-txt-secondary line-through' : 'text-txt-primary'}>{o.name}</span>
            <a href={getExplorerAddressUrl(chainId, o.operator)} target="_blank" rel="noopener noreferrer" className="font-mono text-txt-secondary hover:text-accent inline-flex items-center gap-0.5">
              {short(o.operator)}<ExternalLink className="w-2.5 h-2.5" />
            </a>
            {o.dsm && <span className="text-txt-secondary">DSM {short(o.dsm)}</span>}
            {o.active === false && <span className="text-[10px] text-yellow-400">inactive</span>}
          </div>
        ))}
      </div>
      {checked && (removed.length > 0 || added.length > 0) && (
        <p className="text-[11px] text-yellow-300 mt-1">
          chain.json is out of date:{' '}
          {added.length > 0 && <>new on-chain {added.map(short).join(', ')}{removed.length ? '; ' : ''}</>}
          {removed.length > 0 && <>no longer on-chain {removed.map(r => `${r.name} ${short(r.operator)}`).join(', ')}</>}
          {' '}— update &quot;operators&quot; in chain.json.
        </p>
      )}
    </div>
  );
}
