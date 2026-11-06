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
import { clearIndex, indexKey, isMinted, loadIndex, readOwnerIds, readVouchers, saveToIndex, type IndexedVoucher } from '@/lib/contracts/voucher-v2/voucher-index';
import { getBatchSupport, type BatchCall, type BatchReceipt, type BatchSupport } from '@/lib/contracts/wallet-batch';
import { AddressInput, Badge, ContractTag, Field, Select, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

const SCAN_LIMIT = 2000; // vouchers read per browse scan (newest first)
const MAX_BATCH = 50; // VoucherConstants.MAX_MINT_PER_CALL
// revokeVoucher calls per wallet_sendCalls request — wallets cap batch size (MetaMask: 10)
const REVOKE_BATCH = 10;
const MAX_RANGE = 1000; // voucher numbers one "Select range" may read from the chain

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
      {part === 'mine' && <ListPanel types={types} mine showValue={showValue} statusOf={statusOf} />}
      {part === 'browse' && <ListPanel types={types} showValue={showValue} statusOf={statusOf} />}
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
const toVoucher = (x: IndexedVoucher): Voucher => ({ ...x, faceValue: ethers.BigNumber.from(x.faceValue) });

function ListPanel({ types, mine, showValue, statusOf }: {
  types: VoucherType[];
  mine?: boolean;
  showValue: (v: Voucher) => string;
  statusOf: (v: Voucher, now: number) => { tone: 'good' | 'bad' | 'warn' | 'muted'; text: string };
}) {
  const ctx = useVoucherV2();
  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState(-1);
  const [holder, setHolder] = useState('');
  // identical vouchers (same type, value, holder, dates, status) shown as one row with a count
  const [grouped, setGrouped] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [range, setRange] = useState({ from: '', to: '' });
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
  // multi-select revoke: wallet batching (EIP-5792) — atomic on smart accounts, else one tx per voucher
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState('');
  const [support, setSupport] = useState<BatchSupport | null>(null);
  // bump to ask the wallet again (e.g. after it upgraded the account to a smart account)
  const [supportCheck, setSupportCheck] = useState(0);
  useEffect(() => {
    if (mine || !canRevoke || !ctx.signer || !ctx.account) { setSupport(null); return; }
    let live = true;
    setSupport(null);
    getBatchSupport(ctx.signer, ctx.account, ctx.chainId).then((s) => { if (live) setSupport(s); });
    return () => { live = false; };
  }, [mine, canRevoke, ctx.signer, ctx.account, ctx.chainId, supportCheck]);

  // local index (IndexedDB): the list opens from it instantly, then refreshes via Multicall3
  const nftAddr = ctx.book.contracts.VoucherNFT || '';
  const key = indexKey(ctx.chainId, nftAddr);
  const [indexInfo, setIndexInfo] = useState<{ cached: number; at: number | null; fromCache: boolean }>({ cached: 0, at: null, fromCache: false });
  // older vouchers pulled in by "Select range" — kept across reloads (re-read with every refresh)
  const extraIds = React.useRef<Set<number>>(new Set());
  useEffect(() => { extraIds.current = new Set(); setRows(null); setSelected(new Set()); }, [key]);

  const load = useCallback(async () => {
    if (!ctx.reader || !nftAddr) return;
    setLoading(true);
    try {
      const nft = ctx.read('VoucherNFT');
      const cached = await loadIndex(key);
      const all = Object.values(cached);
      // 1) instant view from the index (marked as cached until the refresh lands)
      const view = (mine ? all.filter((v) => sameAddr(v.owner, ctx.account)) : all.sort((a, b) => b.id - a.id).slice(0, SCAN_LIMIT));
      setRows((r) => (r === null && view.length ? view.map(toVoucher).sort((a, b) => b.id - a.id) : r));
      setIndexInfo({ cached: all.length, at: null, fromCache: true });
      // 2) fresh read: which ids, then all vouchers in a few Multicall3 calls
      let ids: number[];
      if (mine) {
        const n = (await nft.balanceOf(ctx.account)).toNumber();
        ids = await readOwnerIds(nft, ctx.account, Math.min(n, SCAN_LIMIT));
      } else {
        const next = (await nft.nextVoucherId()).toNumber(); // ids are sequential; ownerOf fails for unminted
        ids = Array.from({ length: Math.min(next, SCAN_LIMIT) }, (_, k) => next - 1 - k);
        extraIds.current.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
      }
      const fresh = (await readVouchers(nft, ids, cached)).filter(isMinted);
      await saveToIndex(key, fresh);
      setRows(fresh.map(toVoucher).sort((a, b) => b.id - a.id));
      setIndexInfo({ cached: Object.keys({ ...cached, ...Object.fromEntries(fresh.map((v) => [v.id, 1])) }).length, at: Date.now(), fromCache: false });
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not load vouchers: ${e.message}` });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, ctx.reader, ctx.account, ctx.revision, key]);

  const resetIndex = async () => {
    await clearIndex(key);
    extraIds.current = new Set();
    setRows(null);
    load();
  };

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

  const revokeSelected = async () => {
    const ids = (rows || []).filter((v) => selected.has(v.id) && !v.claimed && !v.revoked).map((v) => v.id).sort((a, b) => a - b);
    if (!ids.length) return;
    const how = support?.atomic ? `in one atomic transaction${ids.length > REVOKE_BATCH ? ` per ${REVOKE_BATCH}` : ''} (all or none)`
      : support?.supported ? 'as one wallet batch (not atomic — each call can succeed or fail on its own)'
      : `as ${ids.length} separate transactions`;
    const reason = window.prompt(`Revoke ${ids.length} voucher${ids.length > 1 ? 's' : ''} (#${ids.join(', #')}) ${how}? They move to each type's revoke destination and can no longer be claimed. Reason (stored on-chain, same for all):`, '');
    if (reason === null) return;
    const why = reason.trim();
    const nft = ctx.write('VoucherNFT');
    setBulkBusy(true);
    setMsg(null);
    const done: number[] = [];
    const failed: string[] = [];
    try {
      // pre-check every call: one revert would sink a whole atomic batch
      setBulkNote('pre-checking…');
      const ok: number[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        const part = ids.slice(i, i + 10);
        const res = await Promise.all(part.map((id) => nft.estimateGas.revokeVoucher(id, why).then(() => '', (e: any) => e?.reason || e?.error?.message || e?.message || 'reverts')));
        part.forEach((id, j) => (res[j] ? failed.push(`#${id}: would revert (${res[j]})`) : ok.push(id)));
      }
      if (support?.supported) {
        for (let i = 0; i < ok.length; i += REVOKE_BATCH) {
          const chunk = ok.slice(i, i + REVOKE_BATCH);
          const calls: BatchCall[] = chunk.map((id) => ({ to: nft.address, data: nft.interface.encodeFunctionData('revokeVoucher', [id, why]) }));
          setBulkNote(`confirm ${support.atomic ? 'atomic ' : ''}batch of ${chunk.length} in wallet…`);
          try {
            await ctx.sendCalls(`Revoke vouchers #${chunk.join(', #')}${support.atomic ? ' (atomic)' : ' (batch)'}`, calls, support.atomic);
            done.push(...chunk);
          } catch (e: any) {
            const rc: BatchReceipt[] | undefined = e?.result?.receipts;
            if (!support.atomic && rc && rc.length === chunk.length) {
              chunk.forEach((id, j) => (rc[j].status ? done.push(id) : failed.push(`#${id}: reverted`)));
            } else {
              chunk.forEach((id) => failed.push(`#${id}: ${e.message}`));
            }
            if (/reject|denied/i.test(e?.message || '')) break; // user said no — don't pop the next batch
          }
        }
      } else {
        for (const id of ok) {
          setBulkNote(`revoking #${id} (${done.length + 1}/${ok.length}) — confirm in wallet…`);
          try {
            await ctx.send(`Revoke voucher #${id}`, nft, 'revokeVoucher', [id, why]);
            done.push(id);
          } catch (e: any) {
            failed.push(`#${id}: ${e.message}`);
            if (/reject|denied/i.test(e?.message || '')) break;
          }
        }
      }
    } finally {
      setBulkBusy(false);
      setBulkNote('');
      setSelected((s) => { const n = new Set(s); done.forEach((id) => n.delete(id)); return n; });
      const parts = [done.length ? `Revoked ${done.length}: #${done.join(', #')}` : '', failed.length ? `Not revoked — ${failed.join('; ')}` : ''].filter(Boolean);
      setMsg({ ok: !failed.length, text: parts.join('. ') || 'Nothing revoked' });
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
  const selectable = !mine && canRevoke;
  const revocableShown = shown.filter((v) => !v.claimed && !v.revoked);
  const selCount = (rows || []).filter((v) => selected.has(v.id) && !v.claimed && !v.revoked).length;
  const allShownSelected = revocableShown.length > 0 && revocableShown.every((v) => selected.has(v.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    revocableShown.forEach((v) => (allShownSelected ? n.delete(v.id) : n.add(v.id)));
    return n;
  });

  // group consecutive-or-not duplicates, keeping the newest-first order of each group's first voucher
  const groups = useMemo(() => {
    const m = new Map<string, Voucher[]>();
    for (const v of shown) {
      const k = [v.typeId, v.faceValue.toString(), v.token.toLowerCase(), v.owner.toLowerCase(), v.startDate, v.expiryDate, statusOf(v, now).text, v.reserved].join('|');
      const g = m.get(k);
      if (g) g.push(v); else m.set(k, [v]);
    }
    return [...m.entries()].map(([key, items]) => ({ key, items }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((v) => v.id).join(','), rows]);
  const idsLabel = (items: Voucher[]) => {
    const ids = items.map((v) => v.id).sort((a, b) => a - b);
    const contiguous = ids[ids.length - 1] - ids[0] === ids.length - 1;
    return contiguous ? `#${ids[0]}–#${ids[ids.length - 1]}` : ids.length <= 4 ? `#${ids.join(', #')}` : `#${ids.slice(0, 3).join(', #')} … #${ids[ids.length - 1]}`;
  };
  const toggleGroup = (items: Voucher[]) => setSelected((s) => {
    const rev = items.filter((v) => !v.claimed && !v.revoked);
    const all = rev.every((v) => s.has(v.id));
    const n = new Set(s);
    rev.forEach((v) => (all ? n.delete(v.id) : n.add(v.id)));
    return n;
  });
  // tick every revocable voucher with from ≤ id ≤ to (within the current Type / Holder filters).
  // Numbers outside the loaded list (older than the newest SCAN_LIMIT) are read from the chain first.
  const [rangeBusy, setRangeBusy] = useState(false);
  const rangeBounds = (() => {
    const a = parseInt(range.from, 10), b = parseInt(range.to || range.from, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a <= b ? [a, b] as const : [b, a] as const;
  })();
  const rangeTooBig = !!rangeBounds && rangeBounds[1] - rangeBounds[0] + 1 > MAX_RANGE;
  const selectRange = async () => {
    if (!rangeBounds || rangeTooBig || !ctx.reader) return;
    const [lo, hi] = rangeBounds;
    setRangeBusy(true);
    setMsg(null);
    try {
      const have = new Map((rows || []).map((v) => [v.id, v]));
      const missing: number[] = [];
      for (let id = lo; id <= hi; id++) if (!have.has(id)) missing.push(id);
      const nft = ctx.read('VoucherNFT');
      // ownerOf() fails for numbers never minted (or burned) → skipped; results go into the local index
      const read = (await readVouchers(nft, missing, await loadIndex(key))).filter(isMinted);
      await saveToIndex(key, read);
      read.forEach((v) => extraIds.current.add(v.id));
      const fetched = read.map(toVoucher);
      if (fetched.length) setRows((r) => [...(r || []), ...fetched].sort((a, b) => b.id - a.id));
      const all = [...have.values(), ...fetched];
      const pick = all.filter((v) => v.id >= lo && v.id <= hi && !v.claimed && !v.revoked
        && (typeFilter < 0 || v.typeId === typeFilter) && (!holder || sameAddr(v.owner, holder))).map((v) => v.id);
      setSelected((s) => { const n = new Set(s); pick.forEach((id) => n.add(id)); return n; });
      const found = all.filter((v) => v.id >= lo && v.id <= hi).length;
      setMsg({ ok: pick.length > 0, text: pick.length
        ? `Selected ${pick.length} voucher${pick.length > 1 ? 's' : ''} in #${lo}–#${hi}${found > pick.length ? ` (${found - pick.length} skipped: claimed, revoked or not matching the filters)` : ''}${fetched.length ? ` — ${fetched.length} read from the chain` : ''}`
        : `No revocable vouchers in #${lo}–#${hi}${found ? ` (${found} found, all claimed, revoked or not matching the filters)` : ' — none exist'}` });
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not read vouchers: ${e.message}` });
    } finally {
      setRangeBusy(false);
    }
  };
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const renderRow = (v: Voucher, child = false) => {
    const st = statusOf(v, now);
    const t = types.find((x) => x.id === v.typeId);
    const canClaim = mine && st.text === 'Claimable';
    return (
      <tr key={v.id} className={`border-b border-white/5 ${child ? 'bg-white/[0.02]' : ''}`}>
        {selectable && <td className="py-2 pr-2">{!v.claimed && !v.revoked && <input type="checkbox" className="accent-accent" checked={selected.has(v.id)} disabled={bulkBusy} onChange={() => toggle(v.id)} />}</td>}
        <td className={`py-2 pr-3 ${child ? 'pl-4 text-txt-secondary' : ''}`}>{v.id}</td>
        <td className="py-2 pr-3">{t ? typeLabel(t) : `#${v.typeId}`}</td>
        <td className="py-2 pr-3 whitespace-nowrap">{showValue(v)}{v.reserved && <div className="text-[10px] text-txt-secondary">reserved in pool</div>}</td>
        {!mine && <td className="py-2 pr-3 font-mono">{ctx.nameOf(v.owner)}</td>}
        <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.startDate} empty="now" /></td>
        <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.expiryDate} empty="never" /></td>
        <td className="py-2 pr-3"><Badge tone={st.tone}>{st.text}</Badge></td>
        <td className="py-2 text-right">
          {canClaim && <button className={btnCls} disabled={busyId !== null} onClick={() => claim(v)}>{busyId === v.id ? 'Claiming…' : 'Claim'}</button>}
          {!mine && canRevoke && !v.claimed && !v.revoked && <button className={linkBtnCls} disabled={busyId !== null || bulkBusy} onClick={() => revoke(v)}>{busyId === v.id ? 'Revoking…' : 'Revoke'}</button>}
        </td>
      </tr>
    );
  };

  const renderGroup = (key: string, items: Voucher[]) => {
    const v = items[0];
    const st = statusOf(v, now);
    const t = types.find((x) => x.id === v.typeId);
    const rev = items.filter((x) => !x.claimed && !x.revoked);
    const nSel = rev.filter((x) => selected.has(x.id)).length;
    const isOpen = open.has(key);
    return (
      <React.Fragment key={key}>
        <tr className="border-b border-white/5 bg-white/[0.03]">
          {selectable && (
            <td className="py-2 pr-2">
              {rev.length > 0 && (
                <input type="checkbox" className="accent-accent" checked={nSel === rev.length} disabled={bulkBusy}
                  ref={(el) => { if (el) el.indeterminate = nSel > 0 && nSel < rev.length; }}
                  onChange={() => toggleGroup(items)} title={`Select all ${rev.length} in this group`} />
              )}
            </td>
          )}
          <td className="py-2 pr-3 whitespace-nowrap">
            <button className="text-accent hover:underline" onClick={() => flip(key)}>{isOpen ? '▾' : '▸'} {idsLabel(items)}</button>
            <span className="ml-1.5 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">×{items.length}</span>
          </td>
          <td className="py-2 pr-3">{t ? typeLabel(t) : `#${v.typeId}`}</td>
          <td className="py-2 pr-3 whitespace-nowrap">{showValue(v)} <span className="text-txt-secondary">each</span>{v.reserved && <div className="text-[10px] text-txt-secondary">reserved in pool</div>}</td>
          {!mine && <td className="py-2 pr-3 font-mono">{ctx.nameOf(v.owner)}</td>}
          <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.startDate} empty="now" /></td>
          <td className="py-2 pr-3 whitespace-nowrap"><UtcTime ts={v.expiryDate} empty="never" /></td>
          <td className="py-2 pr-3"><Badge tone={st.tone}>{st.text}</Badge></td>
          <td className="py-2 text-right text-txt-secondary">{nSel > 0 ? `${nSel} selected` : <button className={linkBtnCls} onClick={() => flip(key)}>{isOpen ? 'Hide' : 'Show all'}</button>}</td>
        </tr>
        {isOpen && items.map((x) => renderRow(x, true))}
      </React.Fragment>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64"><Field label="Type"><Select value={typeFilter} onChange={setTypeFilter} options={[{ label: 'All types', value: -1 }, ...types.map((t) => ({ label: typeLabel(t), value: t.id }))]} /></Field></div>
        {!mine && <div className="flex-1 min-w-[240px]"><Field label="Holder"><AddressInput value={holder} onChange={setHolder} placeholder="any — or paste an address" options={[{ label: 'Connected wallet', value: ctx.account }]} /></Field></div>}
        <button className={btnSecondaryCls} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Reload'}</button>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-txt-secondary cursor-pointer select-none">
          <input type="checkbox" className="accent-accent" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group identical vouchers
        </label>
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

      {selectable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-surface-tertiary px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-txt-secondary">Voucher #</span>
            <input className={`${inputCls} !w-20 !py-1`} inputMode="numeric" placeholder="from" value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value.replace(/\D/g, '') })} />
            <span className="text-txt-secondary">to</span>
            <input className={`${inputCls} !w-20 !py-1`} inputMode="numeric" placeholder="to" value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value.replace(/\D/g, '') })}
              onKeyDown={(e) => { if (e.key === 'Enter' && !rangeBusy && !bulkBusy) selectRange(); }} />
            <button className={btnSecondaryCls} disabled={!rangeBounds || rangeTooBig || rangeBusy || bulkBusy} onClick={selectRange}
              title="Selects every voucher in the range that matches the filters and can still be revoked (reads older ones from the chain)">
              {rangeBusy ? 'Reading…' : 'Select'}
            </button>
            {rangeTooBig && <span className="text-red-300">max {MAX_RANGE} at a time</span>}
          </span>
          <span className="text-txt-secondary">{selCount ? `${selCount} selected` : 'or tick vouchers below'}</span>
          {selCount > 0 && (
            <>
              <button className={btnCls} disabled={bulkBusy || busyId !== null} onClick={revokeSelected}>{bulkBusy ? 'Revoking…' : `Revoke ${selCount}`}</button>
              <button className={linkBtnCls} disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
            </>
          )}
          <span className="ml-auto flex items-center gap-2" title={support?.detail}>
            {support === null ? <Badge tone="muted">checking wallet…</Badge>
              : support.atomic ? <Badge tone="good">Smart account — atomic tx</Badge>
              : support.supported ? <Badge tone="warn">Wallet batch — not atomic</Badge>
              : <Badge tone="muted">One tx per voucher</Badge>}
            <button className={linkBtnCls} disabled={support === null || bulkBusy} onClick={() => setSupportCheck((n) => n + 1)}
              title="Ask the wallet again what it supports — use after upgrading to a smart account or switching wallet/network">
              Re-check
            </button>
          </span>
          {bulkNote && <span className="w-full text-txt-secondary">{bulkNote}</span>}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-txt-secondary border-b border-white/10">
              {selectable && <th className="py-2 pr-2 w-6"><input type="checkbox" className="accent-accent" checked={allShownSelected} disabled={!revocableShown.length || bulkBusy} onChange={toggleAll} title="Select all revocable vouchers shown" /></th>}
              {['#', 'Type', 'Value', ...(mine ? [] : ['Holder']), 'Claimable from', 'Expires', 'Status', ''].map((h) => <th key={h} className="py-2 pr-3 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {grouped
              ? groups.map((g) => (g.items.length > 1 ? renderGroup(g.key, g.items) : renderRow(g.items[0])))
              : shown.map((v) => renderRow(v))}
            {rows && !shown.length && <tr><td colSpan={9} className="py-3 text-txt-secondary">{mine ? 'Your wallet holds no vouchers.' : 'No vouchers match.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {!mine && rows && rows.length >= SCAN_LIMIT && <p className="text-[11px] text-txt-secondary">Showing the newest {SCAN_LIMIT} vouchers{extraIds.current.size ? ` + ${extraIds.current.size} older from Select range` : ''}.</p>}
      <p className="text-[11px] text-txt-secondary">
        Local index: {indexInfo.cached} voucher{indexInfo.cached === 1 ? '' : 's'} cached in this browser
        {indexInfo.fromCache ? (loading ? ' — showing cached list, refreshing from chain…' : '') : indexInfo.at ? ` · refreshed ${new Date(indexInfo.at).toLocaleTimeString()}` : ''}
        {' · '}<button className={linkBtnCls} disabled={loading} onClick={resetIndex} title="Delete the cached vouchers for this VoucherNFT and read everything again">Rebuild index</button>
      </p>
      {mine && <p className="text-[11px] text-txt-secondary">Claiming pays the voucher&apos;s value from its type&apos;s pool (or adds / spends points) to you — or to the type&apos;s fixed payout recipient. <button className={linkBtnCls} onClick={load}>Refresh</button></p>}
      {msg && <p className={`text-xs break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}
