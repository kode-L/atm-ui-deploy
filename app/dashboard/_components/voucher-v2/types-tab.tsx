'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '@/components/card';
import {
  FundingMode, PayoutMode, PointsDirection, TokenStandard, VoucherMode, VoucherType, ZERO,
  MAX_UINT, enumName, eventArg, isAddr, kindOf, loadVoucherTypes, settledRead, sameAddr, toUnits, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DESTINATION_LISTS } from './destinations-card';
import { useSourceOptions } from './source-options';
import { ContractTag, AddressInput, AddressOption, Badge, Collapsible, Field, NavButtons, Select, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

interface Form {
  name: string;
  mode: number;
  pointsDirection: number;
  tokenStandard: number;
  fundingMode: number;
  payoutMode: number;
  routeTarget: string;
  payoutRecipient: string;
  settlementTarget: string;
  approvalsRequired: number;
  redemptionDays: number;
  transferGate: string;
  revokeDestination: string;
  transferable: boolean;
  approvedTokens: string[];
  pauseClaiming: boolean;
  grantSelfMinter: boolean;
  grantDaoMinter: boolean;
}

const blank = (): Form => ({
  name: '',
  mode: VoucherMode.Points,
  pointsDirection: PointsDirection.Credit,
  tokenStandard: TokenStandard.ERC20,
  fundingMode: FundingMode.Reserved,
  payoutMode: PayoutMode.Direct,
  routeTarget: '',
  payoutRecipient: ZERO,
  settlementTarget: ZERO,
  approvalsRequired: 1,
  redemptionDays: 0,
  transferGate: ZERO,
  revokeDestination: ZERO,
  transferable: true,
  approvedTokens: [],
  pauseClaiming: false,
  grantSelfMinter: true,
  grantDaoMinter: false,
});

const num = (v: string) => Math.max(0, parseInt(v || '0', 10) || 0);

const isRewardMode = (m: number) => m === VoucherMode.Reward;

export default function TypesTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [presetId, setPresetId] = useState('pointsCredit');
  const [f, setF] = useState<Form>(blank());
  const [types, setTypes] = useState<VoucherType[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tokenEdit, setTokenEdit] = useState('');
  const [newToken, setNewToken] = useState('');
  const [m, setM] = useState({ typeId: -1, to: ctx.account, faceValue: '', token: '', tokenId: '0' });

  const presets = useMemo(() => {
    const vi = c.VoucherSettlement || ZERO;
    const rs = c.RewardVault || ZERO;
    return [
      { id: 'pointsCredit', label: 'Points — claiming adds points', note: "Claiming adds the voucher's value to the holder's points balance.", apply: { name: 'Points Credit', settlementTarget: vi, revokeDestination: c.RevocationVault || ZERO } },
      { id: 'pointsDebit', label: 'Points — claiming spends points', note: "Claiming takes the voucher's value from the holder's points (fails if they don't have enough).", apply: { name: 'Points Debit', pointsDirection: PointsDirection.Debit, settlementTarget: vi } },
      { id: 'rewardNative', label: 'Reward — native coin (BNB)', note: "Claiming pays native coin from the chosen pool.", apply: { name: 'Reward Native', mode: VoucherMode.Reward, tokenStandard: TokenStandard.Native, settlementTarget: rs, approvedTokens: [ZERO] } },
      { id: 'rewardErc20', label: 'Reward — ERC20 token', note: "Claiming pays an ERC20 token (e.g. USDT) from the chosen pool.", apply: { name: 'Reward ERC20', mode: VoucherMode.Reward, tokenStandard: TokenStandard.ERC20, settlementTarget: rs } },
      { id: 'rewardDeferred', label: 'Reward — ERC20 via VoucherSettlement (paid on claim)', note: "Claiming records what the holder is owed on VoucherSettlement; it can pay them directly, route the tokens to another pool, or leave delivery to another system.", apply: { name: 'Reward ERC20 Deferred', mode: VoucherMode.Reward, tokenStandard: TokenStandard.ERC20, fundingMode: FundingMode.OnClaim, redemptionDays: 14, settlementTarget: vi } },
      { id: 'daoGoverned', label: 'Reward — native coin, minted by a 2-vote DAO', note: "Every mint is a VoucherDAO proposal that needs 2 operator votes. Add at least 2 operators on Minters & roles.", apply: { name: 'Reward Native (DAO)', mode: VoucherMode.Reward, tokenStandard: TokenStandard.Native, settlementTarget: rs, approvalsRequired: 2, grantDaoMinter: true, grantSelfMinter: false, revokeDestination: c.RevocationVault || ZERO, approvedTokens: [ZERO] } },
      { id: 'custom', label: 'Custom (blank)', note: '', apply: {} },
    ] as { id: string; label: string; note: string; apply: Partial<Form> }[];
  }, [c.VoucherSettlement, c.RewardVault, c.RevocationVault]);

  const preset = presets.find((p) => p.id === presetId);
  const applyPreset = (id: string) => {
    setPresetId(id);
    setF({ ...blank(), ...(presets.find((p) => p.id === id)?.apply || {}) });
  };
  // Re-apply once the book loads, so preset addresses aren't stuck at 0x0.
  useEffect(() => { applyPreset(presetId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [presets]);

  const opt = (key: keyof typeof c, label: string): AddressOption[] => (c[key] ? [{ label, value: c[key] as string }] : []);
  const none: AddressOption = { label: 'None (0x0)', value: ZERO };
  const gateOptions = [none, ...opt('AllowlistTransferGate', 'AllowlistTransferGate')];
  const revokeOptions = [none, ...opt('RevocationVault', 'RevocationVault')];
  const tokenOptions: AddressOption[] = [{ label: 'Native coin (0x0)', value: ZERO }, ...Object.entries(ctx.book.tokens).map(([k, v]) => ({ label: k, value: v }))];

  const { nameOf } = ctx;

  // Funding source dropdown: approved pools by name; "Other" keeps a free-text field.
  const OTHER = '__other__';
  const sourceOptions = useSourceOptions(isRewardMode(f.mode) ? VoucherMode.Reward : VoucherMode.Points, f.tokenStandard);
  // every known pool, for showing a registered type's funding source by its name (same as the dropdown)
  const allSources = useSourceOptions(null, 0);
  const sourceCell = (a: string) => {
    if (sameAddr(a, ZERO)) return <span className="text-txt-secondary">none</span>;
    const o = allSources.find((x) => sameAddr(x.value, a));
    if (!o) return nameOf(a);
    const [name, kind] = o.label.split(' · ');
    // label is "name · contract · 0x…"; without an on-chain name it starts with the contract
    return kind && !kind.startsWith('0x') ? <><div>{name}</div><div className="text-txt-secondary text-[10px]">{kind}</div></> : name;
  };
  const [otherSource, setOtherSource] = useState(false);
  const known = sameAddr(f.settlementTarget, ZERO) || sourceOptions.some((o) => sameAddr(o.value, f.settlementTarget));
  const sourceChoice = otherSource || (!known && isAddr(f.settlementTarget))
    ? OTHER
    : sameAddr(f.settlementTarget, ZERO) ? ZERO : (sourceOptions.find((o) => sameAddr(o.value, f.settlementTarget))?.value ?? ZERO);

  const isReward = isRewardMode(f.mode);
  // "Who mints it": maps onto grantSelfMinter / grantDaoMinter; votes only matter for the DAO
  const minter: 'wallet' | 'dao' | 'both' = f.grantDaoMinter ? (f.grantSelfMinter ? 'both' : 'dao') : 'wallet';
  const setMinter = (m: string) => setF((prev) => ({
    ...prev,
    grantSelfMinter: m !== 'dao',
    grantDaoMinter: m !== 'wallet',
    // direct-only minting has no vote
    approvalsRequired: m === 'wallet' ? 1 : prev.approvalsRequired,
  }));
  // payout modes are read by VoucherSettlement only — a RewardVault always pays the claimer
  // (or the fixed payout recipient), so anything but Direct would be silently ignored there
  const usesSettlement = !!c.VoucherSettlement && sameAddr(f.settlementTarget, c.VoucherSettlement);
  const payoutMode = isReward && usesSettlement ? f.payoutMode : PayoutMode.Direct;
  const warnings = useMemo(() => {
    const w: string[] = [];
    if (!f.name.trim()) w.push('Name is required');
    if (f.approvalsRequired < 1) w.push('Mint approvals required must be at least 1');
    if (f.approvalsRequired > 1 && !f.grantDaoMinter) w.push(`Needs ${f.approvalsRequired} approvals but VoucherDAO won't be a minter — nobody can mint it until you grant VoucherDAO the minter role`);
    if (!isReward && f.pointsDirection === PointsDirection.Credit && sameAddr(f.settlementTarget, ZERO)) w.push('A Points Credit type with no funding source credits nothing on claim');
    if (isReward && sameAddr(f.settlementTarget, ZERO)) w.push('Reward types need a funding source to pay out');
    if (payoutMode === PayoutMode.Routed && !isAddr(f.routeTarget)) w.push('Routed payout needs a valid route target');
    for (const a of [f.settlementTarget, f.transferGate, f.revokeDestination, ...(isReward ? [f.payoutRecipient, ...f.approvedTokens] : [])]) {
      if (!isAddr(a)) w.push(`Not a valid address: ${a || '(empty)'}`);
    }
    return w;
  }, [f, isReward]);
  const noTokenWarning = isReward && f.approvedTokens.length === 0;

  // With VoucherNFT linked to the registry, a fixed payout recipient / route target must be on
  // the registry's allowlist (Wire tab) — check up front instead of letting the tx revert.
  const [destWarnings, setDestWarnings] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: string[] = [];
      try {
        if (!isReward || !c.VoucherNFT) return;
        const linked: string = await ctx.read('VoucherNFT').sourceRegistry();
        if (sameAddr(linked, ZERO)) return;
        const reg = ctx.read('SourceRegistry', linked);
        const checks: [string, string, string][] = [
          [DESTINATION_LISTS[0].key, f.payoutRecipient, 'Payout recipient'],
          [DESTINATION_LISTS[1].key, payoutMode === PayoutMode.Routed ? f.routeTarget : ZERO, 'Route target'],
        ];
        for (const [key, a, label] of checks) {
          if (!isAddr(a) || sameAddr(a, ZERO)) continue;
          if (!(await reg.isDestinationApproved(key, a))) out.push(`${label} ${nameOf(a)} isn't approved in SourceRegistry — approve it on the Wire tab (Payout destination allowlists) first`);
        }
      } catch {
        // older registry without destination lists, or a read failure — the tx itself still validates
      } finally {
        if (!cancelled) setDestWarnings(out);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReward, f.payoutRecipient, f.routeTarget, payoutMode, c.VoucherNFT, ctx.reader, ctx.revision]);

  const [daoMints, setDaoMints] = useState<number[]>([]);
  const load = useCallback(async () => {
    if (!ctx.book.contracts.VoucherNFT) return;
    setLoading(true);
    try {
      const nft = ctx.read('VoucherNFT');
      const ts = await loadVoucherTypes(nft);
      setTypes(ts);
      // which types VoucherDAO mints — "votes to mint" goes through it even at 1 approval
      const dao = ctx.book.contracts.VoucherDAO;
      if (dao) {
        const flags = await Promise.all(ts.map(async (t) => nft.hasRole(await nft.typeMinterRole(t.id), dao).catch(() => false)));
        setDaoMints(ts.filter((_, i) => flags[i]).map((t) => t.id));
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not read types: ${e.message}` });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book.contracts.VoucherNFT, ctx.reader]);

  useEffect(() => { load(); }, [load]);

  const register = async () => {
    if (warnings.length) return setMsg({ ok: false, text: warnings[0] });
    if (destWarnings.length) return setMsg({ ok: false, text: destWarnings[0] });
    setBusy(true);
    setMsg(null);
    ctx.beginFlow(`Create "${f.name.trim()}"`, [
      'Register the voucher type',
      ...(isReward ? f.approvedTokens.map((t) => `Approve payout token ${sameAddr(t, ZERO) ? 'native coin' : nameOf(t)}`) : []),
      ...(f.pauseClaiming ? ['Pause claiming'] : []),
      ...(f.grantSelfMinter ? ['Make my wallet a minter'] : []),
      ...(f.grantDaoMinter && c.VoucherDAO ? ['Make VoucherDAO a minter (unlimited)'] : []),
    ]);
    try {
      const nft = ctx.write('VoucherNFT');
      setProgress('Registering type…');
      const receipt = await ctx.send(`Register type "${f.name}"`, nft, 'registerVoucherType', [
        f.name.trim(),
        f.redemptionDays,
        f.transferable,
        f.approvalsRequired,
        f.mode,
        isReward ? f.tokenStandard : TokenStandard.Native,
        isReward ? f.payoutRecipient : ZERO,
        f.settlementTarget,
        isReward ? f.fundingMode : FundingMode.Reserved,
        isReward ? PointsDirection.Credit : f.pointsDirection,
        f.transferGate,
        f.revokeDestination,
        payoutMode,
        payoutMode === PayoutMode.Routed ? f.routeTarget : ZERO,
      ]);
      const typeId = Number(eventArg(receipt, nft, 'VoucherTypeRegistered', 'typeId'));
      if (isReward) {
        for (const token of f.approvedTokens) {
          setProgress(`Approving token ${nameOf(token)}…`);
          await ctx.send(`Type ${typeId}: approve token ${nameOf(token)}`, nft, 'addApprovedToken', [typeId, token]);
        }
      }
      if (f.pauseClaiming) {
        setProgress('Pausing claiming…');
        await ctx.send(`Type ${typeId}: pause claiming`, nft, 'setVoucherTypeClaimPaused', [typeId, true]);
      }
      if (f.grantSelfMinter) {
        setProgress('Granting minter role…');
        await ctx.send(`Type ${typeId}: minter → wallet`, nft, 'grantTypeMinterWithCap', [typeId, ctx.account, 0, 0]);
      }
      // any quorum: with 1 approval a DAO proposal executes the moment it's proposed
      if (f.grantDaoMinter && c.VoucherDAO) {
        setProgress('Granting minter role to VoucherDAO…');
        // unlimited: the DAO mints on behalf of every approved proposal — a 100/day default cap would stall it
        await ctx.send(`Type ${typeId}: minter → VoucherDAO (unlimited)`, nft, 'grantTypeMinterWithCap', [typeId, c.VoucherDAO, MAX_UINT, 0]);
      }
      setMsg({ ok: true, text: `Registered type #${typeId}` });
      const fresh = await settledRead(() => loadVoucherTypes(ctx.read('VoucherNFT')), (ts) => ts.length > typeId);
      if (fresh) setTypes(fresh);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const act = async (label: string, method: string, args: any[]) => {
    setMsg(null);
    try {
      await ctx.send(label, ctx.write('VoucherNFT'), method, args);
      setMsg({ ok: true, text: label });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const mintType = types.find((t) => t.id === m.typeId);
  const faceHint = !mintType ? '' : mintType.mode === VoucherMode.Points ? 'Whole points (integer)'
    : mintType.tokenStandard === TokenStandard.ERC721 ? 'Usually 0 for an NFT'
    : mintType.tokenStandard === TokenStandard.ERC1155 ? 'Quantity (integer)'
    : 'Token amount, e.g. 12.5 (18-decimal faceValue)';

  const testMint = async () => {
    if (!mintType) return;
    setBusy(true);
    setMsg(null);
    try {
      if (!isAddr(m.to)) throw new Error('Recipient is not a valid address');
      const reward = mintType.mode === VoucherMode.Reward;
      const fungible = reward && mintType.tokenStandard <= TokenStandard.ERC20;
      const faceValue = fungible ? toUnits(m.faceValue, 18) : String(num(m.faceValue));
      const token = reward ? m.token || mintType.approvedTokens[0] || ZERO : ZERO;
      const tokenId = reward && mintType.tokenStandard >= TokenStandard.ERC721 ? m.tokenId || '0' : '0';
      const nft = ctx.write('VoucherNFT');
      const receipt = await ctx.send(`Test mint type ${mintType.id}`, nft, 'mint', [mintType.id, m.to, 1, faceValue, 0, 0, token, tokenId]);
      setMsg({ ok: true, text: `Minted voucher #${eventArg(receipt, nft, 'VoucherMinted', 'voucherId').toString()}` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!c.VoucherNFT) {
    return <Card><p className="text-sm text-txt-secondary text-center py-6">Deploy (or set) VoucherNFT first.</p></Card>;
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-4">
      <Card title={`Registered types (${types.length})`}>
        <ContractTag contract="VoucherNFT" methods={['setVoucherTypeMintingPaused', 'setVoucherTypeClaimPaused', 'addApprovedToken', 'removeApprovedToken']} />
        <div className="flex justify-end -mt-10 mb-4">
          <button className={btnSecondaryCls} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Reload'}</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-txt-secondary border-b border-white/10">
                {['#', 'Name', 'Gives', 'Pays from', 'Votes to mint', 'Minting', 'Claiming', ''].map((h) => <th key={h} className="py-2 pr-3 whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <React.Fragment key={t.id}>
                  <tr className={`border-b border-white/5 align-top ${ctx.typeId === t.id ? 'bg-accent/5' : ''}`}>
                    <td className="py-2 pr-3">{t.id}</td>
                    <td className="py-2 pr-3">{t.name}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{kindOf(t)}</td>
                    <td className="py-2 pr-3">
                      {sourceCell(t.settlementTarget)}
                      {t.mode === VoucherMode.Reward && <div className="text-[10px] text-txt-secondary">{t.fundingMode === FundingMode.Reserved ? 'Reserved at mint' : 'Paid on claim'}</div>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {t.approvalsRequired > 1
                        ? <><b>{t.approvalsRequired}</b> votes<div className="text-txt-secondary text-[10px]">via VoucherDAO</div></>
                        : daoMints.includes(t.id)
                          ? <>1 vote<div className="text-txt-secondary text-[10px]">VoucherDAO · runs on propose</div></>
                          : <>1 <span className="text-txt-secondary">(direct)</span></>}
                    </td>
                    <td className="py-2 pr-3">
                      <button className={linkBtnCls} onClick={() => act(`Type ${t.id}: ${t.mintingPaused ? 'resume' : 'pause'} minting`, 'setVoucherTypeMintingPaused', [t.id, !t.mintingPaused])}>
                        {t.mintingPaused ? <Badge tone="bad">paused</Badge> : <Badge tone="good">on</Badge>}
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <button className={linkBtnCls} onClick={() => act(`Type ${t.id}: ${t.claimPaused ? 'resume' : 'pause'} claiming`, 'setVoucherTypeClaimPaused', [t.id, !t.claimPaused])}>
                        {t.claimPaused ? <Badge tone="bad">paused</Badge> : <Badge tone="good">on</Badge>}
                      </button>
                    </td>
                    <td className="py-2"><button className={linkBtnCls} onClick={() => { setExpanded(expanded === t.id ? null : t.id); ctx.setTypeId(t.id); }}>{expanded === t.id ? 'Close' : 'Manage'}</button></td>
                  </tr>
                  {expanded === t.id && (
                    <tr className="border-b border-white/5">
                      <td colSpan={8} className="py-3 bg-surface-tertiary/40 px-3 space-y-3">
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                          <div><div className="text-txt-secondary">Payout tokens</div>{t.mode === VoucherMode.Points ? 'n/a (points)' : t.approvedTokens.length === 0 ? <span className="text-yellow-300">none — can&apos;t mint</span> : t.approvedTokens.map((a) => <div key={a}>{sameAddr(a, ZERO) ? 'Native coin' : nameOf(a)}</div>)}</div>
                          <div><div className="text-txt-secondary">Transferable</div>{t.transferable ? 'yes' : 'no'}</div>
                          <div><div className="text-txt-secondary">Gate</div>{nameOf(t.transferGate)}</div>
                          <div><div className="text-txt-secondary">Revoke destination</div>{nameOf(t.revokeDestination)}</div>
                          <div><div className="text-txt-secondary">Payout recipient</div>{nameOf(t.payoutRecipient)}</div>
                          <div><div className="text-txt-secondary">Payout mode</div>{enumName(PayoutMode, t.payoutMode)}{t.payoutMode === PayoutMode.Routed && ` → ${nameOf(t.routeTarget)}`}</div>
                          <div><div className="text-txt-secondary">Redemption days</div>{t.redemptionDays}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-txt-secondary">This type&apos;s:</span>
                          <button className={btnSecondaryCls} onClick={() => { ctx.setTypeId(t.id); onGo('roles'); }}>Minters &amp; roles →</button>
                          {(t.approvalsRequired > 1 || daoMints.includes(t.id)) && <button className={btnSecondaryCls} onClick={() => { ctx.setTypeId(t.id); onGo('dao'); }}>DAO proposals →</button>}
                          {t.mode === VoucherMode.Reward && !sameAddr(t.settlementTarget, ZERO) && <button className={btnSecondaryCls} onClick={() => onGo('funding')}>Fund its pool →</button>}
                          <span className="text-txt-secondary">· Click a Minting / Claiming badge to pause or resume it.</span>
                        </div>
                        {t.mode === VoucherMode.Reward && (
                          <div className="flex flex-wrap gap-2 max-w-2xl">
                            <div className="flex-1 min-w-[240px]"><AddressInput value={tokenEdit} onChange={setTokenEdit} options={tokenOptions} placeholder="Token address" /></div>
                            <button className={btnSecondaryCls} disabled={!isAddr(tokenEdit)} onClick={() => act(`Type ${t.id}: add token ${nameOf(tokenEdit)}`, 'addApprovedToken', [t.id, tokenEdit])}>Add token</button>
                            <button className={btnSecondaryCls} disabled={!isAddr(tokenEdit)} onClick={() => act(`Type ${t.id}: remove token ${nameOf(tokenEdit)}`, 'removeApprovedToken', [t.id, tokenEdit])}>Remove token</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {types.length === 0 && <tr><td colSpan={10} className="py-4 text-center text-txt-secondary">No types registered yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Collapsible key={types.length ? 'has-types' : 'no-types'} title="Create a new voucher type" summary={types.length ? 'pick what it gives, name it, choose who can mint' : 'no types yet — start here'} defaultOpen={types.length === 0}>
      <Card>
        <ContractTag contract="VoucherNFT" methods={['registerVoucherType', 'addApprovedToken', 'grantTypeMinterWithCap']} />
        {/* 1 — what the voucher is: a preset fills every technical setting */}
        <h4 className="text-sm font-semibold mb-2">1. What does claiming the voucher give?</h4>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3 mb-5">
          <Select value={presetId} onChange={applyPreset} options={presets.map((p) => ({ label: p.label, value: p.id }))} />
          {preset?.note && <p className="text-xs text-txt-secondary self-center">{preset.note}</p>}
        </div>

        {/* 2 — the few things everyone sets */}
        <h4 className="text-sm font-semibold mb-2">2. Basics</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Name" hint="Shown everywhere this type appears.">
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field
            label={isReward ? 'Pays from (pool)' : 'Points ledger'}
            hint={<>✓ = approved for {isReward ? `${enumName(TokenStandard, f.tokenStandard)} rewards` : 'points'}. Pools are deployed on the Pools tab.</>}
          >
            <Select
              value={sourceChoice}
              onChange={(v) => { if (v !== OTHER) set('settlementTarget', v); setOtherSource(v === OTHER); }}
              options={[
                { label: 'None', value: ZERO },
                ...sourceOptions.map((o) => ({ label: `${o.approved === true ? '✓ ' : o.approved === false ? '✗ ' : ''}${o.label}${o.approved === false ? ' — not approved for this' : ''}`, value: o.value })),
                { label: 'Other address…', value: OTHER },
              ]}
            />
            {sourceChoice === OTHER && (
              <div className="mt-2"><AddressInput value={f.settlementTarget} onChange={(v) => set('settlementTarget', v)} placeholder="0x… pool address" /></div>
            )}
          </Field>
          {isReward && (
            <Field label="Payout token(s)" hint={f.tokenStandard === TokenStandard.Native ? 'Native coin is already added.' : 'The token(s) this voucher can pay out — every mint names one of them.'}>
              <div className="flex flex-wrap gap-2 mb-2">
                {f.approvedTokens.map((t) => (
                  <span key={t} className="bg-surface-tertiary rounded px-2 py-1 text-xs font-mono">
                    {sameAddr(t, ZERO) ? 'Native coin' : nameOf(t)} <button className="text-red-300 ml-1" onClick={() => set('approvedTokens', f.approvedTokens.filter((x) => x !== t))}>×</button>
                  </span>
                ))}
                {!f.approvedTokens.length && <span className="text-xs text-yellow-300">none yet</span>}
              </div>
              <div className="flex gap-2">
                <AddressInput value={newToken} onChange={setNewToken} options={tokenOptions} placeholder="Token address" />
                <button className={btnSecondaryCls} disabled={!isAddr(newToken)} onClick={() => { if (!f.approvedTokens.some((t) => sameAddr(t, newToken))) set('approvedTokens', [...f.approvedTokens, newToken]); setNewToken(''); }}>Add</button>
              </div>
            </Field>
          )}
          {isReward && (
            <Field label="Funding mode" hint={f.fundingMode === FundingMode.Reserved ? 'Minting needs the tokens in the pool and sets them aside for the voucher until claim, revoke or expiry.' : 'Nothing is set aside at mint — the claim pays if the pool has free tokens at that moment.'}>
              <Select value={f.fundingMode} onChange={(v) => set('fundingMode', v)} options={[
                { label: 'Reserved — tokens set aside at mint', value: FundingMode.Reserved },
                { label: 'On claim — paid from the free balance', value: FundingMode.OnClaim },
              ]} />
            </Field>
          )}
          <Field
            label="Who mints it"
            hint={minter === 'wallet' ? 'Your wallet mints directly — no vote. More minters can be added later on Minters below.'
              : minter === 'dao' ? 'Every mint is a VoucherDAO proposal by one of its operators (added on the VoucherDAO tab).'
              : 'Your wallet mints directly, and VoucherDAO operators can also mint through proposals.'}
          >
            <Select value={minter} onChange={setMinter} options={[
              { label: 'My wallet (direct, no vote)', value: 'wallet' },
              ...(c.VoucherDAO ? [
                { label: 'VoucherDAO (operators propose)', value: 'dao' },
                { label: 'Both — my wallet and VoucherDAO', value: 'both' },
              ] : []),
            ]} />
          </Field>
          {minter !== 'wallet' && (
            <Field
              label="Votes needed (VoucherDAO)"
              hint={f.approvalsRequired <= 1 ? "1 = an operator's proposal mints immediately (no second vote)." : `${f.approvalsRequired} operator votes per mint — the proposer counts as one, so you need at least ${f.approvalsRequired} operators.`}
            >
              <input className={inputCls} type="number" min={1} value={f.approvalsRequired} onChange={(e) => set('approvalsRequired', Math.max(1, num(e.target.value)))} />
            </Field>
          )}
        </div>
        {minter === 'both' && f.approvalsRequired > 1 && (
          <p className="text-xs text-yellow-300 mt-2">⚠ Your wallet can mint this type directly, skipping the {f.approvalsRequired}-vote DAO process. Pick &quot;VoucherDAO&quot; if every mint must be voted on.</p>
        )}

        {/* 3 — everything else, already set by the preset */}
        <div className="mt-5">
          <Collapsible title="Advanced options" summary="already set by the preset — change only if you need to">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Mode">
                <Select value={f.mode} onChange={(v) => set('mode', v)} options={[
                  { label: 'Points (credit/debit a ledger)', value: VoucherMode.Points },
                  { label: 'Reward (pay out a real asset)', value: VoucherMode.Reward },
                ]} />
              </Field>
              {!isReward ? (
                <Field label="Points direction">
                  <Select value={f.pointsDirection} onChange={(v) => set('pointsDirection', v)} options={[
                    { label: 'Credit (claim adds points)', value: PointsDirection.Credit },
                    { label: 'Debit (claim removes points)', value: PointsDirection.Debit },
                  ]} />
                </Field>
              ) : (
                <>
                  <Field label="Payout token standard">
                    <Select value={f.tokenStandard} onChange={(v) => set('tokenStandard', v)} options={[TokenStandard.Native, TokenStandard.ERC20].map((v) => ({ label: enumName(TokenStandard, v), value: v as number }))} />
                  </Field>
                  {usesSettlement ? (
                    <Field label="Payout mode" hint="How VoucherSettlement delivers the reward.">
                      <Select value={f.payoutMode} onChange={(v) => set('payoutMode', v)} options={[
                        { label: 'Direct (to the claimer)', value: PayoutMode.Direct },
                        { label: 'Routed (to a route target pool)', value: PayoutMode.Routed },
                        { label: 'External (nothing moves; delivered elsewhere)', value: PayoutMode.External },
                      ]} />
                    </Field>
                  ) : (
                    <Field label="Payout mode" hint="Routed / External need VoucherSettlement as the pool.">
                      <div className="text-sm py-2">Direct — the pool pays the claimer</div>
                    </Field>
                  )}
                  {payoutMode === PayoutMode.Routed && (
                    <Field label="Route target" hint="Must be approved under Route targets (Wire → Advanced)."><AddressInput value={f.routeTarget} onChange={(v) => set('routeTarget', v)} /></Field>
                  )}
                  <Field label="Payout recipient" hint="Whoever claims, or one fixed address (must be approved under Payout recipients, Wire → Advanced).">
                    <AddressInput value={f.payoutRecipient} onChange={(v) => set('payoutRecipient', v)} options={[{ label: 'Whoever claims', value: ZERO }]} />
                  </Field>
                </>
              )}
              <Field label="Redemption days" hint="Informational only (0 = none).">
                <input className={inputCls} type="number" min={0} value={f.redemptionDays} onChange={(e) => set('redemptionDays', num(e.target.value))} />
              </Field>
              <Field label="Transfer gate"><AddressInput value={f.transferGate} onChange={(v) => set('transferGate', v)} options={gateOptions} /></Field>
              <Field label="Revoked vouchers go to"><AddressInput value={f.revokeDestination} onChange={(v) => set('revokeDestination', v)} options={revokeOptions} /></Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.transferable} onChange={(e) => set('transferable', e.target.checked)} /> Holders can transfer it</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.pauseClaiming} onChange={(e) => set('pauseClaiming', e.target.checked)} /> Start with claiming paused</label>
            </div>
          </Collapsible>
        </div>

        {[...warnings, ...destWarnings, ...(noTokenWarning ? ['No payout token yet — mints will fail until one is added'] : [])].map((w) => (
          <p key={w} className="text-xs text-yellow-300 mt-2">⚠ {w}</p>
        ))}
        <div className="flex items-center gap-3 mt-4">
          <button className={btnCls} disabled={busy || warnings.length > 0} onClick={register}>{busy && progress ? 'Working…' : 'Create voucher type'}</button>
          {progress && <span className="text-xs text-txt-secondary">{progress}</span>}
        </div>
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>
      </Collapsible>


    </div>
  );
}
