'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import {
  DEFAULT_ADMIN_ROLE, TokenStandard, VoucherMode, VoucherType, ZERO, fromUnits, isAddr, loadVoucherTypes, sameAddr, toUnits, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import PoolFundingBox from './pool-funding-box';
import { ContractTag, AddressInput, Badge, Field, NavButtons, Select, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

// VoucherDAO: proposing counts as the first approval; at the type's quorum
// (VoucherNFT.requiredApprovals = approvalsRequired) the mint/revoke executes automatically.
// execute*() is only a manual retry for when that automatic attempt failed.
type Kind = 'mint' | 'bulk' | 'revoke';
const MAX_SHOWN = 50; // newest proposals per kind

// Gas floor for a tx that may auto-execute (it reaches quorum): the execution runs inside a
// try/catch, so a plain estimate can settle on a limit where the mint/revoke silently fails and
// the proposal is left at quorum. ~200k gas per minted voucher (VoucherConstants note) + margin.
// Unused gas is refunded, so the floor costs nothing extra.
const execGas = (kind: Kind, vouchers: number) => (kind === 'revoke' ? 600_000 : 300_000 + 250_000 * Math.max(1, vouchers));

interface Proposal {
  kind: Kind;
  id: number;
  typeId: number;
  proposer: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
  expiresAt: number;
  iApproved: boolean;
  summary: string;
  vouchers: number; // how many vouchers executing it mints (0 for revoke)
}

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
// what a proposal will reserve when it executes, in 18-dp fixed point
const neededFor = (t: VoucherType | undefined, kind: string, quantity: string, value: string, rows: string) => {
  if (!fungible(t) || kind === 'revoke') return ethers.BigNumber.from(0);
  const p = (v: string) => { try { return ethers.utils.parseUnits((v || '0').trim(), 18); } catch { return ethers.BigNumber.from(0); } };
  if (kind === 'mint') return p(value).mul(Math.max(0, parseInt(quantity || '0', 10) || 0));
  return rows.split('\n').map((l) => l.trim()).filter(Boolean).reduce((s, l) => s.add(p(l.split(/[,\s]+/)[1] || '0')), ethers.BigNumber.from(0));
};
const toFace = (t: VoucherType | undefined, v: string) => (fungible(t) ? toUnits(v, 18) : String(Math.max(0, parseInt(v || '0', 10) || 0)));
const showFace = (t: VoucherType | undefined, v: ethers.BigNumberish) => (fungible(t) ? fromUnits(v, 18) : String(v));
const toDate = (d: string) => (d ? Math.floor(new Date(d).getTime() / 1000) : 0);
const fmtTime = (s: number) => (s ? new Date(s * 1000).toLocaleString() : '—');

export default function DaoTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  // only types governed by the DAO (quorum > 1) belong here; follow the shared selection when it is one
  const [types, setTypes] = useState<VoucherType[]>([]);
  // types VoucherDAO can mint (any quorum), plus 2+-approval types even before it's granted (so the warning shows)
  const [daoMinterOf, setDaoMinterOf] = useState<number[]>([]);
  const daoTypes = types.filter((t) => t.approvalsRequired > 1 || daoMinterOf.includes(t.id));
  const typeId = daoTypes.some((t) => t.id === ctx.typeId) ? ctx.typeId : daoTypes[0]?.id ?? -1;
  const setTypeId = ctx.setTypeId;
  // no DAO type selected yet (e.g. a direct-mint type picked elsewhere): share the one shown here
  useEffect(() => { if (typeId >= 0 && typeId !== ctx.typeId) ctx.setTypeId(typeId); }, [typeId, ctx]);
  // v0.53: one operator group per type — operators both propose and approve
  const [roles, setRoles] = useState({ operator: false, admin: false, daoMinter: false, operators: 0 });
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const [kind, setKind] = useState<Kind>('mint');
  const [form, setForm] = useState({ to: ctx.account, quantity: '1', faceValue: '', token: '', start: '', expiry: '', hours: '72', bulk: '', voucherId: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const selected = types.find((t) => t.id === typeId);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  const load = useCallback(async () => {
    if (!c.VoucherNFT || !c.VoucherDAO || !ctx.reader) return;
    try {
      const nft = ctx.read('VoucherNFT');
      const dao = ctx.read('VoucherDAO');
      const ts = await loadVoucherTypes(nft);
      const minterOf = await Promise.all(ts.map(async (t) => ((await nft.hasRole(await nft.typeMinterRole(t.id), c.VoucherDAO)) ? t.id : -1)));
      setDaoMinterOf(minterOf.filter((x) => x >= 0));
      setTypes(ts);
      const tmap = new Map(ts.map((t) => [t.id, t]));
      const out: Proposal[] = [];
      const range = (n: number) => Array.from({ length: Math.min(n, MAX_SHOWN) }, (_, i) => n - 1 - i);

      for (const id of range((await dao.nextMintProposalId()).toNumber())) {
        const p = await dao.mintProposals(id);
        const t = tmap.get(Number(p.typeId));
        out.push({
          kind: 'mint', id, typeId: Number(p.typeId), proposer: p.proposer, approvals: Number(p.approvalCount),
          executed: p.executed, cancelled: p.cancelled, expiresAt: Number(p.expiresAt),
          iApproved: await dao.mintApprovals(id, ctx.account),
          vouchers: Number(p.quantity),
          summary: `${p.quantity}× ${showFace(t, p.faceValue)} → ${ctx.nameOf(p.to)}${sameAddr(p.token, ZERO) ? '' : ` (${ctx.nameOf(p.token)})`}`,
        });
      }
      for (const id of range((await dao.nextBulkProposalId()).toNumber())) {
        const p = await dao.bulkMintProposals(id);
        const t = tmap.get(Number(p.typeId));
        const [recipients, faces] = await Promise.all([dao.getBulkMintRecipients(id), dao.getBulkMintFaceValues(id)]);
        const total = faces.reduce((s: ethers.BigNumber, f: ethers.BigNumber) => s.add(f), ethers.BigNumber.from(0));
        out.push({
          kind: 'bulk', id, typeId: Number(p.typeId), proposer: p.proposer, approvals: Number(p.approvalCount),
          executed: p.executed, cancelled: p.cancelled, expiresAt: Number(p.expiresAt),
          iApproved: await dao.bulkMintApprovals(id, ctx.account),
          vouchers: recipients.length,
          summary: `${recipients.length} recipients, total ${showFace(t, total)}`,
        });
      }
      for (const id of range((await dao.nextRevokeProposalId()).toNumber())) {
        const p = await dao.revokeProposals(id);
        const vt = Number(await nft.voucherTypeOf(p.voucherId).catch(() => -1));
        out.push({
          kind: 'revoke', id, typeId: vt, proposer: p.proposer, approvals: Number(p.approvalCount),
          executed: p.executed, cancelled: p.cancelled, expiresAt: Number(p.expiresAt),
          iApproved: await dao.revokeApprovals(id, ctx.account),
          vouchers: 0,
          summary: `revoke voucher #${p.voucherId}${p.reason ? ` — "${p.reason}"` : ''}`,
        });
      }
      setProposals(out);
      setNow(Math.floor(Date.now() / 1000));
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not read VoucherDAO: ${e.message}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.VoucherNFT, c.VoucherDAO, ctx.reader, ctx.account, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  // the connected wallet's standing for the selected type
  useEffect(() => {
    if (typeId < 0 || !c.VoucherDAO || !c.VoucherNFT || !ctx.reader) return;
    (async () => {
      const dao = ctx.read('VoucherDAO');
      const nft = ctx.read('VoucherNFT');
      const ar = await dao.typeOperatorRole(typeId);
      const [operator, admin, daoMinter, operators] = await Promise.all([
        dao.hasRole(ar, ctx.account), dao.hasRole(DEFAULT_ADMIN_ROLE, ctx.account),
        nft.hasRole(await nft.typeMinterRole(typeId), c.VoucherDAO), dao.getOperatorsOf(typeId),
      ]);
      setRoles({ operator, admin, daoMinter, operators: operators.length });
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, c.VoucherDAO, c.VoucherNFT, ctx.reader, ctx.account, ctx.revision]);

  const run = async (label: string, method: string, args: any[], minGas?: number) => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(label, ctx.write('VoucherDAO'), method, args, minGas ? { gasLimit: minGas } : {});
      setMsg({ ok: true, text: label });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const duration = () => {
    const h = Number(form.hours);
    if (!(h >= 1 && h <= 720)) throw new Error('Voting window must be between 1 and 720 hours (30 days)');
    return Math.round(h * 3600);
  };

  const propose = async () => {
    try {
      if (!selected) throw new Error('Pick a voucher type');
      const d = duration();
      const token = selected.mode === VoucherMode.Reward ? form.token || selected.approvedTokens[0] || ZERO : ZERO;
      if (kind === 'mint') {
        if (!isAddr(form.to)) throw new Error('Recipient is not a valid address');
        const q = parseInt(form.quantity, 10);
        if (!(q >= 1 && q <= 50)) throw new Error('Quantity must be 1–50');
        if (!form.faceValue) throw new Error('Enter a face value');
        return run(`DAO: propose mint ${q}× type ${selected.id} → ${ctx.nameOf(form.to)}`, 'proposeMint',
          [selected.id, form.to, q, toFace(selected, form.faceValue), toDate(form.start), toDate(form.expiry), token, 0, d],
          selected.approvalsRequired <= 1 ? execGas('mint', q) : undefined);
      }
      if (kind === 'bulk') {
        const rows = form.bulk.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,\s]+/));
        if (!rows.length || rows.length > 50) throw new Error('Enter 1–50 lines of "address, amount"');
        const bad = rows.filter(([a, v]) => !isAddr(a || '') || !v);
        if (bad.length) throw new Error(`Bad line(s): ${bad.map((r) => r.join(' ')).join('; ')}`);
        return run(`DAO: propose bulk mint (${rows.length}) type ${selected.id}`, 'proposeBulkMint',
          [selected.id, rows.map((r) => r[0]), rows.map((r) => toFace(selected, r[1])), toDate(form.start), toDate(form.expiry), token, rows.map(() => 0), d],
          selected.approvalsRequired <= 1 ? execGas('bulk', rows.length) : undefined);
      }
      if (!/^\d+$/.test(form.voucherId)) throw new Error('Enter the voucher id to revoke');
      return run(`DAO: propose revoke voucher #${form.voucherId}`, 'proposeRevoke', [form.voucherId, form.reason.trim(), d],
        selected.approvalsRequired <= 1 ? execGas('revoke', 0) : undefined);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const statusOf = (p: Proposal) => {
    const quorum = typeById.get(p.typeId)?.approvalsRequired ?? 0;
    if (p.executed) return { tone: 'good' as const, text: 'Executed' };
    if (p.cancelled) return { tone: 'muted' as const, text: 'Cancelled' };
    if (now > p.expiresAt) return { tone: 'muted' as const, text: 'Expired' };
    if (quorum && p.approvals >= quorum) return { tone: 'bad' as const, text: 'Quorum reached — auto-execute failed, retry Execute' };
    return { tone: 'warn' as const, text: 'Open' };
  };
  const isOpen = (p: Proposal) => !p.executed && !p.cancelled && now <= p.expiresAt;
  const shown = proposals.filter((p) => !openOnly || isOpen(p)).filter((p) => typeId < 0 || p.typeId === typeId || p.kind === 'revoke');
  const method = { mint: ['approveMint', 'executeMint', 'cancelMint'], bulk: ['approveBulkMint', 'executeBulkMint', 'cancelBulkMint'], revoke: ['approveRevoke', 'executeRevoke', 'cancelRevoke'] } as const;

  if (!c.VoucherDAO || !c.VoucherNFT) {
    return <Card><p className="text-sm text-txt-secondary text-center py-6">Deploy VoucherNFT and VoucherDAO first (Deploy tab).</p></Card>;
  }

  if (types.length && !daoTypes.length) {
    return (
      <Card title="VoucherDAO">
        <p className="text-sm text-txt-secondary">
          No voucher type uses the DAO yet. A type uses it when it needs 2+ approvals, or when VoucherDAO is one of its minters (any number of approvals) —
          set that when registering a type on the <button className={linkBtnCls} onClick={() => onGo('types')}>Voucher types</button> tab, or grant it on{' '}
          <button className={linkBtnCls} onClick={() => onGo('roles')}>Minters &amp; roles</button>.
        </p>
      </Card>
    );
  }

  const set = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const quorum = selected?.approvalsRequired ?? 0;

  return (
    <div className="space-y-4">
      <Card title="VoucherDAO — governed mints and revokes">
        <p className="text-xs text-txt-secondary mb-3">
          Each type sets how many approvals its proposals need. Proposing counts as approval #1; at that number the mint or revoke <b>runs automatically</b>
          (so with 1, it runs as soon as it&apos;s proposed). Execute is only a retry if that run failed (e.g. the pool was short).
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-3">
          <Field label="Voucher type">
            <Select value={typeId} onChange={setTypeId} options={daoTypes.map((t) => ({ label: `${typeLabel(t)} · ${t.approvalsRequired} approval${t.approvalsRequired === 1 ? ' (executes on propose)' : 's'}`, value: t.id }))} />
          </Field>
          {selected && (
            <div className="text-xs space-y-1 self-end pb-1">
              <div>
                Needs <b>{quorum}</b> approval{quorum === 1 ? '' : 's'} · {roles.operators} operator(s) ·{' '}
                You: {[roles.operator && 'operator', roles.admin && 'DAO admin'].filter(Boolean).join(', ') || 'no role'}
              </div>
              {!roles.daoMinter && <p className="text-red-300">⚠ VoucherDAO can&apos;t mint this type — reaching quorum will fail. <button className={linkBtnCls} onClick={() => onGo('roles')}>Grant it on Roles</button></p>}
              {roles.operators < quorum && <p className="text-yellow-300">⚠ Fewer operators than the approvals needed (the proposer counts as one) — add some in <i>VoucherDAO operators</i> below.</p>}
            </div>
          )}
        </div>
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>

      {selected && (
        <Card title="New proposal">
        <ContractTag contract="VoucherDAO" methods={['proposeMint', 'proposeBulkMint', 'proposeRevoke']} />
          <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1 w-fit mb-4">
            {(['mint', 'bulk', 'revoke'] as Kind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 rounded text-xs font-medium ${kind === k ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
                {k === 'mint' ? 'Mint' : k === 'bulk' ? 'Bulk mint' : 'Revoke'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {kind === 'mint' && (
              <>
                <Field label="Recipient"><AddressInput value={form.to} onChange={(v) => set('to', v)} options={[{ label: 'Connected wallet', value: ctx.account }]} /></Field>
                <Field label="Quantity" hint="Identical vouchers to the recipient, 1–50."><input className={inputCls} value={form.quantity} onChange={(e) => set('quantity', e.target.value)} /></Field>
                <Field label="Face value" hint={fungible(selected) ? 'In token units, e.g. 12.5 (stored with 18 decimals).' : 'Whole number (points).'}>
                  <input className={inputCls} value={form.faceValue} onChange={(e) => set('faceValue', e.target.value)} />
                </Field>
              </>
            )}
            {kind === 'bulk' && (
              <div className="md:col-span-3">
                <Field label="Recipients" hint={`One per line: address, amount (${fungible(selected) ? 'token units' : 'points'}). Up to 50.`}>
                  <textarea className={`${inputCls} h-28`} value={form.bulk} onChange={(e) => set('bulk', e.target.value)} placeholder={'0xabc…, 10\n0xdef…, 25'} />
                </Field>
              </div>
            )}
            {kind === 'revoke' && (
              <>
                <Field label="Voucher id"><input className={inputCls} value={form.voucherId} onChange={(e) => set('voucherId', e.target.value)} placeholder="e.g. 12" /></Field>
                <div className="md:col-span-2"><Field label="Reason (stored on-chain)"><input className={inputCls} value={form.reason} onChange={(e) => set('reason', e.target.value)} /></Field></div>
              </>
            )}
            {kind !== 'revoke' && selected.mode === VoucherMode.Reward && (
              <Field label="Payout token" hint="One of the type's approved tokens.">
                <Select value={form.token || selected.approvedTokens[0] || ZERO} onChange={(v) => set('token', v)}
                  options={(selected.approvedTokens.length ? selected.approvedTokens : [ZERO]).map((a) => ({ label: sameAddr(a, ZERO) ? 'Native coin' : ctx.nameOf(a), value: a }))} />
              </Field>
            )}
            {kind !== 'revoke' && (
              <>
                <Field label="Claimable from (optional)"><input type="datetime-local" className={inputCls} value={form.start} onChange={(e) => set('start', e.target.value)} /></Field>
                <Field label="Voucher expiry (optional)"><input type="datetime-local" className={inputCls} value={form.expiry} onChange={(e) => set('expiry', e.target.value)} /></Field>
              </>
            )}
            <Field label="Voting window (hours)" hint="How long operators have to vote: 1 to 720 hours (30 days).">
              <input className={inputCls} value={form.hours} onChange={(e) => set('hours', e.target.value)} />
            </Field>
          </div>
          {kind !== 'revoke' && (
            <div className="mt-3">
              <PoolFundingBox type={selected} token={selected.mode === VoucherMode.Reward ? form.token || selected.approvedTokens[0] || ZERO : ZERO} needed={neededFor(selected, kind, form.quantity, form.faceValue, form.bulk)} />
            </div>
          )}
          <button className={`${btnCls} mt-4`} disabled={busy || !roles.operator} onClick={propose}>{busy ? 'Sending…' : 'Propose'}</button>
          {!roles.operator && <span className="text-xs text-txt-secondary ml-3">Only this type&apos;s operators can propose — add your wallet on Minters &amp; roles.</span>}
        </Card>
      )}

      <Card title="Proposals">
        <ContractTag contract="VoucherDAO" methods={['approve*', 'execute*', 'cancel*']} />
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label className="flex items-center gap-2 text-xs text-txt-secondary"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only</label>
          <span className="text-xs text-txt-secondary">Showing {selected ? `type #${selected.id} + revokes` : 'all types'} · newest {MAX_SHOWN} per kind</span>
          <span className="flex-1" />
          <button className={btnSecondaryCls} disabled={busy} onClick={load}>Reload</button>
        </div>
        <div className="space-y-2">
          {shown.map((p) => {
            const st = statusOf(p);
            const t = typeById.get(p.typeId);
            const q = t?.approvalsRequired ?? 0;
            const open = isOpen(p);
            const [approveM, executeM, cancelM] = method[p.kind];
            const canCancel = open && (sameAddr(p.proposer, ctx.account) || roles.admin);
            return (
              <div key={`${p.kind}${p.id}`} className="bg-surface-tertiary rounded-lg p-3 text-xs space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm">{p.kind === 'mint' ? 'Mint' : p.kind === 'bulk' ? 'Bulk mint' : 'Revoke'} #{p.id}</span>
                  <Badge tone={st.tone}>{st.text}</Badge>
                  <span className="text-txt-secondary">{t ? typeLabel(t) : `type #${p.typeId}`}</span>
                </div>
                <div>{p.summary}</div>
                <div className="text-txt-secondary">
                  Approvals <b className="text-txt-primary">{p.approvals} / {q || '?'}</b> · proposer {ctx.nameOf(p.proposer)} · voting ends {fmtTime(p.expiresAt)}
                  {p.iApproved && ' · you approved'}
                </div>
                {open && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button className={btnSecondaryCls} disabled={busy || p.iApproved} onClick={() => run(`DAO: approve ${p.kind} #${p.id}`, approveM, [p.id], q > 0 && p.approvals + 1 >= q ? execGas(p.kind, p.vouchers) : undefined)}>
                      {p.iApproved ? 'Approved ✓' : 'Approve'}
                    </button>
                    {q > 0 && p.approvals >= q && (
                      <button className={btnCls} disabled={busy} onClick={() => run(`DAO: execute ${p.kind} #${p.id}`, executeM, [p.id], execGas(p.kind, p.vouchers))}>Execute (retry)</button>
                    )}
                    {canCancel && <button className={btnDangerCls} disabled={busy} onClick={() => run(`DAO: cancel ${p.kind} #${p.id}`, cancelM, [p.id])}>Cancel</button>}
                  </div>
                )}
              </div>
            );
          })}
          {!shown.length && <p className="text-xs text-txt-secondary">{openOnly ? 'No open proposals.' : 'No proposals yet.'}</p>}
        </div>
      </Card>

    </div>
  );
}
