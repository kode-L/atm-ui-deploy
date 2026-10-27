'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { ARTIFACTS, FundingMode, PayoutMode, VoucherMode, VoucherType, ZERO, fromUnits, sameAddr } from '@/lib/contracts/voucher-v2';
import { NETWORKS } from '@/lib/contracts/config';
import { useVoucherV2 } from './context';
import { btnCls, inputCls } from './ui';

const ERC20 = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
];

/**
 * Funding check for a mint, right where you mint: the type's pool, how much of the payout token it
 * holds, how much is already reserved for earlier vouchers, what's free, what this mint needs —
 * and a one-click top-up of the shortfall from the connected wallet.
 *
 * needed: total value this mint will reserve, in 18-decimal fixed point (quantity × faceValue).
 */
export default function PoolFundingBox({ type, token, needed, onShort }: { type?: VoucherType; token: string; needed: ethers.BigNumber; onShort?: (short: boolean) => void }) {
  const ctx = useVoucherV2();
  const [info, setInfo] = useState<{ held: ethers.BigNumber; reserved: ethers.BigNumber; decimals: number; symbol: string; wallet: ethers.BigNumber } | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reward = type?.mode === VoucherMode.Reward;
  const pool = type?.sink || ZERO;
  const isNative = sameAddr(token, ZERO);
  // External payouts hold nothing; points need no tokens
  const relevant = reward && !sameAddr(pool, ZERO) && type?.payoutMode !== PayoutMode.External;

  const load = useCallback(async () => {
    if (!relevant || !ctx.reader || !type) return setInfo(null);
    try {
      const sink = new ethers.Contract(pool, ARTIFACTS.RewardSink.abi, ctx.reader);
      const [held, reserved] = await Promise.all([
        sink.availableBalance(type.id, type.tokenStandard, token, 0),
        ctx.read('VoucherNFT').reservedOf(pool, token, 0).catch(() => ethers.BigNumber.from(0)),
      ]);
      let decimals = 18;
      let symbol = NETWORKS[ctx.chainId]?.nativeCurrency.symbol || 'native';
      let wallet = await ctx.reader.getBalance(ctx.account);
      if (!isNative) {
        const t = new ethers.Contract(token, ERC20, ctx.reader);
        [decimals, symbol, wallet] = await Promise.all([t.decimals(), t.symbol(), t.balanceOf(ctx.account)]);
      }
      setInfo({ held, reserved, decimals, symbol, wallet });
    } catch {
      setInfo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevant, pool, token, type?.id, ctx.reader, ctx.account, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  // tell the form whether a mint would fail, so it can hold the button until topped up
  const shortNow = !!(info && relevant && type?.fundingMode === FundingMode.Reserved && needed.gt(info.held.sub(info.reserved).lt(0) ? 0 : info.held.sub(info.reserved)));
  useEffect(() => { onShort?.(shortNow); }, [shortNow, onShort]);

  if (!relevant || !type) return null;
  if (!info) return <div className="text-xs text-txt-secondary">Reading the pool…</div>;

  const free = info.held.sub(info.reserved);
  const freePos = free.lt(0) ? ethers.BigNumber.from(0) : free;
  const shortBy = needed.sub(freePos);
  const short = shortBy.gt(0);
  const reservedMode = type.fundingMode === FundingMode.Reserved;
  // 18-dp fixed point → token units (rounded up so the top-up really covers it)
  const toTokenUnits = (v18: ethers.BigNumber) => {
    if (info.decimals >= 18) return v18.mul(ethers.BigNumber.from(10).pow(info.decimals - 18));
    const f = ethers.BigNumber.from(10).pow(18 - info.decimals);
    return v18.add(f.sub(1)).div(f);
  };
  const show = (v18: ethers.BigNumber) => `${fromUnits(v18, 18)} ${info.symbol}`;
  const suggested = short ? fromUnits(toTokenUnits(shortBy), info.decimals) : '';

  const topUp = async () => {
    const amt = (amount || suggested).trim();
    if (!amt || Number(amt) <= 0) return setMsg({ ok: false, text: 'Enter an amount to add' });
    setBusy(true);
    setMsg(null);
    try {
      const units = ethers.utils.parseUnits(amt, info.decimals);
      if (isNative) await ctx.sendValue(`Top up ${ctx.nameOf(pool)} with ${amt} ${info.symbol}`, pool, units.toString());
      else await ctx.send(`Top up ${ctx.nameOf(pool)} with ${amt} ${info.symbol}`, new ethers.Contract(token, ERC20, ctx.signer || undefined), 'transfer', [pool, units]);
      setMsg({ ok: true, text: `Added ${amt} ${info.symbol} to ${ctx.nameOf(pool)}` });
      setAmount('');
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-lg border p-3 space-y-2 text-xs ${short ? 'border-yellow-500/40 bg-yellow-900/10' : 'border-white/10 bg-surface-tertiary'}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-sm">Pool: {ctx.nameOf(pool)}</span>
        <span>Held <b>{show(info.held)}</b></span>
        <span>Reserved <b>{show(info.reserved)}</b></span>
        <span>Free <b className={short ? 'text-yellow-300' : 'text-green-300'}>{show(freePos)}</b></span>
        <span>This mint needs <b>{show(needed)}</b></span>
      </div>
      {short ? (
        <p className="text-yellow-300">
          Short by <b>{show(shortBy)}</b> — {reservedMode ? 'minting will fail until the pool has enough free tokens.' : 'claims will fail until the pool has enough free tokens.'}
        </p>
      ) : (
        <p className="text-green-300">Enough free tokens{reservedMode ? ' — they will be reserved for these vouchers when you mint.' : ' — paid out when the vouchers are claimed.'}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} w-44`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={suggested || `amount in ${info.symbol}`} />
        <button className={btnCls} disabled={busy} onClick={topUp}>{busy ? 'Sending…' : short ? `Top up ${suggested} ${info.symbol}` : 'Add funds'}</button>
        <span className="text-txt-secondary">Your wallet: {fromUnits(info.wallet, info.decimals)} {info.symbol}</span>
      </div>
      {msg && <p className={`break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </div>
  );
}
