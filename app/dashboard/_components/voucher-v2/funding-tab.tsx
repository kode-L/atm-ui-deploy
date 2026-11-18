'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { NETWORKS, getExplorerAddressUrl, chainVoucherV2 } from '@/lib/contracts/config';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { TokenStandard, VoucherMode, ZERO, fromUnits, isAddr, loadVoucherTypes, sameAddr, shortAddr, toUnits } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { useWeb3 } from '@/lib/contracts/use-web3';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import { useAdminOf } from './use-role';
import { useSourceOptions } from './source-options';
import ExtraPoolsCard from './extra-pools-card';
import { ContractTag, AddressInput, AddressOption, Field, NavButtons, Select, btnCls, btnSecondaryCls, inputCls } from './ui';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ERC721 / ERC1155 deposits left out for now, matching the RewardVault wiring step
type Kind = 'native' | 'erc20';
const OTHER_POOL = '__other__';
const OTHER_TOKEN = '__other_token__';
const OTHER_ACL = '__other_acl__';
// held = what the pool holds; reserved = set aside by VoucherNFT for minted Reserved-mode vouchers;
// free = held - reserved (what new mints, On-claim payouts and withdrawals can use)
interface TokenBal { address: string; label: string; balance: string; reserved: string; free: string; empty: boolean; supported: boolean }
// one pool contract and every asset it holds
// supported = tokens the pool pays out: approved tokens of the Reward voucher types whose pool (settlementTarget) is this contract
interface PoolBal { label: string; address: string; types: { id: number; name: string; tokens: string[] }[]; assets: TokenBal[] }

export default function FundingTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const { read, reader, signer, account, nameOf } = ctx;
  const c = ctx.book.contracts;
  const symbol = NETWORKS[ctx.chainId]?.nativeCurrency.symbol || 'native';
  const [pool, setPool] = useState(c.RewardVault || '');
  const [kind, setKind] = useState<Kind>('native');
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [meta, setMeta] = useState<{ symbol: string; decimals: number; wallet: string } | null>(null);
  const [pools, setPools] = useState<PoolBal[]>([]);
  const [copied, setCopied] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [w, setW] = useState({ token: ZERO, amount: '', to: account });
  // pool access control: the current one (accessControl()) + GameHub's ATM access control as the quick pick
  const { hubAddress } = useWeb3();
  const [hubAcl, setHubAcl] = useState('');
  const [poolAcl, setPoolAcl] = useState<string | null>(null);
  const [aclPick, setAclPick] = useState('');
  const [aclCheck, setAclCheck] = useState('');
  // withdraw*() needs DEFAULT_ADMIN_ROLE on the selected pool
  const poolAdmin = useAdminOf('RewardVault', isAddr(pool) ? [pool] : [])[pool.toLowerCase()];

  useEffect(() => { if (!pool && c.RewardVault) setPool(c.RewardVault); }, [c.RewardVault, pool]);

  // every pool by name: main + extra RewardVaults, VoucherSettlement, and anything the registry approved
  const sourceOptions = useSourceOptions(null, 0);
  // a pool's plain name, e.g. "ActiveUserReward" / "RGST": chain.json's pool name, else the address
  // book's extra-pool name, else the registry / on-chain name - never the address or the voucher types
  const poolName = useCallback((a: string) => {
    const fromChain = Object.entries(chainVoucherV2(ctx.chainId).pools).find(([, v]) => sameAddr(v, a))?.[0];
    if (fromChain) return fromChain;
    const extra = (ctx.book.extraPools || []).find((x) => sameAddr(x.address, a));
    if (extra?.name) return extra.name;
    const o = sourceOptions.find((x) => sameAddr(x.value, a));
    const first = o?.label.split(' · ')[0];
    if (first && !first.startsWith('0x')) return first;
    const k = Object.entries(ctx.book.contracts).find(([, v]) => sameAddr(v, a))?.[0];
    return k || shortAddr(a);
  }, [ctx.chainId, ctx.book, sourceOptions]);
  const poolOptions: AddressOption[] = sourceOptions.map((o) => ({ label: poolName(o.value), value: o.value }));
  const tokenOptions: AddressOption[] = Object.entries(ctx.book.tokens).map(([k, v]) => ({ label: k, value: v }));
  const erc20 = useCallback((a: string, s?: ethers.Signer | null) => new ethers.Contract(a, ERC20_ABI, s || reader || undefined), [reader]);

  // every pool contract (named pools + the selected one), each with the balance of every asset
  const poolKey = poolOptions.map((o) => o.value.toLowerCase()).join(',');
  const loadBalances = useCallback(async () => {
    if (!reader) return;
    const list: { label: string; address: string }[] = poolOptions.filter((o) => isAddr(o.value)).map((o) => ({ label: o.label, address: o.value }));
    if (isAddr(pool) && !list.some((p) => sameAddr(p.address, pool))) list.push({ label: poolName(pool), address: pool });
    if (!list.length) return;
    setLoading(true);
    try {
      // VoucherNFT.reservedOf(pool, token, 0) is in 18-decimal fixed point (same as availableBalance)
      const nft = ctx.book.contracts.VoucherNFT ? read('VoucherNFT') : null;
      const zero = ethers.BigNumber.from(0);
      const reservedOf = async (p: string, token: string) => (nft ? await nft.reservedOf(p, token, 0).catch(() => zero) : zero);
      // token list: ERC20s in the address book plus every approved ERC20 on a Reward type
      const addrs = new Set(Object.values(ctx.book.tokens));
      // which tokens each pool supports, from the on-chain Reward voucher types that pay from it
      const support = new Map<string, { types: { id: number; name: string; tokens: string[] }[]; tokens: Set<string> }>();
      if (nft) {
        const types = await loadVoucherTypes(nft).catch(() => []);
        for (const t of types.filter((x) => x.mode === VoucherMode.Reward && isAddr(x.settlementTarget) && !sameAddr(x.settlementTarget, ZERO))) {
          const k = t.settlementTarget.toLowerCase();
          if (!support.has(k)) support.set(k, { types: [], tokens: new Set() });
          const e = support.get(k)!;
          const tt: string[] = t.tokenStandard === TokenStandard.Native ? [ZERO] : t.tokenStandard === TokenStandard.ERC20 ? [...t.approvedTokens] : [];
          e.types.push({ id: t.id, name: t.name, tokens: tt.map((a) => a.toLowerCase()) });
          tt.forEach((a) => { if (a !== ZERO) addrs.add(a); e.tokens.add(a.toLowerCase()); });
          if (!list.some((p) => sameAddr(p.address, t.settlementTarget))) list.push({ label: poolName(t.settlementTarget), address: t.settlementTarget });
        }
      }
      const tokens: { address: string; label: string; dec: number; c: ethers.Contract }[] = [];
      for (const a of addrs) {
        try {
          const t = erc20(a);
          const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
          const known = nameOf(a);
          // "tUSDT" — add the book's label only when it says something the symbol doesn't
          tokens.push({ address: a, label: known.startsWith('0x') || known.toLowerCase().includes(sym.toLowerCase()) ? sym : `${sym} (${known})`, dec, c: t });
        } catch {
          // not an ERC20 (e.g. an NFT collection saved in the book) — skip
        }
      }
      const out = await Promise.all(list.map(async (p): Promise<PoolBal> => {
        const sup = support.get(p.address.toLowerCase());
        const isSup = (a: string) => !!sup?.tokens.has(a.toLowerCase());
        const nativeHeld = await reader.getBalance(p.address);
        const nativeRes = await reservedOf(p.address, ZERO);
        const nativeFree = nativeHeld.sub(nativeRes);
        const assets: TokenBal[] = [{
          address: ZERO, label: `${symbol} (native)`, balance: fromUnits(nativeHeld, 18), reserved: fromUnits(nativeRes, 18),
          free: fromUnits(nativeFree.lt(0) ? 0 : nativeFree, 18), empty: nativeHeld.isZero() && nativeRes.isZero(), supported: isSup(ZERO),
        }];
        for (const t of tokens) {
          const bal: ethers.BigNumber = await t.c.balanceOf(p.address).catch(() => zero);
          const held18 = t.dec <= 18 ? bal.mul(ethers.BigNumber.from(10).pow(18 - t.dec)) : bal.div(ethers.BigNumber.from(10).pow(t.dec - 18));
          const res = await reservedOf(p.address, t.address);
          const free = held18.sub(res);
          assets.push({ address: t.address, label: t.label, balance: fromUnits(bal, t.dec), reserved: fromUnits(res, 18), free: fromUnits(free.lt(0) ? 0 : free, 18), empty: bal.isZero() && res.isZero(), supported: isSup(t.address) });
        }
        return { ...p, types: sup?.types || [], assets };
      }));
      setPools(out);
    } finally {
      setLoading(false);
    }
  }, [poolKey, pool, reader, read, erc20, nameOf, ctx.book, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadBalances(); }, [loadBalances]);

  useEffect(() => {
    if (!hubAddress || !reader) return setHubAcl('');
    new ethers.Contract(hubAddress, GameHubArtifact.abi, reader).accessControl()
      .then((a: string) => setHubAcl(sameAddr(a, ZERO) ? '' : a)).catch(() => setHubAcl(''));
  }, [hubAddress, reader]);

  const poolKey2 = isAddr(pool) ? (sameAddr(pool, c.VoucherSettlement) || (ctx.book.extraPools || []).some((x) => sameAddr(x.address, pool) && x.kind === 'VoucherSettlement') ? 'VoucherSettlement' : 'RewardVault') : 'RewardVault';
  const loadAcl = useCallback(async () => {
    setPoolAcl(null);
    if (!isAddr(pool) || !reader) return;
    const a: string = await read(poolKey2, pool).accessControl().catch(() => '');
    setPoolAcl(a);
    setAclPick(a && !sameAddr(a, ZERO) ? a : ZERO);
  }, [pool, reader, read, poolKey2]);
  useEffect(() => { loadAcl(); }, [loadAcl]);

  // the picked contract must answer redirectTarget(addr), or every payout from this pool would revert
  useEffect(() => {
    setAclCheck('');
    if (!isAddr(aclPick) || sameAddr(aclPick, ZERO) || !reader) return;
    new ethers.Contract(aclPick, ['function redirectTarget(address) view returns (address)'], reader).redirectTarget(account || ZERO)
      .then(() => setAclCheck('ok')).catch(() => setAclCheck('bad'));
  }, [aclPick, reader, account]);
  const aclName = (a: string) => (!a || sameAddr(a, ZERO) ? 'Off' : sameAddr(a, hubAcl) ? 'ATM Access Control (GameHub)' : shortAddr(a));

  // pre-select the selected pool's first supported token for deposit and withdraw
  // (once per pool, so a balance reload after a deposit doesn't undo the user's pick)
  const preselected = useRef('');
  useEffect(() => {
    const sp = pools.find((x) => sameAddr(x.address, pool));
    if (!sp || preselected.current === pool.toLowerCase()) return;
    preselected.current = pool.toLowerCase();
    const first = sp.assets.find((a) => a.supported) || sp.assets.find((a) => !a.empty);
    if (!first) return;
    if (first.address === ZERO) { setKind('native'); setToken(''); } else { setKind('erc20'); setToken(first.address); }
    setW((x) => ({ ...x, token: first.address }));
  }, [pool, pools]);

  useEffect(() => {
    setMeta(null);
    if (kind !== 'erc20' || !isAddr(token)) return;
    const t = erc20(token);
    Promise.all([t.symbol(), t.decimals(), t.balanceOf(account)])
      .then(([sym, dec, bal]) => setMeta({ symbol: sym, decimals: dec, wallet: fromUnits(bal, dec) }))
      .catch(() => setMeta(null));
  }, [kind, token, account, erc20]);

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      setTimeout(loadBalances, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const deposit = () => run(async () => {
    if (kind === 'native') return ctx.sendValue(`Deposit ${amount} ${symbol} → ${nameOf(pool)}`, pool, toUnits(amount, 18));
    if (!isAddr(token)) throw new Error('Pick a token address');
    if (!meta) throw new Error("Couldn't read that token's decimals — is it an ERC20?");
    return ctx.send(`Deposit ${amount} ${meta.symbol} → ${nameOf(pool)}`, erc20(token, signer), 'transfer', [pool, toUnits(amount, meta.decimals)]);
  }, 'Deposited');

  const withdraw = () => run(async () => {
    if (!isAddr(w.to)) throw new Error('Recipient is not a valid address');
    const extra = (ctx.book.extraPools || []).find((x) => sameAddr(x.address, pool));
    const key = sameAddr(pool, c.VoucherSettlement) || (extra && extra.kind === 'VoucherSettlement') ? 'VoucherSettlement' : 'RewardVault';
    const vault = ctx.write(key, pool);
    if (sameAddr(w.token, ZERO)) return ctx.send(`Withdraw ${w.amount} ${symbol}`, vault, 'withdrawNative', [w.to, toUnits(w.amount, 18)]);
    // Both pool contracts take ERC20 withdraw amounts in the same 18-decimal fixed point as faceValue
    // and rescale to the token's own decimals on-chain — never pass raw token units here.
    return ctx.send(`Withdraw ${w.amount} ${nameOf(w.token)}`, vault, 'withdrawERC20', [w.token, w.to, toUnits(w.amount, 18)]);
  }, 'Withdrawn');

  return (
    <div className="space-y-4">
      {/* ── One place for the selected pool: which pool, what it pays, and deposit / withdraw on it ── */}
      <Card title="Manage a reward pool">
        <p className="text-xs text-txt-secondary mb-3">
          Reward types pay from their pool, and minting checks the pool holds enough. Pick the pool, then deposit to it or (admin) withdraw from it — both act on the pool shown below.
        </p>
        <Field label="Pool">
          <Select
            value={poolOptions.some((o) => sameAddr(o.value, pool)) ? (poolOptions.find((o) => sameAddr(o.value, pool)) as AddressOption).value : OTHER_POOL}
            onChange={(v) => setPool(v === OTHER_POOL ? '' : v)}
            options={[...poolOptions, { label: 'Other address…', value: OTHER_POOL }]}
          />
          {!poolOptions.some((o) => sameAddr(o.value, pool)) && (
            <div className="mt-2"><AddressInput value={pool} onChange={setPool} placeholder="0x… pool address" /></div>
          )}
        </Field>

        {isAddr(pool) ? (() => {
          const sp = pools.find((x) => sameAddr(x.address, pool));
          const sup = sp ? sp.assets.filter((a) => a.supported) : [];
          const name = poolName(pool);
          // withdraw choices: what the pool supports or actually holds
          const withdrawable = sp ? sp.assets.filter((a) => a.supported || !a.empty) : [];
          const isSettlement = sameAddr(pool, c.VoucherSettlement) || (ctx.book.extraPools || []).some((x) => sameAddr(x.address, pool) && x.kind === 'VoucherSettlement');
          return (
            <>
              {/* selected pool */}
              <div className="mt-3 bg-surface-tertiary rounded-lg p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm text-txt-primary">{name}</span>
                  <code className="font-mono text-txt-secondary break-all">{pool}</code>
                  <button onClick={() => { navigator.clipboard?.writeText?.(pool); setCopied(pool); setTimeout(() => setCopied(''), 1500); }}>
                    {copied === pool ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-txt-secondary hover:text-txt-primary" />}
                  </button>
                  <a href={getExplorerAddressUrl(ctx.chainId, pool)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 text-txt-secondary hover:text-accent" /></a>
                </div>
                {sp && sp.types.length > 0 && (
                  <p className="mt-1 text-txt-secondary">Voucher types: {sp.types.map((t) => `#${t.id} ${t.name}`).join(', ')}</p>
                )}
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  <span className="text-txt-secondary">Supports:</span>
                  {sup.length ? sup.map((a) => <span key={a.address} className="bg-accent/15 text-accent px-2 py-0.5 rounded-full">{a.label.replace(' (native)', '')} · free {a.free}</span>)
                    : <span className="text-yellow-400/80">{sp ? 'no Reward voucher type pays from this pool yet' : loading ? 'loading…' : '—'}</span>}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                {/* deposit */}
                <div className="border border-white/10 rounded-lg p-4">
                  <h4 className="font-medium mb-1">Deposit to {name}</h4>
                  <ContractTag contract="Token" methods={['transfer (ERC20) / send (native) → pool']} label="Sends with" />
                  <div className="space-y-3">
                    {/* the tokens this pool supports; "Other token…" for anything else */}
                    <Field label="Token">
                      <Select
                        value={kind === 'native' ? ZERO : sup.some((a) => sameAddr(a.address, token)) ? sup.find((a) => sameAddr(a.address, token))!.address : OTHER_TOKEN}
                        onChange={(v) => {
                          if (v === ZERO) { setKind('native'); setToken(''); }
                          else if (v === OTHER_TOKEN) { setKind('erc20'); setToken(''); }
                          else { setKind('erc20'); setToken(v); }
                        }}
                        options={[
                          ...sup.map((a) => ({ label: `${a.label.replace(' (native)', '')} · in pool ${a.balance}`, value: a.address })),
                          ...(sup.some((a) => a.address === ZERO) ? [] : [{ label: `${symbol} (native, not used by this pool's types)`, value: ZERO }]),
                          { label: 'Other token…', value: OTHER_TOKEN },
                        ]}
                      />
                      {kind === 'erc20' && !sup.some((a) => sameAddr(a.address, token)) && (
                        <div className="mt-2"><AddressInput value={token} onChange={setToken} options={tokenOptions} placeholder="0x… token address" /></div>
                      )}
                    </Field>
                    <Field label="Amount" hint={kind === 'erc20' && meta ? `${meta.symbol} · ${meta.decimals} decimals · you hold ${meta.wallet}` : undefined}>
                      <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000.5" />
                    </Field>
                  </div>
                  <button className={`${btnCls} mt-4`} disabled={busy} onClick={deposit}>{busy ? 'Sending…' : `Deposit to ${name}`}</button>
                </div>

                {/* withdraw */}
                <div className="border border-white/10 rounded-lg p-4">
                  <h4 className="font-medium mb-1">Withdraw from {name} <span className="text-xs text-txt-secondary">(admin)</span></h4>
                  {poolAdmin === false ? (
                    <p className="text-xs text-txt-secondary">View only — only this pool&apos;s admin can withdraw from it.</p>
                  ) : (
                    <>
                      <ContractTag contract={isSettlement ? 'VoucherSettlement' : 'RewardVault'} methods={['withdrawNative', 'withdrawERC20']} />
                      <p className="text-xs text-txt-secondary mb-3">Only the <b>Free</b> amount can leave; reserved tokens stay for their vouchers. Amount in token units (e.g. 100.5) — the pool rescales it to the token&apos;s decimals itself.</p>
                      <div className="space-y-3">
                        <Field label="Asset">
                          <Select
                            value={w.token}
                            onChange={(v) => setW({ ...w, token: v })}
                            options={withdrawable.length
                              ? withdrawable.map((a) => ({ label: `${a.label.replace(' (native)', '')} · free ${a.free}${a.supported ? '' : ' (not used by its types)'}`, value: a.address }))
                              : [{ label: `${symbol} (native)`, value: ZERO }, ...tokenOptions]}
                          />
                        </Field>
                        <Field label="Amount"><input className={inputCls} value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} /></Field>
                        <Field label="To"><AddressInput value={w.to} onChange={(v) => setW({ ...w, to: v })} options={[{ label: 'Connected wallet', value: account }]} /></Field>
                      </div>
                      <button className={`${btnSecondaryCls} mt-4`} disabled={busy} onClick={withdraw}>Withdraw from {name}</button>
                    </>
                  )}
                </div>
              </div>

              {/* access control */}
              <div className="border border-white/10 rounded-lg p-4 mt-4">
                <h4 className="font-medium mb-1">Access control of {name} <span className="text-xs text-txt-secondary">(admin)</span></h4>
                <p className="text-xs text-txt-secondary mb-3">
                  Checked before every payout from this pool: unrestricted users are paid directly, frozen users&apos; payouts go to their safe wallet, blacklisted users can&apos;t claim. Currently: <span className="text-txt-primary font-medium">{poolAcl === null ? '…' : aclName(poolAcl)}</span>
                  {poolAcl && !sameAddr(poolAcl, ZERO) && <span className="font-mono"> ({poolAcl})</span>}
                </p>
                {poolAdmin === false ? (
                  <p className="text-xs text-txt-secondary">View only — only this pool&apos;s admin can change it.</p>
                ) : (
                  <>
                    <ContractTag contract={isSettlement ? 'VoucherSettlement' : 'RewardVault'} methods={['setAccessControl']} />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                      <Field label="Access control">
                        <Select
                          value={sameAddr(aclPick, ZERO) ? ZERO : hubAcl && sameAddr(aclPick, hubAcl) ? hubAcl : OTHER_ACL}
                          onChange={(v) => setAclPick(v === OTHER_ACL ? '' : v)}
                          options={[
                            ...(hubAcl ? [{ label: `ATM Access Control (GameHub) · ${shortAddr(hubAcl)}`, value: hubAcl }] : []),
                            { label: 'Off (no access control)', value: ZERO },
                            { label: 'Other contract…', value: OTHER_ACL },
                          ]}
                        />
                        {!sameAddr(aclPick, ZERO) && !(hubAcl && sameAddr(aclPick, hubAcl)) && (
                          <div className="mt-2"><AddressInput value={aclPick} onChange={setAclPick} placeholder="0x… access control contract" /></div>
                        )}
                      </Field>
                      <button
                        className={btnSecondaryCls}
                        disabled={busy || poolAcl === null || (!sameAddr(aclPick, ZERO) && (!isAddr(aclPick) || aclCheck !== 'ok')) || (isAddr(aclPick) && sameAddr(aclPick, poolAcl || ''))}
                        onClick={() => run(async () => { await ctx.send(`${name}: access control → ${aclName(aclPick)}`, ctx.write(poolKey2, pool), 'setAccessControl', [aclPick]); setTimeout(loadAcl, 2500); }, 'Access control updated')}
                      >
                        {isAddr(aclPick) && sameAddr(aclPick, poolAcl || '') ? 'Already set' : 'Set access control'}
                      </button>
                    </div>
                    {aclCheck === 'ok' && <p className="text-[11px] text-green-300 mt-1">✓ Responds to redirectTarget()</p>}
                    {aclCheck === 'bad' && <p className="text-[11px] text-red-300 mt-1">✗ This contract doesn&apos;t answer redirectTarget(address) — setting it would make every payout revert</p>}
                  </>
                )}
              </div>
            </>
          );
        })() : (
          <p className="text-sm text-txt-secondary text-center py-4">Pick a pool (deploy RewardVault first, or paste an address).</p>
        )}
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>

      <Card title="All reward pools">
        <div className="flex justify-end -mt-10 mb-4">
          <button className={btnSecondaryCls} disabled={loading} onClick={loadBalances}>{loading ? 'Loading…' : 'Reload'}</button>
        </div>
        <p className="text-xs text-txt-secondary mb-3">Every reward pool contract, the tokens it <b>supports</b> (what its voucher types pay out, read from VoucherNFT) and how much of each it holds, read live. Click <b>Select</b> to manage that pool above.</p>
        {!pools.length && <p className="text-xs text-txt-secondary">{loading ? 'Loading…' : 'No pools found.'}</p>}
        <div className="space-y-3">
          {pools.map((p) => {
            const sel = sameAddr(p.address, pool);
            const supported = p.assets.filter((a) => a.supported);
            const held = p.assets.filter((a) => a.supported || !a.empty);
            const none = p.assets.filter((a) => a.empty && !a.supported);
            return (
              <div key={p.address} className={`bg-surface-tertiary rounded-lg p-3 ${sel ? 'ring-1 ring-accent/60' : ''}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                  <span className="font-semibold text-sm text-txt-primary">{p.label}</span>
                  {sel && <span className="text-[10px] bg-accent/20 text-accent px-1.5 rounded">selected</span>}
                  <code className="font-mono text-txt-secondary break-all">{p.address}</code>
                  <button onClick={() => { navigator.clipboard?.writeText?.(p.address); setCopied(p.address); setTimeout(() => setCopied(''), 1500); }}>
                    {copied === p.address ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-txt-secondary hover:text-txt-primary" />}
                  </button>
                  <a href={getExplorerAddressUrl(ctx.chainId, p.address)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 text-txt-secondary hover:text-accent" /></a>
                  {!sel && <button onClick={() => { setPool(p.address); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="ml-auto text-accent hover:underline">Select</button>}
                </div>
                <div className="flex flex-wrap items-center gap-1 text-[11px] mb-2">
                  <span className="text-txt-secondary">Supports:</span>
                  {supported.length ? supported.map((a) => <span key={a.address} className="bg-accent/15 text-accent px-2 py-0.5 rounded-full">{a.label.replace(' (native)', '')}</span>)
                    : <span className="text-yellow-400/80">no Reward voucher type pays from this pool yet</span>}
                </div>
                {p.types.length > 0 && (
                  <div className="text-[11px] mb-2">
                    <span className="text-txt-secondary">Voucher types paying from this pool:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {p.types.map((t) => {
                        const toks = t.tokens.map((a) => p.assets.find((x) => sameAddr(x.address, a))?.label.replace(' (native)', '') || shortAddr(a));
                        return <span key={t.id} className="bg-surface-secondary border border-white/10 px-2 py-0.5 rounded">#{t.id} {t.name}{toks.length ? <span className="text-accent"> · {toks.join(', ')}</span> : null}</span>;
                      })}
                    </div>
                  </div>
                )}
                {held.length ? (
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-txt-secondary border-b border-white/10"><th className="py-1.5 pr-3">Token</th><th className="py-1.5 pr-3">Token address</th><th className="py-1.5 pr-3">Held</th><th className="py-1.5 pr-3">Reserved</th><th className="py-1.5">Free</th></tr></thead>
                    <tbody>
                      {held.map((b) => (
                        <tr key={b.address} className="border-b border-white/5"><td className="py-1.5 pr-3">{b.label}{!b.supported && <span className="ml-1 text-[10px] text-yellow-400/80" title="No voucher type pays this token from this pool">not used</span>}</td><td className="py-1.5 pr-3 font-mono break-all text-txt-secondary">{b.address === ZERO ? '—' : b.address}</td><td className="py-1.5 pr-3">{b.balance}</td><td className="py-1.5 pr-3">{b.reserved}</td><td className="py-1.5 font-semibold">{b.free}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-txt-secondary">Holds nothing yet.</p>}
                {none.length > 0 && held.length > 0 && <p className="text-[10px] text-txt-secondary mt-1">0 held: {none.map((a) => a.label).join(', ')}</p>}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-txt-secondary mt-2"><b>Reserved</b> = set aside for vouchers already minted in Reserved mode (released on claim, revoke or expiry). <b>Free</b> = what new mints, on-claim payouts and withdrawals can use. Tokens checked: ERC20s in the address book plus every approved ERC20 on a type.</p>
      </Card>
    </div>
  );
}
