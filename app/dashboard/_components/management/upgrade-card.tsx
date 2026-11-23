'use client';
import React, { ReactNode, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import Card from '@/components/card';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import { AclContractName, ProxyInfo, isAddr, sameAddr, short } from '@/lib/contracts/acl';
import { AddrRow, Badge, ControlledAction, ControllerTag, Ctx, btnCls, inputCls, netName, useLiveVersion } from './shared';

// Deploy / upgrade cards in the Deploy tab's layout (Upgrade GameHub / Upgrade DSM): collapsible, the
// current version on top, "1. Deploy new implementation" and "2. Upgrade" side by side, and who
// controls the contract (proxy admin = upgrades it, owner = settings) at the bottom.

export const vtag = (v?: string) => (!v ? 'no version()' : v.startsWith('v') || v.startsWith('no ') ? v : `v${v}`);

export function StepBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-surface-tertiary rounded-lg p-4 space-y-3 min-w-0">
      <h4 className="font-medium">{title}</h4>
      {children}
    </div>
  );
}

export function VersionBar({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="bg-surface-tertiary rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-txt-secondary">{label}</span>
      <span className="font-mono text-accent">{value}</span>
    </div>
  );
}

/** Step 1: deploy the bundled implementation. Any wallet can; nothing changes until the upgrade. */
export function DeployImplBox({ ctx, artifact, label, impl, setImpl }: {
  ctx: Ctx; artifact: AclContractName; label: string; impl: string; setImpl: (a: string) => void;
}) {
  const deploy = async () => {
    const a = await ctx.deploy(`Deploy ${label}`, artifact);
    if (a) setImpl(a);
  };
  return (
    <StepBox title="1. Deploy new implementation">
      <p className="text-xs text-txt-secondary">
        Deploys the bundled {label} code (built from the tested contracts). <strong>Any wallet</strong> can do this — nothing changes until step 2.
      </p>
      <button type="button" className={`w-full ${btnCls}`} disabled={!ctx.signer} onClick={deploy}>Deploy new implementation</button>
      {!ctx.signer && <p className="text-xs text-yellow-300">Connect a wallet to deploy.</p>}
      {isAddr(impl) && (
        <AddrRow ctx={ctx} label="Deployed" address={impl} name="" verify={artifact}>
          <button type="button" className="text-xs text-txt-secondary hover:text-txt-primary underline" onClick={() => setImpl('')}>forget</button>
        </AddrRow>
      )}
    </StepBox>
  );
}

/** Proxy admin hand-over (wallet → Management multisig / timelock, …). */
export function ChangeAdmin({ ctx, info, contractName, suggest }: { ctx: Ctx; info: ProxyInfo; contractName: string; suggest?: string }) {
  const [to, setTo] = useState('');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="New proxy admin 0x…" className={`${inputCls} max-w-md`} />
        {isAddr(suggest) && !sameAddr(suggest, info.admin) && (
          <button className="text-xs text-accent underline" onClick={() => setTo(suggest!)}>use {ctx.nameOf(suggest) || short(suggest)}</button>
        )}
      </div>
      <ControlledAction ctx={ctx} title="Change proxy admin" contractName={contractName} target={info.address} controller={info.admin}
        kind="changeAdmin" arg={to.trim()} disabled={sameAddr(to, info.admin)} disabledReason="Enter the new admin (wallet, Management multisig or timelock)."
        confirm={`Hand the proxy admin of ${contractName} to ${to.trim()}? Only that address can upgrade it afterwards.`} onDone={() => setTo('')} />
    </div>
  );
}

/** Bottom of every card: who upgrades it and who changes its settings, read live. */
export function WhoControls({ ctx, info, proxyName, implName, implArtifact, proxyArtifact, suggestAdmin }: {
  ctx: Ctx; info: ProxyInfo; proxyName: string; implName?: string; implArtifact?: AclContractName; proxyArtifact?: AclContractName; suggestAdmin?: string;
}) {
  return (
    <div className="border-t border-white/10 pt-3 space-y-1">
      <h4 className="font-medium text-sm">Who controls it</h4>
      <p className="text-xs text-txt-secondary">
        Read live from the chain. The <strong>proxy admin</strong> upgrades it (step 2) and can hand that over; the <strong>owner</strong> changes its settings.
        Connect the wallet shown here to sign — or copy the request for that admin.
      </p>
      <AddrRow ctx={ctx} label="Proxy (use this)" address={info.address} name={proxyName} verify={proxyArtifact}>
        <Badge tone="accent">{info.code ? vtag(info.version) : 'no contract'}</Badge>
      </AddrRow>
      <AddrRow ctx={ctx} label="Implementation" address={info.implementation} name={implName} verify={implArtifact} />
      <AddrRow ctx={ctx} label="Proxy admin (upgrades)" address={info.admin} name={ctx.nameOf(info.admin)}><ControllerTag ctx={ctx} address={info.admin} /></AddrRow>
      {info.owner && <AddrRow ctx={ctx} label="Owner (settings)" address={info.owner} name={ctx.nameOf(info.owner)}><ControllerTag ctx={ctx} address={info.owner} /></AddrRow>}
      <details className="text-xs pt-1">
        <summary className="cursor-pointer text-txt-secondary">Change proxy admin…</summary>
        <div className="mt-2"><ChangeAdmin ctx={ctx} info={info} contractName={proxyName} suggest={suggestAdmin} /></div>
      </details>
    </div>
  );
}

/**
 * Upgrade one basePorxy proxy: current version → 1. deploy implementation → 2. proxy admin calls
 * upgrad(impl) (direct, Management proposal or copyable request) → who controls it.
 */
export function UpgradeCard({ ctx, title, shortName, proxyName, implName, info, artifact, proxyArtifact, intro, warning, confirm, impl, setImpl, suggestAdmin, icon, defaultOpen, onDone }: {
  ctx: Ctx;
  title: string;                 // card title, e.g. "Upgrade ACL"
  shortName: string;             // e.g. "ACL"
  proxyName: string;             // e.g. "ATMAccessControl (ACL) proxy"
  implName: string;              // e.g. "ATMAccessControl implementation"
  info: ProxyInfo | null;
  artifact?: AclContractName;    // bundled implementation; without it step 1 says where to get one
  proxyArtifact?: AclContractName;
  intro: ReactNode;
  warning?: ReactNode;
  confirm?: string;
  impl: string;
  setImpl: (a: string) => void;
  suggestAdmin?: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  onDone?: () => void;
}) {
  const newVersion = useLiveVersion(ctx.provider, impl);
  const live = isAddr(impl) && sameAddr(impl, info?.implementation);
  const noCode = newVersion === 'no contract';
  const head = (
    <span>{title} <span className="text-sm text-txt-secondary font-normal">
      · {info ? `${info.code ? vtag(info.version) : 'no contract'} · upgraded by ${ctx.nameOf(info.admin) || short(info.admin) || '—'}` : 'not found'}
    </span></span>
  );
  return (
    <Card collapsible defaultOpen={defaultOpen} title={head} icon={icon || <ArrowUpCircle className="w-5 h-5 text-accent" />}>
      <div className="space-y-4">
        <div className="text-txt-secondary text-sm space-y-1">{intro}</div>
        {!info ? <p className="text-xs text-txt-secondary">No {shortName} found on {netName(ctx.ns)}.</p> : (
          <>
            <VersionBar label={`Currently deployed ${shortName} version:`} value={info.code ? vtag(info.version) : 'no contract'} />
            {warning}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {artifact ? <DeployImplBox ctx={ctx} artifact={artifact} label={implName} impl={impl} setImpl={setImpl} /> : (
                <StepBox title="1. Deploy new implementation">
                  <p className="text-xs text-txt-secondary">This contract isn&apos;t bundled here: deploy its implementation from the contracts repo, then paste the address in step 2.</p>
                </StepBox>
              )}
              <StepBox title={`2. Upgrade ${shortName}`}>
                <p className="text-[11px] text-txt-secondary break-all">
                  Currently live implementation (what you&apos;re replacing):{' '}
                  {isAddr(info.implementation) ? (
                    <a href={getExplorerAddressUrl(ctx.ns, info.implementation)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">{info.implementation}</a>
                  ) : '—'}
                  <span> ({info.code ? vtag(info.version) : '—'})</span>
                </p>
                <p className="text-xs text-txt-secondary">Pre-filled from step 1, or paste an implementation that&apos;s already deployed.</p>
                <input value={impl} onChange={(e) => setImpl(e.target.value.trim())} placeholder="New implementation 0x…" className={inputCls} />
                {isAddr(impl) && (
                  <p className="text-[11px] text-txt-secondary">
                    New version: <span className={`font-mono ${noCode ? 'text-red-300' : 'text-accent'}`}>{newVersion || 'loading…'}</span>
                    {live && <> · <span className="text-green-300">already live — the proxy uses it</span></>}
                  </p>
                )}
                <ControlledAction ctx={ctx} title={`Upgrade ${shortName}`} contractName={proxyName} target={info.address} controller={info.admin}
                  kind="upgrade" arg={impl} disabled={!isAddr(impl) || live || noCode}
                  disabledReason={!isAddr(impl) ? 'Deploy the new implementation in step 1, or paste one.' : live ? 'The proxy already uses this implementation.' : 'No contract at that address on this network.'}
                  confirm={confirm ?? `Upgrade ${proxyName} ${info.address} to ${impl}? Everything that uses it runs the new code at once.`} onDone={onDone} />
              </StepBox>
            </div>
            <WhoControls ctx={ctx} info={info} proxyName={proxyName} implName={implName} implArtifact={artifact} proxyArtifact={proxyArtifact} suggestAdmin={suggestAdmin} />
          </>
        )}
      </div>
    </Card>
  );
}
