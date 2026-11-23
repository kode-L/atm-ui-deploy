'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '@/components/confirm-dialog';
import { ethers } from 'ethers';
import { Inbox, RefreshCw } from 'lucide-react';
import Card from '@/components/card';
import { UtcTime } from '@/components/utc-datetime';
import { CopyButton } from '@/components/tx-status';
import { ARTIFACTS, isAddr, sameAddr, short } from '@/lib/contracts/acl';
import { AddrRow, Badge, ControlledAction, Ctx, WalletStatusBadge, btnCls, btnSecondaryCls, inputCls } from './shared';

// ATMAccessControlDAO, read only through its own enumerable views — no event scanning:
//   proposals 1..proposalCount via getProposal(id); "waiting for you" via pendingProposals(wallet);
//   canApprove(id) gives the exact reason an approval would fail right now.
// Safe-wallet change requests are a mapping by protected wallet, so candidates are every wallet
// that appears in a DAO proposal (that's how wallets become protected), you, and any wallet you
// look up — each read live with safeWalletRequests(wallet).
const KIND = ['Protection', 'Move up'];
const STATUS: Record<number, [string, 'warn' | 'good' | 'muted' | 'bad']> = {
  1: ['pending', 'warn'], 2: ['approved', 'good'], 3: ['cancelled', 'muted'], 4: ['rejected', 'bad'],
};
const SHOWN = 30;
const ACL_VIEW_ABI = [
  'function isProtected(address) view returns (bool)',
  'function isFrozen(address) view returns (bool)',
  'function safeWalletOf(address) view returns (address)',
];

interface P { id: number; wallet: string; kind: number; status: number; createdAt: number; bySafe: boolean; safeWallet: string; fromSafe: string; can?: [boolean, string] }
// who approves: the wallet when S2 asked (move-up started by the safe wallet), else the safe wallet
const approver = (p: P) => (p.bySafe ? p.wallet : p.safeWallet);
const requester = (p: P) => (p.bySafe ? p.safeWallet : p.wallet);
interface Req { wallet: string; newSafe: string; currentSafe: string; approvals: number; threshold: number; nonce: number; mine: boolean }

export default function DaoRequests({ ctx }: { ctx: Ctx }) {
  const dao = ctx.s.dao?.address || '';
  const acl = ctx.s.acl?.address || '';
  const [info, setInfo] = useState<{ owner: string; paused: boolean; threshold: number; count: number; verifier: boolean; voteOn: boolean } | null>(null);
  const [mine, setMine] = useState<P[]>([]);
  const [all, setAll] = useState<P[]>([]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [lookups, setLookups] = useState<string[]>([]);
  const [lookup, setLookup] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [rev, setRev] = useState(0);

  const load = useCallback(async () => {
    setErr('');
    if (!ctx.provider || !isAddr(dao)) return;
    setLoading(true);
    try {
      const d = new ethers.Contract(dao, ARTIFACTS.ATMAccessControlDAO.abi, ctx.provider);
      const a = isAddr(acl) ? new ethers.Contract(acl, ACL_VIEW_ABI, ctx.provider) : null;
      const [owner, paused, threshold, n, verifier, voteOn] = await Promise.all([
        d.owner(), d.paused(), d.verifierThreshold(), d.proposalCount(),
        ctx.me ? d.isVerifier(ctx.me).catch(() => false) : Promise.resolve(false),
        d.verifierVoteEnabled().catch(() => true),
      ]);
      const total = n.toNumber();
      const toP = (id: number, p: any): P => ({
        id, wallet: p.wallet, kind: Number(p.kind), status: Number(p.status), createdAt: Number(p.createdAt), bySafe: !!p.bySafe, safeWallet: p.safeWallet, fromSafe: p.fromSafe,
      });
      const ids = Array.from({ length: Math.min(SHOWN, total) }, (_, i) => total - i);
      const list = await Promise.all(ids.map(async (id) => toP(id, await d.getProposal(id))));
      // approvals waiting for the connected wallet, with the reason each would fail right now
      let waiting: P[] = [];
      if (ctx.me) {
        const [pIds, items] = await d.pendingProposals(ctx.me);
        waiting = await Promise.all(pIds.map(async (id: ethers.BigNumber, i: number) => {
          const p = toP(id.toNumber(), items[i]);
          const [ok, reason] = await d.canApprove(id);
          return { ...p, can: [ok, reason] as [boolean, string] };
        }));
      }
      // safe-wallet change requests: every wallet seen in DAO proposals + you + looked-up wallets
      const cands = Array.from(new Set([ctx.me, ...lookups, ...list.map((p) => p.wallet)].filter(isAddr).map((x) => ethers.utils.getAddress(x))));
      const reqList = (await Promise.all(cands.map(async (w) => {
        const r = await d.safeWalletRequests(w);
        if (!r.active) return null;
        const voted = ctx.me ? await d.hasApprovedSafeWallet(w, r.nonce, ctx.me) : false;
        return { wallet: w, newSafe: r.newSafeWallet, currentSafe: r.currentSafeWallet, approvals: r.approvals.toNumber(), threshold: r.threshold.toNumber(), nonce: r.nonce.toNumber(), mine: voted } as Req;
      }))).filter(Boolean) as Req[];
      setInfo({ owner, paused, threshold: threshold.toNumber(), count: total, verifier, voteOn });
      setAll(list); setMine(waiting); setReqs(reqList);
    } catch (e: any) {
      setErr(e?.reason || e?.message || String(e));
    } finally { setLoading(false); }
  }, [ctx.provider, dao, acl, ctx.me, lookups]);
  useEffect(() => { load(); }, [load, rev, ctx.s]);

  const write = () => new ethers.Contract(dao, ARTIFACTS.ATMAccessControlDAO.abi, ctx.signer!);
  const act = async (label: string, fn: (c: ethers.Contract) => Promise<ethers.ContractTransaction>) => {
    const rc = await ctx.run(`ACL DAO: ${label}`, () => fn(write()));
    if (rc) setRev((x) => x + 1);
  };
  const isOwner = sameAddr(ctx.me, info?.owner);
  const describe = (p: P) => p.kind === 0
    ? `Protect ${p.wallet} (payouts go to its safe wallet ${p.safeWallet})`
    : `Move ${p.wallet} from restricted safe wallet ${p.fromSafe} to ${p.safeWallet} (payouts then go to it)${p.bySafe ? ' — asked by the new safe wallet' : ''}`;
  const request = (p: P) => [
    `ACL DAO request #${p.id} on ${dao}`,
    describe(p),
    `Approver: ${approver(p)}${p.bySafe ? ' (the wallet itself)' : ' (safe wallet)'}`,
    `Approve: ATMAccessControlDAO.approveProposal(${p.id}) from ${approver(p)}`,
  ].join('\n');

  if (!isAddr(dao)) {
    return <Card title="ACL DAO requests"><p className="text-xs text-txt-secondary">No ACL DAO on this network yet — deploy it in <strong>2. ACL DAO</strong> and link it in <strong>3. Link in ACL</strong>.</p></Card>;
  }

  return (
    <Card icon={<Inbox className="w-5 h-5 text-accent" />}
      title={<span>ACL DAO requests <span className="text-sm text-txt-secondary font-normal">· {info ? `${info.count} total${info.paused ? ' · PAUSED' : ''} · verifier threshold ${info.threshold}` : '…'}</span></span>}>
      <div className="space-y-4">
        <p className="text-xs text-txt-secondary">
          Everything here is read from the DAO contract itself (<code>getProposal</code>, <code>pendingProposals</code>, <code>canApprove</code>,
          <code> safeWalletRequests</code>) — connect the approver wallet and approve straight from the chain.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-txt-secondary">Your wallet:</span>
          {!ctx.me ? <span className="text-txt-secondary">not connected</span> : <>
            {mine.length > 0 ? <Badge tone="warn">{mine.length} waiting for your approval</Badge> : <Badge tone="muted">nothing waiting for you</Badge>}
            {info?.verifier && <Badge tone="good">active verifier</Badge>}
            {isOwner && <Badge tone="good">DAO owner</Badge>}
          </>}
          <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload from chain" onClick={() => setRev((x) => x + 1)}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {info && <AddrRow ctx={ctx} label="DAO owner" address={info.owner} name="" />}
        {info?.paused && <p className="text-xs text-yellow-300">The DAO is paused: approvals and new requests revert; reject and cancel still work. Only the owner can unpause.</p>}
        {err && <p className="text-xs text-red-300">{err}</p>}

        {/* waiting for the connected safe wallet */}
        {mine.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-semibold">Waiting for your approval</div>
            {mine.map((p) => (
              <div key={p.id} className="rounded-lg border border-yellow-400/30 p-3 space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-txt-secondary">#{p.id}</span>
                  <Badge tone="accent">{KIND[p.kind] ?? p.kind}</Badge>
                  <span className="flex-1 min-w-[240px] break-all">{describe(p)}</span>
                  <button className={btnCls} disabled={!p.can?.[0]} title={p.can?.[0] ? '' : p.can?.[1]} onClick={() => act(`approve request #${p.id} (${KIND[p.kind]} for ${short(p.wallet)})`, (c) => c.approveProposal(p.id))}>Approve</button>
                  <button className={btnSecondaryCls} onClick={async () => (await confirmDialog({ title: `Reject request #${p.id}?`, details: [{ label: 'DAO', value: dao, copy: dao, mono: true }, { label: 'Request', value: `${KIND[p.kind] ?? p.kind}: ${describe(p)}` }, { label: 'Wallet', value: p.wallet, copy: p.wallet, mono: true }], warning: "A rejected request can't be approved later.", danger: true, confirmLabel: 'Reject' })) && act(`reject request #${p.id}`, (c) => c.rejectProposal(p.id))}>Reject</button>
                </div>
                <div className="flex flex-wrap items-center gap-2"><span className="text-txt-secondary">Wallet now:</span><WalletStatusBadge ctx={ctx} wallet={p.wallet} compact /></div>
                {p.can && !p.can[0] && <p className="text-red-300">Can&apos;t approve right now: {p.can[1]}</p>}
              </div>
            ))}
          </div>
        )}

        {/* all requests */}
        <div className="space-y-1.5">
          <div className="text-sm font-semibold">Latest requests</div>
          {all.length === 0 && !loading && <p className="text-xs text-txt-secondary">No requests yet.</p>}
          {all.map((p) => {
            const [label, tone] = STATUS[p.status] ?? [`status ${p.status}`, 'muted'];
            const pending = p.status === 1;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-b border-white/5 pb-1.5">
                <span className="font-mono text-txt-secondary">#{p.id}</span>
                <Badge tone={tone}>{label}</Badge>
                <Badge tone="accent">{KIND[p.kind] ?? p.kind}</Badge>
                <span className="flex-1 min-w-[240px] break-all">{describe(p)}</span>
                <span className="text-txt-secondary"><UtcTime inline ts={p.createdAt} /></span>
                {pending && <span className="text-txt-secondary">approver {sameAddr(approver(p), ctx.me) ? <Badge tone="good">you</Badge> : short(approver(p))}</span>}
                {pending && <WalletStatusBadge ctx={ctx} wallet={p.wallet} compact />}
                {pending && <CopyButton text={request(p)} label="Copy request" title="Copy what the approver needs to approve" />}
                {pending && (sameAddr(ctx.me, requester(p)) || isOwner) && (
                  <button className={btnSecondaryCls} onClick={async () => (await confirmDialog({ title: `Cancel request #${p.id}?`, details: [{ label: 'DAO', value: dao, copy: dao, mono: true }, { label: 'Request', value: `${KIND[p.kind] ?? p.kind}: ${describe(p)}` }, { label: 'Wallet', value: p.wallet, copy: p.wallet, mono: true }], danger: true, confirmLabel: 'Cancel request', cancelLabel: 'Keep it' })) && act(`cancel request #${p.id}`, (c) => c.cancelProposal(p.id))}>Cancel</button>
                )}
              </div>
            );
          })}
        </div>

        <StartRequest ctx={ctx} dao={dao} act={act} />

        {/* verifier votes */}
        <div className="space-y-2">
          <div className="text-sm font-semibold flex items-center gap-2">Safe-wallet change votes (verifiers) {info && (info.voteOn ? <Badge tone="good">on · {info.threshold} votes</Badge> : <Badge tone="muted">off</Badge>)}</div>
          {info && !info.voteOn && <p className="text-xs text-txt-secondary">The verifier vote is switched off: protected wallets can&apos;t propose a new safe wallet and verifiers can&apos;t vote. Cancelling an old request still works. The DAO owner can switch it on below.</p>}
          {info && (
            <ControlledAction ctx={ctx} title={info.voteOn ? 'Switch verifier vote off' : 'Switch verifier vote on'} contractName="ATMAccessControlDAO proxy" target={dao} controller={info.owner}
              kind="call" data={new ethers.utils.Interface(ARTIFACTS.ATMAccessControlDAO.abi).encodeFunctionData('setVerifierVoteEnabled', [!info.voteOn])}
              confirm={info.voteOn ? undefined : 'Switch the verifier vote on? Protected wallets can then propose a new safe wallet and verifiers vote on it.'} />
          )}
          <p className="text-xs text-txt-secondary">
            A protected wallet asks for a new safe wallet; verifiers (wallets with the DAO&apos;s verifier type, set in 5. Types &amp; rules) vote, and it executes at the threshold. Requests are found for every wallet
            in the DAO requests above and for you — look up any other protected wallet here.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Protected wallet 0x…" className={`${inputCls} max-w-md`} />
            <button className={btnSecondaryCls} disabled={!isAddr(lookup)} onClick={() => { setLookups((l) => [...l, lookup.trim()]); setLookup(''); }}>Look up</button>
          </div>
          {reqs.length === 0 && !loading && <p className="text-xs text-txt-secondary">No open safe-wallet change requests found.</p>}
          {reqs.map((r) => {
            const party = sameAddr(ctx.me, r.wallet) || sameAddr(ctx.me, r.newSafe);
            return (
              <div key={r.wallet} className="rounded-lg border border-white/10 p-3 space-y-1 text-xs">
                <AddrRow ctx={ctx} label="Protected wallet" address={r.wallet} name=""><WalletStatusBadge ctx={ctx} wallet={r.wallet} compact /></AddrRow>
                <AddrRow ctx={ctx} label="Current safe wallet" address={r.currentSafe} name=""><WalletStatusBadge ctx={ctx} wallet={r.currentSafe} compact /></AddrRow>
                <AddrRow ctx={ctx} label="New safe wallet" address={r.newSafe} name="" />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">{r.approvals}/{r.threshold} verifier votes</Badge>
                  <span className="text-txt-secondary">nonce {r.nonce}</span>
                  {r.mine && <Badge tone="good">you voted</Badge>}
                  {info && !info.voteOn && <span className="text-txt-secondary">Verifier vote is off.</span>}
                  {info?.voteOn && info?.verifier && !r.mine && !party && (
                    <button className={btnCls} onClick={() => act(`verifier vote for ${short(r.wallet)} → ${short(r.newSafe)}${r.approvals + 1 >= r.threshold ? ' — executes it' : ''}`, (c) => c.approveSafeWallet(r.wallet, r.nonce))}>Approve</button>
                  )}
                  {!info?.verifier && ctx.me && <span className="text-yellow-300">Only a verifier can vote (a wallet with the DAO's verifier type).</span>}
                  {party && <span className="text-txt-secondary">You are a party to this request, so you can&apos;t vote.</span>}
                  {(sameAddr(ctx.me, r.wallet) || isOwner) && (
                    <button className={btnSecondaryCls} onClick={async () => (await confirmDialog({ title: 'Cancel this safe-wallet change?', details: [{ label: 'DAO', value: dao, copy: dao, mono: true }, { label: 'Wallet', value: r.wallet, copy: r.wallet, mono: true }, { label: 'New safe wallet', value: r.newSafe, copy: r.newSafe, mono: true }, { label: 'Votes', value: `${r.approvals}/${r.threshold}` }], danger: true, confirmLabel: 'Cancel request', cancelLabel: 'Keep it' })) && act(`cancel safe-wallet request of ${short(r.wallet)}`, (c) => c.cancelSafeWalletRequest(r.wallet))}>Cancel</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ── Start a request from the connected wallet ─────────────────────────────────
// Frozen wallet → ask its safe wallet for protection. Frozen / protected wallet W whose safe wallet
// S1 is restricted → move to S1's safe wallet S2 (W asks, S2 approves), or S2 starts it for W
// (W approves). The links shown are read live; the contract re-checks them on approval.
function StartRequest({ ctx, dao, act }: { ctx: Ctx; dao: string; act: (label: string, fn: (c: ethers.Contract) => Promise<ethers.ContractTransaction>) => Promise<void> }) {
  const [links, setLinks] = useState<{ s1: string; s2: string } | null>(null);
  const [forWallet, setForWallet] = useState('');
  const [forLinks, setForLinks] = useState<{ s1: string; s2: string } | null>(null);
  const acl = ctx.s.acl?.address || '';
  const readLinks = useCallback(async (w: string) => {
    if (!ctx.provider || !isAddr(acl) || !isAddr(w)) return null;
    const a = new ethers.Contract(acl, ACL_VIEW_ABI, ctx.provider);
    const s1: string = await a.safeWalletOf(w);
    const s2: string = isAddr(s1) ? await a.safeWalletOf(s1) : '';
    return { s1: isAddr(s1) ? s1 : '', s2: isAddr(s2) ? s2 : '' };
  }, [ctx.provider, acl]);
  useEffect(() => { setLinks(null); if (ctx.me) readLinks(ctx.me).then(setLinks).catch(() => setLinks(null)); }, [ctx.me, readLinks, ctx.s]);
  useEffect(() => { setForLinks(null); if (isAddr(forWallet)) readLinks(forWallet.trim()).then(setForLinks).catch(() => setForLinks(null)); }, [forWallet, readLinks]);
  if (!ctx.me) return null;
  const forOk = !!forLinks?.s2 && sameAddr(forLinks.s2, ctx.me);
  return (
    <div className="space-y-2 rounded-lg border border-white/10 p-3">
      <div className="text-sm font-semibold">Start a request</div>
      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-txt-secondary w-28">Your wallet</span><WalletStatusBadge ctx={ctx} wallet={ctx.me} compact /></div>
      {links?.s1 && (
        <div className="text-xs text-txt-secondary">Your safe wallet S1 {short(links.s1)} <WalletStatusBadge ctx={ctx} wallet={links.s1} compact />
          {links.s2 ? <> · S1&apos;s safe wallet S2 {short(links.s2)}</> : <> · S1 has no safe wallet yet (operators set it)</>}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={btnSecondaryCls} disabled={!links?.s1} title="Frozen wallet: your safe wallet approves, then you are PROTECTED"
          onClick={() => act('ask protection from my safe wallet', (c) => c.requestProtection())}>Ask protection from my safe wallet</button>
        <button className={btnSecondaryCls} disabled={!links?.s2} title="Your safe wallet S1 is frozen / blacklisted: move to S1's safe wallet S2; S2 approves"
          onClick={() => act(`move my safe wallet to ${short(links?.s2 || '')}`, (c) => c.requestMoveToSafeOfSafe())}>Move to S2 (S2 approves)</button>
      </div>
      <div className="border-t border-white/5 pt-2 space-y-1">
        <div className="text-xs text-txt-secondary">You are S2 (the safe wallet of its safe wallet S1, which is frozen / blacklisted): ask to become its safe wallet; that wallet approves:</div>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={forWallet} onChange={(e) => setForWallet(e.target.value)} placeholder="Wallet 0x… (frozen or protected)" className={`${inputCls} max-w-md`} />
          <button className={btnSecondaryCls} disabled={!forOk} onClick={() => act(`move ${short(forWallet)} to me`, (c) => c.requestMoveForWallet(forWallet.trim()))}>Request move to me</button>
        </div>
        {isAddr(forWallet) && forLinks && !forOk && <p className="text-xs text-yellow-300">{!forLinks.s1 ? 'That wallet has no safe wallet.' : !forLinks.s2 ? `Its safe wallet ${short(forLinks.s1)} has no safe wallet.` : `Its safe wallet's safe wallet is ${short(forLinks.s2)}, not you.`}</p>}
        {isAddr(forWallet) && <div className="text-xs"><WalletStatusBadge ctx={ctx} wallet={forWallet.trim()} compact /></div>}
      </div>
    </div>
  );
}
