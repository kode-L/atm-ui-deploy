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
  atmVoucherAddress?: string;
  contributionPoolAddress?: string;
  rgstAddress?: string;
  atmVoidAddress?: string;
  // VoucherAdapter: deploy-form defaults (senator / signatures = the legacy Incentive contract's on
  // this chain) and, once deployed, its address (the GameHub tab also finds it on-chain)
  voucherNftAddress?: string;
  senatorAddress?: string;
  signNum?: number;
  voucherAdapterAddress?: string;
  // LUCA-LP burner (the "Luca Void" tab manages tokenVoidAddress, which burns LUCA itself)
  lucaVoidLpAddress?: string;
  // operators' PaymentSplitters, name -> address (stable - always listed in the Splitter tab)
  splitters?: Record<string, string>;
  // RGST Registor (the RGST registration contract, not the token - rgstAddress is the RGST token)
  rgstRegistorAddress?: string;
  // one DailySessionManager per operator: name -> { dsm contract, operator wallet }
  // (shown instantly, then checked against GameHub on-chain)
  operators?: Record<string, { dsm: string; operator: string }>;
  // Reward Eligibility Registry operators (propose/approve types), name -> address; checked on-chain on load
  registryOperators?: Record<string, string>;
  // TokenVoid contracts on this chain, name -> address (Luca Void tab dropdown)
  tokenVoids?: Record<string, string>;
  // Voucher V2 set on this chain (checked live by Voucher V2 -> Overview -> On-chain set)
  voucherV2?: VoucherV2Chain;
};

// addresses only - types, tokens and versions are always read live from the chain
export interface VoucherV2Chain {
  contracts: Record<string, string>; // contract name -> address
  pools: Record<string, string>; // pool name -> address
}

// Per-chainId production addresses (keyed by chainId as a string, e.g. "97", "56"). This
// checked-in manifest is the source of truth - edit it after deploying to a chain. A .env value
// is only a fallback for a field chain.json leaves empty (and must be a real address).
const CHAIN_DEFAULTS = chainDefaults as Record<string, ChainDefaults>;
const chainDefault = (chainId: number, key: keyof ChainDefaults): string => {
  const v = CHAIN_DEFAULTS[String(chainId)]?.[key];
  return v === undefined || v === null || typeof v === 'object' ? '' : String(v);
};

/** A real 0x address, else ''. Placeholder text in .env (e.g. "your_gamehub_address_here") or a
 *  corrupted saved value must never override the per-chain production defaults in chain.json. */
export const validAddr = (v?: string | null): string => (v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? v.trim() : '');

/** chain.json's operator DSMs for this chain, as { name, dsm, operator }. */
export const chainOperators = (chainId: number): { name: string; dsm: string; operator: string }[] =>
  Object.entries(CHAIN_DEFAULTS[String(chainId)]?.operators || {})
    .filter(([, o]) => o && validAddr(o.dsm) && validAddr(o.operator))
    .map(([name, o]) => ({ name, dsm: o.dsm, operator: o.operator }));

/** chain.json's Reward Eligibility Registry operators for this chain, as { name, address }. */
export const chainRegistryOperators = (chainId: number): { name: string; address: string }[] =>
  Object.entries(CHAIN_DEFAULTS[String(chainId)]?.registryOperators || {})
    .filter(([, address]) => validAddr(address))
    .map(([name, address]) => ({ name, address }));

/** chain.json's TokenVoid contracts for this chain, as { label, address } (Luca Void tab dropdown). */
export const chainTokenVoids = (chainId: number): { label: string; address: string }[] =>
  Object.entries(CHAIN_DEFAULTS[String(chainId)]?.tokenVoids || {})
    .filter(([, address]) => validAddr(address))
    .map(([label, address]) => ({ label, address }));

/** chain.json's Voucher V2 set for this chain (empty if none). */
export const chainVoucherV2 = (chainId: number): VoucherV2Chain => {
  const v = CHAIN_DEFAULTS[String(chainId)]?.voucherV2;
  return { contracts: { ...(v?.contracts || {}) }, pools: { ...(v?.pools || {}) } };
};

/** chain.json's PaymentSplitters for this chain (operators' splitters - they don't change). */
export const chainSplitters = (chainId: number): { address: string; label: string }[] =>
  Object.entries(CHAIN_DEFAULTS[String(chainId)]?.splitters || {})
    .filter(([, address]) => validAddr(address))
    .map(([name, address]) => ({ address, label: `${name} Splitter` }));

/** A chain.json address for this chain ('' if unset or not a real address). */
export const chainAddress = (chainId: number, key: keyof ChainDefaults): string => validAddr(chainDefault(chainId, key));

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
export const DEFAULT_TOKEN_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'tokenAddress') || validAddr(process.env.NEXT_PUBLIC_TOKEN_ADDRESS);
// GameHub proxy — platform registry/factory. Set after deploying the hub stack from the Deploy tab.
export const DEFAULT_HUB_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'hubAddress') || validAddr(process.env.NEXT_PUBLIC_HUB_ADDRESS);
// Void — burns points sent to it straight to the dead address. Set after deploying from the Void tab.
export const DEFAULT_TOKEN_VOID_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'tokenVoidAddress') || validAddr(process.env.NEXT_PUBLIC_TOKEN_VOID_ADDRESS);
// Pre-fills the Admin Address field on the Deploy tab's GameHub form for first deployment.
// Not an on-chain source of truth — the actual admin is whatever address GameHub.initialize() was called with.
export const DEFAULT_ADMIN_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'adminAddress') || validAddr(process.env.NEXT_PUBLIC_ADMIN_ADDRESS);

// Optional fallback recognized as the Void contract owner in the UI (token-void-section.tsx's
// isOwner check), in addition to whatever the live owner() call returns. Useful if the on-chain
// owner hasn't loaded yet or you want a designated wallet to always see owner-only controls.
export const DEFAULT_VOID_OWNER_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'voidOwnerAddress') || validAddr(process.env.NEXT_PUBLIC_VOID_OWNER_ADDRESS);

// RewardEligibilityRegistry proxy — standalone player/type registry, unrelated to the GameHub
// fleet. Set after deploying from the Reward Eligibility Registry tab.
export const DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'rewardEligibilityRegistryAddress') || validAddr(process.env.NEXT_PUBLIC_REWARD_ELIGIBILITY_REGISTRY_ADDRESS);

// ATMVoucher proxy — standalone ERC-721 voucher contract, unrelated to the GameHub fleet
// (though GameHub can optionally point at one via setATMVoucher). Set after deploying
// from the ATM Vouchers tab.
export const DEFAULT_ATM_VOUCHER_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'atmVoucherAddress') || validAddr(process.env.NEXT_PUBLIC_ATM_VOUCHER_ADDRESS);

// ContributionPool proxy — standalone pooled-contribution contract with its own admin/operator
// role model, unrelated to the GameHub fleet. Set after deploying from the Contribution Pool tab.
export const DEFAULT_CONTRIBUTION_POOL_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'contributionPoolAddress') || validAddr(process.env.NEXT_PUBLIC_CONTRIBUTION_POOL_ADDRESS);

// RGST proxy — standalone rebasing ERC20 with its own owner/minter/rebaser/receiver roles and a
// timelocked proxy admin, unrelated to the GameHub fleet. Set after deploying from the RGST Token tab.
export const DEFAULT_RGST_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'rgstAddress') || validAddr(process.env.NEXT_PUBLIC_RGST_ADDRESS);

// Senator (PR-node multisig) the VoucherAdapter verifies signed points transfers against: the same
// one the legacy Incentive contract uses on each chain (Incentive.senator()), i.e. pagerank-service's
// SENATOR_ADDRESS, so the PR nodes that already sign there are the ones the adapter accepts.
export const DEFAULT_SENATOR_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'senatorAddress');
export const DEFAULT_SENATOR_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'senatorAddress');
// Required PR-node signatures for signed points transfers - same as the legacy Incentive contract on
// each chain (Incentive.signNum(); 0 there means its built-in default of 18).
export const DEFAULT_SIGN_NUM = Number(chainDefault(BNB_TESTNET.chainId, 'signNum')) || 1;
export const DEFAULT_SIGN_NUM_MAINNET = Number(chainDefault(BSC_MAINNET.chainId, 'signNum')) || 1;

// Deployed Voucher V2 VoucherNFT per chain (atm-smart-contract ProductionAddress.md / TestnetAddress.md) —
// pre-fills the VoucherAdapter deploy form when the Voucher V2 tab's address book has none.
export const DEFAULT_VOUCHER_NFT_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'voucherNftAddress');
export const DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'voucherNftAddress');

// ATMVoid proxy — configurable burn contract (any registered ERC-20 / V2 LP token), its own
// admin/operator roles. Set after deploying from the ATM Void tab.
export const DEFAULT_ATM_VOID_ADDRESS = chainDefault(BNB_TESTNET.chainId, 'atmVoidAddress') || validAddr(process.env.NEXT_PUBLIC_ATM_VOID_ADDRESS);

// Same set of defaults, but for BSC Mainnet — deployments are independent per network,
// so mainnet gets its own fallbacks (chain.json's "56" entry, env var still wins) alongside
// the testnet ones above.
export const DEFAULT_TOKEN_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'tokenAddress') || validAddr(process.env.NEXT_PUBLIC_TOKEN_ADDRESS_MAINNET);
export const DEFAULT_HUB_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'hubAddress') || validAddr(process.env.NEXT_PUBLIC_HUB_ADDRESS_MAINNET);
// Mirrors DEFAULT_SESSION_MANAGER_ADDRESS (testnet) — no env var, chain.json only, same as testnet's.
export const DEFAULT_SESSION_MANAGER_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'sessionManagerAddress');
export const DEFAULT_TOKEN_VOID_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'tokenVoidAddress') || validAddr(process.env.NEXT_PUBLIC_TOKEN_VOID_ADDRESS_MAINNET);
export const DEFAULT_ADMIN_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'adminAddress') || validAddr(process.env.NEXT_PUBLIC_ADMIN_ADDRESS_MAINNET);
export const DEFAULT_VOID_OWNER_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'voidOwnerAddress') || validAddr(process.env.NEXT_PUBLIC_VOID_OWNER_ADDRESS_MAINNET);
export const DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'rewardEligibilityRegistryAddress') || validAddr(process.env.NEXT_PUBLIC_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET);
export const DEFAULT_ATM_VOUCHER_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'atmVoucherAddress') || validAddr(process.env.NEXT_PUBLIC_ATM_VOUCHER_ADDRESS_MAINNET);
export const DEFAULT_CONTRIBUTION_POOL_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'contributionPoolAddress') || validAddr(process.env.NEXT_PUBLIC_CONTRIBUTION_POOL_ADDRESS_MAINNET);
export const DEFAULT_RGST_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'rgstAddress') || validAddr(process.env.NEXT_PUBLIC_RGST_ADDRESS_MAINNET);
export const DEFAULT_ATM_VOID_ADDRESS_MAINNET = chainDefault(BSC_MAINNET.chainId, 'atmVoidAddress') || validAddr(process.env.NEXT_PUBLIC_ATM_VOID_ADDRESS_MAINNET);

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

// Etherscan v2 key for the Link tab's on-chain index (Factory event logs by date range). One key
// covers every chain id. Bundled into client JS like every NEXT_PUBLIC_ var — see .env.example.
export const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || '';
