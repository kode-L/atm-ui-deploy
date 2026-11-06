'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UtcDateTimeInput, UtcTime } from '@/components/utc-datetime';
import { fmtLocal, utcInputToUnix } from '@/lib/utc-time';
import { ethers } from 'ethers';
import Card from '@/components/card';
import {
  DEFAULT_ADMIN_ROLE, TokenStandard, eventArg, VoucherMode, VoucherType, ZERO, fromUnits, isAddr, loadVoucherTypes, sameAddr, toUnits, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { NETWORKS } from '@/lib/contracts/config';
import { BulkMatch, findNewBulkProposal, raceWithChain } from './chain-watch';
import { ConfirmRow, useConfirmDialog } from './confirm-dialog';
import { isQueuingWallet } from './safe-api';
import PoolFundingBox from './pool-funding-box';
import BulkTracker, { BulkFocus } from './bulk-tracker';
import { StoredUpload, deleteUpload, listUploads, newUploadId, removeRows, saveUpload } from './upload-store';
import { EditRow, MAX_PER_CALL, MintRow, RecipientRows, blankRow, checkRows, chunk } from './mint-csv';
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
// gas floor when a call mints at once (quorum 1 / last approval). Measured on BSC testnet 2026-11-06:
// Reserved tLUCA ~350k + 254k/row (50 rows = 13.0M), points ~236k/row. 400k + 300k/row covers both
// with ~18% headroom; a Safe gets only this floor (no estimate), an EOA gets max(estimate x1.25, floor).
const execGas = (kind: Kind, vouchers: number) => (kind === 'revoke' ? 600_000 : 400_000 + 300_000 * Math.max(1, vouchers));

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
const neededFor = (t: VoucherType | undefined, kind: string, quantity: string, value: string, rows: MintRow[]) => {
  if (!fungible(t) || kind === 'revoke') return ethers.BigNumber.from(0);
  const p = (v: string) => { try { return ethers.utils.parseUnits((v || '0').trim(), 18); } catch { return ethers.BigNumber.from(0); } };
  if (kind === 'mint') return p(value).mul(Math.max(0, parseInt(quantity || '0', 10) || 0));
  return rows.reduce((s, r) => s.add(p(r.amount)), ethers.BigNumber.from(0));
};
const toFace = (t: VoucherType | undefined, v: string) => (fungible(t) ? toUnits(v, 18) : String(Math.max(0, parseInt(v || '0', 10) || 0)));
const showFace = (t: VoucherType | undefined, v: ethers.BigNumberish) => (fungible(t) ? fromUnits(v, 18) : String(v));

export default function DaoTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const { ask, dialog } = useConfirmDialog(ctx.nameOf);
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
  const [form, setForm] = useState({ to: ctx.account, quantity: '1', faceValue: '', token: '', tokenId: '0', start: '', expiry: '', hours: '72', voucherId: '', reason: '' });
  const [bulkRows, setBulkRows] = useState<EditRow[]>([blankRow()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // bulk uploads (saved in IndexedDB, shown by BulkTracker under the Bulk mint form)
  const [bulkFocus, setBulkFocus] = useState<BulkFocus | null>(null);
  const [uploadsVersion, setUploadsVersion] = useState(0);
  const lastError = useRef('');
  // saved upload files for the "Load a saved file" dropdown; `linked` = the batch now in the rows
  const [saved, setSaved] = useState<StoredUpload[]>([]);
  const [linked, setLinked] = useState<{ uploadId: string; idx: number; sig: string } | null>(null);
  // a Safe / smart account only queues txs and returns its own hash, which never lands on-chain:
  // waiting for that receipt hangs, so for such a wallet we send without waiting (see run)
  const [contractWallet, setContractWallet] = useState(false);
  const [kick, setKick] = useState<{ uploadId: string; n: number } | null>(null); // tell the tracker to follow an upload
  const [csvName, setCsvName] = useState<string | null>(null); // CSV the bulk rows came from (Upload CSV), saved as the upload's name

  const selected = types.find((t) => t.id === typeId);
  // ERC721 and ERC1155 payouts name a specific token id per voucher
  const needsId = selected?.mode === VoucherMode.Reward && (selected.tokenStandard === TokenStandard.ERC721 || selected.tokenStandard === TokenStandard.ERC1155);
  const parsed = useMemo(() => checkRows(bulkRows, fungible(selected), !!needsId), [bulkRows, selected, needsId]);
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
      // an empty reply ("0x") usually means no contract at that address on this network
      // (e.g. testnet addresses while connected to mainnet): say so instead of the raw revert
      const net = NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}`;
      const empty = await Promise.all((['VoucherDAO', 'VoucherNFT'] as const).map(async (k) => {
        const at = c[k];
        const code = at && ctx.reader ? await ctx.reader.getCode(at).catch(() => null) : null;
        return code === '0x' ? `${k} ${at}` : null;
      }));
      const missing = empty.filter(Boolean);
      setMsg({
        ok: false,
        text: missing.length
          ? `No contract on ${net} at ${missing.join(' and ')}. These addresses belong to another network (e.g. testnet) — switch the wallet to the network they were deployed on, or set this network's addresses on the Overview tab.`
          : `Could not read VoucherDAO: ${e.message}`,
      });
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

  useEffect(() => {
    if (!ctx.reader || !ctx.account) return;
    isQueuingWallet(ctx.reader, ctx.account).then(setContractWallet).catch(() => setContractWallet(false));
  }, [ctx.reader, ctx.account]);

  useEffect(() => {
    if (!c.VoucherDAO || typeId < 0) return;
    listUploads(ctx.chainId, c.VoucherDAO).then((list) => setSaved(list.filter((u) => u.typeId === typeId))).catch(() => setSaved([]));
  }, [c.VoucherDAO, ctx.chainId, typeId, uploadsVersion]);

  // identifies a batch by its content, not its position (Remove shifts positions)
  const sigOf = (u: StoredUpload, i: number) => {
    const b = u.batches[i];
    return b ? `${b.file ?? ''}|${b.end - b.start}|${u.rows[b.start]?.to}|${u.rows[b.end - 1]?.to}` : '';
  };
  // fill the Bulk mint form with one saved file (batch): its rows, payout token and dates
  const loadSaved = (key: string) => {
    if (!key) { setLinked(null); return; }
    const [uploadId, i] = key.split('#');
    const u = saved.find((x) => x.id === uploadId);
    const b = u?.batches[Number(i)];
    if (!u || !b || !selected) return;
    setBulkRows(u.rows.slice(b.start, b.end).map((r) => ({ to: r.to, amount: fungible(selected) ? fromUnits(r.face, 18) : r.face, tokenId: needsId ? r.tokenId : '' })));
    setLinked({ uploadId, idx: Number(i), sig: sigOf(u, Number(i)) });
    setCsvName(null);
    setMsg({ ok: true, text: `Loaded ${b.file ?? `batch ${Number(i) + 1}`} (${b.end - b.start} rows) from "${u.name}"` });
  };
  useEffect(() => {
    if (!linked) return;
    const u = saved.find((x) => x.id === linked.uploadId);
    const b = u?.batches[linked.idx];
    if (!u || !b || b.proposalId !== null || b.submittedAt) { setLinked(null); return; }
    if (sigOf(u, linked.idx) !== linked.sig) {
      // the same file moved (a batch before it was removed): follow it, else unlink
      const at = u.batches.findIndex((_, k) => sigOf(u, k) === linked.sig);
      setLinked(at >= 0 ? { ...linked, idx: at } : null);
    }
  }, [saved, linked]);
  const pendingFiles = saved.flatMap((u) => u.batches.map((b, i) => ({ u, b, i })).filter(({ b }) => b.proposalId === null && !b.submittedAt));

  // the receipt once the tx confirmed, { safeTxHash } when a contract wallet (Safe) queued it, null on failure
  // (errors are shown, not thrown)
  // match: for a bulk propose, also watch the chain (from 3s, every 3s) and stop waiting on the
  // wallet as soon as that exact proposal is there
  const run = async (label: string, method: string, args: any[], minGas?: number, match?: BulkMatch): Promise<ethers.ContractReceipt | { safeTxHash: string } | { proposalId: number } | null> => {
    setBusy(true);
    setMsg(null);
    try {
      if (contractWallet) {
        const dao = ctx.write('VoucherDAO');
        const tx = await dao.populateTransaction[method](...args, minGas ? { gasLimit: minGas } : {});
        const signer = dao.signer as ethers.providers.JsonRpcSigner;
        const safeTxHash = typeof signer.sendUncheckedTransaction === 'function' ? await signer.sendUncheckedTransaction(tx) : (await signer.sendTransaction(tx)).hash;
        setMsg({ ok: true, text: `${label} — sent to the Safe. Sign & execute it there; this page shows it once it's on-chain.` });
        setTimeout(load, 2500);
        return { safeTxHash };
      }
      const sending = ctx.send(label, ctx.write('VoucherDAO'), method, args, minGas ? { gasLimit: minGas } : {});
      if (match) {
        const d = ctx.read('VoucherDAO');
        const fromId = (await d.nextBulkProposalId()).toNumber();
        const raced = await raceWithChain(sending, () => findNewBulkProposal(d, fromId, match));
        if (raced.via === 'chain') {
          ctx.confirmedByChain(label, `seen on-chain as proposal #${raced.proposalId}`);
          setMsg({ ok: true, text: `${label} — on-chain as proposal #${raced.proposalId}` });
          setTimeout(load, 1000);
          return { proposalId: raced.proposalId };
        }
        setMsg({ ok: true, text: label });
        setTimeout(load, 2500);
        return raced.value;
      }
      const receipt = await sending;
      setMsg({ ok: true, text: label });
      setTimeout(load, 2500);
      return receipt;
    } catch (e: any) {
      lastError.current = e.message;
      setMsg({ ok: false, text: e.message });
      return null;
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
      // review dialog with everything that will be sent (empty dates are 0 on-chain: claimable at
      // once, never expires) and the full wallet list to cross-check
      const confirmSend = (what: string, rows: ConfirmRow[], proposals: number, allowRemove = false) => {
        const utcOf = (v: string) => { const ts = utcInputToUnix(v); return ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC${new Date(ts * 1000).getTimezoneOffset() !== 0 ? ` · your local time: ${fmtLocal(ts)}` : ' (same as your local time)'}` : ''; };
        const tokenName = selected.mode === VoucherMode.Reward ? (sameAddr(token, ZERO) ? 'native coin' : ctx.nameOf(token)) : '';
        const total = fungible(selected)
          ? `${fromUnits(rows.reduce((t, r) => { try { return t.add(ethers.utils.parseUnits(r.amount.split(' ')[0] || '0', 18).mul(r.amount.includes('×') ? Number(r.amount.split('×')[1]) || 1 : 1)); } catch { return t; } }, ethers.BigNumber.from(0)), 18)} ${tokenName}`
          : undefined;
        return ask({
          title: `Propose ${what}`,
          intro: contractWallet ? 'Connected wallet is a Safe: this is queued there for the owners to sign and execute.' : 'Your wallet will ask you to confirm after this.',
          fields: [
            { label: 'Page', value: `Voucher V2 → VoucherDAO → ${kind === 'bulk' ? 'Bulk mint' : 'Mint'}` },
            { label: 'Network', value: NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}` },
            { label: 'Contract (VoucherDAO)', value: <span className="font-mono text-xs">{c.VoucherDAO}</span> },
            { label: 'Voucher type', value: `${typeLabel(selected)} · needs ${selected.approvalsRequired} approval${selected.approvalsRequired === 1 ? '' : 's'}` },
            ...(tokenName ? [{ label: 'Payout token', value: tokenName }] : []),
            { label: 'Claimable from', value: utcOf(form.start) || 'immediately' },
            { label: 'Expires', value: utcOf(form.expiry) || 'never', warn: !utcOf(form.expiry) },
            { label: 'Voting window', value: `${Math.round(d / 3600)} hours` },
            { label: 'Proposals', value: `${proposals} (max ${MAX_PER_CALL} wallets each)` },
            { label: 'Sent from', value: <span className="font-mono text-xs">{ctx.account}{contractWallet ? ' (Safe)' : ''}</span> },
            ...(total ? [{ label: 'Total', value: total }] : []),
          ],
          rows,
          amountLabel: fungible(selected) ? `Amount (${tokenName})` : selected.mode === VoucherMode.Points ? 'Points' : 'Amount',
          allowRemove,
          totalUnit: fungible(selected) ? tokenName : undefined,
          total,
          warnings: [
            ...(!utcOf(form.expiry) ? ['No expiry set — these vouchers never expire.'] : []),
            ...(selected.approvalsRequired <= 1 ? ['This type needs 1 approval: the vouchers are minted as soon as the proposal lands on-chain.'] : []),
          ],
          confirmLabel: contractWallet ? 'Confirm & send to Safe' : 'Confirm & send',
        });
      };
      if (kind === 'mint') {
        if (!isAddr(form.to)) throw new Error('Recipient is not a valid address');
        const q = parseInt(form.quantity, 10);
        if (!(q >= 1 && q <= 50)) throw new Error('Quantity must be 1–50');
        if (!form.faceValue) throw new Error('Enter a face value');
        if (needsId && !/^\d+$/.test(form.tokenId)) throw new Error('Enter the NFT token id');
        if (!(await confirmSend(`mint of ${q}× ${form.faceValue} to ${ctx.nameOf(form.to)}`, [{ to: form.to, amount: q > 1 ? `${form.faceValue} × ${q}` : form.faceValue }], 1))) return;
        return run(`DAO: propose mint ${q}× type ${selected.id} → ${ctx.nameOf(form.to)}`, 'proposeMint',
          [selected.id, form.to, q, toFace(selected, form.faceValue), utcInputToUnix(form.start), utcInputToUnix(form.expiry), token, needsId ? form.tokenId : 0, d],
          selected.approvalsRequired <= 1 ? execGas('mint', q) : undefined);
      }
      if (kind === 'bulk') {
        const { rows: reviewed, errors } = parsed;
        if (errors.length) throw new Error(`Fix the recipient list first: ${errors.slice(0, 3).join('; ')}`);
        if (!reviewed.length) throw new Error('Add recipients, or upload a CSV');
        // rows loaded from a saved file and unchanged: the proposal is recorded on that batch, no new upload
        let lu = linked ? saved.find((x) => x.id === linked.uploadId) : undefined;
        let li = linked ? linked.idx : -1;
        let lb = lu?.batches[li];
        const linkedOk = !!(lu && lb && lb.proposalId === null && !lb.submittedAt && reviewed.length === lb.end - lb.start
          && reviewed.every((r, k) => sameAddr(r.to, lu!.rows[lb!.start + k].to) && toFace(selected, r.amount) === lu!.rows[lb!.start + k].face));
        const src = (linkedOk ? lb?.file : undefined) ?? csvName ?? undefined;
        const res = await confirmSend(`bulk mint of ${reviewed.length} vouchers${src ? ` (${src})` : ''}`, reviewed.map((r) => ({ to: r.to, amount: r.amount, group: src })), Math.ceil(reviewed.length / MAX_PER_CALL), reviewed.length > 1);
        if (!res) return;
        // wallets removed in the review: drop them from the form and from the saved file's batch
        const dropped = new Set(res.removed);
        const rows = reviewed.filter((_, k) => !dropped.has(k));
        if (dropped.size) {
          const formIdx = new Set(reviewed.filter((_, k) => dropped.has(k)).map((r) => r.row - 1));
          setBulkRows((prev) => prev.filter((_, i) => !formIdx.has(i)));
          if (linkedOk && lu && lb) {
            const { upload, batchMap } = removeRows(lu, res.removed.map((k) => lb!.start + k));
            await saveUpload(upload);
            setUploadsVersion((v) => v + 1);
            lu = upload;
            li = batchMap[li];
            lb = li >= 0 ? upload.batches[li] : undefined;
            if (lb) setLinked({ uploadId: upload.id, idx: li, sig: sigOf(upload, li) });
          }
        }
        // proposeBulkMint takes at most MAX_PER_CALL recipients: a longer list becomes one proposal per batch
        const parts = chunk(rows);
        if (linkedOk && lu && lb && parts.length === 1) {
          const receipt = await run(`DAO: propose bulk mint ${lb.file ?? `batch ${li + 1}`} (${rows.length}) type ${selected.id}`, 'proposeBulkMint',
            [selected.id, rows.map((r) => r.to), rows.map((r) => toFace(selected, r.amount)), utcInputToUnix(form.start), utcInputToUnix(form.expiry), token, rows.map((r) => r.tokenId), d],
            selected.approvalsRequired <= 1 ? execGas('bulk', rows.length) : undefined,
            { typeId: selected.id, recipients: rows.map((r) => r.to), faces: rows.map((r) => toFace(selected, r.amount)), startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry), token });
          if (!receipt) return;
          const next: StoredUpload = { ...lu, batches: lu.batches.map((x) => ({ ...x })) };
          const nb = next.batches[li];
          nb.fromTs = Math.floor(Date.now() / 1000) - 60;
          Object.assign(nb, { token, startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry) });
          if ('proposalId' in receipt) nb.proposalId = receipt.proposalId; // seen on-chain before the wallet answered
          else if ('safeTxHash' in receipt) {
            nb.submittedAt = Math.floor(Date.now() / 1000);
            nb.safeTxHash = receipt.safeTxHash;
            nb.safe = ctx.account;
          } else { nb.proposeTx = receipt.transactionHash; try { nb.proposalId = Number(eventArg(receipt, ctx.read('VoucherDAO'), 'BulkMintProposed', 'proposalId').toString()); } catch { /* matched on-chain later */ } }
          await saveUpload(next);
          setUploadsVersion((v) => v + 1);
          setKick({ uploadId: next.id, n: Date.now() });
          // load the next file of the same upload, so the admin can just press Propose again
          const ni = next.batches.findIndex((x, k) => k !== li && x.proposalId === null && !x.submittedAt);
          const done = `${lb.file ?? `Batch ${li + 1}`} ${'safeTxHash' in receipt ? 'sent to the Safe' : `proposed${nb.proposalId !== null ? ` as #${nb.proposalId}` : ''}`}.`;
          if (ni >= 0) {
            const b2 = next.batches[ni];
            setBulkRows(next.rows.slice(b2.start, b2.end).map((r) => ({ to: r.to, amount: fungible(selected) ? fromUnits(r.face, 18) : r.face, tokenId: needsId ? r.tokenId : '' })));
            setLinked({ uploadId: next.id, idx: ni, sig: sigOf(next, ni) });
            setMsg({ ok: true, text: `${done} Loaded the next file: ${b2.file ?? `batch ${ni + 1}`} (${b2.end - b2.start} rows) — check it and press Propose.` });
          } else {
            setBulkRows([blankRow()]);
            setLinked(null);
            setMsg({ ok: true, text: `${done} That was the last file of "${next.name}".` });
          }
          return;
        }
        // saved once in this browser, so the upload can be checked later — also when the wallet
        // (e.g. a Safe) never returns the transactions; unknown proposal ids are matched on-chain
        let off = 0;
        const upload: StoredUpload = {
          id: newUploadId(), chainId: ctx.chainId, dao: c.VoucherDAO!.toLowerCase(), typeId: selected.id, token,
          startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry), createdAt: Math.floor(Date.now() / 1000),
          name: `${csvName ?? `Upload of ${rows.length}`} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          ...(csvName ? { source: csvName } : {}),
          rows: rows.map((r) => ({ to: r.to, face: toFace(selected, r.amount), tokenId: r.tokenId || '0' })),
          batches: parts.map((p, k) => {
            const b = { start: off, end: off + p.length, proposalId: null as number | null, ...(csvName ? { file: parts.length > 1 ? `${csvName} (${k + 1}/${parts.length})` : csvName } : {}) };
            off = b.end;
            return b;
          }),
        };
        await saveUpload(upload);
        setUploadsVersion((v) => v + 1);
        if (parts.length > 1) ctx.beginFlow(`Propose bulk mint of ${rows.length} (type ${selected.id}) as ${parts.length} proposals`);
        const ids: string[] = []; // proposals created so far
        for (const [i, p] of parts.entries()) {
          const receipt = await run(`DAO: propose bulk mint ${parts.length > 1 ? `${i + 1}/${parts.length} ` : ''}(${p.length}) type ${selected.id}`, 'proposeBulkMint',
            [selected.id, p.map((r) => r.to), p.map((r) => toFace(selected, r.amount)), utcInputToUnix(form.start), utcInputToUnix(form.expiry), token, p.map((r) => r.tokenId), d],
            selected.approvalsRequired <= 1 ? execGas('bulk', p.length) : undefined,
            { typeId: selected.id, recipients: p.map((r) => r.to), faces: p.map((r) => toFace(selected, r.amount)), startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry), token });
          if (!receipt) {
            // nothing reached the wallet (e.g. the estimate reverted): don't keep an empty upload.
            // A timeout may still land later (Safe), so that one is kept and matched on-chain.
            if (i === 0 && !/Not confirmed|explorer/i.test(lastError.current)) { await deleteUpload(upload.id); setUploadsVersion((v) => v + 1); }
            // earlier batches are already proposed: keep only the rest, so a retry doesn't propose them twice
            if (i > 0) {
              setBulkRows(parts.slice(i).flat().map(({ to, amount, tokenId }) => ({ to, amount, tokenId })));
              setMsg({ ok: false, text: `Stopped at proposal ${i + 1} of ${parts.length}. Bulk mint ${ids.map((x) => `#${x}`).join(', ')} ${ids.length === 1 ? 'is' : 'are'} already open for the first ${parts.slice(0, i).flat().length} recipients — the table now holds only the rest. To abandon the list instead, cancel ${ids.length === 1 ? 'that proposal' : 'those proposals'} below.` });
            }
            return;
          }
          upload.batches[i].fromTs = Math.floor(Date.now() / 1000) - 60;
          Object.assign(upload.batches[i], { token, startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry) });
          if ('proposalId' in receipt) {
            upload.batches[i].proposalId = receipt.proposalId;
            ids.push(String(receipt.proposalId));
            await saveUpload(upload);
            continue;
          }
          if ('safeTxHash' in receipt) {
            upload.batches[i].submittedAt = Math.floor(Date.now() / 1000);
            upload.batches[i].safeTxHash = receipt.safeTxHash;
            upload.batches[i].safe = ctx.account;
            ids.push('?');
            await saveUpload(upload);
            continue;
          }
          try {
            const pid = eventArg(receipt, ctx.read('VoucherDAO'), 'BulkMintProposed', 'proposalId').toString();
            ids.push(pid);
            upload.batches[i].proposalId = Number(pid);
            upload.batches[i].proposeTx = receipt.transactionHash;
            await saveUpload(upload);
          } catch { ids.push('?'); }
        }
        setBulkRows([blankRow()]);
        setCsvName(null);
        setUploadsVersion((v) => v + 1);
        setKick({ uploadId: upload.id, n: Date.now() });
        if (contractWallet) setMsg({ ok: true, text: `Sent ${parts.length} bulk-mint proposal${parts.length === 1 ? '' : 's'} to the Safe. Sign & execute there; follow them under Bulk uploads below.` });
        else if (parts.length > 1) setMsg({ ok: true, text: `Proposed ${rows.length} vouchers as ${parts.length} bulk-mint proposals (${ids.map((x) => `#${x}`).join(', ')})` });
        return;
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
      {dialog}
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
                {needsId && <Field label="NFT token id"><input className={inputCls} value={form.tokenId} onChange={(e) => set('tokenId', e.target.value)} /></Field>}
              </>
            )}
            {kind === 'bulk' && (
              <div className="md:col-span-3">
                <div className="mb-3">
                  <Field label="Load a saved file" hint={pendingFiles.length
                    ? 'Every imported file with its status. Picking one fills the rows only — token and dates stay as set in this form. After Propose the next file loads.'
                    : saved.length ? 'Every file of these uploads is proposed — see the status of each below.' : 'Import a .zip or CSV files under Bulk uploads (below) — its files then show up here.'}>
                    {/* native select: grouped per upload, proposed / complete files shown but disabled */}
                    <select className={inputCls} value={linked ? `${linked.uploadId}#${linked.idx}` : ''} onChange={(e) => loadSaved(e.target.value)}>
                      <option value="">{pendingFiles.length ? `— pick a file (${pendingFiles.length} not proposed) —` : '— no files left to propose —'}</option>
                      {saved.map((u) => {
                        const done = u.batches.filter((b) => b.completedAt).length;
                        return (
                          <optgroup key={u.id} label={`${u.name} — ${done}/${u.batches.length} complete`}>
                            {u.batches.map((b, i) => {
                              const status = b.completedAt ? '✓ complete'
                                : b.proposalId !== null ? `proposed #${b.proposalId}`
                                : b.submittedAt ? 'sent to Safe'
                                : 'not proposed';
                              const free = b.proposalId === null && !b.submittedAt;
                              return (
                                <option key={i} value={`${u.id}#${i}`} disabled={!free}>
                                  {`${free ? '○' : b.completedAt ? '✓' : '…'} ${b.file ?? `batch ${i + 1}`} · ${b.end - b.start} rows · ${status}`}
                                </option>
                              );
                            })}
                          </optgroup>
                        );
                      })}
                    </select>
                  </Field>
                </div>
                <RecipientRows rows={bulkRows} onChange={(r) => { setBulkRows(r); setLinked(null); }} needsId={!!needsId} check={parsed} perTx="proposal"
                  amountLabel={fungible(selected) ? 'Amount (tokens)' : selected.mode === VoucherMode.Points ? 'Points' : 'Quantity'}
                  total={fungible(selected) ? `${fromUnits(neededFor(selected, 'bulk', '', '', parsed.rows), 18)} ${ctx.nameOf(form.token || selected.approvedTokens[0] || ZERO)}` : undefined}
                  onLoaded={(text, fileName) => { setMsg({ ok: !/^(CSV|Failed)/.test(text), text }); if (fileName) setCsvName(fileName); }} />
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
                <Field label="Claimable from — your local time (optional)" hint="Empty = claimable right away."><UtcDateTimeInput className={inputCls} value={form.start} onChange={(v) => set('start', v)} /></Field>
                <Field label="Voucher expiry — your local time (optional)" hint={'Empty = never expires (the type\'s redemption days are informational only).'}><UtcDateTimeInput className={inputCls} value={form.expiry} onChange={(v) => set('expiry', v)} /></Field>
              </>
            )}
            <Field label="Voting window (hours)" hint="How long operators have to vote: 1 to 720 hours (30 days).">
              <input className={inputCls} value={form.hours} onChange={(e) => set('hours', e.target.value)} />
            </Field>
          </div>
          {kind !== 'revoke' && (
            <div className="mt-3">
              <PoolFundingBox type={selected} token={selected.mode === VoucherMode.Reward ? form.token || selected.approvedTokens[0] || ZERO : ZERO} needed={neededFor(selected, kind, form.quantity, form.faceValue, parsed.rows)} />
            </div>
          )}
          <button className={`${btnCls} mt-4`} disabled={busy || !roles.operator} onClick={propose}>{busy ? 'Sending…' : 'Propose'}</button>
          {!roles.operator && <span className="text-xs text-txt-secondary ml-3">Only this type&apos;s operators can propose — add your wallet on Minters &amp; roles.</span>}
        </Card>
      )}

      {selected && kind === 'bulk' && (
        <div id="bulk-uploads" className="scroll-mt-4"><BulkTracker type={selected} focus={bulkFocus} version={uploadsVersion} onChange={() => setUploadsVersion((v) => v + 1)} kick={kick} params={() => ({
          token: selected.mode === VoucherMode.Reward ? form.token || selected.approvedTokens[0] || ZERO : ZERO,
          startDate: utcInputToUnix(form.start), expiryDate: utcInputToUnix(form.expiry), duration: duration(),
        })} /></div>
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
                  Approvals <b className="text-txt-primary">{p.approvals} / {q || '?'}</b> · proposer {ctx.nameOf(p.proposer)} · voting ends <UtcTime inline ts={p.expiresAt} />
                  {p.iApproved && ' · you approved'}
                  {p.kind === 'bulk' && (
                    <> · <button className={linkBtnCls} onClick={() => {
                      setKind('bulk');
                      setBulkFocus({ id: p.id, nonce: Date.now() });
                      setTimeout(() => document.getElementById('bulk-uploads')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                    }}>Check on-chain</button></>
                  )}
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
