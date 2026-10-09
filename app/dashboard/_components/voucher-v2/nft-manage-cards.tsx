'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import {
  FundingMode, PayoutMode, VoucherMode, VoucherType, ZERO, enumName, isAddr, loadVoucherTypes, sameAddr, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { useSourceOptions } from './source-options';
import { useHasRole } from './use-role';
import { AddressInput, Badge, ContractTag, Field, Select, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

type Msg = { ok: boolean; text: string } | null;

/** Small helper: send one VoucherNFT / vault tx with busy + message handling. */
function useSender() {
  const ctx = useVoucherV2();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (label: string, key: 'VoucherNFT' | 'RevocationVault', method: string, args: any[]) => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(label, ctx.write(key), method, args);
      setMsg({ ok: true, text: label });
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, run };
}

// ── Edit a voucher type after it was created (OPERATOR_ROLE on VoucherNFT) ──
export function EditTypeCard() {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const canEdit = useHasRole('VoucherNFT', 'OPERATOR_ROLE') === true;
  const [types, setTypes] = useState<VoucherType[]>([]);
  const t = types.find((x) => x.id === ctx.typeId);
  const [v, setV] = useState({ name: '', source: '', fundingMode: 0, recipient: '', payoutMode: 0, route: '', revokeTo: '', gate: '' });
  const { busy, msg, run } = useSender();
  const sources = useSourceOptions(t ? t.mode : null, t?.tokenStandard ?? 0);

  const load = useCallback(async () => {
    if (!c.VoucherNFT || !ctx.reader) return;
    const ts = await loadVoucherTypes(ctx.read('VoucherNFT')).catch(() => []);
    setTypes(ts);
    if (ctx.typeId < 0 && ts.length) ctx.setTypeId(ts[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.VoucherNFT, ctx.reader, ctx.revision]);
  useEffect(() => { load(); }, [load]);
  // form starts from the type's current settings whenever the type (or chain state) changes
  useEffect(() => {
    if (!t) return;
    setV({ name: t.name, source: t.fundingSource, fundingMode: t.fundingMode, recipient: t.payoutRecipient, payoutMode: t.payoutMode, route: t.routeTarget, revokeTo: t.revokeDestination, gate: t.transferGate });
  }, [t?.id, t?.name, t?.fundingSource, t?.fundingMode, t?.payoutRecipient, t?.payoutMode, t?.routeTarget, t?.revokeDestination, t?.transferGate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c.VoucherNFT || !types.length) return null;
  const reward = t?.mode === VoucherMode.Reward;
  const usesIncentive = !!t && sameAddr(v.source, c.VoucherIncentive || '') || (ctx.book.extraSinks || []).some((x) => x.kind === 'VoucherIncentive' && sameAddr(x.address, v.source));
  const changed = (a: unknown, b: unknown) => String(a).toLowerCase() !== String(b).toLowerCase();
  const Row = ({ label, hint, children, onSave, dirty }: { label: string; hint?: string; children: React.ReactNode; onSave: () => void; dirty: boolean }) => (
    <Field label={label} hint={hint}>
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0">{children}</div>
        {canEdit && <button className={btnSecondaryCls} disabled={busy || !dirty} onClick={onSave}>Save</button>}
      </div>
    </Field>
  );

  return (
    <Card title="Edit a voucher type">
      <ContractTag contract="VoucherNFT" methods={['setVoucherTypeName', 'setVoucherTypeFundingSource', 'setVoucherTypePayoutRecipient', 'setVoucherTypePayoutConfig', 'setVoucherTypeRevokeDestination', 'setVoucherTypeTransferGate', 'emergencyShutdownType', 'reactivateType']} />
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3 mb-3">
        <Field label="Type"><Select value={ctx.typeId} onChange={ctx.setTypeId} options={types.map((x) => ({ label: typeLabel(x), value: x.id }))} /></Field>
        {t && (
          <div className="self-end pb-2 flex flex-wrap gap-2 text-xs">
            {t.mintingPaused ? <Badge tone="bad">minting paused</Badge> : <Badge tone="good">minting on</Badge>}
            {t.redemptionPaused ? <Badge tone="bad">claiming paused</Badge> : <Badge tone="good">claiming on</Badge>}
          </div>
        )}
      </div>
      {!canEdit && <p className="text-xs text-yellow-300 mb-3">View only — editing a type needs OPERATOR_ROLE on VoucherNFT.</p>}
      {t && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Row label="Name" dirty={changed(v.name, t.name)} onSave={() => run(`Type ${t.id}: rename to "${v.name.trim()}"`, 'VoucherNFT', 'setVoucherTypeName', [t.id, v.name.trim()])}>
            <input className={inputCls} disabled={!canEdit} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Row>
          <Row
            label={reward ? 'Pays from (pool) + funding mode' : 'Points ledger'}
            hint="Can't move to another pool while this type's vouchers still hold reserved tokens in the current one."
            dirty={changed(v.source, t.fundingSource) || v.fundingMode !== t.fundingMode}
            onSave={() => run(`Type ${t.id}: pool → ${ctx.nameOf(v.source)}`, 'VoucherNFT', 'setVoucherTypeFundingSource', [t.id, v.source, v.fundingMode])}
          >
            <Select value={sources.some((o) => sameAddr(o.value, v.source)) ? (sources.find((o) => sameAddr(o.value, v.source)) as { value: string }).value : v.source} onChange={(x) => setV({ ...v, source: x })}
              options={[...sources.map((o) => ({ label: `${o.approved === false ? '✗ ' : ''}${o.label}`, value: o.value })), ...(sources.some((o) => sameAddr(o.value, v.source)) ? [] : [{ label: ctx.nameOf(v.source), value: v.source }])]} />
            {reward && (
              <div className="mt-2">
                <Select value={v.fundingMode} onChange={(x) => setV({ ...v, fundingMode: x })} options={[{ label: 'Reserved — tokens set aside at mint', value: FundingMode.Reserved }, { label: 'On claim — paid from the free balance', value: FundingMode.OnClaim }]} />
              </div>
            )}
          </Row>
          {reward && (
            <Row label="Payout recipient" hint="Whoever claims (0x0), or a fixed address approved under Payout recipients (SourceRegistry)." dirty={changed(v.recipient, t.payoutRecipient)}
              onSave={() => run(`Type ${t.id}: payout recipient → ${ctx.nameOf(v.recipient)}`, 'VoucherNFT', 'setVoucherTypePayoutRecipient', [t.id, v.recipient])}>
              <AddressInput value={v.recipient} onChange={(x) => setV({ ...v, recipient: x })} options={[{ label: 'Whoever claims', value: ZERO }]} />
            </Row>
          )}
          {reward && (
            <Row label="Payout mode" hint={usesIncentive ? 'How VoucherIncentive delivers the reward. Routed needs an approved route target.' : 'Only VoucherIncentive pools use this — a RewardSink always pays directly.'}
              dirty={v.payoutMode !== t.payoutMode || changed(v.route, t.routeTarget)}
              onSave={() => run(`Type ${t.id}: payout mode → ${enumName(PayoutMode, v.payoutMode)}`, 'VoucherNFT', 'setVoucherTypePayoutConfig', [t.id, v.payoutMode, v.payoutMode === PayoutMode.Routed ? v.route : ZERO])}>
              <Select value={v.payoutMode} onChange={(x) => setV({ ...v, payoutMode: x })} options={[{ label: 'Direct (to the claimer)', value: PayoutMode.Direct }, { label: 'Routed (to a route target)', value: PayoutMode.Routed }, { label: 'External (nothing moves)', value: PayoutMode.External }]} />
              {v.payoutMode === PayoutMode.Routed && <div className="mt-2"><AddressInput value={v.route} onChange={(x) => setV({ ...v, route: x })} placeholder="0x… route target" /></div>}
            </Row>
          )}
          <Row label="Revoked vouchers go to" dirty={changed(v.revokeTo, t.revokeDestination)}
            onSave={() => run(`Type ${t.id}: revoke destination → ${ctx.nameOf(v.revokeTo)}`, 'VoucherNFT', 'setVoucherTypeRevokeDestination', [t.id, v.revokeTo])}>
            <AddressInput value={v.revokeTo} onChange={(x) => setV({ ...v, revokeTo: x })} options={c.RevocationVault ? [{ label: 'RevocationVault', value: c.RevocationVault }] : []} />
          </Row>
          <Row label="Transfer gate" hint="0x0 = no restriction on who may hold / receive." dirty={changed(v.gate, t.transferGate)}
            onSave={() => run(`Type ${t.id}: transfer gate → ${ctx.nameOf(v.gate)}`, 'VoucherNFT', 'setVoucherTypeTransferGate', [t.id, v.gate])}>
            <AddressInput value={v.gate} onChange={(x) => setV({ ...v, gate: x })} options={[{ label: 'None', value: ZERO }]} />
          </Row>
        </div>
      )}
      {t && canEdit && (
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-white/10">
          <span className="text-xs text-txt-secondary flex-1 min-w-[220px]">Emergency: stop both minting and claiming for this type at once (or turn both back on).</span>
          <button className={btnDangerCls} disabled={busy} onClick={() => window.confirm(`Shut down type #${t.id}? Minting and claiming both stop until reactivated.`) && run(`Type ${t.id}: emergency shutdown`, 'VoucherNFT', 'emergencyShutdownType', [t.id])}>Emergency shut down</button>
          <button className={btnSecondaryCls} disabled={busy} onClick={() => run(`Type ${t.id}: reactivate`, 'VoucherNFT', 'reactivateType', [t.id])}>Reactivate</button>
        </div>
      )}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}

// ── VoucherNFT admin: pause everything, base URI (DEFAULT_ADMIN_ROLE) ──
export function NftAdminCard() {
  const ctx = useVoucherV2();
  const isAdmin = useHasRole('VoucherNFT', 'DEFAULT_ADMIN_ROLE') === true;
  const [paused, setPaused] = useState<boolean | null>(null);
  const [uri, setUri] = useState('');
  const [sampleUri, setSampleUri] = useState('');
  const { busy, msg, run } = useSender();

  useEffect(() => {
    if (!ctx.book.contracts.VoucherNFT || !ctx.reader) return;
    const nft = ctx.read('VoucherNFT');
    nft.paused().then(setPaused).catch(() => setPaused(null));
    nft.totalSupply().then((n: any) => (n.gt(0) ? nft.tokenByIndex(0).then((id: any) => nft.tokenURI(id)) : '')).then((u: string) => setSampleUri(u || '')).catch(() => setSampleUri(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book.contracts.VoucherNFT, ctx.reader, ctx.revision]);

  if (!ctx.book.contracts.VoucherNFT) return null;
  return (
    <Card title="VoucherNFT admin">
      <ContractTag contract="VoucherNFT" methods={['pause', 'unpause', 'setBaseURI']} />
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <span>All minting: {paused === null ? '…' : paused ? <Badge tone="bad">paused</Badge> : <Badge tone="good">running</Badge>}</span>
        {isAdmin && (paused
          ? <button className={btnSecondaryCls} disabled={busy} onClick={() => run('VoucherNFT: unpause', 'VoucherNFT', 'unpause', [])}>Unpause</button>
          : <button className={btnDangerCls} disabled={busy} onClick={() => window.confirm('Pause VoucherNFT? All minting stops for every type until unpaused.') && run('VoucherNFT: pause', 'VoucherNFT', 'pause', [])}>Pause all minting</button>)}
      </div>
      <Field label="Metadata base URI" hint={`Each voucher's tokenURI = base URI + its id.${sampleUri ? ` Current example: ${sampleUri}` : ''}`}>
        <div className="flex gap-2">
          <input className={inputCls} disabled={!isAdmin} value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://… /metadata/" />
          {isAdmin && <button className={btnSecondaryCls} disabled={busy || !uri.trim()} onClick={() => run('VoucherNFT: set base URI', 'VoucherNFT', 'setBaseURI', [uri.trim()])}>Set</button>}
        </div>
      </Field>
      {!isAdmin && <p className="text-xs text-yellow-300 mt-2">View only — these need the VoucherNFT admin (DEFAULT_ADMIN_ROLE).</p>}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}

// ── RevocationVault: revoked vouchers it holds, and release them (vault DEFAULT_ADMIN_ROLE) ──
export function VaultCard() {
  const ctx = useVoucherV2();
  const vault = ctx.book.contracts.RevocationVault;
  const isAdmin = useHasRole('RevocationVault', 'DEFAULT_ADMIN_ROLE') === true;
  const [ids, setIds] = useState<number[] | null>(null);
  const [to, setTo] = useState<Record<number, string>>({});
  const { busy, msg, run } = useSender();

  const load = useCallback(async () => {
    if (!vault || !ctx.book.contracts.VoucherNFT || !ctx.reader) return;
    const nft = ctx.read('VoucherNFT');
    const n = Math.min((await nft.balanceOf(vault)).toNumber(), 500);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await nft.tokenOfOwnerByIndex(vault, i)).toNumber());
    setIds(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, ctx.book.contracts.VoucherNFT, ctx.reader, ctx.revision]);
  useEffect(() => { load().catch(() => setIds([])); }, [load]);

  if (!vault) return null;
  return (
    <Card title="Revoked vouchers (RevocationVault)">
      <ContractTag contract="RevocationVault" methods={['release']} />
      <p className="text-xs text-txt-secondary mb-3">Vouchers revoked to the vault stay here. Its admin can release one to an address (it stays revoked — it can&apos;t be claimed).</p>
      {ids === null ? <p className="text-xs text-txt-secondary">Loading…</p> : !ids.length ? <p className="text-xs text-txt-secondary">The vault holds no vouchers.</p> : (
        <div className="space-y-1.5">
          {ids.map((id) => (
            <div key={id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold">Voucher #{id}</span>
              {isAdmin && (
                <>
                  <div className="flex-1 min-w-[220px]"><AddressInput value={to[id] || ''} onChange={(x) => setTo((p) => ({ ...p, [id]: x }))} placeholder="release to 0x…" /></div>
                  <button className={linkBtnCls} disabled={busy || !isAddr(to[id] || '')} onClick={() => run(`Release voucher #${id} → ${ctx.nameOf(to[id])}`, 'RevocationVault', 'release', [ctx.book.contracts.VoucherNFT, id, to[id]])}>Release</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!isAdmin && !!ids?.length && <p className="text-xs text-yellow-300 mt-2">View only — releasing needs the RevocationVault admin.</p>}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}

