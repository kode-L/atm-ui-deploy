// Which contracts each dashboard section works with - feeds the Overview at the top of every
// section (on-chain version + implementation per contract). Addresses are resolved exactly the way
// each section resolves them (shared web3 state, the section's own saved address, chain.json).
// RULE: a new section or contract must be added here so its on-chain version is always visible.
import { OverviewItem } from '@/components/contract-overview';
import {
  BSC_MAINNET, networkStorageKey, validAddr, chainTokenVoids, registryName,
  DEFAULT_TOKEN_VOID_ADDRESS, DEFAULT_TOKEN_VOID_ADDRESS_MAINNET, DEFAULT_ATM_VOID_ADDRESS, DEFAULT_ATM_VOID_ADDRESS_MAINNET,
} from '@/lib/contracts/config';
import { loadBook } from '@/lib/contracts/voucher-v2';
import { LINK_ADDRESSES } from '@/lib/contracts/link';
import { loadVoucherAdapterAddress } from '@/app/dashboard/_components/voucher-adapter-card';

export interface SectionCtx {
  chainId: number;
  tokenAddress: string;
  hubAddress: string;
  sessionManagerAddress: string;
  rewardEligibilityRegistryAddress: string;
  atmVoucherAddress: string;
  contributionPoolAddress: string;
  rgstAddress: string;
  activeSplitter: string;
}

const saved = (base: string, chainId: number) => {
  try { return validAddr(localStorage.getItem(networkStorageKey(base, chainId))); } catch { return ''; }
};

export function sectionContracts(tab: string, c: SectionCtx): OverviewItem[] {
  const isMainnet = c.chainId === BSC_MAINNET.chainId;
  const ns = isMainnet ? BSC_MAINNET.chainId : 97;
  const hub = { label: 'GameHub', address: c.hubAddress };
  const token = { label: 'Payment token (LUCA)', address: c.tokenAddress };
  const adapter = { label: 'VoucherAdapter', address: loadVoucherAdapterAddress(ns) };

  switch (tab) {
    case 'deploy':
      return [hub, adapter];
    case 'hub':
      return [hub, adapter,
        { label: 'Reward Eligibility Registry', address: c.rewardEligibilityRegistryAddress },
        { label: 'ATM Voucher', address: c.atmVoucherAddress }];
    case 'tokens':
    case 'admin':
    case 'operators':
    case 'sessions':
    case 'matches':
    case 'explorer':
    case 'daily-points':
    case 'boost':
      return [hub, token];
    case 'splitter':
      return [{ label: 'PaymentSplitter (selected)', address: c.activeSplitter }, hub];
    case 'void': {
      const selected = saved('dg_tokenVoidAddress', ns) || (isMainnet ? DEFAULT_TOKEN_VOID_ADDRESS_MAINNET : DEFAULT_TOKEN_VOID_ADDRESS);
      const known = chainTokenVoids(ns);
      const items = known.map(v => ({ label: v.label + (v.address.toLowerCase() === selected.toLowerCase() ? ' (selected)' : ''), address: v.address }));
      if (selected && !known.some(v => v.address.toLowerCase() === selected.toLowerCase())) items.unshift({ label: 'Void (selected)', address: selected });
      return items;
    }
    case 'atm-void':
      return [{ label: 'ATM Void', address: saved('dg_atmVoidAddress', ns) || (isMainnet ? DEFAULT_ATM_VOID_ADDRESS_MAINNET : DEFAULT_ATM_VOID_ADDRESS) }];
    case 'reward-eligibility-registry':
      return [{ label: registryName(c.chainId, c.rewardEligibilityRegistryAddress) || 'Reward Eligibility Registry', address: c.rewardEligibilityRegistryAddress }, hub];
    case 'atm-vouchers':
      return [{ label: 'ATM Voucher', address: c.atmVoucherAddress }, hub];
    case 'voucher-v2': {
      // the Voucher V2 tab has its own Overview (contracts + pools + tokens + chain.json check)
      return [];
    }
    case 'contribution-pool':
      return [{ label: 'Contribution Pool', address: c.contributionPoolAddress }];
    case 'rgst':
      return [{ label: 'RGST', address: c.rgstAddress }];
    case 'link': {
      const l = LINK_ADDRESSES[ns];
      return l ? [{ label: 'Link Factory', address: l.factory }, { label: 'File', address: l.file }, { label: 'Trader', address: l.trader },
        { label: 'LUCA', address: l.luca }, { label: 'Link template', address: l.linkTemplate }] : [];
    }
    default:
      return [];
  }
}

/** Voucher V2 contracts known for this network: the tab's address book, else chain.json. */
export function voucherV2Known(chainId: number): Record<string, string> {
  const book = loadBook(chainId).contracts as Record<string, string>;
  return { ...book };
}
