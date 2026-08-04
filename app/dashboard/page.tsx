'use client';
import React, { useState, useEffect } from 'react';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { Wallet, Shield, Gamepad2, Swords, Coins, Zap, DollarSign, Users, Split, Search, Network, Loader2, HelpCircle, Flame, IdCard } from 'lucide-react';
import DeploySection from './_components/deploy-section';
import HubSection from './_components/hub-section';
import TokenSection from './_components/token-section';
import AdminSection from './_components/admin-section';
import GamesSection from './_components/games-section';
import BattlesSection from './_components/battles-section';
import PrBoostSection from './_components/pr-boost-section';
import DailyPointsSection from './_components/daily-points-section';
import OperatorsSection from './_components/operators-section';
import SplitterSection from './_components/splitter-section';
import SessionExplorer from './_components/session-explorer';
import TokenVoidSection from './_components/token-void-section';
import RewardEligibilityRegistrySection from './_components/reward-eligibility-registry-section';

// adminOnly tabs manage platform-wide infra (deploy/upgrade contracts, register
// operators, create reward types) — every write call they make is
// onlyRole(DEFAULT_ADMIN_ROLE) on-chain, so a pure operator wallet can't use them
// anyway. Hidden for 'operator' role; still shown for 'admin' / 'admin+operator'.
const TABS = [
  { id: 'deploy', label: 'Deploy', icon: <Wallet className="w-4 h-4" />, adminOnly: true },
  { id: 'hub', label: 'Hub', icon: <Network className="w-4 h-4" />, adminOnly: true },
  { id: 'tokens', label: 'Points', icon: <Coins className="w-4 h-4" />, adminOnly: false },
  { id: 'admin', label: 'Admin', icon: <Shield className="w-4 h-4" />, adminOnly: true },
  { id: 'operators', label: 'Operators', icon: <Users className="w-4 h-4" />, adminOnly: false },
  { id: 'sessions', label: 'Sessions', icon: <Gamepad2 className="w-4 h-4" />, adminOnly: false },
  { id: 'matches', label: 'Matches', icon: <Swords className="w-4 h-4" />, adminOnly: false },
  { id: 'explorer', label: 'Explorer', icon: <Search className="w-4 h-4" />, adminOnly: false },
  { id: 'daily-points', label: 'Daily Points', icon: <DollarSign className="w-4 h-4" />, adminOnly: false },
  { id: 'boost', label: 'PR Boost', icon: <Zap className="w-4 h-4" />, adminOnly: false },
  { id: 'splitter', label: 'Splitter', icon: <Split className="w-4 h-4" />, adminOnly: false },
  { id: 'void', label: 'Void', icon: <Flame className="w-4 h-4" />, adminOnly: false },
  // Not gated by GameHub walletRole — this is a standalone contract with its own
  // owner/operator permission model, enforced on-chain and reflected in the tab's own UI.
  { id: 'reward-eligibility-registry', label: 'Reward Eligibility Registry', icon: <IdCard className="w-4 h-4" />, adminOnly: false },
] as const;

const OPERATOR_DEFAULT_TAB = 'sessions';

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<string>('deploy');
  const { isConnected, hubAddress, walletRole, roleLoading, operatorName, operatorInstance, sessionManagerAddress } = useWeb3();

  // Pure operator (not also admin): admin-only tabs are hidden since every write call
  // they make would revert on-chain (onlyRole(DEFAULT_ADMIN_ROLE)) for this wallet anyway.
  const isPureOperator = walletRole === 'operator';
  const visibleTabs = isPureOperator ? TABS.filter(t => !t.adminOnly) : TABS;

  // If role resolves to pure-operator while an admin-only tab is active (e.g. the
  // default landing tab, or a leftover selection from a prior admin session), bounce
  // to a tab they can actually use.
  useEffect(() => {
    if (isPureOperator) {
      const stillVisible = visibleTabs.some(t => t.id === activeTab);
      if (!stillVisible) setActiveTab(OPERATOR_DEFAULT_TAB);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPureOperator, activeTab]);

  return (
    <div className="space-y-6">
      <div className="text-center mb-2">
        <h1 className="text-2xl font-bold">Daily PR Boost <span className="text-accent">Manager</span></h1>
        <p className="text-txt-secondary text-sm mt-1">Deploy and interact with smart contracts on BNB Testnet</p>
      </div>

      {/* Wallet role — who you're connected as, checked against the loaded hub */}
      {isConnected && hubAddress && (
        <div className="bg-surface-secondary border border-white/10 rounded-xl p-3 flex items-center gap-3">
          {roleLoading ? (
            <>
              <Loader2 className="w-4 h-4 text-txt-secondary animate-spin shrink-0" />
              <p className="text-txt-secondary text-xs">Checking wallet role against the hub...</p>
            </>
          ) : walletRole === 'admin' ? (
            <>
              <Shield className="w-5 h-5 text-yellow-400 shrink-0" />
              <p className="text-yellow-300 text-sm font-medium">Logged in as Platform Admin</p>
            </>
          ) : walletRole === 'operator' ? (
            <>
              <Gamepad2 className="w-5 h-5 text-accent shrink-0" />
              <div>
                <p className="text-accent text-sm font-medium">Logged in as Operator: {operatorName}</p>
                {sessionManagerAddress?.toLowerCase() === operatorInstance?.toLowerCase() && (
                  <p className="text-txt-secondary text-xs mt-0.5">Dashboard automatically set to your instance ({operatorInstance.slice(0, 6)}…{operatorInstance.slice(-4)}).</p>
                )}
              </div>
            </>
          ) : walletRole === 'admin+operator' ? (
            <>
              <Shield className="w-5 h-5 text-yellow-400 shrink-0" />
              <div>
                <p className="text-yellow-300 text-sm font-medium">Logged in as Platform Admin &amp; Operator: {operatorName}</p>
                {sessionManagerAddress?.toLowerCase() === operatorInstance?.toLowerCase() && (
                  <p className="text-txt-secondary text-xs mt-0.5">Dashboard automatically set to your instance ({operatorInstance.slice(0, 6)}…{operatorInstance.slice(-4)}).</p>
                )}
              </div>
            </>
          ) : (
            <>
              <HelpCircle className="w-5 h-5 text-txt-secondary shrink-0" />
              <p className="text-txt-secondary text-xs">Connected wallet is not the platform admin or a registered operator on this hub.</p>
            </>
          )}
        </div>
      )}

      {isPureOperator && (
        <div className="bg-accent/10 border border-accent/30 rounded-lg px-3 py-2 text-xs text-accent">
          Showing operator tools only. Platform admin tabs (Deploy, Hub, Admin) are hidden because this wallet isn&apos;t the platform admin — those actions would revert on-chain anyway.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto scrollbar-hide bg-surface-secondary rounded-xl p-1.5">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              activeTab === tab.id
                ? 'bg-accent text-black shadow-md'
                : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-tertiary'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'deploy' && !isPureOperator && <DeploySection />}
        {activeTab === 'hub' && !isPureOperator && <HubSection />}
        {activeTab === 'tokens' && <TokenSection />}
        {activeTab === 'admin' && !isPureOperator && <AdminSection />}
        {activeTab === 'operators' && <OperatorsSection />}
        {activeTab === 'sessions' && <GamesSection />}
        {activeTab === 'matches' && <BattlesSection />}
        {activeTab === 'explorer' && <SessionExplorer />}
        {activeTab === 'daily-points' && <DailyPointsSection />}
        {activeTab === 'boost' && <PrBoostSection />}
        {activeTab === 'splitter' && <SplitterSection />}
        {activeTab === 'void' && <TokenVoidSection />}
        {activeTab === 'reward-eligibility-registry' && <RewardEligibilityRegistrySection />}
      </div>
    </div>
  );
}
