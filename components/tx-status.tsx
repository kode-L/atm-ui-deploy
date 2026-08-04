'use client';
import React from 'react';
import { CheckCircle, XCircle, Loader2, ExternalLink } from 'lucide-react';
import { getExplorerTxUrl } from '@/lib/contracts/config';

interface TxStatusProps {
  status: 'idle' | 'pending' | 'success' | 'error';
  hash?: string;
  error?: string;
  message?: string;
  // Falls back to the testnet explorer (getExplorerTxUrl's own default) if omitted.
  chainId?: number;
}

export default function TxStatus({ status, hash, error, message, chainId }: TxStatusProps) {
  if (status === 'idle') return null;

  return (
    <div className={`mt-3 p-3 rounded-lg text-sm flex items-start gap-2 ${
      status === 'pending' ? 'bg-yellow-900/30 text-yellow-300' :
      status === 'success' ? 'bg-green-900/30 text-green-300' :
      'bg-red-900/30 text-red-300'
    }`}>
      {status === 'pending' && <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0" />}
      {status === 'success' && <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      {status === 'error' && <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <p>{message || (status === 'pending' ? 'Transaction pending...' : status === 'success' ? 'Transaction successful!' : 'Transaction failed')}</p>
        {hash && (
          <a
            href={getExplorerTxUrl(chainId ?? 0, hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 mt-1 text-accent hover:underline text-xs"
          >
            View on BscScan <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {error && <p className="mt-1 text-xs opacity-80 break-all">{error}</p>}
      </div>
    </div>
  );
}
