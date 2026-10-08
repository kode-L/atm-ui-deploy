'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { NETWORKS } from '@/lib/contracts/config';
import { TokenStandard, VoucherMode, ZERO, fromUnits, isAddr, loadVoucherTypes, sameAddr, toUnits } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { useSourceOptions } from './source-options';
import ExtraSinksCard from './extra-sinks-card';
import { ContractTag, AddressInput, AddressOption, Field, NavButtons, Select, btnCls, btnSecondaryCls, inputCls } from './ui';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ERC721 / ERC1155 deposits left out for now, matching the RewardSink wiring step
type Kind = 'native' | 'erc20';
const OTHER_POOL = '__other__';
interface TokenBal { address: string; label: string; balance: string }

export default function FundingTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const { read, reader, signer, account, nameOf } = ctx;
  const c = ctx.book.contracts;
  const symbol = NETWORKS[ctx.chainId]?.nativeCurrency.symbol || 'native';
  const [pool, setPool] = useState(c.RewardSink || '');
  const [kind, setKind] = useState<Kind>('native');
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [meta, setMeta] = useState<{ symbol: string; decimals: number; wallet: string } | null>(null);
  const [native, setNative] = useState('—');
  const [balances, setBalances] = useState<TokenBal[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [w, setW] = useState({ token: ZERO, amount: '', to: account });

  useEffect(() => { if (!pool && c.RewardSink) setPool(c.RewardSink); }, [c.RewardSink, pool]);

  // every pool by name: main + extra RewardSinks, VoucherIncentive, and anything the registry approved
  const poolOptions: AddressOption[] = useSourceOptions(null, 0).map((o) => ({ label: o.label, value: o.value }));
  const tokenOptions: AddressOption[] = Object.entries(ctx.book.tokens).map(([k, v]) => ({ label: k, value: v }));
  const erc20 = useCallback((a: string, s?: ethers.Signer | null) => new ethers.Contract(a, ERC20_ABI, s || reader || undefined), [reader]);

  const loadBalances = useCallback(async () => {
    if (!isAddr(pool) || !reader) return;
    setLoading(true);
    try {
      setNative(fromUnits(await reader.getBalance(pool), 18));
      const addrs = new Set(Object.values(ctx.book.tokens));
      if (ctx.book.contracts.VoucherNFT) {
        const types = await loadVoucherTypes(read('VoucherNFT')).catch(() => []);
        types.filter((t) => t.mode === VoucherMode.Reward && t.tokenStandard === TokenStandard.ERC20).forEach((t) => t.approvedTokens.forEach((a) => addrs.add(a)));
      }
      const out: TokenBal[] = [];
      for (const a of addrs) {
        try {
          const t = erc20(a);
          const [sym, dec, bal] = await Promise.all([t.symbol(), t.decimals(), t.balanceOf(pool)]);
          const known = nameOf(a);
          // "tUSDT" — add the book's label only when it says something the symbol doesn't
          out.push({ address: a, label: known.startsWith('0x') || known.toLowerCase().includes(sym.toLowerCase()) ? sym : `${sym} (${known})`, balance: fromUnits(bal, dec) });
        } catch {
          // not an ERC20 (e.g. an NFT collection saved in the book) — skip
        }
      }
      setBalances(out);
    } finally {
      setLoading(false);
    }
  }, [pool, reader, read, erc20, nameOf, ctx.book]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

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
    const extra = (ctx.book.extraSinks || []).find((x) => sameAddr(x.address, pool));
    const key = sameAddr(pool, c.VoucherIncentive) || (extra && extra.kind === 'VoucherIncentive') ? 'VoucherIncentive' : 'RewardSink';
    const sink = ctx.write(key, pool);
    if (sameAddr(w.token, ZERO)) return ctx.send(`Withdraw ${w.amount} ${symbol}`, sink, 'withdrawNative', [w.to, toUnits(w.amount, 18)]);
    // Both sinks take ERC20 withdraw amounts in the same 18-decimal fixed point as faceValue
    // and rescale to the token's own decimals on-chain — never pass raw token units here.
    return ctx.send(`Withdraw ${w.amount} ${nameOf(w.token)}`, sink, 'withdrawERC20', [w.token, w.to, toUnits(w.amount, 18)]);
  }, 'Withdrawn');

  return (
    <div className="space-y-4">
      <Card title="Fund a reward pool">
        <p className="text-xs text-txt-secondary mb-3">
          Reward types pay from their pool, and minting checks the pool holds enough. Top it up from the connected wallet.
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
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>

      {isAddr(pool) ? (
        <>
          <Card title="Pool balances">
            <div className="flex justify-end -mt-10 mb-4">
              <button className={btnSecondaryCls} disabled={loading} onClick={loadBalances}>{loading ? 'Loading…' : 'Reload'}</button>
            </div>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-txt-secondary border-b border-white/10"><th className="py-2 pr-3">Asset</th><th className="py-2 pr-3">Address</th><th className="py-2">Pool balance</th></tr></thead>
              <tbody>
                <tr className="border-b border-white/5"><td className="py-2 pr-3">{symbol} (native)</td><td className="py-2 pr-3 text-txt-secondary">—</td><td className="py-2">{native}</td></tr>
                {balances.map((b) => (
                  <tr key={b.address} className="border-b border-white/5"><td className="py-2 pr-3">{b.label}</td><td className="py-2 pr-3 font-mono break-all">{b.address}</td><td className="py-2">{b.balance}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-txt-secondary mt-2">Lists ERC20s saved in the address book plus every approved ERC20 on a registered type.</p>
          </Card>

          <Card title="Deposit">
        <ContractTag contract="Token" methods={['transfer (ERC20) / send (native) → pool']} label="Sends with" />
            <div className="flex gap-1 bg-surface-tertiary rounded-lg p-1 w-fit mb-4">
              {(['native', 'erc20'] as Kind[]).map((k) => (
                <button key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 rounded text-xs font-medium ${kind === k ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
                  {k === 'native' ? symbol : k.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {kind === 'erc20' && (
                <Field label="Token"><AddressInput value={token} onChange={setToken} options={tokenOptions} /></Field>
              )}
              <Field label="Amount" hint={kind === 'erc20' && meta ? `${meta.symbol} · ${meta.decimals} decimals · you hold ${meta.wallet}` : undefined}>
                <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000.5" />
              </Field>
            </div>
            <button className={`${btnCls} mt-4`} disabled={busy} onClick={deposit}>{busy ? 'Sending…' : 'Deposit to pool'}</button>
          </Card>

          <Card title="Withdraw (admin)">
        <ContractTag contract={sameAddr(pool, c.VoucherIncentive) || (ctx.book.extraSinks || []).some((x) => sameAddr(x.address, pool) && x.kind === 'VoucherIncentive') ? 'VoucherIncentive' : 'RewardSink'} methods={['withdrawNative', 'withdrawERC20']} />
            <p className="text-xs text-txt-secondary mb-3">RewardSink / VoucherIncentive admin only. Sends from the pool to the given address. Enter the amount in token units (e.g. 100.5) — the pool rescales it to the token&apos;s decimals itself.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Asset">
                <Select value={w.token} onChange={(v) => setW({ ...w, token: v })} options={[{ label: `${symbol} (native)`, value: ZERO }, ...tokenOptions]} />
              </Field>
              <Field label="Amount"><input className={inputCls} value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} /></Field>
              <Field label="To"><AddressInput value={w.to} onChange={(v) => setW({ ...w, to: v })} options={[{ label: 'Connected wallet', value: account }]} /></Field>
            </div>
            <button className={`${btnSecondaryCls} mt-4`} disabled={busy} onClick={withdraw}>Withdraw</button>
          </Card>
        </>
      ) : (
        <Card><p className="text-sm text-txt-secondary text-center py-4">Pick a pool (deploy RewardSink first, or paste an address).</p></Card>
      )}

    </div>
  );
}
