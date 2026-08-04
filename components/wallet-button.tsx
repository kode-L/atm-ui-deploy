'use client';
import React from 'react';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { NETWORKS } from '@/lib/contracts/config';
import { Wallet, LogOut, AlertTriangle, Loader2 } from 'lucide-react';

export default function WalletButton() {
  const { isConnected, address, bnbBalance, chainId, connecting, connect, disconnect, openNetworkPicker } = useWeb3();

  const network = NETWORKS[chainId];
  const wrongNetwork = isConnected && !network;

  if (connecting) {
    return (
      <button className="flex items-center gap-2 bg-surface-tertiary px-4 py-2 rounded-lg text-sm" disabled>
        <Loader2 className="w-4 h-4 animate-spin" /> Connecting...
      </button>
    );
  }

  if (!isConnected) {
    return (
      <button onClick={connect} className="flex items-center gap-2 bg-accent hover:bg-accent-dark text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
        <Wallet className="w-4 h-4" /> Connect Wallet
      </button>
    );
  }

  if (wrongNetwork) {
    return (
      <button onClick={openNetworkPicker} className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm transition-colors">
        <AlertTriangle className="w-4 h-4" /> Wrong network — switch
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={openNetworkPicker}
        title="Switch network"
        className="hidden sm:inline text-xs text-txt-secondary hover:text-accent transition-colors"
      >
        {network!.chainName}
      </button>
      <button
        onClick={connect}
        title="Open wallet"
        className="flex items-center gap-2 bg-surface-tertiary hover:bg-surface-tertiary/70 px-3 py-1.5 rounded-lg text-sm transition-colors"
      >
        <Wallet className="w-3.5 h-3.5 text-accent" />
        <span className="text-accent font-medium">{parseFloat(bnbBalance || '0').toFixed(4)}</span>
        <span className="text-txt-secondary">{network!.nativeCurrency.symbol}</span>
        <span className="text-txt-secondary font-mono">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
      </button>
      <button onClick={disconnect} className="p-2 hover:bg-surface-tertiary rounded-lg transition-colors" title="Disconnect">
        <LogOut className="w-4 h-4 text-txt-secondary" />
      </button>
    </div>
  );
}
