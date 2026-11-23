'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Landmark, RefreshCw } from 'lucide-react';
import Card from '@/components/card';
import { UtcTime } from '@/components/utc-datetime';
import { MANAGEMENT_ABI, describeCall, isAddr, sameAddr, short } from '@/lib/contracts/acl';
import { AddrRow, Badge, Ctx, btnCls, btnSecondaryCls, inputCls, useSavedAddr } from './shared';

interface Proposal {
  id: number; voters: string[]; executed: boolean; target: string; addr: string; data: string; expire: number; label: string;
}
const SHOWN = 15;

/** Management multisig: nodes, latest proposals (status by chain time), vote, new proposals. */
export default function ManagementCard({ ctx }: { ctx: Ctx }) {
  const [manual, setManual] = useSavedAddr('dg_managementAddress', ctx.ns);
  const [input, setInput] = useState('');
  const address = ctx.s.management || manual;
  const [nodes, setNodes] = useState<string[]>([]);
  const [props, setProps] = useState<Proposal[]>([]);
  const [count, setCount] = useState(0);
  const [now, setNow] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [rev, setRev] = useState(0);

  const load = useCallback(async () => {
    setErr('');
    if (!ctx.provider || !isAddr(address)) { setNodes([]); setProps([]); return; }
    setLoading(true);
    try {
      const m = new ethers.Contract(address, MANAGEMENT_ABI, ctx.provider);
      const [n, c, block] = await Promise.all([m.queryNodes(), m.proposalCount(), ctx.provider.getBlock('latest')]);
      const total = c.toNumber();
      const ids = Array.from({ length: Math.min(SHOWN, total) }, (_, i) => total - i);
      const list = await Promise.all(ids.map(async (id) => {
        const r = await m.queryVotes(id);
        return { id, voters: r.voters, executed: r.executed, target: r.target, addr: r.addr, data: r.data, expire: r.expire.toNumber(), label: r.label } as Proposal;
      }));
      setNodes(n); setCount(total); setProps(list); setNow(block.timestamp);
    } catch (e: any) {
      setErr(`Not a Management contract, or it can't be read: ${e?.reason || e?.message || e}`);
    } finally { setLoading(false); }
  }, [ctx.provider, address]);
  useEffect(() => { load(); }, [load, rev]);

  const needed = Math.floor(nodes.length / 2) + 1;
  const isNode = nodes.some((n) => sameAddr(n, ctx.me));

  const vote = async (p: Proposal) => {
    const m = new ethers.Contract(address, MANAGEMENT_ABI, ctx.signer!);
    const last = p.voters.length + 1 >= needed;
    // the vote that reaches quorum runs the proposal in the same tx: give it room
    const rc = await ctx.run(`Management: vote on #${p.id} (${describe(p)})${last ? ' — executes it' : ''}`, async () => {
      const gas = await m.estimateGas.vote(p.id);
      return m.vote(p.id, { gasLimit: gas.mul(13).div(10) });
    });
    if (rc) { setRev((r) => r + 1); ctx.refresh(); }
  };

  const describe = (p: Proposal) => {
    const tgt = ctx.nameOf(p.target) || short(p.target);
    switch (p.label) {
      case 'updateProxyUpgrad': return `Upgrade ${tgt} to ${ctx.nameOf(p.addr) || p.addr}`;
      case 'updateProxyAdmin': return `Change proxy admin of ${tgt} to ${ctx.nameOf(p.addr) || p.addr}`;
      case 'excContract': return `Call ${tgt}: ${describeCall(p.data)}`;
      case 'addNode': return `Add node ${p.addr}`;
      case 'deleteNode': return `Remove node ${p.addr}`;
      default: return p.label;
    }
  };

  // ── new proposal (any kind) ──
  const [kind, setKind] = useState<'upgrade' | 'admin' | 'call' | 'addNode' | 'deleteNode'>('upgrade');
  const [target, setTarget] = useState('');
  const [arg, setArg] = useState('');
  const [data, setData] = useState('');
  const canPropose = isNode && (
    kind === 'addNode' || kind === 'deleteNode' ? isAddr(arg)
    : kind === 'call' ? isAddr(target) && /^0x[0-9a-fA-F]{8,}$/.test(data.trim())
    : isAddr(target) && isAddr(arg));
  const propose = async () => {
    const m = new ethers.Contract(address, MANAGEMENT_ABI, ctx.signer!);
    const t = target.trim(), a = arg.trim(), d = data.trim();
    const [fn, args, text] =
      kind === 'upgrade' ? ['updateProxyUpgradPropose', [t, a], `upgrade ${ctx.nameOf(t) || t}`]
      : kind === 'admin' ? ['updateProxyAdminPropose', [t, a], `change proxy admin of ${ctx.nameOf(t) || t}`]
      : kind === 'call' ? ['excContractPropose', [t, d], `call ${ctx.nameOf(t) || t}: ${describeCall(d)}`]
      : kind === 'addNode' ? ['addNodePropose', [a], `add node ${a}`]
      : ['deleteNodePropose', [a], `remove node ${a}`];
    const rc = await ctx.run(`Management: propose ${text}`, () => m[fn as string](...(args as string[])));
    if (rc) { setTarget(''); setArg(''); setData(''); setRev((r) => r + 1); }
  };

  return (
    <Card icon={<Landmark className="w-5 h-5 text-accent" />}
      title={<span>Management multisig {isAddr(address) ? <span className="text-sm text-txt-secondary font-normal">· {nodes.length ? `${needed} of ${nodes.length} nodes` : '…'} · {count} proposals{isNode ? ' · you are a node' : ''}</span> : <span className="text-sm text-txt-secondary font-normal">· none on {ctx.ns === 56 ? 'this network' : 'testnet'}</span>}</span>}>
      <div className="space-y-4">
        <p className="text-xs text-txt-secondary">
          <code>contracts/Management.sol</code> — no owner and no proxy. A node creates a proposal (counts as its vote); it executes on the vote that
          passes half the nodes and expires 24h after it was created. Only nodes can propose or vote.
        </p>
        {!ctx.s.management && (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-txt-secondary">No contract on this network is controlled by a Management multisig. Load one by address:</span>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… Management address" className={`${inputCls} max-w-md`} />
            <button className={btnSecondaryCls} disabled={!isAddr(input)} onClick={() => { setManual(input.trim()); setInput(''); ctx.refresh(); }}>Load</button>
            {manual && <button className="text-xs underline text-txt-secondary" onClick={() => { setManual(''); ctx.refresh(); }}>forget {short(manual)}</button>}
          </div>
        )}
        {isAddr(address) && <AddrRow ctx={ctx} label="Management" address={address} name="Management multisig" />}
        {err && <p className="text-xs text-red-300">{err}</p>}

        {nodes.length > 0 && (
          <div>
            <div className="text-xs font-semibold mb-1">Nodes ({nodes.length}) — connect one of these wallets to propose or vote</div>
            {nodes.map((n, i) => <AddrRow key={n} ctx={ctx} label={`Node ${i + 1}`} address={n} name="" />)}
          </div>
        )}

        {props.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold">Latest proposals</span>
              <span className="text-xs text-txt-secondary">chain time <UtcTime inline ts={now} /></span>
              <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload" onClick={() => setRev((r) => r + 1)}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="space-y-1.5">
              {props.map((p) => {
                const expired = !p.executed && p.expire <= now;
                const voted = p.voters.some((v) => sameAddr(v, ctx.me));
                return (
                  <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-b border-white/5 pb-1.5">
                    <span className="font-mono text-txt-secondary">#{p.id}</span>
                    {p.executed ? <Badge tone="good">executed</Badge> : expired ? <Badge tone="muted">expired</Badge> : <Badge tone="warn">open</Badge>}
                    <span className="flex-1 min-w-[240px] break-all">{describe(p)}</span>
                    <span className="text-txt-secondary" title={p.voters.join('\n')}>{p.voters.length}/{needed} votes</span>
                    {!p.executed && !expired && <span className="text-txt-secondary">expires <UtcTime inline ts={p.expire} /></span>}
                    {!p.executed && !expired && isNode && !voted && <button className={btnCls} onClick={() => vote(p)}>Vote</button>}
                    {!p.executed && !expired && voted && <Badge tone="good">you voted</Badge>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isAddr(address) && nodes.length > 0 && (
          <div className="rounded-lg border border-white/10 p-3 space-y-2">
            <div className="text-sm font-semibold">New proposal</div>
            {!isNode && <p className="text-xs text-yellow-300">Only a node wallet can propose. Connect one of the nodes above.</p>}
            <div className="flex flex-wrap gap-2">
              {([['upgrade', 'Upgrade a proxy'], ['admin', 'Change proxy admin'], ['call', 'Call a contract'], ['addNode', 'Add node'], ['deleteNode', 'Remove node']] as const).map(([k, l]) => (
                <button key={k} className={kind === k ? btnCls : btnSecondaryCls} onClick={() => setKind(k)}>{l}</button>
              ))}
            </div>
            {kind !== 'addNode' && kind !== 'deleteNode' && (
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target contract 0x… (proxy for upgrade / admin)" className={inputCls} />
            )}
            {kind !== 'call' && (
              <input value={arg} onChange={(e) => setArg(e.target.value)} placeholder={kind === 'upgrade' ? 'New implementation 0x…' : kind === 'admin' ? 'New proxy admin 0x…' : 'Node address 0x…'} className={inputCls} />
            )}
            {kind === 'call' && (
              <>
                <input value={data} onChange={(e) => setData(e.target.value)} placeholder="Calldata 0x… (upgrad / changeAdmin are not allowed here — use the other kinds)" className={inputCls} />
                {/^0x[0-9a-fA-F]{8,}$/.test(data.trim()) && <p className="text-xs font-mono text-txt-secondary break-all">{describeCall(data.trim())}</p>}
              </>
            )}
            {isAddr(target) && ctx.nameOf(target) && <p className="text-xs text-txt-secondary">Target: <span className="text-txt-primary">{ctx.nameOf(target)}</span></p>}
            <button className={btnCls} disabled={!canPropose} onClick={propose}>Create proposal</button>
          </div>
        )}
      </div>
    </Card>
  );
}
