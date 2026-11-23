'use client';
import React, { ReactNode, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { ExternalLink } from 'lucide-react';
import { CopyButton } from '@/components/tx-status';
import { confirmDialog } from '@/components/confirm-dialog';
import VerifyButton from '@/components/verify-button';
import { NETWORKS, getExplorerAddressUrl } from '@/lib/contracts/config';
import {
  ARTIFACTS, AclContractName, AclSystem, Controller, MANAGEMENT_ABI, PROXY_ABI, WalletStatus, describeCall, isAddr, loadVerifyBundle,
  readProxyInfo, readWalletStatus, sameAddr, saveAddr, savedAddr, short,
} from '@/lib/contracts/acl';

export const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';
export const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap';
export const btnSecondaryCls = 'bg-surface-tertiary hover:bg-surface-tertiary/70 disabled:opacity-40 disabled:cursor-not-allowed border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap';

export interface Ctx {
  s: AclSystem;
  ns: number;                                   // network the tab reads (netChainId)
  me: string;                                   // connected wallet ('' = none)
  provider: ethers.providers.Provider | null;
  signer: ethers.Signer | null;
  apiKey: string;
  nameOf: (a?: string) => string;
  controllerOf: (a?: string) => Controller | undefined;
  /** Sends one tx with the connected wallet; status goes to the toast. Resolves to the receipt, or null on failure. */
  run: (label: string, send: () => Promise<ethers.ContractTransaction>) => Promise<ethers.ContractReceipt | null>;
  /** Deploys a bundled contract with the connected wallet; resolves to its address, or '' on failure. */
  deploy: (label: string, name: AclContractName, args?: any[]) => Promise<string>;
  refresh: () => void;
}

export const netName = (ns: number) => NETWORKS[ns]?.chainName || `chain ${ns}`;

export function Badge({ tone, children, title }: { tone: 'good' | 'warn' | 'bad' | 'muted' | 'accent'; children: ReactNode; title?: string }) {
  const cls = {
    good: 'bg-green-900/40 text-green-300',
    warn: 'bg-yellow-900/40 text-yellow-300',
    bad: 'bg-red-900/40 text-red-300',
    muted: 'bg-surface-tertiary text-txt-secondary',
    accent: 'bg-accent/15 text-accent',
  }[tone];
  return <span title={title} className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded whitespace-nowrap ${cls}`}>{children}</span>;
}

/** Address with its contract name, copy, explorer link and (optionally) a Verify button. */
export function AddrRow({ ctx, label, address, name, verify, children }: {
  ctx: Ctx;
  label: string;
  address?: string;
  name?: string;
  verify?: AclContractName;
  children?: ReactNode;
}) {
  const known = name ?? ctx.nameOf(address);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs py-1">
      <span className="text-txt-secondary w-36 shrink-0">{label}</span>
      {!isAddr(address) ? <span className="text-txt-secondary">—</span> : (
        <>
          {known && <span className="font-semibold text-txt-primary">{known}</span>}
          <a href={getExplorerAddressUrl(ctx.ns, address!)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline inline-flex items-center gap-1" title={address}>
            {address} <ExternalLink className="w-3 h-3" />
          </a>
          <CopyButton text={address!} title="Copy address" />
          {sameAddr(address, ctx.me) && <Badge tone="good">you</Badge>}
          {verify && (
            <VerifyButton chainId={ctx.ns} address={address!} name={known || verify} bytecode={ARTIFACTS[verify].bytecode}
              load={() => loadVerifyBundle(verify)} apiKey={ctx.apiKey} provider={ctx.provider} />
          )}
        </>
      )}
      {children}
    </div>
  );
}

/** What kind of signer controls an address and whether the connected wallet is it. */
export function ControllerTag({ ctx, address }: { ctx: Ctx; address?: string }) {
  const c = ctx.controllerOf(address);
  if (!isAddr(address)) return <Badge tone="muted">none</Badge>;
  const isMe = sameAddr(address, ctx.me);
  const isNode = c?.kind === 'management' && c.nodes?.some((n) => sameAddr(n, ctx.me));
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {c?.kind === 'wallet' && <Badge tone="accent" title="An ordinary wallet (no contract code): connect it to sign">wallet</Badge>}
      {c?.kind === 'management' && <Badge tone="warn" title="Management multisig: a node proposes, the other nodes vote">Management · {c.needed} of {c.nodes?.length} nodes</Badge>}
      {c?.kind === 'contract' && <Badge tone="muted" title="Another contract (e.g. Safe / timelock): send it the request below">contract</Badge>}
      {!ctx.me ? null
        : isMe ? <Badge tone="good">connected</Badge>
        : isNode ? <Badge tone="good">you are a node</Badge>
        : <Badge tone="bad" title="The connected wallet can't sign this">not you</Badge>}
    </span>
  );
}

export type ActionKind = 'upgrade' | 'changeAdmin' | 'call';

/**
 * One admin action, routed by whoever controls it:
 * - the connected wallet          → send it directly
 * - Management multisig, you're a node → create the proposal (the other nodes vote)
 * - anyone else                   → tells you which wallet to connect, with a copyable request
 */
export function ControlledAction({ ctx, title, contractName, target, controller, kind, arg, data, disabled, disabledReason, confirm, onDone }: {
  ctx: Ctx;
  title: string;            // e.g. "Upgrade ACL proxy"
  contractName: string;     // e.g. "ATMAccessControl (ACL) proxy"
  target?: string;          // contract the action changes
  controller?: string;      // who must sign: proxy admin or owner
  kind: ActionKind;
  arg?: string;             // upgrade: new implementation · changeAdmin: new admin
  data?: string;            // call: calldata
  disabled?: boolean;
  disabledReason?: string;
  confirm?: string;         // asked before sending
  onDone?: () => void;
}) {
  const c = ctx.controllerOf(controller);
  const isMe = sameAddr(controller, ctx.me);
  const isNode = c?.kind === 'management' && !!c.nodes?.some((n) => sameAddr(n, ctx.me));
  const valid = isAddr(target) && isAddr(controller) && (kind === 'call' ? !!data && data !== '0x' : isAddr(arg));
  const calldata = !valid ? '' : kind === 'upgrade'
    ? new ethers.utils.Interface(PROXY_ABI).encodeFunctionData('upgrad', [arg])
    : kind === 'changeAdmin' ? new ethers.utils.Interface(PROXY_ABI).encodeFunctionData('changeAdmin', [arg]) : data!;
  const what = describeCall(calldata);

  const mgmtCall = !valid || c?.kind !== 'management' ? null
    : kind === 'upgrade' ? { fn: 'updateProxyUpgradPropose', args: [target!, arg!] }
    : kind === 'changeAdmin' ? { fn: 'updateProxyAdminPropose', args: [target!, arg!] }
    : { fn: 'excContractPropose', args: [target!, data!] };

  const request = !valid ? '' : [
    `Network: ${netName(ctx.ns)} (chainId ${ctx.ns})`,
    `Action: ${title}`,
    `Contract: ${contractName} ${target}`,
    `Call: ${what}`,
    mgmtCall
      ? `Sign with: a node of the Management multisig ${controller} (${c?.needed} of ${c?.nodes?.length} votes, within 24h)\nPropose: Management.${mgmtCall.fn}(${mgmtCall.args.join(', ')})`
      : `Sign with: ${controller}${c?.kind === 'contract' ? ' (contract — submit as a transaction from it)' : ''}`,
    `Raw tx: to ${target}, data ${calldata}`,
  ].join('\n');

  const send = async () => {
    if (!valid || !ctx.signer) return;
    if (confirm && !(await confirmDialog({
      title: `${title}?`,
      message: confirm,
      details: [
        { label: 'Network', value: `${netName(ctx.ns)} (chainId ${ctx.ns})` },
        { label: 'Contract', value: `${contractName} ${target}`, copy: target, mono: true },
        { label: 'Call', value: what, copy: what, mono: true },
        { label: 'Signed by', value: `${ctx.nameOf(controller) || c?.kind || ''} ${controller}`.trim(), copy: controller, mono: true },
        { label: 'Sent as', value: isMe ? 'A transaction from your connected wallet' : `A Management proposal (${c?.needed} of ${c?.nodes?.length} node votes, within 24h)` },
      ],
      danger: true,
      confirmLabel: isMe ? 'Send transaction' : 'Create proposal',
    }))) return;
    let rc: ethers.ContractReceipt | null = null;
    if (isMe) {
      rc = await ctx.run(`${contractName}: ${title}`, () => (kind === 'call'
        ? ctx.signer!.sendTransaction({ to: target, data }) as Promise<ethers.ContractTransaction>
        : new ethers.Contract(target!, PROXY_ABI, ctx.signer!)[kind === 'upgrade' ? 'upgrad' : 'changeAdmin'](arg)));
    } else if (isNode && mgmtCall) {
      const m = new ethers.Contract(controller!, MANAGEMENT_ABI, ctx.signer);
      rc = await ctx.run(`Management: propose "${title}" on ${contractName}`, () => m[mgmtCall.fn](...mgmtCall.args));
    }
    if (rc) onDone?.();
  };

  return (
    <div className="rounded-lg border border-white/10 bg-surface-tertiary/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-txt-secondary">on {contractName}</span>
      </div>
      {valid && <div className="text-xs font-mono text-txt-secondary break-all">{what}</div>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-txt-secondary">Signed by</span>
        {isAddr(controller) ? (
          <>
            <span className="font-semibold">{ctx.nameOf(controller) || (c?.kind === 'wallet' ? 'wallet' : 'contract')}</span>
            <a href={getExplorerAddressUrl(ctx.ns, controller!)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">{controller}</a>
            <CopyButton text={controller!} title="Copy signer address" />
            <ControllerTag ctx={ctx} address={controller} />
          </>
        ) : <span className="text-txt-secondary">— (not readable)</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isMe || isNode ? (
          <button type="button" className={btnCls} disabled={disabled || !valid} onClick={send}>
            {isMe ? title : 'Create Management proposal'}
          </button>
        ) : (
          <span className="text-xs text-yellow-300">
            {!ctx.me ? 'Connect a wallet' : c?.kind === 'management'
              ? `Connect one of the ${c.nodes?.length} Management node wallets to propose — or send the request to a node admin`
              : `Connect ${short(controller)} to send this — or send the request to whoever holds it`}
          </span>
        )}
        {valid && <CopyButton text={request} title="Copy a request with everything the signer needs" label="Copy request for admin" />}
      </div>
      {isNode && <p className="text-xs text-txt-secondary">Your proposal counts as the first vote. It executes when {c?.needed} of {c?.nodes?.length} nodes have voted, within 24h — see Management proposals below.</p>}
      {(disabled || !valid) && disabledReason && <p className="text-xs text-txt-secondary">{disabledReason}</p>}
    </div>
  );
}

/** Address remembered per network in this browser (e.g. a freshly deployed implementation). */
export function useSavedAddr(key: string, ns: number): [string, (a: string) => void] {
  const [v, setV] = useState('');
  useEffect(() => { setV(savedAddr(key, ns)); }, [key, ns]);
  return [v, (a: string) => { saveAddr(key, ns, a); setV(a); }];
}

/** version() of any address, read live ('' while loading or if it has none). */
export function useLiveVersion(provider: ethers.providers.Provider | null, address: string, rev = 0): string {
  const [v, setV] = useState('');
  useEffect(() => {
    setV('');
    if (!provider || !isAddr(address)) return;
    let cancelled = false;
    readProxyInfo(provider, address).then((i) => { if (!cancelled) setV(i?.code ? i.version || 'no version()' : 'no contract'); });
    return () => { cancelled = true; };
  }, [provider, address, rev]);
  return v;
}

/** "Deploy new implementation" + the deployed address (kept in this browser until it's live). */
export function NewImplementation({ ctx, name, label, current, impl, setImpl }: {
  ctx: Ctx;
  name: AclContractName;
  label: string;           // e.g. "ATMAccessControl implementation"
  current?: string;        // implementation the proxy uses now
  impl: string;
  setImpl: (a: string) => void;
}) {
  const version = useLiveVersion(ctx.provider, impl);
  const live = sameAddr(impl, current);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState('');
  const deploy = async () => {
    const a = await ctx.deploy(`Deploy ${label}`, name);
    if (a) setImpl(a);
  };
  // an implementation deployed elsewhere (another browser, a script): accept it only if the chain
  // shows contract code with a version()
  const use = async () => {
    setErr('');
    if (!ctx.provider) return;
    const i = await readProxyInfo(ctx.provider, paste.trim());
    if (!i?.code) { setErr('No contract at that address on this network.'); return; }
    if (!i.version) { setErr('That contract has no version() — not an implementation built from these sources?'); return; }
    setImpl(paste.trim()); setPaste('');
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnSecondaryCls} disabled={!ctx.signer} onClick={deploy}>Deploy new {label}</button>
        <span className="text-xs text-txt-secondary">Any wallet can deploy it. It does nothing until the proxy is upgraded to it.</span>
      </div>
      {!isAddr(impl) && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-txt-secondary">Or use one already deployed:</span>
          <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Implementation 0x…" className={`${inputCls} max-w-md`} />
          <button className={btnSecondaryCls} disabled={!isAddr(paste)} onClick={use}>Check on-chain &amp; use</button>
          {err && <span className="text-xs text-red-300">{err}</span>}
        </div>
      )}
      {isAddr(impl) && (
        <AddrRow ctx={ctx} label="New implementation" address={impl} name={label} verify={name}>
          <Badge tone={live ? 'good' : 'accent'}>{version || '…'}</Badge>
          {live ? <Badge tone="good">live — proxy uses it</Badge> : <Badge tone="warn">not live yet</Badge>}
          <button type="button" className="text-xs text-txt-secondary hover:text-txt-primary underline" onClick={() => setImpl('')}>forget</button>
        </AddrRow>
      )}
    </div>
  );
}

/** Effective ACL status of a wallet, read live. A protected wallet whose safe wallet is restricted shows FROZEN with the reason. */
export function useWalletStatus(ctx: Ctx, wallet: string, rev = 0): WalletStatus | null {
  const [st, setSt] = useState<WalletStatus | null>(null);
  useEffect(() => {
    setSt(null);
    const acl = ctx.s.acl?.address;
    if (!ctx.provider || !isAddr(acl) || !isAddr(wallet)) return;
    let cancelled = false;
    readWalletStatus(ctx.provider, acl!, wallet).then((r) => { if (!cancelled) setSt(r); }).catch(() => { /* ACL below v1.1.0 */ });
    return () => { cancelled = true; };
  }, [ctx.provider, ctx.s, wallet, rev]);
  return st;
}

const SAFE_TEXT: Record<string, string> = { frozen: 'frozen', blacklisted: 'blacklisted', revoked: 'revoked (was blacklisted)' };

/** Status badge + reason: e.g. FROZEN · safe wallet 0x… is blacklisted · payouts blocked. */
export function WalletStatusBadge({ ctx, wallet, st: given, compact }: { ctx: Ctx; wallet: string; st?: WalletStatus | null; compact?: boolean }) {
  const fetched = useWalletStatus(ctx, given ? '' : wallet);
  const st = given ?? fetched;
  if (!st) return <span className="text-txt-secondary text-xs">…</span>;
  const tone = st.status === 'blacklisted' || st.status === 'frozen' ? 'bad' : st.status === 'protected' ? 'accent' : 'good';
  const payouts = !st.payoutsTo ? 'payouts blocked' : sameAddr(st.payoutsTo, wallet) ? '' : `payouts to ${short(st.payoutsTo)}`;
  const reason = st.frozenBy === 'safe' ? `safe wallet ${short(st.safeWallet)} is ${SAFE_TEXT[st.safeState] || st.safeState}`
    : st.status === 'protected' ? `safe wallet ${short(st.safeWallet)}`
    : st.status === 'frozen' && st.safeWallet && st.safeState !== 'ok' ? `its safe wallet ${short(st.safeWallet)} is ${SAFE_TEXT[st.safeState] || st.safeState}` : '';
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <Badge tone={tone as any}>{st.status}</Badge>
      {reason && <span className="text-txt-secondary">{reason}</span>}
      {payouts && <span className={st.payoutsTo ? 'text-txt-secondary' : 'text-red-300'}>· {payouts}</span>}
      {!compact && st.frozenBy === 'safe' && <span className="text-txt-secondary">· back to protected automatically when the safe wallet is cleared</span>}
    </span>
  );
}
