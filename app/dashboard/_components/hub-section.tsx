'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import { Network, RefreshCw, UserPlus, UserMinus, CheckCircle, Copy, Check, ExternalLink, Link2 } from 'lucide-react';
import GameHubArtifact from '@/lib/contracts/GameHub.json';

interface HubOperator {
  address: string;
  instance: string;
  active: boolean;
  registeredAt: number;
  name: string;
}

interface HubInfo {
  adminWallet: string;
  paymentToken: string;
  beacon: string;
  instanceImplementation: string;
  sessionStartOffset: number;
  sessionDuration: number;
  finalizationGracePeriod: number;
  prBoostGracePeriod: number;
}

export default function HubSection() {
  const { provider, signer, isConnected, hubAddress, sessionManagerAddress, setSessionManagerAddress, activeSplitter, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string }>({ status: 'idle' });
  const [hubInfo, setHubInfo] = useState<HubInfo | null>(null);
  const [operators, setOperators] = useState<HubOperator[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  // Register-operator form
  const [opWallet, setOpWallet] = useState('');
  const [opName, setOpName] = useState('');
  const [opMeta, setOpMeta] = useState('');
  const [opSplitter, setOpSplitter] = useState('');

  // Link-existing-instance form (recovery path)
  const [linkWallet, setLinkWallet] = useState('');
  const [linkInstance, setLinkInstance] = useState('');
  const [linkName, setLinkName] = useState('');

  // Access Control (hub-wide ATMAccessControl link, via GameHub.file/setFile)
  const [accessControlOnChain, setAccessControlOnChain] = useState('');
  const [accessControlInput, setAccessControlInput] = useState('');

  // Reward Eligibility Registry (hub-wide, shared by every operator instance)
  const [rewardEligibilityRegistryOnChain, setRewardEligibilityRegistryOnChain] = useState('');
  const [rewardEligibilityRegistryInput, setRewardEligibilityRegistryInput] = useState('');

  // ATM Voucher (hub-wide link to the deployed ATMVoucher contract)
  const [atmVoucherOnChain, setAtmVoucherOnChain] = useState('');
  const [atmVoucherInput, setAtmVoucherInput] = useState('');

  const getHub = useCallback((withSigner = false) => {
    if (!hubAddress) return null;
    const signerOrProvider = withSigner ? signer : provider;
    if (!signerOrProvider) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, signerOrProvider);
  }, [hubAddress, provider, signer]);

  const fetchAll = useCallback(async () => {
    const hub = getHub();
    if (!hub) return;
    setLoading(true);
    setError('');
    try {
      const [adminWallet, paymentToken, beacon, impl, offset, duration, grace, prBoostGrace, opAddrs, fileAddr, rewardRegistryAddr, atmVoucherAddr] = await Promise.all([
        hub.adminWallet(),
        hub.paymentToken(),
        hub.beacon(),
        hub.instanceImplementation(),
        hub.sessionStartOffset(),
        hub.sessionDuration(),
        hub.finalizationGracePeriod(),
        hub.prBoostGracePeriod(),
        hub.getOperators(),
        hub.file(),
        hub.rewardEligibilityRegistry(),
        hub.atmVoucher(),
      ]);
      setAccessControlOnChain(fileAddr);
      setRewardEligibilityRegistryOnChain(rewardRegistryAddr);
      setAtmVoucherOnChain(atmVoucherAddr);
      setHubInfo({
        adminWallet,
        paymentToken,
        beacon,
        instanceImplementation: impl,
        sessionStartOffset: Number(offset),
        sessionDuration: Number(duration),
        finalizationGracePeriod: Number(grace),
        prBoostGracePeriod: Number(prBoostGrace),
      });
      const records: HubOperator[] = [];
      for (const addr of opAddrs) {
        const rec = await hub.getOperatorRecord(addr);
        records.push({
          address: addr,
          instance: rec.instance,
          active: rec.active,
          registeredAt: rec.registeredAt?.toNumber?.() ?? Number(rec.registeredAt),
          name: rec.name,
        });
      }
      records.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setOperators(records);
    } catch (e: any) {
      console.error('Fetch hub error:', e);
      setError(decodeError(e));
    } finally {
      setLoading(false);
    }
  }, [getHub]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const registerOperator = async () => {
    const hub = getHub(true);
    if (!hub) return;
    const wallet = opWallet.trim();
    const splitter = opSplitter.trim() || activeSplitter;
    if (!ethers.utils.isAddress(wallet)) {
      setTxStatus({ status: 'error', error: 'Invalid operator wallet address' });
      return;
    }
    if (!opName.trim()) {
      setTxStatus({ status: 'error', error: 'Operator name is required' });
      return;
    }
    if (!ethers.utils.isAddress(splitter)) {
      setTxStatus({ status: 'error', error: 'Invalid splitter address (set one in the Splitter tab or paste it here)' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Simulating registration...' });
    try {
      // Simulation also returns the instance address the registration will deploy.
      const instance = await hub.callStatic.registerOperator(wallet, opName.trim(), opMeta.trim(), splitter);
      setTxStatus({ status: 'pending', message: 'Registering operator & deploying their SessionManager instance...' });
      const tx = await hub.registerOperator(wallet, opName.trim(), opMeta.trim(), splitter);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Operator registered — dedicated instance deployed at ${instance}` });
      setOpWallet(''); setOpName(''); setOpMeta(''); setOpSplitter('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const linkExistingInstance = async () => {
    const hub = getHub(true);
    if (!hub) return;
    const wallet = linkWallet.trim();
    const instance = linkInstance.trim();
    if (!ethers.utils.isAddress(wallet)) {
      setTxStatus({ status: 'error', error: 'Invalid operator wallet address' });
      return;
    }
    if (!ethers.utils.isAddress(instance)) {
      setTxStatus({ status: 'error', error: 'Invalid instance address' });
      return;
    }
    if (!linkName.trim()) {
      setTxStatus({ status: 'error', error: 'Name is required' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Simulating link...' });
    try {
      await hub.callStatic.registerExistingInstance(wallet, instance, linkName.trim());
      setTxStatus({ status: 'pending', message: 'Linking instance into the hub registry...' });
      const tx = await hub.registerExistingInstance(wallet, instance, linkName.trim());
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Instance linked — hub callbacks from ${instance} will no longer revert.` });
      setLinkWallet(''); setLinkInstance(''); setLinkName('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const setAccessControl = async () => {
    const hub = getHub(true);
    if (!hub) return;
    const addr = accessControlInput.trim();
    if (!ethers.utils.isAddress(addr)) {
      setTxStatus({ status: 'error', error: 'Enter a valid contract address.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Setting File...' });
    try {
      const tx = await hub.setFile(addr);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'File set ✔' });
      setAccessControlInput('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const clearAccessControl = async () => {
    const hub = getHub(true);
    if (!hub) return;
    setTxStatus({ status: 'pending', message: 'Clearing File...' });
    try {
      const tx = await hub.setFile(ethers.constants.AddressZero);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'File cleared ✔' });
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const setRewardEligibilityRegistry = async () => {
    const hub = getHub(true);
    if (!hub) return;
    const addr = rewardEligibilityRegistryInput.trim();
    if (!ethers.utils.isAddress(addr)) {
      setTxStatus({ status: 'error', error: 'Enter a valid registry contract address.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Setting Reward Eligibility Registry...' });
    try {
      const tx = await hub.setRewardEligibilityRegistry(addr);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Reward Eligibility Registry set ✔' });
      setRewardEligibilityRegistryInput('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const clearRewardEligibilityRegistry = async () => {
    const hub = getHub(true);
    if (!hub) return;
    setTxStatus({ status: 'pending', message: 'Clearing Reward Eligibility Registry...' });
    try {
      const tx = await hub.setRewardEligibilityRegistry(ethers.constants.AddressZero);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Reward Eligibility Registry cleared (unlimited) ✔' });
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const setAtmVoucher = async () => {
    const hub = getHub(true);
    if (!hub) return;
    const addr = atmVoucherInput.trim();
    if (!ethers.utils.isAddress(addr)) {
      setTxStatus({ status: 'error', error: 'Enter a valid ATM Voucher contract address.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Setting ATM Voucher...' });
    try {
      const tx = await hub.setATMVoucher(addr);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'ATM Voucher set ✔' });
      setAtmVoucherInput('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const clearAtmVoucher = async () => {
    const hub = getHub(true);
    if (!hub) return;
    setTxStatus({ status: 'pending', message: 'Clearing ATM Voucher...' });
    try {
      const tx = await hub.setATMVoucher(ethers.constants.AddressZero);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'ATM Voucher cleared ✔' });
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const removeOperator = async (operator: string) => {
    const hub = getHub(true);
    if (!hub) return;
    setTxStatus({ status: 'pending', message: `Deactivating operator ${operator}...` });
    try {
      const tx = await hub.removeOperator(operator);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Operator deactivated. Their instance keeps its historical state.' });
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const useInstance = (op: HubOperator) => {
    setSessionManagerAddress(op.instance);
    setTxStatus({ status: 'success', message: `Dashboard now points at ${op.name}'s instance (${op.instance}). All tabs (Sessions, Matches, Balances, ...) target it.` });
  };

  const copyAddr = (addr: string, label: string) => {
    navigator.clipboard?.writeText?.(addr);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const fmtAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
  const fmtDate = (ts: number) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—');
  const fmtDuration = (s: number) => (s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`);
  const inputCls = 'w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent';

  if (!hubAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load a GameHub first (Deploy tab).</p></Card>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5 text-accent" />
          <h3 className="text-lg font-semibold">GameHub</h3>
          <code className="text-xs text-accent font-mono">{fmtAddr(hubAddress)}</code>
          <button onClick={() => copyAddr(hubAddress, 'hub')} className="shrink-0">
            {copied === 'hub' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
          </button>
          <a href={getExplorerAddressUrl(chainId, hubAddress)} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="w-3.5 h-3.5 text-txt-secondary hover:text-accent" />
          </a>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="flex items-center gap-1.5 bg-surface-tertiary hover:bg-surface-secondary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3">
          <p className="text-red-300 text-xs">{error}</p>
        </div>
      )}

      {/* Hub config */}
      {hubInfo && (
        <Card title="Platform Config">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-[11px] text-txt-secondary">Admin Wallet</p>
              <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.adminWallet)}</code>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Payment Token</p>
              <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.paymentToken)}</code>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Beacon</p>
              <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.beacon)}</code>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Instance Implementation</p>
              <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.instanceImplementation)}</code>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Session Start Offset</p>
              <p className="font-medium">{hubInfo.sessionStartOffset}s</p>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Session Duration</p>
              <p className="font-medium">{fmtDuration(hubInfo.sessionDuration)}</p>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Grace Period</p>
              <p className="font-medium">{fmtDuration(hubInfo.finalizationGracePeriod)}</p>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">PR Boost Claim Window</p>
              <p className="font-medium">{hubInfo.prBoostGracePeriod > 0 ? fmtDuration(hubInfo.prBoostGracePeriod) : 'Not set (2× duration)'}</p>
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">Operators</p>
              <p className="font-medium">{operators.length} ({operators.filter(o => o.active).length} active)</p>
            </div>
          </div>
          <p className="text-[11px] text-txt-secondary mt-3">
            Schedule config and the reward-type catalog are managed on the hub (Admin tab) and broadcast to every active instance.
          </p>
        </Card>
      )}

      {/* Register operator */}
      <Card title="Register Operator" icon={<UserPlus className="w-4 h-4 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Deploys a dedicated DailySessionManager instance for the operator (BeaconProxy), registers them on it,
          seeds the current schedule config and replays the reward-type catalog. Requires DEFAULT_ADMIN_ROLE on the hub.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[11px] text-txt-secondary">Operator Wallet</label>
            <input value={opWallet} onChange={e => setOpWallet(e.target.value)} placeholder="0x..." className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Display Name</label>
            <input value={opName} onChange={e => setOpName(e.target.value)} placeholder="Operator name" className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Metadata URI (optional)</label>
            <input value={opMeta} onChange={e => setOpMeta(e.target.value)} placeholder="ipfs:// or https://" className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Payment Splitter {activeSplitter ? '(defaults to active splitter if blank)' : ''}</label>
            <input value={opSplitter} onChange={e => setOpSplitter(e.target.value)} placeholder={activeSplitter || '0x...'} className={inputCls} />
          </div>
        </div>
        <button
          onClick={registerOperator}
          disabled={!isConnected || !opWallet || !opName}
          className="bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors"
        >
          Register Operator
        </button>
        <TxStatus {...txStatus} chainId={chainId} />
      </Card>

      {/* Linked Contracts — every hub-level pointer to an external/recovered contract */}
      <Card title="Linked Contracts" icon={<Link2 className="w-4 h-4 text-accent" />}>
        <div className="space-y-4">
          {/* Link existing instance (recovery) */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Link Existing Instance</h5>
            <p className="text-[11px] text-txt-secondary">
              Recovery only — for an instance that already has its <code className="text-accent">hub</code> variable
              pointing at this GameHub (e.g. it was deployed manually) but was never created via Register Operator above,
              so it&apos;s missing from this registry. Its hub callbacks (<code className="text-accent">notifySessionCreated</code> /{' '}
              <code className="text-accent">notifyDayFinalized</code>) revert until linked — sessions still get created,
              but check that instance for a <code className="text-accent">HubNotifyFailed</code> event to confirm this is
              actually needed. Does not touch the instance&apos;s own operator role or reward catalog.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] text-txt-secondary">Operator Wallet</label>
                <input value={linkWallet} onChange={e => setLinkWallet(e.target.value)} placeholder="0x..." className={inputCls} />
              </div>
              <div>
                <label className="text-[11px] text-txt-secondary">Instance Address</label>
                <input value={linkInstance} onChange={e => setLinkInstance(e.target.value)} placeholder="0x..." className={inputCls} />
              </div>
              <div>
                <label className="text-[11px] text-txt-secondary">Display Name</label>
                <input value={linkName} onChange={e => setLinkName(e.target.value)} placeholder="Operator name" className={inputCls} />
              </div>
            </div>
            <button
              onClick={linkExistingInstance}
              disabled={!isConnected || !linkWallet || !linkInstance || !linkName}
              className="bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-6 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Link Instance
            </button>
          </div>

          {/* Reward Eligibility Registry */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Reward Eligibility Registry</h5>
            <p className="text-[11px] text-txt-secondary">Wires the hub to a RewardEligibilityRegistry contract. Once set, claimDailyPrBoost on every operator instance checks it for eligibility and caps the daily boost — same registry no matter which instance a wallet claims through.</p>
            <p className="text-[11px] text-txt-secondary break-all">Current: <span className="text-accent font-semibold font-mono">{rewardEligibilityRegistryOnChain && rewardEligibilityRegistryOnChain !== ethers.constants.AddressZero ? rewardEligibilityRegistryOnChain : 'Not set (unlimited)'}</span></p>
            <input value={rewardEligibilityRegistryInput} onChange={e => setRewardEligibilityRegistryInput(e.target.value)} placeholder="0x..." className={inputCls} />
            <div className="flex gap-2">
              <button onClick={setRewardEligibilityRegistry} disabled={!isConnected} className="flex-1 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">Set Registry</button>
              <button onClick={clearRewardEligibilityRegistry} disabled={!isConnected || !rewardEligibilityRegistryOnChain || rewardEligibilityRegistryOnChain === ethers.constants.AddressZero} className="flex-1 bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Clear (Unlimited)</button>
            </div>
          </div>

          {/* File */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">File</h5>
            <p className="text-[11px] text-txt-secondary">A generic pointer the hub resolves through — <code className="text-accent">GameHub.accessControl()</code> calls <code className="text-accent">Ifile(file).accessControl()</code> on whatever&apos;s set here to reach the real ATMAccessControl contract. Once set, redeeming a negative-value Reward voucher on any operator instance resolves its payout redirect target through it — same contract no matter which instance a wallet redeems through.</p>
            <p className="text-[10px] text-yellow-400/70">⚠ Until this is set, redeeming a negative-value Reward voucher reverts (AccessControlNotSet).</p>
            <p className="text-[11px] text-txt-secondary break-all">Current: <span className="text-accent font-semibold font-mono">{accessControlOnChain && accessControlOnChain !== ethers.constants.AddressZero ? accessControlOnChain : 'Not set'}</span></p>
            <input value={accessControlInput} onChange={e => setAccessControlInput(e.target.value)} placeholder="0x..." className={inputCls} />
            <div className="flex gap-2">
              <button onClick={setAccessControl} disabled={!isConnected} className="flex-1 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">Set File</button>
              <button onClick={clearAccessControl} disabled={!isConnected || !accessControlOnChain || accessControlOnChain === ethers.constants.AddressZero} className="flex-1 bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Clear</button>
            </div>
          </div>

          {/* ATM Voucher */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">ATM Voucher</h5>
            <p className="text-[11px] text-txt-secondary">Wires the hub to the deployed ATMVoucher contract, so every operator instance can resolve it live no matter which instance a wallet redeems through.</p>
            <p className="text-[11px] text-txt-secondary break-all">Current: <span className="text-accent font-semibold font-mono">{atmVoucherOnChain && atmVoucherOnChain !== ethers.constants.AddressZero ? atmVoucherOnChain : 'Not set'}</span></p>
            <input value={atmVoucherInput} onChange={e => setAtmVoucherInput(e.target.value)} placeholder="0x..." className={inputCls} />
            <div className="flex gap-2">
              <button onClick={setAtmVoucher} disabled={!isConnected} className="flex-1 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">Set ATM Voucher</button>
              <button onClick={clearAtmVoucher} disabled={!isConnected || !atmVoucherOnChain || atmVoucherOnChain === ethers.constants.AddressZero} className="flex-1 bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Clear</button>
            </div>
          </div>
        </div>
      </Card>

      {/* Operator registry */}
      <Card title={`Operator Registry (${operators.length})`}>
        {operators.length === 0 && !loading && (
          <p className="text-txt-secondary text-sm text-center py-6">No operators registered yet. Register the first one above.</p>
        )}
        <div className="space-y-2">
          {operators.map(op => {
            const isActive = sessionManagerAddress && sessionManagerAddress.toLowerCase() === op.instance.toLowerCase();
            return (
              <div key={op.address} className={`bg-surface-tertiary rounded-lg p-3 ${isActive ? 'ring-1 ring-accent' : ''}`}>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${op.active ? 'bg-green-400' : 'bg-red-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{op.name || 'Unnamed'}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${op.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {op.active ? 'ACTIVE' : 'DEACTIVATED'}
                      </span>
                      {isActive && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-accent/20 text-accent flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" /> IN USE
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-txt-secondary flex-wrap">
                      <span>Wallet: <code className="font-mono">{fmtAddr(op.address)}</code></span>
                      <span className="flex items-center gap-1">
                        Instance: <code className="font-mono text-accent">{fmtAddr(op.instance)}</code>
                        <button onClick={() => copyAddr(op.instance, op.address)}>
                          {copied === op.address ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}
                        </button>
                        <a href={getExplorerAddressUrl(chainId, op.instance)} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-3 h-3 hover:text-accent" />
                        </a>
                      </span>
                      <span>Registered: {fmtDate(op.registeredAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => useInstance(op)}
                      disabled={!!isActive}
                      className="bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-1.5 rounded-lg text-xs transition-colors"
                    >
                      {isActive ? 'In Use' : 'Use Instance'}
                    </button>
                    {op.active && (
                      <button
                        onClick={() => removeOperator(op.address)}
                        disabled={!isConnected}
                        className="flex items-center gap-1 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 font-medium px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-40"
                      >
                        <UserMinus className="w-3.5 h-3.5" /> Deactivate
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {loading && operators.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-6">
            <RefreshCw className="w-4 h-4 animate-spin text-accent" />
            <span className="text-txt-secondary text-sm">Loading operators...</span>
          </div>
        )}
      </Card>
    </div>
  );
}
