'use client';
import React from 'react';
import Header from '@/components/header';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { Gamepad2, Wallet, Loader2 } from 'lucide-react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isConnected, initialized, connecting, connect } = useWeb3();

  // Wait for AppKit to finish restoring any existing session before deciding
  // whether to show the connect gate, so an already-connected user doesn't see
  // it flash on every page load.
  if (!initialized) return null;

  if (!isConnected && false) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary px-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center gap-3 mb-8">
            <Gamepad2 className="w-10 h-10 text-accent" />
            <h1 className="text-3xl font-bold">Daily PR Boost <span className="text-accent">Manager</span></h1>
          </div>
          <div className="bg-surface-secondary rounded-xl shadow-2xl shadow-black/40 p-8 text-center">
            <h2 className="text-xl font-semibold mb-2">Connect your wallet</h2>
            <p className="text-txt-secondary text-sm mb-6">
              Connect a wallet to access the dashboard and interact with contracts on BNB Smart Chain (Testnet or Mainnet).
            </p>
            <button
              onClick={connect}
              disabled={connecting}
              className="w-full bg-accent hover:bg-accent-dark text-black font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
              {connecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-[1200px] mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
