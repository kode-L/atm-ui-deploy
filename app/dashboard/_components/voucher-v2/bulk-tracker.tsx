'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { UtcTime } from '@/components/utc-datetime';
import { DEFAULT_ADMIN_ROLE, TokenStandard, VoucherMode, VoucherType, eventArg, fromUnits, sameAddr, typeLabel } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { Badge, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';
import { MAX_PER_CALL, checkRows, chunk, csvToRows } from './mint-csv';
import { StoredBatch, StoredRow, StoredUpload, UploadScope, batchVoucherIds, deleteUpload as dbDelete, listUploads as dbList, newUploadId, removeRows, saveUpload as dbSave } from './upload-store';
import { readZip, sha256Hex } from './zip-read';
import { findNewBulkProposal, raceWithChain } from './chain-watch';
import { useConfirmDialog } from './confirm-dialog';
import { NETWORKS, getExplorerTxUrl } from '@/lib/contracts/config';
import { fmtLocal } from '@/lib/utc-time';
import { SafeTxStatus, getSafeTx, isQueuingWallet, safeApiSupported, safeTxLabel, safeTxUrl } from './safe-api';

// Bulk-mint uploads, one shared tracker for every page that mints in bulk (page key = `mode`):
//   dao    — VoucherDAO tab: each batch is a proposeBulkMint proposal (approvals, quorum, Safe)
//   direct — VoucherNFT tab: each batch is a VoucherNFT.mintBatch from the connected wallet
//   atm-v1 — ATM Vouchers (older contract): each batch is an ATMVoucher.mintBatch
// Uploads are stored per page and per contract address, so pages never share or match each other's data.
// (The notes below describe the DAO flow; direct / ATM v1 skip proposals: a batch is done once its
// mint tx is found, by receipt or — when the wallet doesn't answer — by its VoucherMinted events.)
// Bulk-mint uploads on the VoucherDAO tab. Every upload proposed from this page is saved once in
// IndexedDB (upload-store.ts); opening one checks it lazily against the chain: which batches
// (proposals) minted, the voucher id each row got, and whether it's been claimed.
// Nothing depends on the wallet returning a transaction — with a Safe it never does — so batches
// without a known proposal id are found by matching their recipients and amounts on-chain.
// Batch files (e.g. the rgst_vouchers.py zip: one folder per reward, files.csv with sha256s) can be
// imported here: one upload per folder, one batch (= one bulk-mint proposal) per file.

export interface BulkFocus { id: number; nonce: number }

const PAGE = 50;
const MATCH_DEPTH = 400; // newest bulk proposals searched when matching an upload's batches
const NEIGHBOURS = 20;
const RECENT = 20;
const exec = (vouchers: number) => 400_000 + 300_000 * Math.max(1, vouchers); // same floor as dao-tab execGas

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
const showFace = (t: VoucherType | undefined, v: ethers.BigNumberish) => (fungible(t) ? fromUnits(v, 18) : String(v));
const idTopic = (id: number) => ethers.utils.hexZeroPad(ethers.utils.hexlify(id), 32);

interface Live { approvals: number; executed: boolean; cancelled: boolean; expiresAt: number; iApproved: boolean }
interface Claim { claimed: boolean; revoked: boolean; owner: string | null }
// what a send uses, from the page's form (duration: DAO voting window; the rest: ATM v1 mintBatch)
export interface ProposeParams { token: string; startDate: number; expiryDate: number; duration: number; redemptionDays?: number; transferable?: boolean; uri?: string }
export type TrackerMode = UploadScope;
// the older ATMVoucher contract (ATM Vouchers page): not in the Voucher V2 address book
export interface AtmV1 { address: string; abi: any }
const PAGES: Record<TrackerMode, { page: string; contract: string; verb: string; unit: string; claim: string }> = {
  dao: { page: 'Voucher V2 → VoucherDAO → Bulk mint', contract: 'VoucherDAO', verb: 'Propose', unit: 'proposal', claim: 'Claimed' },
  direct: { page: 'Voucher V2 → VoucherNFT → Mint (many)', contract: 'VoucherNFT', verb: 'Mint', unit: 'mintBatch tx', claim: 'Claimed' },
  'atm-v1': { page: 'ATM Vouchers → Mint Batch', contract: 'ATMVoucher', verb: 'Mint', unit: 'mintBatch tx', claim: 'Redeemed' },
};
// a mint seen on-chain (VoucherMinted): voucher / NFT id, recipient, value (ATM v1 events carry it)
interface MintEvent { id: string; to: string; typeId: number; face?: string }
// dup: this file's content already exists — 'same' wallets + amounts in order, or 'similar' (>= 80% of
// its wallets in one existing batch); `where` names that batch and its state
interface PreviewFile {
  file: string; rows: StoredRow[]; errors: string[]; sha: 'ok' | 'bad' | 'none'; total: ethers.BigNumber; pick: boolean;
  dup?: { kind: 'same' | 'similar'; pct: number; where: string; note?: string };
}
const SIMILAR = 0.8;
interface PreviewGroup { name: string; files: PreviewFile[]; pick: boolean }
interface ProposalMeta { typeId: number; token: string; start: number; expiry: number; to?: string; faces?: string }

// CSV download (a permanent record of what was sent and minted, outside the browser)
const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isoUtc = (ts?: number) => (ts ? `${new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '');
function downloadCsv(fileName: string, header: string[], rows: unknown[][]) {
  const text = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
type SafeSent = { safeTxHash: string };
const isSafeSent = (r: unknown): r is SafeSent => !!r && typeof (r as SafeSent).safeTxHash === 'string';
const clone = (u: StoredUpload): StoredUpload => ({ ...u, batches: u.batches.map((b) => ({ ...b, safeActions: b.safeActions?.map((a) => ({ ...a })) })), minted: { ...(u.minted || {}) } });

export default function BulkTracker({ type, focus, version, params, onChange, kick, mode = 'dao', atm }: {
  type: VoucherType; focus?: BulkFocus | null; version?: number; params: () => ProposeParams;
  // the form just sent (or saved) a batch of this upload: open it and follow it; send = open the review to send it
  kick?: { uploadId: string; n: number; send?: boolean; only?: number } | null;
  onChange?: () => void; // a saved upload changed (the Bulk mint form's "Load a saved file" list re-reads)
  mode?: TrackerMode;
  atm?: AtmV1;
}) {
  const ctx = useVoucherV2();
  const isDao = mode === 'dao';
  const P = PAGES[mode];
  // this page's contract = where its uploads are stored (and the only ones it lists / matches)
  const storeAddr = mode === 'dao' ? ctx.book.contracts.VoucherDAO : mode === 'direct' ? ctx.book.contracts.VoucherNFT : atm?.address;
  const listUploads = (chainId: number, addr: string) => dbList(chainId, addr, mode);
  // the contract a direct / ATM v1 batch is minted on
  const mintContract = (write: boolean): ethers.Contract => {
    if (mode === 'atm-v1') {
      if (!atm) throw new Error('ATMVoucher address missing');
      const via = write ? ctx.signer : ctx.reader;
      if (!via) throw new Error('Connect a wallet first');
      return new ethers.Contract(atm.address, atm.abi, via);
    }
    return write ? ctx.write('VoucherNFT') : ctx.read('VoucherNFT');
  };
  const { ask, dialog } = useConfirmDialog(ctx.nameOf);
  // every write tells the parent, so its file dropdown never shows a forgotten / proposed file
  const saveUpload = async (u: StoredUpload) => { await dbSave(u); onChange?.(); };
  const deleteUpload = async (id: string) => { await dbDelete(id); onChange?.(); };
  const dao = storeAddr; // this page's contract address (VoucherDAO on the DAO tab)
  const [uploads, setUploads] = useState<StoredUpload[]>([]);
  const [current, setCurrent] = useState<StoredUpload | null>(null);
  const [live, setLive] = useState<Record<number, Live>>({});
  const [claims, setClaims] = useState<Record<string, Claim>>({});
  const [operator, setOperator] = useState(false);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<string | null>(null); // lazy work in progress
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true); // follow the chain while a batch is in progress
  const [fastUntil, setFastUntil] = useState(0); // right after a propose: follow every 3s instead of 15s
  const [idText, setIdText] = useState('');
  const [recent, setRecent] = useState<{ id: number; count: number; live: Live }[]>([]);
  const work = useRef(0); // bumps to cancel lazy work for a previous upload
  const missed = useRef(new Set<number>()); // executed batches whose voucher ids a full search didn't find
  const [safeStatus, setSafeStatus] = useState<Record<string, SafeTxStatus>>({}); // by safeTxHash (mainnet)
  const [preview, setPreview] = useState<{ source: string; summary?: string; groups: PreviewGroup[]; missing: string[] } | null>(null);
  const [contractWallet, setContractWallet] = useState(false);
  // vouchers left in the current cap window: this operator's VoucherDAO proposal cap, and
  // VoucherDAO's minter cap on VoucherNFT (both default to 100 a day); null = unlimited
  const [caps, setCaps] = useState<{ op: number | null; opLimit: string; opResets: number; nft: number | null; nftLimit: string; nftResets: number } | null>(null);
  // immutable proposal fields, so matching batches on-chain reads each proposal once
  const meta = useRef(new Map<number, ProposalMeta>());
  useEffect(() => { meta.current = new Map(); }, [dao, ctx.chainId]);
  const fungibleType = fungible(type);
  const needsId = type.mode === VoucherMode.Reward && (type.tokenStandard === TokenStandard.ERC721 || type.tokenStandard === TokenStandard.ERC1155);

  // a Safe / smart-account: its wallet only queues the tx, so we never wait for a receipt
  useEffect(() => {
    if (!ctx.reader || !ctx.account) return;
    isQueuingWallet(ctx.reader, ctx.account).then(setContractWallet).catch(() => setContractWallet(false));
  }, [ctx.reader, ctx.account]);

  const reload = useCallback(async () => {
    if (!dao) return [];
    let list = (await listUploads(ctx.chainId, dao)).filter((u) => u.typeId === type.id);
    // uploads saved before page keys: give them their page and move index-keyed voucher ids onto batches
    const legacy = list.filter((u) => !u.scope);
    if (legacy.length) {
      for (const u of legacy) {
        const next: StoredUpload = { ...u, scope: mode, batches: u.batches.map((b, bi) => (mode !== 'dao' && !b.voucherIds && u.minted?.[bi] ? { ...b, voucherIds: u.minted[bi] } : b)) };
        if (mode !== 'dao') next.minted = {};
        await dbSave(next);
      }
      list = (await listUploads(ctx.chainId, dao)).filter((u) => u.typeId === type.id);
    }
    // repair names saved by an old import bug ("0 files · <folder>"): the zip name is lost, so name
    // it after the folder and import time; only the label changes
    const bad = list.filter((u) => /^0 files · /.test(u.name));
    if (bad.length) {
      for (const u of bad) {
        const when = u.createdAt ? new Date(u.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
        await dbSave({ ...u, name: `${u.name.replace(/^0 files · /, '')} · imported ${when} UTC`, source: u.source === '0 files' ? undefined : u.source });
      }
      list = (await listUploads(ctx.chainId, dao)).filter((u) => u.typeId === type.id);
      const renamed = new Map(list.map((u) => [u.id, u.name]));
      setCurrent((c) => (c && renamed.has(c.id) ? { ...c, name: renamed.get(c.id)! } : c));
      onChange?.(); // the form's "Load a saved file" list shows the new name too
    }
    setUploads(list);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.chainId, dao, type.id]);

  useEffect(() => { reload(); }, [reload, version]);

  const readLive = useCallback(async (ids: number[]) => {
    if (mode !== 'dao' || !ids.length) return {} as Record<number, Live>;
    const d = ctx.read('VoucherDAO');
    const out: Record<number, Live> = {};
    await Promise.all(ids.map(async (id) => {
      const [p, mine] = await Promise.all([d.bulkMintProposals(id), ctx.account ? d.bulkMintApprovals(id, ctx.account) : false]);
      out[id] = { approvals: Number(p.approvalCount), executed: p.executed, cancelled: p.cancelled, expiresAt: Number(p.expiresAt), iApproved: mine };
    }));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.reader, ctx.account]);

  // newest bulk proposals of this type, for proposals made outside this page / browser
  const loadRecent = useCallback(async () => {
    if (!dao || !ctx.reader || !isDao) return;
    try {
      const d = ctx.read('VoucherDAO');
      const n = (await d.nextBulkProposalId()).toNumber();
      const out: { id: number; count: number; live: Live }[] = [];
      for (let id = n - 1; id >= 0 && id >= n - 100 && out.length < RECENT; id--) {
        const p = await d.bulkMintProposals(id);
        if (Number(p.typeId) !== type.id) continue;
        const r: string[] = await d.getBulkMintRecipients(id);
        out.push({ id, count: r.length, live: { approvals: Number(p.approvalCount), executed: p.executed, cancelled: p.cancelled, expiresAt: Number(p.expiresAt), iApproved: false } });
      }
      setRecent(out);
    } catch { /* shown as empty */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, ctx.reader, type.id, ctx.revision]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  // who may send here: DAO = type operator (or DAO admin); direct = the type's minter on VoucherNFT;
  // ATM v1 = MINTER_ROLE on ATMVoucher. Also the per-tx batch size (ATM v1 sets its own).
  const [maxBatch, setMaxBatch] = useState(MAX_PER_CALL);
  useEffect(() => {
    if (!dao || !ctx.reader || !ctx.account) return;
    (async () => {
      if (mode === 'dao') {
        const d = ctx.read('VoucherDAO');
        const [admin, op] = await Promise.all([d.hasRole(DEFAULT_ADMIN_ROLE, ctx.account), d.hasRole(await d.typeOperatorRole(type.id), ctx.account)]);
        setOperator(admin || op);
      } else if (mode === 'direct') {
        const nft = ctx.read('VoucherNFT');
        setOperator(await nft.hasRole(await nft.typeMinterRole(type.id), ctx.account));
      } else {
        const c = mintContract(false);
        setOperator(await c.hasRole(await c.MINTER_ROLE(), ctx.account));
        const mb = Number(await c.MAX_BATCH_SIZE().catch(() => MAX_PER_CALL));
        if (mb > 0) setMaxBatch(mb);
      }
    })().catch(() => setOperator(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, ctx.reader, ctx.account, type.id, mode]);

  const loadCaps = useCallback(async () => {
    if (!dao || !ctx.reader || !ctx.account || mode === 'atm-v1' || !ctx.book.contracts.VoucherNFT) return;
    try {
      // DAO: this operator's proposal cap + VoucherDAO's minter cap. Direct: this wallet's minter cap.
      const nft = ctx.read('VoucherNFT');
      const [o, m, blk] = await Promise.all([
        mode === 'dao' ? ctx.read('VoucherDAO').getOperatorCap(type.id, ctx.account) : nft.getMinterCap(type.id, ctx.account),
        mode === 'dao' ? nft.getMinterCap(type.id, dao) : Promise.resolve(null),
        ctx.reader.getBlock('latest'),
      ]);
      const left = (c: any) => {
        if (c.limit.eq(ethers.constants.MaxUint256)) return { n: null, resets: 0 };
        const fresh = blk.timestamp >= c.windowStart.add(c.windowDuration).toNumber();
        const used = fresh ? ethers.BigNumber.from(0) : c.usedInWindow;
        return { n: c.limit.sub(used).toNumber(), resets: fresh ? 0 : c.windowStart.add(c.windowDuration).toNumber() };
      };
      const a = left(o);
      const b = m ? left(m) : { n: null, resets: 0 };
      setCaps({ op: a.n, opLimit: o.limit.toString(), opResets: a.resets, nft: b.n, nftLimit: m ? m.limit.toString() : '', nftResets: b.resets });
    } catch {
      setCaps(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, ctx.reader, ctx.account, type.id, ctx.revision]);
  useEffect(() => { loadCaps(); }, [loadCaps]);

  // ---- direct / ATM v1: a batch is its mintBatch tx ----

  // VoucherMinted events of this page's contract in a receipt, in order
  const mintsIn = (rc: ethers.providers.TransactionReceipt): MintEvent[] => {
    const c = mintContract(false);
    const out: MintEvent[] = [];
    for (const l of rc.logs) {
      if (!sameAddr(l.address, c.address)) continue;
      try {
        const pl = c.interface.parseLog(l);
        if (pl.name !== 'VoucherMinted') continue;
        if (mode === 'atm-v1') out.push({ id: pl.args.tokenId.toString(), to: pl.args.to, typeId: Number(pl.args.voucherType), face: pl.args.faceValue.toString() });
        else out.push({ id: pl.args.voucherId.toString(), to: pl.args.to, typeId: Number(pl.args.typeId) });
      } catch { /* other event */ }
    }
    return out;
  };
  // the run of mints in `mints` that is exactly batch b (same wallets in order, type, and values)
  const matchRun = async (u: StoredUpload, b: StoredBatch, mints: MintEvent[], usedIds: Set<string>): Promise<string[] | null> => {
    const rows = u.rows.slice(b.start, b.end);
    for (let s0 = 0; s0 + rows.length <= mints.length; s0++) {
      const run = mints.slice(s0, s0 + rows.length);
      if (run.some((m) => usedIds.has(m.id))) continue;
      if (!run.every((m, k) => sameAddr(m.to, rows[k].to) && m.typeId === u.typeId)) continue;
      // values: ATM v1 events carry them; VoucherNFT ones don't, so read them
      const faces = mode === 'atm-v1' ? run.map((m) => m.face ?? '') : await Promise.all(run.map((m) => mintContract(false).vouchers(m.id).then((v: any) => v.faceValue.toString())));
      if (faces.every((f, k) => f === rows[k].face)) return run.map((m) => m.id);
    }
    return null;
  };
  // a receipt that minted batch bi: record its voucher ids, mint tx and time (complete)
  const completeFrom = async (u: StoredUpload, bi: number, rc: ethers.providers.TransactionReceipt): Promise<StoredUpload | null> => {
    const used = new Set(u.batches.flatMap((x, k) => (k === bi ? [] : batchVoucherIds(u, k) ?? [])));
    const ids = await matchRun(u, u.batches[bi], mintsIn(rc), used);
    if (!ids) return null;
    const blk = await ctx.reader!.getBlock(rc.blockNumber).catch(() => null);
    const next = clone(u);
    const nb = next.batches[bi];
    Object.assign(nb, { voucherIds: ids, execTx: rc.transactionHash, proposeTx: rc.transactionHash, completedAt: blk?.timestamp ?? Math.floor(Date.now() / 1000) });
    delete nb.submittedAt;
    return next;
  };
  // look a sent batch up by its VoucherMinted events (first wallet), from `fromBlock`
  const findMintTx = async (u: StoredUpload, bi: number, fromBlock: number, my?: number): Promise<StoredUpload | null> => {
    if (!ctx.reader) return null;
    const b = u.batches[bi];
    const c = mintContract(false);
    const topic = c.interface.getEventTopic('VoucherMinted');
    const first = ethers.utils.hexZeroPad(u.rows[b.start].to.toLowerCase(), 32);
    // VoucherNFT: VoucherMinted(voucherId, typeId, to) — ATM v1: VoucherMinted(tokenId, to, …)
    const topics = mode === 'atm-v1' ? [topic, null, first] : [topic, null, ethers.utils.hexZeroPad(ethers.utils.hexlify(u.typeId), 32), first];
    const latest = await ctx.reader.getBlockNumber();
    const seen = new Set<string>();
    let size = 5000;
    for (let to = latest; to >= fromBlock && (my === undefined || work.current === my);) {
      const from = Math.max(fromBlock, to - size + 1);
      let logs: ethers.providers.Log[];
      try {
        logs = await ctx.reader.getLogs({ address: c.address, topics, fromBlock: from, toBlock: to });
      } catch (e) {
        if (size > 250) { size = Math.floor(size / 2); continue; }
        throw e;
      }
      for (const l of logs) {
        if (seen.has(l.transactionHash)) continue;
        seen.add(l.transactionHash);
        if (u.batches.some((x, k) => k !== bi && x.execTx === l.transactionHash && x.end - x.start === b.end - b.start)) continue;
        const rc = await ctx.reader.getTransactionReceipt(l.transactionHash);
        const done = rc && rc.status !== 0 ? await completeFrom(u, bi, rc) : null;
        if (done) return done;
      }
      to = from - 1;
    }
    return null;
  };
  // block number about `secsAgo` seconds back (from the recent block rate)
  const blockAgo = async (secsAgo: number) => {
    const p = ctx.reader!;
    const latest = await p.getBlockNumber();
    const back = Math.min(1000, latest);
    const [a, b0] = await Promise.all([p.getBlock(latest), p.getBlock(latest - back)]);
    const spb = Math.max(0.1, (a.timestamp - b0.timestamp) / Math.max(1, back));
    return Math.max(0, latest - Math.ceil(secsAgo / spb));
  };
  // direct / ATM v1: batches sent but not confirmed (wallet stuck, page closed, Safe executed later)
  const resolveSent = async (u: StoredUpload, my: number): Promise<StoredUpload> => {
    let x = u;
    for (const [bi, b] of u.batches.entries()) {
      if (b.completedAt || !(b.fromTs || b.submittedAt) || work.current !== my) continue;
      setStatus(`Looking for ${b.file ?? `batch ${bi + 1}`} on-chain…`);
      const since = Math.floor(Date.now() / 1000) - Math.min(b.fromTs ?? Infinity, b.submittedAt ?? Infinity) + 600;
      const found = await findMintTx(x, bi, await blockAgo(since), my).catch(() => null);
      if (found) { x = found; await saveUpload(x); }
    }
    return x;
  };

  // ---- lazy steps when an upload is opened ----

  // 1. batches proposed without a known id (Safe, closed tab…): find the proposal with the same
  //    type, token, dates, recipients and amounts
  const metaOf = async (d: ethers.Contract, id: number) => {
    let m = meta.current.get(id);
    if (!m) {
      const p = await d.bulkMintProposals(id);
      m = { typeId: Number(p.typeId), token: p.token.toLowerCase(), start: Number(p.startDate), expiry: Number(p.expiryDate) };
      meta.current.set(id, m);
    }
    return m;
  };
  const resolveIds = async (u: StoredUpload, my: number): Promise<StoredUpload> => {
    if (!isDao) return resolveSent(u, my);
    if (!u.batches.some((b) => b.proposalId === null)) return u;
    setStatus('Finding batches on-chain…');
    const d = ctx.read('VoucherDAO');
    const all = await listUploads(ctx.chainId, u.dao);
    const taken = new Set([...all, u].flatMap((x) => x.batches.map((b) => b.proposalId)).filter((x): x is number => x !== null));
    const n = (await d.nextBulkProposalId()).toNumber();
    const next = clone(u);
    const toKey = (b: StoredBatch) => next.rows.slice(b.start, b.end).map((r) => r.to.toLowerCase()).join(',');
    const faceKey = (b: StoredBatch) => next.rows.slice(b.start, b.end).map((r) => r.face).join(',');
    const left = () => next.batches.filter((b) => b.proposalId === null);
    for (let hi = n - 1; hi >= Math.max(0, n - MATCH_DEPTH) && left().length && work.current === my; hi -= 20) {
      const ids = Array.from({ length: Math.min(20, hi + 1) }, (_, k) => hi - k).filter((id) => id >= Math.max(0, n - MATCH_DEPTH));
      const metas = await Promise.all(ids.map((id) => metaOf(d, id)));
      for (const [k, id] of ids.entries()) {
        const open = left();
        if (!open.length) break;
        const m = metas[k];
        if (taken.has(id) || m.typeId !== u.typeId) continue;
        if (m.to === undefined) m.to = ((await d.getBulkMintRecipients(id)) as string[]).map((x) => x.toLowerCase()).join(',');
        // a batch proposed from here recorded its token and dates: they must match too
        const cand = open.filter((b) => toKey(b) === m.to
          && (b.startDate === undefined || (b.startDate === m.start && b.expiryDate === m.expiry && (b.token ?? '').toLowerCase() === m.token)));
        if (!cand.length) continue;
        if (m.faces === undefined) m.faces = ((await d.getBulkMintFaceValues(id)) as ethers.BigNumber[]).map(String).join(',');
        const hit = cand.find((b) => faceKey(b) === m.faces);
        if (hit) { hit.proposalId = id; delete hit.submittedAt; taken.add(id); }
      }
    }
    if (next.batches.some((b, i) => b.proposalId !== u.batches[i].proposalId)) await saveUpload(next);
    return next;
  };

  // 2. voucher ids of executed batches: the VoucherMinted events in each execute tx, cached forever
  const findMinted = async (u: StoredUpload, lv: Record<number, Live>, my: number, quiet = false): Promise<StoredUpload> => {
    if (!isDao) return u; // direct / ATM v1: completed when their mint tx is found
    // quiet (auto re-check): skip batches whose execute event a full search already missed
    const need = u.batches.filter((b) => b.proposalId !== null && lv[b.proposalId]?.executed && !u.minted?.[b.proposalId] && !(quiet && missed.current.has(b.proposalId)));
    if (!need.length || !ctx.reader) return u;
    const provider = ctx.reader;
    const d = ctx.read('VoucherDAO');
    const nft = ctx.read('VoucherNFT');
    const topic = d.interface.getEventTopic('BulkMintExecuted');
    const latest = await provider.getBlockNumber();
    const back = Math.min(1000, latest);
    const [a, b0] = await Promise.all([provider.getBlock(latest), provider.getBlock(latest - back)]);
    const secPerBlock = Math.max(0.1, (a.timestamp - b0.timestamp) / Math.max(1, back));
    // from an hour before the earliest batch was proposed from this page; a batch that was only
    // matched on-chain (imported after it was proposed, or opened from on-chain) has no known
    // start, so search back 30 days (newest first — it stops as soon as everything is found)
    const starts = need.map((b) => b.fromTs ?? b.submittedAt ?? (!u.source && u.createdAt ? u.createdAt : 0));
    const since = starts.every((t) => t > 0) ? Math.max(0, a.timestamp - Math.min(...starts) + 3600) : 30 * 86400;
    const fromBlock = Math.max(0, latest - Math.ceil(since / secPerBlock));
    const ids = need.map((b) => b.proposalId as number);
    const found: ethers.providers.Log[] = [];
    let size = 5000;
    for (let to = latest; to >= fromBlock && work.current === my;) {
      const from = Math.max(fromBlock, to - size + 1);
      try {
        found.push(...(await provider.getLogs({ address: d.address, topics: [topic, ids.map(idTopic)], fromBlock: from, toBlock: to })));
      } catch (e) {
        if (size > 250) { size = Math.floor(size / 2); continue; }
        throw e;
      }
      setStatus(`Looking up minted voucher ids… ${Math.round(((latest - from) / Math.max(1, latest - fromBlock)) * 100)}%`);
      to = from - 1;
      if (ids.every((id) => found.some((l) => l.topics[1] === idTopic(id)))) break;
    }
    const next: StoredUpload = { ...u, minted: { ...(u.minted || {}) } };
    const used = new Set<string>();
    for (const log of found) {
      const pid = ethers.BigNumber.from(log.topics[1]).toNumber();
      const batch = need.find((x) => x.proposalId === pid);
      if (!batch || next.minted![pid]) continue;
      const rc = await provider.getTransactionReceipt(log.transactionHash);
      const minted: { id: string; to: string }[] = [];
      for (const l of rc.logs) {
        if (!sameAddr(l.address, nft.address)) continue;
        try {
          const pl = nft.interface.parseLog(l);
          if (pl.name === 'VoucherMinted' && Number(pl.args.typeId) === u.typeId) minted.push({ id: pl.args.voucherId.toString(), to: pl.args.to });
        } catch { /* other event */ }
      }
      // one tx can execute several batches (e.g. a Safe multi-send): take the run of mints whose
      // recipients match this batch's rows, in order
      const rows = u.rows.slice(batch.start, batch.end);
      for (let s = 0; s + rows.length <= minted.length; s++) {
        const run = minted.slice(s, s + rows.length);
        if (run.some((m) => used.has(m.id))) continue;
        if (run.every((m, i) => sameAddr(m.to, rows[i].to))) {
          run.forEach((m) => used.add(m.id));
          next.minted![pid] = run.map((m) => m.id);
          // complete: every row's voucher was minted to that row's wallet — saved, never re-checked
          const blk = await provider.getBlock(log.blockNumber).catch(() => null);
          // proposed in the same tx (a 1-approval type mints on propose): that's the propose tx too
          const proposedHere = rc.logs.some((l) => sameAddr(l.address, d.address) && l.topics[0] === d.interface.getEventTopic('BulkMintProposed') && l.topics[1] === idTopic(pid));
          next.batches = next.batches.map((x) => (x.proposalId === pid
            ? { ...x, execTx: log.transactionHash, completedAt: blk?.timestamp ?? Math.floor(Date.now() / 1000), ...(proposedHere && !x.proposeTx ? { proposeTx: log.transactionHash } : {}) }
            : x));
          break;
        }
      }
    }
    if (work.current === my) for (const pid of ids) if (!next.minted![pid]) missed.current.add(pid);
    if (Object.keys(next.minted!).length !== Object.keys(u.minted || {}).length) await saveUpload(next);
    return next;
  };

  // mainnet: follow txs queued in a Safe; once the propose tx ran, take the proposal id from it
  const pollSafe = async (u: StoredUpload, my: number): Promise<StoredUpload> => {
    if (!ctx.reader) return u;
    // a hash saved as a Safe tx that is really an on-chain tx (e.g. sent by an EIP-7702 wallet
    // mistaken for a Safe): take the proposal straight from its receipt — works on every chain
    let healed: StoredUpload | null = null;
    for (const [bi, b] of u.batches.entries()) {
      if ((isDao ? b.proposalId !== null : !!b.completedAt) || !b.safeTxHash) continue;
      const rc = await ctx.reader.getTransactionReceipt(b.safeTxHash).catch(() => null);
      if (!rc || work.current !== my) continue;
      if (!isDao) {
        // direct / ATM v1: the "Safe" hash was a real mint tx
        const base: StoredUpload = healed || clone(u);
        const done: StoredUpload | null = rc.status !== 0 ? await completeFrom(base, bi, rc) : null;
        const h: StoredUpload = done || base;
        delete h.batches[bi].safeTxHash;
        delete h.batches[bi].safe;
        if (!done) delete h.batches[bi].submittedAt;
        healed = h;
        continue;
      }
      healed = healed || clone(u);
      const hb = healed.batches[bi];
      delete hb.safeTxHash;
      delete hb.safe;
      if (rc.status === 0) { delete hb.submittedAt; continue; } // reverted: can be proposed again
      const d0 = ctx.read('VoucherDAO');
      const ids = rc.logs.filter((l) => sameAddr(l.address, d0.address)).map((l) => { try { const pl = d0.interface.parseLog(l); return pl.name === 'BulkMintProposed' ? Number(pl.args.proposalId.toString()) : null; } catch { return null; } }).filter((x): x is number => x !== null);
      if (ids.length === 1) { hb.proposalId = ids[0]; hb.proposeTx = rc.transactionHash; delete hb.submittedAt; }
    }
    if (healed) { await saveUpload(healed); u = healed; }
    if (!safeApiSupported(ctx.chainId)) return u;
    const jobs: { hash: string; safe: string; bi: number; propose: boolean }[] = [];
    u.batches.forEach((b, bi) => {
      if (b.safeTxHash && b.safe && (isDao ? b.proposalId === null : !b.completedAt)) jobs.push({ hash: b.safeTxHash, safe: b.safe, bi, propose: true });
      for (const a of b.safeActions || []) if (!b.completedAt) jobs.push({ hash: a.hash, safe: a.safe, bi, propose: false });
    });
    if (!jobs.length) return u;
    const res = await Promise.all(jobs.map(async (j) => [j, await getSafeTx(ctx.chainId, j.safe, j.hash)] as const));
    if (work.current !== my) return u;
    const st: Record<string, SafeTxStatus> = {};
    let next: StoredUpload | null = null;
    const d = ctx.read('VoucherDAO');
    for (const [j, s] of res) {
      if (!s) continue;
      st[j.hash] = s;
      if (!j.propose || s.state !== 'executed' || !s.txHash) continue;
      const rc = await ctx.reader.getTransactionReceipt(s.txHash).catch(() => null);
      if (!rc) continue;
      if (!isDao) {
        const done = await completeFrom(next || u, j.bi, rc);
        if (done) next = done;
        continue;
      }
      const ids: number[] = [];
      for (const l of rc.logs) {
        if (!sameAddr(l.address, d.address)) continue;
        try { const pl = d.interface.parseLog(l); if (pl.name === 'BulkMintProposed') ids.push(Number(pl.args.proposalId.toString())); } catch { /* other */ }
      }
      // one proposal in that tx: it's this batch. Several (a Safe batch): left to the on-chain match
      if (ids.length === 1) {
        next = next || clone(u);
        next.batches[j.bi].proposalId = ids[0];
        next.batches[j.bi].proposeTx = s.txHash;
        delete next.batches[j.bi].submittedAt;
      }
    }
    setSafeStatus((c) => ({ ...c, ...st }));
    if (next) await saveUpload(next);
    return next || u;
  };

  // propose tx of batches that have a proposal id but no recorded tx (seen on-chain before the
  // wallet answered, or a multi-approval type): BulkMintProposed log, searched from shortly before
  // the batch was sent. Only for batches sent from this page (fromTs), and only tried once each.
  const proposeTxTried = useRef(new Set<number>());
  const findProposeTxs = async (u: StoredUpload, my: number): Promise<StoredUpload> => {
    if (!isDao) return u;
    const need = u.batches.filter((b) => b.proposalId !== null && !b.proposeTx && b.fromTs && !proposeTxTried.current.has(b.proposalId));
    if (!need.length || !ctx.reader) return u;
    need.forEach((b) => proposeTxTried.current.add(b.proposalId as number));
    const provider = ctx.reader;
    const d = ctx.read('VoucherDAO');
    const topic = d.interface.getEventTopic('BulkMintProposed');
    const latest = await provider.getBlockNumber();
    const back = Math.min(1000, latest);
    const [a, b0] = await Promise.all([provider.getBlock(latest), provider.getBlock(latest - back)]);
    const secPerBlock = Math.max(0.1, (a.timestamp - b0.timestamp) / Math.max(1, back));
    const since = Math.max(0, a.timestamp - Math.min(...need.map((b) => b.fromTs as number)) + 600);
    const fromBlock = Math.max(0, latest - Math.ceil(since / secPerBlock));
    const ids = need.map((b) => b.proposalId as number);
    const found = new Map<number, string>();
    let size = 5000;
    for (let to = latest; to >= fromBlock && work.current === my && found.size < ids.length;) {
      const from = Math.max(fromBlock, to - size + 1);
      try {
        for (const l of await provider.getLogs({ address: d.address, topics: [topic, ids.map(idTopic)], fromBlock: from, toBlock: to })) {
          found.set(ethers.BigNumber.from(l.topics[1]).toNumber(), l.transactionHash);
        }
      } catch (e) {
        if (size > 250) { size = Math.floor(size / 2); continue; }
        return u; // RPC refused: try again next visit
      }
      to = from - 1;
    }
    if (!found.size || work.current !== my) return u;
    const next = clone(u);
    next.batches.forEach((b) => { if (b.proposalId !== null && !b.proposeTx && found.has(b.proposalId)) b.proposeTx = found.get(b.proposalId); });
    await saveUpload(next);
    return next;
  };

  const open = async (u: StoredUpload): Promise<StoredUpload> => {
    const my = ++work.current;
    let x = u;
    setCurrent(u);
    setLive({});
    setClaims(u.claims || {});
    setPage(0);
    setMsg(null);
    try {
      x = await pollSafe(u, my);
      x = await resolveIds(x, my);
      if (work.current !== my) return x;
      setCurrent(x);
      setStatus('Reading batches…');
      const lv = await readLive(x.batches.map((b) => b.proposalId).filter((id): id is number => id !== null));
      if (work.current !== my) return x;
      setLive(lv);
      x = await findMinted(x, lv, my);
      if (work.current !== my) return x;
      x = await findProposeTxs(x, my).catch(() => x);
      if (work.current !== my) return x;
      setCurrent(x);
      setStatus(null);
      reload();
    } catch (e: any) {
      if (work.current === my) { setStatus(null); setMsg({ ok: false, text: `On-chain check failed: ${e.message}` }); }
    }
    return x;
  };

  // re-read approvals / executed (cheap), then voucher ids for anything newly executed
  const refresh = async (quiet = false, base?: StoredUpload) => {
    const start = base ?? current;
    if (!start) return;
    const my = work.current;
    try {
      // batches sent to a Safe: follow it (mainnet) and look for the proposal on-chain
      let cur = await pollSafe(start, my);
      if (cur.batches.some((b) => (isDao ? b.proposalId === null && b.submittedAt : !b.completedAt && (b.fromTs || b.submittedAt)))) cur = await resolveIds(cur, my);
      if (work.current !== my) return;
      if (cur !== current) setCurrent(cur);
      const lv = await readLive(cur.batches.map((b) => b.proposalId).filter((id): id is number => id !== null));
      if (work.current !== my) return;
      setLive(lv);
      let x = await findMinted(cur, lv, my, quiet);
      x = await findProposeTxs(x, my).catch(() => x);
      if (work.current === my) { setCurrent(x); setStatus(null); }
    } catch (e: any) {
      if (!quiet) setMsg({ ok: false, text: e.message });
    }
  };

  // 3. claim state, only for the rows on screen
  // filters for the vouchers table: search (wallet / voucher id), batch, status
  const [fq, setFq] = useState('');
  const [fBatch, setFBatch] = useState(''); // '' = all, else batch index
  const [fStatus, setFStatus] = useState<'' | 'minted' | 'notminted' | 'claimed' | 'unclaimed' | 'revoked' | 'moved'>('');
  useEffect(() => { setPage(0); }, [fq, fBatch, fStatus]);
  useEffect(() => { setFq(''); setFBatch(''); setFStatus(''); }, [current?.id]);
  const filtered = useMemo(() => {
    if (!current) return [];
    const q = fq.trim().toLowerCase().replace(/^#/, '');
    return current.rows.map((r, i) => {
      const bi = current.batches.findIndex((x) => i >= x.start && i < x.end);
      const b = current.batches[bi];
      const vid = batchVoucherIds(current, bi)?.[i - b.start];
      const minted = !!b.completedAt || (b.proposalId !== null && !!live[b.proposalId]?.executed);
      return { r, i, b, bi, vid, minted };
    }).filter((x) => {
      if (fBatch !== '' && x.bi !== Number(fBatch)) return false;
      if (q && !(x.r.to.toLowerCase().includes(q) || x.vid === q)) return false;
      const cl = x.vid ? claims[x.vid] : undefined;
      switch (fStatus) {
        case 'minted': return x.minted;
        case 'notminted': return !x.minted;
        case 'claimed': return !!cl?.claimed;
        case 'unclaimed': return !!cl && !cl.claimed && !cl.revoked;
        case 'revoked': return !!cl?.revoked;
        case 'moved': return !!cl?.owner && !sameAddr(cl.owner, x.r.to);
        default: return true;
      }
    });
  }, [current, live, claims, fq, fBatch, fStatus]);
  const rowsOnPage = useMemo(() => filtered.slice(page * PAGE, page * PAGE + PAGE), [filtered, page]);
  // claim-based filters use the last "Check claims" result (button); nothing is read automatically
  const claimFilter = fStatus === 'claimed' || fStatus === 'unclaimed' || fStatus === 'revoked' || fStatus === 'moved';


  // claim state, read on demand only (button). Claimed / revoked are final on-chain, so vouchers
  // already saved as such are skipped; results are saved with the upload in IndexedDB.
  const checkClaims = async () => {
    if (!current || !ctx.reader) return;
    const c = mintContract(false);
    const known = current.claims || {};
    const vids = current.batches.flatMap((_, bi) => batchVoucherIds(current, bi) ?? []).filter((v) => !(known[v]?.claimed || known[v]?.revoked));
    const out: Record<string, Claim> = {};
    try {
      setStatus(`Checking claims for ${vids.length} vouchers on-chain…`);
      // ATM v1: "claimed" = redeemed; "revoked" = voided (moved to the void address)
      const voidAddr: string | null = mode === 'atm-v1' ? await c.voidAddress().catch(() => null) : null;
      for (let i = 0; i < vids.length; i += 25) {
        await Promise.all(vids.slice(i, i + 25).map(async (vid) => {
          if (mode === 'atm-v1') {
            const [v, owner] = await Promise.all([c.voucherOf(vid), c.ownerOf(vid).catch(() => null)]);
            out[vid] = { claimed: v.redeemed, revoked: !!owner && !!voidAddr && sameAddr(owner, voidAddr), owner };
            return;
          }
          const [v, owner] = await Promise.all([c.vouchers(vid), c.ownerOf(vid).catch(() => null)]);
          out[vid] = { claimed: v.claimed, revoked: v.revoked, owner };
        }));
        setStatus(`Checking claims… ${Math.min(i + 25, vids.length)}/${vids.length}`);
      }
      // save onto the latest stored copy (never an older one), then show it
      const fresh = (await listUploads(ctx.chainId, current.dao)).find((x) => x.id === current.id) ?? current;
      const next: StoredUpload = { ...fresh, claims: { ...(fresh.claims || {}), ...out }, claimsAt: Math.floor(Date.now() / 1000) };
      await saveUpload(next);
      setCurrent((c) => (c && c.id === next.id ? { ...c, claims: next.claims, claimsAt: next.claimsAt } : c));
      setClaims(next.claims || {});
      setMsg({ ok: true, text: `Claim status checked for ${vids.length} voucher${vids.length === 1 ? '' : 's'}${Object.keys(known).length ? ' (already-claimed ones are final and were skipped)' : ''}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: `Claim check failed: ${e.message}` });
    } finally {
      setStatus(null);
    }
  };

  // open from on-chain proposal ids (proposed elsewhere): saved once, like an upload
  const openFromChain = async (seed: number, withNeighbours = true) => {
    if (!dao) return;
    setBusy(true);
    setMsg(null);
    try {
      const existing = (await listUploads(ctx.chainId, dao)).find((u) => u.batches.some((b) => b.proposalId === seed));
      if (existing) { open(existing); return; }
      const d = ctx.read('VoucherDAO');
      const n = (await d.nextBulkProposalId()).toNumber();
      if (!(seed >= 0 && seed < n)) throw new Error(`Bulk mint proposal #${seed} does not exist (there are ${n})`);
      const read = async (id: number) => {
        const [p, to, faces, tokenIds] = await Promise.all([d.bulkMintProposals(id), d.getBulkMintRecipients(id), d.getBulkMintFaceValues(id), d.getBulkMintTokenIds(id)]);
        return { id, p, to: to as string[], faces: faces as ethers.BigNumber[], tokenIds: tokenIds as ethers.BigNumber[] };
      };
      const first = await read(seed);
      if (Number(first.p.typeId) !== type.id) throw new Error(`Proposal #${seed} is for voucher type #${first.p.typeId} — pick that type above`);
      const same = (x: typeof first) => sameAddr(x.p.proposer, first.p.proposer) && Number(x.p.typeId) === type.id && sameAddr(x.p.token, first.p.token)
        && Number(x.p.startDate) === Number(first.p.startDate) && Number(x.p.expiryDate) === Number(first.p.expiryDate);
      const parts = [first];
      if (withNeighbours) {
        const known = new Set((await listUploads(ctx.chainId, dao)).flatMap((u) => u.batches.map((b) => b.proposalId)));
        for (const dir of [-1, 1]) {
          for (let id = seed + dir, k = 0; id >= 0 && id < n && k < NEIGHBOURS && !known.has(id); id += dir, k++) {
            const x = await read(id);
            if (!same(x)) break;
            parts.push(x);
          }
        }
      }
      parts.sort((a, b) => a.id - b.id);
      const rows = parts.flatMap((x) => x.to.map((to, i) => ({ to, face: x.faces[i].toString(), tokenId: (x.tokenIds[i] ?? 0).toString() })));
      let start = 0;
      const batches = parts.map((x) => { const b = { start, end: start + x.to.length, proposalId: x.id }; start = b.end; return b; });
      const u: StoredUpload = {
        id: newUploadId(), chainId: ctx.chainId, dao: dao.toLowerCase(), typeId: type.id, token: first.p.token,
        startDate: Number(first.p.startDate), expiryDate: Number(first.p.expiryDate), createdAt: 0,
        name: parts.length > 1 ? `On-chain batches #${parts[0].id}–#${parts[parts.length - 1].id}` : `On-chain batch #${seed}`,
        rows, batches,
      };
      await saveUpload(u);
      await reload();
      open(u);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  // a bulk proposal's "Check on-chain" link on the proposals list
  useEffect(() => {
    if (focus && ctx.reader && isDao) openFromChain(focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, ctx.reader]);

  // follow the chain every 15s while any batch is in progress (sent to a Safe, or proposed and not
  // yet complete / cancelled / expired); stops by itself once everything has finished
  const nowSec = Math.floor(Date.now() / 1000);
  const inFlight = !!current && current.batches.some((b) => {
    if (!isDao) return !b.completedAt && !!(b.fromTs || b.submittedAt);
    if (b.proposalId === null) return !!b.submittedAt;
    if (b.completedAt) return false;
    const l = live[b.proposalId];
    return !l || !(l.cancelled || (!l.executed && nowSec > l.expiresAt));
  });
  const fast = fastUntil > Date.now();
  useEffect(() => {
    if (!auto || !inFlight) return;
    const t = setInterval(() => refresh(true), fast ? 3_000 : 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, inFlight, current, fast]);
  useEffect(() => {
    if (!fast) return;
    const t = setTimeout(() => setFastUntil(0), fastUntil - Date.now());
    return () => clearTimeout(t);
  }, [fast, fastUntil]);

  // the form above proposed a batch: show that upload (fresh from IndexedDB) and follow it
  useEffect(() => {
    if (!kick || !dao) return;
    (async () => {
      const fresh = (await listUploads(ctx.chainId, dao)).find((u) => u.id === kick.uploadId);
      if (!fresh) return;
      if (kick.send) {
        const x = await open(fresh);
        propose(kick.only, x);
        return;
      }
      if (current?.id === fresh.id) { setCurrent(fresh); refresh(true, fresh); } else open(fresh);
      setAuto(true);
      setFastUntil(Date.now() + 120_000);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kick]);

  useEffect(() => () => { work.current++; }, []);

  const act = async (pid: number, what: 'approve' | 'execute', vouchers: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const lv = live[pid];
      const reaches = lv && type.approvalsRequired > 0 && lv.approvals + 1 >= type.approvalsRequired;
      const gas = what === 'execute' || reaches ? exec(vouchers) : undefined;
      const rc = await sendDao(`DAO: ${what} bulk #${pid}`, what === 'approve' ? 'approveBulkMint' : 'executeBulkMint', [pid], gas ? { gasLimit: gas } : {});
      if (isSafeSent(rc) && current) {
        const next = clone(current);
        const b = next.batches.find((x) => x.proposalId === pid);
        if (b) {
          b.safeActions = [...(b.safeActions || []), { kind: what, hash: rc.safeTxHash, safe: ctx.account, at: Math.floor(Date.now() / 1000) }];
          await saveUpload(next);
          setCurrent(next);
        }
      }
      setMsg({ ok: true, text: !isSafeSent(rc) ? `${what === 'approve' ? 'Approved' : 'Executed'} batch #${pid}` : `Sent "${what} batch #${pid}" to the Safe — sign & execute it there; progress shows on the batch.` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      setTimeout(() => refresh(true), 2500);
    }
  };

  // ---- propose batches from an upload ----

  // A Safe only queues a tx and answers with its own hash (safeTxHash), which never appears on-chain —
  // ethers' sendTransaction (and so ctx.send) would poll for it forever. Send unchecked and keep that
  // hash: on mainnet the Safe API follows it; everywhere the result is also read from the chain.
  const sendDao = (label: string, method: string, args: any[], overrides: { gasLimit?: number }) => sendTx(label, ctx.write('VoucherDAO'), method, args, overrides);
  const sendTx = async (label: string, c: ethers.Contract, method: string, args: any[], overrides: { gasLimit?: number }): Promise<ethers.ContractReceipt | SafeSent> => {
    if (!contractWallet) return ctx.send(label, c, method, args, overrides);
    const tx = await c.populateTransaction[method](...args, overrides);
    const signer = c.signer as ethers.providers.JsonRpcSigner;
    const safeTxHash = typeof signer.sendUncheckedTransaction === 'function' ? await signer.sendUncheckedTransaction(tx) : (await signer.sendTransaction(tx)).hash;
    return { safeTxHash };
  };

  // direct / ATM v1: one mintBatch per batch; the chain is watched while the wallet is busy
  const mintBatchTx = async (u: StoredUpload, idx: number, pr: ProposeParams): Promise<StoredUpload> => {
    const b = u.batches[idx];
    const rows = u.rows.slice(b.start, b.end);
    const c = mintContract(true);
    const args = mode === 'atm-v1'
      ? [rows.map((r) => r.to), rows.map((r) => r.face), type.id, pr.startDate, pr.expiryDate, pr.redemptionDays ?? 0, pr.transferable ?? true, pr.uri ?? '']
      : [type.id, rows.map((r) => r.to), rows.map((r) => r.face), pr.startDate, pr.expiryDate, pr.token, rows.map((r) => r.tokenId || '0')];
    let next = clone(u);
    next.batches[idx].fromTs = Math.floor(Date.now() / 1000) - 60;
    Object.assign(next.batches[idx], { token: pr.token, startDate: pr.startDate, expiryDate: pr.expiryDate });
    await saveUpload(next); // "sent" is recorded before the wallet: a page closed now can't lose it
    const label = `${P.contract}: mint batch ${b.file ?? `batch ${idx + 1}`} (${rows.length})${mode === 'direct' ? ` type ${type.id}` : ''}`;
    const fromBlock = Math.max(0, (await ctx.reader!.getBlockNumber()) - 2);
    let seen: StoredUpload | null = null;
    const raced = await raceWithChain(sendTx(label, c, 'mintBatch', args, {}), async () => {
      seen = await findMintTx(next, idx, fromBlock);
      return seen ? 1 : null;
    });
    if (raced.via === 'chain' && seen) {
      ctx.confirmedByChain(label, 'seen on-chain');
      next = seen;
    } else if (raced.via === 'wallet') {
      const rc = raced.value;
      if (isSafeSent(rc)) {
        Object.assign(next.batches[idx], { submittedAt: Math.floor(Date.now() / 1000), safeTxHash: rc.safeTxHash, safe: ctx.account });
      } else {
        next = (await completeFrom(next, idx, rc)) ?? next;
      }
    }
    await saveUpload(next);
    return next;
  };

  const proposeBatch = async (u: StoredUpload, idx: number, pr: ProposeParams): Promise<StoredUpload> => {
    if (!isDao) return mintBatchTx(u, idx, pr);
    const b = u.batches[idx];
    const rows = u.rows.slice(b.start, b.end);
    const args = [type.id, rows.map((r) => r.to), rows.map((r) => r.face), pr.startDate, pr.expiryDate, pr.token, rows.map((r) => r.tokenId || '0'), pr.duration];
    // at quorum 1 the proposal mints at once: keep the gas floor (see dao-tab execGas)
    const gas = type.approvalsRequired <= 1 ? { gasLimit: exec(rows.length) } : {};
    const next = clone(u);
    next.batches[idx].fromTs = Math.floor(Date.now() / 1000) - 60;
    Object.assign(next.batches[idx], { token: pr.token, startDate: pr.startDate, expiryDate: pr.expiryDate });
    const label = `DAO: propose bulk mint ${b.file ?? `batch ${idx + 1}`} (${rows.length}) type ${type.id}`;
    // watch the chain while the wallet is busy: from 3s after the click, every 3s, look for a new
    // proposal that is exactly this batch — if it's there, stop waiting on the wallet
    const d = ctx.read('VoucherDAO');
    const fromId = (await d.nextBulkProposalId()).toNumber();
    const taken = new Set(u.batches.map((x) => x.proposalId).filter((x): x is number => x !== null));
    const raced = await raceWithChain(
      sendDao(label, 'proposeBulkMint', args, gas),
      () => findNewBulkProposal(d, fromId, { typeId: type.id, recipients: rows.map((r) => r.to), faces: rows.map((r) => r.face), startDate: pr.startDate, expiryDate: pr.expiryDate, token: pr.token }, taken),
    );
    if (raced.via === 'chain') {
      ctx.confirmedByChain(label, `seen on-chain as proposal #${raced.proposalId}`);
      next.batches[idx].proposalId = raced.proposalId;
      await saveUpload(next);
      return next;
    }
    const rc = raced.value;
    if (isSafeSent(rc)) {
      // queued in the Safe: followed via the Safe API (mainnet) and matched on-chain later
      next.batches[idx].submittedAt = Math.floor(Date.now() / 1000);
      next.batches[idx].safeTxHash = rc.safeTxHash;
      next.batches[idx].safe = ctx.account;
    } else {
      next.batches[idx].proposeTx = rc.transactionHash;
      try { next.batches[idx].proposalId = Number(eventArg(rc, ctx.read('VoucherDAO'), 'BulkMintProposed', 'proposalId').toString()); } catch { /* matched on-chain later */ }
    }
    await saveUpload(next);
    return next;
  };

  // propose the given batches one by one (all not yet proposed when `only` is omitted)
  const propose = async (only?: number, base?: StoredUpload) => {
    const start = base ?? current;
    if (!start) return;
    const my = work.current;
    setBusy(true);
    setMsg(null);
    let x = start;
    let at = '';
    try {
      const pr = params();
      // already on-chain (Safe tx executed meanwhile, another admin)? then don't propose it twice
      x = await resolveIds(x, my);
      setCurrent(x);
      // DAO: no proposal yet. Direct / ATM v1: not minted; one sent in the last 3 min that isn't found
      // yet is left alone (its tx may still be pending), so a batch is never minted twice
      const recent = (b: StoredBatch) => !!b.fromTs && Date.now() / 1000 - b.fromTs < 240;
      let todo = x.batches.map((_, i) => i).filter((i) => {
        const b = x.batches[i];
        if (only !== undefined && i !== only) return false;
        if (isDao) return b.proposalId === null && (only !== undefined || !b.submittedAt);
        return !b.completedAt && !recent(b) && (only !== undefined || !b.submittedAt);
      });
      if (!todo.length) { setMsg({ ok: true, text: only === undefined ? `Every batch is already ${isDao ? 'proposed' : 'sent'}.` : 'That batch is already on-chain (or was just sent — it is being looked up).' }); return; }
      if (only !== undefined && x.batches[only].submittedAt && !window.confirm('This batch was already sent to the Safe and is not on-chain yet. Send it again? (Reject the old one in Safe{Wallet} if you do.)')) return;
      const n = todo.reduce((s2, i) => s2 + x.batches[i].end - x.batches[i].start, 0);
      const utc = (ts: number) => `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC${new Date(ts * 1000).getTimezoneOffset() !== 0 ? ` · your local time: ${fmtLocal(ts)}` : ' (same as your local time)'}`;
      // ATM v1 has no payout token: the face value is the amount
      const tokenName = type.mode === VoucherMode.Reward && mode !== 'atm-v1' ? (sameAddr(pr.token, ethers.constants.AddressZero) ? 'native coin' : ctx.nameOf(pr.token)) : '';
      const what = todo.length > 1 ? `${todo.length} batches (${n} vouchers)` : `${x.batches[todo[0]].file ?? `batch ${todo[0] + 1}`} (${n} vouchers)`;
      const rowsToSend = todo.flatMap((i) => x.rows.slice(x.batches[i].start, x.batches[i].end).map((r) => ({ to: r.to, amount: showFace(type, r.face), group: x.batches[i].file ?? `batch ${i + 1}` })));
      const totalRaw = todo.reduce((t, i) => t.add(sum(x.rows.slice(x.batches[i].start, x.batches[i].end))), ethers.BigNumber.from(0));
      const total = `${showFace(type, totalRaw)}${tokenName ? ` ${tokenName}` : ''}`;
      const resending = only !== undefined && !!x.batches[only].submittedAt;
      const res = await ask({
        title: `${P.verb} ${what}`,
        intro: contractWallet
          ? `Connected wallet is a Safe: ${todo.length > 1 ? 'each batch is' : 'it is'} queued there for the owners to sign and execute.`
          : todo.length > 1 ? 'Your wallet asks once per batch; each waits for the chain before the next.' : 'Your wallet will ask you to confirm after this.',
        fields: [
          { label: 'Page', value: P.page },
          { label: 'Network', value: NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}` },
          { label: `Contract (${P.contract})`, value: <span className="font-mono text-xs">{dao}</span> },
          { label: 'Voucher type', value: mode === 'atm-v1' ? `#${type.id} ${type.name}` : `${typeLabel(type)}${isDao ? ` · needs ${type.approvalsRequired} approval${type.approvalsRequired === 1 ? '' : 's'}` : ''}` },
          ...(tokenName ? [{ label: 'Payout token', value: tokenName }] : []),
          { label: 'Claimable from', value: pr.startDate ? utc(pr.startDate) : 'immediately' },
          { label: 'Expires', value: pr.expiryDate ? utc(pr.expiryDate) : 'never', warn: !pr.expiryDate },
          ...(isDao ? [{ label: 'Voting window', value: `${Math.round(pr.duration / 3600)} hours` }] : []),
          ...(mode === 'atm-v1' ? [
            { label: 'Redemption days', value: `${pr.redemptionDays ?? 0}${(pr.redemptionDays ?? 0) === 0 ? ' (instant)' : ''}` },
            { label: 'Transferable', value: pr.transferable === false ? 'no' : 'yes' },
            ...(pr.uri ? [{ label: 'Metadata URI', value: pr.uri }] : []),
          ] : []),
          { label: isDao ? 'Proposals (batches)' : 'Transactions (batches)', value: `${todo.length}: ${todo.map((i) => x.batches[i].file ?? `batch ${i + 1}`).join(', ')}` },
          { label: 'Sent from', value: <span className="font-mono text-xs">{ctx.account}{contractWallet ? ' (Safe)' : ''}</span> },
          { label: 'Total', value: total },
        ],
        rows: rowsToSend,
        amountLabel: fungible(type) && tokenName ? `Amount (${tokenName})` : 'Amount',
        // removing changes a batch's content: not for one already queued in a Safe
        allowRemove: !resending && n > 1,
        totalUnit: fungible(type) ? tokenName || ' ' : undefined,
        total,
        warnings: [
          ...(!pr.expiryDate ? ['No expiry set — these vouchers never expire.'] : []),
          ...(isDao && type.approvalsRequired <= 1 ? ['This type needs 1 approval: the vouchers are minted as soon as each proposal lands on-chain.'] : []),
          ...(caps?.op !== null && caps?.op !== undefined && n > caps.op ? [`Your ${isDao ? 'proposal' : 'mint'} cap has ${caps.op} vouchers left — only the batches that fit are sent; the rest stop with a message.`] : []),
        ],
        confirmLabel: contractWallet ? 'Confirm & send to Safe' : 'Confirm & send',
      });
      if (!res) return;
      // wallets removed in the review move to a new "… — removed wallets" batch (not proposed)
      if (res.removed.length) {
        const rowIdx = todo.flatMap((i) => Array.from({ length: x.batches[i].end - x.batches[i].start }, (_, k) => x.batches[i].start + k));
        const { upload, batchMap } = removeRows(x, res.removed.map((k) => rowIdx[k]));
        await saveUpload(upload);
        x = upload;
        setCurrent(x);
        todo = todo.map((i) => batchMap[i]).filter((i) => i >= 0);
        if (!todo.length) { setMsg({ ok: true, text: 'All wallets were removed — nothing sent. They are in the new "removed wallets" batch.' }); return; }
      }
      // proposeBulkMint reverts with MintCapExceeded once this operator's window is used up
      let room = caps?.op ?? Infinity;
      for (const [k, i] of todo.entries()) {
        if (work.current !== my) break;
        const size = x.batches[i].end - x.batches[i].start;
        if (size > room) {
          throw new Error(`Your ${isDao ? 'VoucherDAO proposal' : 'VoucherNFT mint'} cap is used up (${caps?.op ?? 0} left of ${caps?.opLimit} per window) — ${todo.length - k} batch${todo.length - k === 1 ? '' : 'es'} not sent. `
            + `Wait for the window to reset${caps?.opResets ? ` (${new Date(caps.opResets * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}, or have the ${isDao ? 'DAO' : 'VoucherNFT'} admin raise it (Set my cap to unlimited, below the table).`);
        }
        room -= size;
        at = x.batches[i].file ?? `batch ${i + 1}`;
        setStatus(`${isDao ? 'Proposing' : 'Minting'} ${k + 1}/${todo.length}: ${at}…`);
        x = await proposeBatch(x, i, pr);
        setCurrent(x);
      }
      setMsg({ ok: true, text: contractWallet ? `Sent ${todo.length} batch${todo.length === 1 ? '' : 'es'} to the Safe. Sign & execute there; they show up here once on-chain.` : `${isDao ? 'Proposed' : 'Minted'} ${todo.length} batch${todo.length === 1 ? '' : 'es'}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: `${at ? `Stopped at ${at}: ` : ''}${e.message}${at ? ` — earlier batches are saved; click ${P.verb} again to continue.` : ''}` });
    } finally {
      setBusy(false);
      setStatus(null);
      setFastUntil(Date.now() + 120_000);
      loadCaps();
      if (work.current === my) open(x);
    }
  };

  // DAO admin: lift the operator's (and VoucherDAO's minter) cap for this type
  const unlimit = async (which: 'op' | 'nft') => {
    setBusy(true);
    setMsg(null);
    try {
      const max = ethers.constants.MaxUint256.toString();
      if (which === 'op' && !isDao) {
        await sendTx(`Type ${type.id}: my mint cap → unlimited`, ctx.write('VoucherNFT'), 'setMinterCap', [type.id, ctx.account, max], {});
      } else if (which === 'op') {
        await sendDao(`Type ${type.id}: operator cap → unlimited`, 'setOperatorCap', [type.id, ctx.account, max], {});
      } else {
        await ctx.send(`Type ${type.id}: VoucherDAO minter cap → unlimited`, ctx.write('VoucherNFT'), 'setMinterCap', [type.id, dao, max]);
      }
      setMsg({ ok: true, text: contractWallet ? 'Sent to the Safe — sign & execute it there.' : 'Cap set to unlimited.' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      setTimeout(loadCaps, 2500);
    }
  };

  // ---- import batch files (zip or CSVs) ----

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    // copy now: the FileList is live and empties when the input is reset after picking
    const list = Array.from(fileList);
    setMsg(null);
    setPreview(null);
    try {
      const files: { path: string; bytes: Uint8Array; loose?: boolean }[] = [];
      for (const f of list) {
        if (/\.zip$/i.test(f.name)) files.push(...(await readZip(f)));
        else files.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()), loose: true });
      }
      const dec = new TextDecoder();
      const index = files.find((f) => /(^|\/)files\.csv$/i.test(f.path));
      const summary = files.find((f) => /(^|\/)SUMMARY\.txt$/i.test(f.path));
      const root = index ? index.path.replace(/files\.csv$/i, '') : '';
      const shaOf = new Map<string, string>(); // path under root -> sha256 (files.csv: file,rows,rgst,sha256)
      if (index) {
        for (const line of dec.decode(index.bytes).split(/\r?\n/).slice(1)) {
          const cols = line.split(',').map((c) => c.trim());
          if (cols.length >= 4 && cols[0]) shaOf.set(cols[0], cols[cols.length - 1].toLowerCase());
        }
      }
      // a CSV picked on its own has no folder: find it in files.csv by file name (gives its folder + sha)
      const byName = new Map<string, string[]>();
      for (const rel of Array.from(shaOf.keys())) {
        const base = rel.split('/').pop() as string;
        byName.set(base, [...(byName.get(base) || []), rel]);
      }
      const relOf = (f: { path: string; loose?: boolean }) => {
        if (f.loose) {
          const hits = byName.get(f.path) || [];
          return hits.length === 1 ? hits[0] : f.path; // ambiguous or unlisted: keep the bare name
        }
        return root && f.path.startsWith(root) ? f.path.slice(root.length) : f.path;
      };
      const groups = new Map<string, PreviewFile[]>();
      for (const f of files.filter((x) => /\.csv$/i.test(x.path) && x !== index)) {
        const rel = relOf(f);
        const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : 'files';
        const name = rel.split('/').pop() as string;
        const { rows, errors } = checkRows(csvToRows(dec.decode(f.bytes)), fungibleType, needsId);
        const stored = rows.map((r) => ({ to: r.to, face: fungibleType ? ethers.utils.parseUnits(r.amount, 18).toString() : r.amount, tokenId: r.tokenId || '0' }));
        const want = shaOf.get(rel);
        const sha = !want ? 'none' : (await sha256Hex(f.bytes)) === want ? 'ok' : 'bad';
        if (!rows.length && !errors.length) errors.push('no rows');
        const total = stored.reduce((t, r) => t.add(r.face), ethers.BigNumber.from(0));
        groups.set(folder, [...(groups.get(folder) || []), { file: name, rows: stored, errors, sha, total, pick: true }]);
      }
      if (!groups.size) throw new Error('No CSV batch files found');
      const present = new Set(files.map(relOf));
      const missing = Array.from(shaOf.keys()).filter((rel) => !present.has(rel)).sort(natural);
      const source = list.length === 1 ? list[0].name : `${list.length} files`;

      // smart duplicate check against every batch already saved for this VoucherDAO (any type, any
      // state) and against the other files in this import
      const saved = dao ? await listUploads(ctx.chainId, dao) : [];
      const stateOf = (b: StoredBatch) => (b.completedAt ? '✓ complete' : b.proposalId !== null ? `proposed #${b.proposalId}` : b.submittedAt ? 'sent to Safe' : b.fromTs ? 'sent' : isDao ? 'not proposed' : 'not minted');
      // compare wallet + amount pairs (order does not matter) and the payout token
      let formToken = '';
      try { formToken = params().token.toLowerCase(); } catch { /* voting window not valid yet: token still readable below */ }
      const pairsOf = (rows: StoredRow[]) => rows.map((r) => `${r.to.toLowerCase()}:${r.face}`).sort();
      const known = saved.flatMap((u) => u.batches.map((b) => {
        const rows = u.rows.slice(b.start, b.end);
        const token = (b.token ?? u.token ?? '').toLowerCase();
        return {
          where: `${u.name} · ${b.file ?? 'batch'} (${stateOf(b)}${u.typeId !== type.id ? `, type #${u.typeId}` : ''})`,
          exact: pairsOf(rows).join(','),
          pairs: new Set(pairsOf(rows)),
          wallets: new Set(rows.map((r) => r.to.toLowerCase())),
          token,
        };
      }));
      const ordered = Array.from(groups.entries()).sort(([a], [b]) => natural(a, b)).map(([name, fs]) => ({ name, files: fs.sort((a, b) => natural(a.file, b.file)), pick: true }));
      const seenHere = new Map<string, string>(); // exact content -> folder/file earlier in this import
      for (const g of ordered) {
        for (const f of g.files) {
          if (!f.rows.length) continue;
          const pairs = pairsOf(f.rows);
          const exact = pairs.join(',');
          const wallets = new Set(f.rows.map((r) => r.to.toLowerCase()));
          const tokenDiffers = (k: { token: string }) => !!formToken && !!k.token && k.token !== formToken;
          const same = known.find((k) => k.exact === exact);
          if (same && !tokenDiffers(same)) f.dup = { kind: 'same', pct: 100, where: same.where };
          else if (same) f.dup = { kind: 'similar', pct: 100, where: same.where, note: 'same wallets and amounts, but a different payout token' };
          else if (seenHere.has(exact)) f.dup = { kind: 'same', pct: 100, where: `${seenHere.get(exact)} (in this import)` };
          else {
            let best: { pct: number; amt: number; where: string; tok: boolean } | null = null;
            for (const k of known) {
              let w = 0;
              let a = 0;
              wallets.forEach((x) => { if (k.wallets.has(x)) w++; });
              pairs.forEach((x) => { if (k.pairs.has(x)) a++; });
              const pct = w / wallets.size;
              if (pct >= SIMILAR && (!best || pct > best.pct)) best = { pct, amt: a / pairs.length, where: k.where, tok: tokenDiffers(k) };
            }
            if (best) {
              f.dup = {
                kind: 'similar', pct: Math.round(best.pct * 100), where: best.where,
                note: `${Math.round(best.pct * 100)}% same wallets · ${Math.round(best.amt * 100)}% same wallet + amount${best.tok ? ' · different payout token' : ''}`,
              };
            }
          }
          if (f.dup?.kind === 'same') f.pick = false; // an exact copy starts unticked
          seenHere.set(exact, `${g.name}/${f.file}`);
        }
      }
      setPreview({ source, summary: summary ? dec.decode(summary.bytes) : undefined, missing, groups: ordered });
    } catch (e: any) {
      setMsg({ ok: false, text: `Import failed: ${e.message}` });
    }
  };

  const saveImport = async () => {
    if (!preview || !dao) return;
    try {
      const pr = params();
      // only ticked folders and, inside them, only ticked files
      const picked = preview.groups.filter((g) => g.pick).map((g) => ({ ...g, files: g.files.filter((f) => f.pick) })).filter((g) => g.files.length);
      if (!picked.length) throw new Error('Tick at least one file');
      const bad = picked.flatMap((g) => g.files.filter((f) => f.errors.length || f.sha === 'bad').map((f) => `${g.name}/${f.file}`));
      if (bad.length) throw new Error(`Fix or untick these files first: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`);
      const flagged = picked.flatMap((g) => g.files.filter((f) => f.dup).map((f) => `• ${g.name}/${f.file} — ${f.dup!.kind === 'same' ? 'already imported' : f.dup!.note}: ${f.dup!.where}`));
      if (flagged.length && !window.confirm(`${flagged.length} file${flagged.length === 1 ? ' looks' : 's look'} already imported:\n\n${flagged.slice(0, 12).join('\n')}${flagged.length > 12 ? `\n… and ${flagged.length - 12} more` : ''}\n\nImport ${flagged.length === 1 ? 'it' : 'them'} anyway? They are added as a NEW upload — existing uploads and their batches are not changed.`)) return;
      const existing = await listUploads(ctx.chainId, dao);
      let first: StoredUpload | null = null;
      for (const g of picked) {
        const name = `${preview.source} · ${g.name}`;
        if (existing.some((u) => u.name === name) && !window.confirm(`"${name}" was imported before. Import it again as a separate upload?`)) continue;
        const rows: StoredRow[] = [];
        const batches: StoredBatch[] = [];
        for (const f of g.files) {
          const parts = chunk(f.rows, maxBatch); // a file over the per-tx limit becomes several batches
          parts.forEach((part, k) => {
            batches.push({ start: rows.length, end: rows.length + part.length, proposalId: null, file: parts.length > 1 ? `${f.file} (${k + 1}/${parts.length})` : f.file });
            rows.push(...part);
          });
        }
        const u: StoredUpload = {
          id: newUploadId(), chainId: ctx.chainId, dao: dao.toLowerCase(), scope: mode, typeId: type.id, token: pr.token,
          startDate: pr.startDate, expiryDate: pr.expiryDate, createdAt: Math.floor(Date.now() / 1000), name, source: preview.source, rows, batches,
        };
        await saveUpload(u);
        first = first || u;
      }
      setPreview(null);
      await reload();
      if (first) open(first); // also matches batches proposed before the import
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  // drop a batch that was never proposed (nothing on-chain refers to it, so this is safe)
  const removeBatch = async (idx: number) => {
    if (!current) return;
    const b = current.batches[idx];
    if (b.proposalId !== null || b.submittedAt || b.completedAt || (!isDao && b.fromTs)) return;
    if (!window.confirm(`Remove ${b.file ?? `batch ${idx + 1}`} (${b.end - b.start} rows) from this upload?`)) return;
    const size = b.end - b.start;
    const next = clone(current);
    next.rows = [...current.rows.slice(0, b.start), ...current.rows.slice(b.end)];
    next.batches = current.batches.filter((_, i) => i !== idx).map((x) => (x.start >= b.end ? { ...x, start: x.start - size, end: x.end - size } : x));
    if (!next.batches.length) {
      await deleteUpload(current.id);
      setCurrent(null);
    } else {
      await saveUpload(next);
      setCurrent(next);
      setPage(0);
    }
    reload();
  };

  if (!dao) return null;
  const now = Math.floor(Date.now() / 1000);

  // ---- downloads ----
  const fileBase = (u: StoredUpload) => `${u.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'upload'}_chain${ctx.chainId}_${new Date().toISOString().slice(0, 10)}`;
  const net = NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}`;
  const txUrl = (h?: string) => (h ? getExplorerTxUrl(ctx.chainId, h) : '');
  const nftAddr = (mode === 'atm-v1' ? atm?.address : ctx.book.contracts.VoucherNFT) ?? '';
  // explorer page of one voucher NFT (e.g. bscscan.com/nft/<contract>/<id>)
  const nftUrl = (id?: string) => (id && nftAddr ? `${(NETWORKS[ctx.chainId] || NETWORKS[97]).blockExplorerUrls[0]}/nft/${nftAddr}/${id}` : '');
  const payoutIsNft = type.mode === VoucherMode.Reward && (type.tokenStandard === TokenStandard.ERC721 || type.tokenStandard === TokenStandard.ERC1155);
  const tokenOf = (b: StoredBatch, u: StoredUpload) => {
    const t = b.token ?? u.token;
    return type.mode !== VoucherMode.Reward || mode === 'atm-v1' ? '' : sameAddr(t, ethers.constants.AddressZero) ? 'native' : ctx.nameOf(t);
  };
  // status for the file: live state when this upload is open, else what IndexedDB has
  const statusForFile = (b: StoredBatch) => {
    const t = batchStatus(b).text;
    return t !== '…' ? t : b.proposalId !== null ? `proposed #${b.proposalId}` : isDao ? 'not proposed' : 'not minted';
  };
  const downloadRows = (u: StoredUpload) => downloadCsv(`${fileBase(u)}.csv`,
    ['row', 'wallet', 'amount', 'token', ...(payoutIsNft ? ['payout_nft_token_id'] : []), 'batch_no', 'file', 'proposal_id', 'batch_status', 'minted',
      'voucher_nft_id', 'voucher_nft_contract', 'voucher_nft_url', 'mint_tx', 'mint_tx_url', 'minted_at_utc',
      'propose_tx', 'safe_tx_hash', P.claim.toLowerCase(), 'current_owner', 'claims_checked_at_utc', 'claimable_from_utc', 'expires_utc', 'voucher_type', 'network', 'page', 'contract'],
    u.rows.map((r, i) => {
      const bi = u.batches.findIndex((x) => i >= x.start && i < x.end);
      const b = u.batches[bi];
      const vid = batchVoucherIds(u, bi)?.[i - b.start];
      const cl = vid ? (claims[vid] ?? u.claims?.[vid]) : undefined;
      const start = b.startDate ?? u.startDate;
      const expiry = b.expiryDate ?? u.expiryDate;
      return [i + 1, r.to, showFace(type, r.face), tokenOf(b, u), ...(payoutIsNft ? [r.tokenId] : []), bi + 1, b.file ?? '', b.proposalId ?? '', statusForFile(b), isMinted(b) ? 'yes' : 'no',
        vid ?? '', vid ? nftAddr : '', nftUrl(vid),
        b.execTx ?? '', txUrl(b.execTx), isoUtc(b.completedAt), b.proposeTx ?? '', b.safeTxHash ?? '',
        !vid ? '' : !cl ? 'not checked' : cl.revoked ? 'revoked' : cl.claimed ? 'yes' : 'no', cl?.owner ?? '', isoUtc(u.claimsAt),
        start ? isoUtc(start) : 'immediately', expiry ? isoUtc(expiry) : 'never', `#${type.id} ${type.name}`, net, P.page, dao];
    }));

  // minted = saved as complete in IndexedDB (never re-read), or the chain says executed
  const isMinted = (b: StoredBatch) => !!b.completedAt || (b.proposalId !== null && !!live[b.proposalId]?.executed);
  const batchStatus = (b: StoredBatch) => {
    const pid = b.proposalId;
    if (!isDao) {
      if (b.completedAt) return { tone: 'good' as const, text: 'Complete ✓' };
      const s0 = b.safeTxHash ? safeStatus[b.safeTxHash] : undefined;
      if (s0?.state === 'replaced') return { tone: 'bad' as const, text: 'Rejected in Safe — send again' };
      if (s0?.state === 'failed') return { tone: 'bad' as const, text: 'Safe tx failed — send again' };
      if (s0) return { tone: 'warn' as const, text: safeTxLabel(s0) };
      if (b.submittedAt) return { tone: 'warn' as const, text: 'Sent to Safe — not on-chain yet' };
      if (b.fromTs) return { tone: 'warn' as const, text: 'Sent — looking for it on-chain' };
      return { tone: 'muted' as const, text: 'Not minted' };
    }
    if (pid === null) {
      const s = b.safeTxHash ? safeStatus[b.safeTxHash] : undefined;
      if (s?.state === 'replaced') return { tone: 'bad' as const, text: 'Rejected in Safe — send again' };
      if (s?.state === 'failed') return { tone: 'bad' as const, text: 'Safe tx failed — send again' };
      if (s) return { tone: 'warn' as const, text: safeTxLabel(s) };
      return b.submittedAt ? { tone: 'warn' as const, text: 'Sent to Safe — not on-chain yet' } : { tone: 'muted' as const, text: 'Not proposed' };
    }
    if (b.completedAt) return { tone: 'good' as const, text: 'Complete ✓' };
    const l = live[pid];
    if (!l) return { tone: 'muted' as const, text: '…' };
    if (l.executed) return { tone: 'good' as const, text: 'Minted' };
    if (l.cancelled) return { tone: 'muted' as const, text: 'Cancelled' };
    if (now > l.expiresAt) return { tone: 'muted' as const, text: 'Expired' };
    if (type.approvalsRequired && l.approvals >= type.approvalsRequired) return { tone: 'bad' as const, text: 'Mint failed — retry Execute' };
    return { tone: 'warn' as const, text: `Waiting — ${l.approvals}/${type.approvalsRequired} approvals` };
  };

  // totals
  const sum = (rows: { face: string }[]) => rows.reduce((s, r) => s.add(r.face || '0'), ethers.BigNumber.from(0));
  const totals = current && (() => {
    const done = current.batches.filter(isMinted);
    const mintedRows = done.flatMap((b) => current.rows.slice(b.start, b.end));
    const vids = current.batches.flatMap((_, bi) => batchVoucherIds(current, bi) ?? []);
    const checked = vids.filter((v) => claims[v]);
    return {
      done, mintedRows, total: current.rows.length,
      claimed: checked.filter((v) => claims[v].claimed).length, checked: checked.length, vids: vids.length,
    };
  })();
  const pages = Math.ceil(filtered.length / PAGE);

  return (
    <Card title={`Bulk uploads — what minted & what's ${P.claim.toLowerCase()}`}>
      {dialog}
      <p className="text-xs text-txt-secondary mb-3">
        Every bulk upload is saved in this browser, for this page only ({P.page}). Import batch files (a .zip like the RGST vouchers export, or CSVs),
        {isDao ? ' propose them batch by batch,' : ' mint them batch by batch (one mintBatch transaction each),'} and see which batches minted, each row&apos;s voucher id
        and whether it&apos;s {P.claim.toLowerCase()}. Works with a <b>Safe</b> — nothing waits for the wallet to return a transaction.
      </p>
      {contractWallet && <p className="text-xs text-yellow-300 mb-3">Connected wallet is a contract (Safe): transactions are queued there; this page follows them on-chain.</p>}

      {/* import */}
      <div className="bg-surface-tertiary rounded-lg p-3 mb-3 text-xs space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">Import batch files</span>
          <input type="file" accept=".zip,.csv" multiple className="text-xs" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-txt-secondary">
          One upload per folder, one batch (= one {P.unit}, max {maxBatch} rows) per file. A <code>files.csv</code> with sha256s is checked.
          Amounts are {fungibleType ? 'token units (stored with 18 decimals)' : 'whole numbers'}. Token and dates are taken from the form above each time you {P.verb.toLowerCase()}.
        </p>
        {preview && (
          <div className="border-t border-white/10 pt-2 space-y-2">
            {preview.summary && <pre className="whitespace-pre-wrap text-[11px] text-txt-secondary">{preview.summary.trim()}</pre>}
            {preview.missing.length > 0 && (
              <p className="text-yellow-300">Listed in files.csv but not in the upload (left out): {preview.missing.join(', ')}</p>
            )}
            {preview.groups.map((g, gi) => {
              const on = g.files.filter((f) => f.pick);
              const rows = on.reduce((t, f) => t + f.rows.length, 0);
              const total = on.reduce((t, f) => t.add(f.total), ethers.BigNumber.from(0));
              const bad = on.filter((f) => f.errors.length || f.sha === 'bad');
              const withSha = on.filter((f) => f.sha !== 'none');
              const shaOk = on.filter((f) => f.sha === 'ok').length;
              const setGroup = (patch: Partial<PreviewGroup>) => setPreview((pv) => pv && { ...pv, groups: pv.groups.map((x, i) => (i === gi ? { ...x, ...patch } : x)) });
              const setFile = (fi: number, pick: boolean) => setGroup({ files: g.files.map((x, i) => (i === fi ? { ...x, pick } : x)) });
              return (
                <div key={g.name}>
                  <label className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" checked={g.pick} onChange={(e) => setGroup({ pick: e.target.checked })} />
                    <b>{g.name}</b>
                    <span>{on.length}/{g.files.length} files · {rows} rows · {showFace(type, total)}</span>
                    {withSha.length > 0 && <Badge tone={shaOk === withSha.length ? 'good' : 'warn'}>sha256 {shaOk}/{withSha.length} ✓</Badge>}
                    {bad.length > 0 && <Badge tone="bad">{bad.length} file{bad.length === 1 ? '' : 's'} with problems</Badge>}
                    {g.files.some((f) => f.dup) && (
                      <Badge tone="warn">
                        {g.files.filter((f) => f.dup?.kind === 'same').length} already imported · {g.files.filter((f) => f.dup?.kind === 'similar').length} similar
                      </Badge>
                    )}
                  </label>
                  {g.pick && (
                    <div className="ml-6 mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4">
                      {g.files.map((f, fi) => {
                        const problem = f.sha === 'bad' ? 'sha256 does not match files.csv' : f.errors.slice(0, 2).join('; ');
                        return (
                          <label key={f.file} className={`flex items-start gap-2 py-0.5 ${f.pick ? '' : 'opacity-50 line-through'}`}>
                            <input type="checkbox" className="mt-0.5" checked={f.pick} onChange={(e) => setFile(fi, e.target.checked)} />
                            <span className="break-all">
                              {f.file} <span className="text-txt-secondary">· {f.rows.length} rows · {showFace(type, f.total)}{f.sha === 'ok' ? ' · sha ✓' : ''}</span>
                              {problem && <span className="text-red-300"> · {problem}</span>}
                              {f.dup?.kind === 'same' && <span className="block text-red-300">Already imported — same wallets and amounts as {f.dup.where}</span>}
                              {f.dup?.kind === 'similar' && <span className="block text-yellow-300">Similar to {f.dup.where} — {f.dup.note}</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex gap-2">
              <button className={btnCls} onClick={saveImport}>Save for type #{type.id}</button>
              <button className={btnSecondaryCls} onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* saved uploads */}
      <div className="space-y-1 mb-3">
        {uploads.map((u) => {
          const ids = u.batches.map((b) => b.proposalId);
          const isCur = current?.id === u.id;
          return (
            <div key={u.id} className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs ${isCur ? 'bg-accent/10 border border-accent/40' : 'bg-surface-tertiary'}`}>
              <span className="font-semibold">{u.name}</span>
              <span className="text-txt-secondary">{u.rows.length} rows · {u.batches.length} batch{u.batches.length === 1 ? '' : 'es'}{isDao ? ` (${ids.map((x) => (x === null ? '?' : `#${x}`)).join(', ')})` : ''}</span>
              {(() => {
                const done = u.batches.filter((b) => b.completedAt);
                const rows = done.reduce((t, b) => t + b.end - b.start, 0);
                return <Badge tone={done.length === u.batches.length ? 'good' : done.length ? 'warn' : 'muted'}>{done.length}/{u.batches.length} batches complete · {rows}/{u.rows.length} vouchers</Badge>;
              })()}
              {u.createdAt > 0 && <span className="text-txt-secondary"><UtcTime inline ts={u.createdAt} /></span>}
              <span className="flex-1" />
              <button className={linkBtnCls} onClick={() => open(u)}>{isCur ? 'Re-open' : 'Open'}</button>
              <button className={linkBtnCls} title="CSV, one line per wallet: batch, file, proposal, propose / mint tx, NFT id, claim state"
                onClick={() => downloadRows(isCur && current ? current : u)}>⤓ Download</button>
              <button className={linkBtnCls} onClick={async () => {
                // only the label changes: batches, proposals and minted ids stay as they are
                const name = window.prompt('New name for this upload', u.name)?.trim();
                if (!name || name === u.name) return;
                // rename the latest saved copy, never an older one from this list (would undo progress)
                const fresh = (await listUploads(ctx.chainId, u.dao)).find((x) => x.id === u.id);
                if (!fresh) return;
                await saveUpload({ ...fresh, name });
                if (isCur) setCurrent((c) => (c ? { ...c, name } : c));
                reload();
              }}>Rename</button>
              <button className={`${linkBtnCls} text-red-300`} onClick={async () => { await deleteUpload(u.id); if (isCur) setCurrent(null); reload(); }}>Forget</button>
            </div>
          );
        })}
        {!uploads.length && <p className="text-xs text-txt-secondary">No saved uploads for this type yet. They appear here when you import files or {P.verb.toLowerCase()} a list{isDao ? ', or open one from on-chain below' : ''}.</p>}
      </div>

      {isDao && <div className="flex flex-wrap items-center gap-2 mb-4">
        <input className={`${inputCls} max-w-[10rem]`} value={idText} onChange={(e) => setIdText(e.target.value)} placeholder="Bulk proposal id" onKeyDown={(e) => e.key === 'Enter' && /^\d+$/.test(idText) && openFromChain(Number(idText))} />
        <button className={btnSecondaryCls} disabled={busy || !/^\d+$/.test(idText)} onClick={() => openFromChain(Number(idText))}>Open from on-chain</button>
        <span className="text-xs text-txt-secondary">Loads that proposal and the other batches of the same upload, and saves it here.</span>
      </div>}
      {isDao && recent.length > 0 && (
        <details className="mb-4 text-xs">
          <summary className="cursor-pointer text-txt-secondary">Recent on-chain bulk proposals of this type ({recent.length})</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r.id} className="bg-surface-tertiary rounded px-2 py-1 hover:ring-1 hover:ring-accent" onClick={() => openFromChain(r.id)}>
                #{r.id} · {r.count} · <span className={r.live.executed ? 'text-green-300' : 'text-yellow-300'}>{r.live.executed ? 'minted' : r.live.cancelled ? 'cancelled' : 'not minted'}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      {status && <p className="text-xs text-accent mb-2">{status}</p>}
      {msg && <p className={`text-xs mb-2 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}

      {current && totals && (
        <div className="border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center gap-3 text-xs mb-3">
            <span className="text-sm font-semibold">{current.name}</span>
            {(() => {
              let pr: ProposeParams | null = null;
              try { pr = params(); } catch { /* bad voting window: shown on Propose */ }
              if (!pr) return null;
              return (
                <span className="text-txt-secondary">
                  {P.verb} uses the form above{mode === 'atm-v1' ? '' : `: token ${sameAddr(pr.token, ethers.constants.AddressZero) ? 'native' : ctx.nameOf(pr.token)}`}
                  {' · '}claimable from <b className="text-txt-primary">{pr.startDate > 0 ? <UtcTime inline ts={pr.startDate} /> : 'immediately'}</b>
                  {' · '}expires <b className="text-txt-primary">{pr.expiryDate > 0 ? <UtcTime inline ts={pr.expiryDate} /> : 'never'}</b>
                </span>
              );
            })()}
            <button className={linkBtnCls} disabled={busy} onClick={() => refresh()}>Re-check now</button>
            <button className={linkBtnCls} disabled={busy} title="Forget the saved minted / complete state of this upload and read it all from the chain again" onClick={async () => {
              if (!window.confirm('Rescan this upload from the chain? Saved voucher ids, "complete" marks and claim results are cleared and looked up again.')) return;
              const fresh = clone(current);
              fresh.minted = {};
              fresh.claims = {};
              delete fresh.claimsAt;
              // direct / ATM v1: a batch that was complete is searched again (back 30 days if its send time is unknown)
              fresh.batches = fresh.batches.map(({ completedAt, execTx, voucherIds, ...b }) => (isDao || !completedAt || b.fromTs || b.submittedAt ? b : { ...b, fromTs: Math.floor(Date.now() / 1000) - 30 * 86400 })); // eslint-disable-line @typescript-eslint/no-unused-vars
              missed.current.clear();
              await saveUpload(fresh);
              open(fresh);
            }}>Rescan from chain</button>
            {operator && current.batches.some((b) => (isDao ? b.proposalId === null : !b.completedAt && !b.fromTs) && !b.submittedAt) && (
              <button className={btnCls} disabled={busy} onClick={() => propose()}>
                {P.verb} {current.batches.filter((b) => (isDao ? b.proposalId === null : !b.completedAt && !b.fromTs) && !b.submittedAt).length} remaining batch{current.batches.filter((b) => (isDao ? b.proposalId === null : !b.completedAt && !b.fromTs) && !b.submittedAt).length === 1 ? '' : 'es'}
              </button>
            )}
            {inFlight && (
              <label className="flex items-center gap-2 text-txt-secondary">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                {auto ? <span className="text-accent">Following the chain every {fast ? '3' : '15'}s until the batches in progress finish</span> : 'Follow the chain'}
              </label>
            )}
            {isDao && operator && current.batches.some((b) => b.proposalId !== null && live[b.proposalId] && !live[b.proposalId].executed && !live[b.proposalId].cancelled && !live[b.proposalId].iApproved && now <= live[b.proposalId].expiresAt) && (
              <button className={btnSecondaryCls} disabled={busy} onClick={async () => {
                for (const b of current.batches) {
                  const l = b.proposalId !== null ? live[b.proposalId] : undefined;
                  if (l && !l.executed && !l.cancelled && !l.iApproved && now <= l.expiresAt) await act(b.proposalId as number, 'approve', b.end - b.start);
                }
              }}>Approve all open batches</button>
            )}
          </div>

          {/* batches */}
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs text-left">
              <thead className="text-txt-secondary"><tr><th className="py-1 pr-3">Batch</th><th className="pr-3">File</th><th className="pr-3">Rows</th><th className="pr-3">Vouchers</th><th className="pr-3">Total</th><th className="pr-3">Status</th><th /></tr></thead>
              <tbody>
                {current.batches.map((b, n) => {
                  const st = batchStatus(b);
                  const l = b.proposalId !== null ? live[b.proposalId] : undefined;
                  const isOpen = l && !l.executed && !l.cancelled && now <= l.expiresAt;
                  return (
                    <tr key={n} className="border-t border-white/5">
                      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{n + 1}.{isDao ? ` ${b.proposalId === null ? 'proposal ?' : `#${b.proposalId}`}` : ''}</td>
                      <td className="pr-3 break-all">{b.file ?? '—'}</td>
                      <td className="pr-3">{b.start + 1}–{b.end}</td>
                      <td className="pr-3">{b.end - b.start}</td>
                      <td className="pr-3">{showFace(type, sum(current.rows.slice(b.start, b.end)))}</td>
                      <td className="pr-3">
                        <Badge tone={st.tone}>{st.text}</Badge>{l?.iApproved && <span className="ml-1 text-txt-secondary">you ✓</span>}
                        {b.completedAt && <div className="text-txt-secondary mt-0.5">all {b.end - b.start} minted · <UtcTime inline ts={b.completedAt} /></div>}
                        {/* Safe progress (mainnet): the propose tx while not on-chain, approve / execute while not complete */}
                        {[
                          ...((isDao ? b.proposalId === null : !b.completedAt) && b.safeTxHash && b.safe ? [{ kind: isDao ? 'propose' : 'mint', hash: b.safeTxHash, safe: b.safe }] : []),
                          ...(!b.completedAt ? (b.safeActions || []) : []),
                        ].map((a) => {
                          const s = safeStatus[a.hash];
                          const url = safeTxUrl(ctx.chainId, a.safe, a.hash);
                          if (s?.state === 'executed' && a.kind !== 'propose' && a.kind !== 'mint') return null;
                          return (
                            <div key={a.hash} className="text-txt-secondary mt-0.5">
                              {a.kind}: {s ? safeTxLabel(s) : safeApiSupported(ctx.chainId) ? 'Safe: checking…' : 'queued in Safe'}
                              {url && <> · <a className="text-accent hover:underline" href={url} target="_blank" rel="noreferrer">open in Safe</a></>}
                            </div>
                          );
                        })}
                      </td>
                      <td className="whitespace-nowrap">
                        {(isDao ? b.proposalId === null : !b.completedAt) && operator && (
                          <button className={linkBtnCls} disabled={busy} onClick={() => propose(n)}>{b.submittedAt || (!isDao && b.fromTs) ? 'Send again' : P.verb}</button>
                        )}
                        {b.execTx && <a className={`${linkBtnCls} ml-2`} href={`${ctx.chainId === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'}/tx/${b.execTx}`} target="_blank" rel="noreferrer">mint tx</a>}
                        {b.proposalId === null && !b.submittedAt && !b.completedAt && (isDao || !b.fromTs) && (
                          <button className={`${linkBtnCls} ml-2 text-red-300`} disabled={busy} onClick={() => removeBatch(n)}>Remove</button>
                        )}
                        {isOpen && operator && !l.iApproved && <button className={linkBtnCls} disabled={busy} onClick={() => act(b.proposalId as number, 'approve', b.end - b.start)}>Approve</button>}
                        {isOpen && operator && type.approvalsRequired > 0 && l.approvals >= type.approvalsRequired && (
                          <button className={`${linkBtnCls} ml-2`} disabled={busy} onClick={() => act(b.proposalId as number, 'execute', b.end - b.start)}>Execute (retry)</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {caps && (() => {
              const notProposed = current.batches.filter((b) => (isDao ? b.proposalId === null : !b.completedAt && !b.fromTs) && !b.submittedAt).reduce((t, b) => t + b.end - b.start, 0);
              const notMinted = current.batches.filter((b) => !isMinted(b)).reduce((t, b) => t + b.end - b.start, 0);
              const opShort = caps.op !== null && notProposed > caps.op;
              const nftShort = caps.nft !== null && notMinted > caps.nft;
              const when = (ts: number) => (ts ? ` · resets ${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
              return (
                <div className={`text-xs mt-2 rounded p-2 ${opShort || nftShort ? 'bg-yellow-900/20 border border-yellow-400/30' : 'text-txt-secondary'}`}>
                  <div>
                    Your {isDao ? 'proposal' : 'mint'} cap: <b>{caps.op === null ? 'unlimited' : `${caps.op} vouchers left`}</b>{caps.op !== null && ` (limit ${caps.opLimit} per window${when(caps.opResets)})`}
                    {opShort && <> — not enough for the {notProposed} still to {P.verb.toLowerCase()}. </>}
                    {opShort && <button className={linkBtnCls} disabled={busy} onClick={() => unlimit('op')}>Set my cap to unlimited ({isDao ? 'DAO' : 'VoucherNFT'} admin)</button>}
                  </div>
                  {isDao && <div>
                    VoucherDAO mint cap on VoucherNFT: <b>{caps.nft === null ? 'unlimited' : `${caps.nft} vouchers left`}</b>{caps.nft !== null && ` (limit ${caps.nftLimit} per window${when(caps.nftResets)})`}
                    {nftShort && <> — not enough for the {notMinted} still to mint: those batches will reach quorum and fail. </>}
                    {nftShort && <button className={linkBtnCls} disabled={busy} onClick={() => unlimit('nft')}>Set to unlimited (VoucherNFT admin)</button>}
                  </div>}
                </div>
              );
            })()}
            {isDao && current.batches.some((b) => b.proposalId === null) && (
              <p className="text-xs text-yellow-300 mt-1">
                Batches without a proposal id aren&apos;t on-chain yet. One sent from a Safe shows up once the Safe tx is executed — re-check after that (Propose first checks on-chain, so it never proposes a batch twice).
              </p>
            )}
          </div>

          {/* every row, filtered */}
          <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <input className={`${inputCls} max-w-[16rem]`} placeholder="Search wallet or voucher id…" value={fq} onChange={(e) => setFq(e.target.value)} />
            <select className={`${inputCls} max-w-[16rem]`} value={fBatch} onChange={(e) => setFBatch(e.target.value)}>
              <option value="">All batches ({current.batches.length})</option>
              {current.batches.map((b, i) => (
                <option key={i} value={String(i)}>{i + 1}. {b.file ?? `batch ${i + 1}`}{isDao && b.proposalId !== null ? ` · #${b.proposalId}` : ''} · {b.end - b.start} rows</option>
              ))}
            </select>
            <select className={`${inputCls} max-w-[12rem]`} value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)}>
              <option value="">All statuses</option>
              <option value="minted">Minted</option>
              <option value="notminted">Not minted</option>
              <option value="claimed">{P.claim}</option>
              <option value="unclaimed">Minted, not {P.claim.toLowerCase()}</option>
              <option value="revoked">{mode === 'atm-v1' ? 'Voided' : 'Revoked'}</option>
              <option value="moved">Moved to another wallet</option>
            </select>
            {(fq || fBatch !== '' || fStatus) && <button className={linkBtnCls} onClick={() => { setFq(''); setFBatch(''); setFStatus(''); }}>Clear filters</button>}
            <button className={btnSecondaryCls} disabled={!!status || busy || !totals.vids} onClick={checkClaims}
              title="Read each minted voucher's claim state from the chain now (claimed / revoked ones are final and skipped)">
              Check {P.claim.toLowerCase()} on-chain
            </button>
            <span className="text-txt-secondary">{current.claimsAt ? <>claims checked <UtcTime inline ts={current.claimsAt} /></> : 'claims not checked yet'}</span>
            <span className="text-txt-secondary ml-auto">
              {filtered.length === current.rows.length ? `${current.rows.length} rows` : `${filtered.length} of ${current.rows.length} rows`}
              {claimFilter && !current.claimsAt ? ' · click “Check claims on-chain” for this filter' : ''}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-txt-secondary"><tr><th className="py-1 pr-3">#</th><th className="pr-3">Recipient</th><th className="pr-3">Amount</th><th className="pr-3">Batch</th><th className="pr-3">Minted</th><th className="pr-3">Voucher</th><th>{P.claim}</th></tr></thead>
              <tbody>
                {rowsOnPage.map(({ r, i, b, vid }) => {
                  const st = batchStatus(b);
                  const minted = isMinted(b);
                  const cl = vid ? claims[vid] : undefined;
                  return (
                    <tr key={i} className="border-t border-white/5">
                      <td className="py-1 pr-3 text-txt-secondary">{i + 1}</td>
                      <td className="pr-3 break-all">{ctx.nameOf(r.to)}</td>
                      <td className="pr-3">{showFace(type, r.face)}</td>
                      <td className="pr-3 whitespace-nowrap">{isDao ? (b.proposalId === null ? '?' : `#${b.proposalId}`) : current.batches.indexOf(b) + 1}</td>
                      <td className="pr-3"><Badge tone={minted ? 'good' : st.tone === 'muted' ? 'muted' : 'warn'}>{minted ? 'Yes' : st.tone === 'muted' && st.text !== '…' ? 'No' : 'Pending'}</Badge></td>
                      <td className="pr-3 font-mono">{vid ? `#${vid}` : minted ? <span className="text-txt-secondary">looking up…</span> : '—'}</td>
                      <td>
                        {!vid ? '—' : !cl ? <span className="text-txt-secondary">not checked</span>
                          : cl.revoked ? <Badge tone="bad">{mode === 'atm-v1' ? 'Voided' : 'Revoked'}</Badge>
                          : cl.claimed ? <Badge tone="good">{P.claim}</Badge>
                          : <span>No{cl.owner && !sameAddr(cl.owner, r.to) ? ` · moved → ${ctx.nameOf(cl.owner)}` : ''}</span>}
                      </td>
                    </tr>
                  );
                })}
                {!rowsOnPage.length && <tr><td colSpan={7} className="py-3 text-txt-secondary">No rows match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-3 text-xs mt-2">
              <button className={linkBtnCls} disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
              <span className="text-txt-secondary">Rows {page * PAGE + 1}–{Math.min(filtered.length, page * PAGE + PAGE)} of {filtered.length}</span>
              <button className={linkBtnCls} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          )}

          {/* totals */}
          <div className={`mt-4 rounded-lg p-3 border text-xs space-y-1 ${totals.mintedRows.length === totals.total ? 'border-green-400/40 bg-green-900/20' : 'border-yellow-400/40 bg-yellow-900/20'}`}>
            <div className="text-sm">
              <b>{totals.mintedRows.length} / {totals.total}</b> vouchers minted
              {fungible(type) && <> · {showFace(type, sum(totals.mintedRows))} / {showFace(type, sum(current.rows))}</>}
              {' '}· <b>{totals.done.length} / {current.batches.length}</b> batches
              {totals.vids > 0 && <> · <b>{totals.claimed}</b> claimed{totals.checked < totals.vids && ` (of ${totals.checked} checked)`}</>}
            </div>
            {totals.done.length > 0 && <div className="text-green-300">Minted batches: {totals.done.map((b) => `${isDao ? `#${b.proposalId}` : b.file ?? `batch ${current.batches.indexOf(b) + 1}`} (rows ${b.start + 1}–${b.end})`).join(', ')}</div>}
            {totals.done.length < current.batches.length && (
              <div className="text-yellow-300">
                Not minted: {current.batches.filter((b) => !totals.done.includes(b)).map((b) => `${isDao ? (b.proposalId === null ? '?' : `#${b.proposalId}`) : b.file ?? `batch ${current.batches.indexOf(b) + 1}`} (rows ${b.start + 1}–${b.end}) — ${batchStatus(b).text.toLowerCase()}`).join(', ')}
              </div>
            )}
            {totals.vids > totals.checked && (
              <button className={linkBtnCls} disabled={!!status} onClick={checkClaims}>Check claims on-chain ({totals.vids - totals.checked} not checked)</button>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <button className={btnDangerCls} onClick={() => { work.current++; setCurrent(null); setStatus(null); }}>Close</button>
            {!operator && <span className="text-xs text-txt-secondary self-center">{isDao ? 'Propose / Approve buttons show for this type\'s operators.' : mode === 'direct' ? 'Mint buttons show for this type\'s minters on VoucherNFT.' : 'Mint buttons show for wallets with MINTER_ROLE on ATMVoucher.'} From a Safe, sign in Safe{'{'}Wallet{'}'} and re-check here.</span>}
          </div>
        </div>
      )}
      {!current && uploads.length > 0 && <button className={btnCls} onClick={() => open(uploads[0])}>Open latest upload</button>}
    </Card>
  );
}
