'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import {
  TokenStandard, VoucherMode, VoucherType, ZERO, eventArg, fromUnits, isAddr, loadVoucherTypes, sameAddr, toUnits, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { AddressInput, Badge, ContractTag, Field, Select, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

const SCAN_LIMIT = 2000; // vouchers read per browse scan (newest first)
const MAX_BATCH = 50; // VoucherConstants.MAX_BATCH_SIZE

interface Voucher {
  id: number;
  owner: string;
  typeId: number;
  faceValue: ethers.BigNumber;
  token: string;
  startDate: number;
  expiryDate: number;
  redeemed: boolean;
  revoked: boolean;
  reserved: boolean;
}

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
const toDate = (d: string) => (d ? Math.floor(new Date(d).getTime() / 1000) : 0);
const fmtDate = (s: number) => (s ? new Date(s * 1000).toLocaleString() : '—');

/** Mint, claim and browse vouchers — every call here goes to VoucherNFT. */
export default function VouchersCard() {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [part, setPart] = useState<'mint' | 'mine' | 'browse'>('mint');
  const [types, setTypes] = useState<VoucherType[]>([]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  useEffect(() => {
    if (!c.VoucherNFT || !ctx.reader) return;
    loadVoucherTypes(ctx.read('VoucherNFT')).then(setTypes).catch(() => setTypes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.VoucherNFT, ctx.reader, ctx.revision]);

  const nameToken = (a: string) => (sameAddr(a, ZERO) ? 'native coin' : ctx.nameOf(a));
  const showValue = (v: Voucher) => {
    const t = typeById.get(v.typeId);
    if (!t) return v.faceValue.toString();
    if (t.mode === VoucherMode.Points) return `${v.faceValue.toString()} points`;
    return fungible(t) ? `${fromUnits(v.faceValue, 18)} ${nameToken(v.token)}` : `${v.faceValue.toString()} × ${nameToken(v.token)}`;
  };
  const statusOf = (v: Voucher, now: number) => {
    if (v.redeemed) return { tone: 'good' as const, text: 'Claimed' };
    if (v.revoked) return { tone: 'bad' as const, text: 'Revoked' };
    if (v.expiryDate && now > v.expiryDate) return { tone: 'muted' as const, text: 'Expired' };
    if (now < v.startDate) return { tone: 'muted' as const, text: 'Not yet claimable' };
    if (typeById.get(v.typeId)?.redemptionPaused) return { tone: 'warn' as const, text: 'Claiming paused' };
    return { tone: 'warn' as const, text: 'Claimable' };
  };

  const readVoucher = async (nft: ethers.Contract, id: number): Promise<Voucher> => {
    const [v, owner] = await Promise.all([nft.vouchers(id), nft.ownerOf(id).catch(() => ZERO)]);
    return {
      id, owner, typeId: Number(v.voucherType), faceValue: ethers.BigNumber.from(v.faceValue), token: v.token,
      startDate: Number(v.startDate), expiryDate: Number(v.expiryDate), redeemed: v.redeemed, revoked: v.revoked, reserved: v.reserved,
    };
  };

  if (!c.VoucherNFT) return null;

  return (
    <Card title="Vouchers">
      <ContractTag contract="VoucherNFT" methods={part === 'mint' ? ['mint', 'mintBatch'] : part === 'mine' ? ['claim'] : ['revokeVoucher']} />
      <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1 w-fit mb-4">
        {([['mint', 'Mint'], ['mine', 'My vouchers'], ['browse', 'Browse']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setPart(id)} className={`px-3 py-1.5 rounded text-xs font-medium ${part === id ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>{label}</button>
        ))}
      </div>
      {part === 'mint' && <MintPanel types={types} />}
      {part === 'mine' && <ListPanel types={types} mine readVoucher={readVoucher} showValue={showValue} statusOf={statusOf} />}
      {part === 'browse' && <ListPanel types={types} readVoucher={readVoucher} showValue={showValue} statusOf={statusOf} />}
    </Card>
  );
}

// ── Mint: one or many vouchers of a type, straight from the connected wallet (needs its minter role) ──
function MintPanel({ types }: { types: VoucherType[] }) {
  const ctx = useVoucherV2();
  const [typeId, setTypeId] = useState(-1);
  const t = types.find((x) => x.id === typeId);
  const [bulk, setBulk] = useState(false);
  const [f, setF] = useState({ to: ctx.account, quantity: '1', faceValue: '', token: '', tokenId: '0', start: '', expiry: '', rows: '' });
  const [isMinter, setIsMinter] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => { if (typeId < 0 && types.length) setTypeId((types.find((x) => x.mintApprovalsRequired <= 1) ?? types[0]).id); }, [types, typeId]);
  useEffect(() => {
    if (typeId < 0 || !ctx.reader) return setIsMinter(null);
    const nft = ctx.read('VoucherNFT');
    nft.typeMinterRole(typeId).then((r: string) => nft.hasRole(r, ctx.account)).then(setIsMinter).catch(() => setIsMinter(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, ctx.reader, ctx.account, ctx.revision]);

  const reward = t?.mode === VoucherMode.Reward;
  const nft721 = reward && t?.tokenStandard === TokenStandard.ERC721;
  const toFace = (v: string) => (fungible(t) ? toUnits(v, 18) : String(Math.max(0, parseInt(v || '0', 10) || 0)));
  const token = reward ? f.token || t?.approvedTokens[0] || ZERO : ZERO;

  const mint = async () => {
    if (!t) return;
    setBusy(true);
    setMsg(null);
    try {
      const nft = ctx.write('VoucherNFT');
      if (!bulk) {
        if (!isAddr(f.to)) throw new Error('Recipient is not a valid address');
        const q = parseInt(f.quantity, 10);
        if (!(q >= 1 && q <= MAX_BATCH)) throw new Error(`Quantity must be 1–${MAX_BATCH}`);
        if (!f.faceValue) throw new Error('Enter a value');
        const receipt = await ctx.send(`Mint ${q}× type ${t.id} → ${ctx.nameOf(f.to)}`, nft, 'mint', [t.id, f.to, q, toFace(f.faceValue), toDate(f.start), toDate(f.expiry), token, nft721 ? f.tokenId || '0' : 0]);
        setMsg({ ok: true, text: `Minted voucher #${eventArg(receipt, nft, 'VoucherMinted', 'voucherId').toString()}${q > 1 ? ` (+${q - 1} more)` : ''}` });
      } else {
        const rows = f.rows.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,\s]+/));
        if (!rows.length || rows.length > MAX_BATCH) throw new Error(`Enter 1–${MAX_BATCH} lines of "address, amount"`);
        const bad = rows.filter(([a, v]) => !isAddr(a || '') || !v);
        if (bad.length) throw new Error(`Bad line(s): ${bad.map((r) => r.join(' ')).join('; ')}`);
        await ctx.send(`Bulk mint ${rows.length} × type ${t.id}`, nft, 'mintBatch', [t.id, rows.map((r) => r[0]), rows.map((r) => toFace(r[1])), toDate(f.start), toDate(f.expiry), token, rows.map((r) => (nft721 ? r[2] || '0' : 0))]);
        setMsg({ ok: true, text: `Minted ${rows.length} voucher(s)` });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!types.length) return <p className="text-xs text-txt-secondary">Create a voucher type first (above).</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3">
        <Field label="Voucher type">
          <Select value={typeId} onChange={setTypeId} options={types.map((x) => ({ label: `${typeLabel(x)}${x.mintApprovalsRequired > 1 ? ' — mint via VoucherDAO' : ''}`, value: x.id }))} />
        </Field>
        <Field label="How many recipients">
          <Select value={bulk ? 'bulk' : 'one'} onChange={(v) => setBulk(v === 'bulk')} options={[{ label: 'One recipient', value: 'one' }, { label: `Many (bulk, up to ${MAX_BATCH})`, value: 'bulk' }]} />
        </Field>
      </div>
      {t && t.mintApprovalsRequired > 1 && <p className="text-xs text-yellow-300">This type needs {t.mintApprovalsRequired} votes — mint it through a proposal on the VoucherDAO tab.</p>}
      {isMinter === false && t && t.mintApprovalsRequired <= 1 && <p className="text-xs text-yellow-300">Your wallet isn&apos;t a minter of this type — add it under Minters (this tab).</p>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {!bulk ? (
          <>
            <Field label="Recipient"><AddressInput value={f.to} onChange={(v) => set('to', v)} options={[{ label: 'Connected wallet', value: ctx.account }]} /></Field>
            <Field label="Quantity" hint={`Identical vouchers to this recipient (1–${MAX_BATCH}).`}><input className={inputCls} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} /></Field>
            <Field label={nft721 ? 'Value (1)' : 'Value'} hint={fungible(t) ? 'In token units, e.g. 12.5' : reward ? 'Quantity of the item' : 'Whole number of points'}>
              <input className={inputCls} value={f.faceValue} onChange={(e) => set('faceValue', e.target.value)} />
            </Field>
          </>
        ) : (
          <div className="md:col-span-3">
            <Field label="Recipients" hint={`One per line: address, amount${nft721 ? ', tokenId' : ''} (${fungible(t) ? 'token units' : 'whole number'}).`}>
              <textarea className={`${inputCls} h-28`} value={f.rows} onChange={(e) => set('rows', e.target.value)} placeholder={'0xabc…, 10\n0xdef…, 25'} />
            </Field>
          </div>
        )}
        {reward && (
          <Field label="Payout token" hint="One of the type's approved tokens.">
            <Select value={token} onChange={(v) => set('token', v)} options={(t?.approvedTokens.length ? t.approvedTokens : [ZERO]).map((a) => ({ label: sameAddr(a, ZERO) ? 'Native coin' : ctx.nameOf(a), value: a }))} />
          </Field>
        )}
        {nft721 && !bulk && <Field label="NFT token id"><input className={inputCls} value={f.tokenId} onChange={(e) => set('tokenId', e.target.value)} /></Field>}
        <Field label="Claimable from (optional)"><input type="datetime-local" className={inputCls} value={f.start} onChange={(e) => set('start', e.target.value)} /></Field>
        <Field label="Expires (optional)"><input type="datetime-local" className={inputCls} value={f.expiry} onChange={(e) => set('expiry', e.target.value)} /></Field>
      </div>
      <button className={btnCls} disabled={busy || !t || t.mintApprovalsRequired > 1 || isMinter === false} onClick={mint}>{busy ? 'Minting…' : bulk ? 'Mint all' : 'Mint'}</button>
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}

// ── My vouchers (with Claim) / Browse (filters + per-type totals) ──
function ListPanel({ types, mine, readVoucher, showValue, statusOf }: {
  types: VoucherType[];
  mine?: boolean;
  readVoucher: (nft: ethers.Contract, id: number) => Promise<Voucher>;
  showValue: (v: Voucher) => string;
  statusOf: (v: Voucher, now: number) => { tone: 'good' | 'bad' | 'warn' | 'muted'; text: string };
}) {
  const ctx = useVoucherV2();
  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState(-1);
  const [holder, setHolder] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  // revokeVoucher() needs REVOKE_ROLE on VoucherNFT
  const [canRevoke, setCanRevoke] = useState(false);
  useEffect(() => {
    if (!ctx.reader || mine) return;
    ctx.read('VoucherNFT').hasRole(ethers.utils.id('REVOKE_ROLE'), ctx.account).then(setCanRevoke).catch(() => setCanRevoke(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.reader, ctx.account, mine, ctx.revision]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const load = useCallback(async () => {
    if (!ctx.reader) return;
    setLoading(true);
    try {
      const nft = ctx.read('VoucherNFT');
      const ids: number[] = [];
      if (mine) {
        const n = (await nft.balanceOf(ctx.account)).toNumber();
        for (let i = 0; i < Math.min(n, SCAN_LIMIT); i++) ids.push((await nft.tokenOfOwnerByIndex(ctx.account, i)).toNumber());
      } else {
        const total = (await nft.totalSupply()).toNumber();
        for (let i = total - 1; i >= 0 && ids.length < SCAN_LIMIT; i--) ids.push((await nft.tokenByIndex(i)).toNumber());
      }
      const out = await Promise.all(ids.map((id) => readVoucher(nft, id)));
      setRows(out.sort((a, b) => b.id - a.id));
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not load vouchers: ${e.message}` });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, ctx.reader, ctx.account, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  const claim = async (v: Voucher) => {
    setBusyId(v.id);
    setMsg(null);
    try {
      await ctx.send(`Claim voucher #${v.id}`, ctx.write('VoucherNFT'), 'claim', [v.id]);
      setMsg({ ok: true, text: `Claimed voucher #${v.id} — ${showValue(v)}` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (v: Voucher) => {
    const reason = window.prompt(`Revoke voucher #${v.id}? It moves to the type's revoke destination and can no longer be claimed. Reason (stored on-chain):`, '');
    if (reason === null) return;
    setBusyId(v.id);
    setMsg(null);
    try {
      await ctx.send(`Revoke voucher #${v.id}`, ctx.write('VoucherNFT'), 'revokeVoucher', [v.id, reason.trim()]);
      setMsg({ ok: true, text: `Revoked voucher #${v.id}` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusyId(null);
    }
  };

  const shown = (rows || []).filter((v) => (typeFilter < 0 || v.typeId === typeFilter) && (!holder || sameAddr(v.owner, holder)));
  // per-type totals over what was loaded
  const totals = types.map((t) => {
    const of = (rows || []).filter((v) => v.typeId === t.id);
    return {
      t,
      minted: of.length,
      claimed: of.filter((v) => v.redeemed).length,
      revoked: of.filter((v) => v.revoked).length,
      expired: of.filter((v) => !v.redeemed && !v.revoked && v.expiryDate && now > v.expiryDate).length,
      open: of.filter((v) => !v.redeemed && !v.revoked && !(v.expiryDate && now > v.expiryDate)).length,
    };
  }).filter((x) => x.minted > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64"><Field label="Type"><Select value={typeFilter} onChange={setTypeFilter} options={[{ label: 'All types', value: -1 }, ...types.map((t) => ({ label: typeLabel(t), value: t.id }))]} /></Field></div>
        {!mine && <div className="flex-1 min-w-[240px]"><Field label="Holder"><AddressInput value={holder} onChange={setHolder} placeholder="any — or paste an address" options={[{ label: 'Connected wallet', value: ctx.account }]} /></Field></div>}
        <button className={btnSecondaryCls} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Reload'}</button>
      </div>

      {!mine && totals.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-txt-secondary border-b border-white/10">{['Type', 'Minted', 'Open', 'Claimed', 'Revoked', 'Expired'].map((h) => <th key={h} className="py-2 pr-3">{h}</th>)}</tr></thead>
            <tbody>
              {totals.map((x) => (
                <tr key={x.t.id} className="border-b border-white/5">
                  <td className="py-1.5 pr-3">{typeLabel(x.t)}</td><td className="py-1.5 pr-3">{x.minted}</td><td className="py-1.5 pr-3">{x.open}</td>
                  <td className="py-1.5 pr-3">{x.claimed}</td><td className="py-1.5 pr-3">{x.revoked}</td><td className="py-1.5 pr-3">{x.expired}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-txt-secondary border-b border-white/10">
              {['#', 'Type', 'Value', ...(mine ? [] : ['Holder']), 'Claimable from', 'Expires', 'Status', ''].map((h) => <th key={h} className="py-2 pr-3 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => {
              const st = statusOf(v, now);
              const t = types.find((x) => x.id === v.typeId);
              const canClaim = mine && st.text === 'Claimable';
              return (
                <tr key={v.id} className="border-b border-white/5">
                  <td className="py-2 pr-3">{v.id}</td>
                  <td className="py-2 pr-3">{t ? typeLabel(t) : `#${v.typeId}`}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{showValue(v)}{v.reserved && <div className="text-[10px] text-txt-secondary">reserved in pool</div>}</td>
                  {!mine && <td className="py-2 pr-3 font-mono">{ctx.nameOf(v.owner)}</td>}
                  <td className="py-2 pr-3 whitespace-nowrap">{v.startDate ? fmtDate(v.startDate) : 'now'}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{v.expiryDate ? fmtDate(v.expiryDate) : 'never'}</td>
                  <td className="py-2 pr-3"><Badge tone={st.tone}>{st.text}</Badge></td>
                  <td className="py-2 text-right">
                    {canClaim && <button className={btnCls} disabled={busyId !== null} onClick={() => claim(v)}>{busyId === v.id ? 'Claiming…' : 'Claim'}</button>}
                    {!mine && canRevoke && !v.redeemed && !v.revoked && <button className={linkBtnCls} disabled={busyId !== null} onClick={() => revoke(v)}>{busyId === v.id ? 'Revoking…' : 'Revoke'}</button>}
                  </td>
                </tr>
              );
            })}
            {rows && !shown.length && <tr><td colSpan={8} className="py-3 text-txt-secondary">{mine ? 'Your wallet holds no vouchers.' : 'No vouchers match.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {!mine && rows && rows.length >= SCAN_LIMIT && <p className="text-[11px] text-txt-secondary">Showing the newest {SCAN_LIMIT} vouchers.</p>}
      {mine && <p className="text-[11px] text-txt-secondary">Claiming pays the voucher&apos;s value from its type&apos;s pool (or adds / spends points) to you — or to the type&apos;s fixed payout recipient. <button className={linkBtnCls} onClick={load}>Refresh</button></p>}
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}
