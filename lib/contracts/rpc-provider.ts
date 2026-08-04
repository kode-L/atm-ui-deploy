import { ethers } from 'ethers';
import { BNB_TESTNET, BSC_MAINNET } from './config';

// One shared FallbackProvider per chainId, built lazily and reused — every component reading
// from the chain (points, finalization, sessions, matches, etc.) pulls the same instance via
// useWeb3().provider instead of depending solely on the connected wallet's own RPC, which may
// be a single rate-limited public endpoint. All configured RPCs for a chain share priority 1
// (same tier), so FallbackProvider fires every one of them in parallel and, with quorum 1,
// resolves as soon as the first one succeeds — the rest are just redundancy, not required to
// agree. This is read-only: writes still go through the wallet's own signer, untouched.
const cache: Partial<Record<number, ethers.providers.FallbackProvider>> = {};

export function getFallbackProvider(chainId: number): ethers.providers.FallbackProvider | null {
  const network = chainId === BSC_MAINNET.chainId ? BSC_MAINNET
    : chainId === BNB_TESTNET.chainId ? BNB_TESTNET
    : null;
  if (!network) return null;

  const cached = cache[chainId];
  if (cached) return cached;

  const configs = network.rpcUrls.map((url) => ({
    provider: new ethers.providers.StaticJsonRpcProvider(url, chainId),
    priority: 1,
    weight: 1,
    stallTimeout: 2000,
  }));

  const fallback = new ethers.providers.FallbackProvider(configs, 1);
  cache[chainId] = fallback;
  return fallback;
}
