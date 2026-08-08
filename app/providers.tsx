'use client';
import React, { useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { ethers } from 'ethers';
import { Web3Context, Web3State, WalletRole } from '@/lib/contracts/use-web3';
import {
  BNB_TESTNET,
  BSC_MAINNET,
  DEFAULT_HUB_ADDRESS,
  DEFAULT_HUB_ADDRESS_MAINNET,
  DEFAULT_SESSION_MANAGER_ADDRESS,
  DEFAULT_SESSION_MANAGER_ADDRESS_MAINNET,
  DEFAULT_TOKEN_ADDRESS,
  DEFAULT_TOKEN_ADDRESS_MAINNET,
  DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS,
  DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET,
  DEFAULT_ATM_VOUCHER_ADDRESS,
  DEFAULT_ATM_VOUCHER_ADDRESS_MAINNET,
  networkStorageKey,
} from '@/lib/contracts/config';
import { getFallbackProvider } from '@/lib/contracts/rpc-provider';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
// Side-effect import: lib/reown/appkit.ts calls createAppKit() at module scope, and this is
// the only place that module gets imported. Without it, createAppKit() never runs and every
// useAppKit*() hook below throws "Please call createAppKit before using ... hook".
import '@/lib/reown/appkit';
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useAppKitState,
  useDisconnect,
} from '@reown/appkit/react';

function Web3Provider({ children }: { children: ReactNode }) {
  const { open } = useAppKit();
  const { disconnect: disconnectAppKit } = useDisconnect();
  const { address: aaAddress, isConnected: aaIsConnected } = useAppKitAccount();
  const { chainId: aaChainId } = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider<ethers.providers.ExternalProvider>('eip155');
  const { open: modalOpen, initialized } = useAppKitState();

  // Only `signer` (writes) and the native BNB balance below come from the wallet's own
  // connection now — every read-only call in the app instead gets `readProvider` (exposed as
  // `provider` in context, see val below), so it isn't bottlenecked on whichever single RPC
  // the connected wallet happens to use.
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState(0);
  const [bnbBalance, setBnbBalance] = useState('0');
  const [tokenAddress, setTokenAddress] = useState('');
  const [hubAddress, setHubAddress] = useState('');
  const [sessionManagerAddress, setSessionManagerAddress] = useState('');
  const [rewardEligibilityRegistryAddress, setRewardEligibilityRegistryAddressState] = useState('');
  const [atmVoucherAddress, setAtmVoucherAddressState] = useState('');
  const [splitters, setSplitters] = useState<{ address: string; label: string }[]>([]);
  const [activeSplitter, setActiveSplitterState] = useState('');
  const [walletRole, setWalletRole] = useState<WalletRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);
  const [operatorName, setOperatorName] = useState('');
  const [operatorInstance, setOperatorInstance] = useState('');
  // Guards the auto-load-instance side effect so it fires once per (wallet, hub) pair
  // rather than clobbering a manually-selected instance on every re-render.
  const autoLoadedFor = useRef('');

  // Which network's stored addresses to read/write. Derived straight from AppKit's raw
  // chainId (not the mirrored `chainId` state below) so it updates in the same render as
  // a network switch, rather than one tick later. Defaults to testnet when disconnected
  // or on some other, unsupported chain — matches the app's original testnet-only behavior.
  const rawChainId = aaIsConnected ? (typeof aaChainId === 'string' ? parseInt(aaChainId, 10) : aaChainId ?? 0) : 0;
  const netNs = rawChainId === BSC_MAINNET.chainId ? BSC_MAINNET.chainId : BNB_TESTNET.chainId;

  useEffect(() => {
    const isMainnet = netNs === BSC_MAINNET.chainId;

    // TEMPORARY: chain.json is the sole source for these three addresses on load — a saved
    // override under the correctly-namespaced key was still showing a mainnet address while
    // connected to testnet even after removing the legacy unnamespaced-key fallback above, so
    // reading any saved override is disabled for now. saveTokenAddress/saveHubAddress/
    // saveSessionManagerAddress below still write localStorage and update state live within
    // the session (e.g. right after a deploy) — only the read-on-load/network-switch is
    // disabled. Re-enable by restoring the `localStorage.getItem(...) ||` read once addresses
    // have been reconfirmed and explicitly re-saved.
    setTokenAddress(isMainnet ? DEFAULT_TOKEN_ADDRESS_MAINNET : DEFAULT_TOKEN_ADDRESS);
    setHubAddress(isMainnet ? DEFAULT_HUB_ADDRESS_MAINNET : DEFAULT_HUB_ADDRESS);
    setSessionManagerAddress(isMainnet ? DEFAULT_SESSION_MANAGER_ADDRESS_MAINNET : DEFAULT_SESSION_MANAGER_ADDRESS);

    // rewardEligibilityRegistryAddress is a standalone contract unrelated to the hub/token
    // addresses above, so it isn't subject to the mainnet/testnet mix-up those hit — a saved
    // override is read back normally here.
    const savedRegistry = localStorage.getItem(networkStorageKey('dg_rewardEligibilityRegistryAddress', netNs));
    setRewardEligibilityRegistryAddressState(savedRegistry || (isMainnet ? DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS_MAINNET : DEFAULT_REWARD_ELIGIBILITY_REGISTRY_ADDRESS));

    // atmVoucherAddress is likewise a standalone contract, unaffected by the
    // token/hub/sessionManager mainnet/testnet mix-up noted above.
    const savedAtmVoucher = localStorage.getItem(networkStorageKey('dg_atmVoucherAddress', netNs));
    setAtmVoucherAddressState(savedAtmVoucher || (isMainnet ? DEFAULT_ATM_VOUCHER_ADDRESS_MAINNET : DEFAULT_ATM_VOUCHER_ADDRESS));

    // Load splitters array
    try {
      const savedSplitters = localStorage.getItem(networkStorageKey('dg_splitters', netNs));
      setSplitters(savedSplitters ? JSON.parse(savedSplitters) : []);
    } catch { setSplitters([]); }
    const savedActive = localStorage.getItem(networkStorageKey('dg_activeSplitter', netNs)) || '';
    setActiveSplitterState(savedActive);

    // Avoid showing the previous network's admin/operator status while the hub address
    // above is still catching up.
    setWalletRole(null);
    setOperatorName('');
    setOperatorInstance('');
    autoLoadedFor.current = '';
  }, [netNs]);

  const saveTokenAddress = (a: string) => {
    setTokenAddress(a);
    localStorage.setItem(networkStorageKey('dg_tokenAddress', netNs), a);
  };
  // Clears the saved override so the .env/chain.json default takes effect again — without
  // this, once any value is saved via deployToken/saveManualAddresses it wins over .env forever.
  const resetTokenAddress = () => {
    localStorage.removeItem(networkStorageKey('dg_tokenAddress', netNs));
    const isMainnet = netNs === BSC_MAINNET.chainId;
    setTokenAddress(isMainnet ? DEFAULT_TOKEN_ADDRESS_MAINNET : DEFAULT_TOKEN_ADDRESS);
  };
  const saveSessionManagerAddress = (a: string) => {
    setSessionManagerAddress(a);
    localStorage.setItem(networkStorageKey('dg_sessionManagerAddress', netNs), a);
  };
  const saveHubAddress = (a: string) => {
    setHubAddress(a);
    localStorage.setItem(networkStorageKey('dg_hubAddress', netNs), a);
  };
  const saveRewardEligibilityRegistryAddress = (a: string) => {
    setRewardEligibilityRegistryAddressState(a);
    localStorage.setItem(networkStorageKey('dg_rewardEligibilityRegistryAddress', netNs), a);
  };
  const saveAtmVoucherAddress = (a: string) => {
    setAtmVoucherAddressState(a);
    localStorage.setItem(networkStorageKey('dg_atmVoucherAddress', netNs), a);
  };
  const addSplitter = (addr: string, label: string) => {
    setSplitters(prev => {
      // Don't add duplicates
      if (prev.some(s => s.address.toLowerCase() === addr.toLowerCase())) return prev;
      const next = [...prev, { address: addr, label }];
      localStorage.setItem(networkStorageKey('dg_splitters', netNs), JSON.stringify(next));
      return next;
    });
    // Auto-set as active if it's the first one
    setActiveSplitterState(prev => {
      if (!prev) {
        localStorage.setItem(networkStorageKey('dg_activeSplitter', netNs), addr);
        return addr;
      }
      return prev;
    });
  };
  const removeSplitter = (addr: string) => {
    setSplitters(prev => {
      const next = prev.filter(s => s.address.toLowerCase() !== addr.toLowerCase());
      localStorage.setItem(networkStorageKey('dg_splitters', netNs), JSON.stringify(next));
      return next;
    });
    setActiveSplitterState(prev => {
      if (prev.toLowerCase() === addr.toLowerCase()) {
        localStorage.removeItem(networkStorageKey('dg_activeSplitter', netNs));
        return '';
      }
      return prev;
    });
  };
  const setActiveSplitter = (addr: string) => {
    setActiveSplitterState(addr);
    if (addr) localStorage.setItem(networkStorageKey('dg_activeSplitter', netNs), addr);
    else localStorage.removeItem(networkStorageKey('dg_activeSplitter', netNs));
  };

  const fetchBalance = useCallback(async (prov: ethers.providers.Web3Provider, addr: string) => {
    try {
      const bal = await prov.getBalance(addr);
      setBnbBalance(ethers.utils.formatEther(bal));
    } catch { setBnbBalance('0'); }
  }, []);

  // Reown AppKit drives the actual wallet connection (MetaMask, WalletConnect,
  // Coinbase, etc.) and reacts to account/chain changes internally; this effect
  // just mirrors its state into the ethers provider/signer this app expects.
  useEffect(() => {
    if (!aaIsConnected || !walletProvider) {
      setSigner(null);
      setAddress('');
      setChainId(0);
      setBnbBalance('0');
      return;
    }
    const prov = new ethers.providers.Web3Provider(walletProvider);
    setSigner(prov.getSigner());
    setAddress(aaAddress ?? '');
    setChainId(typeof aaChainId === 'string' ? parseInt(aaChainId, 10) : aaChainId ?? 0);
    fetchBalance(prov, aaAddress ?? '');
  }, [aaIsConnected, walletProvider, aaAddress, aaChainId, fetchBalance]);

  // Multi-RPC read provider for this network — built from netNs (the resolved
  // testnet/mainnet namespace), not the raw wallet chainId, so it always matches whichever
  // network's contract addresses are currently loaded, even before/without a wallet connected.
  const readProvider = useMemo(() => getFallbackProvider(netNs), [netNs]);

  const connect = useCallback(async () => {
    await open();
  }, [open]);

  const disconnect = useCallback(() => {
    disconnectAppKit();
    setWalletRole(null);
    setOperatorName('');
    setOperatorInstance('');
    autoLoadedFor.current = '';
  }, [disconnectAppKit]);

  const openNetworkPicker = useCallback(async () => {
    await open({ view: 'Networks' });
  }, [open]);

  // Detect the connected wallet's role against the hub (admin / registered active
  // operator / neither) and, for operators, auto-load their own SessionManager
  // instance once per (wallet, hub) pair so they land directly in their own scope
  // instead of hunting for it in the Hub tab.
  useEffect(() => {
    let cancelled = false;
    const detectRole = async () => {
      if (!address || !hubAddress || !readProvider) {
        setWalletRole(null);
        setOperatorName('');
        setOperatorInstance('');
        return;
      }
      setRoleLoading(true);
      try {
        const hub = new ethers.Contract(hubAddress, GameHubArtifact.abi, readProvider);
        const [adminWallet, record] = await Promise.all([
          hub.adminWallet(),
          hub.getOperatorRecord(address),
        ]);
        if (cancelled) return;

        const isAdmin = !!adminWallet && adminWallet.toLowerCase() === address.toLowerCase();
        const isOperator = !!record?.active && record.instance && record.instance !== ethers.constants.AddressZero;

        let role: WalletRole = 'unknown';
        if (isAdmin && isOperator) role = 'admin+operator';
        else if (isAdmin) role = 'admin';
        else if (isOperator) role = 'operator';

        setWalletRole(role);
        setOperatorName(isOperator ? record.name : '');
        setOperatorInstance(isOperator ? record.instance : '');

        const pairKey = `${address.toLowerCase()}:${hubAddress.toLowerCase()}`;
        if (isOperator && autoLoadedFor.current !== pairKey) {
          autoLoadedFor.current = pairKey;
          saveSessionManagerAddress(record.instance);
        }
      } catch {
        if (!cancelled) {
          setWalletRole('unknown');
          setOperatorName('');
          setOperatorInstance('');
        }
      } finally {
        if (!cancelled) setRoleLoading(false);
      }
    };
    detectRole();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, hubAddress, readProvider]);

  const val: Web3State = {
    provider: readProvider, signer, address, chainId, bnbBalance,
    isConnected: aaIsConnected,
    connecting: modalOpen && !aaIsConnected,
    initialized,
    connect, disconnect, openNetworkPicker,
    tokenAddress, hubAddress, sessionManagerAddress, rewardEligibilityRegistryAddress,
    atmVoucherAddress,
    splitters, activeSplitter,
    setTokenAddress: saveTokenAddress,
    resetTokenAddress,
    setHubAddress: saveHubAddress,
    setSessionManagerAddress: saveSessionManagerAddress,
    setRewardEligibilityRegistryAddress: saveRewardEligibilityRegistryAddress,
    setAtmVoucherAddress: saveAtmVoucherAddress,
    addSplitter, removeSplitter, setActiveSplitter,
    walletRole, roleLoading, operatorName, operatorInstance,
  };

  return <Web3Context.Provider value={val}>{children}</Web3Context.Provider>;
}

export default function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <Web3Provider>{children}</Web3Provider>;
}
