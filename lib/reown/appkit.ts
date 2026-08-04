'use client';
import { createAppKit } from '@reown/appkit/react';
import { Ethers5Adapter } from '@reown/appkit-adapter-ethers5';
import { defineChain } from '@reown/appkit/networks';
import { BNB_TESTNET, BSC_MAINNET } from '@/lib/contracts/config';

// Mirrors BNB_TESTNET from lib/contracts/config.ts so AppKit and the rest of
// the app (MetaMask add/switch-chain calls) agree on the same RPC/explorer.
export const bscTestnet = defineChain({
  id: BNB_TESTNET.chainId,
  caipNetworkId: `eip155:${BNB_TESTNET.chainId}`,
  chainNamespace: 'eip155',
  name: BNB_TESTNET.chainName,
  nativeCurrency: BNB_TESTNET.nativeCurrency,
  rpcUrls: {
    default: { http: BNB_TESTNET.rpcUrls },
  },
  blockExplorers: {
    default: { name: 'BscScan Testnet', url: BNB_TESTNET.blockExplorerUrls[0] },
  },
  testnet: true,
});

// Mirrors BSC_MAINNET from lib/contracts/config.ts. Registering it alongside bscTestnet
// below is what lets AppKit's own connect/account modal offer a network switcher between
// the two — no custom in-app toggle needed.
export const bscMainnet = defineChain({
  id: BSC_MAINNET.chainId,
  caipNetworkId: `eip155:${BSC_MAINNET.chainId}`,
  chainNamespace: 'eip155',
  name: BSC_MAINNET.chainName,
  nativeCurrency: BSC_MAINNET.nativeCurrency,
  rpcUrls: {
    default: { http: BSC_MAINNET.rpcUrls },
  },
  blockExplorers: {
    default: { name: 'BscScan', url: BSC_MAINNET.blockExplorerUrls[0] },
  },
  testnet: false,
});

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

if (!projectId) {
  throw new Error(
    'NEXT_PUBLIC_REOWN_PROJECT_ID is not set. Get a project ID at https://cloud.reown.com and add it to nextjs_space/.env'
  );
}

createAppKit({
  adapters: [new Ethers5Adapter()],
  networks: [bscTestnet, bscMainnet],
  defaultNetwork: bscTestnet,
  projectId,
  metadata: {
    name: 'Daily PR Boost Manager',
    description: 'Interact with Daily PR Boost Manager on BNB Smart Chain (Testnet or Mainnet)',
    url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
    icons: ['/favicon.svg'],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
});
