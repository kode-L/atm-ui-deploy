'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import { Network, RefreshCw, UserPlus, UserMinus, CheckCircle, Copy, Check, ExternalLink, Link2, IdCard, Ticket } from 'lucide-react';
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
  rewardEligibilityRegistry: string;
  atmVoucher: string;
}

export default function HubSection() {
  const { provider, signer, isConnected, hubAddress, sessionManagerAddress, setSessionManagerAddress, activeSplitter, chainId, rewardEligibilityRegistryAddress, atmVoucherAddress } = useWeb3();
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

  // Linked contracts (setRewardEligibilityRegistry / setATMVoucher on the hub itself —
  // separate from the useWeb3 addresses below, which just pick which contract each standalone
  // tab points at; these two calls are what actually make GameHub reference them on-chain).
  const [newRewardRegistry, setNewRewardRegistry] = useState('');
  const [newAtmVoucher, setNewAtmVoucher] = useState('');

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
      const [adminWallet, paymentToken, beacon, impl, offset, duration, grace, prBoostGrace, rewardEligibilityRegistry, atmVoucher, opAddrs] = await Promise.all([
        hub.adminWallet(),
        hub.paymentToken(),
        hub.beacon(),
        hub.instanceImplementation(),
        hub.sessionStartOffset(),
        hub.sessionDuration(),
        hub.finalizationGracePeriod(),
        hub.prBoostGracePeriod(),
        hub.rewardEligibilityRegistry(),
        hub.atmVoucher(),
        hub.getOperators(),
      ]);
      setHubInfo({
        adminWallet,
        paymentToken,
        beacon,
        instanceImplementation: impl,
        sessionStartOffset: Number(offset),
        sessionDuration: Number(duration),
        finalizationGracePeriod: Number(grace),
        prBoostGracePeriod: Number(prBoostGrace),
        rewardEligibilityRegistry,
        atmVoucher,
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

  // Convenience pre-fill from whatever's loaded in the standalone Reward Eligibility
  // Registry / ATM Vouchers tabs — still freely editable, and only fills once (won't
  // clobber a manually-typed value or overwrite after the field's been touched).
  useEffect(() => { if (rewardEligibilityRegistryAddress && !newRewardRegistry) setNewRewardRegistry(rewardEligibilityRegistryAddress); }, [rewardEligibilityRegistryAddress, newRewardRegistry]);
  useEffect(() => { if (atmVoucherAddress && !newAtmVoucher) setNewAtmVoucher(atmVoucherAddress); }, [atmVoucherAddress, newAtmVoucher]);

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

  const handleSetRewardRegistry = async () => {
    const hub = getHub(true);
    const target = newRewardRegistry.trim();
    if (!hub || !ethers.utils.isAddress(target)) {
      setTxStatus({ status: 'error', error: 'Invalid Reward Eligibility Registry address' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Linking Reward Eligibility Registry to the hub...' });
    try {
      const tx = await hub.setRewardEligibilityRegistry(target);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `GameHub now references Reward Eligibility Registry at ${target}.` });
      setNewRewardRegistry('');
      fetchAll();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleSetAtmVoucher = async () => {
    const hub = getHub(true);
    const target = newAtmVoucher.trim();
    if (!hub || !ethers.utils.isAddress(target)) {
      setTxStatus({ status: 'error', error: 'Invalid ATM Voucher address' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Linking ATM Voucher to the hub...' });
    try {
      const tx = await hub.setATMVoucher(target);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `GameHub now references ATM Voucher at ${target}.` });
      setNewAtmVoucher('');
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

  const isZero = (a: string) => !a || a === ethers.constants.AddressZero;
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
            <div>
              <p className="text-[11px] text-txt-secondary">Reward Eligibility Registry</p>
              {isZero(hubInfo.rewardEligibilityRegistry) ? (
                <p className="font-medium text-yellow-400">Not linked</p>
              ) : (
                <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.rewardEligibilityRegistry)}</code>
              )}
            </div>
            <div>
              <p className="text-[11px] text-txt-secondary">ATM Voucher</p>
              {isZero(hubInfo.atmVoucher) ? (
                <p className="font-medium text-yellow-400">Not linked</p>
              ) : (
                <code className="text-xs text-accent font-mono">{fmtAddr(hubInfo.atmVoucher)}</code>
              )}
            </div>
          </div>
          <p className="text-[11px] text-txt-secondary mt-3">
            Schedule config and the reward-type catalog are managed on the hub (Admin tab) and broadcast to every active instance.
          </p>
        </Card>
      )}

      {/* Linked contracts */}
      <Card title="Linked Contracts" icon={<Link2 className="w-4 h-4 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Points the hub at the standalone Reward Eligibility Registry / ATM Voucher deployments so GameHub can reference them on-chain — separate from which address each of those tabs itself talks to. Requires DEFAULT_ADMIN_ROLE on the hub.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-3">
            <label className="text-[11px] text-txt-secondary flex items-center gap-1 mb-1.5"><IdCard className="w-3.5 h-3.5" /> Reward Eligibility Registry</label>
            {hubInfo && (
              isZero(hubInfo.rewardEligibilityRegistry) ? (
                <div className="flex items-center gap-1.5 mb-2 text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                  <span className="text-red-400 font-medium">Not Linked</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 mb-2 text-xs flex-wrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                  <span className="text-green-400 font-medium">Linked</span>
                  <code className="text-txt-secondary font-mono">{fmtAddr(hubInfo.rewardEligibilityRegistry)}</code>
                </div>
              )
            )}
            <input value={newRewardRegistry} onChange={e => setNewRewardRegistry(e.target.value)} placeholder="0x..." className={`${inputCls} mb-2`} />
            <button
              onClick={handleSetRewardRegistry}
              disabled={!isConnected || !newRewardRegistry.trim()}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2 rounded-lg text-sm transition-colors"
            >
              Set Reward Eligibility Registry
            </button>
          </div>
          <div className="bg-surface-tertiary rounded-lg p-3">
            <label className="text-[11px] text-txt-secondary flex items-center gap-1 mb-1.5"><Ticket className="w-3.5 h-3.5" /> ATM Voucher</label>
            {hubInfo && (
              isZero(hubInfo.atmVoucher) ? (
                <div className="flex items-center gap-1.5 mb-2 text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                  <span className="text-red-400 font-medium">Not Linked</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 mb-2 text-xs flex-wrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                  <span className="text-green-400 font-medium">Linked</span>
                  <code className="text-txt-secondary font-mono">{fmtAddr(hubInfo.atmVoucher)}</code>
                </div>
              )
            )}
            <input value={newAtmVoucher} onChange={e => setNewAtmVoucher(e.target.value)} placeholder="0x..." className={`${inputCls} mb-2`} />
            <button
              onClick={handleSetAtmVoucher}
              disabled={!isConnected || !newAtmVoucher.trim()}
              className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2 rounded-lg text-sm transition-colors"
            >
              Set ATM Voucher
            </button>
          </div>
        </div>
      </Card>

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

      {/* Link existing instance (recovery) */}
      <Card title="Link Existing Instance" icon={<Link2 className="w-4 h-4 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Recovery only — for an instance that already has its <code className="text-accent">hub</code> variable
          pointing at this GameHub (e.g. it was deployed manually) but was never created via Register Operator above,
          so it&apos;s missing from this registry. Its hub callbacks (<code className="text-accent">notifySessionCreated</code> /{' '}
          <code className="text-accent">notifyDayFinalized</code>) revert until linked — sessions still get created,
          but check that instance for a <code className="text-accent">HubNotifyFailed</code> event to confirm this is
          actually needed. Does not touch the instance&apos;s own operator role or reward catalog.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
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
