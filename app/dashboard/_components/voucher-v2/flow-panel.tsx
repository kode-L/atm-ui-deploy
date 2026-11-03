'use client';
import React, { useEffect } from 'react';
import { CheckCircle2, Circle, Loader2, X, XCircle } from 'lucide-react';
import { getExplorerTxUrl } from '@/lib/contracts/config';
import { useVoucherV2 } from './context';

/**
 * Bottom-right panel for an action that sends several transactions: numbered steps with their
 * state (waiting for the wallet, confirming, done, failed). Closes itself shortly after
 * everything succeeded; stays open on an error.
 */
export default function FlowPanel() {
  const { flow, closeFlow, chainId, stepAction } = useVoucherV2();
  const allDone = !!flow && flow.steps.length > 0 && flow.steps.every((s) => s.status === 'done');

  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(closeFlow, 5000);
    return () => clearTimeout(t);
  }, [allDone, closeFlow, flow?.id]);

  if (!flow || !flow.steps.length) return null;
  const done = flow.steps.filter((s) => s.status === 'done').length;
  const failed = flow.steps.some((s) => s.status === 'error');

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-32px)] rounded-xl border border-white/10 bg-surface-secondary shadow-2xl p-4 space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{flow.title}</div>
          <div className="text-xs text-txt-secondary">
            {failed ? 'Stopped — a step failed' : allDone ? 'All done' : `Step ${Math.min(done + 1, flow.steps.length)} of ${flow.steps.length}`}
          </div>
        </div>
        <button onClick={closeFlow} className="text-txt-secondary hover:text-txt-primary" title="Close"><X className="w-4 h-4" /></button>
      </div>
      <ol className="space-y-2">
        {flow.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {s.status === 'done' ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
              : s.status === 'error' ? <XCircle className="w-4 h-4 text-red-400 shrink-0" />
              : s.status === 'pending' ? <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
              : <Circle className="w-4 h-4 text-txt-secondary shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className={s.status === 'todo' ? 'text-txt-secondary' : ''}>{i + 1}. {s.label}</div>
              {s.status === 'pending' && (
                <div className="text-txt-secondary">
                  {s.hash ? <>Confirming on-chain… <a className="text-accent" href={getExplorerTxUrl(chainId, s.hash)} target="_blank" rel="noopener noreferrer">view tx</a></> : 'Confirm it in your wallet…'}
                </div>
              )}
              {s.status === 'pending' && !s.hash && s.stuck && s.key && (
                <div className="mt-1 space-y-1">
                  <div className="text-yellow-300">No answer from the wallet yet.</div>
                  <div className="flex flex-wrap gap-3">
                    <button className="text-accent hover:underline" onClick={() => stepAction(s.key as string, 'find')}>I already confirmed it — find it</button>
                    <button className="text-accent hover:underline" onClick={() => stepAction(s.key as string, 'retry')}>Ask the wallet again</button>
                  </div>
                </div>
              )}
              {s.status === 'pending' && s.note && <div className="text-txt-secondary mt-1">{s.note}</div>}
              {s.status === 'done' && s.hash && <a className="text-accent" href={getExplorerTxUrl(chainId, s.hash)} target="_blank" rel="noopener noreferrer">view tx</a>}
              {s.status === 'error' && <div className="text-red-300 break-all">{s.error}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
