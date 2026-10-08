'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { useWeb3 } from '@/lib/contracts/use-web3';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import { ContractKey, ZERO, isAddr, poolKind, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { ContractTag, AddressInput, AddressOption, Field, btnDangerCls, btnSecondaryCls, inputCls } from './ui';

// RewardSink / VoucherIncentive / SourceRegistry carry an informational on-chain `name`;
// the two sinks also have an optional `accessControl` consulted before every real payout.
const TARGETS: { key: ContractKey; accessControl: boolean; nameHint: string }[] = [
  { key: 'RewardSink', accessControl: true, nameHint: 'e.g. "Main pool (Native + USDT)"' },
  { key: 'VoucherIncentive', accessControl: true, nameHint: 'e.g. "Points + deferred rewards"' },
  { key: 'SourceRegistry', accessControl: false, nameHint: 'e.g. "Voucher V2 registry"' },
];

interface State { name: string; acl: string }
// one row per contract: the book's main contracts plus every extra RewardSink pool
type Target = { id: string; key: ContractKey; address: string; title: string; accessControl: boolean; nameHint: string };

export default function PoolsCard({ only }: { only?: 'pools' | 'registry' } = {}) {
  const ctx = useVoucherV2();
  const { hubAddress } = useWeb3();
  const [state, setState] = useState<Record<string, State>>({});
  const [nameIn, setNameIn] = useState<Record<string, string>>({});
  const [aclIn, setAclIn] = useState<Record<string, string>>({});
  const [aclCheck, setAclCheck] = useState<Record<string, string>>({});
  const [hubAcl, setHubAcl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const all: Target[] = [
    ...TARGETS.filter((t) => ctx.book.contracts[t.key]).map((t) => ({ ...t, id: t.key, address: ctx.book.contracts[t.key] as string, title: t.key })),
    ...(ctx.book.extraSinks || []).map((x) => ({ id: x.address, key: poolKind(x) as ContractKey, address: x.address, title: `${poolKind(x)} "${x.name}"`, accessControl: true, nameHint: 'e.g. "USDT payouts"' })),
  ];
  const present = all.filter((t) => !only || (only === 'registry' ? t.key === 'SourceRegistry' : t.key !== 'SourceRegistry'));

  const load = useCallback(async () => {
    if (!ctx.reader) return;
    const out: Record<string, State> = {};
    for (const t of present) {
      const c = ctx.read(t.key, t.address);
      // older deployments (before names / access control) don't have these getters
      const name = await c.name().catch(() => null);
      const acl = t.accessControl ? await c.accessControl().catch(() => null) : '';
      out[t.id] = { name: name ?? '(not supported by this deployment)', acl: acl ?? '(not supported)' };
    }
    setState(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book.contracts, ctx.book.extraSinks, ctx.reader, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  // The ATM access control contract the GameHub already resolves to — offered as a quick pick.
  useEffect(() => {
    if (!hubAddress || !ctx.reader) return setHubAcl('');
    new ethers.Contract(hubAddress, GameHubArtifact.abi, ctx.reader).accessControl()
      .then((a: string) => setHubAcl(sameAddr(a, ZERO) ? '' : a))
      .catch(() => setHubAcl(''));
  }, [hubAddress, ctx.reader]);

  // Probe the pasted contract: it must answer redirectTarget(addr), or every payout would revert.
  const probe = async (key: string, addr: string) => {
    if (!isAddr(addr) || !ctx.reader) return setAclCheck((p) => ({ ...p, [key]: '' }));
    try {
      const acl = new ethers.Contract(addr, ['function redirectTarget(address) view returns (address)'], ctx.reader);
      const t: string = await acl.redirectTarget(ctx.account);
      const res = sameAddr(t, ctx.account) ? 'your wallet is unrestricted' : sameAddr(t, ZERO) ? 'your wallet is BLOCKED (blacklisted / frozen without safe wallet)' : `your wallet is frozen → pays ${t}`;
      setAclCheck((p) => ({ ...p, [key]: `✓ Responds to redirectTarget() — ${res}` }));
    } catch {
      setAclCheck((p) => ({ ...p, [key]: "✗ This address doesn't answer redirectTarget(address) — setting it would make every payout revert" }));
    }
  };

  const send = async (label: string, t: Target, method: string, args: any[]) => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(label, ctx.write(t.key, t.address), method, args);
      setMsg({ ok: true, text: label });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!present.length) return null;

  const aclOptions: AddressOption[] = hubAcl ? [{ label: 'ATM access control (from GameHub)', value: hubAcl }] : [];

  return (
    <Card title={only === 'registry' ? 'Registry name' : 'Pool names & access control'}>
        <ContractTag contract={only === 'registry' ? 'SourceRegistry' : 'RewardSink / VoucherIncentive'} methods={only === 'registry' ? ['setName'] : ['setName', 'setAccessControl']} />
      {only !== 'registry' && <p className="text-xs text-txt-secondary mb-3">
        <b>Name</b>: a label to tell pools apart. <b>Access control</b> (off by default): before each payout the pool asks the access control contract —
        frozen users are paid to their safe wallet, blacklisted users can&apos;t claim yet (the voucher stays claimable). Points are never checked.
      </p>}
      <div className="space-y-3">
        {present.map((t) => {
          const s = state[t.id];
          const aclOn = s && isAddr(s.acl) && !sameAddr(s.acl, ZERO);
          return (
            <div key={t.id} className="bg-surface-tertiary rounded-lg p-3 space-y-3">
              <h4 className="text-sm font-semibold">{t.title} <span className="font-mono text-xs text-txt-secondary">{t.address}</span></h4>
              <div className={`grid grid-cols-1 ${t.accessControl ? 'md:grid-cols-2' : ''} gap-3`}>
                <Field label={`Name — currently: ${s ? s.name || '(none)' : '…'}`} hint={t.nameHint}>
                  <div className="flex gap-2">
                    <input className={inputCls} value={nameIn[t.id] ?? ''} onChange={(e) => setNameIn((p) => ({ ...p, [t.id]: e.target.value }))} placeholder="New name" />
                    <button className={btnSecondaryCls} disabled={busy || !(nameIn[t.id] || '').trim()} onClick={() => send(`${t.title}: set name "${(nameIn[t.id] || '').trim()}"`, t, 'setName', [(nameIn[t.id] || '').trim()])}>Set</button>
                  </div>
                </Field>
                {t.accessControl && (
                  <Field
                    label={`Access control — currently: ${!s ? '…' : aclOn ? ctx.nameOf(s.acl) : s.acl.startsWith('(') ? s.acl : 'off'}`}
                    hint={
                      <>
                        Paste the access control contract address{hubAcl ? ', or pick the one the GameHub uses' : ''}. Leave off for a plain pool.
                        {aclCheck[t.id] && <span className={aclCheck[t.id]?.startsWith('✓') ? ' text-green-300' : ' text-red-300'}> {aclCheck[t.id]}</span>}
                      </>
                    }
                  >
                    <AddressInput value={aclIn[t.id] ?? ''} onChange={(v) => { setAclIn((p) => ({ ...p, [t.id]: v })); probe(t.id, v); }} options={aclOptions} />
                    <div className="flex gap-2 mt-2">
                      <button
                        className={btnSecondaryCls}
                        disabled={busy || !isAddr(aclIn[t.id] || '') || !aclCheck[t.id]?.startsWith('✓')}
                        onClick={() => send(`${t.title}: access control → ${ctx.nameOf(aclIn[t.id] as string)}`, t, 'setAccessControl', [aclIn[t.id]])}
                      >
                        Turn on
                      </button>
                      <button className={btnDangerCls} disabled={busy || !aclOn} onClick={() => send(`${t.title}: access control off`, t, 'setAccessControl', [ZERO])}>Turn off</button>
                    </div>
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}
