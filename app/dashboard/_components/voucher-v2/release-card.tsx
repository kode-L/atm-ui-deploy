'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { TokenStandard, VoucherMode, VoucherType, ZERO, fromUnits, loadVoucherTypes, sameAddr, typeLabel } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { ContractTag, btnCls, btnSecondaryCls } from './ui';

interface Expired {
  id: number;
  owner: string;
  typeId: number;
  faceValue: ethers.BigNumber;
  token: string;
  expiryDate: number;
}

const fungible = (t?: VoucherType) => !!t && t.mode === VoucherMode.Reward && t.tokenStandard <= TokenStandard.ERC20;

const SCAN_LIMIT = 2000; // vouchers checked per scan (newest first)
const PER_TX = 100; // ids per releaseExpiredReservations() call

/**
 * Reserved-mode vouchers keep their tokens set aside until claimed, revoked or expired.
 * Expired ones only release when someone calls VoucherNFT.releaseExpiredReservations(ids) — anyone may.
 */
export default function ReleaseExpiredCard() {
  const ctx = useVoucherV2();
  const [found, setFound] = useState<Expired[] | null>(null);
  const [types, setTypes] = useState<VoucherType[]>([]);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  const scan = useCallback(async () => {
    if (!ctx.book.contracts.VoucherNFT || !ctx.reader) return;
    setBusy(true);
    setMsg(null);
    try {
      const nft = ctx.read('VoucherNFT');
      setTypes(await loadVoucherTypes(nft).catch(() => []));
      const total = (await nft.totalSupply()).toNumber();
      // the contract compares against block time, not this computer's clock
      const now = (await ctx.reader.getBlock('latest')).timestamp;
      const out: Expired[] = [];
      let n = 0;
      for (let i = total - 1; i >= 0 && n < SCAN_LIMIT; i--, n++) {
        const id = (await nft.tokenByIndex(i)).toNumber();
        const v = await nft.vouchers(id);
        const expiry = Number(v.expiryDate);
        if (!(v.reserved && !v.claimed && !v.revoked && expiry > 0 && expiry < now)) continue;
        const owner = await nft.ownerOf(id).catch(() => ZERO);
        out.push({ id, owner, typeId: Number(v.typeId), faceValue: ethers.BigNumber.from(v.faceValue), token: v.token, expiryDate: expiry });
      }
      setScanned(n);
      setFound(out);
    } catch (e: any) {
      setMsg({ ok: false, text: `Could not scan vouchers: ${e.message}` });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.book.contracts.VoucherNFT, ctx.reader]);

  // scan once when the tab opens so the list is just there
  useEffect(() => { scan(); }, [scan]);

  const nameToken = (a: string) => (sameAddr(a, ZERO) ? 'native coin' : ctx.nameOf(a));
  const showReserved = (v: Expired) => {
    const t = typeById.get(v.typeId);
    return fungible(t) ? `${fromUnits(v.faceValue, 18)} ${nameToken(v.token)}` : `${v.faceValue.toString()} × ${nameToken(v.token)}`;
  };
  const poolOf = (v: Expired) => typeById.get(v.typeId)?.sink || ZERO;

  // what releasing frees, per pool + token
  const totals = useMemo(() => {
    const m = new Map<string, { pool: string; token: string; amount: ethers.BigNumber; count: number; fungible: boolean }>();
    for (const v of found || []) {
      const t = typeById.get(v.typeId);
      const pool = t?.sink || ZERO;
      const k = `${pool.toLowerCase()}|${v.token.toLowerCase()}`;
      const cur = m.get(k) || { pool, token: v.token, amount: ethers.BigNumber.from(0), count: 0, fungible: fungible(t) };
      cur.amount = cur.amount.add(v.faceValue);
      cur.count++;
      m.set(k, cur);
    }
    return [...m.values()];
  }, [found, typeById]);

  const release = async () => {
    if (!found?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const all = found.map((v) => v.id);
      for (let i = 0; i < all.length; i += PER_TX) {
        const ids = all.slice(i, i + PER_TX);
        await ctx.send(`Release ${ids.length} expired reservation(s)`, ctx.write('VoucherNFT'), 'releaseExpiredReservations', [ids]);
      }
      setMsg({ ok: true, text: `Released ${all.length} expired reservation(s) — those tokens are free again` });
      setFound([]);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!ctx.book.contracts.VoucherNFT) return null;

  return (
    <Card title="Release expired reservations">
      <ContractTag contract="VoucherNFT" methods={['releaseExpiredReservations']} />
      <p className="text-xs text-txt-secondary mb-3">
        A <b>Reserved</b>-mode voucher keeps its tokens set aside in the pool until it is claimed, revoked or expires.
        Expired ones are only released when someone sends this — anyone can, no role needed. Released tokens become free in the pool again.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnSecondaryCls} disabled={busy} onClick={scan}>{busy && !found ? 'Scanning…' : found ? 'Scan again' : 'Find expired reservations'}</button>
        {found && (
          <span className="text-xs text-txt-secondary">
            {found.length ? <><b className="text-txt-primary">{found.length}</b> expired reservation(s)</> : 'None to release'} · checked {scanned} voucher(s)
          </span>
        )}
      </div>

      {!!found?.length && (
        <div className="mt-3 space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-txt-secondary text-left">
                <tr><th className="py-1.5 pr-3">Voucher</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">Reserved</th><th className="py-1.5 pr-3">Pool</th><th className="py-1.5 pr-3">Held by</th><th className="py-1.5 pr-3">Expired</th></tr>
              </thead>
              <tbody>
                {found.map((v) => {
                  const t = typeById.get(v.typeId);
                  return (
                    <tr key={v.id} className="border-t border-white/5">
                      <td className="py-1.5 pr-3">#{v.id}</td>
                      <td className="py-1.5 pr-3">{t ? typeLabel(t) : `#${v.typeId}`}</td>
                      <td className="py-1.5 pr-3 font-semibold">{showReserved(v)}</td>
                      <td className="py-1.5 pr-3">{ctx.nameOf(poolOf(v))}</td>
                      <td className="py-1.5 pr-3 font-mono break-all" title={v.owner}>
                        {sameAddr(v.owner, ZERO) ? '—' : ethers.utils.getAddress(v.owner)}{sameAddr(v.owner, ctx.account) ? ' (you)' : ''}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(v.expiryDate * 1000).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-white/10 bg-surface-tertiary p-3 text-xs space-y-1">
            <div className="font-semibold text-sm">Releasing frees</div>
            {totals.map((x) => (
              <div key={`${x.pool}|${x.token}`}>
                <b className="text-green-300">{x.fungible ? fromUnits(x.amount, 18) : x.amount.toString()} {nameToken(x.token)}</b> in {ctx.nameOf(x.pool)} ({x.count} voucher{x.count > 1 ? 's' : ''})
              </div>
            ))}
            <p className="text-txt-secondary">Nothing happens to the vouchers themselves — they are not revoked or burned and stay in the holder's wallet (still marked Expired, still not claimable). Only the pool's set-aside amount is unlocked so it can back new vouchers or be withdrawn.</p>
          </div>
          <button className={btnCls} disabled={busy} onClick={release}>{busy ? 'Sending…' : `Release ${found.length}`}</button>
        </div>
      )}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}
