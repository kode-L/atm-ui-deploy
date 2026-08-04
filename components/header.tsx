'use client';
import React from 'react';
import Link from 'next/link';
import WalletButton from './wallet-button';
import { Gamepad2 } from 'lucide-react';

export default function Header() {
  return (
    <header className="sticky top-0 z-50 bg-surface-primary/90 backdrop-blur-md border-b border-surface-tertiary">
      <div className="max-w-[1200px] mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 group">
          <Gamepad2 className="w-7 h-7 text-accent group-hover:scale-110 transition-transform" />
          <span className="font-bold text-lg">Daily PR Boost <span className="text-accent">Manager</span></span>
        </Link>
        <WalletButton />
      </div>
    </header>
  );
}
