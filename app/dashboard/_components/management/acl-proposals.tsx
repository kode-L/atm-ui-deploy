'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '@/components/confirm-dialog';
import { ethers } from 'ethers';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import Card from '@/components/card';
import { CopyButton } from '@/components/tx-status';
import { isAddr, sameAddr, short } from '@/lib/contracts/acl';
import { AddrRow, Badge, Ctx, btnCls, btnSecondaryCls, inputCls } from './shared';

// ATMAccessControl operator proposals (same in v1.0.0 and v1.1.0). Ids are 0..proposalCount-1 and
// every field is readable, so the list below is the complete on-chain state — no event scanning.
// Creating counts as the proposer's approval; it executes on the approval that reaches the
// threshold snapshotted at creation.
export const ACL_PROPOSAL_ABI = [
  'function owner() view returns (address)',
  'function operators(address) view returns (bool)',
  'function proposalThreshold() view returns (uint256)',
  'function proposalCount() view returns (uint256)',
  'function proposals(uint256) view returns (uint8 proposalType, uint256 approvalCount, uint256 snapshotThreshold, bool executed, bool cancelled, address proposer)',
  'function getProposalAddrs(uint256) view returns (address[])',
  'function getProposalAux(uint256) view returns (address[])',
  'function hasApproved(uint256, address) view returns (bool)',
  'function approveProposal(uint256)',
  'function rejectProposal(uint256)',
  'function blacklist(address[])',
  'function freeze(address[])',
  'function unBlacklist(address[])',
  'function unFreeze(address[])',
  'function moveToFrozen(address[])',
  'function setSafeWallet(address[], address[])',
];
const TYPES = ['Set safe wallet', 'Unfreeze', 'Unblacklist', 'Move to frozen', 'Add wallets to a type', 'Remove wallets from a type'];
const SHOWN = 25;

interface Row {
  id: number; type: number; approvals: number; threshold: number; executed: boolean; cancelled: boolean;
  proposer: string; addrs: string[]; aux: string[]; approvedByMe: boolean;
}

type Action = 'blacklist' | 'freeze' | 'unBlacklist' | 'unFreeze' | 'moveToFrozen' | 'setSafeWallet';
const ACTIONS: { id: Action; label: string; immediate: boolean; help: string }[] = [
  { id: 'unBlacklist', label: 'Unblacklist', immediate: false, help: 'Proposal: runs when enough operators approve.' },
  { id: 'unFreeze', label: 'Unfreeze', immediate: false, help: 'Proposal: runs when enough operators approve. Wallets must be frozen.' },
  { id: 'moveToFrozen', label: 'Move to frozen', immediate: false, help: 'Proposal: blacklisted wallets become frozen (payouts can go to a safe wallet).' },
  { id: 'setSafeWallet', label: 'Set safe wallet', immediate: false, help: 'Proposal: one "wallet, safe wallet" pair per line. Wallets must be frozen or protected.' },
  { id: 'blacklist', label: 'Blacklist', immediate: true, help: 'Applies immediately — no proposal, no approvals.' },
  { id: 'freeze', label: 'Freeze', immediate: true, help: 'Applies immediately — no proposal, no approvals.' },
];

/** ACL operator proposals: full list from the chain, approve / reject, and new proposals. */
export default function AclProposals({ ctx }: { ctx: Ctx }) {
  const acl = ctx.s.acl?.address || '';
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [threshold, setThreshold] = useState(0);
  const [owner, setOwner] = useState('');
  const [isOperator, setIsOperator] = useState(false);
  const [operators, setOperators] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [rev, setRev] = useState(0);
  const [onlyOpen, setOnlyOpen] = useState(true);

  const load = useCallback(async () => {
    setErr('');
    if (!ctx.provider || !isAddr(acl)) return;
    setLoading(true);
    try {
      const c = new ethers.Contract(acl, ACL_PROPOSAL_ABI, ctx.provider);
      const [n, t, o] = await Promise.all([c.proposalCount(), c.proposalThreshold(), c.owner()]);
      const total = n.toNumber();
      const ids = Array.from({ length: Math.min(SHOWN, total) }, (_, i) => total - 1 - i);
      const list: Row[] = await Promise.all(ids.map(async (id) => {
        const [p, addrs, aux, mine] = await Promise.all([
          c.proposals(id), c.getProposalAddrs(id), c.getProposalAux(id),
          ctx.me ? c.hasApproved(id, ctx.me) : Promise.resolve(false),
        ]);
        return {
          id, type: Number(p.proposalType), approvals: p.approvalCount.toNumber(), threshold: p.snapshotThreshold.toNumber(),
          executed: p.executed, cancelled: p.cancelled, proposer: p.proposer, addrs, aux, approvedByMe: mine,
        };
      }));
      // operators aren't enumerable on-chain: check everyone who proposed, plus you and the owner
      const cands = Array.from(new Set([ctx.me, o, ...list.map((r) => r.proposer)].filter(isAddr).map((a) => ethers.utils.getAddress(a))));
      const flags = await Promise.all(cands.map((a) => c.operators(a) as Promise<boolean>));
      setOperators(cands.filter((_, i) => flags[i]));
      setIsOperator(!!ctx.me && flags[cands.findIndex((a) => sameAddr(a, ctx.me))] === true);
      setRows(list); setCount(total); setThreshold(t.toNumber()); setOwner(o);
    } catch (e: any) {
      setErr(e?.reason || e?.message || String(e));
    } finally { setLoading(false); }
  }, [ctx.provider, acl, ctx.me]);
  useEffect(() => { load(); }, [load, rev, ctx.s]);

  const write = () => new ethers.Contract(acl, ACL_PROPOSAL_ABI, ctx.signer!);
  const approve = async (r: Row) => {
    const last = r.approvals + 1 >= r.threshold;
    const rc = await ctx.run(`ACL proposal #${r.id} (${TYPES[r.type]}, ${r.addrs.length} wallets): approve${last ? ' — executes it' : ''}`, async () => {
      const c = write();
      const gas = await c.estimateGas.approveProposal(r.id);
      return c.approveProposal(r.id, { gasLimit: gas.mul(13).div(10) }); // the last approval runs the batch
    });
    if (rc) setRev((x) => x + 1);
  };
  const reject = async (r: Row) => {
    if (!(await confirmDialog({
      title: `Reject ACL proposal #${r.id}?`,
      details: [
        { label: 'ACL', value: acl, copy: acl, mono: true },
        { label: 'Type', value: TYPES[r.type] },
        { label: 'Approvals', value: `${r.approvals} / ${r.threshold}` },
        { label: `Wallets (${r.addrs.length})`, value: r.addrs.slice(0, 10).join('\n') + (r.addrs.length > 10 ? `\n… and ${r.addrs.length - 10} more` : ''), copy: r.addrs.join('\n'), mono: true },
      ],
      warning: "It can't be approved afterwards.",
      danger: true,
      confirmLabel: 'Reject proposal',
    }))) return;
    const rc = await ctx.run(`ACL proposal #${r.id}: reject`, () => write().rejectProposal(r.id));
    if (rc) setRev((x) => x + 1);
  };

  // ── new proposal / operator action ──
  const [action, setAction] = useState<Action>('unFreeze');
  const [text, setText] = useState('');
  const def = ACTIONS.find((a) => a.id === action)!;
  const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => l.split(/[\s,]+/).filter(Boolean));
  const bad = parsed.filter((p) => (action === 'setSafeWallet' ? p.length !== 2 || !isAddr(p[0]) || !isAddr(p[1]) : p.length !== 1 || !isAddr(p[0])));
  const canSend = isOperator && lines.length > 0 && bad.length === 0 && lines.length <= 500;
  const submit = async () => {
    const a = parsed.map((p) => p[0]);
    const args: any[] = action === 'setSafeWallet' ? [a, parsed.map((p) => p[1])] : [a];
    if (def.immediate && !(await confirmDialog({
      title: `${def.label} ${a.length} wallet${a.length === 1 ? '' : 's'} now?`,
      details: [
        { label: 'ACL', value: acl, copy: acl, mono: true },
        { label: 'Call', value: `${action}(…)`, mono: true },
        { label: `Wallets (${a.length})`, value: lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n… and ${lines.length - 10} more` : ''), copy: lines.join('\n'), mono: true },
      ],
      warning: 'This applies immediately — no other operator approves it.',
      danger: true,
      confirmLabel: def.label,
    }))) return;
    const rc = await ctx.run(`ACL: ${def.label} ${a.length} wallet(s)${def.immediate ? '' : ' (proposal)'}`, () => write()[action](...args));
    if (rc) { setText(''); setRev((x) => x + 1); }
  };

  const shown = onlyOpen ? rows.filter((r) => !r.executed && !r.cancelled) : rows;
  const open = rows.filter((r) => !r.executed && !r.cancelled).length;
  const describe = (r: Row) => [
    `ACL proposal #${r.id} on ${ctx.s.acl?.address} (${ctx.ns === 56 ? 'BSC mainnet' : 'BSC testnet'})`,
    `Type: ${TYPES[r.type]} · approvals ${r.approvals}/${r.threshold} · proposer ${r.proposer}`,
    ...r.addrs.map((a, i) => (r.aux[i] ? `${a} → safe wallet ${r.aux[i]}` : a)),
    `Approve: ATMAccessControl.approveProposal(${r.id}) from an operator wallet`,
  ].join('\n');

  if (!isAddr(acl)) return <Card title="ACL proposals"><p className="text-xs text-txt-secondary">No ACL found on this network.</p></Card>;

  return (
    <Card icon={<ClipboardCheck className="w-5 h-5 text-accent" />}
      title={<span>ACL operator proposals <span className="text-sm text-txt-secondary font-normal">· {count} total · {open} open in the latest {Math.min(SHOWN, count)} · threshold {threshold}</span></span>}>
      <div className="space-y-4">
        <p className="text-xs text-txt-secondary">
          Read straight from <code>ATMAccessControl.proposals(id)</code> — the complete on-chain list, nothing stored in the browser.
          Creating a proposal counts as the proposer&apos;s approval; it executes on the approval that reaches the threshold it was created with.
          Operators approve; the proposer or the ACL owner can reject.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-txt-secondary">Your wallet:</span>
          {!ctx.me ? <span className="text-txt-secondary">not connected</span> : <>
            {isOperator ? <Badge tone="good">operator — you can approve</Badge> : <Badge tone="bad">not an operator</Badge>}
            {sameAddr(ctx.me, owner) && <Badge tone="good">ACL owner — you can reject</Badge>}
          </>}
          <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload from chain" onClick={() => setRev((x) => x + 1)}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {operators.length > 0 && (
          <div>
            <div className="text-xs font-semibold">Known operators (checked live with <code>operators(addr)</code>)</div>
            {operators.map((o) => <AddrRow key={o} ctx={ctx} label="Operator" address={o} name="" />)}
          </div>
        )}
        {err && <p className="text-xs text-red-300">{err}</p>}

        <div className="flex items-center gap-2 text-xs">
          <button className={onlyOpen ? btnCls : btnSecondaryCls} onClick={() => setOnlyOpen(true)}>Open ({open})</button>
          <button className={!onlyOpen ? btnCls : btnSecondaryCls} onClick={() => setOnlyOpen(false)}>Latest {Math.min(SHOWN, count)}</button>
        </div>
        {shown.length === 0 && !loading && <p className="text-xs text-txt-secondary">{onlyOpen ? 'Nothing waiting for approval.' : 'No proposals yet.'}</p>}
        <div className="space-y-2">
          {shown.map((r) => {
            const pending = !r.executed && !r.cancelled;
            const canReject = pending && (sameAddr(ctx.me, r.proposer) || sameAddr(ctx.me, owner));
            return (
              <div key={r.id} className="rounded-lg border border-white/10 p-3 space-y-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-txt-secondary">#{r.id}</span>
                  <span className="font-semibold">{TYPES[r.type] ?? `type ${r.type}`}</span>
                  <span className="text-txt-secondary">{r.addrs.length} wallet{r.addrs.length === 1 ? '' : 's'}</span>
                  {r.executed ? <Badge tone="good">executed</Badge> : r.cancelled ? <Badge tone="muted">rejected</Badge> : <Badge tone="warn">waiting {r.approvals}/{r.threshold}</Badge>}
                  {r.approvedByMe && pending && <Badge tone="good">you approved</Badge>}
                  <span className="text-txt-secondary">by {ctx.nameOf(r.proposer) || short(r.proposer)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <CopyButton text={describe(r)} label="Copy" title="Copy the proposal details for an operator" />
                    {pending && isOperator && !r.approvedByMe && <button className={btnCls} onClick={() => approve(r)}>Approve</button>}
                    {canReject && <button className={btnSecondaryCls} onClick={() => reject(r)}>Reject</button>}
                  </span>
                </div>
                <details>
                  <summary className="cursor-pointer text-txt-secondary">Wallets</summary>
                  <div className="mt-1 space-y-0.5 font-mono max-h-48 overflow-y-auto">
                    {r.addrs.map((a, i) => <div key={i} className="break-all">{a}{r.aux[i] && isAddr(r.aux[i]) ? <span className="text-txt-secondary"> → safe wallet </span> : null}{r.aux[i] && isAddr(r.aux[i]) ? r.aux[i] : null}</div>)}
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-white/10 p-3 space-y-2">
          <div className="text-sm font-semibold">New operator action</div>
          {!isOperator && <p className="text-xs text-yellow-300">Only an operator wallet can do this. Connect one of the operators above.</p>}
          <div className="flex flex-wrap gap-2">
            {ACTIONS.map((a) => <button key={a.id} className={action === a.id ? btnCls : btnSecondaryCls} onClick={() => setAction(a.id)}>{a.label}</button>)}
          </div>
          <p className={`text-xs ${def.immediate ? 'text-yellow-300' : 'text-txt-secondary'}`}>{def.help}</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className={inputCls}
            placeholder={action === 'setSafeWallet' ? '0xWallet, 0xSafeWallet\n0xWallet, 0xSafeWallet' : '0xWallet\n0xWallet'} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-txt-secondary">{lines.length} line(s){bad.length ? '' : ''}</span>
            {bad.length > 0 && <span className="text-red-300">{bad.length} invalid line(s)</span>}
            {lines.length > 500 && <span className="text-red-300">max 500 per call</span>}
            <button className={btnCls} disabled={!canSend} onClick={submit}>{def.immediate ? def.label : `Propose ${def.label.toLowerCase()}`}</button>
          </div>
        </div>
      </div>
    </Card>
  );
}
