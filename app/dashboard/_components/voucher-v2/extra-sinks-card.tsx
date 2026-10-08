'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { getExplorerAddressUrl, BSC_MAINNET } from '@/lib/contracts/config';
import { TokenStandard, ZERO, isAddr, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { Badge, Field, btnCls, btnSecondaryCls, inputCls } from './ui';

// Standards a RewardSink pool can be approved for here (matches the Wire tab's RewardSink step).
const STANDARDS = [
  { value: TokenStandard.Native, label: 'Native' },
  { value: TokenStandard.ERC20, label: 'ERC20' },
];

/** Any number of extra RewardSink pools, each its own proxy — the main one stays contracts.RewardSink. */
export default function ExtraSinksCard({ admin }: { admin: string }) {
  const ctx = useVoucherV2();
  const extras = ctx.book.extraSinks || [];
  const main = ctx.book.contracts.RewardSink;
  const pools = [...(main ? [{ name: 'Main RewardSink', address: main, implementation: '' }] : []), ...extras];
  const [name, setName] = useState('');
  // step 1 → step 2: the implementation the new pool's proxy points at. Prefilled with the main
  // RewardSink's implementation (pools can share one), replaced by a freshly deployed one, or pasted.
  const mainImpl = ctx.book.implementations.RewardSink || '';
  const [impl, setImpl] = useState(mainImpl);
  const [implSource, setImplSource] = useState<'main' | 'new' | 'pasted'>('main');
  // optional: makes this pool check the access control contract before every payout
  const [acl, setAcl] = useState('');
  useEffect(() => { if (implSource === 'main') setImpl(mainImpl); }, [mainImpl, implSource]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // approval per pool per standard, read from the registry VoucherNFT enforces (or the book's)
  const [approved, setApproved] = useState<Record<string, Record<number, boolean>>>({});
  const [registry, setRegistry] = useState('');

  const load = useCallback(async () => {
    if (!ctx.reader || !pools.length) return;
    try {
      const linked: string = ctx.book.contracts.VoucherNFT ? await ctx.read('VoucherNFT').sourceRegistry() : ZERO;
      const regAddr = !sameAddr(linked, ZERO) ? linked : ctx.book.contracts.SourceRegistry || '';
      setRegistry(regAddr);
      if (!regAddr) return;
      const reg = ctx.read('SourceRegistry', regAddr);
      const out: Record<string, Record<number, boolean>> = {};
      for (const x of pools) {
        out[x.address] = {};
        for (const s of STANDARDS) out[x.address][s.value] = await reg.isRewardSinkApproved(s.value, x.address);
      }
      setApproved(out);
    } catch {
      // older registry / unreadable — leave statuses blank
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.reader, ctx.book, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const deploy = () => {
    const n = name.trim();
    if (!n) return setMsg({ ok: false, text: 'Give the pool a name, e.g. "USDT payouts" — it is stored on-chain so pools are easy to tell apart' });
    if (extras.some((x) => x.name.toLowerCase() === n.toLowerCase())) return setMsg({ ok: false, text: `A pool named "${n}" already exists in this book` });
    if (!isAddr(admin)) return setMsg({ ok: false, text: 'Admin address (top of this tab) is not valid' });
    if (ctx.chainId === BSC_MAINNET.chainId && !window.confirm(`Deploy RewardSink "${n}" on BSC MAINNET? This spends real BNB.`)) return;
    if (!isAddr(impl)) return setMsg({ ok: false, text: 'Step 1: deploy an implementation or paste one' });
    if (acl && !isAddr(acl)) return setMsg({ ok: false, text: 'Access control is not a valid address (leave it blank for a plain pool)' });
    run(async () => { await ctx.deployExtraSink(n, admin, impl, acl); setName(''); setAcl(''); }, `RewardSink "${n}" deployed — approve it for the standards it will pay out below`);
  };

  const deployImpl = () => {
    if (ctx.chainId === BSC_MAINNET.chainId && !window.confirm('Deploy a RewardSink implementation on BSC MAINNET? This spends real BNB.')) return;
    run(async () => { const a = await ctx.deployExtraSinkImpl(); setImpl(a); setImplSource('new'); }, 'Implementation deployed — it is filled in step 2');
  };

  const approve = (address: string, poolName: string, standard: { value: number; label: string }) =>
    run(
      () => ctx.send(`Approve RewardSink "${poolName}" (${standard.label})`, ctx.write('SourceRegistry', registry), 'setRewardSinkApproved', [standard.value, address, true, poolName]),
      `"${poolName}" approved for ${standard.label}`,
    );

  return (
    <Card title="Reward pools">
      <p className="text-xs text-txt-secondary mb-3">
        Deploy as many RewardSink pools as you need (e.g. one per token or campaign); each voucher type picks one as its <b>Funding source</b>.
        A pool can be plain or use access control. Points and deferred/routed rewards use VoucherIncentive instead (Deploy tab).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
          <h5 className="text-xs font-semibold">1. Implementation</h5>
          <p className="text-[11px] text-txt-secondary">
            {mainImpl ? 'Uses the main RewardSink\'s implementation by default — pools can share it, so no extra deploy is needed.' : 'Deploy the RewardSink logic contract first.'}
          </p>
          <button className={btnSecondaryCls} disabled={busy} onClick={deployImpl}>Deploy new implementation</button>
        </div>
        <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
          <h5 className="text-xs font-semibold">2. Pool (proxy + initialize)</h5>
          <Field
            label="Implementation address"
            hint={implSource === 'main' && impl ? 'Auto-filled: main RewardSink implementation' : implSource === 'new' ? 'Auto-filled from step 1' : 'Pasted — must be a RewardSink implementation on this network'}
          >
            <input className={inputCls} value={impl} onChange={(e) => { setImpl(e.target.value.trim()); setImplSource('pasted'); }} placeholder="0x… (step 1, or paste one)" />
          </Field>
          <Field label="Pool name" hint="Stored on the contract. Shown in every pool / funding source dropdown.">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "USDT payouts"' />
          </Field>
          <Field label="Access control (optional)" hint="Blank = plain pool. Set it to the access control contract to redirect frozen users and block blacklisted ones; can be changed later (Wire → Advanced).">
            <input className={inputCls} value={acl} onChange={(e) => setAcl(e.target.value.trim())} placeholder="blank = off" />
          </Field>
          <button className={btnCls} disabled={busy || !ctx.book.contracts.VoucherNFT || !isAddr(impl)} onClick={deploy}>{busy ? 'Working…' : 'Deploy pool'}</button>
        </div>
      </div>
      {!ctx.book.contracts.VoucherNFT && <p className="text-xs text-txt-secondary">Deploy VoucherNFT first.</p>}
      <div className="space-y-2">
        {pools.map((x) => (
          <div key={x.address} className="bg-surface-tertiary rounded-lg p-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="font-semibold text-sm">{x.name}</span>
            <a className="font-mono text-accent break-all" href={getExplorerAddressUrl(ctx.chainId, x.address)} target="_blank" rel="noopener noreferrer">{x.address}</a>
            <span className="flex-1" />
            {STANDARDS.map((s) => (
              approved[x.address]?.[s.value]
                ? <Badge key={s.value} tone="good">{s.label} approved</Badge>
                : <button key={s.value} className={btnSecondaryCls} disabled={busy || !registry} onClick={() => approve(x.address, x.name, s)}>Approve for {s.label}</button>
            ))}
          </div>
        ))}
        {!pools.length && <p className="text-xs text-txt-secondary">No pools yet — deploy the main RewardSink on the Deploy tab first.</p>}
      </div>
      {!registry && pools.length > 0 && <p className="text-xs text-yellow-300 mt-2">⚠ Deploy SourceRegistry to approve these pools.</p>}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}
