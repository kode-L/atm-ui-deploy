'use client';
import React, { useState } from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import Card from '@/components/card';
import { NETWORKS, getExplorerAddressUrl, getExplorerTxUrl } from '@/lib/contracts/config';
import { shortAddr } from '@/lib/contracts/voucher-v2';
import { TxLogEntry, useVoucherV2 } from './context';
import { Badge, Collapsible, btnDangerCls, btnSecondaryCls } from './ui';

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** Every tx sent from the Voucher V2 tabs, with its hash and contract address — kept per chain in localStorage. */
export default function TxLogCard() {
  const ctx = useVoucherV2();
  const [copied, setCopied] = useState('');
  const network = NETWORKS[ctx.chainId];
  const networkName = network?.chainName || `chain ${ctx.chainId}`;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  const addressOf = (t: TxLogEntry) => t.deployed || t.to;

  const asText = () => [
    `Voucher V2 transactions — ${networkName} (chainId ${ctx.chainId})`,
    '',
    'Contracts:',
    ...Object.entries(ctx.book.contracts).map(([k, v]) => `  ${k}: ${v}${ctx.book.implementations[k as keyof typeof ctx.book.implementations] ? ` (impl ${ctx.book.implementations[k as keyof typeof ctx.book.implementations]})` : ''}`),
    '',
    'Transactions (newest first):',
    ...ctx.txLog.map((t) => [
      fmtTime(t.at), t.status, t.label,
      t.hash ? `tx ${t.hash}` : 'no tx hash',
      t.deployed ? `deployed ${t.deployed}` : t.to ? `to ${t.to}` : '',
      t.error ? `error: ${t.error}` : '',
    ].filter(Boolean).join(' | ')),
  ].join('\n');

  const exportJson = () => {
    const data = {
      chainId: ctx.chainId,
      network: networkName,
      exportedAt: new Date().toISOString(),
      contracts: ctx.book.contracts,
      implementations: ctx.book.implementations,
      transactions: ctx.txLog.map(({ id, ...t }) => t),
    };
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voucher-v2-transactions-${ctx.chainId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => {
    if (window.confirm(`Delete all ${ctx.txLog.length} saved transactions for ${networkName} from this browser? Export them first if you need the hashes.`)) ctx.clearTxLog();
  };

  const CopyBtn = ({ text, id }: { text: string; id: string }) => (
    <button onClick={() => copy(text, id)} className="shrink-0" title="Copy">
      {copied === id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-txt-secondary hover:text-txt-primary" />}
    </button>
  );

  return (
    <Collapsible title="Transactions" summary={`${ctx.txLog.length} saved for ${networkName} · hashes, deployed addresses, copy / export`}>
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-xs text-txt-secondary">
          {ctx.txLog.length} saved in this browser for {networkName}. Export them for a safe copy — clearing site data deletes them.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={btnSecondaryCls} onClick={() => copy(asText(), 'all')}>{copied === 'all' ? 'Copied ✓' : 'Copy all'}</button>
          <button className={btnSecondaryCls} onClick={exportJson}>Export JSON</button>
          <button className={btnDangerCls} onClick={clear}>Clear</button>
        </div>
      </div>
      <div className="space-y-1.5">
        {ctx.txLog.map((t) => {
          const addr = addressOf(t);
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-b border-white/5 pb-1.5">
              <span className="text-txt-secondary">{fmtTime(t.at)}</span>
              {t.status === 'pending' && <Loader2 className="w-3.5 h-3.5 animate-spin text-yellow-300" />}
              {t.status === 'success' && <Badge tone="good">ok</Badge>}
              {t.status === 'error' && <Badge tone="bad">failed</Badge>}
              {t.status === 'unknown' && <Badge tone="warn">unconfirmed</Badge>}
              <span>{t.label}</span>
              {t.hash && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-txt-secondary">tx</span>
                  <a href={getExplorerTxUrl(ctx.chainId, t.hash)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent inline-flex items-center gap-1">
                    {shortAddr(t.hash)} <ExternalLink className="w-3 h-3" />
                  </a>
                  <CopyBtn text={t.hash} id={`h${t.id}`} />
                </span>
              )}
              {addr && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-txt-secondary">{t.deployed ? 'deployed' : 'to'}</span>
                  <a href={getExplorerAddressUrl(ctx.chainId, addr)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent inline-flex items-center gap-1">
                    {addr} <ExternalLink className="w-3 h-3" />
                  </a>
                  <CopyBtn text={addr} id={`a${t.id}`} />
                </span>
              )}
              {t.error && <span className="text-red-300 break-all w-full">{t.error}</span>}
            </div>
          );
        })}
      </div>
    </Card>
    </Collapsible>
  );
}
