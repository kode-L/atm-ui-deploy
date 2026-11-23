'use client';
import React, { ReactNode, useCallback, useEffect, useState } from 'react';
import { confirmDialog } from '@/components/confirm-dialog';
import { ethers } from 'ethers';
import { ArrowUpCircle, CheckCircle2, Circle, ClipboardCheck, FlaskConical, KeyRound, Loader2, RefreshCw, RotateCcw, Rocket, XCircle } from 'lucide-react';
import Card from '@/components/card';
import TxStatus, { CopyButton } from '@/components/tx-status';
import ContractOverview from '@/components/contract-overview';
import { UtcTime } from '@/components/utc-datetime';
import { LINK_ADDRESSES } from '@/lib/contracts/link';
import {
  ARTIFACTS, CONNECTION_ACTIONS, MANAGEMENT_ABI, MgmtProposal, ProductionRuleState, ProxyInfo, aclIface, factoryChecksAcl, findMgmtProposals, implIsBundled, isAddr, newImplKey,
  readProductionRules, sameAddr, saveAddr, short,
} from '@/lib/contracts/acl';
import { useAclCtx } from './management/use-acl-ctx';
import { AddrRow, Badge, ControlledAction, ControllerTag, Ctx, NewImplementation, btnCls, inputCls, netName, useSavedAddr } from './management/shared';

// ATM Upgrader: only the ACL v1.1.0 upgrade, as one checklist in runbook order. Every step reads its
// state from the chain and names who signs it. A wallet signs directly; a Management multisig gets a
// proposal that its nodes vote on (BSC mainnet: Factory and Trader). Versions follow mainnet + 1.
const TARGET = { acl: 'v1.1.0', dao: 'v1.0.0', trader: 'v1.0.5' } as const;
const PREV_KEY = (name: string) => `dg_upgraderPrevImpl_${name}`;

type StepState = 'done' | 'next' | 'blocked' | 'optional';

interface Live {
  aclBundled: boolean | null;               // live ACL implementation == the bundled v1.1.0 build
  factoryNew: boolean | null;               // live Factory implementation == the bundled build
  traderBundled: boolean | null;            // live Trader implementation == the bundled v1.0.5 build
  rules: ProductionRuleState | null;        // null = ACL below v1.1.0 / not readable
}

export default function AtmUpgraderSection({ onOpenManagement }: { onOpenManagement?: (subTab: string) => void } = {}) {
  const { s, ctx, ns, chainId, provider, loading, loadErr, wrongChain, tx, refresh } = useAclCtx();
  const [live, setLive] = useState<Live>({ aclBundled: null, factoryNew: null, traderBundled: null, rules: null });
  const luca = LINK_ADDRESSES[ns]?.luca || '';

  useEffect(() => {
    if (!provider || !s) return;
    let cancelled = false;
    (async () => {
      const [aclBundled, factoryNew, traderBundled, rules] = await Promise.all([
        s.acl ? implIsBundled(provider, s.acl.implementation, 'ATMAccessControl') : Promise.resolve(null),
        s.factory ? implIsBundled(provider, s.factory.implementation, 'Factory') : Promise.resolve(null),
        s.trader ? implIsBundled(provider, s.trader.implementation, 'Trader') : Promise.resolve(null),
        s.acl && s.aclV11 ? readProductionRules(provider, s.acl.address, luca).catch(() => null) : Promise.resolve(null),
      ]);
      if (!cancelled) setLive({ aclBundled, factoryNew, traderBundled, rules });
    })();
    return () => { cancelled = true; };
  }, [provider, s, luca]);

  // remember each proxy's implementation from before its upgrade: the rollback target
  useEffect(() => {
    if (!s) return;
    const keep = (name: string, info: ProxyInfo | null, upgraded: boolean) => {
      if (!info?.implementation || upgraded) return;
      saveAddr(PREV_KEY(name), ns, info.implementation);
    };
    if (live.aclBundled === false) keep('acl', s.acl, false);
    if (live.factoryNew === false) keep('factory', s.factory, false);
    if (live.traderBundled === false) keep('trader', s.trader, false);
  }, [s, ns, live.aclBundled, live.factoryNew, live.traderBundled]);

  const overview = !s ? [] : [
    { label: 'ATMAccessControl (ACL)', address: s.acl?.address || '' },
    { label: 'ATMAccessControlDAO', address: s.dao?.address || '' },
    { label: 'Factory', address: s.factory?.address || '' },
    { label: 'Trader', address: s.trader?.address || '' },
    ...(s.management ? [{ label: 'Management multisig', address: s.management }] : []),
  ].filter((i) => isAddr(i.address));

  return (
    <div className="space-y-4">
      <ContractOverview items={overview} provider={provider} chainId={ns} />

      <div className="bg-surface-secondary rounded-xl p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Rocket className="w-5 h-5 text-accent" />
          <h2 className="font-semibold">ATM Upgrader — {netName(ns)}</h2>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-txt-secondary" />}
          <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload from chain" onClick={refresh}><RefreshCw className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-txt-secondary">
          The ACL v1.1.0 upgrade only: upgrade the ACL, deploy the ACL DAO, link them, set the production rules, upgrade the Factory, then the Trader.
          Each step shows its state on the chain and <strong>who signs it</strong>. Link, Pledge, File and Luca are not changed.
          Types, operators and DAO requests are managed in <strong>ACL &amp; Management</strong>.
        </p>
        {wrongChain && <p className="text-xs text-red-300">Your wallet is on chain {chainId}, this tab reads {netName(ns)}. Switch the wallet before sending anything.</p>}
        {loadErr && <p className="text-xs text-red-300">Couldn&apos;t read the contracts: {loadErr}</p>}
      </div>

      {ctx && (
        <>
          <Signers ctx={ctx} />
          <UpgradeChecklist ctx={ctx} live={live} />
          <Steps ctx={ctx} live={live} luca={luca} open={onOpenManagement} />
          {ctx.ns === 97 && <TestFactoryCard ctx={ctx} />}
          <Rollback ctx={ctx} />
        </>
      )}
      <TxStatus {...tx} chainId={ns} />
    </div>
  );
}

// ── Who signs on this network, and what that means ────────────────────────────
function signText(ctx: Ctx, address?: string): ReactNode {
  const c = ctx.controllerOf(address);
  if (!isAddr(address) || !c) return <span className="text-txt-secondary">not readable</span>;
  if (c.kind === 'wallet') {
    return <>Connect <span className="font-mono">{short(address)}</span> in your wallet and press the button in the step{c.delegated ? ' (an EOA with an EIP-7702 delegation, it signs like any wallet)' : ''}.</>;
  }
  if (c.kind === 'management') {
    return <>A <strong>Management proposal</strong>: any node connects and presses <em>Create Management proposal</em> in the step, then {(c.needed || 1) - 1} more of the {c.nodes?.length} nodes press <em>Vote</em> in the same step within 24h. It runs on the vote that reaches {c.needed} of {c.nodes?.length}.</>;
  }
  return <>Another contract (Safe, timelock…): copy the request from the step and send it from that contract.</>;
}

function Signers({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const rows: [string, string, string | undefined][] = [
    ['Upgrade ACL', 'ACL proxy admin', s.acl?.admin],
    ['Set DAO, production rules', 'ACL owner', s.acl?.owner],
    ['Deploy ACL DAO', 'any wallet (becomes the DAO proxy admin)', ctx.me || undefined],
    ['Upgrade Factory', 'Factory proxy admin', s.factory?.admin],
    ['Upgrade Trader', 'Trader proxy admin', s.trader?.admin],
  ];
  const kinds = rows.slice(0, 2).concat(rows.slice(3)).map(([, , a]) => ctx.controllerOf(a)?.kind);
  const mixed = kinds.includes('management');
  const mgmt = rows.map(([, , a]) => ctx.controllerOf(a)).find((c) => c?.kind === 'management');
  const isNode = !!mgmt?.nodes?.some((n) => sameAddr(n, ctx.me));
  return (
    <Card title="Who signs on this network" icon={<KeyRound className="w-5 h-5 text-accent" />}>
      <div className="space-y-3">
        <div className={`rounded-lg p-3 text-xs ${mixed ? 'bg-yellow-900/20 border border-yellow-700/40' : 'bg-green-900/20 border border-green-700/40'}`}>
          {mixed ? (
            <>
              <strong>Wallet + Management flow.</strong> Steps signed by a wallet are sent directly. Steps signed by the Management multisig
              ({mgmt?.needed} of {mgmt?.nodes?.length} nodes) become proposals that expire after 24h, so have the node holders ready.
              Do steps 1–4 first. Propose step 5 only after step 3 shows ✓, because the Factory starts asking the ACL as soon as its proposal runs.
              {ctx.me && (isNode ? <span className="text-green-300"> You are a Management node.</span> : <span className="text-txt-secondary"> The connected wallet is not a Management node.</span>)}
            </>
          ) : (
            <><strong>Wallet flow.</strong> Every step is signed by a wallet. Connect the wallet named in each step and send it. No votes needed.</>
          )}
        </div>
        <div className="space-y-2">
          {rows.map(([what, role, who]) => (
            <div key={what} className="text-xs border-b border-white/5 pb-2 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold w-72 shrink-0">{what}</span>
                <span className="text-txt-secondary">{role}</span>
                {isAddr(who) && (
                  <>
                    <span className="font-mono" title={who}>{who}</span>
                    <CopyButton text={who!} title="Copy address" />
                    <ControllerTag ctx={ctx} address={who} />
                    {ctx.controllerOf(who)?.delegated && <Badge tone="muted" title="EOA with an EIP-7702 delegation (e.g. a MetaMask smart account)">EIP-7702</Badge>}
                  </>
                )}
                {!isAddr(who) && role.startsWith('any') && <span className="text-txt-secondary">connect any wallet</span>}
              </div>
              {isAddr(who) && !role.startsWith('any') && <div className="text-txt-secondary pl-0 md:pl-[18.5rem]">{signText(ctx, who)}</div>}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── The checklist ─────────────────────────────────────────────────────────────
function StepCard({ n, title, state, summary, children }: { n: number; title: string; state: StepState; summary: ReactNode; children: ReactNode }) {
  const badge = {
    done: <Badge tone="good">done</Badge>,
    next: <Badge tone="accent">to do</Badge>,
    blocked: <Badge tone="muted">waiting for an earlier step</Badge>,
    optional: <Badge tone="warn">to do · fix</Badge>,
  }[state];
  return (
    <Card collapsible defaultOpen={state !== 'done'} icon={state === 'done' ? <CheckCircle2 className="w-5 h-5 text-green-400" /> : <Circle className="w-5 h-5 text-accent" />}
      title={<span className="inline-flex flex-wrap items-center gap-2">{n}. {title} {badge} <span className="text-sm text-txt-secondary font-normal">{summary}</span></span>}>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Steps({ ctx, live, luca, open }: { ctx: Ctx; live: Live; luca: string; open?: (subTab: string) => void }) {
  const { s } = ctx;
  const aclDone = !!s.acl && s.aclV11 && s.acl.version === TARGET.acl && live.aclBundled === true;
  const aclOlderBuild = !!s.acl && s.acl.version === TARGET.acl && live.aclBundled === false;
  const daoDone = !!s.dao;
  const linkDao = !!s.dao && sameAddr(s.aclDao, s.dao.address);
  const rules = live.rules;
  const rulesDone = !!rules && rules.blacklisted && rules.frozen && rules.frozenLuca;
  const factoryDone = live.factoryNew === true;
  const traderDone = s.trader?.version === TARGET.trader && live.traderBundled === true;
  const st = (done: boolean, ready: boolean): StepState => (done ? 'done' : ready ? 'next' : 'blocked');
  const doneCount = [aclDone, daoDone, linkDao, rulesDone, factoryDone, traderDone].filter(Boolean).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <ArrowUpCircle className="w-4 h-4 text-accent" />
        <span className="text-sm font-semibold">Upgrade steps</span>
        <span className="text-xs text-txt-secondary">{doneCount} of 6 done · in this order</span>
      </div>

      {/* 1. ACL */}
      <StepCard n={1} title="Upgrade the ACL to v1.1.0" state={st(aclDone, true)}
        summary={s.acl ? (aclOlderBuild ? `an older ${TARGET.acl} build → the bundled ${TARGET.acl}` : `now ${s.acl.version || 'no version()'} → ${TARGET.acl}`) : 'ACL not found'}>
        {aclOlderBuild && <p className="text-xs text-yellow-300">The live ACL reports {TARGET.acl} but it isn&apos;t the bundled build (e.g. the earlier testnet build with <code>connectionCaller</code>). Deploy the bundled implementation and upgrade again; storage is unchanged.</p>}
        <p className="text-xs text-txt-secondary">Wallet types and rules, the ACL DAO hooks and the new <code>selfFreeze</code> (an active safe wallet can freeze itself). Storage is append-only: blacklist, frozen wallets, safe wallets and proposals stay as they are.</p>
        {s.acl && <StatusRows ctx={ctx} rows={[
          ['ACL proxy', s.acl.address, <Badge key="v" tone={aclDone ? 'good' : 'accent'}>{s.acl.version || 'no version()'}{aclDone ? ' · bundled build' : ''}</Badge>],
          ['Implementation now', s.acl.implementation, null],
          ['Upgrade signed by', s.acl.admin, <ControllerTag key="c" ctx={ctx} address={s.acl.admin} />],
        ]} />}
        <GoTo open={open} sub="acl" label="ACL & Management → 1. ACL → Upgrade ACL" done={aclDone} />
      </StepCard>

      {/* 2. DAO */}
      <StepCard n={2} title="Deploy the ACL DAO" state={st(daoDone, aclDone)}
        summary={s.dao ? `${s.dao.version || '…'} at ${short(s.dao.address)}${s.daoSource === 'saved' ? ' · not linked yet' : ''}` : 'new contract'}>
        {s.dao ? <StatusRows ctx={ctx} rows={[
          ['DAO proxy', s.dao.address, <Badge key="v" tone="accent">{s.dao.version || '…'}</Badge>],
          ['DAO owner', s.dao.owner, <ControllerTag key="o" ctx={ctx} address={s.dao.owner} />],
          ['DAO proxy admin', s.dao.admin, <ControllerTag key="a" ctx={ctx} address={s.dao.admin} />],
        ]} /> : <p className="text-xs text-txt-secondary">Not deployed yet. Deploy the implementation, then the proxy (File address + owner); the deploying wallet becomes the DAO proxy admin.</p>}
        {s.daoSource === 'saved' && <p className="text-xs text-yellow-300">Kept in this browser until step 3 links it in the ACL.</p>}
        <GoTo open={open} sub="dao" label="ACL & Management → 2. ACL DAO" done={daoDone} />
      </StepCard>

      {/* 3. Link */}
      <StepCard n={3} title="Link the DAO in the ACL" state={st(linkDao, aclDone && daoDone)}
        summary={s.aclV11 ? (linkDao ? 'DAO ✓' : 'DAO ✗') : 'needs step 1'}>
        <p className="text-xs text-txt-secondary">The ACL owner calls <code>setDao(dao)</code>, so the ACL accepts the DAO&apos;s hooks. The Factory needs no setup here: it finds the ACL through <code>File.accessControl()</code>.</p>
        {s.acl && s.aclV11 && <StatusRows ctx={ctx} rows={[
          ['ACL.dao()', s.aclDao, linkDao ? <Badge key="d" tone="good">matches the DAO</Badge> : <Badge key="d" tone="warn">{s.dao ? 'not the DAO yet' : 'no DAO yet'}</Badge>],
          ['Signed by (ACL owner)', s.acl.owner, <ControllerTag key="o" ctx={ctx} address={s.acl.owner} />],
        ]} />}
        <GoTo open={open} sub="link" label="ACL & Management → 3. Link in ACL → Set DAO" done={linkDao} />
      </StepCard>

      {/* 4. Production rules */}
      <StepCard n={4} title="Set the production rules" state={st(rulesDone, aclDone)}
        summary={rules ? `${[rules.blacklisted, rules.frozen, rules.frozenLuca].filter(Boolean).length} of 3 set` : 'needs step 1'}>
        {s.acl && s.aclV11 ? <ProductionRulesTable ctx={ctx} luca={luca} /> : <p className="text-xs text-yellow-300">Needs step 1: the rules live in the v1.1.0 ACL.</p>}
      </StepCard>

      {/* 5. Factory */}
      <StepCard n={5} title="Upgrade the Factory" state={st(factoryDone, aclDone)}
        summary={live.factoryNew === null ? '…' : factoryDone ? 'bundled build: asks the ACL on createLink' : 'not the bundled build yet'}>
        <p className="text-xs text-txt-secondary">The new Factory asks <code>acl.checkConnection(…)</code> (found through <code>File.accessControl()</code>) on every <code>createLink</code>. Storage is unchanged. Set the production rules (step 4) first, or frozen and blacklisted wallets can still create connections.</p>
        {s.factory && !aclDone && <p className="text-xs text-red-300">Finish step 1 first: an ACL without <code>checkConnection</code> makes every createLink revert after this upgrade.</p>}
        {s.factory && <UpgradeBlock ctx={ctx} name="Factory" label="Factory implementation" contract="Factory proxy" info={s.factory} done={factoryDone} blocked={!aclDone ? 'Finish step 1 first: the ACL must be the bundled v1.1.0.' : ''} />}
      </StepCard>

      {/* 6. Trader */}
      <StepCard n={6} title="Upgrade the Trader to v1.0.5" state={traderDone ? 'done' : 'optional'}
        summary={s.trader ? `now ${s.trader.version || 'no version()'} → ${TARGET.trader}` : 'Trader not found'}>
        <p className="text-xs text-txt-secondary">
          Fix: on an open 100% LUCA connection, <code>setUserB</code> no longer accepts a blacklisted wallet or a frozen wallet without a safe wallet
          (the ACL check now runs before the zero-reward return). Nothing else changes; storage is the same. The current Trader already works with the new ACL,
          so this step can run any time after step 1.
        </p>
        {s.trader && <UpgradeBlock ctx={ctx} name="Trader" label="Trader v1.0.5 implementation" contract="Trader proxy" info={s.trader} done={traderDone} />}
      </StepCard>
    </div>
  );
}

// Steps 1–3 are done in ACL & Management (1. ACL, 2. ACL DAO, 3. Link in ACL); here they are
// only a status checklist read from the chain, with a link to where the action is.
function StatusRows({ ctx, rows }: { ctx: Ctx; rows: [string, string | undefined, ReactNode][] }) {
  return (
    <div className="space-y-0.5">
      {rows.map(([label, addr, extra]) => <AddrRow key={label} ctx={ctx} label={label} address={addr} name={ctx.nameOf(addr)}>{extra}</AddrRow>)}
    </div>
  );
}

function GoTo({ open, sub, label, done }: { open?: (subTab: string) => void; sub: string; label: string; done: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-txt-secondary">{done ? 'Done. Details and changes in' : 'Do it in'}</span>
      {open ? <button type="button" className="text-accent underline" onClick={() => open(sub)}>{label}</button> : <strong>{label}</strong>}
    </div>
  );
}

// ── Deploy implementation + upgrade, routed by who signs (wallet / Management) ─
function UpgradeBlock({ ctx, name, label, contract, info, done, blocked }: {
  ctx: Ctx; name: 'ATMAccessControl' | 'Factory' | 'Trader'; label: string; contract: string; info: ProxyInfo; done: boolean; blocked?: string;
}) {
  const [impl, setImpl] = useSavedAddr(newImplKey(name), ctx.ns);
  const c = ctx.controllerOf(info.admin);
  const mgmt = c?.kind === 'management';
  const [open, setOpen] = useState<MgmtProposal[]>([]);
  const [rev, setRev] = useState(0);
  const live = sameAddr(impl, info.implementation);
  return (
    <div className="space-y-2">
      <AddrRow ctx={ctx} label="Proxy" address={info.address} name={contract}><Badge tone="accent">{info.version || 'no version()'}</Badge></AddrRow>
      <AddrRow ctx={ctx} label="Implementation now" address={info.implementation} name="" />
      <AddrRow ctx={ctx} label="Upgrade signed by" address={info.admin} name={ctx.nameOf(info.admin)}><ControllerTag ctx={ctx} address={info.admin} /></AddrRow>
      {!done && (
        <>
          <NewImplementation ctx={ctx} name={name} label={label} current={info.implementation} impl={impl} setImpl={setImpl} />
          <ControlledAction ctx={ctx} title={`Upgrade ${contract.replace(' proxy', '')}`} contractName={contract} target={info.address} controller={info.admin}
            kind="upgrade" arg={impl}
            disabled={!isAddr(impl) || live || !!blocked || open.length > 0}
            disabledReason={!!blocked ? blocked : !isAddr(impl) ? 'Deploy the new implementation first (or paste one already deployed).' : live ? 'The proxy already uses this implementation.' : open.length ? `Proposal #${open[0].id} for this upgrade is already open: vote on it below instead of creating another.` : ''}
            confirm={`Upgrade ${contract} ${info.address} to ${impl}?`}
            onDone={() => setRev((r) => r + 1)} />
        </>
      )}
      {mgmt && isAddr(info.admin) && isAddr(impl) && !live && (
        <MgmtVotes ctx={ctx} management={info.admin} target={info.address} addr={impl} rev={rev} onOpen={setOpen} />
      )}
      {done && <p className="text-xs text-green-300">Done. The previous implementation is kept under Rollback below.</p>}
    </div>
  );
}

/** Open Management proposals for exactly this upgrade: votes so far, expiry, and a Vote button for nodes. */
function MgmtVotes({ ctx, management, target, addr, rev, onOpen }: { ctx: Ctx; management: string; target: string; addr: string; rev: number; onOpen: (p: MgmtProposal[]) => void }) {
  const [r, setR] = useState<{ open: MgmtProposal[]; nodes: string[]; now: number } | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    setErr('');
    if (!ctx.provider) return;
    try {
      const x = await findMgmtProposals(ctx.provider, management, { target, addr });
      setR(x); onOpen(x.open);
    } catch (e: any) { setErr(e?.message || String(e)); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.provider, management, target, addr]);
  useEffect(() => { load(); }, [load, rev, tick, ctx.s]);
  if (err) return <p className="text-xs text-red-300">Couldn&apos;t read Management proposals: {err}</p>;
  if (!r) return <p className="text-xs text-txt-secondary">Reading Management proposals…</p>;
  const needed = Math.floor(r.nodes.length / 2) + 1;
  const isNode = r.nodes.some((n) => sameAddr(n, ctx.me));
  const vote = async (p: MgmtProposal) => {
    const m = new ethers.Contract(management, MANAGEMENT_ABI, ctx.signer!);
    const last = p.voters.length + 1 >= needed;
    // the vote that reaches quorum runs the upgrade in the same tx: give it room
    const rc = await ctx.run(`Management: vote on #${p.id}${last ? ' — runs the upgrade' : ''}`, async () => {
      const gas = await m.estimateGas.vote(p.id);
      return m.vote(p.id, { gasLimit: gas.mul(13).div(10) });
    });
    if (rc) setTick((t) => t + 1);
  };
  return (
    <div className="rounded-lg border border-yellow-700/40 bg-yellow-900/10 p-3 space-y-2 text-xs">
      <div className="font-semibold">Management proposal for this upgrade</div>
      {r.open.length === 0 ? (
        <p className="text-txt-secondary">None open yet. A node creates it with the button above; it then needs {needed} of {r.nodes.length} votes within 24h.</p>
      ) : r.open.map((p) => {
        const voted = p.voters.some((v) => sameAddr(v, ctx.me));
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono">#{p.id}</span>
            <Badge tone="warn">open</Badge>
            <span title={p.voters.join('\n')}><strong>{p.voters.length}</strong> of {needed} votes</span>
            <span className="text-txt-secondary">expires <UtcTime inline ts={p.expire} /></span>
            {isNode && !voted && <button className={btnCls} disabled={!ctx.signer} onClick={() => vote(p)}>Vote{p.voters.length + 1 >= needed ? ' (runs it)' : ''}</button>}
            {voted && <Badge tone="good">you voted</Badge>}
            {!isNode && ctx.me && <span className="text-yellow-300">Connect a node wallet to vote.</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── Rollback targets (implementations seen before each upgrade) ──────────────
function Rollback({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const rows = ([
    ['factory', 'Factory proxy', s.factory],
    ['acl', 'ATMAccessControl (ACL) proxy', s.acl],
    ['trader', 'Trader proxy', s.trader],
  ] as const).map(([k, name, info]) => ({ k, name, info }));
  return (
    <Card collapsible title="Rollback" icon={<RotateCcw className="w-5 h-5 text-accent" />}>
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">
          If something is wrong after an upgrade, point the proxy back at its previous implementation. <strong>Roll back the Factory first</strong>, then the ACL
          (an old ACL has no <code>checkConnection</code>, so the new Factory would fail every createLink). The previous implementations are remembered in this browser
          when this tab first sees them; write them down too.
        </p>
        {rows.map(({ k, name, info }) => info && <RollbackRow key={k} ctx={ctx} k={k} name={name} info={info} />)}
      </div>
    </Card>
  );
}

function RollbackRow({ ctx, k, name, info }: { ctx: Ctx; k: string; name: string; info: ProxyInfo }) {
  const [prev] = useSavedAddr(PREV_KEY(k), ctx.ns);
  const [manual, setManual] = useState('');
  const target = manual.trim() || prev;
  const same = sameAddr(target, info.implementation);
  return (
    <div className="rounded-lg border border-white/10 p-3 space-y-1">
      <div className="text-sm font-semibold">{name}</div>
      <AddrRow ctx={ctx} label="Implementation now" address={info.implementation} name="" />
      <AddrRow ctx={ctx} label="Previous (remembered)" address={prev} name="">{same && <Badge tone="muted">in use — nothing to roll back</Badge>}</AddrRow>
      {!same && isAddr(target) && (
        <ControlledAction ctx={ctx} title={`Roll back ${name.replace(' proxy', '')}`} contractName={name} target={info.address} controller={info.admin}
          kind="upgrade" arg={target} confirm={`Point ${name} back to ${target}?`} />
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or another implementation 0x…" className={`${inputCls} max-w-md`} />
      </div>
    </div>
  );
}

// ── 4. Production rules: what the ACL stores now, as tick boxes ───────────────
// Rules live in the ACL: typeInfo(1).defaultBlocked, typeRule(2, action, 0x0, false) and the LUCA
// token rule typeRule(2, JOIN_FULLY_PAID, LUCA, true). Values: 0 not set, 1 allow, 2 block.
interface RuleValues { blackDefault: boolean; frozen: number[]; frozenLuca: number }
const RULE_TEXT = ['not set', 'allow', 'block'];
const RULE_TONE: ('muted' | 'good' | 'bad')[] = ['muted', 'good', 'bad'];
const FROZEN_ACTIONS = [
  { label: 'Create a connection', hint: 'as creator, 100% or any %' },
  { label: 'Join a part-paid connection', hint: 'as user B, paying a part (< 100%)' },
  { label: 'Be user B of a 100% connection', hint: 'creator pays everything, any token' },
];
const RECOMMENDED = { blackBlock: true, frozenBlock: [true, true, true], lucaAllow: true };

async function readRuleValues(provider: ethers.providers.Provider, acl: string, luca: string): Promise<RuleValues> {
  const c = new ethers.Contract(acl, ARTIFACTS.ATMAccessControl.abi, provider);
  const Z = ethers.constants.AddressZero;
  const [info, ...frozen] = await Promise.all([c.typeInfo(1), ...CONNECTION_ACTIONS.map((a) => c.typeRule(2, a, Z, false))]);
  const frozenLuca = isAddr(luca) ? Number(await c.typeRule(2, CONNECTION_ACTIONS[2], luca, true)) : 0;
  return { blackDefault: !!info.defaultBlocked, frozen: frozen.map(Number), frozenLuca };
}

function ProductionRulesTable({ ctx, luca }: { ctx: Ctx; luca: string }) {
  const acl = ctx.s.acl!;
  const owner = acl.owner;
  const [now, setNow] = useState<RuleValues | null>(null);
  const [err, setErr] = useState('');
  const [blackBlock, setBlackBlock] = useState(RECOMMENDED.blackBlock);
  const [frozenBlock, setFrozenBlock] = useState<boolean[]>(RECOMMENDED.frozenBlock);
  const [lucaAllow, setLucaAllow] = useState(RECOMMENDED.lucaAllow);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!ctx.provider) return;
    let cancelled = false;
    setErr('');
    readRuleValues(ctx.provider, acl.address, luca).then((v) => { if (!cancelled) setNow(v); }).catch((e) => { if (!cancelled) setErr(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [ctx.provider, ctx.s, acl.address, luca]);

  if (err) return <p className="text-xs text-red-300">Couldn&apos;t read the rules from the ACL: {err}</p>;
  if (!now) return <p className="text-xs text-txt-secondary">Reading the rules from the ACL…</p>;

  // what the ticks mean on-chain
  const wantFrozen = frozenBlock.map((b) => (b ? 2 : 0));
  const wantLuca = lucaAllow ? 1 : 0;
  const changes: { title: string; text: string; data: string }[] = [];
  if (blackBlock !== now.blackDefault) changes.push({ title: `BLACKLISTED: ${blackBlock ? 'block everything' : 'stop blocking by default'}`, text: `setTypeDefaultBlocked(1, ${blackBlock})`, data: aclIface.encodeFunctionData('setTypeDefaultBlocked', [1, blackBlock]) });
  if (wantFrozen.some((v, i) => v !== now.frozen[i])) changes.push({ title: 'FROZEN: create / join rules', text: `setTypeRules(2, [create, join, join 100%], [${wantFrozen.map((v) => RULE_TEXT[v]).join(', ')}])`, data: aclIface.encodeFunctionData('setTypeRules', [2, CONNECTION_ACTIONS, wantFrozen]) });
  if (isAddr(luca) && wantLuca !== now.frozenLuca) changes.push({ title: `FROZEN: ${lucaAllow ? 'allow' : 'clear'} 100% LUCA as user B`, text: `setTypeTokenRules(2, join 100%, [LUCA], [${RULE_TEXT[wantLuca]}])`, data: aclIface.encodeFunctionData('setTypeTokenRules', [2, CONNECTION_ACTIONS[2], [luca], [wantLuca]]) });

  // effect for a frozen wallet with the ticked settings (token rule > general rule > default allow)
  const frozenCan = (i: number) => wantFrozen[i] !== 2;
  const frozenLucaB = wantLuca === 1 ? true : frozenCan(2);
  const yesNo = (ok: boolean) => <span className={ok ? 'text-green-300' : 'text-red-300'}>{ok ? '✓ allowed' : '✗ blocked'}</span>;
  const isMe = sameAddr(owner, ctx.me);
  const setCount = [now.blackDefault, now.frozen.every((v) => v === 2), now.frozenLuca === 1].filter(Boolean).length;
  const recommendedNow = setCount === 3;
  // a row differs when the ACL doesn't store what is ticked
  const diffBlack = blackBlock !== now.blackDefault;
  const diffFrozen = (i: number) => wantFrozen[i] !== now.frozen[i];
  const diffLuca = isAddr(luca) && wantLuca !== now.frozenLuca;
  const rowCls = (d: boolean) => `border-b border-white/5 align-top ${d ? 'bg-yellow-900/20' : ''}`;

  const applyAll = async () => {
    if (!ctx.signer || !changes.length) return;
    if (!(await confirmDialog({
      title: `Send ${changes.length} production-rule transaction${changes.length > 1 ? 's' : ''}?`,
      details: [
        { label: 'Network', value: `${netName(ctx.ns)} (chainId ${ctx.ns})` },
        { label: 'Contract', value: `ATMAccessControl (ACL) ${acl.address}`, copy: acl.address, mono: true },
        { label: 'Signed by', value: `${owner} (ACL owner, your wallet)`, mono: true },
      ],
      steps: changes.map((c) => <span key={c.title}><b>{c.title}</b><br /><code className="text-xs text-txt-secondary break-all">{c.text}</code></span>),
      confirmLabel: `Send ${changes.length}`,
    }))) return;
    setBusy(true);
    try {
      for (const c of changes) {
        const rc = await ctx.run(`ACL: ${c.title}`, () => ctx.signer!.sendTransaction({ to: acl.address, data: c.data }) as Promise<ethers.ContractTransaction>);
        if (!rc) break;
      }
    } finally { setBusy(false); }
  };

  const cell = (v: number | boolean, kind: 'rule' | 'default') => kind === 'default'
    ? <Badge tone={v ? 'bad' : 'muted'}>{v ? 'block all' : 'not blocked'}</Badge>
    : <Badge tone={RULE_TONE[v as number]}>{RULE_TEXT[v as number]}</Badge>;
  const tick = (checked: boolean, onChange: (v: boolean) => void, label: string) => (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent,#f5c542)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="space-y-3">
      {recommendedNow ? (
        <div className="rounded-lg border border-green-700/40 bg-green-900/20 p-3 text-sm">
          <span className="text-green-300 font-semibold">✓ Configured on-chain: 3 of 3 production rules set</span>
          <span className="text-xs text-txt-secondary"> (stored in the ACL {short(acl.address)}). Blacklisted wallets are blocked from everything; frozen wallets can only be user B of a 100% LUCA connection.</span>
        </div>
      ) : (
        <div className="rounded-lg border border-yellow-700/40 bg-yellow-900/20 p-3 text-sm">
          <span className="text-yellow-300 font-semibold">✗ {setCount} of 3 production rules set: apply below</span>
          <span className="text-xs text-txt-secondary"> (stored in the ACL {short(acl.address)}). Until they are set, frozen and blacklisted wallets can still create connections after the Factory upgrade. Highlighted rows are what will change.</span>
        </div>
      )}
      {recommendedNow && !editing && (
        <button type="button" className="text-xs underline text-txt-secondary hover:text-txt-primary" onClick={() => setEditing(true)}>Change these rules…</button>
      )}
      {(!recommendedNow || editing) && (<>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-txt-secondary text-left">
            <tr className="border-b border-white/10"><th className="py-1.5 pr-3">Wallet type</th><th className="pr-3">Action</th><th className="pr-3">In the ACL now</th><th className="pr-3">Your setting</th><th>After applying</th></tr>
          </thead>
          <tbody>
            <tr className={rowCls(diffBlack)}>
              <td className="py-2 pr-3 font-semibold">BLACKLISTED</td>
              <td className="pr-3">Every action, to and from<div className="text-txt-secondary">also actions added later</div></td>
              <td className="pr-3">{cell(now.blackDefault, 'default')}</td>
              <td className="pr-3">{tick(blackBlock, setBlackBlock, 'Block everything')}</td>
              <td>{yesNo(!blackBlock)}</td>
            </tr>
            {FROZEN_ACTIONS.map((a, i) => (
              <tr key={a.label} className={rowCls(diffFrozen(i))}>
                <td className="py-2 pr-3 font-semibold">{i === 0 ? 'FROZEN' : ''}</td>
                <td className="pr-3">{a.label}<div className="text-txt-secondary">{a.hint}</div></td>
                <td className="pr-3">{cell(now.frozen[i], 'rule')}</td>
                <td className="pr-3">{tick(frozenBlock[i], (v) => setFrozenBlock((x) => x.map((y, j) => (j === i ? v : y))), 'Block')}</td>
                <td>{yesNo(frozenCan(i))}</td>
              </tr>
            ))}
            <tr className={`align-top ${diffLuca ? 'bg-yellow-900/20' : ''}`}>
              <td className="py-2 pr-3" />
              <td className="pr-3">↳ Exception: user B of a <strong>100% LUCA</strong> connection<div className="text-txt-secondary">LUCA {isAddr(luca) ? short(luca) : 'not found on this network'}</div></td>
              <td className="pr-3">{cell(now.frozenLuca, 'rule')}</td>
              <td className="pr-3">{isAddr(luca) ? tick(lucaAllow, setLucaAllow, 'Allow') : '—'}</td>
              <td>{yesNo(frozenLucaB)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" className="underline text-txt-secondary hover:text-txt-primary" onClick={() => { setBlackBlock(RECOMMENDED.blackBlock); setFrozenBlock(RECOMMENDED.frozenBlock); setLucaAllow(RECOMMENDED.lucaAllow); }}>Reset to recommended</button>
        <button type="button" className="underline text-txt-secondary hover:text-txt-primary" onClick={() => { setBlackBlock(now.blackDefault); setFrozenBlock(now.frozen.map((v) => v === 2)); setLucaAllow(now.frozenLuca === 1); }}>Match what the ACL has</button>
      </div>

      {changes.length === 0 ? (
        <p className="text-xs text-green-300">Nothing to send: the ACL already stores these settings.</p>
      ) : (
        <div className="rounded-lg border border-white/10 bg-surface-tertiary/40 p-3 space-y-2">
          <div className="text-sm font-semibold">{changes.length} change{changes.length > 1 ? 's' : ''} to send (ACL owner)</div>
          <ol className="list-decimal pl-5 text-xs space-y-0.5">
            {changes.map((c) => <li key={c.title}><span className="font-semibold">{c.title}</span> <span className="font-mono text-txt-secondary">{c.text}</span></li>)}
          </ol>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-txt-secondary">Signed by</span>
            <span className="font-mono">{owner}</span>
            <ControllerTag ctx={ctx} address={owner} />
          </div>
          {isMe ? (
            <button type="button" className={btnCls} disabled={busy || !ctx.signer} onClick={applyAll}>
              {busy ? 'Sending…' : `Apply ${changes.length} change${changes.length > 1 ? 's' : ''} (${changes.length} transaction${changes.length > 1 ? 's' : ''})`}
            </button>
          ) : (
            // not the owner: one routed action per change (Management proposal / copyable request)
            <div className="space-y-2">
              {changes.map((c) => (
                <ControlledAction key={c.title} ctx={ctx} title={c.title} contractName="ATMAccessControl (ACL) proxy" target={acl.address} controller={owner} kind="call" data={c.data} />
              ))}
            </div>
          )}
        </div>
      )}
      {recommendedNow && editing && <button type="button" className="text-xs underline text-txt-secondary hover:text-txt-primary" onClick={() => setEditing(false)}>Hide</button>}
      </>)}
    </div>
  );
}

// ── Upgrade checklist: everything that must be true, read from the chain + manual ticks ──
interface ChainChecks {
  daoFile: string; daoAcl: string; verifierOff: boolean | null; daoUnpaused: boolean | null;
  aclDaoUnpaused: boolean | null; fileAcl: string; normalAllowed: boolean | null;
}
const MANUAL_KEY = (ns: number) => `dg_upgraderManualChecks_${ns}`;

function UpgradeChecklist({ ctx, live }: { ctx: Ctx; live: Live }) {
  const { s } = ctx;
  const [c, setC] = useState<ChainChecks | null>(null);
  const [manual, setManual] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setManual(JSON.parse(localStorage.getItem(MANUAL_KEY(ctx.ns)) || '{}')); } catch { setManual({}); }
  }, [ctx.ns]);
  const tickManual = (k: string, v: boolean) => setManual((m) => {
    const n = { ...m, [k]: v };
    try { localStorage.setItem(MANUAL_KEY(ctx.ns), JSON.stringify(n)); } catch { /* not remembered */ }
    return n;
  });

  useEffect(() => {
    if (!ctx.provider) return;
    let cancelled = false;
    const p = ctx.provider;
    const str = (x: Promise<any>) => x.then(String).catch(() => '');
    const bool = (x: Promise<any>) => x.then((v: any) => !!v).catch(() => null);
    (async () => {
      const dao = s.dao ? new ethers.Contract(s.dao.address, ARTIFACTS.ATMAccessControlDAO.abi, p) : null;
      const acl = s.acl && s.aclV11 ? new ethers.Contract(s.acl.address, ARTIFACTS.ATMAccessControl.abi, p) : null;
      const file = s.file ? new ethers.Contract(s.file.address, ['function accessControl() view returns (address)'], p) : null;
      const someone = ethers.Wallet.createRandom().address; // a wallet with no type: must always be allowed
      const [daoFile, daoAcl, vEnabled, daoPaused, aclDaoPaused, fileAcl, normal] = await Promise.all([
        dao ? str(dao.file()) : Promise.resolve(''),
        dao ? str(dao.acl()) : Promise.resolve(''),
        dao ? bool(dao.verifierVoteEnabled()) : Promise.resolve(null),
        dao ? bool(dao.paused()) : Promise.resolve(null),
        acl ? bool(acl.daoPaused()) : Promise.resolve(null),
        file ? str(file.accessControl()) : Promise.resolve(''),
        acl ? acl.canCreateConnection(someone, ethers.constants.AddressZero, ethers.constants.AddressZero, ethers.utils.parseEther('0.001'), 50, 30).then((r: any) => !!r.allowed).catch(() => null) : Promise.resolve(null),
      ]);
      if (!cancelled) setC({
        daoFile, daoAcl, verifierOff: vEnabled === null ? null : !vEnabled, daoUnpaused: daoPaused === null ? null : !daoPaused,
        aclDaoUnpaused: aclDaoPaused === null ? null : !aclDaoPaused, fileAcl, normalAllowed: normal,
      });
    })();
    return () => { cancelled = true; };
  }, [ctx.provider, s]);

  const rules = live.rules;
  // null = can't tell yet (still loading, or an earlier item is missing)
  const auto: { step: string; text: string; ok: boolean | null; detail?: string }[] = [
    { step: '1', text: 'ACL is the bundled v1.1.0 build', ok: live.aclBundled, detail: s.acl ? `${s.acl.version || 'no version()'} · impl ${short(s.acl.implementation)}` : 'ACL not found' },
    { step: '1', text: 'File.accessControl() is this ACL', ok: !c ? null : !!s.acl && sameAddr(c.fileAcl, s.acl.address), detail: c ? `File → ${short(c.fileAcl) || '—'}` : '' },
    { step: '2', text: 'ACL DAO is deployed', ok: !!s.dao, detail: s.dao ? `${s.dao.version || '…'} at ${short(s.dao.address)}` : 'not deployed' },
    { step: '2', text: 'DAO reads the ACL through File (file() = File, acl() = this ACL)', ok: !s.dao ? false : !c ? null : sameAddr(c.daoFile, s.file?.address) && sameAddr(c.daoAcl, s.acl?.address), detail: c && s.dao ? `file ${short(c.daoFile) || '—'} · acl ${short(c.daoAcl) || '—'}` : '' },
    { step: '2', text: 'Verifier vote is off (until that flow is decided)', ok: !s.dao ? false : c?.verifierOff ?? null },
    { step: '2', text: 'DAO is not paused', ok: !s.dao ? false : c?.daoUnpaused ?? null },
    { step: '3', text: 'ACL.dao() is the DAO', ok: !!s.dao && sameAddr(s.aclDao, s.dao.address), detail: `ACL.dao() = ${short(s.aclDao) || '—'}` },
    { step: '3', text: 'ACL DAO hooks are not paused', ok: !s.aclV11 ? false : c?.aclDaoUnpaused ?? null },
    { step: '4', text: 'BLACKLISTED: blocked from everything', ok: rules ? rules.blacklisted : false },
    { step: '4', text: 'FROZEN: cannot create or join connections', ok: rules ? rules.frozen : false },
    { step: '4', text: 'FROZEN: may be user B of a 100% LUCA connection', ok: rules ? rules.frozenLuca : false },
    { step: '4', text: 'A wallet with no type can create a connection', ok: !s.aclV11 ? false : c?.normalAllowed ?? null },
    { step: '5', text: 'Factory is the bundled build (asks the ACL on createLink)', ok: live.factoryNew, detail: s.factory ? `impl ${short(s.factory.implementation)}` : '' },
    { step: '6', text: 'Trader is the bundled v1.0.5 build', ok: live.traderBundled, detail: s.trader ? `${s.trader.version || 'no version()'} · impl ${short(s.trader.implementation)}` : '' },
  ];
  const mgmt = [s.acl?.admin, s.acl?.owner, s.factory?.admin, s.trader?.admin].some((a) => ctx.controllerOf(a)?.kind === 'management');
  const manualItems: { k: string; text: string }[] = [
    { k: 'rollback', text: 'Wrote down the old implementations (see Rollback below)' },
    { k: 'daoAdmin', text: `DAO proxy admin is the wallet / multisig that should upgrade it${s.dao?.admin ? ` (now ${short(s.dao.admin)})` : ''}` },
    ...(mgmt ? [{ k: 'nodes', text: 'Management node holders are ready to vote within 24h (Factory, Trader)' }] : []),
    { k: 'tests', text: 'Ran test plan A–G with fresh wallets (docs/acl-v1.1.0-deploy-and-test.md)' },
  ];
  const autoDone = auto.filter((a) => a.ok === true).length;
  const manualDone = manualItems.filter((m) => manual[m.k]).length;
  const missing = auto.filter((a) => a.ok === false);
  const all = autoDone === auto.length && manualDone === manualItems.length;

  return (
    <Card collapsible defaultOpen icon={<ClipboardCheck className="w-5 h-5 text-accent" />}
      title={<span className="inline-flex flex-wrap items-center gap-2">Upgrade checklist {all ? <Badge tone="good">nothing missing</Badge> : <Badge tone="warn">{auto.length - autoDone + manualItems.length - manualDone} open</Badge>}
        <span className="text-sm text-txt-secondary font-normal">{autoDone} of {auto.length} on-chain · {manualDone} of {manualItems.length} manual</span></span>}>
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">On-chain items tick themselves from what the contracts return now; they can&apos;t be ticked by hand. Manual items are for what the chain can&apos;t show and are remembered in this browser for {netName(ctx.ns)}.</p>
        {missing.length > 0 && <p className="text-xs text-yellow-300">Missing: {missing.map((m) => `${m.text} (step ${m.step})`).join(' · ')}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-txt-secondary text-left"><tr className="border-b border-white/10"><th className="py-1.5 pr-2 w-8" /><th className="pr-3 w-12">Step</th><th className="pr-3">Check (read from the chain)</th><th>Now</th></tr></thead>
            <tbody>
              {auto.map((a) => (
                <tr key={a.text} className="border-b border-white/5">
                  <td className="py-1.5 pr-2">{a.ok === true ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : a.ok === false ? <XCircle className="w-4 h-4 text-red-400" /> : <Loader2 className="w-4 h-4 animate-spin text-txt-secondary" />}</td>
                  <td className="pr-3 text-txt-secondary">{a.step}</td>
                  <td className={`pr-3 ${a.ok === false ? 'text-txt-primary' : ''}`}>{a.text}</td>
                  <td className="text-txt-secondary font-mono">{a.detail || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Manual</div>
          {manualItems.map((m) => (
            <label key={m.k} className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input type="checkbox" className="w-4 h-4" checked={!!manual[m.k]} onChange={(e) => tickManual(m.k, e.target.checked)} />
              <span className={manual[m.k] ? 'text-txt-secondary line-through' : ''}>{m.text}</span>
            </label>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Test Factory (BSC testnet only) ────────────────────────────────────────────
// When the real Factory can't be upgraded yet (its admin isn't available), deploy a SEPARATE Factory
// proxy that uses the same File and ACL. File is NOT changed, so the live Factory and its Links are
// untouched. Factory.addToken is onlyFile, so this Factory only knows the native coin (BNB) that its
// initialize registers. BNB connections work end to end (create, agree, close, withdraw don't use the
// Trader); LUCA connections, AGT and Pledge need the real Factory.
const TEST_FACTORY_KEY = 'dg_testFactory';
const NATIVE = 'BNB';
type StepRun = 'idle' | 'running' | 'done' | 'failed';

function TestFactoryCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const [testF, setTestF] = useSavedAddr(TEST_FACTORY_KEY, ctx.ns);
  const [savedImpl] = useSavedAddr(newImplKey('Factory'), ctx.ns);
  const [impl, setImpl] = useState('');
  const [implOk, setImplOk] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<StepRun[]>(['idle', 'idle', 'idle']);
  const [info, setInfo] = useState<{ file: string; bnb: boolean; admin: string; implementation: string; totalLink: string } | null>(null);
  const [rev, setRev] = useState(0);
  const fileAddr = s.file?.address || '';

  useEffect(() => { if (!impl && isAddr(savedImpl)) setImpl(savedImpl); }, [savedImpl, impl]);
  // the implementation must be a Factory that asks the ACL (any build of the new Factory)
  useEffect(() => {
    setImplOk(null);
    if (!ctx.provider || !isAddr(impl)) return;
    let cancelled = false;
    factoryChecksAcl(ctx.provider, impl).then((v) => { if (!cancelled) setImplOk(v); });
    return () => { cancelled = true; };
  }, [ctx.provider, impl]);
  // live state of the test Factory
  useEffect(() => {
    setInfo(null);
    if (!ctx.provider || !isAddr(testF)) return;
    let cancelled = false;
    (async () => {
      const f = new ethers.Contract(testF, ARTIFACTS.Factory.abi, ctx.provider!);
      const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
      const slot = async (k: string) => { const v = await ctx.provider!.getStorageAt(testF, k); return /^0x0*$/.test(v) ? '' : ethers.utils.getAddress('0x' + v.slice(26)); };
      const [file, bnb, implementation, admin, total] = await Promise.all([
        f.file().then(String).catch(() => ''), f.tokenMap(NATIVE).then((t: any) => !!t.isActive).catch(() => false),
        slot(SLOT_IMPL), slot(SLOT_ADMIN), f.totalLink().then(String).catch(() => '?'),
      ]);
      if (!cancelled) setInfo({ file, bnb, admin, implementation, totalLink: total });
    })();
    return () => { cancelled = true; };
  }, [ctx.provider, testF, rev, ctx.s]);

  const setRun = (i: number, v: StepRun) => setRuns((r) => r.map((x, j) => (j === i ? v : x)));
  const configured = !!info && sameAddr(info.file, fileAddr) && info.bnb;

  // one click: deploy the proxy, initialize it straight away (initialize is open until called), verify
  const deployAndConfigure = async () => {
    if (!ctx.signer || !isAddr(impl) || !implOk || !isAddr(fileAddr)) return;
    if (!(await confirmDialog({
      title: `Deploy a TEST Factory on ${netName(ctx.ns)}?`,
      details: [
        { label: 'Implementation', value: impl, copy: impl, mono: true },
        { label: 'File', value: fileAddr, copy: fileAddr, mono: true },
        { label: 'Proxy admin', value: `${ctx.me} (your wallet)`, mono: true },
      ],
      steps: [
        <>Deploy <code>FactoryPorxy({short(impl)})</code> — your wallet becomes its admin</>,
        <><code>initialize(&quot;{NATIVE}&quot;, File {short(fileAddr)})</code></>,
        'Read it back from the chain: file() and native token set',
      ],
      message: 'File is not changed: the live Factory and its connections are untouched.',
      confirmLabel: 'Deploy and configure',
    }))) return;
    setRuns(['running', 'idle', 'idle']);
    const proxy = await ctx.deploy('Test Factory: deploy proxy', 'FactoryPorxy', [impl]);
    if (!proxy) { setRun(0, 'failed'); return; }
    setRun(0, 'done'); setTestF(proxy); setRun(1, 'running');
    const rc = await ctx.run('Test Factory: initialize', () => new ethers.Contract(proxy, ARTIFACTS.Factory.abi, ctx.signer!).initialize(NATIVE, fileAddr));
    if (!rc) { setRun(1, 'failed'); return; }
    setRun(1, 'done'); setRun(2, 'running');
    const f = new ethers.Contract(proxy, ARTIFACTS.Factory.abi, ctx.provider!);
    const ok = sameAddr(await f.file().catch(() => ''), fileAddr) && !!(await f.tokenMap(NATIVE).catch(() => ({ isActive: false }))).isActive;
    setRun(2, ok ? 'done' : 'failed'); setRev((x) => x + 1);
  };
  const runIcon = (r: StepRun) => r === 'done' ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : r === 'failed' ? <XCircle className="w-4 h-4 text-red-400" /> : r === 'running' ? <Loader2 className="w-4 h-4 animate-spin text-accent" /> : <Circle className="w-4 h-4 text-txt-secondary" />;
  const forUiTeam = isAddr(testF) ? [
    `BSC testnet (97) TEST Factory for the ACL v1.1.0 connection rules`,
    `Factory: ${testF}  (use instead of the live Factory ${s.factory?.address || ''} for these tests)`,
    `File: ${fileAddr} (unchanged)   ACL: ${s.acl?.address || ''}`,
    `Tokens: ${NATIVE} (native) any time; LUCA / BUSD only while a "LUCA test session" is on (File pointed at this Factory; the admin announces it).`,
    `Works end to end for BNB: createLink, agree, setUserB, close, withdraw. Frozen / blacklisted wallets are refused by createLink.`,
    `Use throwaway test wallets for LUCA/BUSD session connections: after the session they can't use the Trader any more.`,
    `Connections made here are listed by this Factory only (LinkCreated events from ${testF}).`,
  ].join('\n') : '';

  return (
    <Card collapsible defaultOpen={!configured} icon={<FlaskConical className="w-5 h-5 text-accent" />}
      title={<span className="inline-flex flex-wrap items-center gap-2">Test Factory <Badge tone="muted">testnet only</Badge> {configured ? <Badge tone="good">configured</Badge> : isAddr(testF) ? <Badge tone="warn">check setup</Badge> : <Badge tone="accent">not deployed</Badge>}
        <span className="text-sm text-txt-secondary font-normal">for testing the connection rules before the real Factory is upgraded</span></span>}>
      <div className="space-y-3 text-xs">
        <p className="text-txt-secondary">
          A <strong>separate</strong> Factory that uses the same File and ACL, for testing while the real Factory&apos;s admin isn&apos;t available. File&apos;s code is never changed;
          only its <code>factory</code> setting is switched briefly by <strong>Config: tokens</strong> below (to add tokens, or for a LUCA test session) and switched back.
          <strong> BNB</strong> connections work on it any time, end to end (create, agree, setUserB, close, withdraw), and frozen / blacklisted wallets are refused.
          <strong> LUCA / BUSD</strong> connections need a LUCA test session (the Trader only trusts <code>File.factory()</code>). AGT and Pledge on the live connections still need the real Factory upgrade.
        </p>

        {!configured && (
          <div className="rounded-lg border border-white/10 bg-surface-tertiary/40 p-3 space-y-2">
            <div className="text-sm font-semibold">Deploy &amp; configure (one click, 2 transactions)</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-txt-secondary w-36">Factory implementation</span>
              <input value={impl} onChange={(e) => setImpl(e.target.value.trim())} placeholder="0x… (new Factory implementation)" className={`${inputCls} max-w-md`} />
              {implOk === true && <Badge tone="good">new Factory code (asks the ACL)</Badge>}
              {implOk === false && <Badge tone="bad">not the new Factory code</Badge>}
            </div>
            {!isAddr(impl) && <NewImplementation ctx={ctx} name="Factory" label="Factory implementation" current={s.factory?.implementation} impl={impl} setImpl={setImpl} />}
            <AddrRow ctx={ctx} label="File (unchanged)" address={fileAddr} />
            <ol className="space-y-1">
              {['Deploy FactoryPorxy(implementation): your wallet becomes its admin', `initialize("${NATIVE}", File)`, `Check on-chain: file() = File and ${NATIVE} is active`].map((t, i) => (
                <li key={t} className="flex items-center gap-2">{runIcon(runs[i])}<span>{i + 1}. {t}</span></li>
              ))}
            </ol>
            <button type="button" className={btnCls} disabled={!ctx.signer || !isAddr(impl) || !implOk || !isAddr(fileAddr) || runs.includes('running')} onClick={deployAndConfigure}>
              {runs.includes('running') ? 'Working…' : 'Deploy & configure test Factory'}
            </button>
            <p className="text-txt-secondary">Your wallet confirms each transaction. They run straight after each other because <code>initialize</code> is open to anyone until it&apos;s called; step 3 checks it was initialised with this File.</p>
          </div>
        )}

        {isAddr(testF) && (
          <div className="space-y-1">
            <AddrRow ctx={ctx} label="Test Factory" address={testF} name="Test Factory proxy">
              <button type="button" className="text-xs text-txt-secondary hover:text-txt-primary underline" onClick={async () => { if (await confirmDialog({ title: 'Forget this test Factory?', message: 'It is removed from this browser only — the contract stays on-chain.', details: [{ label: 'Test Factory', value: testF, copy: testF, mono: true }], confirmLabel: 'Forget' })) { setTestF(''); setRuns(['idle', 'idle', 'idle']); } }}>forget</button>
            </AddrRow>
            {!info ? <p className="text-txt-secondary">Reading it from the chain…</p> : (
              <>
                <div className="flex items-center gap-2">{sameAddr(info.file, fileAddr) ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}<span>file() = File {short(fileAddr)}{!sameAddr(info.file, fileAddr) && ` (it is ${short(info.file) || 'not set'}: someone else initialised it; deploy a new one)`}</span></div>
                <div className="flex items-center gap-2">{info.bnb ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}<span>{NATIVE} is active</span></div>
                <AddrRow ctx={ctx} label="Implementation" address={info.implementation} name="" />
                <AddrRow ctx={ctx} label="Admin" address={info.admin} name=""><ControllerTag ctx={ctx} address={info.admin} /></AddrRow>
                <div className="text-txt-secondary">Connections created on it: {info.totalLink}</div>
                {configured && <div className="flex flex-wrap items-center gap-2 pt-1"><CopyButton text={forUiTeam} title="Copy the details for the UI team" label="Copy details for the UI team" /></div>}
              </>
            )}
            {configured && <TestFactoryTokens ctx={ctx} testF={testF} />}
            {configured && <DryRun ctx={ctx} factory={testF} />}
          </div>
        )}
      </div>
    </Card>
  );
}

/** No-gas check: what the ACL answers for a creator / user B, i.e. what createLink on this Factory will do. */
function DryRun({ ctx, factory }: { ctx: Ctx; factory: string }) {
  const [creator, setCreator] = useState('');
  const [userB, setUserB] = useState('');
  const [pct, setPct] = useState('50');
  const [res, setRes] = useState('');
  const DENY = ['allowed', 'creator blocked by a rule', 'user B blocked by a rule', 'lock days outside the limit', 'amount outside the limit', 'creator % outside the limit', 'outside the date range'];
  const check = async () => {
    setRes('');
    if (!ctx.provider || !ctx.s.acl || !isAddr(creator)) return;
    try {
      const acl = new ethers.Contract(ctx.s.acl.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider);
      const r = await acl.checkConnection(creator, isAddr(userB) ? userB : ethers.constants.AddressZero, ethers.constants.AddressZero, ethers.utils.parseEther('0.01'), Number(pct), 30);
      setRes(r.allowed ? '✓ allowed: createLink on the test Factory will go through' : `✗ refused (${DENY[Number(r.reason)] || `reason ${r.reason}`}): createLink reverts with "Factory: connection not allowed"`);
    } catch (e: any) { setRes(`Couldn't check: ${e?.reason || e?.message || e}`); }
  };
  return (
    <div className="rounded-lg border border-white/10 p-3 space-y-2 mt-2">
      <div className="text-sm font-semibold">Dry run (no gas): would this connection be allowed?</div>
      <p className="text-txt-secondary">Asks the ACL exactly what {short(factory)} asks on <code>createLink</code> (BNB, 0.01, 30 days).</p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={creator} onChange={(e) => setCreator(e.target.value.trim())} placeholder="Creator 0x…" className={`${inputCls} max-w-xs`} />
        {ctx.me && <button type="button" className="text-accent underline" onClick={() => setCreator(ctx.me)}>me</button>}
        <input value={userB} onChange={(e) => setUserB(e.target.value.trim())} placeholder="User B 0x… (optional)" className={`${inputCls} max-w-xs`} />
        <select value={pct} onChange={(e) => setPct(e.target.value)} className={`${inputCls} w-28`}>
          <option value="50">50%</option><option value="100">100%</option><option value="70">70%</option>
        </select>
        <button type="button" className={btnCls} disabled={!isAddr(creator)} onClick={check}>Check</button>
      </div>
      {res && <p className={res.startsWith('✓') ? 'text-green-300' : 'text-red-300'}>{res}</p>}
    </div>
  );
}

// ── Test Factory: add the live Factory's tokens (via File) + LUCA test session ────────────────
// Factory.addToken is onlyFile and File.addToken always targets File.factory(), so adding a token to
// the test Factory means: point File at it, addToken, point File back. ERC-20 connections also move
// tokens through the Trader, which only trusts File.factory(): LUCA / BUSD connections on the test
// Factory work only while File points at it (a "test session"), and during that time the live
// Factory's connections can't use the Trader. Always end the session.
const FILE_MODULE_ABI = ['function owner() view returns (address)', 'function factory() view returns (address)', 'function fileModule(bytes32 item, address addr)', 'function addToken(address addr, uint256 min)'];
const TOKEN_CANDIDATES = ['LUCA', 'BUSD', 'ETH', 'BTCB', 'USDT', 'USDC'];
const FACTORY_KEY = ethers.utils.formatBytes32String('factory');

function TestFactoryTokens({ ctx, testF }: { ctx: Ctx; testF: string }) {
  const liveF = LINK_ADDRESSES[ctx.ns]?.factory || '';
  const fileAddr = ctx.s.file?.address || '';
  const [st, setSt] = useState<{ owner: string; fileFactory: string; tokens: { sym: string; addr: string; min: ethers.BigNumber; onTest: boolean }[] } | null>(null);
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!ctx.provider || !isAddr(fileAddr) || !isAddr(liveF)) return;
    let cancelled = false;
    (async () => {
      const file = new ethers.Contract(fileAddr, FILE_MODULE_ABI, ctx.provider!);
      const live = new ethers.Contract(liveF, ARTIFACTS.Factory.abi, ctx.provider!), test = new ethers.Contract(testF, ARTIFACTS.Factory.abi, ctx.provider!);
      const [owner, fileFactory] = await Promise.all([file.owner(), file.factory()]);
      const rows = await Promise.all(TOKEN_CANDIDATES.map(async (sym) => {
        const [l, t] = await Promise.all([live.tokenMap(sym).catch(() => null), test.tokenMap(sym).catch(() => null)]);
        return l?.isActive ? { sym, addr: l.addr as string, min: l.minAmount as ethers.BigNumber, onTest: !!t?.isActive } : null;
      }));
      if (!cancelled) setSt({ owner, fileFactory, tokens: rows.filter(Boolean) as any });
    })().catch(() => { /* shown as loading */ });
    return () => { cancelled = true; };
  }, [ctx.provider, fileAddr, liveF, testF, rev, ctx.s]);

  if (!st) return <p className="text-txt-secondary mt-2">Reading File and the tokens…</p>;
  const isOwner = sameAddr(st.owner, ctx.me);
  const onTest = sameAddr(st.fileFactory, testF), onLive = sameAddr(st.fileFactory, liveF);
  const missing = st.tokens.filter((t) => !t.onTest);
  const file = ctx.signer ? new ethers.Contract(fileAddr, FILE_MODULE_ABI, ctx.signer) : null;
  const point = (to: string, label: string) => ctx.run(label, () => file!.fileModule(FACTORY_KEY, to));

  const addTokens = async () => {
    if (!file || !missing.length) return;
    if (!(await confirmDialog({
      title: `Add ${missing.map((t) => t.sym).join(', ')} to the test Factory?`,
      details: [
        { label: 'File', value: fileAddr, copy: fileAddr, mono: true },
        { label: 'Test Factory', value: testF, copy: testF, mono: true },
        { label: 'Live Factory', value: liveF, copy: liveF, mono: true },
      ],
      steps: [
        <>File.factory → test Factory {short(testF)}</>,
        ...missing.map((t) => <>File.addToken({t.sym} <span className="font-mono">{short(t.addr)}</span>, min {t.min.toString()})</>),
        <>File.factory → live Factory {short(liveF)}</>,
      ],
      warning: "While File points at the test Factory (these few blocks), live connections can't use the Trader. Confirm every transaction so File is pointed back.",
      danger: true,
      confirmLabel: `Send ${missing.length + 2} transactions`,
    }))) return;
    setBusy('add');
    try {
      if (!onTest && !(await point(testF, 'File: point at the test Factory'))) return;
      for (const t of missing) { if (!(await ctx.run(`File: addToken ${t.sym} to the test Factory`, () => file.addToken(t.addr, t.min)))) break; }
    } finally {
      // always try to point File back at the live Factory
      await point(liveF, 'File: point back at the live Factory');
      setBusy(''); setRev((x) => x + 1);
    }
  };
  const session = async (start: boolean) => {
    if (!file) return;
    if (start && !(await confirmDialog({
      title: 'Start a LUCA test session?',
      message: <>Points <code>File.factory</code> at the test Factory.</>,
      details: [
        { label: 'File', value: fileAddr, copy: fileAddr, mono: true },
        { label: 'Test Factory', value: testF, copy: testF, mono: true },
        { label: 'Live Factory', value: liveF, copy: liveF, mono: true },
      ],
      items: [
        <>This changes File for <b>everyone</b> on {netName(ctx.ns)}: every app and backend using this File creates connections through the test Factory while the session is on.</>,
        "The live Factory's connections (payouts, close, withdraw, AGT, Pledge) can't use the Trader.",
        'Connections created during the session belong to the test Factory: after you restore File, the Trader and Pledge stop trusting them.',
      ],
      warning: "End the session as soon as you're done.",
      danger: true,
      confirmLabel: 'Start session',
    }))) return;
    setBusy(start ? 'start' : 'end');
    await point(start ? testF : liveF, start ? 'File: start LUCA test session (→ test Factory)' : 'File: end test session (→ live Factory)');
    setBusy(''); setRev((x) => x + 1);
  };

  return (
    <div className="rounded-lg border border-white/10 p-3 space-y-2 mt-2">
      <div className="text-sm font-semibold">Config: tokens</div>
      {onTest ? (
        <div className="rounded-lg border border-red-700/50 bg-red-900/30 p-2 space-y-1">
          <div className="text-red-300 font-semibold">⚠ File points at the TEST Factory ({short(testF)}): LUCA test session is ON</div>
          <div className="text-txt-secondary">This is the same for <strong>everyone on BSC testnet</strong>: apps and backends using this File create connections through the test Factory now, and the live Factory&apos;s connections can&apos;t use the Trader (payouts, close, withdraw, AGT, Pledge). Connections created during the session belong to the test Factory, so after restoring, the Trader and Pledge stop trusting them. The Factory step above also points at the test Factory until you restore. End the session when you&apos;re done.</div>
          {isOwner ? <button type="button" className={btnCls} disabled={!!busy} onClick={() => session(false)}>{busy === 'end' ? 'Restoring…' : `End session: point File back at the live Factory ${short(liveF)}`}</button>
            : <p className="text-yellow-300">Connect File&apos;s owner {short(st.owner)} to end it.</p>}
        </div>
      ) : onLive ? (
        <div className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-400" /><span>File points at the live Factory {short(liveF)} (normal)</span></div>
      ) : (
        <div className="text-red-300">File.factory() is {short(st.fileFactory)}: neither the live nor this test Factory.</div>
      )}
      <table className="w-full">
        <thead className="text-txt-secondary text-left"><tr className="border-b border-white/10"><th className="py-1 pr-3">Token (from the live Factory)</th><th className="pr-3">Address</th><th className="pr-3">Min</th><th>On the test Factory</th></tr></thead>
        <tbody>
          <tr className="border-b border-white/5"><td className="py-1 pr-3 font-semibold">BNB</td><td className="pr-3 text-txt-secondary">native</td><td className="pr-3">100</td><td><Badge tone="good">yes</Badge></td></tr>
          {st.tokens.map((t) => (
            <tr key={t.sym} className="border-b border-white/5"><td className="py-1 pr-3 font-semibold">{t.sym}</td><td className="pr-3 font-mono">{short(t.addr)}</td><td className="pr-3">{t.min.toString()}</td><td>{t.onTest ? <Badge tone="good">yes</Badge> : <Badge tone="warn">no</Badge>}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-txt-secondary">Signed by File&apos;s owner</span><span className="font-mono">{st.owner}</span><ControllerTag ctx={ctx} address={st.owner} />
      </div>
      {missing.length > 0 && (isOwner
        ? <button type="button" className={btnCls} disabled={!!busy} onClick={addTokens}>{busy === 'add' ? 'Working…' : `Add ${missing.map((t) => t.sym).join(', ')} (${missing.length + 2} transactions, File pointed back at the end)`}</button>
        : <p className="text-yellow-300">Connect File&apos;s owner {short(st.owner)} to add tokens.</p>)}
      {missing.length === 0 && <p className="text-green-300">The test Factory has every token the live Factory has.</p>}
      <p className="text-txt-secondary">
        BNB connections work on the test Factory any time. <strong>{st.tokens.map((t) => t.sym).join(' / ') || 'ERC-20'} connections only work during a LUCA test session</strong> (File pointed at the test Factory),
        because they move tokens through the Trader, which only trusts <code>File.factory()</code>. During a session the live Factory&apos;s connections can&apos;t use the Trader, so keep it short.
      </p>
      {!onTest && isOwner && st.tokens.some((t) => t.onTest) && (
        <button type="button" className="text-xs underline text-yellow-300" disabled={!!busy} onClick={() => session(true)}>{busy === 'start' ? 'Starting…' : 'Start a LUCA test session (point File at the test Factory)'}</button>
      )}
    </div>
  );
}
