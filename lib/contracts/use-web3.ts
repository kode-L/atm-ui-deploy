'use client';
import { createContext, useContext } from 'react';
import { ethers } from 'ethers';

// Detected by checking the connected wallet against the hub's adminWallet and
// operator registry. 'admin' and 'operator' are not mutually exclusive on-chain
// (the same wallet can be both), hence 'admin+operator'.
export type WalletRole = 'admin' | 'operator' | 'admin+operator' | 'unknown';

export interface Web3State {
  // Read-only calls throughout the app use this — it's the multi-RPC fallback provider
  // (lib/contracts/rpc-provider.ts), not the wallet's own connection, so reads stay fast and
  // don't depend on whichever single RPC the connected wallet happens to use. Writes always
  // go through `signer` instead, which is tied to the actual wallet.
  provider: ethers.providers.Provider | null;
  signer: ethers.Signer | null;
  address: string;
  chainId: number;
  bnbBalance: string;
  isConnected: boolean;
  connecting: boolean;
  // True once Reown AppKit has finished restoring any existing session, so
  // consumers can avoid flashing a "disconnected" UI before it settles.
  initialized: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  // Opens Reown AppKit's own network-picker view so the user can switch between every
  // registered network (BNB Testnet / BSC Mainnet) themselves, rather than the app
  // forcing one specific chain.
  openNetworkPicker: () => Promise<void>;
  tokenAddress: string;
  hubAddress: string;
  sessionManagerAddress: string;
  rewardEligibilityRegistryAddress: string;
  atmVoucherAddress: string;
  splitters: { address: string; label: string }[];
  activeSplitter: string;
  setTokenAddress: (a: string) => void;
  // Clears the saved localStorage override for this network and re-pulls the
  // .env/chain.json default — otherwise a saved value wins over .env forever (see providers.tsx).
  resetTokenAddress: () => void;
  setHubAddress: (a: string) => void;
  setSessionManagerAddress: (a: string) => void;
  setRewardEligibilityRegistryAddress: (a: string) => void;
  setAtmVoucherAddress: (a: string) => void;
  addSplitter: (address: string, label: string) => void;
  removeSplitter: (address: string) => void;
  setActiveSplitter: (address: string) => void;
  walletRole: WalletRole | null; // null = not yet checked (no hub loaded, or still loading)
  roleLoading: boolean;
  operatorName: string;
  operatorInstance: string;
}

export const Web3Context = createContext<Web3State>({
  provider: null,
  signer: null,
  address: '',
  chainId: 0,
  bnbBalance: '0',
  isConnected: false,
  connecting: false,
  initialized: false,
  connect: async () => {},
  disconnect: () => {},
  openNetworkPicker: async () => {},
  tokenAddress: '',
  hubAddress: '',
  sessionManagerAddress: '',
  rewardEligibilityRegistryAddress: '',
  atmVoucherAddress: '',
  splitters: [],
  activeSplitter: '',
  setTokenAddress: () => {},
  resetTokenAddress: () => {},
  setHubAddress: () => {},
  setSessionManagerAddress: () => {},
  setRewardEligibilityRegistryAddress: () => {},
  setAtmVoucherAddress: () => {},
  addSplitter: () => {},
  removeSplitter: () => {},
  setActiveSplitter: () => {},
  walletRole: null,
  roleLoading: false,
  operatorName: '',
  operatorInstance: '',
});

export const useWeb3 = () => useContext(Web3Context);
