'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { getExplorerAddressUrl, BSC_MAINNET } from '@/lib/contracts/config';
import { PoolKind, TokenStandard, ZERO, isAddr, poolKind, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { Badge, Field, Select, btnCls, btnSecondaryCls, inputCls } from './ui';

// What each pool type can be approved for in the registry. "points" = setPointsSinkApproved;
// a number = setRewardSinkApproved for that token standard.
type Approval = { id: string; label: string; standard?: number };
const APPROVALS: Record<PoolKind, Approval[]> = {
  RewardSink: [
    { id: 'native', label: 'Native', standard: TokenStandard.Native },
    { id: 'erc20', label: 'ERC20', standard: TokenStandard.ERC20 },
  ],
  VoucherIncentive: [
    { id: 'points', label: 'Points' },
    { id: 'erc20', label: 'ERC20 rewards', standard: TokenStandard.ERC20 },
  ],
};

// set before jumping to Wire so its Advanced section (pool names & access control) opens expanded
export const OPEN_ADVANCED_KEY = 'dg_voucherV2OpenAdvanced';

// The pool types the selector offers. Access control is an optional field for either one.
const POOL_TYPES: { id: string; kind: PoolKind; acl: boolean; label: string; what: string }[] = [
  { id: 'sink', kind: 'RewardSink', acl: false, label: 'RewardSink', what: 'Holds the reward tokens and pays them on claim (Native / ERC20) to the claimer or the type’s fixed payout recipient. Add an access control contract below if payouts should be checked.' },
  { id: 'incentive', kind: 'VoucherIncentive', acl: false, label: 'VoucherIncentive', what: 'A points ledger (Points types), plus ERC20 rewards that are recorded as entitlements and paid Direct, Routed to a route target, or External.' },
];

/** Deploy any number of extra pools (RewardSink or VoucherIncentive), each its own proxy. */
export default function ExtraSinksCard({ admin, onGo }: { admin: string; onGo?: (tab: string) => void }) {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const extras = ctx.book.extraSinks || [];
  const pools: { name: string; address: string; kind: PoolKind }[] = [
    ...(c.RewardSink ? [{ name: 'Main RewardSink', address: c.RewardSink, kind: 'RewardSink' as const }] : []),
    ...(c.VoucherIncentive ? [{ name: 'Main VoucherIncentive', address: c.VoucherIncentive, kind: 'VoucherIncentive' as const }] : []),
    ...extras.map((x) => ({ name: x.name, address: x.address, kind: poolKind(x) })),
  ];

  const [typeId, setTypeId] = useState('sink');
  const type = POOL_TYPES.find((t) => t.id === typeId) || POOL_TYPES[0];
  const [name, setName] = useState('');
  // step 1 → step 2: the implementation the new pool's proxy points at. Prefilled with the main
  // contract's implementation of the same kind (pools can share one), replaced by a freshly deployed
  // one, or pasted.
  const mainImpl = ctx.book.implementations[type.kind] || '';
  const [impl, setImpl] = useState(mainImpl);
  const [implSource, setImplSource] = useState<'main' | 'new' | 'pasted'>('main');
  const [acl, setAcl] = useState('');
  useEffect(() => { if (implSource === 'main') setImpl(mainImpl); }, [mainImpl, implSource]);
  // switching pool type: start again from that type's main implementation
  useEffect(() => { setImplSource('main'); setImpl(ctx.book.implementations[type.kind] || ''); }, [type.kind, ctx.book.implementations]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // approval per pool per approval id, from the registry VoucherNFT enforces (or the book's)
  const [approved, setApproved] = useState<Record<string, Record<string, boolean>>>({});
  const [registry, setRegistry] = useState('');
  // each pool's access control (0x0 = off) — changed on Wire → Advanced
  const [aclOf, setAclOf] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!ctx.reader || !pools.length) return;
    try {
      const linked: string = c.VoucherNFT ? await ctx.read('VoucherNFT').sourceRegistry() : ZERO;
      const regAddr = !sameAddr(linked, ZERO) ? linked : c.SourceRegistry || '';
      setRegistry(regAddr);
      if (!regAddr) return;
      const reg = ctx.read('SourceRegistry', regAddr);
      const out: Record<string, Record<string, boolean>> = {};
      for (const x of pools) {
        out[x.address] = {};
        for (const a of APPROVALS[x.kind]) {
          out[x.address][a.id] = a.standard === undefined ? await reg.isPointsSinkApproved(x.address) : await reg.isRewardSinkApproved(a.standard, x.address);
        }
      }
      setApproved(out);
      const acls: Record<string, string> = {};
      for (const x of pools) acls[x.address] = await ctx.read(x.kind, x.address).accessControl().catch(() => '');
      setAclOf(acls);
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
    if (!isAddr(admin)) return setMsg({ ok: false, text: 'Admin address is not valid' });
    if (!isAddr(impl)) return setMsg({ ok: false, text: 'Step 1: deploy an implementation or paste one' });
    if (type.acl && !isAddr(acl)) return setMsg({ ok: false, text: 'This pool type needs the access control contract address' });
    if (acl && !isAddr(acl)) return setMsg({ ok: false, text: 'Access control is not a valid address (leave it blank for none)' });
    if (ctx.chainId === BSC_MAINNET.chainId && !window.confirm(`Deploy ${type.kind} "${n}" on BSC MAINNET? This spends real BNB.`)) return;
    run(async () => { await ctx.deployExtraSink(n, admin, impl, acl, type.kind); setName(''); setAcl(''); }, `${type.kind} "${n}" deployed — approve it below for what it will pay out`);
  };

  const deployImpl = () => {
    if (ctx.chainId === BSC_MAINNET.chainId && !window.confirm(`Deploy a ${type.kind} implementation on BSC MAINNET? This spends real BNB.`)) return;
    run(async () => { const a = await ctx.deployExtraSinkImpl(type.kind); setImpl(a); setImplSource('new'); }, 'Implementation deployed — it is filled in step 2');
  };

  const approve = (pool: { name: string; address: string; kind: PoolKind }, a: Approval) =>
    run(
      () => a.standard === undefined
        ? ctx.send(`Approve ${pool.kind} "${pool.name}" (points)`, ctx.write('SourceRegistry', registry), 'setPointsSinkApproved', [pool.address, true, pool.name])
        : ctx.send(`Approve ${pool.kind} "${pool.name}" (${a.label})`, ctx.write('SourceRegistry', registry), 'setRewardSinkApproved', [a.standard, pool.address, true, pool.name]),
      `"${pool.name}" approved for ${a.label}`,
    );

  return (
    <Card title="Reward pools">
      <p className="text-xs text-txt-secondary mb-3">
        Deploy as many pools as you need (e.g. one per token or campaign). Each voucher type picks one as its <b>Funding source</b>; approve a pool for what it pays out first.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3 mb-3">
        <Field label="Pool type">
          <Select value={typeId} onChange={setTypeId} options={POOL_TYPES.map((t) => ({ label: t.label, value: t.id }))} />
        </Field>
        <p className="text-xs text-txt-secondary self-end pb-2">{type.what}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
          <h5 className="text-xs font-semibold">1. Implementation</h5>
          <p className="text-[11px] text-txt-secondary">
            {mainImpl ? `Uses the main ${type.kind}'s implementation by default — pools of the same type can share it, so no extra deploy is needed.` : `Deploy the ${type.kind} logic contract first.`}
          </p>
          <button className={btnSecondaryCls} disabled={busy} onClick={deployImpl}>Deploy new implementation</button>
        </div>
        <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
          <h5 className="text-xs font-semibold">2. Pool (proxy + initialize)</h5>
          <Field
            label="Implementation address"
            hint={implSource === 'main' && impl ? `Auto-filled: main ${type.kind} implementation` : implSource === 'new' ? 'Auto-filled from step 1' : `Pasted — must be a ${type.kind} implementation on this network`}
          >
            <input className={inputCls} value={impl} onChange={(e) => { setImpl(e.target.value.trim()); setImplSource('pasted'); }} placeholder="0x… (step 1, or paste one)" />
          </Field>
          <Field label="Pool name" hint="Stored on the contract. Shown in every pool / funding source dropdown.">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "USDT payouts"' />
          </Field>
          <Field
            label={type.acl ? 'Access control contract' : 'Access control (optional)'}
            hint={type.acl ? 'Required for this pool type. Can be changed later (Wire → Advanced).' : 'Blank = off. Can be turned on later (Wire → Advanced).'}
          >
            <input className={inputCls} value={acl} onChange={(e) => setAcl(e.target.value.trim())} placeholder={type.acl ? '0x… access control' : 'blank = off'} />
          </Field>
          <button className={btnCls} disabled={busy || !c.VoucherNFT || !isAddr(impl) || (type.acl && !isAddr(acl))} onClick={deploy}>{busy ? 'Working…' : `Deploy ${type.label}`}</button>
        </div>
      </div>
      {!c.VoucherNFT && <p className="text-xs text-txt-secondary">Deploy VoucherNFT first.</p>}
      <div className="space-y-2">
        {pools.map((x) => (
          <div key={x.address} className="bg-surface-tertiary rounded-lg p-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="font-semibold text-sm">{x.name}</span>
            <Badge tone="muted">{x.kind}</Badge>
            <a className="font-mono text-accent break-all" href={getExplorerAddressUrl(ctx.chainId, x.address)} target="_blank" rel="noopener noreferrer">{x.address}</a>
            {aclOf[x.address] !== undefined && aclOf[x.address] !== '' && (
              <span className="text-txt-secondary">
                Access control: {sameAddr(aclOf[x.address], ZERO) ? 'off' : <span className="text-txt-primary">{ctx.nameOf(aclOf[x.address])}</span>}
                {onGo && <> · <button className="text-accent hover:underline" onClick={() => { try { sessionStorage.setItem(OPEN_ADVANCED_KEY, '1'); } catch { /* storage blocked */ } onGo('wire'); }}>Change</button></>}
              </span>
            )}
            <span className="flex-1" />
            {APPROVALS[x.kind].map((a) => (
              approved[x.address]?.[a.id]
                ? <Badge key={a.id} tone="good">{a.label} approved</Badge>
                : <button key={a.id} className={btnSecondaryCls} disabled={busy || !registry} onClick={() => approve(x, a)}>Approve for {a.label}</button>
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
