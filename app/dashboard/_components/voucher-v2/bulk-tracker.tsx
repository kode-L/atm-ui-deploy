'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { UtcTime } from '@/components/utc-datetime';
import { DEFAULT_ADMIN_ROLE, TokenStandard, VoucherMode, VoucherType, eventArg, fromUnits, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { Badge, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';
import { MAX_PER_CALL, checkRows, chunk, csvToRows } from './mint-csv';
import { StoredBatch, StoredRow, StoredUpload, deleteUpload, listUploads, newUploadId, saveUpload } from './upload-store';
import { readZip, sha256Hex } from './zip-read';

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
const exec = (vouchers: number) => 300_000 + 250_000 * Math.max(1, vouchers); // same floor as dao-tab execGas

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;
const showFace = (t: VoucherType | undefined, v: ethers.BigNumberish) => (fungible(t) ? fromUnits(v, 18) : String(v));
const idTopic = (id: number) => ethers.utils.hexZeroPad(ethers.utils.hexlify(id), 32);

interface Live { approvals: number; executed: boolean; cancelled: boolean; expiresAt: number; iApproved: boolean }
interface Claim { claimed: boolean; revoked: boolean; owner: string | null }
// what a new proposal uses, from the Bulk mint form
export interface ProposeParams { token: string; startDate: number; expiryDate: number; duration: number }
interface PreviewFile { file: string; rows: StoredRow[]; errors: string[]; sha: 'ok' | 'bad' | 'none'; total: ethers.BigNumber }
interface PreviewGroup { name: string; files: PreviewFile[]; pick: boolean }
interface ProposalMeta { typeId: number; token: string; start: number; expiry: number; to?: string; faces?: string }

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const clone = (u: StoredUpload): StoredUpload => ({ ...u, batches: u.batches.map((b) => ({ ...b })), minted: { ...(u.minted || {}) } });

export default function BulkTracker({ type, focus, version, params }: { type: VoucherType; focus?: BulkFocus | null; version?: number; params: () => ProposeParams }) {
  const ctx = useVoucherV2();
  const dao = ctx.book.contracts.VoucherDAO;
  const [uploads, setUploads] = useState<StoredUpload[]>([]);
  const [current, setCurrent] = useState<StoredUpload | null>(null);
  const [live, setLive] = useState<Record<number, Live>>({});
  const [claims, setClaims] = useState<Record<string, Claim>>({});
  const [operator, setOperator] = useState(false);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<string | null>(null); // lazy work in progress
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [idText, setIdText] = useState('');
  const [recent, setRecent] = useState<{ id: number; count: number; live: Live }[]>([]);
  const work = useRef(0); // bumps to cancel lazy work for a previous upload
  const [preview, setPreview] = useState<{ source: string; summary?: string; groups: PreviewGroup[] } | null>(null);
  const [contractWallet, setContractWallet] = useState(false);
  // immutable proposal fields, so matching batches on-chain reads each proposal once
  const meta = useRef(new Map<number, ProposalMeta>());
  useEffect(() => { meta.current = new Map(); }, [dao, ctx.chainId]);
  const fungibleType = fungible(type);
  const needsId = type.mode === VoucherMode.Reward && (type.tokenStandard === TokenStandard.ERC721 || type.tokenStandard === TokenStandard.ERC1155);

  // a Safe / smart-account: its wallet only queues the tx, so we never wait for a receipt
  useEffect(() => {
    if (!ctx.reader || !ctx.account) return;
    ctx.reader.getCode(ctx.account).then((code) => setContractWallet(!!code && code !== '0x')).catch(() => setContractWallet(false));
  }, [ctx.reader, ctx.account]);

  const reload = useCallback(async () => {
    if (!dao) return [];
    const list = (await listUploads(ctx.chainId, dao)).filter((u) => u.typeId === type.id);
    setUploads(list);
    return list;
  }, [ctx.chainId, dao, type.id]);

  useEffect(() => { reload(); }, [reload, version]);

  const readLive = useCallback(async (ids: number[]) => {
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
    if (!dao || !ctx.reader) return;
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

  useEffect(() => {
    if (!dao || !ctx.reader || !ctx.account) return;
    const d = ctx.read('VoucherDAO');
    (async () => {
      const [admin, op] = await Promise.all([d.hasRole(DEFAULT_ADMIN_ROLE, ctx.account), d.hasRole(await d.typeOperatorRole(type.id), ctx.account)]);
      setOperator(admin || op);
    })().catch(() => setOperator(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, ctx.reader, ctx.account, type.id]);

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
        if (taken.has(id) || m.typeId !== u.typeId || m.token !== u.token.toLowerCase() || m.start !== u.startDate || m.expiry !== u.expiryDate) continue;
        if (m.to === undefined) m.to = ((await d.getBulkMintRecipients(id)) as string[]).map((x) => x.toLowerCase()).join(',');
        const cand = open.filter((b) => toKey(b) === m.to);
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
  const findMinted = async (u: StoredUpload, lv: Record<number, Live>, my: number): Promise<StoredUpload> => {
    const need = u.batches.filter((b) => b.proposalId !== null && lv[b.proposalId]?.executed && !u.minted?.[b.proposalId]);
    if (!need.length || !ctx.reader) return u;
    const provider = ctx.reader;
    const d = ctx.read('VoucherDAO');
    const nft = ctx.read('VoucherNFT');
    const topic = d.interface.getEventTopic('BulkMintExecuted');
    const latest = await provider.getBlockNumber();
    const back = Math.min(1000, latest);
    const [a, b0] = await Promise.all([provider.getBlock(latest), provider.getBlock(latest - back)]);
    const secPerBlock = Math.max(0.1, (a.timestamp - b0.timestamp) / Math.max(1, back));
    // from an hour before it was proposed (or 30 days back for uploads added from on-chain)
    const since = u.createdAt ? Math.max(0, a.timestamp - u.createdAt + 3600) : 30 * 86400;
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
          break;
        }
      }
    }
    if (Object.keys(next.minted!).length !== Object.keys(u.minted || {}).length) await saveUpload(next);
    return next;
  };

  const open = async (u: StoredUpload) => {
    const my = ++work.current;
    setCurrent(u);
    setLive({});
    setClaims({});
    setPage(0);
    setMsg(null);
    try {
      let x = await resolveIds(u, my);
      if (work.current !== my) return;
      setCurrent(x);
      setStatus('Reading batches…');
      const lv = await readLive(x.batches.map((b) => b.proposalId).filter((id): id is number => id !== null));
      if (work.current !== my) return;
      setLive(lv);
      x = await findMinted(x, lv, my);
      if (work.current !== my) return;
      setCurrent(x);
      setStatus(null);
      reload();
    } catch (e: any) {
      if (work.current === my) { setStatus(null); setMsg({ ok: false, text: `On-chain check failed: ${e.message}` }); }
    }
  };

  // re-read approvals / executed (cheap), then voucher ids for anything newly executed
  const refresh = async (quiet = false) => {
    if (!current) return;
    const my = work.current;
    try {
      const lv = await readLive(current.batches.map((b) => b.proposalId).filter((id): id is number => id !== null));
      if (work.current !== my) return;
      setLive(lv);
      const x = await findMinted(current, lv, my);
      if (work.current === my) { setCurrent(x); setStatus(null); }
      if (!quiet) setClaims({}); // re-read claims for the visible page
    } catch (e: any) {
      if (!quiet) setMsg({ ok: false, text: e.message });
    }
  };

  // 3. claim state, only for the rows on screen
  const rowsOnPage = useMemo(() => {
    if (!current) return [];
    return current.rows.map((r, i) => {
      const b = current.batches.find((x) => i >= x.start && i < x.end)!;
      const vid = b.proposalId !== null ? current.minted?.[b.proposalId]?.[i - b.start] : undefined;
      return { r, i, b, vid };
    }).slice(page * PAGE, page * PAGE + PAGE);
  }, [current, page]);

  useEffect(() => {
    const want = rowsOnPage.map((x) => x.vid).filter((v): v is string => !!v && !claims[v]);
    if (!want.length || !ctx.reader) return;
    let stop = false;
    const nft = ctx.read('VoucherNFT');
    Promise.all(want.map(async (vid) => {
      const [v, owner] = await Promise.all([nft.vouchers(vid), nft.ownerOf(vid).catch(() => null)]);
      return [vid, { claimed: v.claimed, revoked: v.revoked, owner }] as const;
    })).then((res) => { if (!stop) setClaims((c) => ({ ...c, ...Object.fromEntries(res) })); }).catch(() => {});
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsOnPage, claims, ctx.reader]);

  const checkAllClaims = async () => {
    if (!current) return;
    const nft = ctx.read('VoucherNFT');
    const vids = Object.values(current.minted || {}).flat();
    setStatus(`Checking claims for ${vids.length} vouchers…`);
    const out: Record<string, Claim> = {};
    for (let i = 0; i < vids.length; i += 25) {
      await Promise.all(vids.slice(i, i + 25).map(async (vid) => {
        const [v, owner] = await Promise.all([nft.vouchers(vid), nft.ownerOf(vid).catch(() => null)]);
        out[vid] = { claimed: v.claimed, revoked: v.revoked, owner };
      }));
      setStatus(`Checking claims… ${Math.min(i + 25, vids.length)}/${vids.length}`);
    }
    setClaims((c) => ({ ...c, ...out }));
    setStatus(null);
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
    if (focus && ctx.reader) openFromChain(focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, ctx.reader]);

  // waiting for a Safe: re-read every 15s until every batch has executed
  useEffect(() => {
    if (!auto || !current) return;
    const t = setInterval(() => refresh(true), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, current]);

  useEffect(() => () => { work.current++; }, []);

  const act = async (pid: number, what: 'approve' | 'execute', vouchers: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const lv = live[pid];
      const reaches = lv && type.approvalsRequired > 0 && lv.approvals + 1 >= type.approvalsRequired;
      const gas = what === 'execute' || reaches ? exec(vouchers) : undefined;
      const rc = await sendDao(`DAO: ${what} bulk #${pid}`, what === 'approve' ? 'approveBulkMint' : 'executeBulkMint', [pid], gas ? { gasLimit: gas } : {});
      setMsg({ ok: true, text: rc ? `${what === 'approve' ? 'Approved' : 'Executed'} batch #${pid}` : `Sent "${what} batch #${pid}" to the Safe — sign & execute it there, then re-check.` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      setTimeout(() => refresh(true), 2500);
    }
  };

  // ---- propose batches from an upload ----

  // A Safe only queues a tx and answers with its own hash, which never appears on-chain — ethers'
  // sendTransaction (and so ctx.send) would poll for it forever. Send unchecked; the result is read
  // from the chain afterwards. Returns null for a contract wallet, else the receipt.
  const sendDao = async (label: string, method: string, args: any[], overrides: { gasLimit?: number }) => {
    const c = ctx.write('VoucherDAO');
    if (!contractWallet) return ctx.send(label, c, method, args, overrides);
    const tx = await c.populateTransaction[method](...args, overrides);
    const signer = c.signer as ethers.providers.JsonRpcSigner;
    if (typeof signer.sendUncheckedTransaction === 'function') await signer.sendUncheckedTransaction(tx);
    else await signer.sendTransaction(tx);
    return null;
  };

  const proposeBatch = async (u: StoredUpload, idx: number, pr: ProposeParams): Promise<StoredUpload> => {
    const b = u.batches[idx];
    const rows = u.rows.slice(b.start, b.end);
    const args = [type.id, rows.map((r) => r.to), rows.map((r) => r.face), u.startDate, u.expiryDate, u.token, rows.map((r) => r.tokenId || '0'), pr.duration];
    // at quorum 1 the proposal mints at once: keep the gas floor (see dao-tab execGas)
    const gas = type.approvalsRequired <= 1 ? { gasLimit: exec(rows.length) } : {};
    const next = clone(u);
    const rc = await sendDao(`DAO: propose bulk mint ${b.file ?? `batch ${idx + 1}`} (${rows.length}) type ${type.id}`, 'proposeBulkMint', args, gas);
    if (!rc) next.batches[idx].submittedAt = Math.floor(Date.now() / 1000); // queued in the Safe: matched on-chain later
    else {
      try { next.batches[idx].proposalId = Number(eventArg(rc, ctx.read('VoucherDAO'), 'BulkMintProposed', 'proposalId').toString()); } catch { /* matched on-chain later */ }
    }
    await saveUpload(next);
    return next;
  };

  // propose the given batches one by one (all not yet proposed when `only` is omitted)
  const propose = async (only?: number) => {
    if (!current) return;
    const my = work.current;
    setBusy(true);
    setMsg(null);
    let x = current;
    let at = '';
    try {
      const pr = params();
      // already on-chain (Safe tx executed meanwhile, another admin)? then don't propose it twice
      x = await resolveIds(x, my);
      setCurrent(x);
      const todo = x.batches.map((_, i) => i).filter((i) => (only === undefined || i === only) && x.batches[i].proposalId === null && (only !== undefined || !x.batches[i].submittedAt));
      if (!todo.length) { setMsg({ ok: true, text: only === undefined ? 'Every batch is already proposed.' : 'That batch is already on-chain.' }); return; }
      if (only !== undefined && x.batches[only].submittedAt && !window.confirm('This batch was already sent to the Safe and is not on-chain yet. Send it again? (Reject the old one in Safe{Wallet} if you do.)')) return;
      const n = todo.reduce((s2, i) => s2 + x.batches[i].end - x.batches[i].start, 0);
      if (todo.length > 1 && !window.confirm(`Propose ${todo.length} batches (${n} vouchers) for voucher type #${type.id}? The wallet asks once per batch.${contractWallet ? ' From a Safe each one is queued there to sign and execute.' : ''}`)) return;
      for (const [k, i] of todo.entries()) {
        if (work.current !== my) break;
        at = x.batches[i].file ?? `batch ${i + 1}`;
        setStatus(`Proposing ${k + 1}/${todo.length}: ${at}…`);
        x = await proposeBatch(x, i, pr);
        setCurrent(x);
      }
      setMsg({ ok: true, text: contractWallet ? `Sent ${todo.length} batch${todo.length === 1 ? '' : 'es'} to the Safe. Sign & execute there; they show up here once on-chain (tick re-check).` : `Proposed ${todo.length} batch${todo.length === 1 ? '' : 'es'}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: `${at ? `Stopped at ${at}: ` : ''}${e.message}${at ? ' — earlier batches are saved; click Propose again to continue.' : ''}` });
    } finally {
      setBusy(false);
      setStatus(null);
      if (work.current === my) open(x);
    }
  };

  // ---- import batch files (zip or CSVs) ----

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setMsg(null);
    setPreview(null);
    try {
      const files: { path: string; bytes: Uint8Array }[] = [];
      for (const f of Array.from(list)) {
        if (/\.zip$/i.test(f.name)) files.push(...(await readZip(f)));
        else files.push({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
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
      const groups = new Map<string, PreviewFile[]>();
      for (const f of files.filter((x) => /\.csv$/i.test(x.path) && x !== index)) {
        const rel = root && f.path.startsWith(root) ? f.path.slice(root.length) : f.path;
        const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : 'files';
        const name = rel.split('/').pop() as string;
        const { rows, errors } = checkRows(csvToRows(dec.decode(f.bytes)), fungibleType, needsId);
        const stored = rows.map((r) => ({ to: r.to, face: fungibleType ? ethers.utils.parseUnits(r.amount, 18).toString() : r.amount, tokenId: r.tokenId || '0' }));
        const want = shaOf.get(rel);
        const sha = !want ? 'none' : (await sha256Hex(f.bytes)) === want ? 'ok' : 'bad';
        if (!rows.length && !errors.length) errors.push('no rows');
        const total = stored.reduce((t, r) => t.add(r.face), ethers.BigNumber.from(0));
        groups.set(folder, [...(groups.get(folder) || []), { file: name, rows: stored, errors, sha, total }]);
      }
      if (!groups.size) throw new Error('No CSV batch files found');
      const source = list.length === 1 ? list[0].name : `${list.length} files`;
      setPreview({
        source, summary: summary ? dec.decode(summary.bytes) : undefined,
        groups: Array.from(groups.entries()).sort(([a], [b]) => natural(a, b)).map(([name, fs]) => ({ name, files: fs.sort((a, b) => natural(a.file, b.file)), pick: true })),
      });
    } catch (e: any) {
      setMsg({ ok: false, text: `Import failed: ${e.message}` });
    }
  };

  const saveImport = async () => {
    if (!preview || !dao) return;
    try {
      const pr = params();
      const picked = preview.groups.filter((g) => g.pick);
      if (!picked.length) throw new Error('Tick at least one folder');
      const bad = picked.flatMap((g) => g.files.filter((f) => f.errors.length || f.sha === 'bad').map((f) => `${g.name}/${f.file}`));
      if (bad.length) throw new Error(`Fix these files first: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`);
      const existing = await listUploads(ctx.chainId, dao);
      let first: StoredUpload | null = null;
      for (const g of picked) {
        const name = `${preview.source} · ${g.name}`;
        if (existing.some((u) => u.name === name) && !window.confirm(`"${name}" was imported before. Import it again as a separate upload?`)) continue;
        const rows: StoredRow[] = [];
        const batches: StoredBatch[] = [];
        for (const f of g.files) {
          const parts = chunk(f.rows, MAX_PER_CALL); // a file over the per-proposal limit becomes several batches
          parts.forEach((part, k) => {
            batches.push({ start: rows.length, end: rows.length + part.length, proposalId: null, file: parts.length > 1 ? `${f.file} (${k + 1}/${parts.length})` : f.file });
            rows.push(...part);
          });
        }
        const u: StoredUpload = {
          id: newUploadId(), chainId: ctx.chainId, dao: dao.toLowerCase(), typeId: type.id, token: pr.token,
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

  if (!dao) return null;
  const now = Math.floor(Date.now() / 1000);

  const batchStatus = (b: StoredBatch) => {
    const pid = b.proposalId;
    if (pid === null) return b.submittedAt ? { tone: 'warn' as const, text: 'Sent to Safe — not on-chain yet' } : { tone: 'muted' as const, text: 'Not proposed' };
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
    const done = current.batches.filter((b) => b.proposalId !== null && live[b.proposalId]?.executed);
    const mintedRows = done.flatMap((b) => current.rows.slice(b.start, b.end));
    const vids = Object.values(current.minted || {}).flat();
    const checked = vids.filter((v) => claims[v]);
    return {
      done, mintedRows, total: current.rows.length,
      claimed: checked.filter((v) => claims[v].claimed).length, checked: checked.length, vids: vids.length,
    };
  })();
  const pages = current ? Math.ceil(current.rows.length / PAGE) : 0;

  return (
    <Card title="Bulk uploads — what minted & what's claimed">
      <p className="text-xs text-txt-secondary mb-3">
        Every bulk upload is saved in this browser. Import batch files (a .zip like the RGST vouchers export, or CSVs), propose them batch by batch,
        and see which batches minted, each row&apos;s voucher id and whether it&apos;s claimed. Works with a <b>Safe</b> — nothing waits for the wallet to return a transaction.
      </p>
      {contractWallet && <p className="text-xs text-yellow-300 mb-3">Connected wallet is a contract (Safe): transactions are queued there; this page follows them on-chain.</p>}

      {/* import */}
      <div className="bg-surface-tertiary rounded-lg p-3 mb-3 text-xs space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">Import batch files</span>
          <input type="file" accept=".zip,.csv" multiple className="text-xs" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-txt-secondary">
          One upload per folder, one batch (= one proposal, max {MAX_PER_CALL} rows) per file. A <code>files.csv</code> with sha256s is checked.
          Amounts are {fungibleType ? 'token units (stored with 18 decimals)' : 'whole numbers'}. Payout token and dates come from the form above and are fixed for the upload.
        </p>
        {preview && (
          <div className="border-t border-white/10 pt-2 space-y-2">
            {preview.summary && <pre className="whitespace-pre-wrap text-[11px] text-txt-secondary">{preview.summary.trim()}</pre>}
            {preview.groups.map((g, gi) => {
              const rows = g.files.reduce((t, f) => t + f.rows.length, 0);
              const total = g.files.reduce((t, f) => t.add(f.total), ethers.BigNumber.from(0));
              const bad = g.files.filter((f) => f.errors.length || f.sha === 'bad');
              const shaOk = g.files.filter((f) => f.sha === 'ok').length;
              return (
                <div key={g.name}>
                  <label className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" checked={g.pick} onChange={(e) => setPreview((pv) => pv && { ...pv, groups: pv.groups.map((x, i) => (i === gi ? { ...x, pick: e.target.checked } : x)) })} />
                    <b>{g.name}</b>
                    <span>{g.files.length} files · {rows} rows · {showFace(type, total)}</span>
                    {shaOk > 0 && <Badge tone={shaOk === g.files.length ? 'good' : 'warn'}>sha256 {shaOk}/{g.files.length} ✓</Badge>}
                    {bad.length > 0 && <Badge tone="bad">{bad.length} file{bad.length === 1 ? '' : 's'} with problems</Badge>}
                  </label>
                  {bad.map((f) => (
                    <div key={f.file} className="text-red-300 ml-6 break-all">{f.file}: {f.sha === 'bad' ? 'sha256 does not match files.csv. ' : ''}{f.errors.slice(0, 3).join('; ')}</div>
                  ))}
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
              <span className="text-txt-secondary">{u.rows.length} rows · {u.batches.length} batch{u.batches.length === 1 ? '' : 'es'} ({ids.map((x) => (x === null ? '?' : `#${x}`)).join(', ')})</span>
              {u.createdAt > 0 && <span className="text-txt-secondary"><UtcTime inline ts={u.createdAt} /></span>}
              <span className="flex-1" />
              <button className={linkBtnCls} onClick={() => open(u)}>{isCur ? 'Re-open' : 'Open'}</button>
              <button className={`${linkBtnCls} text-red-300`} onClick={async () => { await deleteUpload(u.id); if (isCur) setCurrent(null); reload(); }}>Forget</button>
            </div>
          );
        })}
        {!uploads.length && <p className="text-xs text-txt-secondary">No saved uploads for this type yet. They appear here when you propose a bulk mint, or open one from on-chain below.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input className={`${inputCls} max-w-[10rem]`} value={idText} onChange={(e) => setIdText(e.target.value)} placeholder="Bulk proposal id" onKeyDown={(e) => e.key === 'Enter' && /^\d+$/.test(idText) && openFromChain(Number(idText))} />
        <button className={btnSecondaryCls} disabled={busy || !/^\d+$/.test(idText)} onClick={() => openFromChain(Number(idText))}>Open from on-chain</button>
        <span className="text-xs text-txt-secondary">Loads that proposal and the other batches of the same upload, and saves it here.</span>
      </div>
      {recent.length > 0 && (
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
            <span className="text-txt-secondary">
              token {sameAddr(current.token, ethers.constants.AddressZero) ? 'native' : ctx.nameOf(current.token)}
              {current.startDate > 0 && <> · claimable from <UtcTime inline ts={current.startDate} /></>}
              {current.expiryDate > 0 && <> · expires <UtcTime inline ts={current.expiryDate} /></>}
            </span>
            <button className={linkBtnCls} disabled={busy} onClick={() => refresh()}>Re-check now</button>
            {operator && current.batches.some((b) => b.proposalId === null && !b.submittedAt) && (
              <button className={btnCls} disabled={busy} onClick={() => propose()}>
                Propose {current.batches.filter((b) => b.proposalId === null && !b.submittedAt).length} remaining batch{current.batches.filter((b) => b.proposalId === null && !b.submittedAt).length === 1 ? '' : 'es'}
              </button>
            )}
            {totals.done.length < current.batches.length && (
              <label className="flex items-center gap-2 text-txt-secondary">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Re-check every 15s (waiting for a Safe)
              </label>
            )}
            {operator && current.batches.some((b) => b.proposalId !== null && live[b.proposalId] && !live[b.proposalId].executed && !live[b.proposalId].cancelled && !live[b.proposalId].iApproved && now <= live[b.proposalId].expiresAt) && (
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
                      <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{n + 1}. {b.proposalId === null ? 'proposal ?' : `#${b.proposalId}`}</td>
                      <td className="pr-3 break-all">{b.file ?? '—'}</td>
                      <td className="pr-3">{b.start + 1}–{b.end}</td>
                      <td className="pr-3">{b.end - b.start}</td>
                      <td className="pr-3">{showFace(type, sum(current.rows.slice(b.start, b.end)))}</td>
                      <td className="pr-3"><Badge tone={st.tone}>{st.text}</Badge>{l?.iApproved && <span className="ml-1 text-txt-secondary">you ✓</span>}</td>
                      <td className="whitespace-nowrap">
                        {b.proposalId === null && operator && (
                          <button className={linkBtnCls} disabled={busy} onClick={() => propose(n)}>{b.submittedAt ? 'Send again' : 'Propose'}</button>
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
            {current.batches.some((b) => b.proposalId === null) && (
              <p className="text-xs text-yellow-300 mt-1">
                Batches without a proposal id aren&apos;t on-chain yet. One sent from a Safe shows up once the Safe tx is executed — re-check after that (Propose first checks on-chain, so it never proposes a batch twice).
              </p>
            )}
          </div>

          {/* every row */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-txt-secondary"><tr><th className="py-1 pr-3">#</th><th className="pr-3">Recipient</th><th className="pr-3">Amount</th><th className="pr-3">Batch</th><th className="pr-3">Minted</th><th className="pr-3">Voucher</th><th>Claimed</th></tr></thead>
              <tbody>
                {rowsOnPage.map(({ r, i, b, vid }) => {
                  const st = batchStatus(b);
                  const minted = st.text === 'Minted';
                  const cl = vid ? claims[vid] : undefined;
                  return (
                    <tr key={i} className="border-t border-white/5">
                      <td className="py-1 pr-3 text-txt-secondary">{i + 1}</td>
                      <td className="pr-3 break-all">{ctx.nameOf(r.to)}</td>
                      <td className="pr-3">{showFace(type, r.face)}</td>
                      <td className="pr-3 whitespace-nowrap">{b.proposalId === null ? '?' : `#${b.proposalId}`}</td>
                      <td className="pr-3"><Badge tone={minted ? 'good' : st.tone === 'muted' ? 'muted' : 'warn'}>{minted ? 'Yes' : st.tone === 'muted' && st.text !== '…' ? 'No' : 'Pending'}</Badge></td>
                      <td className="pr-3 font-mono">{vid ? `#${vid}` : minted ? <span className="text-txt-secondary">looking up…</span> : '—'}</td>
                      <td>
                        {!vid ? '—' : !cl ? <span className="text-txt-secondary">…</span>
                          : cl.revoked ? <Badge tone="bad">Revoked</Badge>
                          : cl.claimed ? <Badge tone="good">Claimed</Badge>
                          : <span>No{cl.owner && !sameAddr(cl.owner, r.to) ? ` · moved → ${ctx.nameOf(cl.owner)}` : ''}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-3 text-xs mt-2">
              <button className={linkBtnCls} disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
              <span className="text-txt-secondary">Rows {page * PAGE + 1}–{Math.min(current.rows.length, page * PAGE + PAGE)} of {current.rows.length}</span>
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
            {totals.done.length > 0 && <div className="text-green-300">Minted batches: {totals.done.map((b) => `#${b.proposalId} (rows ${b.start + 1}–${b.end})`).join(', ')}</div>}
            {totals.done.length < current.batches.length && (
              <div className="text-yellow-300">
                Not minted: {current.batches.filter((b) => !totals.done.includes(b)).map((b) => `${b.proposalId === null ? '?' : `#${b.proposalId}`} (rows ${b.start + 1}–${b.end}) — ${batchStatus(b).text.toLowerCase()}`).join(', ')}
              </div>
            )}
            {totals.vids > totals.checked && (
              <button className={linkBtnCls} disabled={!!status} onClick={checkAllClaims}>Check claims for all {totals.vids} vouchers</button>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <button className={btnDangerCls} onClick={() => { work.current++; setCurrent(null); setStatus(null); }}>Close</button>
            {!operator && <span className="text-xs text-txt-secondary self-center">Approve buttons show for this type&apos;s operators. From a Safe, approve in Safe{'{'}Wallet{'}'} and re-check here.</span>}
          </div>
        </div>
      )}
      {!current && uploads.length > 0 && <button className={btnCls} onClick={() => open(uploads[0])}>Open latest upload</button>}
    </Card>
  );
}
