'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { UtcDateTimeInput, UtcTime } from '@/components/utc-datetime';
import { utcInputToUnix } from '@/lib/utc-time';
import { ethers } from 'ethers';
import Card from '@/components/card';
import {
  TokenStandard, VoucherMode, VoucherType, ZERO, eventArg, fromUnits, isAddr, loadVoucherTypes, sameAddr, toUnits, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import PoolFundingBox from './pool-funding-box';
import { EditRow, MAX_PER_CALL, MintRow, RecipientRows, blankRow, checkRows } from './mint-csv';
import BulkTracker from './bulk-tracker';
import { makeUpload, saveUpload } from './upload-store';
import { AddressInput, Badge, ContractTag, Field, Select, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

const SCAN_LIMIT = 2000; // vouchers read per browse scan (newest first)
const MAX_BATCH = 50; // VoucherConstants.MAX_MINT_PER_CALL

interface Voucher {
  id: number;
  owner: string;
  typeId: number;
  faceValue: ethers.BigNumber;
  token: string;
  startDate: number;
  expiryDate: number;
  claimed: boolean;
  revoked: boolean;
  reserved: boolean;
}

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
// total value a mint form will reserve, in 18-dp fixed point (0 when it can't be parsed yet)
const neededFor = (t: VoucherType | undefined, bulk: boolean, quantity: string, value: string, rows: MintRow[]) => {
  if (!fungible(t)) return ethers.BigNumber.from(0);
  const p = (v: string) => { try { return ethers.utils.parseUnits((v || '0').trim(), 18); } catch { return ethers.BigNumber.from(0); } };
  if (!bulk) return p(value).mul(Math.max(0, parseInt(quantity || '0', 10) || 0));
  return rows.reduce((s, r) => s.add(p(r.amount)), ethers.BigNumber.from(0));
};


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
    if (v.claimed) return { tone: 'good' as const, text: 'Claimed' };
    if (v.revoked) return { tone: 'bad' as const, text: 'Revoked' };
    if (v.expiryDate && now > v.expiryDate) return { tone: 'muted' as const, text: 'Expired' };
    if (now < v.startDate) return { tone: 'muted' as const, text: 'Not yet claimable' };
    if (typeById.get(v.typeId)?.claimPaused) return { tone: 'warn' as const, text: 'Claiming paused' };
    return { tone: 'warn' as const, text: 'Claimable' };
  };

  const readVoucher = async (nft: ethers.Contract, id: number): Promise<Voucher> => {
    const [v, owner] = await Promise.all([nft.vouchers(id), nft.ownerOf(id).catch(() => ZERO)]);
    return {
      id, owner, typeId: Number(v.typeId), faceValue: ethers.BigNumber.from(v.faceValue), token: v.token,
      startDate: Number(v.startDate), expiryDate: Number(v.expiryDate), claimed: v.claimed, revoked: v.revoked, reserved: v.reserved,
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
  const [f, setF] = useState({ to: ctx.account, quantity: '1', faceValue: '', token: '', tokenId: '0', start: '', expiry: '' });
  const [rows, setRows] = useState<EditRow[]>([blankRow()]);
  const [isMinter, setIsMinter] = useState<boolean | null>(null);
  // vouchers this wallet may still mint of the type in its current cap window (getMinterCap)
  const [capLeft, setCapLeft] = useState<ethers.BigNumber | null>(null);
  const [short, setShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => { if (typeId < 0 && types.length) setTypeId((types.find((x) => x.approvalsRequired <= 1) ?? types[0]).id); }, [types, typeId]);
  useEffect(() => {
    if (typeId < 0 || !ctx.reader) return setIsMinter(null);
    const nft = ctx.read('VoucherNFT');
    nft.typeMinterRole(typeId).then((r: string) => nft.hasRole(r, ctx.account)).then(setIsMinter).catch(() => setIsMinter(null));
    nft.getMinterCap(typeId, ctx.account).then((cap: any) => {
      const fresh = Date.now() / 1000 >= cap.windowStart.add(cap.windowDuration).toNumber();
      setCapLeft(cap.limit.sub(fresh ? 0 : cap.usedInWindow));
    }).catch(() => setCapLeft(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, ctx.reader, ctx.account, ctx.revision]);

  const reward = t?.mode === VoucherMode.Reward;
  const nft721 = reward && t?.tokenStandard === TokenStandard.ERC721;
  // ERC721 and ERC1155 payouts name a specific token id per voucher
  const needsId = reward && (t?.tokenStandard === TokenStandard.ERC721 || t?.tokenStandard === TokenStandard.ERC1155);
  const parsed = useMemo(() => checkRows(rows, fungible(t), !!needsId), [rows, t, needsId]);
  const overCap = capLeft !== null && capLeft.lt(bulk ? parsed.rows.length : parseInt(f.quantity, 10) || 0);
  const toFace = (v: string) => (fungible(t) ? toUnits(v, 18) : String(Math.max(0, parseInt(v || '0', 10) || 0)));
  const token = reward ? f.token || t?.approvedTokens[0] || ZERO : ZERO;
  const [uploadsVersion, setUploadsVersion] = useState(0);
  // the shared bulk tracker (page key "direct"): opens an upload and, with send, its review dialog
  const [kick, setKick] = useState<{ uploadId: string; n: number; send?: boolean } | null>(null);
  const directParams = () => ({ token, startDate: utcInputToUnix(f.start), expiryDate: utcInputToUnix(f.expiry), duration: 0 });

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
        if (needsId && !/^\d+$/.test(f.tokenId)) throw new Error('Enter the NFT token id');
        const receipt = await ctx.send(`Mint ${q}× type ${t.id} → ${ctx.nameOf(f.to)}`, nft, 'mint', [t.id, f.to, q, toFace(f.faceValue), utcInputToUnix(f.start), utcInputToUnix(f.expiry), token, needsId ? f.tokenId : 0]);
        setMsg({ ok: true, text: `Minted voucher #${eventArg(receipt, nft, 'VoucherMinted', 'voucherId').toString()}${q > 1 ? ` (+${q - 1} more)` : ''}` });
      } else {
        const { rows: list, errors } = parsed;
        if (errors.length) throw new Error(`Fix the recipient list first: ${errors.slice(0, 3).join('; ')}`);
        if (!list.length) throw new Error('Add recipients, or upload a CSV');
        // saved as a bulk upload first (Bulk uploads, below): each mintBatch-sized batch is tracked,
        // so a list that stops halfway resumes from there instead of minting twice. The review dialog
        // (all details + every wallet) opens before anything is sent.
        const nftAddr = ctx.book.contracts.VoucherNFT;
        if (!nftAddr) throw new Error('VoucherNFT address missing');
        const p = directParams();
        const u = makeUpload({
          chainId: ctx.chainId, addr: nftAddr, scope: 'direct', typeId: t.id, token: p.token, startDate: p.startDate, expiryDate: p.expiryDate,
          name: `List of ${list.length} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, maxBatch: MAX_PER_CALL,
          files: [{ rows: list.map((r) => ({ to: r.to, face: toFace(r.amount), tokenId: r.tokenId || '0' })) }],
        });
        await saveUpload(u);
        setRows([blankRow()]);
        setUploadsVersion((v) => v + 1);
        setKick({ uploadId: u.id, n: Date.now(), send: true });
        setMsg({ ok: true, text: `Saved as an upload (${u.batches.length} batch${u.batches.length === 1 ? '' : 'es'}) — check the details in the dialog and confirm to mint. Progress shows under Bulk uploads (below).` });
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
          <Select value={typeId} onChange={setTypeId} options={types.map((x) => ({ label: `${typeLabel(x)}${x.approvalsRequired > 1 ? ' — mint via VoucherDAO' : ''}`, value: x.id }))} />
        </Field>
        <Field label="How many recipients">
          <Select value={bulk ? 'bulk' : 'one'} onChange={(v) => setBulk(v === 'bulk')} options={[{ label: 'One recipient', value: 'one' }, { label: 'Many (list or CSV)', value: 'bulk' }]} />
        </Field>
      </div>
      {t && t.approvalsRequired > 1 && <p className="text-xs text-yellow-300">This type needs {t.approvalsRequired} votes — mint it through a proposal on the VoucherDAO tab.</p>}
      {isMinter === false && t && t.approvalsRequired <= 1 && <p className="text-xs text-yellow-300">Your wallet isn&apos;t a minter of this type — add it under Minters (this tab).</p>}
      {isMinter && overCap && <p className="text-xs text-yellow-300">Your minting cap for this type has only {capLeft!.toString()} voucher(s) left in the current window — raise it under Roles (setMinterCap) or mint fewer.</p>}
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
            <RecipientRows rows={rows} onChange={setRows} needsId={!!needsId} check={parsed} perTx="transaction"
              amountLabel={fungible(t) ? 'Amount (tokens)' : t?.mode === VoucherMode.Points ? 'Points' : 'Quantity'}
              total={fungible(t) ? `${fromUnits(neededFor(t, true, '', '', parsed.rows), 18)} ${sameAddr(token, ZERO) ? 'native coin' : ctx.nameOf(token)}` : nft721 ? undefined : `${parsed.rows.reduce((s, r) => s + Number(r.amount), 0)} ${t?.mode === VoucherMode.Points ? 'points' : 'items'}`}
              onLoaded={(text) => setMsg({ ok: !/^(CSV|Failed)/.test(text), text })} />
          </div>
        )}
        {reward && (
          <Field label="Payout token" hint="One of the type's approved tokens.">
            <Select value={token} onChange={(v) => set('token', v)} options={(t?.approvedTokens.length ? t.approvedTokens : [ZERO]).map((a) => ({ label: sameAddr(a, ZERO) ? 'Native coin' : ctx.nameOf(a), value: a }))} />
          </Field>
        )}
        {needsId && !bulk && <Field label="NFT token id"><input className={inputCls} value={f.tokenId} onChange={(e) => set('tokenId', e.target.value)} /></Field>}
        <Field label="Claimable from — your local time (optional)"><UtcDateTimeInput className={inputCls} value={f.start} onChange={(v) => set('start', v)} /></Field>
        <Field label="Expires — your local time (optional)"><UtcDateTimeInput className={inputCls} value={f.expiry} onChange={(v) => set('expiry', v)} /></Field>
      </div>
      {t && t.approvalsRequired <= 1 && <PoolFundingBox type={t} token={token} needed={neededFor(t, bulk, f.quantity, f.faceValue, parsed.rows)} onShort={setShort} />}
      <button className={btnCls} disabled={busy || !t || t.approvalsRequired > 1 || isMinter === false || short || overCap || (bulk && (!parsed.rows.length || parsed.errors.length > 0))} onClick={mint}>{busy ? 'Minting…' : bulk ? `Mint all${parsed.rows.length ? ` (${parsed.rows.length})` : ''}` : 'Mint'}</button>
      {short && <span className="text-xs text-yellow-300 ml-3">Top up the pool first (above) — minting now would fail.</span>}
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      {bulk && t && t.approvalsRequired <= 1 && (
        <BulkTracker mode="direct" type={t} params={directParams} version={uploadsVersion} kick={kick} onChange={() => setUploadsVersion((v) => v + 1)} />
      )}
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
      claimed: of.filter((v) => v.claimed).length,
      revoked: of.filter((v) => v.revoked).length,
      expired: of.filter((v) => !v.claimed && !v.revoked && v.expiryDate && now > v.expiryDate).length,
      open: of.filter((v) => !v.claimed && !v.revoked && !(v.expiryDate && now > v.expiryDate)).length,
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
                  <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.startDate} empty="now" /></td>
                  <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.expiryDate} empty="never" /></td>
                  <td className="py-2 pr-3"><Badge tone={st.tone}>{st.text}</Badge></td>
                  <td className="py-2 text-right">
                    {canClaim && <button className={btnCls} disabled={busyId !== null} onClick={() => claim(v)}>{busyId === v.id ? 'Claiming…' : 'Claim'}</button>}
                    {!mine && canRevoke && !v.claimed && !v.revoked && <button className={linkBtnCls} disabled={busyId !== null} onClick={() => revoke(v)}>{busyId === v.id ? 'Revoking…' : 'Revoke'}</button>}
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
