'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { ExternalLink } from 'lucide-react';
import Card from '@/components/card';
import { getExplorerAddressUrl, NETWORKS } from '@/lib/contracts/config';
import { ContractKey, emptyBook, isAddr, parseBookImport } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DEPLOY_STEPS, WIRE_STEPS, checkDeployStep, checkWireStep } from './steps';
import { PreflightCard, RulesCard } from './guide';
import HealthCard from './health-card';
import { Badge, Collapsible, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

const FLOW = [
  ['Deploy', 'each contract (UUPS proxies, your wallet becomes admin), or paste an existing address below.'],
  ['Wire', 'them together: registry link, sink approvals, DAO revoke role.'],
  ['Voucher types', 'register each type (Points credit/debit, Reward native/ERC20/NFT…) and its approved payout tokens.'],
  ['Minters & roles', 'who may mint each type (with daily caps), DAO approvers (they propose and approve).'],
  ['Fund pools', 'top up RewardSink with the assets Reward types pay out.'],
];

export default function OverviewTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const [loading, setLoading] = useState(false);
  const [deployDone, setDeployDone] = useState(0);
  const [wireDone, setWireDone] = useState(0);
  const [typeCount, setTypeCount] = useState<number | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<ContractKey | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tokName, setTokName] = useState('');
  const [tokAddr, setTokAddr] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      let deployed = 0;
      const v: Record<string, string> = {};
      for (const s of DEPLOY_STEPS) {
        const r = await checkDeployStep(ctx, s).catch(() => ({ done: false }));
        if (r.done) {
          deployed++;
          v[s.key] = await ctx.read(s.key).VERSION().catch(() => '');
        }
      }
      setDeployDone(deployed);
      setVersions(v);
      let wired = 0;
      for (const s of WIRE_STEPS.filter((x) => !x.optional)) {
        const r = await checkWireStep(ctx, s).catch(() => ({ done: false }));
        if (r.done) wired++;
      }
      setWireDone(wired);
      setTypeCount(ctx.book.contracts.VoucherNFT ? (await ctx.read('VoucherNFT').nextTypeId().catch(() => ethers.BigNumber.from(0))).toNumber() : null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book, ctx.reader, ctx.account]);

  useEffect(() => { refresh(); }, [refresh, ctx.revision]);

  const saveEdit = (key: ContractKey) => {
    if (editValue && !isAddr(editValue)) return setMsg({ ok: false, text: 'Not a valid address' });
    ctx.setAddress(key, editValue);
    setEditing(null);
  };

  const doImport = () => {
    try {
      const b = parseBookImport(importText, ctx.chainId);
      ctx.replaceBook(b);
      setMsg({ ok: true, text: `Imported ${Object.keys(b.contracts).length} contract addresses` });
      setImportText('');
      setShowImport(false);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const doExport = () => {
    const { contracts, implementations, tokens, extraSinks, deployedAt } = ctx.book;
    const data = { network: NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}`, chainId: ctx.chainId, deployedAt, contracts, implementations, extraSinks, tokens };
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voucher-v2-${ctx.chainId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    ctx.markExported();
  };

  const doClear = () => {
    if (!window.confirm('Forget every Voucher V2 address saved for this network in this browser? Deployed contracts are not affected. Export first if you need them.')) return;
    ctx.replaceBook(emptyBook());
  };

  const addToken = () => {
    ctx.setToken(tokName.trim(), tokAddr);
    setTokName('');
    setTokAddr('');
  };

  const requiredWire = WIRE_STEPS.filter((s) => !s.optional).length;
  const hasContracts = Object.keys(ctx.book.contracts).length > 0;
  const tiles: [string, string, string][] = [
    ['deploy', 'Contracts deployed', `${deployDone} / ${DEPLOY_STEPS.length}`],
    ['wire', 'Required wiring done', `${wireDone} / ${requiredWire}`],
    ['types', 'Voucher types', typeCount === null ? '—' : String(typeCount)],
  ];

  return (
    <div className="space-y-4">
      {/* nothing deployed yet: the preflight checklist is the useful first thing to see */}
      {!hasContracts && <PreflightCard onExport={doExport} onGo={onGo} />}
      {hasContracts && <HealthCard onGo={onGo} />}
      <Card title="Setup progress">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {tiles.map(([tab, label, value]) => (
            <button key={tab} onClick={() => onGo(tab)} className="text-left bg-surface-tertiary rounded-lg p-3 hover:ring-1 hover:ring-accent transition">
              <div className="text-xs text-txt-secondary">{label}</div>
              <div className="text-xl font-semibold mt-1">{value}</div>
            </button>
          ))}
        </div>
      </Card>

      {hasContracts && (
        <Collapsible title="Preflight checks" summary="network, admin wallet, gas balance">
          <PreflightCard onExport={doExport} onGo={onGo} />
        </Collapsible>
      )}
      <Collapsible title="How it fits together & rules" summary="the setup order and the gotchas worth knowing">
        <Card>
          <ol className="space-y-1.5 text-sm text-txt-secondary list-decimal pl-5">
            {FLOW.map(([title, text]) => <li key={title}><span className="text-txt-primary font-medium">{title}</span> {text}</li>)}
          </ol>
        </Card>
        <RulesCard />
      </Collapsible>

      <Collapsible
        key={hasContracts ? 'book-has' : 'book-empty'}
        title="Address book"
        summary={`${Object.keys(ctx.book.contracts).length} contract(s), ${Object.keys(ctx.book.tokens).length} token(s) · export / import / set existing`}
        defaultOpen={!hasContracts}
      >
      <Card>
        <p className="text-xs text-txt-secondary mb-3">
          Saved in this browser per network. Import accepts this tab&apos;s export or the voucher repo&apos;s{' '}
          <code className="text-accent">deployments/&lt;network&gt;.json</code>. Editing an address here doesn&apos;t touch the chain.
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          <button className={btnSecondaryCls} onClick={doExport}>Export JSON</button>
          <button className={btnSecondaryCls} onClick={() => setShowImport(!showImport)}>Import JSON</button>
          <button className={btnDangerCls} onClick={doClear}>Clear</button>
        </div>
        {msg && <p className={`text-xs mb-3 ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
        {showImport && (
          <div className="mb-4 space-y-2">
            <textarea className={`${inputCls} min-h-[120px]`} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"contracts": {"VoucherNFT": "0x…", …}}' />
            <button className={btnCls} onClick={doImport} disabled={!importText}>Import (replaces current book)</button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-txt-secondary border-b border-white/10">
                <th className="py-2 pr-3">Contract</th>
                <th className="py-2 pr-3">Address</th>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {DEPLOY_STEPS.map((s) => {
                const a = ctx.book.contracts[s.key];
                return (
                  <tr key={s.key} className="border-b border-white/5">
                    <td className="py-2 pr-3 whitespace-nowrap">{s.key} {s.optional && <Badge tone="muted">optional</Badge>}</td>
                    <td className="py-2 pr-3">
                      {editing === s.key ? (
                        <input className={inputCls} value={editValue} onChange={(e) => setEditValue(e.target.value.trim())} placeholder="0x… (blank to unset)" />
                      ) : a ? (
                        <a href={getExplorerAddressUrl(ctx.chainId, a)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent inline-flex items-center gap-1 break-all">
                          {a} <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      ) : <span className="text-txt-secondary">not set</span>}
                    </td>
                    <td className="py-2 pr-3">{versions[s.key] || ''}</td>
                    <td className="py-2 whitespace-nowrap text-right">
                      {editing === s.key ? (
                        <>
                          <button className={linkBtnCls} onClick={() => saveEdit(s.key)}>Save</button>{' '}
                          <button className={linkBtnCls} onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className={linkBtnCls} onClick={() => { setEditing(s.key); setEditValue(a || ''); }}>Set existing</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {Object.entries(ctx.book.tokens).map(([name, a]) => (
                <tr key={name} className="border-b border-white/5">
                  <td className="py-2 pr-3">{name} <Badge tone="muted">token</Badge></td>
                  <td className="py-2 pr-3 font-mono break-all">{a}</td>
                  <td />
                  <td className="py-2 text-right"><button className={linkBtnCls} onClick={() => ctx.setToken(name, null)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr_auto] gap-2 mt-4">
          <input className={inputCls} value={tokName} onChange={(e) => setTokName(e.target.value)} placeholder="Token label (e.g. USDT)" />
          <input className={inputCls} value={tokAddr} onChange={(e) => setTokAddr(e.target.value.trim())} placeholder="Token address 0x…" />
          <button className={btnSecondaryCls} onClick={addToken} disabled={!tokName.trim() || !isAddr(tokAddr)}>Add payout token</button>
        </div>
        <p className="text-[11px] text-txt-secondary mt-2">Saved tokens appear as quick picks on the Voucher types and Fund pools tabs.</p>
      </Card>
      </Collapsible>
    </div>
  );
}
