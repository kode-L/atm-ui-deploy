import chainDefaults from './chain.json';

type ChainDefaults = {
  chainName?: string;
  tokenAddress?: string;
  hubAddress?: string;
  sessionManagerAddress?: string;
  tokenVoidAddress?: string;
  adminAddress?: string;
  voidOwnerAddress?: string;
  rewardEligibilityRegistryAddress?: string;
};

// Per-chainId default contract addresses (keyed by chainId as a string, e.g. "97", "56").
// This is the checked-in manifest to edit after deploying to a chain — env vars below still
// take precedence over it, so a local .env can override a single address without touching it.
const CHAIN_DEFAULTS = chainDefaults as Record<string, ChainDefaults>;
const chainDefault = (chainId: number, key: keyof ChainDefaults) => CHAIN_DEFAULTS[String(chainId)]?.[key] || '';

// Multiple endpoints per network so read calls (used app-wide via the fallback provider in
// rpc-provider.ts) race across all of them instead of depending on one single public RPC —
// index [0] is also what gets passed to wallet_addEthereumChain when a wallet needs to add
// the network, so keep a well-known official endpoint first.
export const BNB_TESTNET = {
  chainId: 97,
  chainIdHex: '0x61',
  chainName: 'BNB Smart Chain Testnet',
  rpcUrls: [
    'https://data-seed-prebsc-1-s1.binance.org:8545/',
    'https://data-seed-prebsc-2-s1.binance.org:8545/',
    'https://data-seed-prebsc-1-s2.binance.org:8545/',
    'https://bsc-testnet.publicnode.com',
  ],
  blockExplorerUrls: ['https://testnet.bscscan.com'],
  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
};

export const BSC_MAINNET = {
  chainId: 56,
  chainIdHex: '0x38',
  chainName: 'BNB Smart Chain',
  rpcUrls: [
    'https://bsc-dataseed.binance.org/',
    'https://bsc-dataseed1.defibit.io/',
    'https://bsc-dataseed1.ninicoin.io/',
    // rpc.ankr.com/bsc used to be a free public endpoint here, but now requires an API key
    // and returns "-32000 Unauthorized" for every call. Since the read fallback provider
    // (rpc-provider.ts) races all listed URLs, one broken endpoint intermittently surfaces
    // as spurious per-field failures (e.g. "missing revert data in call exception" on one
    // read while a sibling read on the same contract succeeds) rather than a clean, obvious
    // error — swapped for a no-key public endpoint instead.
    'https://bsc.publicnode.com',
  ],
  blockExplorerUrls: ['https://bscscan.com'],
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
};

// Deployed contract addresses (BNB Smart Chain Testnet). Falls back to chain.json's "97"
// entry, overridden by the env var if set.
export const DEFAULT_SESSION_MANAGER_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'sessionManagerAddress');
export const DEFAULT_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'tokenAddress');
// GameHub proxy — platform registry/factory. Set after deploying the hub stack from the Deploy tab.
export const DEFAULT_HUB_ADDRESS = process.env.NEXT_PUBLIC_HUB_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'hubAddress');
// Void — burns points sent to it straight to the dead address. Set after deploying from the Void tab.
export const DEFAULT_TOKEN_VOID_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_VOID_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'tokenVoidAddress');
// Pre-fills the Admin Address field on the Deploy tab's GameHub form for first deployment.
// Not an on-chain source of truth — the actual admin is whatever address GameHub.initialize() was called with.
export const DEFAULT_ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'adminAddress');

// Optional fallback recognized as the Void contract owner in the UI (token-void-section.tsx's
// isOwner check), in addition to whatever the live owner() call returns. Useful if the on-chain
// owner hasn't loaded yet or you want a designated wallet to always see owner-only controls.
export const DEFAULT_VOID_OWNER_ADDRESS = process.env.NEXT_PUBLIC_VOID_OWNER_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'voidOwnerAddress');

// RewardEligibilityRegistry proxy — standalone player/type registry, unrelated to the GameHub
// fleet. Set after deploying from the Reward Eligibility Registry tab.
export const DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_REWARD_ELIGIBILITY_REGISTRY_ADDRESS || chainDefault(BNB_TESTNET.chainId, 'rewardEligibilityRegistryAddress');

// Same set of defaults, but for BSC Mainnet — deployments are independent per network,
// so mainnet gets its own fallbacks (chain.json's "56" entry, env var still wins) alongside
// the testnet ones above.
export const DEFAULT_TOKEN_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_TOKEN_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'tokenAddress');
export const DEFAULT_HUB_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_HUB_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'hubAddress');
// Mirrors DEFAULT_SESSION_MANAGER_ADDRESS (testnet) — no env var, chain.json only, same as testnet's.
export const DEFAULT_SESSION_MANAGER_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'sessionManagerAddress');
export const DEFAULT_TOKEN_VOID_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_TOKEN_VOID_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'tokenVoidAddress');
export const DEFAULT_ADMIN_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_ADMIN_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'adminAddress');
export const DEFAULT_VOID_OWNER_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_VOID_OWNER_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'voidOwnerAddress');
export const DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET = process.env.NEXT_PUBLIC_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET || chainDefault(BSC_MAINNET.chainId, 'rewardEligibilityRegistryAddress');

export type NetworkKey = 'testnet' | 'mainnet';

// Per-network localStorage key, e.g. "dg_tokenAddress:97" — testnet and mainnet
// deployments are unrelated contracts, so their addresses must never mix.
export const networkStorageKey = (base: string, chainId: number) => `${base}:${chainId}`;

// Keyed by chainId so components can look up the right network purely from the
// connected wallet's chainId (no separate "selected network" state to keep in sync).
export const NETWORKS: Record<number, typeof BNB_TESTNET | typeof BSC_MAINNET> = {
  [BNB_TESTNET.chainId]: BNB_TESTNET,
  [BSC_MAINNET.chainId]: BSC_MAINNET,
};

// Falls back to the testnet explorer for an unrecognized/disconnected (0) chainId, matching
// the app's pre-connection default.
export const getExplorerAddressUrl = (chainId: number, address: string) =>
  `${(NETWORKS[chainId] || BNB_TESTNET).blockExplorerUrls[0]}/address/${address}`;

export const getExplorerTxUrl = (chainId: number, hash: string) =>
  `${(NETWORKS[chainId] || BNB_TESTNET).blockExplorerUrls[0]}/tx/${hash}`;

// Matches DailySessionManager.SessionStatus enum
export const SESSION_STATUS_LABELS: Record<number, string> = {
  0: 'CREATED',
  1: 'ACTIVE',
  2: 'ENDED',
  3: 'CANCELLED',
};

// Matches DailySessionManager.MatchStatus enum
export const MATCH_STATUS_LABELS: Record<number, string> = {
  0: 'CREATED',
  1: 'SETTLED',
  2: 'CANCELLED',
};

// Matches RewardEligibilityRegistry.ProposalType enum
export const REWARD_ELIGIBILITY_REGISTRY_PROPOSAL_TYPE_LABELS: Record<number, string> = {
  0: 'Wallet Type Change',
  1: 'Type Config',
};

// Role hashes (keccak256)
export const ROLES = {
  DEFAULT_ADMIN: '0x0000000000000000000000000000000000000000000000000000000000000000',
  SESSION_OPERATOR: '0x31df88ddf9a414f836ac658da56c3aeddd70c989e9b49be4778df156cdf36f46',
  PLATFORM_UPDATER: '0xb58d5b41fc8d502d82b6e13b07ad5a883760eca56d27dd0d61794831de8c2bab',
};
