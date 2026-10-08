'use client';
import React, { useState } from 'react';
import { NETWORKS } from '@/lib/contracts/config';
import { emptyBook } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { btnDangerCls, btnSecondaryCls } from './ui';

type Ctx = ReturnType<typeof useVoucherV2>;

/** Download this network's address book (+ transaction history) as JSON. */
export function exportBook(ctx: Ctx) {
  const { contracts, implementations, tokens, extraSinks, deployedAt } = ctx.book;
  const network = NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}`;
  const data = { network, chainId: ctx.chainId, deployedAt, contracts, implementations, extraSinks, tokens, transactions: ctx.txLog.map(({ id, ...t }) => t) };
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `voucher-v2-${ctx.chainId}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ctx.markExported();
}

/**
 * Forget every Voucher V2 address and transaction saved in this browser for the current network,
 * so a full redeploy starts from zero. Contracts already on-chain are untouched.
 */
export default function StartFresh({ compact }: { compact?: boolean }) {
  const ctx = useVoucherV2();
  const [done, setDone] = useState(false);
  const network = NETWORKS[ctx.chainId]?.chainName || `chain ${ctx.chainId}`;
  const count = Object.keys(ctx.book.contracts).length + (ctx.book.extraSinks || []).length;
  if (!count && !ctx.txLog.length && !done) return null;

  const reset = () => {
    if (!window.confirm(
      `Start fresh on ${network}?\n\nThis forgets ${count} saved contract address(es), extra pools, saved tokens and ${ctx.txLog.length} saved transaction(s) in THIS browser, ` +
      'so Deploy starts from zero. Contracts already deployed on-chain are not touched.\n\nTip: press Cancel and use "Export first" to keep a copy.',
    )) return;
    ctx.replaceBook(emptyBook());
    ctx.clearTxLog();
    ctx.setTypeId(-1);
    setDone(true);
  };

  if (done && !count) {
    return <p className="text-xs text-green-300">✓ Cleared — Voucher V2 starts fresh on {network}. Use &quot;Deploy all remaining&quot; to redeploy everything.</p>;
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'rounded-lg border border-red-400/20 bg-red-900/10 p-3'}`}>
      {!compact && (
        <span className="text-xs text-txt-secondary flex-1 min-w-[240px]">
          <b className="text-txt-primary">Redeploying everything?</b> Start fresh to forget the {count} saved address(es) and the transaction history for {network} in this browser. On-chain contracts are not touched.
        </span>
      )}
      <button className={btnSecondaryCls} onClick={() => exportBook(ctx)}>Export first</button>
      <button className={btnDangerCls} onClick={reset}>Start fresh</button>
    </div>
  );
}
