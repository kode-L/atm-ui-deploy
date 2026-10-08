'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import { BSC_MAINNET } from '@/lib/contracts/config';
import { ContractKey, isAddr, sameAddr, shortAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DEPLOY_STEPS, DeployStep, StepResult, checkDeployStep, runDeployStep } from './steps';
import { Field, NavButtons, StepCard, StepStatus, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

export default function DeployTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const [admin, setAdmin] = useState(ctx.account);
  const [form, setForm] = useState({ nftName: 'ATMRank Voucher', nftSymbol: 'ATMV' });
  const [includeOptional, setIncludeOptional] = useState(true);
  const [checks, setChecks] = useState<Partial<Record<ContractKey, StepResult | 'checking'>>>({});
  const [busy, setBusy] = useState<ContractKey | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  // per-contract implementation field for the proxy step: auto-filled from step 1, or pasted
  const [implInputs, setImplInputs] = useState<Partial<Record<ContractKey, string>>>({});
  // finished contracts collapse to one line; their deploy controls only open on "Redeploy…"
  const [reopen, setReopen] = useState<Partial<Record<ContractKey, boolean>>>({});

  useEffect(() => setAdmin(ctx.account), [ctx.account]);

  useEffect(() => {
    setImplInputs((cur) => {
      const next = { ...cur };
      for (const [k, v] of Object.entries(ctx.book.pendingImpl)) if (v) next[k as ContractKey] = v;
      return next;
    });
  }, [ctx.book.pendingImpl]);

  const refresh = useCallback(async () => {
    setChecks(Object.fromEntries(DEPLOY_STEPS.map((s) => [s.key, 'checking'])));
    const out: Partial<Record<ContractKey, StepResult>> = {};
    for (const s of DEPLOY_STEPS) out[s.key] = await checkDeployStep(ctx, s).catch((e) => ({ done: false, warn: e.message }));
    setChecks(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book.contracts, ctx.reader]);

  useEffect(() => { refresh(); }, [refresh]);

  const missingDeps = (s: DeployStep) => s.needs.filter((k) => !ctx.getBook().contracts[k]);
  const statusOf = (s: DeployStep): StepStatus => {
    const c = checks[s.key];
    if (c === 'checking') return 'checking';
    if (c?.done) return 'done';
    return missingDeps(s).length ? 'blocked' : 'todo';
  };
  const remaining = DEPLOY_STEPS.filter((s) => {
    const c = checks[s.key];
    return !(c && c !== 'checking' && c.done) && (includeOptional || !s.optional);
  });

  const validate = () => {
    if (!isAddr(admin)) throw new Error('Admin address is not valid');
    if (!form.nftName.trim() || !form.nftSymbol.trim()) throw new Error('VoucherNFT name and symbol are required');
  };

  // Real money + production addresses: make the operator say so explicitly, every time.
  const confirmMainnet = () =>
    ctx.chainId !== BSC_MAINNET.chainId ||
    window.confirm('You are about to deploy on BSC MAINNET. This spends real BNB and creates production contracts. Continue?');

  const run = async (s: DeployStep, impl?: string) => {
    setBusy(s.key);
    setError('');
    try {
      await runDeployStep(ctx, s, admin, { nftName: form.nftName.trim(), nftSymbol: form.nftSymbol.trim() }, impl);
      return true;
    } catch (e: any) {
      setError(`${s.key}: ${e.message}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const deployOne = async (s: DeployStep, impl?: string) => {
    try {
      validate();
      if (impl !== undefined && !isAddr(impl)) throw new Error(`${s.key}: implementation address is not valid`);
    } catch (e: any) {
      return setError(e.message);
    }
    if (!confirmMainnet()) return;
    if (ctx.getBook().contracts[s.key] && !window.confirm(
      `${s.key} already has an address in this book. Redeploying replaces it here, and anything already pointing at the old one ` +
      '(other contracts, backends, roles) will NOT follow automatically. Continue?'
    )) return;
    await run(s, impl);
    await refresh();
  };

  // Step 1 only: deploys the logic contract; its address auto-fills the proxy step below.
  const deployImplOnly = async (s: DeployStep) => {
    if (!confirmMainnet()) return;
    setBusy(s.key);
    setError('');
    try {
      const impl = await ctx.deployImpl(s.key);
      setImplInputs((cur) => ({ ...cur, [s.key]: impl }));
    } catch (e: any) {
      setError(`${s.key}: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const deployAll = async () => {
    try {
      validate();
    } catch (e: any) {
      return setError(e.message);
    }
    if (!confirmMainnet()) return;
    let allOk = true;
    for (const s of remaining) {
      if (missingDeps(s).length) continue;
      if (!(await run(s))) { allOk = false; break; }
    }
    await refresh();
    if (allOk) setDone(true);
  };

  return (
    <div className="space-y-4">
      <Card title="Deployment settings">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Admin address" hint="Gets DEFAULT_ADMIN_ROLE on every contract. Keep it as the connected wallet, or the wiring steps can't be sent from here.">
            <input className={inputCls} value={admin} onChange={(e) => setAdmin(e.target.value.trim())} />
          </Field>
          <Field label="VoucherNFT name">
            <input className={inputCls} value={form.nftName} onChange={(e) => setForm({ ...form, nftName: e.target.value })} />
          </Field>
          <Field label="VoucherNFT symbol">
            <input className={inputCls} value={form.nftSymbol} onChange={(e) => setForm({ ...form, nftSymbol: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <label className="flex items-center gap-2 text-sm text-txt-secondary">
            <input type="checkbox" checked={includeOptional} onChange={(e) => setIncludeOptional(e.target.checked)} />
            Include optional contracts in &quot;Deploy all&quot;
          </label>
          <button className={btnCls} disabled={!!busy || remaining.length === 0} onClick={deployAll}>Deploy all remaining ({remaining.length})</button>
          <button className={btnSecondaryCls} disabled={!!busy} onClick={refresh}>Re-check</button>
        </div>
        {!sameAddr(admin, ctx.account) && isAddr(admin) && (
          <p className="text-xs text-yellow-300 mt-3">
            ⚠ Admin is not the connected wallet. The contracts will deploy, but every wiring/config step on the next tabs must then be sent from {shortAddr(admin)} — this wallet will get &quot;AccessControlUnauthorizedAccount&quot;.
          </p>
        )}
        {error && <p className="text-xs text-red-300 mt-3 break-all">{error}</p>}
        {done && (
          <p className="text-xs text-green-300 mt-3">
            ✓ Deploy run finished. Export the address book now (Overview tab) — until then the addresses exist only in this browser.
          </p>
        )}
        <p className="text-xs text-txt-secondary mt-3">
          Upgradeable contracts deploy as implementation + proxy (2 transactions each).
        </p>
      </Card>

      {DEPLOY_STEPS.map((s, i) => {
        const c = checks[s.key];
        const a = ctx.book.contracts[s.key];
        const pending = ctx.book.pendingImpl[s.key];
        const deps = missingDeps(s);
        return (
          <StepCard
            key={s.key}
            index={i + 1}
            title={`${s.key}${s.proxy ? ' (UUPS proxy)' : ''}`}
            why={statusOf(s) === 'done' && !reopen[s.key] ? undefined : s.what}
            optional={s.optional}
            status={statusOf(s)}
            warn={c && c !== 'checking' ? c.warn : undefined}
          >
            {a && (
              <p className="text-xs">
                <span className="text-txt-secondary">Address </span>
                <a className="font-mono text-accent break-all" href={getExplorerAddressUrl(ctx.chainId, a)} target="_blank" rel="noopener noreferrer">{a}</a>
                {ctx.book.implementations[s.key] && <span className="text-txt-secondary"> · impl {shortAddr(ctx.book.implementations[s.key] as string)}</span>}
              </p>
            )}
            {pending && <p className="text-xs text-yellow-300">Implementation already deployed at <span className="font-mono">{pending}</span> — step 2 (or &quot;Deploy all&quot;) only sends the proxy tx.</p>}
            {deps.length > 0 && <p className="text-xs text-txt-secondary">Deploy first: {deps.join(', ')}</p>}
            {statusOf(s) === 'done' && !reopen[s.key] ? (
              <button className={linkBtnCls} disabled={!!busy} onClick={() => setReopen((p) => ({ ...p, [s.key]: true }))}>Redeploy…</button>
            ) : s.proxy ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
                  <h5 className="text-xs font-semibold">1. Implementation</h5>
                  <p className="text-[11px] text-txt-secondary">Deploys the {s.key} logic contract. Its address fills in step 2 automatically.</p>
                  <button className={btnSecondaryCls} disabled={!!busy || deps.length > 0} onClick={() => deployImplOnly(s)}>
                    {busy === s.key ? 'Deploying…' : 'Deploy implementation'}
                  </button>
                </div>
                <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
                  <h5 className="text-xs font-semibold">2. Proxy + initialize</h5>
                  <input
                    className={inputCls}
                    value={implInputs[s.key] || ''}
                    onChange={(e) => setImplInputs({ ...implInputs, [s.key]: e.target.value.trim() })}
                    placeholder="Implementation address (step 1, or paste one)"
                  />
                  <button className={btnCls} disabled={!!busy || deps.length > 0 || !isAddr(implInputs[s.key] || '')} onClick={() => deployOne(s, implInputs[s.key])}>
                    {busy === s.key ? 'Deploying…' : a ? 'Redeploy proxy' : 'Deploy proxy'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button className={btnCls} disabled={!!busy || deps.length > 0} onClick={() => deployOne(s)}>
                  {busy === s.key ? 'Deploying…' : a ? 'Redeploy' : 'Deploy'}
                </button>
              </div>
            )}
            {busy === s.key && <span className="text-xs text-txt-secondary">Confirm each transaction in your wallet…</span>}
          </StepCard>
        );
      })}

      <p className="text-xs text-txt-secondary">
        Need more reward pools (e.g. one per token)? Deploy them on the{' '}
        <button className={linkBtnCls} onClick={() => onGo('funding')}>Fund pools</button> tab.
      </p>

      <NavButtons next={['wire', 'Next: wire contracts']} onGo={onGo} />
    </div>
  );
}
