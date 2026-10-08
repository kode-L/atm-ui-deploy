'use client';
import React, { useCallback, useState } from 'react';
import Card from '@/components/card';
import { useVoucherV2 } from './context';
import { ContractTag, btnCls, btnSecondaryCls } from './ui';

const SCAN_LIMIT = 2000; // vouchers checked per scan (newest first)
const PER_TX = 100; // ids per releaseExpired() call

/**
 * Reserved-mode vouchers keep their tokens set aside until claimed, revoked or expired.
 * Expired ones only release when someone calls VoucherNFT.releaseExpired(ids) — anyone may.
 */
export default function ReleaseExpiredCard() {
  const ctx = useVoucherV2();
  const [found, setFound] = useState<number[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const scan = useCallback(async () => {
    if (!ctx.book.contracts.VoucherNFT || !ctx.reader) return;
    setBusy(true);
    setMsg(null);
    try {
      const nft = ctx.read('VoucherNFT');
      const total = (await nft.totalSupply()).toNumber();
      const now = Math.floor(Date.now() / 1000);
      const out: number[] = [];
      let n = 0;
      for (let i = total - 1; i >= 0 && n < SCAN_LIMIT; i--, n++) {
        const id = (await nft.tokenByIndex(i)).toNumber();
        const v = await nft.vouchers(id);
        const expiry = Number(v.expiryDate);
        if (v.reserved && !v.redeemed && !v.revoked && expiry > 0 && expiry < now) out.push(id);
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

  const release = async () => {
    if (!found?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      for (let i = 0; i < found.length; i += PER_TX) {
        const ids = found.slice(i, i + PER_TX);
        await ctx.send(`Release ${ids.length} expired reservation(s)`, ctx.write('VoucherNFT'), 'releaseExpired', [ids]);
      }
      setMsg({ ok: true, text: `Released ${found.length} expired reservation(s) — those tokens are free again` });
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
      <ContractTag contract="VoucherNFT" methods={['releaseExpired']} />
      <p className="text-xs text-txt-secondary mb-3">
        A <b>Reserved</b>-mode voucher keeps its tokens set aside in the pool until it is claimed, revoked or expires.
        Expired ones are only released when someone sends this — anyone can, no role needed. Released tokens become free in the pool again.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnSecondaryCls} disabled={busy} onClick={scan}>{busy && !found ? 'Scanning…' : 'Find expired reservations'}</button>
        {found && (
          <span className="text-xs text-txt-secondary">
            {found.length ? <><b className="text-txt-primary">{found.length}</b> found (ids {found.slice(0, 8).join(', ')}{found.length > 8 ? '…' : ''})</> : 'None to release'} · checked {scanned} voucher(s)
          </span>
        )}
        {!!found?.length && <button className={btnCls} disabled={busy} onClick={release}>{busy ? 'Sending…' : `Release ${found.length}`}</button>}
      </div>
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </Card>
  );
}
