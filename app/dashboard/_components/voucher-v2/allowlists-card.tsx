'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { DEFAULT_ADMIN_ROLE, PoolKind, TokenStandard, isAddr, poolKind, role, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import DestinationsCard, { DESTINATION_LISTS } from './destinations-card';
import { AddressInput, Badge, Collapsible, ContractTag, Field, Select, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

// What a funding source can be approved for. "points" = setPointsSinkApproved; a number =
// setRewardSinkApproved for that token standard.
type Use = { id: 'native' | 'erc20' | 'points'; label: string; standard?: number };
const USES: Use[] = [
  { id: 'native', label: 'Native rewards', standard: TokenStandard.Native },
  { id: 'erc20', label: 'ERC20 rewards', standard: TokenStandard.ERC20 },
  { id: 'points', label: 'Points' },
];
// set by the Pools tab's "Approve in SourceRegistry →" link: the pool to preselect below
export const APPROVE_POOL_KEY = 'dg_voucherV2ApprovePool';

// which uses make sense for a known pool type (a pasted, unknown address gets all three)
const USES_FOR: Record<PoolKind, Use['id'][]> = { RewardSink: ['native', 'erc20'], VoucherIncentive: ['points', 'erc20'] };

const LISTS = [
  { id: 'sources', title: 'Funding sources', what: 'Pools a voucher type may pay from — approved per kind of payout.' },
  { id: DESTINATION_LISTS[0].key, title: 'Payout recipients', what: 'Fixed addresses a voucher type may always pay to (instead of the claimer).' },
  { id: DESTINATION_LISTS[1].key, title: 'Route targets', what: 'Pools a Routed type (on VoucherIncentive) may send its payout to.' },
];

/** SourceRegistry's three allowlists in one place: approve and remove, each with its own list. */
export default function AllowlistsCard() {
  const ctx = useVoucherV2();
  const [list, setList] = useState(LISTS[0].id);
  const current = LISTS.find((l) => l.id === list) || LISTS[0];
  if (!ctx.book.contracts.SourceRegistry) {
    return <Card title="Allowlists"><p className="text-xs text-txt-secondary">Deploy SourceRegistry first (Deploy tab).</p></Card>;
  }
  return (
    <Card title="Allowlists">
      <ContractTag
        contract="SourceRegistry"
        methods={list === 'sources' ? ['setRewardSinkApproved', 'setPointsSinkApproved'] : ['setDestinationApproved', 'setDestinationsApproved', 'setLabel']}
      />
      <p className="text-xs text-txt-secondary mb-3">
        Once VoucherNFT is linked to this registry, voucher types can only use addresses approved here. Removing an address later doesn&apos;t change types already using it.
        Needs <b>OPERATOR_ROLE</b> on SourceRegistry — see <i>Who can change the allowlists</i> below.
      </p>
      <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1 w-fit mb-2">
        {LISTS.map((l) => (
          <button key={l.id} onClick={() => setList(l.id)} className={`px-3 py-1.5 rounded text-xs font-medium ${list === l.id ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
            {l.title}
          </button>
        ))}
      </div>
      <p className="text-xs text-txt-secondary mb-3">{current.what}</p>
      {list === 'sources' ? <FundingSources /> : <DestinationsCard only={list} />}
    </Card>
  );
}

function FundingSources() {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [rows, setRows] = useState<{ address: string; name: string; kind?: PoolKind; on: Record<string, boolean> }[]>([]);
  const OTHER = '__other__';
  const [poolSel, setPoolSel] = useState(() => {
    try {
      const v = sessionStorage.getItem(APPROVE_POOL_KEY) || '';
      sessionStorage.removeItem(APPROVE_POOL_KEY);
      return v;
    } catch {
      return '';
    }
  });
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [useAs, setUseAs] = useState<'reward' | 'points'>('reward');
  const [standard, setStandard] = useState<number>(TokenStandard.ERC20);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!ctx.reader || !c.SourceRegistry) return;
    try {
      const reg = ctx.read('SourceRegistry');
      const [native, erc20, points]: string[][] = await Promise.all([reg.getApprovedRewardSinks(TokenStandard.Native), reg.getApprovedRewardSinks(TokenStandard.ERC20), reg.getApprovedPointsSinks()]);
      // known pools (so unapproved ones show with an Approve button) + anything the registry lists
      const known: { address: string; kind: PoolKind; name: string }[] = [
        ...(c.RewardSink ? [{ address: c.RewardSink, kind: 'RewardSink' as const, name: 'Main RewardSink' }] : []),
        ...(c.VoucherIncentive ? [{ address: c.VoucherIncentive, kind: 'VoucherIncentive' as const, name: 'Main VoucherIncentive' }] : []),
        ...(ctx.book.extraSinks || []).map((x) => ({ address: x.address, kind: poolKind(x), name: x.name })),
      ];
      const all: string[] = [];
      for (const a of [...known.map((k) => k.address), ...native, ...erc20, ...points]) if (!all.some((x) => sameAddr(x, a))) all.push(a);
      const has = (l: string[], a: string) => l.some((x) => sameAddr(x, a));
      setRows(await Promise.all(all.map(async (a) => {
        const k = known.find((x) => sameAddr(x.address, a));
        const regLabel: string = await reg.labelOf(a).catch(() => '');
        return { address: a, name: regLabel || k?.name || '', kind: k?.kind, on: { native: has(native, a), erc20: has(erc20, a), points: has(points, a) } };
      })));
    } catch {
      setMsg({ ok: false, text: 'Could not read the registry — is it deployed on this network?' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.reader, ctx.book, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  const send = (address: string, use: Use, approved: boolean, lbl = '') => {
    const reg = ctx.write('SourceRegistry');
    const verb = approved ? 'Approve' : 'Remove';
    return use.standard === undefined
      ? ctx.send(`${verb} ${ctx.nameOf(address)} (points)`, reg, 'setPointsSinkApproved', [address, approved, lbl])
      : ctx.send(`${verb} ${ctx.nameOf(address)} (${use.label})`, reg, 'setRewardSinkApproved', [use.standard, address, approved, lbl]);
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  // the pool picked in step 1 (a known pool, or a pasted address)
  const target = poolSel === OTHER ? addr : poolSel;
  const targetRow = rows.find((r) => sameAddr(r.address, target));
  const chosenUse = USES.find((u) => (useAs === 'points' ? u.id === 'points' : u.standard === standard)) as Use;
  const alreadyOn = !!targetRow?.on[chosenUse.id];

  const approveChosen = () => {
    if (!isAddr(target)) return setMsg({ ok: false, text: 'Step 1: pick a pool, or paste a valid address' });
    run(async () => {
      if (!targetRow) {
        const code = ctx.reader ? await ctx.reader.getCode(target) : '0x';
        if (!code || code === '0x') throw new Error('No contract at that address on this network');
      }
      await send(target, chosenUse, true, (label.trim() || targetRow?.name || ''));
      setLabel('');
    }, `Approved for ${chosenUse.label}`);
  };

  return (
    <div className="space-y-3">
      <div className="bg-surface-tertiary rounded-lg p-3 space-y-3">
        <h5 className="text-sm font-semibold">Approve a pool</h5>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="1. Pool">
            <Select
              value={poolSel || ''}
              onChange={setPoolSel}
              options={[
                { label: 'Select a pool…', value: '' },
                ...rows.map((r) => ({ label: `${r.name || 'Unnamed'}${r.kind ? ` · ${r.kind}` : ''} · ${r.address.slice(0, 6)}…${r.address.slice(-4)}`, value: r.address })),
                { label: 'Other address…', value: OTHER },
              ]}
            />
            {poolSel === OTHER && <div className="mt-2"><AddressInput value={addr} onChange={setAddr} placeholder="0x… pool address" /></div>}
          </Field>
          <Field label="2. Use as" hint={useAs === 'points' ? 'A points ledger — VoucherIncentive.' : 'A reward pool — RewardSink or VoucherIncentive.'}>
            <Select value={useAs} onChange={(v) => setUseAs(v as 'reward' | 'points')} options={[{ label: 'Reward (pays tokens)', value: 'reward' }, { label: 'Points (sink)', value: 'points' }]} />
          </Field>
          {useAs === 'reward' ? (
            <Field label="3. Token standard">
              <Select value={standard} onChange={setStandard} options={[{ label: 'Native coin', value: TokenStandard.Native }, { label: 'ERC20 token', value: TokenStandard.ERC20 }]} />
            </Field>
          ) : (
            <Field label="3. Token standard"><div className="text-sm py-2 text-txt-secondary">Not needed for points</div></Field>
          )}
        </div>
        {poolSel === OTHER && (
          <Field label="Label (optional)" hint="Stored on the registry, shown next to the address."><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder='e.g. "Partner pool"' /></Field>
        )}
        <div className="flex items-center gap-3">
          <button className={btnCls} disabled={busy || !isAddr(target) || alreadyOn} onClick={approveChosen}>{busy ? 'Sending…' : alreadyOn ? 'Already approved' : 'Approve'}</button>
          {targetRow?.kind === 'RewardSink' && useAs === 'points' && <span className="text-xs text-yellow-300">⚠ A RewardSink isn&apos;t a points ledger — use a VoucherIncentive for Points.</span>}
        </div>
      </div>
      <Collapsible title={`Pools (${rows.length})`} summary={`${rows.filter((r) => Object.values(r.on).some(Boolean)).length} approved for something · approve / remove per kind`}>
      <div className="space-y-2">
        {rows.map((r) => {
          const uses = USES.filter((u) => (r.kind ? USES_FOR[r.kind].includes(u.id) : true) || r.on[u.id]);
          return (
            <div key={r.address} className="bg-surface-tertiary rounded-lg p-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
              <span className="font-semibold text-sm">{r.name || 'Unnamed'}</span>
              {r.kind && <Badge tone="muted">{r.kind}</Badge>}
              <span className="font-mono text-txt-secondary break-all">{r.address}</span>
              <span className="flex-1" />
              {uses.map((u) => (
                <span key={u.id} className="inline-flex items-center gap-1.5">
                  {r.on[u.id] ? <Badge tone="good">{u.label}</Badge> : <Badge tone="muted">{u.label}: no</Badge>}
                  {r.on[u.id]
                    ? <button className={linkBtnCls} disabled={busy} onClick={() => run(() => send(r.address, u, false), `Removed ${u.label}`)}>Remove</button>
                    : <button className={linkBtnCls} disabled={busy} onClick={() => run(() => send(r.address, u, true, r.name), `Approved for ${u.label}`)}>Approve</button>}
                </span>
              ))}
            </div>
          );
        })}
        {!rows.length && <p className="text-xs text-txt-secondary">No pools yet — deploy them on the Deploy / Pools tabs, or add one below.</p>}
      </div>
      </Collapsible>
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}

/** Who may approve / remove on SourceRegistry (OPERATOR_ROLE), and who may change that (admin). */
export function RegistryAccessCard() {
  const ctx = useVoucherV2();
  const reg = ctx.book.contracts.SourceRegistry;
  const OP = role('OPERATOR_ROLE');
  const [ops, setOps] = useState<string[]>([]);
  const [admins, setAdmins] = useState<string[]>([]);
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!reg || !ctx.reader) return;
    try {
      const r = ctx.read('SourceRegistry');
      setOps(await r.getRoleMembers(OP));
      setAdmins(await r.getRoleMembers(DEFAULT_ADMIN_ROLE));
    } catch {
      // older registry — leave empty
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg, ctx.reader, ctx.revision]);
  useEffect(() => { load(); }, [load]);

  const isAdmin = admins.some((a) => sameAddr(a, ctx.account));
  const send = async (label: string, method: string, args: any[]) => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(label, ctx.write('SourceRegistry'), method, args);
      setMsg({ ok: true, text: label });
      setAddr('');
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!reg) return null;
  const tag = (a: string) => (sameAddr(a, ctx.account) ? ' (you)' : ctx.nameOf(a).startsWith('0x') ? '' : ` (${ctx.nameOf(a)})`);

  return (
    <Card title="Who can change the allowlists">
      <ContractTag contract="SourceRegistry" methods={['grantRole(OPERATOR_ROLE)', 'revokeRole']} />
      <p className="text-xs text-txt-secondary mb-3">
        <b>Operators</b> (OPERATOR_ROLE) approve and remove funding sources, payout recipients and route targets, and set labels.
        Only the registry <b>admin</b> (DEFAULT_ADMIN_ROLE) can add or remove operators, and rename the registry.
        The wallet that deployed the registry starts with both.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <div>
          <h4 className="text-sm font-semibold mb-1">Operators ({ops.length})</h4>
          {ops.map((a) => (
            <div key={a} className="flex items-center gap-2 text-xs">
              <span className="font-mono break-all flex-1">{a}<span className="text-txt-secondary">{tag(a)}</span></span>
              {isAdmin && <button className={linkBtnCls} disabled={busy} onClick={() => send(`Remove registry operator ${ctx.nameOf(a)}`, 'revokeRole', [OP, a])}>Remove</button>}
            </div>
          ))}
          {!ops.length && <p className="text-xs text-txt-secondary">None — nobody can change the allowlists.</p>}
        </div>
        <div>
          <h4 className="text-sm font-semibold mb-1">Admins ({admins.length})</h4>
          {admins.map((a) => <div key={a} className="font-mono text-xs break-all">{a}<span className="text-txt-secondary">{tag(a)}</span></div>)}
        </div>
      </div>
      {isAdmin ? (
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[260px]"><Field label="Add operator"><AddressInput value={addr} onChange={setAddr} options={[{ label: 'Connected wallet', value: ctx.account }]} /></Field></div>
          <button className={btnSecondaryCls} disabled={busy || !isAddr(addr)} onClick={() => send(`Add registry operator ${ctx.nameOf(addr)}`, 'grantRole', [OP, addr])}>Add operator</button>
        </div>
      ) : (
        <p className="text-xs text-yellow-300">Your wallet isn&apos;t the registry admin, so it can&apos;t change operators.</p>
      )}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}
