'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { RefreshCw, Tags } from 'lucide-react';
import Card from '@/components/card';
import { UtcDateTimeInput, UtcTime } from '@/components/utc-datetime';
import { utcInputToUnix, unixToUtcInput } from '@/lib/utc-time';
import { ARTIFACTS, WalletStatus, isAddr, readWalletStatus } from '@/lib/contracts/acl';
import { KNOWN_SYMBOLS, LINK_ADDRESSES } from '@/lib/contracts/link';
import { Badge, ControlledAction, Ctx, WalletStatusBadge, btnSecondaryCls, inputCls } from './shared';

// ATMAccessControl v1.1.0 wallet types, rules and connection limits — everything read live from the
// ACL (lastTypeId, typeInfo, typeRule, connectionLimitsOf, typesOf, canCreateConnection).
// Every change is an ACL-owner call routed through ControlledAction (wallet / Management / request).
//
// Built-in ids are fixed: 1 BLACKLISTED and 2 FROZEN come from the existing blacklist / freeze
// status (already on mainnet, never assigned by hand), 3 PROTECTED. Id 4 is retired (the old built-in
// VERIFIER); custom types start at 5. The DAO's verifier is a custom type chosen with dao.setVerifierType.

const acl = new ethers.utils.Interface(ARTIFACTS.ATMAccessControl.abi);
const ZERO = ethers.constants.AddressZero;
const ACTIONS = [
  { key: 'CREATE_CONNECTION', label: 'Create connection', hint: 'as creator, any %' },
  { key: 'JOIN_CONNECTION', label: 'Join connection', hint: 'as userB, userB pays a part (< 100%)' },
  { key: 'JOIN_FULLY_PAID', label: 'Join fully paid', hint: 'as userB, creator pays 100%' },
].map((a) => ({ ...a, id: ethers.utils.id(a.key) }));
const BUILTIN: Record<number, { name: string; note: string }> = {
  1: { name: 'BLACKLISTED', note: 'from blacklist status (operators); not assignable' },
  2: { name: 'FROZEN', note: 'from frozen status, incl. through the safe wallet; not assignable' },
  3: { name: 'PROTECTED', note: 'protected wallet; DAO flow or owner' },
};
const RULE_LABEL = ['not set', 'allow', 'block'];
const RULE_TONE: ('muted' | 'good' | 'bad')[] = ['muted', 'good', 'bad'];
const DENY = ['allowed', 'creator blocked by a rule', 'userB blocked by a rule', 'lock days outside the limit', 'amount outside the limit', 'percentA outside the limit', 'outside the date range'];

interface Limits { minLockDays: number; maxLockDays: number; startTime: number; endTime: number; minPercentA: number; maxPercentA: number; set: boolean; minAmount: ethers.BigNumber; maxAmount: ethers.BigNumber }
interface TypeRow { id: number; name: string; exists: boolean; disabled: boolean; defaultBlocked: boolean; daoAllowed: boolean; rules: number[]; limits: Limits }
interface Token { address: string; symbol: string; decimals: number }

const typeName = (t?: { id: number; name: string }) => (!t ? '' : BUILTIN[t.id]?.name || t.name || `#${t.id}`);
const toLimits = (l: any): Limits => ({
  minLockDays: Number(l.minLockDays), maxLockDays: Number(l.maxLockDays), startTime: Number(l.startTime), endTime: Number(l.endTime),
  minPercentA: Number(l.minPercentA), maxPercentA: Number(l.maxPercentA), set: !!l.set, minAmount: l.minAmount, maxAmount: l.maxAmount,
});

/** Token by "BNB", a Factory symbol (e.g. LUCA) or an address. */
async function resolveToken(provider: ethers.providers.Provider, factory: string, input: string): Promise<Token> {
  const v = input.trim();
  if (!v || v.toUpperCase() === 'BNB' || /^0x0{40}$/i.test(v)) return { address: ZERO, symbol: 'BNB', decimals: 18 };
  let address = v;
  if (!ethers.utils.isAddress(v)) {
    if (!isAddr(factory)) throw new Error('Factory not found — enter the token address');
    const t = await new ethers.Contract(factory, ['function tokenMap(string) view returns (address addr, uint256 minAmount, bool isActive)'], provider).tokenMap(v);
    if (!t.isActive) throw new Error(`"${v}" is not a Factory token — enter the token address`);
    address = t.addr;
  }
  const c = new ethers.Contract(address, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider);
  const [symbol, decimals] = await Promise.all([c.symbol().catch(() => short(address)), c.decimals().catch(() => 18)]);
  return { address: ethers.utils.getAddress(address), symbol, decimals: Number(decimals) };
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Tokens the Factory accepts for connections, read live: Factory.tokenMap(symbol) for the known
 * symbols (tokenMap isn't enumerable), active ones only. The native coin (BNB) is address(0).
 */
function useFactoryTokens(ctx: Ctx): Token[] | null {
  const factory = ctx.s.factory?.address || '';
  const [list, setList] = useState<Token[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!ctx.provider || !isAddr(factory)) { setList([]); return; }
    let cancelled = false;
    const f = new ethers.Contract(factory, ['function tokenMap(string) view returns (address addr, uint256 minAmount, bool isActive)'], ctx.provider);
    Promise.all(KNOWN_SYMBOLS.map(async (sym): Promise<Token | null> => {
      try {
        const r = await f.tokenMap(sym);
        if (!r.isActive) return null;
        if (/^0x0{40}$/i.test(r.addr)) return { address: ZERO, symbol: sym, decimals: 18 };
        const d = await new ethers.Contract(r.addr, ['function decimals() view returns (uint8)'], ctx.provider!).decimals().catch(() => 18);
        return { address: ethers.utils.getAddress(r.addr), symbol: sym, decimals: Number(d) };
      } catch { return null; }
    })).then((r) => { if (!cancelled) setList(r.filter((x): x is Token => !!x)); });
    return () => { cancelled = true; };
  }, [ctx.provider, factory]);
  return list;
}

const OTHER = '__other';

function TokenInput({ ctx, value, onChange, label = 'Token' }: { ctx: Ctx; value: Token | null; onChange: (t: Token | null) => void; label?: string }) {
  const tokens = useFactoryTokens(ctx);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const listed = !!value && !!tokens?.some((x) => x.address === value.address);
  const sel = other || (value && !listed) ? OTHER : value ? value.address : '';
  const pick = async (v: string) => {
    setText(v); setErr('');
    if (!ctx.provider) return;
    try { onChange(await resolveToken(ctx.provider, ctx.s.factory?.address || '', v)); } catch (e: any) { onChange(null); setErr(e?.message || String(e)); }
  };
  const choose = (v: string) => {
    setErr('');
    if (v === OTHER) { setOther(true); onChange(null); return; }
    setOther(false); setText('');
    onChange(tokens?.find((x) => x.address === v) || null);
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-txt-secondary w-16">{label}</span>
        <select value={sel} onChange={(e) => choose(e.target.value)} className={`${inputCls} max-w-xs`}>
          <option value="">{tokens === null ? 'Reading Factory tokens…' : 'Choose a token…'}</option>
          {tokens?.map((x) => <option key={x.address} value={x.address}>{x.symbol}{x.address === ZERO ? ' (native)' : ` · ${short(x.address)}`}</option>)}
          <option value={OTHER}>Other token (address)…</option>
        </select>
        {sel === OTHER && (
          <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && pick(text)} placeholder="Token address 0x…" className={`${inputCls} max-w-xs`} />
        )}
      </div>
      {tokens && tokens.length === 0 && <p className="text-xs text-txt-secondary pl-[4.5rem]">No active Factory tokens found — use &quot;Other token&quot;.</p>}
      {value && <p className="text-xs text-txt-secondary pl-[4.5rem]">{value.symbol} · <span className="font-mono">{value.address}</span> · {value.decimals} decimals</p>}
      {err && <p className="text-xs text-red-300 pl-[4.5rem]">{err}</p>}
    </div>
  );
}

function limitsText(l: Limits, decimals = 18) {
  if (!l.set) return 'no limits';
  const parts: string[] = [];
  const range = (a: string, b: string, unit = '') => (a && b ? `${a}–${b}${unit}` : a ? `≥ ${a}${unit}` : `≤ ${b}${unit}`);
  if (l.minLockDays || l.maxLockDays) parts.push(`lock ${range(l.minLockDays ? String(l.minLockDays) : '', l.maxLockDays ? String(l.maxLockDays) : '', ' days')}`);
  if (!l.minAmount.isZero() || !l.maxAmount.isZero()) parts.push(`amount ${range(l.minAmount.isZero() ? '' : ethers.utils.formatUnits(l.minAmount, decimals), l.maxAmount.isZero() ? '' : ethers.utils.formatUnits(l.maxAmount, decimals))}`);
  if (l.minPercentA || l.maxPercentA) parts.push(`creator % ${range(l.minPercentA ? String(l.minPercentA) : '', l.maxPercentA ? String(l.maxPercentA) : '')}`);
  if (l.startTime || l.endTime) parts.push('date range');
  return parts.join(' · ');
}

export default function AclTypes({ ctx }: { ctx: Ctx }) {
  const aclAddr = ctx.s.acl?.address || '';
  const owner = ctx.s.acl?.owner;
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [sel, setSel] = useState(1);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [rev, setRev] = useState(0);
  const verifierType = useVerifierType(ctx, rev);

  const load = useCallback(async () => {
    setErr('');
    if (!ctx.provider || !isAddr(aclAddr) || !ctx.s.aclV11) return;
    setLoading(true);
    try {
      const c = new ethers.Contract(aclAddr, ARTIFACTS.ATMAccessControl.abi, ctx.provider);
      const last = Math.max(3, (await c.lastTypeId()).toNumber());
      const rows = await Promise.all(Array.from({ length: last }, (_, i) => i + 1).map(async (id) => {
        const [info, limits, ...rules] = await Promise.all([
          c.typeInfo(id), c.connectionLimitsOf(id, ZERO, false), ...ACTIONS.map((a) => c.typeRule(id, a.id, ZERO, false)),
        ]);
        return { id, name: info.name, exists: info.exists, disabled: info.disabled, defaultBlocked: info.defaultBlocked, daoAllowed: !!info.daoAllowed, rules: rules.map(Number), limits: toLimits(limits) } as TypeRow;
      }));
      setTypes(rows.filter((r) => r.exists && r.id !== 4)); // 4 = retired built-in VERIFIER (still "exists" on pre-final builds)
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setLoading(false); }
  }, [ctx.provider, aclAddr, ctx.s.aclV11]);
  // ctx.s changes after every confirmed tx (refresh), so the table follows the chain
  useEffect(() => { load(); }, [load, rev, ctx.s]);

  const t = types.find((x) => x.id === sel);
  const action = (title: string, data: string, extra: Partial<React.ComponentProps<typeof ControlledAction>> = {}) => (
    <ControlledAction ctx={ctx} title={title} contractName="ATMAccessControl (ACL) proxy" target={aclAddr} controller={owner} kind="call" data={data} {...extra} />
  );

  if (!isAddr(aclAddr)) return <Card title="5. Types & rules"><p className="text-xs text-txt-secondary">No ACL found on this network.</p></Card>;
  if (!ctx.s.aclV11) return <Card title="5. Types & rules"><p className="text-xs text-yellow-300">The ACL here is below v1.1.0 — upgrade it in <strong>1. ACL</strong> first.</p></Card>;

  return (
    <div className="space-y-4">
      <Card icon={<Tags className="w-5 h-5 text-accent" />} title={<span>5. Types &amp; rules <span className="text-sm text-txt-secondary font-normal">· {types.length} types</span></span>}>
        <div className="space-y-3">
          <p className="text-xs text-txt-secondary">
            What each wallet type may do in connections. For every type a wallet has: token rule if set → general rule if set → the type&apos;s
            <em> default</em>. <strong>Any block in any type wins.</strong> Normal wallets (no type) are always allowed. Changes are signed by the ACL owner.
          </p>
          <div className="flex items-center gap-2">
            <button className="ml-auto text-txt-secondary hover:text-txt-primary" title="Reload from chain" onClick={() => setRev((r) => r + 1)}><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
          {err && <p className="text-xs text-red-300">{err}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-txt-secondary text-left">
                <tr><th className="py-1 pr-3">Id</th><th className="pr-3">Type</th><th className="pr-3">Default</th>{ACTIONS.map((a) => <th key={a.key} className="pr-3" title={a.hint}>{a.label}</th>)}<th className="pr-3">Limits (all tokens)</th><th className="pr-3" title="setTypeDaoAllowed: the ACL DAO may add / remove this type through its request flow">DAO flow</th><th /></tr>
              </thead>
              <tbody>
                {types.map((r) => (
                  <tr key={r.id} className={`border-t border-white/5 cursor-pointer ${r.id === sel ? 'bg-accent/10' : 'hover:bg-surface-tertiary/50'}`} onClick={() => setSel(r.id)}>
                    <td className="py-1.5 pr-3 font-mono">{r.id}</td>
                    <td className="pr-3"><span className="font-semibold">{typeName(r)}</span> {BUILTIN[r.id] ? <Badge tone="muted" title={BUILTIN[r.id].note}>built-in</Badge> : <Badge tone="accent">custom</Badge>} {r.disabled && <Badge tone="warn">disabled</Badge>}</td>
                    <td className="pr-3">{r.defaultBlocked ? <Badge tone="bad">block</Badge> : <Badge tone="good">allow</Badge>}</td>
                    {r.rules.map((x, i) => <td key={i} className="pr-3"><Badge tone={RULE_TONE[x]}>{RULE_LABEL[x]}</Badge></td>)}
                    <td className="pr-3 text-txt-secondary">{limitsText(r.limits)}</td>
                    <td className="pr-3">{r.daoAllowed ? <Badge tone="accent">allowed</Badge> : <Badge tone="muted">off</Badge>}{r.id === verifierType && <> <Badge tone="good" title="dao.verifierTypeId()">DAO verifier</Badge></>}</td>
                    <td><button className="text-accent underline" onClick={() => setSel(r.id)}>edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-txt-secondary">Click a type (built-in like PROTECTED, or your own) to configure it below: rules, default, per-token rules and limits. Token-specific rules and limits override the ones above for that token.</p>
          <CreateType ctx={ctx} action={action} />
        </div>
      </Card>

      <ProductionRules ctx={ctx} types={types} action={action} />
      <VerifierType ctx={ctx} types={types} current={verifierType} />
      {t && <TypeEditor key={t.id} ctx={ctx} t={t} action={action} types={types} onSelect={setSel} />}
      <WalletTypes ctx={ctx} types={types} action={action} />
      <ConnectionCheck ctx={ctx} />
    </div>
  );
}

type ActionFn = (title: string, data: string, extra?: Partial<React.ComponentProps<typeof ControlledAction>>) => React.ReactNode;

// ── Production rules (BLACKLISTED + FROZEN), shown against the chain ──────────
function ProductionRules({ ctx, types, action }: { ctx: Ctx; types: TypeRow[]; action: ActionFn }) {
  const luca = LINK_ADDRESSES[ctx.ns]?.luca || '';
  const [lucaRule, setLucaRule] = useState<number | null>(null);
  const black = types.find((x) => x.id === 1);
  const frozen = types.find((x) => x.id === 2);
  useEffect(() => {
    if (!ctx.provider || !isAddr(ctx.s.acl?.address) || !isAddr(luca)) return;
    new ethers.Contract(ctx.s.acl!.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider)
      .typeRule(2, ACTIONS[2].id, luca, true).then((v: number) => setLucaRule(Number(v))).catch(() => setLucaRule(null));
  }, [ctx.provider, ctx.s, luca]);
  const blackDefaultOk = !!black?.defaultBlocked;
  const blackRulesOk = !!black && black.rules.every((r) => r === 2);
  const blackOk = blackDefaultOk && blackRulesOk;
  const frozenOk = !!frozen && frozen.rules.every((r) => r === 2);
  const lucaOk = lucaRule === 1;
  const row = (ok: boolean, text: string) => <li className="flex items-center gap-2">{ok ? <Badge tone="good">set</Badge> : <Badge tone="warn">not set</Badge>}<span>{text}</span></li>;
  return (
    <Card title={<span>Production rules <span className="text-sm text-txt-secondary font-normal">· {[blackOk, frozenOk, lucaOk].filter(Boolean).length} of 3 set</span></span>} collapsible defaultOpen={!(blackOk && frozenOk && lucaOk)}>
      <div className="space-y-3">
        <ul className="text-xs space-y-1">
          {row(blackOk, 'BLACKLISTED: blocked from everything, to and from (deny by default, also future actions, and an explicit block on create / join / join fully paid)')}
          {row(frozenOk, 'FROZEN: cannot create any connection (100% or any %), cannot join a part-paid connection')}
          {row(lucaOk, 'FROZEN: may only be userB of a 100% LUCA connection')}
        </ul>
        {!blackDefaultOk && action('BLACKLISTED: block everything by default', acl.encodeFunctionData('setTypeDefaultBlocked', [1, true]))}
        {!blackRulesOk && action('BLACKLISTED: block create / join / join fully paid', acl.encodeFunctionData('setTypeRules', [1, ACTIONS.map((a) => a.id), [2, 2, 2]]))}
        {!frozenOk && action('FROZEN: block create / join / join fully paid', acl.encodeFunctionData('setTypeRules', [2, ACTIONS.map((a) => a.id), [2, 2, 2]]))}
        {!lucaOk && isAddr(luca) && action('FROZEN: allow 100% LUCA as userB', acl.encodeFunctionData('setTypeTokenRules', [2, ACTIONS[2].id, [luca], [1]]))}
      </div>
    </Card>
  );
}

// ── Edit one type ─────────────────────────────────────────────────────────────
function TypeEditor({ ctx, t, action, types, onSelect }: { ctx: Ctx; t: TypeRow; action: ActionFn; types: TypeRow[]; onSelect: (id: number) => void }) {
  const [rules, setRules] = useState<number[]>(t.rules);
  const changed = ACTIONS.map((a, i) => ({ a, i })).filter(({ i }) => rules[i] !== t.rules[i]);

  // token rule
  const [tok, setTok] = useState<Token | null>(null);
  const [tokRules, setTokRules] = useState<number[] | null>(null);
  const [tokAction, setTokAction] = useState(0);
  const [tokRule, setTokRule] = useState(1);
  useEffect(() => {
    setTokRules(null);
    if (!tok || !ctx.provider || !ctx.s.acl) return;
    const c = new ethers.Contract(ctx.s.acl.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider);
    Promise.all(ACTIONS.map((a) => c.typeRule(t.id, a.id, tok.address, true))).then((r) => setTokRules(r.map(Number))).catch(() => setTokRules(null));
  }, [tok, ctx.provider, ctx.s, t.id]);

  return (
    <Card title={<span>Configure {typeName(t)} <span className="text-sm text-txt-secondary font-normal">· type {t.id}{BUILTIN[t.id] ? ` · ${BUILTIN[t.id].note}` : ''}</span></span>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-txt-secondary">Type to configure</span>
          <select value={t.id} onChange={(e) => onSelect(Number(e.target.value))} className={`${inputCls} max-w-xs`}>
            {types.map((x) => <option key={x.id} value={x.id}>{x.id} · {typeName(x)}{BUILTIN[x.id] ? ' (built-in)' : ''}{x.disabled ? ' · disabled' : ''}</option>)}
          </select>
        </div>
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Rules for every token</h4>
          <div className="grid sm:grid-cols-3 gap-2">
            {ACTIONS.map((a, i) => (
              <label key={a.key} className="text-xs space-y-1">
                <span className="text-txt-secondary">{a.label} <span className="opacity-70">({a.hint})</span></span>
                <select value={rules[i]} onChange={(e) => setRules(rules.map((x, j) => (j === i ? Number(e.target.value) : x)))} className={inputCls}>
                  {RULE_LABEL.map((l, v) => <option key={v} value={v}>{l}{v === 0 ? ` (→ default: ${t.defaultBlocked ? 'block' : 'allow'})` : ''}</option>)}
                </select>
                <span className="text-txt-secondary">on-chain: {RULE_LABEL[t.rules[i]]}</span>
              </label>
            ))}
          </div>
          {changed.length > 0 && action(`Set ${changed.length} rule${changed.length > 1 ? 's' : ''} for ${typeName(t)}`,
            acl.encodeFunctionData('setTypeRules', [t.id, changed.map(({ a }) => a.id), changed.map(({ i }) => rules[i])]))}
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Type switches</h4>
          <div className="grid sm:grid-cols-2 gap-2">
            {action(t.defaultBlocked ? 'Default: allow (unset actions allowed)' : 'Default: block (unset actions blocked)',
              acl.encodeFunctionData('setTypeDefaultBlocked', [t.id, !t.defaultBlocked]),
              { confirm: t.id === 1 && t.defaultBlocked ? 'This lets blacklisted wallets do anything without a rule. Continue?' : undefined })}
            {action(t.disabled ? 'Enable type (rules apply again)' : 'Disable type (lifts all its rules and limits)',
              acl.encodeFunctionData('setTypeDisabled', [t.id, !t.disabled]),
              { confirm: !t.disabled && t.id <= 2 ? `Disabling ${typeName(t)} lifts every rule for those wallets. Continue?` : undefined })}
            {t.id >= 3 && action(t.daoAllowed ? 'DAO flow: off (only the owner / operators change this type)' : 'DAO flow: allow (the ACL DAO may add / remove this type)',
              acl.encodeFunctionData('setTypeDaoAllowed', [t.id, !t.daoAllowed]))}
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Token rule <span className="text-txt-secondary font-normal text-xs">— overrides the rule above for one token</span></h4>
          <TokenRulesTable ctx={ctx} t={t} onPick={setTok} selected={tok?.address} />
          <TokenInput ctx={ctx} value={tok} onChange={setTok} />
          {tok && (
            <>
              <p className="text-xs text-txt-secondary">On-chain for {tok.symbol}: {ACTIONS.map((a, i) => `${a.label}: ${tokRules ? RULE_LABEL[tokRules[i]] : '…'}`).join(' · ')}</p>
              <div className="flex flex-wrap gap-2">
                <select value={tokAction} onChange={(e) => setTokAction(Number(e.target.value))} className={`${inputCls} max-w-xs`}>{ACTIONS.map((a, i) => <option key={a.key} value={i}>{a.label}</option>)}</select>
                <select value={tokRule} onChange={(e) => setTokRule(Number(e.target.value))} className={`${inputCls} max-w-[10rem]`}>{RULE_LABEL.map((l, v) => <option key={v} value={v}>{v === 0 ? 'not set (remove)' : l}</option>)}</select>
              </div>
              {action(`${typeName(t)}: ${ACTIONS[tokAction].label} with ${tok.symbol} → ${RULE_LABEL[tokRule]}`,
                acl.encodeFunctionData('setTypeTokenRules', [t.id, ACTIONS[tokAction].id, [tok.address], [tokRule]]))}
            </>
          )}
        </section>

        <LimitsEditor ctx={ctx} t={t} action={action} />
      </div>
    </Card>
  );
}

/** Every Factory token × action for this type: the token rule on-chain and what actually applies. */
function TokenRulesTable({ ctx, t, onPick, selected }: { ctx: Ctx; t: TypeRow; onPick: (tok: Token) => void; selected?: string }) {
  const tokens = useFactoryTokens(ctx);
  const [rules, setRules] = useState<Record<string, number[]>>({});
  useEffect(() => {
    setRules({});
    if (!tokens?.length || !ctx.provider || !ctx.s.acl) return;
    let cancelled = false;
    const c = new ethers.Contract(ctx.s.acl.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider);
    Promise.all(tokens.map(async (tk) => [tk.address, (await Promise.all(ACTIONS.map((a) => c.typeRule(t.id, a.id, tk.address, true)))).map(Number)] as const))
      .then((r) => { if (!cancelled) setRules(Object.fromEntries(r)); }).catch(() => { /* ACL below v1.1.0 */ });
    return () => { cancelled = true; };
  }, [tokens, ctx.provider, ctx.s, t]);
  if (tokens === null) return <p className="text-xs text-txt-secondary">Reading Factory tokens…</p>;
  if (!tokens.length) return null;
  // effective: token rule if set → the rule for every token if set → the type's default
  const effective = (x: number, i: number) => (x || t.rules[i] || (t.defaultBlocked ? 2 : 1));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-txt-secondary text-left">
          <tr><th className="py-1 pr-3">Factory token</th>{ACTIONS.map((a) => <th key={a.key} className="pr-3" title={a.hint}>{a.label}</th>)}<th /></tr>
        </thead>
        <tbody>
          {tokens.map((tk) => {
            const r = rules[tk.address];
            return (
              <tr key={tk.address} className={`border-t border-white/5 cursor-pointer ${selected === tk.address ? 'bg-accent/10' : 'hover:bg-surface-tertiary/50'}`} onClick={() => onPick(tk)}>
                <td className="py-1.5 pr-3"><span className="font-semibold">{tk.symbol}</span> <span className="text-txt-secondary font-mono">{tk.address === ZERO ? 'native' : short(tk.address)}</span></td>
                {ACTIONS.map((a, i) => (
                  <td key={a.key} className="pr-3">
                    {!r ? '…' : (
                      <span className="inline-flex items-center gap-1">
                        <Badge tone={RULE_TONE[effective(r[i], i)]}>{RULE_LABEL[effective(r[i], i)]}</Badge>
                        <span className="text-txt-secondary">{r[i] ? 'token rule' : t.rules[i] ? 'every token' : 'default'}</span>
                      </span>
                    )}
                  </td>
                ))}
                <td><button type="button" className="text-accent underline" onClick={() => onPick(tk)}>change</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-txt-secondary mt-1">What applies to a wallet of this type, per token; the small text says where it comes from. Click a token to change its rule below.</p>
    </div>
  );
}

// ── Connection limits (general or for one token) ──────────────────────────────
function LimitsEditor({ ctx, t, action }: { ctx: Ctx; t: TypeRow; action: ActionFn }) {
  const [specific, setSpecific] = useState(false);
  const [tok, setTok] = useState<Token | null>(null);
  const [onchain, setOnchain] = useState<Limits | null>(specific ? null : t.limits);
  const [f, setF] = useState<Record<string, string>>({});
  const decimals = specific && tok ? tok.decimals : 18;

  useEffect(() => {
    const fill = (l: Limits) => {
      setOnchain(l);
      setF({
        minLockDays: l.minLockDays ? String(l.minLockDays) : '', maxLockDays: l.maxLockDays ? String(l.maxLockDays) : '',
        minAmount: l.minAmount.isZero() ? '' : ethers.utils.formatUnits(l.minAmount, decimals), maxAmount: l.maxAmount.isZero() ? '' : ethers.utils.formatUnits(l.maxAmount, decimals),
        minPercentA: l.minPercentA ? String(l.minPercentA) : '', maxPercentA: l.maxPercentA ? String(l.maxPercentA) : '',
        start: unixToUtcInput(l.startTime), end: unixToUtcInput(l.endTime),
      });
    };
    if (!specific) { fill(t.limits); return; }
    setOnchain(null);
    if (!tok || !ctx.provider || !ctx.s.acl) return;
    new ethers.Contract(ctx.s.acl.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider)
      .connectionLimitsOf(t.id, tok.address, true).then((l: any) => fill(toLimits(l))).catch(() => setOnchain(null));
  }, [specific, tok, t, ctx.provider, ctx.s, decimals]);

  const built = useMemo(() => {
    try {
      const n = (k: string) => (f[k] ? Number(f[k]) : 0);
      const amt = (k: string) => (f[k] ? ethers.utils.parseUnits(f[k], decimals) : ethers.constants.Zero);
      const l = {
        minLockDays: n('minLockDays'), maxLockDays: n('maxLockDays'), startTime: utcInputToUnix(f.start || ''), endTime: utcInputToUnix(f.end || ''),
        minPercentA: n('minPercentA'), maxPercentA: n('maxPercentA'), set: false, minAmount: amt('minAmount'), maxAmount: amt('maxAmount'),
      };
      const bad = (l.minLockDays && l.maxLockDays && l.minLockDays > l.maxLockDays) ? 'min lock days > max'
        : (!l.minAmount.isZero() && !l.maxAmount.isZero() && l.minAmount.gt(l.maxAmount)) ? 'min amount > max'
        : (l.minPercentA > 100 || l.maxPercentA > 100) ? 'percent above 100'
        : (l.minPercentA && l.maxPercentA && l.minPercentA > l.maxPercentA) ? 'min percent > max'
        : (l.startTime && l.endTime && l.startTime >= l.endTime) ? 'start must be before end' : '';
      return { l, bad };
    } catch (e: any) { return { l: null, bad: e?.message || 'invalid number' }; }
  }, [f, decimals]);

  const field = (k: string, label: string, ph = '0 = none') => (
    <label className="text-xs space-y-1"><span className="text-txt-secondary">{label}</span>
      <input value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} className={inputCls} /></label>
  );
  const token = specific ? tok?.address : ZERO;
  const scope = specific ? (tok ? `${tok.symbol} only` : 'one token') : 'every token';
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">Connection limits <span className="text-txt-secondary font-normal text-xs">— checked on the creator; empty = no limit</span></h4>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1"><input type="radio" checked={!specific} onChange={() => setSpecific(false)} /> every token</label>
        <label className="flex items-center gap-1"><input type="radio" checked={specific} onChange={() => setSpecific(true)} /> one token (replaces the general limits for it)</label>
      </div>
      {specific && <TokenInput ctx={ctx} value={tok} onChange={setTok} />}
      {(!specific || tok) && (
        <>
          <p className="text-xs text-txt-secondary">On-chain ({scope}): {onchain ? limitsText(onchain, decimals) : '…'}
            {onchain && (onchain.startTime || onchain.endTime) ? <> · from <UtcTime ts={onchain.startTime} inline /> to <UtcTime ts={onchain.endTime} inline /></> : null}</p>
          <div className="grid sm:grid-cols-3 gap-2">
            {field('minLockDays', 'Min lock days')}{field('maxLockDays', 'Max lock days')}<div />
            {field('minAmount', `Min amount (${specific && tok ? tok.symbol : 'token units, 18 decimals'})`)}{field('maxAmount', 'Max amount')}<div />
            {field('minPercentA', 'Min creator % (1–100)')}{field('maxPercentA', 'Max creator %')}<div />
          </div>
          <div className="grid sm:grid-cols-2 gap-2 text-xs">
            <label className="space-y-1"><span className="text-txt-secondary">Allowed from</span><UtcDateTimeInput value={f.start || ''} onChange={(v) => setF({ ...f, start: v })} className={inputCls} /></label>
            <label className="space-y-1"><span className="text-txt-secondary">Allowed until</span><UtcDateTimeInput value={f.end || ''} onChange={(v) => setF({ ...f, end: v })} className={inputCls} /></label>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnSecondaryCls} onClick={() => setF({})}>Clear form (= remove limits)</button>
          </div>
          {built.bad ? <p className="text-xs text-red-300">{built.bad}</p>
            : built.l && token !== undefined && action(`${typeName(t)}: limits for ${scope}`, acl.encodeFunctionData('setConnectionLimits', [t.id, token, specific, built.l]))}
        </>
      )}
    </section>
  );
}

// ── Create a custom type ──────────────────────────────────────────────────────
function CreateType({ ctx, action }: { ctx: Ctx; action: ActionFn }) {
  const [name, setName] = useState('');
  const n = name.trim().toUpperCase().replace(/\s+/g, '_');
  const reserved = Object.values(BUILTIN).some((b) => b.name === n);
  // VERIFIER is no longer built in: create it as a custom type, then pick it as the DAO verifier type
  return (
    <div className="border-t border-white/10 pt-3 space-y-2">
      <h4 className="text-sm font-semibold">New type</h4>
      <p className="text-xs text-txt-secondary">Gets the next id (5, 6, …) and allows everything until you set rules: after it&apos;s created, pick it above and configure it, then give it to wallets in <strong>Wallets</strong> below. BLACKLISTED, FROZEN and PROTECTED are built in (configure them above). For safe-wallet votes, create e.g. VERIFIER here and pick it in <strong>DAO verifier type</strong>.</p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Type name, e.g. KYC_VERIFIED, PARTNER" className={`${inputCls} max-w-sm`} />
      {reserved ? <p className="text-xs text-red-300">{n} is a built-in type — pick it in the table above to configure it.</p> : n && action(`Create type ${n}`, acl.encodeFunctionData('createType', [n]))}
    </div>
  );
}

// ── Assign / remove types and look up a wallet ────────────────────────────────
function WalletTypes({ ctx, types, action }: { ctx: Ctx; types: TypeRow[]; action: ActionFn }) {
  const assignable = types.filter((x) => x.id >= 3);
  const [typeId, setTypeId] = useState(5);
  const [list, setList] = useState('');
  const addrs = list.split(/[\s,]+/).filter(Boolean);
  const bad = addrs.filter((a) => !ethers.utils.isAddress(a));
  const [who, setWho] = useState('');
  const [info, setInfo] = useState<WalletStatus | null>(null);
  const look = async () => {
    setInfo(null);
    if (!ctx.provider || !ctx.s.acl || !ethers.utils.isAddress(who)) return;
    setInfo(await readWalletStatus(ctx.provider, ctx.s.acl.address, who.trim()));
  };
  // status types (1, 2) and the PROTECTED link are shown by the status line; list only the others
  const extraTypes = info ? info.types.filter((id) => id > 3) : [];
  const sel = types.find((x) => x.id === typeId);
  return (
    <Card title="Wallets" collapsible>
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">BLACKLISTED and FROZEN come from the operators&apos; blacklist / freeze (ACL proposals), not from here. A wallet holds up to 8 types.
          PROTECTED and the DAO verifier type can&apos;t be given to a restricted wallet; PROTECTED can&apos;t be given to a wallet that is someone&apos;s safe wallet.</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={typeId} onChange={(e) => setTypeId(Number(e.target.value))} className={`${inputCls} max-w-xs`}>
            {assignable.map((x) => <option key={x.id} value={x.id}>{x.id} · {typeName(x)}</option>)}
          </select>
        </div>
        <textarea value={list} onChange={(e) => setList(e.target.value)} rows={3} placeholder="Wallet addresses, one per line or comma separated" className={inputCls} />
        {bad.length > 0 && <p className="text-xs text-red-300">Not an address: {bad.join(', ')}</p>}
        {sel && addrs.length > 0 && !bad.length && (
          <div className="grid sm:grid-cols-2 gap-2">
            {action(`Assign ${typeName(sel)} to ${addrs.length} wallet${addrs.length > 1 ? 's' : ''}`, acl.encodeFunctionData('assignType', [addrs, typeId]))}
            {action(`Remove ${typeName(sel)} from ${addrs.length} wallet${addrs.length > 1 ? 's' : ''}`, acl.encodeFunctionData('removeType', [addrs, typeId]),
              { confirm: typeId === 3 ? 'Removing PROTECTED also clears the safe wallet of non-frozen wallets. Continue?' : undefined })}
          </div>
        )}
        <div className="border-t border-white/5 pt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Look up a wallet 0x…" className={`${inputCls} max-w-md`} />
            <button className={btnSecondaryCls} disabled={!ethers.utils.isAddress(who)} onClick={look}>Look up</button>
          </div>
          {info && (
            <div className="text-xs space-y-1">
              <div className="flex flex-wrap items-center gap-2"><span className="text-txt-secondary w-20">Status</span><WalletStatusBadge ctx={ctx} wallet={info.address} st={info} /></div>
              <div className="flex flex-wrap items-center gap-2"><span className="text-txt-secondary w-20">Other types</span>
                {extraTypes.length === 0 ? <span className="text-txt-secondary">none</span> : extraTypes.map((id) => <Badge key={id} tone="accent">{typeName(types.find((x) => x.id === id) || { id, name: '' })}</Badge>)}
                {info.frozenBy === 'safe' && <span className="text-txt-secondary">(custom types, incl. the verifier type, were removed when the safe wallet was restricted; the owner re-adds them)</span>}
              </div>
              {info.safeWallet && (
                <div className="flex flex-wrap items-center gap-2"><span className="text-txt-secondary w-20">Safe wallet</span>
                  <span className="font-mono">{info.safeWallet}</span><WalletStatusBadge ctx={ctx} wallet={info.safeWallet} compact /></div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Would this connection be allowed? ─────────────────────────────────────────
function ConnectionCheck({ ctx }: { ctx: Ctx }) {
  const [creator, setCreator] = useState('');
  const [userB, setUserB] = useState('');
  const [tok, setTok] = useState<Token | null>({ address: ZERO, symbol: 'BNB', decimals: 18 });
  const [amount, setAmount] = useState('0.001');
  const [pct, setPct] = useState('50');
  const [days, setDays] = useState('30');
  const [res, setRes] = useState<string>('');
  const check = async () => {
    setRes('');
    if (!ctx.provider || !ctx.s.acl || !tok) return;
    try {
      const c = new ethers.Contract(ctx.s.acl.address, ARTIFACTS.ATMAccessControl.abi, ctx.provider);
      const [ok, reason] = await c.canCreateConnection(creator, userB || ZERO, tok.address, ethers.utils.parseUnits(amount || '0', tok.decimals), Number(pct), Number(days));
      setRes(ok ? '✓ allowed' : `✗ ${DENY[Number(reason)] || `reason ${reason}`}`);
    } catch (e: any) { setRes(`error: ${e?.reason || e?.message || e}`); }
  };
  return (
    <Card title="Check a connection" collapsible>
      <div className="space-y-2">
        <p className="text-xs text-txt-secondary">Asks the ACL exactly what the Factory asks on <code>createLink</code> (Factory minimums and lock-day bounds are checked separately).</p>
        <div className="grid sm:grid-cols-2 gap-2">
          <input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="Creator 0x…" className={inputCls} />
          <input value={userB} onChange={(e) => setUserB(e.target.value)} placeholder="userB 0x… (empty = open link)" className={inputCls} />
        </div>
        <TokenInput ctx={ctx} value={tok} onChange={setTok} />
        <div className="grid grid-cols-3 gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Total amount" className={inputCls} />
          <input value={pct} onChange={(e) => setPct(e.target.value)} placeholder="Creator %" className={inputCls} />
          <input value={days} onChange={(e) => setDays(e.target.value)} placeholder="Lock days" className={inputCls} />
        </div>
        <div className="flex items-center gap-3">
          <button className={btnSecondaryCls} disabled={!ethers.utils.isAddress(creator) || (!!userB && !ethers.utils.isAddress(userB)) || !tok} onClick={check}>Check</button>
          {res && <span className={`text-sm ${res.startsWith('✓') ? 'text-green-300' : 'text-red-300'}`}>{res}</span>}
        </div>
      </div>
    </Card>
  );
}

// ── DAO verifier type (dao.verifierTypeId / setVerifierType, signed by the DAO owner) ──
function useVerifierType(ctx: Ctx, rev: number): number {
  const [id, setId] = useState(0);
  useEffect(() => {
    setId(0);
    const dao = ctx.s.dao?.address;
    if (!ctx.provider || !isAddr(dao)) return;
    let cancelled = false;
    new ethers.Contract(dao!, ARTIFACTS.ATMAccessControlDAO.abi, ctx.provider).verifierTypeId()
      .then((v: ethers.BigNumber) => { if (!cancelled) setId(v.toNumber()); }).catch(() => { /* older DAO build */ });
    return () => { cancelled = true; };
  }, [ctx.provider, ctx.s, rev]);
  return id;
}

function VerifierType({ ctx, types, current }: { ctx: Ctx; types: TypeRow[]; current: number }) {
  const dao = ctx.s.dao;
  const custom = types.filter((x) => x.id >= 5);
  const [pick, setPick] = useState(0);
  const chosen = pick || current || custom[0]?.id || 0;
  const cur = types.find((x) => x.id === current);
  const daoIface = new ethers.utils.Interface(ARTIFACTS.ATMAccessControlDAO.abi);
  return (
    <Card collapsible defaultOpen={!current} title={<span>DAO verifier type <span className="text-sm text-txt-secondary font-normal">· {!dao ? 'no DAO' : current ? `${typeName(cur || { id: current, name: '' })} (type ${current})` : 'not set'}</span></span>}>
      <div className="space-y-3">
        <p className="text-xs text-txt-secondary">
          Wallets with this type vote on safe-wallet changes in the ACL DAO (<code>dao.isVerifier</code>). It&apos;s a custom type: create it in
          <strong> New type</strong> (e.g. VERIFIER), choose it here, then give it to the verifier wallets in <strong>Wallets</strong>. Signed by the DAO owner.
        </p>
        {!dao ? <p className="text-xs text-yellow-300">Deploy the ACL DAO in <strong>2. ACL DAO</strong> first.</p>
          : !custom.length ? <p className="text-xs text-yellow-300">No custom type yet — create one in <strong>New type</strong> above.</p> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-txt-secondary">Verifier type</span>
              <select value={chosen} onChange={(e) => setPick(Number(e.target.value))} className={`${inputCls} max-w-xs`}>
                {custom.map((x) => <option key={x.id} value={x.id}>{x.id} · {typeName(x)}{x.id === current ? ' (now)' : ''}</option>)}
              </select>
            </div>
            <ControlledAction ctx={ctx} title={`Set verifier type: ${typeName(types.find((x) => x.id === chosen))}`} contractName="ATMAccessControlDAO proxy"
              target={dao.address} controller={dao.owner} kind="call" data={chosen ? daoIface.encodeFunctionData('setVerifierType', [chosen]) : ''}
              disabled={chosen === current} disabledReason="That type is already the verifier type." />
          </>
        )}
      </div>
    </Card>
  );
}
