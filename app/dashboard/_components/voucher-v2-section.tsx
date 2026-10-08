'use client';
import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { NETWORKS } from '@/lib/contracts/config';
import { DEFAULT_ADMIN_ROLE } from '@/lib/contracts/voucher-v2';
import Card from '@/components/card';
import { VoucherV2Provider, useVoucherV2 } from './voucher-v2/context';
import OverviewTab from './voucher-v2/overview-tab';
import DeployTab from './voucher-v2/deploy-tab';
import WireTab from './voucher-v2/wire-tab';
import TypesTab from './voucher-v2/types-tab';
import RolesTab from './voucher-v2/roles-tab';
import TxLogCard from './voucher-v2/tx-log';
import FundingTab from './voucher-v2/funding-tab';
import DaoTab from './voucher-v2/dao-tab';
import ReleaseExpiredCard from './voucher-v2/release-card';
import VouchersCard from './voucher-v2/vouchers-card';
import ExtraSinksCard from './voucher-v2/extra-sinks-card';
import AllowlistsCard, { RegistryAccessCard } from './voucher-v2/allowlists-card';
import PoolsCard from './voucher-v2/pools-card';

// Step-by-step deploy + configuration of the on-chain voucher system from the voucher repo
// (VoucherNFT, VoucherDAO, sinks, registry). Separate from the "ATM Vouchers"
// tab, which manages the older standalone ATMVoucher contract.
// Setup = overview + deploying; Contracts = one tab per contract, holding every call made to it.
const SUB_TABS = [
  { id: 'overview', label: 'Overview', group: 'Setup' },
  { id: 'deploy', label: 'Deploy', group: 'Setup' },
  { id: 'nft', label: 'VoucherNFT', group: 'Contracts' },
  { id: 'dao', label: 'VoucherDAO', group: 'Contracts' },
  { id: 'registry', label: 'SourceRegistry', group: 'Contracts' },
  { id: 'pools', label: 'Pools', group: 'Contracts' },
] as const;
const GROUPS = ['Setup', 'Contracts'] as const;
// links from older places (health check, checklist, buttons) still use the old tab names
const TAB_ALIAS: Record<string, string> = { wire: 'nft', types: 'nft', roles: 'nft', funding: 'pools' };

export type SubTabId = (typeof SUB_TABS)[number]['id'];
const SUB_TAB_KEY = 'dg_voucherV2SubTab';

export default function VoucherV2Section() {
  return (
    <VoucherV2Provider>
      <VoucherV2Inner />
    </VoucherV2Provider>
  );
}

// each contract tab stacks its cards in one column
const TWO_COL = 'space-y-4';
const COL = 'space-y-4';

function VoucherV2Inner() {
  const { isConnected, connect } = useWeb3();
  const ctx = useVoucherV2();
  const [tab, setTab] = useState<SubTabId>('overview');
  const [admin, setAdmin] = useState<'yes' | 'no' | 'unknown' | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SUB_TAB_KEY);
      const mapped = saved ? TAB_ALIAS[saved] || saved : '';
      if (mapped && SUB_TABS.some((t) => t.id === mapped)) setTab(mapped as SubTabId);
    } catch {
      // storage unavailable — stay on overview
    }
  }, []);

  const go = (raw: string) => {
    const id = TAB_ALIAS[raw] || raw;
    setTab(id as SubTabId);
    try {
      localStorage.setItem(SUB_TAB_KEY, id);
    } catch {
      // ignore
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const nft = ctx.book.contracts.VoucherNFT;
  useEffect(() => {
    let cancelled = false;
    setAdmin(null);
    if (!nft || !ctx.account || !ctx.reader) return;
    ctx.read('VoucherNFT').hasRole(DEFAULT_ADMIN_ROLE, ctx.account)
      .then((ok: boolean) => !cancelled && setAdmin(ok ? 'yes' : 'no'))
      .catch(() => !cancelled && setAdmin('unknown'));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nft, ctx.account, ctx.reader, ctx.revision]);

  const network = NETWORKS[ctx.chainId];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Voucher V2</h2>
            <p className="text-sm text-txt-secondary mt-1 max-w-2xl">
              <b>Setup</b>: see the status and deploy. <b>Contracts</b>: one tab per contract — everything you can call on it is there. Every screen reads the chain live.
            </p>
          </div>
          <div className="text-xs space-y-1">
            <div className="text-txt-secondary">
              Network: <span className="text-txt-primary">{network?.chainName || `chain ${ctx.chainId}`}</span>
            </div>
            {admin === 'yes' && <div className="flex items-center gap-1 text-green-300"><ShieldCheck className="w-3.5 h-3.5" /> Wallet is VoucherNFT admin</div>}
            {admin === 'no' && <div className="flex items-center gap-1 text-yellow-300"><ShieldAlert className="w-3.5 h-3.5" /> Wallet is NOT VoucherNFT admin — config txs will revert</div>}
            {admin === 'unknown' && <div className="text-yellow-300">Could not read VoucherNFT on this network</div>}
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface-secondary rounded-xl p-1.5">
        {GROUPS.map((g) => (
          <div key={g} className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            <span className="text-[10px] uppercase tracking-wider text-txt-secondary px-2">{g}</span>
            {SUB_TABS.filter((t) => t.group === g).map((t) => (
              <button
                key={t.id}
                onClick={() => go(t.id)}
                className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  tab === t.id ? 'bg-accent text-black shadow-md' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-tertiary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {!isConnected ? (
        <Card>
          <div className="text-center py-8 space-y-3">
            <p className="text-sm text-txt-secondary">Connect the wallet that will own (admin) the voucher contracts to begin.</p>
            <button onClick={connect} className="bg-accent hover:bg-accent-dark text-black font-semibold px-5 py-2 rounded-lg text-sm">Connect wallet</button>
          </div>
        </Card>
      ) : (
        <>
          {tab === 'overview' && <OverviewTab onGo={go} />}
          {tab === 'deploy' && <DeployTab onGo={go} />}
          {tab === 'nft' && (
            <div className={TWO_COL}>
              <WireTab onGo={go} target="VoucherNFT" />
              <TypesTab onGo={go} />
              <RolesTab onGo={go} part="nft" />
              <VouchersCard />
              <ReleaseExpiredCard />
            </div>
          )}
          {tab === 'dao' && (
            <div className={TWO_COL}>
              <div className={COL}><DaoTab onGo={go} /></div>
              <div className={COL}><RolesTab onGo={go} part="dao" /></div>
            </div>
          )}
          {tab === 'registry' && (
            <div className={TWO_COL}>
              <div className={COL}><AllowlistsCard /></div>
              <div className={COL}>
                <RegistryAccessCard />
                <PoolsCard only="registry" />
              </div>
            </div>
          )}
          {tab === 'pools' && (
            <div className={TWO_COL}>
              <div className={COL}>
                <ExtraSinksCard admin={ctx.account} onGo={go} mode="deploy" />
                <div id="pool-settings"><PoolsCard only="pools" /></div>
              </div>
              <div className={COL}><FundingTab onGo={go} /></div>
            </div>
          )}
        </>
      )}

      {ctx.txLog.length > 0 && <TxLogCard />}
    </div>
  );
}
