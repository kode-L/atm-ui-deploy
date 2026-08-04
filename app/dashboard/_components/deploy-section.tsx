'use client';
import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { Rocket, Copy, ExternalLink, Check, ArrowUpCircle } from 'lucide-react';
import TestTokenArtifact from '@/lib/contracts/TestToken.json';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import BeaconArtifact from '@/lib/contracts/UpgradeableBeacon.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import GameHubProxyArtifact from '@/lib/contracts/GameHubProxy.json';
import { DEFAULT_ADMIN_ADDRESS, DEFAULT_ADMIN_ADDRESS_MAINNET, BSC_MAINNET, NETWORKS, getExplorerAddressUrl } from '@/lib/contracts/config';

// Session Start Offset is stored on-chain as seconds since 00:00 UTC; these convert
// to/from an <input type="time"> value so operators can pick a UTC clock time directly.
const secondsToUtcTime = (secs: number) => {
  const s = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};
const utcTimeToSeconds = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return String((h || 0) * 3600 + (m || 0) * 60);
};

export default function DeploySection() {
  const { provider, signer, isConnected, address, tokenAddress, hubAddress, sessionManagerAddress, setTokenAddress, resetTokenAddress, setHubAddress, setSessionManagerAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string }>({ status: 'idle' });
  const [copied, setCopied] = useState('');

  const [manualToken, setManualToken] = useState('');
  const [manualHub, setManualHub] = useState('');
  const [manualSm, setManualSm] = useState('');

  // TestToken form fields
  const [tokenName, setTokenName] = useState('Daily PR Boost Token');
  const [tokenSymbol, setTokenSymbol] = useState('DGT');
  const [tokenDecimals, setTokenDecimals] = useState('18');
  const [tokenSupply, setTokenSupply] = useState('1000000');

  // Hub stack deploy fields (GameHub.initialize(admin, beacon, paymentToken, sessionStartOffset))
  const [hubAdmin, setHubAdmin] = useState('');
  const [hubPaymentToken, setHubPaymentToken] = useState('');
  const [paymentTokenLabel, setPaymentTokenLabel] = useState(''); // resolved on-chain via ERC20 name()/symbol() for whatever's in hubPaymentToken
  const [hubStartOffset, setHubStartOffset] = useState('0'); // seconds from 00:00 UTC
  const [implAddress, setImplAddress] = useState('');
  const [beaconAddress, setBeaconAddress] = useState('');

  // Admin & Payment Token reset on every network switch and re-seed from *that* chain's
  // env/chain.json default — same per-network separation as tokenAddress/hubAddress in
  // providers.tsx. Without this, a testnet admin/token address (or the connected wallet,
  // for admin) would silently leak into a mainnet deploy after switching networks.
  useEffect(() => {
    const chainAdminDefault = chainId === BSC_MAINNET.chainId ? DEFAULT_ADMIN_ADDRESS_MAINNET : DEFAULT_ADMIN_ADDRESS;
    setHubAdmin(ethers.utils.isAddress(chainAdminDefault) ? chainAdminDefault : (address || ''));
    setHubPaymentToken('');
  }, [chainId]);

  // Backstop for the admin field: if neither this chain's default nor the wallet address
  // was available yet when the network-switch effect above ran, fill in the wallet address
  // as soon as it connects (without clobbering a manually-typed value).
  useEffect(() => {
    if (!hubAdmin && address) setHubAdmin(address);
  }, [address, hubAdmin]);

  // Auto-fill Payment Token with this chain's env-default/deployed TestToken address once
  // it's available, unless the operator has typed their own value in.
  useEffect(() => {
    if (tokenAddress && !hubPaymentToken) setHubPaymentToken(tokenAddress);
  }, [tokenAddress, hubPaymentToken]);

  // Resolve whatever address is currently in the Payment Token field to its ERC20
  // name/symbol so the admin can visually confirm which token it is, not just the raw hex.
  useEffect(() => {
    const addr = hubPaymentToken.trim();
    if (!provider || !addr || !ethers.utils.isAddress(addr)) { setPaymentTokenLabel(''); return; }
    let cancelled = false;
    const erc20 = new ethers.Contract(addr, TestTokenArtifact.abi, provider);
    Promise.all([erc20.name(), erc20.symbol()])
      .then(([name, symbol]) => { if (!cancelled) setPaymentTokenLabel(`${name} (${symbol})`); })
      .catch(() => { if (!cancelled) setPaymentTokenLabel('Not a readable ERC-20 (no name()/symbol())'); });
    return () => { cancelled = true; };
  }, [provider, hubPaymentToken]);

  // Read version() off the currently-loaded SessionManager instance and GameHub, so the
  // admin can see what's actually live BEFORE clicking either upgrade button. All
  // instances share one beacon, so any one instance's version represents the whole fleet.
  const [currentFleetVersion, setCurrentFleetVersion] = useState('');
  const [currentHubVersion, setCurrentHubVersion] = useState('');

  useEffect(() => {
    if (!provider || !sessionManagerAddress || !ethers.utils.isAddress(sessionManagerAddress)) {
      setCurrentFleetVersion('');
      return;
    }
    let cancelled = false;
    const sm = new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider);
    sm.version()
      .then((v: string) => { if (!cancelled) setCurrentFleetVersion(v); })
      .catch(() => { if (!cancelled) setCurrentFleetVersion('unreadable (no version() on this deployment)'); });
    return () => { cancelled = true; };
  }, [provider, sessionManagerAddress]);

  useEffect(() => {
    if (!provider || !hubAddress || !ethers.utils.isAddress(hubAddress)) {
      setCurrentHubVersion('');
      return;
    }
    let cancelled = false;
    const hubReader = new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
    hubReader.version()
      .then((v: string) => { if (!cancelled) setCurrentHubVersion(v); })
      .catch(() => { if (!cancelled) setCurrentHubVersion('unreadable (no version() on this deployment)'); });
    return () => { cancelled = true; };
  }, [provider, hubAddress]);

  // The actual implementation address every instance currently runs, read straight off the
  // shared beacon via the hub (GameHub.instanceImplementation() -> beacon.implementation()).
  // Shown next to "Upgrade All Instances" so it's clear which contract is about to be
  // replaced, not just its version string.
  const [currentImplAddress, setCurrentImplAddress] = useState('');
  const [currentImplVersion, setCurrentImplVersion] = useState('');

  useEffect(() => {
    if (!provider || !hubAddress || !ethers.utils.isAddress(hubAddress)) {
      setCurrentImplAddress('');
      return;
    }
    let cancelled = false;
    const hubReader = new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
    hubReader.instanceImplementation()
      .then((addr: string) => { if (!cancelled) setCurrentImplAddress(addr); })
      .catch(() => { if (!cancelled) setCurrentImplAddress(''); });
    return () => { cancelled = true; };
  }, [provider, hubAddress]);

  // version() is `pure` on DailySessionManager, so it's callable straight on the bare
  // implementation contract (no proxy/initialization needed) — reads the exact version of
  // whatever's currently live on the beacon, rather than whichever instance happens to be
  // loaded in sessionManagerAddress.
  useEffect(() => {
    if (!provider || !currentImplAddress || !ethers.utils.isAddress(currentImplAddress)) {
      setCurrentImplVersion('');
      return;
    }
    let cancelled = false;
    const impl = new ethers.Contract(currentImplAddress, SessionManagerArtifact.abi, provider);
    impl.version()
      .then((v: string) => { if (!cancelled) setCurrentImplVersion(v); })
      .catch(() => { if (!cancelled) setCurrentImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, currentImplAddress]);

  // Fleet upgrade fields (hub.upgradeAllInstancesAndInitCarryForward). Auto-filled by
  // "Deploy New Implementation" below, but always directly editable — paste an
  // already-deployed address here instead if you don't need a fresh deploy.
  const [newImplAddress, setNewImplAddress] = useState('');
  const [newImplVersion, setNewImplVersion] = useState('');

  useEffect(() => {
    if (!provider || !newImplAddress || !ethers.utils.isAddress(newImplAddress)) {
      setNewImplVersion('');
      return;
    }
    let cancelled = false;
    const impl = new ethers.Contract(newImplAddress, SessionManagerArtifact.abi, provider);
    impl.version()
      .then((v: string) => { if (!cancelled) setNewImplVersion(v); })
      .catch(() => { if (!cancelled) setNewImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newImplAddress]);

  // GameHub upgrade fields (hub.upgradeToAndCall — GameHub is UUPS, not beacon-based). Same
  // auto-fill-or-paste pattern as the fleet field above.
  const [newHubImplAddress, setNewHubImplAddress] = useState('');
  const [newHubImplVersion, setNewHubImplVersion] = useState('');

  useEffect(() => {
    if (!provider || !newHubImplAddress || !ethers.utils.isAddress(newHubImplAddress)) {
      setNewHubImplVersion('');
      return;
    }
    let cancelled = false;
    const impl = new ethers.Contract(newHubImplAddress, GameHubArtifact.abi, provider);
    impl.version()
      .then((v: string) => { if (!cancelled) setNewHubImplVersion(v); })
      .catch(() => { if (!cancelled) setNewHubImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newHubImplAddress]);

  const deployToken = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying TestToken...' });
    try {
      const factory = new ethers.ContractFactory(TestTokenArtifact.abi, TestTokenArtifact.bytecode, signer);
      const supply = ethers.utils.parseUnits(tokenSupply, Number(tokenDecimals));
      const contract = await factory.deploy(tokenName, tokenSymbol, Number(tokenDecimals), supply);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: contract.deployTransaction?.hash });
      await contract.deployed();
      setTokenAddress(contract.address);
      setTxStatus({ status: 'success', hash: contract.deployTransaction?.hash, message: `TestToken deployed at ${contract.address}` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Every operator instance is a BeaconProxy running this shared implementation. Beacon is
  // owned by the deployer until the hub is up, then ownership moves to the hub (deploy step 3)
  // so hub.upgradeAllInstances() can retarget the whole fleet. Two transactions.
  const deployImplementationAndBeacon = async () => {
    if (!signer || !address) return;
    try {
      setTxStatus({ status: 'pending', message: '1/2 Deploying SessionManager implementation...' });
      const implFactory = new ethers.ContractFactory(SessionManagerArtifact.abi, SessionManagerArtifact.bytecode, signer);
      const implContract = await implFactory.deploy();
      setTxStatus({ status: 'pending', message: '1/2 Waiting for confirmation...', hash: implContract.deployTransaction?.hash });
      await implContract.deployed();
      setImplAddress(implContract.address);

      setTxStatus({ status: 'pending', message: '2/2 Deploying UpgradeableBeacon...' });
      const beaconFactory = new ethers.ContractFactory(BeaconArtifact.abi, BeaconArtifact.bytecode, signer);
      const beaconContract = await beaconFactory.deploy(implContract.address, address);
      setTxStatus({ status: 'pending', message: '2/2 Waiting for confirmation...', hash: beaconContract.deployTransaction?.hash });
      await beaconContract.deployed();
      setBeaconAddress(beaconContract.address);

      setTxStatus({ status: 'success', hash: beaconContract.deployTransaction?.hash, message: `Implementation deployed at ${implContract.address}, beacon at ${beaconContract.address}. Now deploy the GameHub.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Three transactions: hub implementation, hub proxy (+ initialize), beacon ownership transfer.
  const deployHub = async () => {
    if (!signer || !beaconAddress) return;
    const admin = hubAdmin.trim() || address;
    const paymentToken = hubPaymentToken.trim() || tokenAddress;
    const offset = parseInt(hubStartOffset) || 0;
    if (!admin || !ethers.utils.isAddress(admin)) {
      setTxStatus({ status: 'error', error: 'Invalid admin address' });
      return;
    }
    if (!ethers.utils.isAddress(paymentToken)) {
      setTxStatus({ status: 'error', error: 'Invalid payment token address' });
      return;
    }
    if (offset < 0 || offset >= 86400) {
      setTxStatus({ status: 'error', error: 'sessionStartOffset must be 0–86399 (seconds from 00:00 UTC)' });
      return;
    }
    try {
      setTxStatus({ status: 'pending', message: '1/3 Deploying GameHub implementation...' });
      const hubFactory = new ethers.ContractFactory(GameHubArtifact.abi, GameHubArtifact.bytecode, signer);
      const hubImpl = await hubFactory.deploy();
      await hubImpl.deployed();

      setTxStatus({ status: 'pending', message: '2/3 Deploying GameHub proxy + initialize...' });
      const iface = new ethers.utils.Interface(GameHubArtifact.abi);
      const initData = iface.encodeFunctionData('initialize', [admin, beaconAddress, paymentToken, offset]);
      const proxyFactory = new ethers.ContractFactory(GameHubProxyArtifact.abi, GameHubProxyArtifact.bytecode, signer);
      const proxy = await proxyFactory.deploy(hubImpl.address, initData);
      setTxStatus({ status: 'pending', message: '2/3 Waiting for proxy confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();

      // The hub must own the beacon for upgradeAllInstances().
      setTxStatus({ status: 'pending', message: '3/3 Transferring beacon ownership to hub...' });
      const beacon = new ethers.Contract(beaconAddress, BeaconArtifact.abi, signer);
      const transferTx = await beacon.transferOwnership(proxy.address);
      setTxStatus({ status: 'pending', message: '3/3 Waiting for confirmation...', hash: transferTx.hash });
      await transferTx.wait();

      setHubAddress(proxy.address);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `GameHub deployed at ${proxy.address}. Register operators from the Hub tab — each registration deploys that operator's SessionManager instance.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Deploy a new SessionManager implementation for the fleet, then point the shared
  // beacon at it via hub.upgradeAllInstances (hub owns the beacon).
  const deployNewImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new SessionManager implementation...' });
    try {
      const factory = new ethers.ContractFactory(SessionManagerArtifact.abi, SessionManagerArtifact.bytecode, signer);
      const contract = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: contract.deployTransaction?.hash });
      await contract.deployed();
      setNewImplAddress(contract.address);
      setTxStatus({ status: 'success', hash: contract.deployTransaction?.hash, message: `New implementation deployed at ${contract.address}. Now upgrade the fleet.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const upgradeFleet = async () => {
    if (!signer || !hubAddress || !newImplAddress) return;
    setTxStatus({ status: 'pending', message: 'Checking upgrade...' });
    try {
      const hub = new ethers.Contract(hubAddress, GameHubArtifact.abi, signer);
      // upgradeAllInstancesAndInitCarryForward upgrades the beacon AND calls
      // initializeCarryForward() on every currently-active instance in the same
      // transaction — the one-time carry-forward migration step, done atomically so
      // there's no window for a newly-registered operator to slip in between the two
      // and get initialized needlessly. Requires the hub itself to already be running
      // the GameHub implementation that declares this function — upgrade the hub first
      // (below) if this reverts with a missing-function error.
      // Simulate first so a bad address or missing role fails instantly with a decoded
      // reason instead of after a signed, mined transaction.
      await hub.callStatic.upgradeAllInstancesAndInitCarryForward(newImplAddress);

      setTxStatus({ status: 'pending', message: 'Upgrading all operator instances and initializing carry-forward...' });
      const tx = await hub.upgradeAllInstancesAndInitCarryForward(newImplAddress);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Fleet upgraded — every operator instance now runs ${newImplAddress} and has its carry-forward cutover initialized.` });
      setNewImplAddress('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Deploy a new GameHub implementation for upgradeToAndCall below. GameHub is a UUPS
  // proxy (not beacon-based like the instances), so it upgrades itself directly.
  const deployNewHubImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new GameHub implementation...' });
    try {
      const factory = new ethers.ContractFactory(GameHubArtifact.abi, GameHubArtifact.bytecode, signer);
      const contract = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: contract.deployTransaction?.hash });
      await contract.deployed();
      setNewHubImplAddress(contract.address);
      setTxStatus({ status: 'success', hash: contract.deployTransaction?.hash, message: `New GameHub implementation deployed at ${contract.address}. Now upgrade the hub.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const upgradeHub = async () => {
    if (!signer || !hubAddress || !newHubImplAddress) return;
    setTxStatus({ status: 'pending', message: 'Checking upgrade...' });
    try {
      const hub = new ethers.Contract(hubAddress, GameHubArtifact.abi, signer);
      // Simulate first so a bad address or missing role fails instantly with a decoded
      // reason instead of after a signed, mined transaction.
      await hub.callStatic.upgradeToAndCall(newHubImplAddress, '0x');

      setTxStatus({ status: 'pending', message: 'Upgrading GameHub...' });
      const tx = await hub.upgradeToAndCall(newHubImplAddress, '0x');
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `GameHub upgraded to ${newHubImplAddress}. Operator registry, reward-type catalog and schedule config are untouched.` });
      setNewHubImplAddress('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Surfaced next to the hub address on the upgrade cards so it's never ambiguous which
  // network a transaction is about to target — see the testnet/mainnet address mix-up
  // this was added for.
  const currentChainName = NETWORKS[chainId]?.chainName || 'no network connected';

  const copyAddr = (addr: string, label: string) => {
    navigator.clipboard?.writeText?.(addr);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const saveManualAddresses = () => {
    if (manualToken) setTokenAddress(manualToken);
    if (manualHub) setHubAddress(manualHub);
    if (manualSm) setSessionManagerAddress(manualSm);
  };

  const AddrBadge = ({ addr, label }: { addr: string; label: string }) => (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-xs text-txt-secondary">Address:</span>
      <code className="text-xs text-accent font-mono truncate flex-1">{addr}</code>
      <button onClick={() => copyAddr(addr, label)} className="shrink-0">
        {copied === label ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
      </button>
      <a href={getExplorerAddressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="w-3.5 h-3.5 text-txt-secondary hover:text-accent" />
      </a>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* ── Deploy ── */}
      <Card title="Deploy Platform (GameHub)" icon={<Rocket className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Deploy the hub stack to whichever network your wallet is connected to (BNB Testnet or BSC Mainnet — switch networks from the wallet button above). The GameHub is the platform registry &amp; factory: registering an operator (Hub tab)
          deploys that operator&apos;s own DailySessionManager instance. All instances share one beacon, so the whole fleet upgrades in a single transaction.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* Step 1: TestToken */}
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. TestToken (ERC20)</h4>
            <p className="text-xs text-txt-secondary mb-3">Mintable test token for session fees &amp; rewards.</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="text-[11px] text-txt-secondary">Name</label>
                <input value={tokenName} onChange={e => setTokenName(e.target.value)} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-[11px] text-txt-secondary">Symbol</label>
                <input value={tokenSymbol} onChange={e => setTokenSymbol(e.target.value)} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-[11px] text-txt-secondary">Decimals</label>
                <input type="number" value={tokenDecimals} onChange={e => setTokenDecimals(e.target.value)} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-[11px] text-txt-secondary">Supply (points)</label>
                <input value={tokenSupply} onChange={e => setTokenSupply(e.target.value)} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </div>
            <button
              onClick={deployToken}
              disabled={!isConnected}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Deploy TestToken
            </button>
            {tokenAddress && <AddrBadge addr={tokenAddress} label="token" />}
            <button
              onClick={() => { resetTokenAddress(); setHubPaymentToken(''); }}
              className="mt-2 text-[11px] text-txt-secondary hover:text-accent underline"
            >
              Reset to .env default
            </button>
          </div>

          {/* Step 2: SessionManager Implementation + Beacon */}
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Instance Implementation + Beacon</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the DailySessionManager logic contract every operator instance runs, then the UpgradeableBeacon pointing at it. Ownership moves to the hub in step 3 so it can upgrade the fleet. 2 transactions.</p>
            <button
              onClick={deployImplementationAndBeacon}
              disabled={!isConnected}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Deploy Implementation + Beacon
            </button>
            {implAddress && <AddrBadge addr={implAddress} label="impl" />}
            {beaconAddress && <AddrBadge addr={beaconAddress} label="beacon" />}
          </div>

          {/* Step 3: GameHub */}
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">3. GameHub</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the hub (UUPS proxy), calls <code className="text-accent">initialize(admin, beacon, paymentToken, sessionStartOffset)</code> and hands it the beacon. 3 transactions.</p>
            <div className="mb-3">
              <label className="text-[11px] text-txt-secondary">Admin Address (pre-filled from this chain&apos;s env/chain.json default, otherwise your connected wallet)</label>
              <input value={hubAdmin} onChange={e => setHubAdmin(e.target.value)} placeholder={address || '0x...'} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div className="mb-3">
              <label className="text-[11px] text-txt-secondary">Beacon Address (pre-filled from step 2 above — edit if it's wrong or you're pointing at an existing beacon)</label>
              <input value={beaconAddress} onChange={e => setBeaconAddress(e.target.value)} placeholder="Deploy implementation + beacon first (step 2), or paste one" className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div className="mb-3">
              <label className="text-[11px] text-txt-secondary">Payment Token Address (auto-fills from the TestToken above / .env default token once available)</label>
              <input value={hubPaymentToken} onChange={e => setHubPaymentToken(e.target.value)} placeholder={tokenAddress || '0x...'} className="w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
              {paymentTokenLabel && (
                <p className={`text-[11px] mt-1 ${paymentTokenLabel.startsWith('Not a readable') ? 'text-yellow-400' : 'text-green-400'}`}>{paymentTokenLabel}</p>
              )}
            </div>
            <div className="mb-3">
              <label className="text-[11px] text-txt-secondary">Session Start Offset (seconds from 00:00 UTC, 0 = midnight)</label>
              <div className="flex gap-2 mt-0.5">
                <input type="number" value={hubStartOffset} onChange={e => setHubStartOffset(e.target.value)} min="0" max="86399" placeholder="0" className="flex-1 bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
                <input type="time" value={secondsToUtcTime(parseInt(hubStartOffset) || 0)} onChange={e => setHubStartOffset(utcTimeToSeconds(e.target.value))} className="bg-surface rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <p className="text-[10px] text-txt-secondary/70 mt-1">Pick a UTC clock time (e.g. 18:00 = 6:00 PM UTC) or type raw seconds directly — both stay in sync.</p>
            </div>
            <button
              onClick={deployHub}
              disabled={!isConnected || !beaconAddress || !(hubPaymentToken.trim() || tokenAddress)}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Deploy GameHub
            </button>
            {!beaconAddress && <p className="text-xs text-yellow-400 mt-2">&#9888; Deploy beacon first</p>}
            {hubAddress && <AddrBadge addr={hubAddress} label="hub" />}
          </div>
        </div>
        <TxStatus {...txStatus} chainId={chainId} />
      </Card>

      {/* ── Fleet upgrade ── */}
      <Card title="Upgrade Fleet" icon={<ArrowUpCircle className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Push new DailySessionManager logic to <strong>every operator instance at once</strong> via the hub at <code className="text-accent">{hubAddress || '(no GameHub loaded)'}</code> on <strong className="text-accent">{currentChainName}</strong>,
          and initialize each instance&apos;s carry-forward cutover in the same transaction.
          Requires DEFAULT_ADMIN_ROLE on the hub. Existing data (sessions, matches, balances) is untouched.
          <span className="text-yellow-400"> Requires the hub itself to already be upgraded (see &quot;Upgrade GameHub&quot; below) to a version that has <code>upgradeAllInstancesAndInitCarryForward</code> — upgrade the hub first if this is your first time running this.</span>
        </p>
        <div className="bg-surface-tertiary rounded-lg px-4 py-2.5 mb-4 flex items-center gap-2 text-sm">
          <span className="text-txt-secondary">Currently deployed fleet version:</span>
          <span className="font-mono text-accent">
            {!sessionManagerAddress ? '— no instance loaded —' : currentFleetVersion || 'loading...'}
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Deploy New Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Compile &amp; deploy the updated DailySessionManager code.</p>
            <button
              onClick={deployNewImplementation}
              disabled={!isConnected}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Deploy New Implementation
            </button>
            {newImplAddress && <AddrBadge addr={newImplAddress} label="newImpl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Upgrade All Instances</h4>
            {hubAddress && (
              <p className="text-[11px] text-txt-secondary mb-3">
                Currently live implementation (what you&apos;re replacing):{' '}
                {currentImplAddress ? (
                  <>
                    <a href={getExplorerAddressUrl(chainId, currentImplAddress)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
                      {currentImplAddress}
                    </a>
                    <span className="text-txt-secondary"> ({currentImplVersion || 'loading...'})</span>
                  </>
                ) : (
                  <span className="font-mono">loading...</span>
                )}
              </p>
            )}
            <p className="text-xs text-txt-secondary mb-3">Pre-filled from step 1, or paste an already-deployed implementation address to upgrade straight to it.</p>
            <input
              value={newImplAddress}
              onChange={e => setNewImplAddress(e.target.value)}
              placeholder="0x..."
              className="w-full mb-3 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {newImplAddress && ethers.utils.isAddress(newImplAddress) && (
              <p className="text-[11px] text-txt-secondary mb-3">New version: <span className="font-mono text-accent">{newImplVersion || 'loading...'}</span></p>
            )}
            <button
              onClick={upgradeFleet}
              disabled={!isConnected || !hubAddress || !newImplAddress}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Upgrade Fleet
            </button>
            {!hubAddress && <p className="text-xs text-yellow-400 mt-2">&#9888; Deploy or load a GameHub first</p>}
          </div>
        </div>
      </Card>

      {/* ── Hub upgrade ── */}
      <Card title="Upgrade GameHub" icon={<ArrowUpCircle className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Push new GameHub logic to <code className="text-accent">{hubAddress || '(no GameHub loaded)'}</code> on <strong className="text-accent">{currentChainName}</strong> itself — separate from the fleet upgrade above,
          since GameHub is a UUPS proxy (self-upgrading), not a beacon-based instance. Use this whenever hub-level behavior changes
          (e.g. reward-type catalog rules, operator registration). Requires DEFAULT_ADMIN_ROLE on the hub. The operator registry, reward-type catalog and schedule config are untouched.
        </p>
        <div className="bg-surface-tertiary rounded-lg px-4 py-2.5 mb-4 flex items-center gap-2 text-sm">
          <span className="text-txt-secondary">Currently deployed GameHub version:</span>
          <span className="font-mono text-accent">
            {!hubAddress ? '— no hub loaded —' : currentHubVersion || 'loading...'}
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Deploy New Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Compile &amp; deploy the updated GameHub code.</p>
            <button
              onClick={deployNewHubImplementation}
              disabled={!isConnected}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Deploy New Implementation
            </button>
            {newHubImplAddress && <AddrBadge addr={newHubImplAddress} label="newHubImpl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Upgrade Hub</h4>
            <p className="text-xs text-txt-secondary mb-3">Pre-filled from step 1, or paste an already-deployed implementation address to upgrade straight to it.</p>
            <input
              value={newHubImplAddress}
              onChange={e => setNewHubImplAddress(e.target.value)}
              placeholder="0x..."
              className="w-full mb-3 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {newHubImplAddress && ethers.utils.isAddress(newHubImplAddress) && (
              <p className="text-[11px] text-txt-secondary mb-3">New version: <span className="font-mono text-accent">{newHubImplVersion || 'loading...'}</span></p>
            )}
            <button
              onClick={upgradeHub}
              disabled={!isConnected || !hubAddress || !newHubImplAddress}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              Upgrade Hub
            </button>
            {!hubAddress && <p className="text-xs text-yellow-400 mt-2">&#9888; Deploy or load a GameHub first</p>}
          </div>
        </div>
      </Card>

      {/* ── Load Existing ── */}
      <Card title="Load Existing Contracts" icon={<ExternalLink className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">Already deployed? Enter contract addresses to load them. The active SessionManager instance is normally selected from the Hub tab.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-txt-secondary">TestToken Address</label>
            <input
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              placeholder="0x..."
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">GameHub Address</label>
            <input
              value={manualHub}
              onChange={(e) => setManualHub(e.target.value)}
              placeholder="0x..."
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">SessionManager Instance Address</label>
            <input
              value={manualSm}
              onChange={(e) => setManualSm(e.target.value)}
              placeholder="0x..."
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
        <button
          onClick={saveManualAddresses}
          className="mt-4 bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-6 py-2 rounded-lg text-sm transition-colors"
        >
          Save Addresses
        </button>
      </Card>
    </div>
  );
}
