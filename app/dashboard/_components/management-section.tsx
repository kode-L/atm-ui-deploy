'use client';
import React, { ReactNode, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { BookOpen, KeyRound, Link2, Loader2, RefreshCw, Rocket, Search, ShieldCheck, Users } from 'lucide-react';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import ContractOverview from '@/components/contract-overview';
import { ETHERSCAN_API_KEY } from '@/lib/contracts/config';
import { LINK_ADDRESSES } from '@/lib/contracts/link';
import { Controller, DAO_PROXY_TARGET, ProxyInfo, aclIface, addressBook, isAddr, newImplKey, readController, readProxyInfo, sameAddr, saveAddr } from '@/lib/contracts/acl';
import { useAclCtx } from './management/use-acl-ctx';
import ManagementCard from './management/management-card';
import AclProposals from './management/acl-proposals';
import DaoRequests from './management/dao-requests';
import AclTypes from './management/acl-types';
import { AddrRow, Badge, ControlledAction, ControllerTag, Ctx, btnCls, btnSecondaryCls, inputCls, netName, useLiveVersion, useSavedAddr } from './management/shared';
import { DeployImplBox, StepBox, UpgradeCard, VersionBar } from './management/upgrade-card';
import { confirmDialog } from '@/components/confirm-dialog';

// Grouped sub-tabs (same pattern as Voucher V2). The ACL group holds the ACL, its DAO and the step
// that links them, in upgrade runbook order.
const SUB_TABS = [
  { id: 'overview', label: 'Who signs what', group: 'Overview' },
  { id: 'acl', label: '1. ACL', group: 'ACL' },
  { id: 'acl-proposals', label: 'ACL proposals', group: 'ACL' },
  { id: 'dao', label: '2. ACL DAO', group: 'ACL' },
  { id: 'dao-requests', label: 'DAO requests', group: 'ACL' },
  { id: 'link', label: '3. Link in ACL', group: 'ACL' },
  { id: 'types', label: '5. Types & rules', group: 'ACL' },
  { id: 'factory', label: '4. Factory', group: 'Proxies' },
  { id: 'other', label: 'Other proxy', group: 'Proxies' },
  { id: 'management', label: 'Management multisig', group: 'Governance' },
] as const;
const GROUPS = ['Overview', 'ACL', 'Proxies', 'Governance'] as const;
type SubTabId = (typeof SUB_TABS)[number]['id'];
const SUB_TAB_KEY = 'dg_managementSubTab';

/**
 * Management tab: the ACL contract set (ATMAccessControl, ATMAccessControlDAO, Factory) in upgrade
 * runbook order, plus the Management multisig. Every action shows who signs it (wallet /
 * Management multisig / other contract) and either sends it, creates the Management proposal, or
 * gives a copyable request for the admin.
 */
export default function ManagementSection() {
  const { s, ctx, ns, chainId, provider, loading, loadErr, wrongChain, tx, refresh, apiKey, setApiKey, addController } = useAclCtx();
  const [tab, setTab] = useState<SubTabId>('overview');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SUB_TAB_KEY);
      if (saved && SUB_TABS.some((t) => t.id === saved)) setTab(saved as SubTabId);
    } catch { /* storage blocked: start on the overview */ }
  }, []);
  const go = (id: SubTabId) => {
    setTab(id);
    try { localStorage.setItem(SUB_TAB_KEY, id); } catch { /* not remembered */ }
  };

  const overview = !s ? [] : [
    { label: 'ATMAccessControl (ACL)', address: s.acl?.address || '' },
    { label: 'ATMAccessControlDAO', address: s.dao?.address || '' },
    { label: 'Factory', address: s.factory?.address || '' },
    { label: 'File', address: s.file?.address || '' },
    { label: 'Trader', address: s.trader?.address || '' },
    ...(s.management ? [{ label: 'Management multisig', address: s.management }] : []),
  ].filter((i) => isAddr(i.address));

  return (
    <div className="space-y-4">
      <ContractOverview items={overview} provider={provider} chainId={ns} />

      <div className="bg-surface-secondary rounded-xl p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-accent" />
          <h2 className="font-semibold">ACL &amp; Management — {netName(ns)}</h2>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-txt-secondary" />}
          <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload from chain" onClick={refresh}><RefreshCw className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-txt-secondary">
          Deploy and upgrade the ACL set in runbook order. Each action shows <strong>who signs it</strong>: if that&apos;s your connected wallet you send it here;
          if it&apos;s the Management multisig and you&apos;re a node you create the proposal; otherwise copy the request and send it to that admin.
          Addresses are read from the chain (File → ACL → DAO); new contracts are kept in this browser until they&apos;re linked on-chain.
        </p>
        {s && <FactoryMismatch ctx={ctx} ns={ns} />}
        {wrongChain && <p className="text-xs text-red-300">Your wallet is on chain {chainId}, this tab reads {netName(ns)}. Switch the wallet before sending anything.</p>}
        {!ETHERSCAN_API_KEY && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-txt-secondary">Etherscan API key for <strong>Verify</strong> (kept only in this tab):</span>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="text" autoComplete="off" spellCheck={false} placeholder="Etherscan API key" className={`${inputCls} max-w-xs`} />
          </div>
        )}
        {loadErr && <p className="text-xs text-red-300">Couldn&apos;t read the contracts: {loadErr}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface-secondary rounded-xl p-1.5">
        {GROUPS.map((g) => (
          <div key={g} className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            <span className="text-[10px] uppercase tracking-wider text-txt-secondary px-2">{g}</span>
            {SUB_TABS.filter((t) => t.group === g).map((t) => (
              <button
                key={t.id}
                onClick={() => go(t.id)}
                className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  tab === t.id ? 'bg-accent text-black shadow-md' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-tertiary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {ctx && (
        <>
          {tab === 'overview' && <><WhoSigns ctx={ctx} /><AddressBook ctx={ctx} /></>}
          {tab === 'acl' && <AclCard ctx={ctx} />}
          {tab === 'acl-proposals' && <AclProposals ctx={ctx} />}
          {tab === 'dao' && <DaoCard ctx={ctx} />}
          {tab === 'dao-requests' && <DaoRequests ctx={ctx} />}
          {tab === 'link' && <LinkCard ctx={ctx} />}
          {tab === 'types' && <AclTypes ctx={ctx} />}
          {tab === 'factory' && <FactoryCard ctx={ctx} />}
          {tab === 'other' && <OtherProxyCard ctx={ctx} onController={addController} />}
          {tab === 'management' && <ManagementCard ctx={ctx} />}
        </>
      )}
      <TxStatus {...tx} chainId={ns} />
    </div>
  );
}

// ── Who signs what ─────────────────────────────────────────────────────────────
function WhoSigns({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const rows: [string, string, string | undefined][] = [
    ['Upgrade ACL / change its proxy admin', 'ATMAccessControl (ACL) proxy admin', s.acl?.admin],
    ['ACL settings (setDao, types, rules, operators)', 'ACL owner', s.acl?.owner],
    ['Upgrade ACL DAO / change its proxy admin', 'ATMAccessControlDAO proxy admin', s.dao?.admin],
    ['ACL DAO settings (unpause, verifier threshold)', 'ACL DAO owner', s.dao?.owner],
    ['Upgrade Factory', 'Factory proxy admin', s.factory?.admin],
    ['Upgrade File / File settings', 'File proxy admin / owner', s.file?.admin],
    ['Upgrade Trader', 'Trader proxy admin', s.trader?.admin],
  ];
  return (
    <Card title="Who signs what" icon={<KeyRound className="w-5 h-5 text-accent" />}>
      <p className="text-xs text-txt-secondary mb-2">Read live from each proxy&apos;s admin slot and <code>owner()</code>. Connect the wallet marked here to approve that action.</p>
      <div className="space-y-1.5">
        {rows.map(([what, role, who]) => (
          <div key={what} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs border-b border-white/5 pb-1.5">
            <span className="w-80 shrink-0">{what}</span>
            <span className="text-txt-secondary">{role}:</span>
            {isAddr(who) ? (
              <>
                <span className="font-semibold">{ctx.nameOf(who)}</span>
                <span className="font-mono" title={who}>{who}</span>
                <ControllerTag ctx={ctx} address={who} />
              </>
            ) : <span className="text-txt-secondary">— (contract not found)</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}


// ── Address book: every named address of this network in one place ──────────────
function AddressBook({ ctx }: { ctx: Ctx }) {
  const rows = addressBook(ctx.s);
  return (
    <Card collapsible title={<span>Address book <span className="text-sm text-txt-secondary font-normal">· {netName(ctx.ns)} · {rows.length} addresses</span></span>} icon={<BookOpen className="w-5 h-5 text-accent" />}>
      <p className="text-xs text-txt-secondary mb-2">
        Live contracts read from the chain, plus the fixed signers, rollback implementations and tokens of this network
        (<code>lib/contracts/acl/index.ts</code> → <code>KNOWN_NAMES</code>). The same names appear everywhere in this section.
      </p>
      {rows.length === 0 ? <p className="text-xs text-txt-secondary">Nothing loaded for this network yet.</p> : (
        <div className="divide-y divide-white/5">
          {rows.map((r) => <AddrRow key={r.address} ctx={ctx} label={r.group} address={r.address} name={r.name} />)}
        </div>
      )}
    </Card>
  );
}

// ── 1. ACL ────────────────────────────────────────────────────────────────────
function AclCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const [impl, setImpl] = useSavedAddr(newImplKey('ATMAccessControl'), ctx.ns);
  const [override, setOverride] = useState('');
  const deployProxy = async () => {
    if (!isAddr(impl)) return;
    const a = await ctx.deploy('Deploy ATMAccessControl (ACL) proxy', 'ATMAccessControlProxy', [impl]);
    if (a) { saveAddr('acl', ctx.ns, a); ctx.refresh(); }
  };
  return (
    <div className="space-y-4">
      <UpgradeCard ctx={ctx} title="Upgrade ACL" shortName="ACL" proxyName="ATMAccessControl (ACL) proxy" implName="ATMAccessControl implementation"
        info={s.acl} artifact="ATMAccessControl" proxyArtifact="ATMAccessControlProxy" impl={impl} setImpl={setImpl} suggestAdmin={s.management}
        icon={<ShieldCheck className="w-5 h-5 text-accent" />}
        intro={<>
          <p>
            ATMAccessControl holds wallet types, rules and protected wallets. Found through <code>File.accessControl()</code>
            {s.aclSource === 'saved' && <> — <span className="text-yellow-300">using an address saved in this browser</span></>}.
          </p>
          <p>Deploy the new implementation, then the <strong>proxy admin</strong> (see below) calls <code>upgrad(impl)</code>. Storage is append-only: operators, proposals, blacklist and freeze are all kept. Next: <strong>2. ACL DAO</strong>.</p>
        </>}
        confirm={s.acl ? `Upgrade the ACL proxy ${s.acl.address} to ${impl}? Every contract that reads the ACL uses the new code at once.` : undefined} />

      <Card collapsible title={<span>Deploy a new ACL proxy <span className="text-sm text-txt-secondary font-normal">· new network only</span></span>} icon={<Rocket className="w-5 h-5 text-accent" />}>
        <div className="space-y-4">
          <p className="text-txt-secondary text-sm">
            Only for a network without an ACL. The proxy runs <code>__ATMAccessControl_init()</code> in its constructor: the deploying wallet becomes <strong>proxy admin and owner</strong>.
            File&apos;s owner must then point <code>File.accessControl</code> at it.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DeployImplBox ctx={ctx} artifact="ATMAccessControl" label="ATMAccessControl implementation" impl={impl} setImpl={setImpl} />
            <StepBox title="2. Deploy ACL proxy">
              <p className="text-xs text-txt-secondary">Uses the implementation from step 1. Your connected wallet becomes proxy admin and owner — hand them over afterwards.</p>
              <button className={`w-full ${btnCls}`} disabled={!ctx.signer || !isAddr(impl)} onClick={deployProxy}>Deploy ACL proxy</button>
              {!isAddr(impl) && <p className="text-xs text-txt-secondary">Deploy the implementation first.</p>}
            </StepBox>
          </div>
          <div className="border-t border-white/10 pt-3 space-y-2 text-xs">
            <h4 className="font-medium text-sm">Use another ACL address</h4>
            <div className="flex flex-wrap gap-2 items-center">
              <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="ACL proxy 0x…" className={`${inputCls} max-w-md`} />
              <button className={btnSecondaryCls} disabled={!isAddr(override)} onClick={() => { saveAddr('acl', ctx.ns, override.trim()); setOverride(''); ctx.refresh(); }}>Use</button>
              {s.aclSource === 'saved' && <button className="underline text-txt-secondary" onClick={() => { saveAddr('acl', ctx.ns, ''); ctx.refresh(); }}>back to File.accessControl()</button>}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ── 2. ACL DAO ────────────────────────────────────────────────────────────────
function DaoCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const [impl, setImpl] = useSavedAddr(newImplKey('ATMAccessControlDAO'), ctx.ns);
  const dao = s.dao;
  const intro = (
    <>
      <p>
        ATMAccessControlDAO holds user requests and approvals (protection, move-up, safe-wallet votes). Read from <code>ACL.dao()</code>
        {s.daoSource === 'saved' && <> — <span className="text-yellow-300">this one is only saved in this browser until <strong>3. Link in ACL</strong> sets it</span></>}
        {s.daoSource === 'chain' && <> — <span className="text-yellow-300">not linked yet, so this is the address committed in <code>chain.json</code> until <strong>3. Link in ACL</strong> sets it</span></>}.
      </p>
      <p>Its requests are approved in <strong>DAO requests</strong>.</p>
    </>
  );
  if (!dao) return <DeployDaoCard ctx={ctx} impl={impl} setImpl={setImpl} intro={intro} />;
  return (
    <UpgradeCard ctx={ctx} title="Upgrade ACL DAO" shortName="ACL DAO" proxyName="ATMAccessControlDAO proxy" implName="ATMAccessControlDAO implementation"
      info={dao} artifact="ATMAccessControlDAO" proxyArtifact="ATMAccessControlDAOProxy" impl={impl} setImpl={setImpl} suggestAdmin={s.acl?.admin}
      icon={<Users className="w-5 h-5 text-accent" />}
      intro={<>{intro}<p>Upgrade: deploy the new implementation, then the DAO <strong>proxy admin</strong> (see below) calls <code>upgrad(impl)</code>. Requests and votes are kept.</p></>}
      warning={s.daoSource === 'saved' || s.daoSource === 'chain' ? <p className="text-xs text-yellow-300">Not linked yet: the ACL owner must call <code>setDao</code> in <strong>3. Link in ACL</strong>.</p> : undefined} />
  );
}

function DeployDaoCard({ ctx, impl, setImpl, intro }: { ctx: Ctx; impl: string; setImpl: (a: string) => void; intro: ReactNode }) {
  const { s } = ctx;
  const [owner, setOwner] = useState('');
  const implVersion = useLiveVersion(ctx.provider, impl);
  const implBad = implVersion === 'no contract';
  // 2nd constructor arg, as the bundled DAO expects it: the File proxy (current build: the DAO reads the
  // ACL from File.accessControl()) or, in an older bundle, the ACL itself — that deploy is held.
  const viaFile = DAO_PROXY_TARGET === 'file';
  const held = !viaFile;
  const defTarget = (viaFile ? s.file?.address : s.acl?.address) || '';
  const [tIn, setTIn] = useState('');
  const tArg = tIn.trim() || defTarget;
  const custom = isAddr(tArg) && !sameAddr(tArg, defTarget);
  // checked on-chain: a contract; via File → File.accessControl() gives the ACL; the ACL's owner() is the default DAO owner
  const [chk, setChk] = useState<{ ok: boolean; acl: string; owner: string; msg: string } | null>(null);
  useEffect(() => {
    setChk(null);
    if (!ctx.provider || !isAddr(tArg)) return;
    let cancelled = false;
    (async () => {
      const done = (v: { ok: boolean; acl: string; owner: string; msg: string }) => { if (!cancelled) setChk(v); };
      const code = await ctx.provider!.getCode(tArg).catch(() => '0x');
      if (code === '0x') return done({ ok: false, acl: '', owner: '', msg: 'No contract at this address on this network.' });
      let acl = tArg;
      if (viaFile) {
        acl = await new ethers.Contract(tArg, ['function accessControl() view returns (address)'], ctx.provider!).accessControl().catch(() => '');
        if (!isAddr(acl)) return done({ ok: false, acl: '', owner: '', msg: 'Not a File proxy: accessControl() is not readable or not set.' });
      }
      const c = new ethers.Contract(acl, ['function owner() view returns (address)', 'function dao() view returns (address)'], ctx.provider!);
      const [o, d] = await Promise.all([c.owner().catch(() => ''), c.dao().then(() => true).catch(() => false)]);
      done({ ok: true, acl, owner: o, msg: d ? '' : `The ACL ${acl} has no dao() (below v1.1.0): it can't be linked to the DAO until it is upgraded.` });
    })();
    return () => { cancelled = true; };
  }, [ctx.provider, tArg, viaFile]);
  const ownerArg = owner.trim() || chk?.owner || (custom ? '' : s.acl?.owner || '');
  const argName = viaFile ? 'file' : 'acl';
  const deployProxy = async () => {
    if (held || !isAddr(impl) || !isAddr(tArg) || !chk?.ok || !isAddr(ownerArg)) return;
    if (!(await confirmDialog({
      title: 'Deploy the ACL DAO proxy?',
      message: `ATMAccessControlDAOProxy(impl, ${argName}, owner)`,
      details: [
        { label: 'Network', value: `${netName(ctx.ns)} (chainId ${ctx.ns})` },
        { label: 'Implementation', value: impl, copy: impl, mono: true },
        { label: viaFile ? 'File' : 'ACL', value: tArg, copy: tArg, mono: true },
        ...(viaFile ? [{ label: 'ACL (File.accessControl())', value: chk.acl, copy: chk.acl, mono: true }] : []),
        { label: 'DAO owner', value: ownerArg, copy: ownerArg, mono: true },
        { label: 'Proxy admin', value: `${ctx.me} (your wallet)`, mono: true },
      ],
      warning: 'Your wallet becomes the DAO proxy admin — hand it over later in "Change proxy admin".',
      confirmLabel: 'Deploy',
    }))) return;
    const a = await ctx.deploy('Deploy ATMAccessControlDAO proxy', 'ATMAccessControlDAOProxy', [impl, tArg, ownerArg]);
    if (a) { saveAddr('dao', ctx.ns, a); ctx.refresh(); }
  };
  return (
    <Card collapsible title={<span>Deploy ACL DAO <span className="text-sm text-txt-secondary font-normal">· not deployed yet</span></span>} icon={<Users className="w-5 h-5 text-accent" />}>
      <div className="space-y-4">
        <div className="text-txt-secondary text-sm space-y-1">
          {intro}
          <p>Deploy the implementation, then the proxy. The proxy initialises in its constructor (<code>initialize({argName}, owner)</code>), so nobody can front-run it. Next: <strong>3. Link in ACL</strong>.</p>
        </div>
        <VersionBar label="Currently deployed ACL DAO version:" value="— not deployed —" />
        {!s.aclV11 && <p className="text-xs text-yellow-300">The ACL here is below v1.1.0 — upgrade it in <strong>1. ACL</strong> first, or step 3 can&apos;t link the DAO.</p>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {held ? (
            <StepBox title="1. Deploy new implementation">
              <p className="text-xs text-yellow-300">On hold until the updated DAO (reads the ACL from File) is bundled — an implementation deployed now would be the old code.</p>
            </StepBox>
          ) : <DeployImplBox ctx={ctx} artifact="ATMAccessControlDAO" label="ATMAccessControlDAO implementation" impl={impl} setImpl={setImpl} />}
          <StepBox title="2. Deploy DAO proxy">
            <div className="space-y-1">
              <span className="text-xs text-txt-secondary">DAO implementation (constructor <code>impl</code>) — pre-filled from step 1, or paste one that&apos;s already deployed</span>
              <input value={impl} onChange={(e) => setImpl(e.target.value.trim())} placeholder="ATMAccessControlDAO implementation 0x…" className={inputCls} />
              {isAddr(impl) && (
                <p className="text-[11px] text-txt-secondary">
                  Implementation version: <span className={`font-mono ${implBad ? 'text-red-300' : 'text-accent'}`}>{implVersion || 'loading…'}</span>
                  {implBad && ' — no contract at this address on this network'}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <span className="text-xs text-txt-secondary">
                {viaFile ? <>File proxy (constructor <code>file</code>) — the DAO reads the ACL from <code>File.accessControl()</code></> : <>ACL proxy the DAO works with (constructor <code>acl</code>)</>}
              </span>
              <input value={tIn} onChange={(e) => setTIn(e.target.value)} placeholder={defTarget ? `${defTarget} (${viaFile ? 'File proxy' : 'ATMAccessControl (ACL) proxy'})` : `${viaFile ? 'File' : 'ACL'} proxy 0x…`} className={inputCls} />
              {!tIn.trim() && defTarget && <p className="text-[11px] text-txt-secondary">Default: the {viaFile ? 'File' : 'ACL'} this network uses. Type another address to change it.</p>}
              {chk?.ok && viaFile && <AddrRow ctx={ctx} label="→ ACL it reads" address={chk.acl} />}
              {chk && !chk.ok && <p className="text-[11px] text-red-300">{chk.msg}</p>}
              {chk?.ok && chk.msg && <p className="text-[11px] text-yellow-300">{chk.msg}</p>}
              {custom && chk?.ok && <p className="text-[11px] text-yellow-300">Not the {viaFile ? 'File' : 'ACL'} this network uses — step 3 links the DAO in the ACL that File uses, so only use this for a separate set.</p>}
            </div>
            <div className="space-y-1">
              <span className="text-xs text-txt-secondary">DAO owner (unpauses it, sets the verifier threshold)</span>
              <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={chk?.owner ? `${chk.owner} (ACL owner)` : 'Owner 0x…'} className={inputCls} />
            </div>
            <button className={`w-full ${btnCls}`} disabled={held || !ctx.signer || !isAddr(impl) || implBad || !isAddr(tArg) || !chk?.ok || !isAddr(ownerArg)} onClick={deployProxy}>Deploy DAO proxy</button>
            {held && <p className="text-xs text-yellow-300">On hold: the bundled DAO still stores the ACL address. The updated DAO (reads the ACL from <code>File.accessControl()</code>) isn&apos;t bundled yet — re-run <code>scripts/sync-acl-contracts.js</code> once it&apos;s tested, then this deploy takes the File address.</p>}
            {!isAddr(impl) && <p className="text-xs text-txt-secondary">Deploy the DAO implementation in step 1, or paste one above.</p>}
            <UseExistingDao ctx={ctx} />
          </StepBox>
        </div>
        <div className="border-t border-white/10 pt-3 space-y-1">
          <h4 className="font-medium text-sm">Who will control it</h4>
          <AddrRow ctx={ctx} label="Proxy admin (upgrades)" address={ctx.me} name={ctx.me ? 'your connected wallet' : ''}>
            {!ctx.me && <span className="text-xs text-yellow-300">the wallet that sends step 2 — connect the one that should upgrade the DAO</span>}
          </AddrRow>
          <AddrRow ctx={ctx} label="Owner (settings)" address={ownerArg} name={owner.trim() ? ctx.nameOf(ownerArg) : 'ACL owner'}><ControllerTag ctx={ctx} address={ownerArg} /></AddrRow>
        </div>
      </div>
    </Card>
  );
}

/** Already deployed a DAO proxy (e.g. from another browser)? Load it — checked on-chain: its acl() must be this ACL. */
function UseExistingDao({ ctx }: { ctx: Ctx }) {
  const [a, setA] = useState('');
  const [err, setErr] = useState('');
  const use = async () => {
    setErr('');
    if (!ctx.provider || !ctx.s.acl) return;
    try {
      const d = new ethers.Contract(a.trim(), ['function acl() view returns (address)', 'function version() view returns (string)'], ctx.provider);
      const [acl] = await Promise.all([d.acl(), d.version()]);
      if (!sameAddr(acl, ctx.s.acl.address)) { setErr(`That DAO points at ACL ${acl}, not ${ctx.s.acl.address}.`); return; }
      saveAddr('dao', ctx.ns, a.trim()); setA(''); ctx.refresh();
    } catch { setErr('Not an ATMAccessControlDAO on this network (acl() / version() not readable).'); }
  };
  return (
    <div className="pt-2 border-t border-white/10 space-y-1">
      <span className="text-xs text-txt-secondary">Or load one already deployed (checked on-chain):</span>
      <div className="flex flex-wrap gap-2 items-center">
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="DAO proxy 0x…" className={`${inputCls} flex-1 min-w-0`} />
        <button className={btnSecondaryCls} disabled={!isAddr(a)} onClick={use}>Check &amp; use</button>
      </div>
      {err && <p className="text-xs text-red-300">{err}</p>}
    </div>
  );
}

// ── 3. Link in ACL ────────────────────────────────────────────────────────────
function LinkCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const acl = s.acl;
  const daoDone = !!s.dao && sameAddr(s.aclDao, s.dao.address);
  const title = (
    <span>3. Link the DAO in the ACL <span className="text-sm text-txt-secondary font-normal">· {!s.aclV11 ? 'needs ACL v1.1.0' : daoDone ? 'DAO ✓' : 'DAO ✗'}</span></span>
  );
  return (
    <Card icon={<Link2 className="w-5 h-5 text-accent" />} title={title}>
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">ACL owner calls <code>setDao(dao)</code>, so the ACL accepts the DAO&apos;s hooks. The Factory needs no setup here: it finds the ACL through <code>File.accessControl()</code>.</p>
        {!s.aclV11 ? <p className="text-xs text-yellow-300">The ACL on this network doesn&apos;t have <code>dao()</code> yet — upgrade it to v1.1.0 in step 1 first.</p> : acl && (
          <>
            <AddrRow ctx={ctx} label="ACL.dao()" address={s.aclDao}>{daoDone ? <Badge tone="good">matches DAO</Badge> : <Badge tone="warn">not the DAO</Badge>}</AddrRow>
            <ControlledAction ctx={ctx} title="Set DAO" contractName="ATMAccessControl (ACL) proxy" target={acl.address} controller={acl.owner}
              kind="call" data={s.dao ? aclIface.encodeFunctionData('setDao', [s.dao.address]) : ''} disabled={daoDone}
              disabledReason={!s.dao ? 'Deploy the DAO proxy in step 2 first.' : 'Already set.'} onDone={() => saveAddr('dao', ctx.ns, '')} />
          </>
        )}
      </div>
    </Card>
  );
}

// ── 4. Factory ────────────────────────────────────────────────────────────────
function FactoryCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const [impl, setImpl] = useSavedAddr(newImplKey('Factory'), ctx.ns);
  const f = s.factory;
  const prod = LINK_ADDRESSES[ctx.ns]?.factory || '';
  const notProd = !!f && isAddr(prod) && !sameAddr(f.address, prod);
  const aclOk = s.aclV11; // the new Factory calls acl.checkConnection, which only v1.1.0 has
  return (
    <UpgradeCard ctx={ctx} title="Upgrade Factory" shortName="Factory" proxyName="Factory proxy" implName="Factory implementation"
      info={f} artifact="Factory" impl={impl} setImpl={setImpl} suggestAdmin={s.management}
      intro={<>
        <p>The new Factory asks <code>acl.checkConnection(…)</code> in <code>createLink</code>. Storage is unchanged. Found through <code>File.factory()</code>.</p>
        <p>Do this after the ACL is v1.1.0 and the production rules are set (<strong>5. Types &amp; rules</strong>). On mainnet the proxy admin is the Management multisig: step 2 creates a proposal the nodes vote on.</p>
      </>}
      warning={f && (!aclOk || notProd) ? (
        <div className="space-y-1">
          {notProd && <p className="text-xs text-red-300">This is the Factory File points at <strong>now</strong>, not the production one ({prod}). Upgrading here upgrades that Factory — point File back at the production Factory first if you meant that one.</p>}
          {!aclOk && <p className="text-xs text-red-300">The ACL isn&apos;t v1.1.0 yet — upgrade it in <strong>1. ACL</strong> first, or every createLink reverts after this upgrade.</p>}
        </div>
      ) : undefined}
      confirm={aclOk ? undefined : 'The ACL is not v1.1.0 (no checkConnection): after this upgrade every createLink reverts until the ACL is upgraded. Continue anyway?'} />
  );
}

// ── Any other basePorxy contract ──────────────────────────────────────────────
function OtherProxyCard({ ctx, onController }: { ctx: Ctx; onController: (c: Controller) => void }) {
  const [addr, setAddr] = useState('');
  const [info, setInfo] = useState<ProxyInfo | null>(null);
  const [impl, setImpl] = useState('');
  const [err, setErr] = useState('');
  const known = ([['File proxy', ctx.s.file?.address], ['Trader proxy', ctx.s.trader?.address]] as const).filter(([, a]) => isAddr(a));

  const load = async (a: string) => {
    setErr(''); setInfo(null);
    if (!ctx.provider || !isAddr(a)) return;
    const i = await readProxyInfo(ctx.provider, a.trim());
    if (!i?.code) { setErr('No contract at this address on this network.'); return; }
    if (!i.admin) setErr('No proxy admin found (EIP-1967 admin slot is empty) — not a basePorxy proxy?');
    for (const w of [i.admin, i.owner]) if (isAddr(w)) onController(await readController(ctx.provider, w));
    setInfo(i);
  };
  const name = ctx.nameOf(info?.address) || 'Proxy';
  return (
    <div className="space-y-4">
      <Card icon={<Search className="w-5 h-5 text-accent" />} title="Other proxy (File, Trader, …)">
        <div className="space-y-3">
          <p className="text-xs text-txt-secondary">Load any <code>basePorxy</code> proxy to see who controls it, upgrade it or change its admin.</p>
          <div className="flex flex-wrap gap-2 items-center">
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Proxy address 0x…" className={`${inputCls} max-w-md`} />
            <button className={btnSecondaryCls} disabled={!isAddr(addr)} onClick={() => load(addr)}>Load</button>
            {known.map(([n, a]) => <button key={n} className="text-xs text-accent underline" onClick={() => { setAddr(a!); load(a!); }}>{n}</button>)}
          </div>
          {err && <p className="text-xs text-yellow-300">{err}</p>}
        </div>
      </Card>
      {info && (
        <UpgradeCard key={info.address} ctx={ctx} defaultOpen title={`Upgrade ${name}`} shortName={name.replace(/ proxy$/, '')} proxyName={name} implName={`${name.replace(/ proxy$/, '')} implementation`}
          info={info} impl={impl} setImpl={setImpl} suggestAdmin={ctx.s.management} onDone={() => load(info.address)}
          intro={<p>Deploy the new implementation from the contracts repo, paste it in step 2, and the <strong>proxy admin</strong> (see below) upgrades.</p>} />
      )}
    </div>
  );
}

/** File.factory() isn't the production Factory (chain.json / link addresses): e.g. a test-Factory session is on. */
function FactoryMismatch({ ctx, ns }: { ctx: Ctx | null; ns: number }) {
  const live = ctx?.s.factory?.address || '';
  const prod = LINK_ADDRESSES[ns]?.factory || '';
  if (!isAddr(live) || !isAddr(prod) || sameAddr(live, prod)) return null;
  return (
    <p className="text-xs text-red-300 rounded-lg border border-red-500/40 bg-red-900/20 px-3 py-2">
      File points at a different Factory (<span className="font-mono">{live}</span>) than production (<span className="font-mono">{prod}</span>).
      Factory rows on this tab show the one File uses now; links created meanwhile belong to it. The File owner should point File back at the production Factory.
    </p>
  );
}
