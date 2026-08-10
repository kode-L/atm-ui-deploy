'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { getExplorerAddressUrl, REWARD_ELIGIBILITY_REGISTRY_PROPOSAL_TYPE_LABELS } from '@/lib/contracts/config';
import RegistryArtifact from '@/lib/contracts/RewardEligibilityRegistry.json';
import RegistryProxyArtifact from '@/lib/contracts/RewardEligibilityRegistryProxy.json';
import {
  Rocket, ExternalLink, Copy, Check, RefreshCw, UserCog, UserPlus, IdCard, Vote,
  ShieldCheck, KeyRound, Landmark, ListChecks, Plus, Trash2, Search, ArrowUpCircle,
  ThumbsUp, ThumbsDown, AlertTriangle, Lock, Unlock, FileSignature, UserCheck,
} from 'lucide-react';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };

interface OperatorRow { address: string; allowed: boolean; }
interface TypeRow { id: number; maxClaimablePoints: string; exists: boolean; }
interface ProposalRow {
  id: number;
  proposalType: number; // 0 = WalletTypeChange, 1 = TypeConfig
  approvalCount: number;
  snapshotThreshold: number;
  executed: boolean;
  cancelled: boolean;
  proposer: string;
  wallets?: string[];
  newTypeIds?: number[];
  typeIds?: number[];
  maxPointsList?: string[];
  approvedByMe?: boolean;
}

interface TypePreset { typeId: string; maxPoints: string; }

// Starting point for the editable preset list below — restorable via "Reset to Defaults".
// Editing/adding/removing rows in the UI persists to localStorage (not chain-specific data,
// so unlike contract addresses this list isn't namespaced per network).
const INITIAL_TYPE_PRESETS: TypePreset[] = [
  { typeId: '1', maxPoints: '500' },
  { typeId: '2', maxPoints: '2000' },
  { typeId: '3', maxPoints: '3000' },
  { typeId: '4', maxPoints: '5000' },
];
const TYPE_PRESETS_STORAGE_KEY = 'dg_rewardEligibilityRegistryTypePresets';

const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';
const fmtAddr = (a: string) => a ? `${a.slice(0, 8)}...${a.slice(-6)}` : '—';
const isZero = (a: string) => !a || a === ethers.constants.AddressZero;

// Mirrors RewardEligibilityRegistry._getDigest: keccak256("\x19\x01" || DOMAIN_SEPARATOR ||
// keccak256(abi.encode(wallet, typeId, expiration))). DOMAIN_SEPARATOR is read straight off
// the contract, so this only ever needs to replicate the struct-hash + 0x1901 wrapping.
const computeSelfRegisterDigest = (domainSeparator: string, wallet: string, typeId: number, expiration: number) => {
  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'uint256'], [wallet, typeId, expiration])
  );
  return ethers.utils.keccak256(ethers.utils.hexConcat(['0x1901', domainSeparator, structHash]));
};

export default function RewardEligibilityRegistrySection() {
  const { provider, signer, isConnected, address, rewardEligibilityRegistryAddress, setRewardEligibilityRegistryAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');

  const copyAddr = (addr: string, label: string) => {
    navigator.clipboard?.writeText?.(addr);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
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

  // ── Deploy ──
  const [implAddress, setImplAddress] = useState('');
  const [manualLoad, setManualLoad] = useState('');

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying RewardEligibilityRegistry implementation...' });
    try {
      const factory = new ethers.ContractFactory(RegistryArtifact.abi, RegistryArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now deploy the proxy.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Proxy constructor deploys + delegatecalls __RewardEligibilityRegistry_init() atomically —
  // the connected wallet becomes both proxy admin and contract owner in one transaction.
  const deployProxy = async () => {
    if (!signer || !implAddress) return;
    setTxStatus({ status: 'pending', message: 'Deploying proxy + initializing...' });
    try {
      const factory = new ethers.ContractFactory(RegistryProxyArtifact.abi, RegistryProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      setRewardEligibilityRegistryAddress(proxy.address);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `RewardEligibilityRegistry deployed at ${proxy.address}. You are the owner — add operators below before proposing types or registering wallets.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const loadExisting = () => {
    if (!ethers.utils.isAddress(manualLoad.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid address' });
      return;
    }
    setRewardEligibilityRegistryAddress(manualLoad.trim());
    setManualLoad('');
    setTxStatus({ status: 'idle' });
  };

  // ── Contract instances ──
  const getRead = useCallback(() => {
    if (!provider || !rewardEligibilityRegistryAddress) return null;
    return new ethers.Contract(rewardEligibilityRegistryAddress, RegistryArtifact.abi, provider);
  }, [provider, rewardEligibilityRegistryAddress]);
  const getWrite = useCallback(() => {
    if (!signer || !rewardEligibilityRegistryAddress) return null;
    return new ethers.Contract(rewardEligibilityRegistryAddress, RegistryArtifact.abi, signer);
  }, [signer, rewardEligibilityRegistryAddress]);
  // Proxy-level calls (admin/logic/changeAdmin/upgrad) hit the proxy's OWN functions, not
  // the implementation via delegatecall — a separate ABI/instance at the same address.
  const getProxyRead = useCallback(() => {
    if (!provider || !rewardEligibilityRegistryAddress) return null;
    return new ethers.Contract(rewardEligibilityRegistryAddress, RegistryProxyArtifact.abi, provider);
  }, [provider, rewardEligibilityRegistryAddress]);
  const getProxyWrite = useCallback(() => {
    if (!signer || !rewardEligibilityRegistryAddress) return null;
    return new ethers.Contract(rewardEligibilityRegistryAddress, RegistryProxyArtifact.abi, signer);
  }, [signer, rewardEligibilityRegistryAddress]);

  // ── Overview ──
  const [ownerAddr, setOwnerAddr] = useState('');
  const [pendingOwnerAddr, setPendingOwnerAddr] = useState('');
  const [adminAddr, setAdminAddr] = useState('');
  const [logicAddr, setLogicAddr] = useState('');
  const [versionStr, setVersionStr] = useState('');
  const [thresholdVal, setThresholdVal] = useState(0);
  const [maxThresholdVal, setMaxThresholdVal] = useState(0);
  const [proposalCountVal, setProposalCountVal] = useState(0);
  const [isConnectedOperator, setIsConnectedOperator] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [efficacyContractAddr, setEfficacyContractAddr] = useState('');
  const [domainSeparator, setDomainSeparator] = useState('');
  // False on a pre-v1.1.0 implementation, which has no selfRegister() at all.
  const [supportsSelfRegister, setSupportsSelfRegister] = useState(true);
  const [overviewLoadError, setOverviewLoadError] = useState('');

  const fetchOverview = useCallback(async () => {
    const reg = getRead();
    const prox = getProxyRead();
    if (!reg || !prox) return;
    setOverviewLoading(true);
    setOverviewLoadError('');
    try {
      // Promise.allSettled, not Promise.all — one failing call (e.g. an older/mismatched
      // address without prox.admin()) used to blank out every field, including `owner`,
      // which silently hid the owner-only Add Operator / Propose Type Config UI below with
      // no visible explanation.
      const labels = ['owner', 'pendingOwner', 'admin', 'logic', 'version', 'proposalThreshold', 'MAX_PROPOSAL_THRESHOLD', 'proposalCount'];
      const results = await Promise.allSettled([
        reg.owner(), reg.pendingOwner(), prox.admin(), prox.logic(), reg.version(),
        reg.proposalThreshold(), reg.MAX_PROPOSAL_THRESHOLD(), reg.proposalCount(),
      ]);
      const [owner, pendingOwner, admin, logic, version, threshold, maxThreshold, count] = results.map(r => r.status === 'fulfilled' ? r.value : undefined);
      const firstFailure = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (firstFailure) {
        const failedLabel = labels[results.indexOf(firstFailure)];
        setOverviewLoadError(`Failed to read "${failedLabel}" from ${rewardEligibilityRegistryAddress} — ${decodeError(firstFailure.reason)}. Double-check this address is the Reward Eligibility Registry proxy on the network your wallet is connected to.`);
      }
      if (owner !== undefined) setOwnerAddr(owner);
      if (pendingOwner !== undefined) setPendingOwnerAddr(pendingOwner);
      if (admin !== undefined) setAdminAddr(admin);
      if (logic !== undefined) setLogicAddr(logic);
      if (version !== undefined) setVersionStr(version);
      if (threshold !== undefined) setThresholdVal(threshold?.toNumber?.() ?? Number(threshold));
      if (maxThreshold !== undefined) setMaxThresholdVal(maxThreshold?.toNumber?.() ?? Number(maxThreshold));
      if (count !== undefined) setProposalCountVal(count?.toNumber?.() ?? Number(count));
      // efficacyContract/DOMAIN_SEPARATOR only exist on v1.1.0+ implementations — fetched
      // separately so an older deployment (pre-signed-self-register) doesn't fail the whole
      // overview load.
      try {
        const [efficacy, domSep] = await Promise.all([reg.efficacyContract(), reg.DOMAIN_SEPARATOR()]);
        setEfficacyContractAddr(efficacy);
        setDomainSeparator(domSep);
        setSupportsSelfRegister(true);
      } catch {
        setEfficacyContractAddr('');
        setDomainSeparator('');
        setSupportsSelfRegister(false);
      }
      if (address) {
        try {
          const allowed = await reg.operators(address);
          setIsConnectedOperator(!!allowed);
        } catch {
          setIsConnectedOperator(false);
        }
      } else {
        setIsConnectedOperator(false);
      }
    } catch (e) {
      console.error('fetch registry overview:', e);
      setOverviewLoadError(decodeError(e));
    } finally {
      setOverviewLoading(false);
    }
  }, [getRead, getProxyRead, address]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const isOwnerConnected = !!(isConnected && ownerAddr && address?.toLowerCase() === ownerAddr.toLowerCase());
  const isPendingOwnerConnected = !!(isConnected && !isZero(pendingOwnerAddr) && address?.toLowerCase() === pendingOwnerAddr.toLowerCase());
  const isAdminConnected = !!(isConnected && adminAddr && address?.toLowerCase() === adminAddr.toLowerCase());

  const acceptOwnership = async () => {
    const reg = getWrite();
    if (!reg) return;
    setTxStatus({ status: 'pending', message: 'Accepting ownership...' });
    try {
      const tx = await reg.acceptOwnership();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Ownership accepted!' });
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Ownership transfer & threshold ──
  const [transferTo, setTransferTo] = useState('');
  const [newThreshold, setNewThreshold] = useState('2');

  const handleTransferOwnership = async () => {
    const reg = getWrite();
    if (!reg || !ethers.utils.isAddress(transferTo.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid new owner address' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Initiating ownership transfer...' });
    try {
      const tx = await reg.transferOwnership(transferTo.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Transfer initiated — ${transferTo.trim()} must call Accept Ownership to complete it.` });
      setTransferTo('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleSetThreshold = async () => {
    const reg = getWrite();
    if (!reg) return;
    const t = parseInt(newThreshold);
    if (!t || t < 2 || t > maxThresholdVal) {
      setTxStatus({ status: 'error', error: `Threshold must be between 2 and ${maxThresholdVal}` });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Updating proposal threshold...' });
    try {
      const tx = await reg.setProposalThreshold(t);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proposal threshold set to ${t}.` });
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Efficacy contract (self-register gate) ──
  const [newEfficacyAddr, setNewEfficacyAddr] = useState('');

  const handleSetEfficacyContract = async (clear?: boolean) => {
    const reg = getWrite();
    if (!reg) return;
    const target = clear ? ethers.constants.AddressZero : newEfficacyAddr.trim();
    if (!clear && !ethers.utils.isAddress(target)) {
      setTxStatus({ status: 'error', error: 'Invalid efficacy contract address' });
      return;
    }
    setTxStatus({ status: 'pending', message: clear ? 'Disabling self-register gate...' : 'Setting efficacy contract...' });
    try {
      const tx = await reg.setEfficacyContract(target);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: clear ? 'Self-register gate disabled — anyone can self-register directly.' : `Self-register gate enabled via ${target}.` });
      setNewEfficacyAddr('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Operators ──
  const [operatorInput, setOperatorInput] = useState('');
  const [knownOperators, setKnownOperators] = useState<OperatorRow[]>([]);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const [lookupOperatorAddr, setLookupOperatorAddr] = useState('');

  const fetchOperators = useCallback(async () => {
    const reg = getRead();
    if (!reg) return;
    setOperatorsLoading(true);
    try {
      const currentBlock = await reg.provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50000);
      const events = await reg.queryFilter(reg.filters.OperatorSet(), fromBlock, 'latest');
      const latest = new Map<string, boolean>();
      for (const ev of events) {
        const args: any = (ev as any).args;
        latest.set(args.operator.toLowerCase(), !!args.allowed);
      }
      const rows: OperatorRow[] = Array.from(latest.entries()).map(([addr, allowed]) => ({ address: addr, allowed }));
      rows.sort((a, b) => (a.allowed === b.allowed ? 0 : a.allowed ? -1 : 1));
      setKnownOperators(rows);
    } catch (e) {
      console.error('fetch operators:', e);
    } finally {
      setOperatorsLoading(false);
    }
  }, [getRead]);

  useEffect(() => { fetchOperators(); }, [fetchOperators]);

  const handleSetOperator = async (opAddr: string, allowed: boolean) => {
    const reg = getWrite();
    if (!reg || !ethers.utils.isAddress(opAddr.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid operator address' });
      return;
    }
    setTxStatus({ status: 'pending', message: `${allowed ? 'Adding' : 'Removing'} operator...` });
    try {
      const tx = await reg.setOperator(opAddr.trim(), allowed);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Operator ${opAddr.trim()} ${allowed ? 'added' : 'removed'}.` });
      setOperatorInput('');
      await Promise.all([fetchOperators(), fetchOverview()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleLookupOperator = async () => {
    const reg = getRead();
    if (!reg || !ethers.utils.isAddress(lookupOperatorAddr.trim())) return;
    try {
      const allowed = await reg.operators(lookupOperatorAddr.trim());
      const addr = lookupOperatorAddr.trim().toLowerCase();
      setKnownOperators(prev => {
        const filtered = prev.filter(r => r.address !== addr);
        return [{ address: addr, allowed: !!allowed }, ...filtered];
      });
      setLookupOperatorAddr('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Type Config (reward types + max claim) ──
  const [proposeTypeId, setProposeTypeId] = useState('');
  const [proposeMaxPoints, setProposeMaxPoints] = useState('');
  const [knownTypes, setKnownTypes] = useState<TypeRow[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [lookupTypeId, setLookupTypeId] = useState('');

  const fetchTypes = useCallback(async () => {
    const reg = getRead();
    if (!reg) return;
    setTypesLoading(true);
    try {
      const currentBlock = await reg.provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50000);
      const events = await reg.queryFilter(reg.filters.TypeConfigured(), fromBlock, 'latest');
      const seen = new Map<number, string>();
      for (const ev of events) {
        const args: any = (ev as any).args;
        const id = args.typeId?.toNumber?.() ?? Number(args.typeId);
        seen.set(id, ethers.utils.formatEther(args.maxClaimablePoints));
      }
      const rows: TypeRow[] = Array.from(seen.entries()).map(([id, maxClaimablePoints]) => ({ id, maxClaimablePoints, exists: true }));
      rows.sort((a, b) => a.id - b.id);
      setKnownTypes(rows);
    } catch (e) {
      console.error('fetch types:', e);
    } finally {
      setTypesLoading(false);
    }
  }, [getRead]);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  const handleProposeTypeConfig = async () => {
    const reg = getWrite();
    const typeId = parseInt(proposeTypeId);
    const maxPoints = proposeMaxPoints.trim();
    if (!reg || !proposeTypeId || isNaN(typeId) || typeId < 0) {
      setTxStatus({ status: 'error', error: 'Enter a valid type ID' });
      return;
    }
    let maxPointsBN: ethers.BigNumber;
    try { maxPointsBN = ethers.utils.parseEther(maxPoints || '0'); } catch {
      setTxStatus({ status: 'error', error: 'Max claimable points must be a valid number (up to 18 decimal places)' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Proposing type config...' });
    try {
      const tx = await reg.proposeTypeConfig(typeId, maxPointsBN);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proposal created for type #${typeId}. It needs ${thresholdVal} operator approvals (see Proposals below) before it takes effect.` });
      setProposeTypeId('');
      setProposeMaxPoints('');
      await fetchProposals();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleLookupType = async () => {
    const reg = getRead();
    const id = parseInt(lookupTypeId);
    if (!reg || isNaN(id) || id < 0) return;
    try {
      const [maxPoints, exists] = await reg.typeConfig(id);
      setKnownTypes(prev => {
        const filtered = prev.filter(r => r.id !== id);
        return [...filtered, { id, maxClaimablePoints: ethers.utils.formatEther(maxPoints), exists }].sort((a, b) => a.id - b.id);
      });
      setLookupTypeId('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Default type presets — one-click proposal creation ──
  // Frontend convenience only: each preset still goes through the normal proposeTypeConfig
  // call, so it's still just a proposal auto-approved by you as proposer (approvalCount=1) —
  // it takes effect once it also clears the proposal threshold, same as the manual form above.
  const [typePresets, setTypePresets] = useState<TypePreset[]>(INITIAL_TYPE_PRESETS);
  const [presetStatus, setPresetStatus] = useState<Record<number, boolean>>({}); // keyed by row index, not typeId — rows are freely editable/duplicable
  const [presetBusyIndex, setPresetBusyIndex] = useState<number | null>(null); // row index currently being proposed, or -1 for "all"

  // Loaded after mount (localStorage isn't available during SSR) — starts from
  // INITIAL_TYPE_PRESETS above until a saved list, if any, overrides it.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TYPE_PRESETS_STORAGE_KEY);
      if (saved) setTypePresets(JSON.parse(saved));
    } catch { /* corrupt storage — keep defaults */ }
  }, []);

  const savePresets = (next: TypePreset[]) => {
    setTypePresets(next);
    try { localStorage.setItem(TYPE_PRESETS_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage unavailable/full — edits still work this session */ }
  };
  const updatePresetRow = (i: number, field: keyof TypePreset, v: string) => savePresets(typePresets.map((p, idx) => idx === i ? { ...p, [field]: v } : p));
  const addPresetRow = () => savePresets([...typePresets, { typeId: '', maxPoints: '' }]);
  const removePresetRow = (i: number) => savePresets(typePresets.filter((_, idx) => idx !== i));
  const resetPresetsToDefault = () => savePresets(INITIAL_TYPE_PRESETS);

  const fetchPresetStatus = useCallback(async () => {
    const reg = getRead();
    if (!reg) return;
    try {
      const results = await Promise.all(typePresets.map(p => {
        const id = parseInt(p.typeId);
        return isNaN(id) ? Promise.resolve([null, false]) : reg.typeConfig(id).catch(() => [null, false]);
      }));
      const next: Record<number, boolean> = {};
      results.forEach((r: any, i) => { next[i] = !!r[1]; });
      setPresetStatus(next);
    } catch (e) {
      console.error('fetch preset status:', e);
    }
  }, [getRead, typePresets]);

  useEffect(() => { fetchPresetStatus(); }, [fetchPresetStatus]);

  const proposePreset = async (typeId: number, maxPoints: string) => {
    const reg = getWrite();
    if (!reg) return false;
    try {
      const tx = await reg.proposeTypeConfig(typeId, ethers.utils.parseEther(maxPoints || '0'));
      setTxStatus({ status: 'pending', hash: tx.hash, message: `Waiting for confirmation (type #${typeId})...` });
      await tx.wait();
      return true;
    } catch (e: any) {
      setTxStatus({ status: 'error', error: `Type #${typeId}: ${decodeError(e)}` });
      return false;
    }
  };

  const handleProposeOnePreset = async (index: number) => {
    const preset = typePresets[index];
    const typeId = parseInt(preset?.typeId ?? '');
    if (!preset || isNaN(typeId) || typeId < 0) {
      setTxStatus({ status: 'error', error: 'Enter a valid type ID for this preset' });
      return;
    }
    setPresetBusyIndex(index);
    setTxStatus({ status: 'pending', message: `Proposing type #${typeId} (max ${preset.maxPoints})...` });
    const ok = await proposePreset(typeId, preset.maxPoints);
    if (ok) {
      setTxStatus({ status: 'success', message: `Type #${typeId} proposed and auto-approved by you. Needs ${Math.max(0, thresholdVal - 1) || 'more'} additional operator approval(s) to take effect (see Proposals below).` });
      await Promise.all([fetchPresetStatus(), fetchTypes(), fetchProposals()]);
    }
    setPresetBusyIndex(null);
  };

  // One proposal covering every missing preset (proposeTypeConfigBatch), not one per type —
  // so operators approve it once instead of once per type.
  const handleProposeAllPresets = async () => {
    const reg = getWrite();
    if (!reg) return;
    const missing = typePresets.filter((p, i) => !isNaN(parseInt(p.typeId)) && !presetStatus[i]);
    if (missing.length === 0) {
      setTxStatus({ status: 'success', message: 'All presets are already configured — nothing to propose.' });
      return;
    }
    const typeIds = missing.map(p => parseInt(p.typeId));
    let maxPointsList: ethers.BigNumber[];
    try {
      maxPointsList = missing.map(p => ethers.utils.parseEther(p.maxPoints || '0'));
    } catch {
      setTxStatus({ status: 'error', error: 'Max claimable points must be valid numbers (up to 18 decimal places)' });
      return;
    }
    setPresetBusyIndex(-1);
    setTxStatus({ status: 'pending', message: `Proposing ${missing.length} type(s) in a single proposal...` });
    try {
      const tx = await reg.proposeTypeConfigBatch(typeIds, maxPointsList);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `1 proposal created covering ${missing.length} type(s), auto-approved by you. Needs ${Math.max(0, thresholdVal - 1) || 'more'} additional operator approval(s) to take effect (see Proposals below).` });
      await Promise.all([fetchPresetStatus(), fetchTypes(), fetchProposals()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
    setPresetBusyIndex(null);
  };

  // Same as handleProposeAllPresets, but covers EVERY row regardless of presetStatus —
  // for correcting already-configured types (e.g. a cap that was set with the wrong
  // decimal scaling), not just filling in ones that don't exist yet. Still one proposal.
  const handleRepairAllPresets = async () => {
    const reg = getWrite();
    if (!reg) return;
    const rows = typePresets.filter(p => !isNaN(parseInt(p.typeId)) && p.maxPoints.trim() !== '');
    if (rows.length === 0) {
      setTxStatus({ status: 'error', error: 'No valid type rows to propose — fill in Type ID and Max Claimable Points above.' });
      return;
    }
    const typeIds = rows.map(p => parseInt(p.typeId));
    let maxPointsList: ethers.BigNumber[];
    try {
      maxPointsList = rows.map(p => ethers.utils.parseEther(p.maxPoints || '0'));
    } catch {
      setTxStatus({ status: 'error', error: 'Max claimable points must be valid numbers (up to 18 decimal places)' });
      return;
    }
    setPresetBusyIndex(-2);
    setTxStatus({ status: 'pending', message: `Proposing ${rows.length} type(s) (including already-configured ones) in a single proposal...` });
    try {
      const tx = await reg.proposeTypeConfigBatch(typeIds, maxPointsList);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `1 proposal created covering ${rows.length} type(s) (overwrites existing configs on execution), auto-approved by you. Needs ${Math.max(0, thresholdVal - 1) || 'more'} additional operator approval(s) to take effect (see Proposals below).` });
      await Promise.all([fetchPresetStatus(), fetchTypes(), fetchProposals()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
    setPresetBusyIndex(null);
  };

  // ── Wallets: register + lookup + propose type change ──
  interface WalletRow { address: string; typeId: string; }
  const blankWalletRow = (): WalletRow => ({ address: '', typeId: '' });
  const [registerRows, setRegisterRows] = useState<WalletRow[]>([blankWalletRow()]);
  const updateRegisterRow = (i: number, field: keyof WalletRow, v: string) => setRegisterRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: v } : r));
  const addRegisterRow = () => setRegisterRows(prev => [...prev, blankWalletRow()]);
  const removeRegisterRow = (i: number) => setRegisterRows(prev => prev.filter((_, idx) => idx !== i));

  const handleRegisterWallets = async () => {
    const reg = getWrite();
    if (!reg) return;
    const wallets = registerRows.map(r => r.address.trim());
    const typeIds = registerRows.map(r => parseInt(r.typeId));
    for (let i = 0; i < wallets.length; i++) {
      if (!ethers.utils.isAddress(wallets[i])) {
        setTxStatus({ status: 'error', error: `Invalid address in row ${i + 1}` });
        return;
      }
      if (isNaN(typeIds[i])) {
        setTxStatus({ status: 'error', error: `Missing type ID in row ${i + 1}` });
        return;
      }
    }
    setTxStatus({ status: 'pending', message: `Registering ${wallets.length} wallet(s)...` });
    try {
      const tx = await reg.registerWallets(wallets, typeIds);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${wallets.length} wallet(s) registered.` });
      setRegisterRows([blankWalletRow()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const [lookupWalletAddr, setLookupWalletAddr] = useState('');
  const [walletLookupResult, setWalletLookupResult] = useState<{ registered: boolean; typeId?: number; maxPoints?: string } | null>(null);
  const [walletLookupError, setWalletLookupError] = useState('');

  const handleLookupWallet = async () => {
    const reg = getRead();
    if (!reg || !ethers.utils.isAddress(lookupWalletAddr.trim())) {
      setWalletLookupError('Invalid address');
      return;
    }
    setWalletLookupError('');
    setWalletLookupResult(null);
    try {
      const registered = await reg.isRegistered(lookupWalletAddr.trim());
      if (!registered) {
        setWalletLookupResult({ registered: false });
        return;
      }
      const [typeId, maxPoints] = await Promise.all([
        reg.walletType(lookupWalletAddr.trim()),
        reg.maxClaimablePoints(lookupWalletAddr.trim()),
      ]);
      setWalletLookupResult({ registered: true, typeId: typeId?.toNumber?.() ?? Number(typeId), maxPoints: ethers.utils.formatEther(maxPoints) });
    } catch (e: any) {
      setWalletLookupError(decodeError(e));
    }
  };

  const [typeChangeRows, setTypeChangeRows] = useState<WalletRow[]>([blankWalletRow()]);
  const updateTypeChangeRow = (i: number, field: keyof WalletRow, v: string) => setTypeChangeRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: v } : r));
  const addTypeChangeRow = () => setTypeChangeRows(prev => [...prev, blankWalletRow()]);
  const removeTypeChangeRow = (i: number) => setTypeChangeRows(prev => prev.filter((_, idx) => idx !== i));

  const handleProposeTypeChange = async () => {
    const reg = getWrite();
    if (!reg) return;
    const wallets = typeChangeRows.map(r => r.address.trim());
    const newTypeIds = typeChangeRows.map(r => parseInt(r.typeId));
    for (let i = 0; i < wallets.length; i++) {
      if (!ethers.utils.isAddress(wallets[i])) {
        setTxStatus({ status: 'error', error: `Invalid address in row ${i + 1}` });
        return;
      }
      if (isNaN(newTypeIds[i])) {
        setTxStatus({ status: 'error', error: `Missing new type ID in row ${i + 1}` });
        return;
      }
    }
    setTxStatus({ status: 'pending', message: 'Proposing wallet type change...' });
    try {
      const tx = await reg.proposeTypeChange(wallets, newTypeIds);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proposal created for ${wallets.length} wallet(s). It needs ${thresholdVal} operator approvals (see Proposals below) before it takes effect.` });
      setTypeChangeRows([blankWalletRow()]);
      await fetchProposals();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Self Registration ──
  const [selfRegTypeId, setSelfRegTypeId] = useState('');
  const [selfRegStatus, setSelfRegStatus] = useState<{ registered: boolean; typeId?: number } | null>(null);

  const fetchSelfRegStatus = useCallback(async () => {
    const reg = getRead();
    if (!reg || !address) { setSelfRegStatus(null); return; }
    try {
      const registered = await reg.isRegistered(address);
      if (!registered) { setSelfRegStatus({ registered: false }); return; }
      const typeId = await reg.walletType(address);
      setSelfRegStatus({ registered: true, typeId: typeId?.toNumber?.() ?? Number(typeId) });
    } catch {
      setSelfRegStatus(null);
    }
  }, [getRead, address]);

  useEffect(() => { fetchSelfRegStatus(); }, [fetchSelfRegStatus]);

  const handleUnsignedSelfRegister = async () => {
    const reg = getWrite();
    const typeId = parseInt(selfRegTypeId);
    if (!reg || isNaN(typeId) || typeId < 0) {
      setTxStatus({ status: 'error', error: 'Enter a valid type ID' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Self-registering...' });
    try {
      const tx = await reg['selfRegister(uint256)'](typeId);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Registered to type #${typeId}.` });
      setSelfRegTypeId('');
      await fetchSelfRegStatus();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Signing tool for operators — pre-signs the exact (wallet, typeId, expiration) a
  // requester will later submit. Sharing the resulting signature grants no access by
  // itself; the contract re-derives the digest from the real submission and only counts
  // it if it recovers to a registered operator.
  const [signWallet, setSignWallet] = useState('');
  const [signTypeId, setSignTypeId] = useState('');
  const [signExpiration, setSignExpiration] = useState('');
  const [signResult, setSignResult] = useState('');
  const [signError, setSignError] = useState('');

  useEffect(() => { if (address && !signWallet) setSignWallet(address); }, [address, signWallet]);

  const quickSetExpiration = (secondsFromNow: number) => {
    setSignExpiration(String(Math.floor(Date.now() / 1000) + secondsFromNow));
  };

  const handleSignForRegistration = async () => {
    setSignError('');
    setSignResult('');
    if (!signer || !domainSeparator) {
      setSignError('Connect a wallet and make sure the registry overview has loaded.');
      return;
    }
    if (!ethers.utils.isAddress(signWallet.trim())) { setSignError('Invalid wallet address'); return; }
    const typeId = parseInt(signTypeId);
    const expiration = parseInt(signExpiration);
    if (isNaN(typeId) || typeId < 0) { setSignError('Enter a valid type ID'); return; }
    if (isNaN(expiration) || expiration <= Math.floor(Date.now() / 1000)) { setSignError('Expiration must be a future unix timestamp'); return; }
    try {
      const digest = computeSelfRegisterDigest(domainSeparator, signWallet.trim(), typeId, expiration);
      const sig = await signer.signMessage(ethers.utils.arrayify(digest));
      setSignResult(sig);
    } catch (e: any) {
      setSignError(decodeError(e));
    }
  };

  // Submit form — the registering wallet (always msg.sender on-chain, regardless of what's
  // typed anywhere above) pastes the operator signatures collected out-of-band.
  const [submitTypeId, setSubmitTypeId] = useState('');
  const [submitExpiration, setSubmitExpiration] = useState('');
  const [submitCode, setSubmitCode] = useState('');
  const [submitSignatures, setSubmitSignatures] = useState<string[]>(['']);

  const updateSubmitSignature = (i: number, v: string) => setSubmitSignatures(prev => prev.map((s, idx) => idx === i ? v : s));
  const addSubmitSignature = () => setSubmitSignatures(prev => [...prev, '']);
  const removeSubmitSignature = (i: number) => setSubmitSignatures(prev => prev.filter((_, idx) => idx !== i));

  // Best-effort preview of which address each pasted signature recovers to — informational
  // only. The contract independently re-derives the digest from msg.sender at submission
  // time, so this preview is only meaningful once submitTypeId/submitExpiration match
  // exactly what was signed and the connected wallet is the one that will submit.
  const [signaturePreview, setSignaturePreview] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!address || !domainSeparator) { setSignaturePreview({}); return; }
    const typeId = parseInt(submitTypeId);
    const expiration = parseInt(submitExpiration);
    if (isNaN(typeId) || isNaN(expiration)) { setSignaturePreview({}); return; }
    const digest = computeSelfRegisterDigest(domainSeparator, address, typeId, expiration);
    const preview: Record<number, string> = {};
    submitSignatures.forEach((sig, i) => {
      if (!sig.trim()) return;
      try { preview[i] = ethers.utils.verifyMessage(ethers.utils.arrayify(digest), sig.trim()); } catch { preview[i] = 'invalid signature'; }
    });
    setSignaturePreview(preview);
  }, [address, domainSeparator, submitTypeId, submitExpiration, submitSignatures]);

  const handleSubmitSignedSelfRegister = async () => {
    const reg = getWrite();
    const typeId = parseInt(submitTypeId);
    const expiration = parseInt(submitExpiration);
    if (!reg) return;
    if (isNaN(typeId) || typeId < 0) { setTxStatus({ status: 'error', error: 'Enter a valid type ID' }); return; }
    if (isNaN(expiration)) { setTxStatus({ status: 'error', error: 'Enter a valid expiration (unix seconds)' }); return; }
    if (!/^0x[0-9a-fA-F]{64}$/.test(submitCode.trim())) { setTxStatus({ status: 'error', error: 'Code must be a 32-byte hex value (0x + 64 hex chars)' }); return; }
    const sigs = submitSignatures.map(s => s.trim()).filter(Boolean);
    if (sigs.length === 0) { setTxStatus({ status: 'error', error: 'Add at least one operator signature' }); return; }
    const vs: number[] = [];
    const rssMetadata: string[] = [];
    try {
      for (const sig of sigs) {
        const { v, r, s } = ethers.utils.splitSignature(sig);
        vs.push(v);
        rssMetadata.push(r, s);
      }
    } catch {
      setTxStatus({ status: 'error', error: 'One or more signatures could not be parsed — expected a 65-byte hex signature' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Submitting signed self-registration...' });
    try {
      const tx = await reg['selfRegister(uint256,uint256,bytes32,uint8[],bytes32[])'](typeId, expiration, submitCode.trim(), vs, rssMetadata);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Registered to type #${typeId}.` });
      setSubmitTypeId('');
      setSubmitExpiration('');
      setSubmitCode('');
      setSubmitSignatures(['']);
      await fetchSelfRegStatus();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Proposals ──
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const PAGE_SIZE = 20;
  const [pageStart, setPageStart] = useState(0); // lowest id currently shown

  const fetchProposals = useCallback(async (startOverride?: number) => {
    const reg = getRead();
    if (!reg) return;
    setProposalsLoading(true);
    try {
      const countRaw = await reg.proposalCount();
      const count = countRaw?.toNumber?.() ?? Number(countRaw);
      setProposalCountVal(count);
      const start = startOverride ?? Math.max(0, count - PAGE_SIZE);
      setPageStart(start);
      const ids = [];
      for (let i = count - 1; i >= start; i--) ids.push(i);

      const rows: ProposalRow[] = await Promise.all(ids.map(async (id) => {
        const p = await reg.proposals(id);
        const proposalType = p.proposalType;
        const base: ProposalRow = {
          id,
          proposalType,
          approvalCount: p.approvalCount?.toNumber?.() ?? Number(p.approvalCount),
          snapshotThreshold: p.snapshotThreshold?.toNumber?.() ?? Number(p.snapshotThreshold),
          executed: p.executed,
          cancelled: p.cancelled,
          proposer: p.proposer,
        };
        if (proposalType === 0) {
          const [wallets, newTypeIds] = await Promise.all([reg.getProposalWallets(id), reg.getProposalNewTypeIds(id)]);
          base.wallets = wallets;
          base.newTypeIds = newTypeIds.map((t: any) => t?.toNumber?.() ?? Number(t));
        } else {
          const [typeIds, maxPointsList] = await reg.getProposalTypeConfig(id);
          base.typeIds = typeIds.map((t: any) => t?.toNumber?.() ?? Number(t));
          base.maxPointsList = maxPointsList.map((m: any) => ethers.utils.formatEther(m));
        }
        if (address) {
          base.approvedByMe = await reg.hasApproved(id, address);
        }
        return base;
      }));
      setProposals(rows);
    } catch (e) {
      console.error('fetch proposals:', e);
    } finally {
      setProposalsLoading(false);
    }
  }, [getRead, address]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  const [expandedProposal, setExpandedProposal] = useState<number | null>(null);

  const handleApprove = async (id: number) => {
    const reg = getWrite();
    if (!reg) return;
    setTxStatus({ status: 'pending', message: `Approving proposal #${id}...` });
    try {
      const tx = await reg.approveProposal(id);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proposal #${id} approved.` });
      await Promise.all([fetchProposals(pageStart), fetchTypes()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleReject = async (id: number) => {
    const reg = getWrite();
    if (!reg) return;
    setTxStatus({ status: 'pending', message: `Rejecting proposal #${id}...` });
    try {
      const tx = await reg.rejectProposal(id);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proposal #${id} rejected.` });
      await fetchProposals(pageStart);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Proxy admin (upgrade implementation, change admin) ──
  const [newImplAddress, setNewImplAddress] = useState('');
  const [newImplVersion, setNewImplVersion] = useState('');
  const [newAdminAddr, setNewAdminAddr] = useState('');

  useEffect(() => {
    if (!provider || !newImplAddress || !ethers.utils.isAddress(newImplAddress)) {
      setNewImplVersion('');
      return;
    }
    let cancelled = false;
    const impl = new ethers.Contract(newImplAddress, RegistryArtifact.abi, provider);
    impl.version()
      .then((v: string) => { if (!cancelled) setNewImplVersion(v); })
      .catch(() => { if (!cancelled) setNewImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newImplAddress]);

  const deployNewImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new implementation...' });
    try {
      const factory = new ethers.ContractFactory(RegistryArtifact.abi, RegistryArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setNewImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `New implementation deployed at ${impl.address}. Note: this contract has no re-initializer — storage from the current implementation carries over as-is.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleUpgrade = async () => {
    const prox = getProxyWrite();
    if (!prox || !ethers.utils.isAddress(newImplAddress)) return;
    setTxStatus({ status: 'pending', message: 'Upgrading implementation...' });
    try {
      const tx = await prox.upgrad(newImplAddress);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proxy now points at ${newImplAddress}.` });
      setNewImplAddress('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleChangeAdmin = async () => {
    const prox = getProxyWrite();
    if (!prox || !ethers.utils.isAddress(newAdminAddr.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid admin address' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Changing proxy admin...' });
    try {
      const tx = await prox.changeAdmin(newAdminAddr.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Proxy admin changed to ${newAdminAddr.trim()}.` });
      setNewAdminAddr('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* ── Deploy / Load ── */}
      <Card title="Deploy Reward Eligibility Registry" icon={<Rocket className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Standalone registry mapping wallets → a reward type &amp; max claimable points, governed by a small operator multisig (type changes need approvals from &ge; the proposal threshold, currently&nbsp;
          <span className="text-accent font-semibold">{thresholdVal || '—'}</span>). This is independent of GameHub/DailySessionManager — deploying it does not affect the rest of the fleet.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the RewardEligibilityRegistry logic contract (constructor disables direct initialization).</p>
            <button onClick={deployImplementation} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy Implementation</button>
            {implAddress && <AddrBadge addr={implAddress} label="impl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Proxy</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the proxy and atomically initializes it — your connected wallet becomes both the proxy admin and the contract owner in one transaction.</p>
            <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="Implementation address (step 1, or paste one)" className={`${inputCls} mb-3`} />
            <button onClick={deployProxy} disabled={!isConnected || !implAddress} className={`w-full ${btnCls}`}>Deploy Proxy</button>
            {rewardEligibilityRegistryAddress && <AddrBadge addr={rewardEligibilityRegistryAddress} label="proxy" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">Load Existing</h4>
            <p className="text-xs text-txt-secondary mb-3">Already deployed? Paste the proxy address to load it.</p>
            <input value={manualLoad} onChange={e => setManualLoad(e.target.value)} placeholder="0x... proxy address" className={`${inputCls} mb-3`} />
            <button onClick={loadExisting} className="w-full bg-surface-secondary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm transition-colors">Load Address</button>
          </div>
        </div>
      </Card>

      {!rewardEligibilityRegistryAddress ? (
        <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load a Reward Eligibility Registry to manage operators, types &amp; wallets.</p></Card>
      ) : (
        <>
          {/* ── Overview ── */}
          <Card title={
            <span className="flex items-center gap-2">
              Registry Overview
              <button onClick={() => { fetchOverview(); fetchProposals(); }} disabled={overviewLoading} className="p-1 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-4 h-4 text-txt-secondary ${overviewLoading ? 'animate-spin' : ''}`} />
              </button>
            </span>
          } icon={<ShieldCheck className="w-5 h-5 text-accent" />}>
            {overviewLoadError && (
              <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 flex items-start gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-300 text-xs">{overviewLoadError}</p>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-3">
              <div>
                <p className="text-xs text-txt-secondary">Owner</p>
                <p className="text-xs font-mono text-txt-primary break-all">{fmtAddr(ownerAddr)}</p>
                {isOwnerConnected && <span className="text-[10px] text-green-400">You</span>}
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Proxy Admin</p>
                <p className="text-xs font-mono text-txt-primary break-all">{fmtAddr(adminAddr)}</p>
                {isAdminConnected && <span className="text-[10px] text-green-400">You</span>}
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Implementation (logic)</p>
                <p className="text-xs font-mono text-txt-primary break-all">{fmtAddr(logicAddr)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Version</p>
                <p className="text-sm font-bold text-accent">{versionStr || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Proposal Threshold</p>
                <p className="text-sm font-bold text-accent">{thresholdVal} <span className="text-txt-secondary text-xs">/ max {maxThresholdVal}</span></p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Proposals Created</p>
                <p className="text-sm font-bold text-accent">{proposalCountVal}</p>
              </div>
              {supportsSelfRegister && (
                <div>
                  <p className="text-xs text-txt-secondary">Self-Register Gate</p>
                  <p className={`text-sm font-bold flex items-center gap-1.5 ${isZero(efficacyContractAddr) ? 'text-green-400' : 'text-orange-400'}`}>
                    {isZero(efficacyContractAddr) ? <><Unlock className="w-4 h-4" /> Open</> : <><Lock className="w-4 h-4" /> Gated</>}
                  </p>
                  {!isZero(efficacyContractAddr) && <p className="text-[10px] font-mono text-txt-secondary break-all">{fmtAddr(efficacyContractAddr)}</p>}
                </div>
              )}
            </div>
            {isConnected && (
              <p className="text-xs mb-2">
                Your wallet is: {isOwnerConnected && <span className="text-yellow-400 font-medium">Owner </span>}
                {isConnectedOperator && <span className="text-accent font-medium">Operator </span>}
                {!isOwnerConnected && !isConnectedOperator && <span className="text-txt-secondary">not the owner or a registered operator</span>}
              </p>
            )}
            {!isZero(pendingOwnerAddr) && (
              <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 flex items-center gap-3 flex-wrap mt-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                <p className="text-yellow-300 text-xs flex-1">Ownership transfer pending to <code className="font-mono">{fmtAddr(pendingOwnerAddr)}</code>.</p>
                {isPendingOwnerConnected && (
                  <button onClick={acceptOwnership} className="bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">Accept Ownership</button>
                )}
              </div>
            )}
          </Card>

          {/* ── Ownership & Threshold (owner only — visible to everyone, actions disabled otherwise) ── */}
          <Card title="Ownership &amp; Threshold" icon={<KeyRound className="w-5 h-5 text-yellow-400" />}>
            {!isOwnerConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not the owner — these actions will revert.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-txt-secondary">Transfer Ownership (two-step — new owner must accept)</label>
                <div className="flex gap-2 mt-1">
                  <input value={transferTo} onChange={e => setTransferTo(e.target.value)} placeholder="0x... new owner" className={inputCls} />
                  <button onClick={handleTransferOwnership} disabled={!isOwnerConnected || !transferTo.trim()} className={`shrink-0 px-4 ${btnCls}`}>Transfer</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Proposal Threshold (min 2, max {maxThresholdVal})</label>
                <div className="flex gap-2 mt-1">
                  <input value={newThreshold} onChange={e => setNewThreshold(e.target.value)} type="number" min={2} max={maxThresholdVal} className={inputCls} />
                  <button onClick={handleSetThreshold} disabled={!isOwnerConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
              {supportsSelfRegister && (
                <div className="md:col-span-2">
                  <label className="text-xs text-txt-secondary">
                    Self-Register Gate — Efficacy Contract ({isZero(efficacyContractAddr) ? 'currently open, anyone can self-register' : `currently gated via ${fmtAddr(efficacyContractAddr)}`})
                  </label>
                  <div className="flex gap-2 mt-1">
                    <input value={newEfficacyAddr} onChange={e => setNewEfficacyAddr(e.target.value)} placeholder="0x... efficacy contract (empty/zero = open gate)" className={inputCls} />
                    <button onClick={() => handleSetEfficacyContract(false)} disabled={!isOwnerConnected || !newEfficacyAddr.trim()} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                    {!isZero(efficacyContractAddr) && (
                      <button onClick={() => handleSetEfficacyContract(true)} disabled={!isOwnerConnected} className="shrink-0 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">Disable Gate</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* ── Operators ── */}
          <Card title={`Operators (${knownOperators.filter(o => o.allowed).length} active)`} icon={<UserCog className="w-5 h-5 text-accent" />}>
            <p className="text-txt-secondary text-sm mb-3">
              Only the <strong>owner</strong> can add or remove operators. Operators can propose reward types, register wallets, and approve/reject proposals — most actions below require the connected wallet to be an operator.
            </p>
            <div className="bg-surface-tertiary rounded-lg p-4 mb-4">
              {!isOwnerConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not the owner — these actions will revert.</p>}
              <label className="text-xs text-txt-secondary">Operator Address</label>
              <input value={operatorInput} onChange={e => setOperatorInput(e.target.value)} placeholder="0x..." className={`${inputCls} mt-1 mb-3`} />
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => handleSetOperator(operatorInput, true)} disabled={!isOwnerConnected || !operatorInput.trim()} className={`flex items-center justify-center gap-1.5 ${btnCls}`}>
                  <UserPlus className="w-4 h-4" /> Add Operator
                </button>
                <button onClick={() => handleSetOperator(operatorInput, false)} disabled={!isOwnerConnected || !operatorInput.trim()} className="flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
                  <Trash2 className="w-4 h-4" /> Remove Operator
                </button>
              </div>
            </div>
            <div className="flex gap-2 mb-3">
              <input value={lookupOperatorAddr} onChange={e => setLookupOperatorAddr(e.target.value)} placeholder="Lookup any address..." className={inputCls} onKeyDown={e => e.key === 'Enter' && handleLookupOperator()} />
              <button onClick={handleLookupOperator} disabled={!lookupOperatorAddr.trim()} className={`shrink-0 flex items-center gap-1.5 px-4 ${btnCls}`}><Search className="w-4 h-4" /> Lookup</button>
              <button onClick={fetchOperators} disabled={operatorsLoading} className="shrink-0 flex items-center gap-1.5 px-3 bg-surface-tertiary hover:bg-surface-secondary rounded-lg text-xs">
                <RefreshCw className={`w-3.5 h-3.5 ${operatorsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <p className="text-[11px] text-txt-secondary mb-2">Discovered from OperatorSet events over the last ~50,000 blocks — use Lookup for an address outside that window.</p>
            {knownOperators.length === 0 ? (
              <p className="text-sm text-txt-secondary">No operators discovered yet.</p>
            ) : (
              <div className="space-y-1.5">
                {knownOperators.map(op => (
                  <div key={op.address} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-tertiary">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${op.allowed ? 'bg-green-400' : 'bg-red-400'}`} />
                    <code className="text-xs font-mono flex-1 truncate">{op.address}</code>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${op.allowed ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{op.allowed ? 'ALLOWED' : 'REMOVED'}</span>
                    <button onClick={() => handleSetOperator(op.address, !op.allowed)} disabled={!isOwnerConnected} className="text-[10px] text-accent hover:underline disabled:text-txt-secondary disabled:no-underline disabled:cursor-not-allowed shrink-0">{op.allowed ? 'Remove' : 'Re-add'}</button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── Reward Types / Type Config ── */}
          <Card title="Reward Types (Type Config)" icon={<IdCard className="w-5 h-5 text-green-400" />}>
            <p className="text-txt-secondary text-sm mb-3">
              Create or update a type&apos;s <strong>max claimable points</strong> — entered below in whole points (e.g. <code className="text-accent">500</code> for 500&nbsp;pts), same units as carry-forward/points balances elsewhere in this app; it's scaled to the on-chain 18-decimal value automatically. This goes through the proposal flow — it only takes effect once approved by at least {thresholdVal || 'the configured'} operator(s) (see Proposals below).
            </p>
            {!isConnectedOperator && <p className="text-xs text-yellow-400 mb-4">&#9888; Connected wallet is not a registered operator — proposing will revert until it's added on the Operators card above.</p>}
            <div className="bg-surface-tertiary rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h4 className="font-medium">Default Type Presets</h4>
                <div className="flex items-center gap-3">
                  <button onClick={resetPresetsToDefault} className="text-xs text-txt-secondary hover:text-accent underline">Reset to Defaults</button>
                  <button
                    onClick={handleRepairAllPresets}
                    disabled={!isConnectedOperator || presetBusyIndex !== null}
                    className="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
                    title="Covers every row below, including types that already exist — use this to fix a wrong value, e.g. a cap set without 18-decimal scaling."
                  >
                    {presetBusyIndex === -2 ? 'Repairing all...' : 'Repair/Overwrite All (1 proposal)'}
                  </button>
                  <button
                    onClick={handleProposeAllPresets}
                    disabled={!isConnectedOperator || presetBusyIndex !== null}
                    className={`px-4 py-2 text-sm ${btnCls}`}
                  >
                    {presetBusyIndex === -1 ? 'Proposing all...' : 'Propose All Missing (1 proposal)'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-txt-secondary mb-3">
                Edit, add, or remove rows to customize your one-click shortcuts — saved in this browser only. &quot;Propose All Missing&quot; batches every <strong>not-yet-configured</strong> type into a single proposal; &quot;Repair/Overwrite All&quot; batches <strong>every</strong> row below (including already-configured types) into a single proposal, overwriting their current cap on execution — use it to correct a bad value. Either way the per-row Propose button still creates its own individual proposal for just that row. Proposing auto-approves it as your own vote; it still needs {Math.max(0, thresholdVal - 1) || 'more'} additional operator approval(s) to take effect.
              </p>
              <div className="grid grid-cols-[80px_1fr_100px_36px] gap-2 text-[11px] text-txt-secondary font-semibold px-1 mb-1">
                <span>Type ID</span><span>Max Claimable Points</span><span></span><span></span>
              </div>
              <div className="space-y-2 mb-3">
                {typePresets.map((p, i) => {
                  const typeIdNum = parseInt(p.typeId);
                  const configured = !isNaN(typeIdNum) && !!presetStatus[i];
                  const busy = presetBusyIndex === i;
                  return (
                    <div key={i} className="grid grid-cols-[80px_1fr_100px_36px] gap-2 items-center">
                      <input value={p.typeId} onChange={e => updatePresetRow(i, 'typeId', e.target.value)} type="number" min={0} placeholder="1" className={inputCls} />
                      <input value={p.maxPoints} onChange={e => updatePresetRow(i, 'maxPoints', e.target.value)} type="number" min={0} placeholder="500" className={inputCls} />
                      {configured ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-500/20 text-green-400 text-center">CONFIGURED</span>
                      ) : (
                        <button
                          onClick={() => handleProposeOnePreset(i)}
                          disabled={!isConnectedOperator || presetBusyIndex !== null || !p.typeId || !p.maxPoints}
                          className="text-xs bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2 rounded-lg transition-colors"
                        >
                          {busy ? '...' : 'Propose'}
                        </button>
                      )}
                      <button onClick={() => removePresetRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400 justify-self-center"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  );
                })}
              </div>
              <button onClick={addPresetRow} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus className="w-3.5 h-3.5" /> Add preset</button>
            </div>
            <div className="bg-surface-tertiary rounded-lg p-4 mb-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="text-xs text-txt-secondary">Type ID</label>
                  <input value={proposeTypeId} onChange={e => setProposeTypeId(e.target.value)} type="number" min={0} placeholder="1" className={`${inputCls} mt-1`} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Max Claimable Points</label>
                  <input value={proposeMaxPoints} onChange={e => setProposeMaxPoints(e.target.value)} type="number" min={0} placeholder="1000" className={`${inputCls} mt-1`} />
                </div>
                <div className="flex items-end">
                  <button onClick={handleProposeTypeConfig} disabled={!isConnectedOperator || !proposeTypeId} className={`w-full ${btnCls}`}>Propose Type Config</button>
                </div>
              </div>
            </div>
            <div className="flex gap-2 mb-3">
              <input value={lookupTypeId} onChange={e => setLookupTypeId(e.target.value)} type="number" placeholder="Lookup type ID..." className={inputCls} onKeyDown={e => e.key === 'Enter' && handleLookupType()} />
              <button onClick={handleLookupType} disabled={!lookupTypeId} className={`shrink-0 flex items-center gap-1.5 px-4 ${btnCls}`}><Search className="w-4 h-4" /> Lookup</button>
              <button onClick={fetchTypes} disabled={typesLoading} className="shrink-0 flex items-center gap-1.5 px-3 bg-surface-tertiary hover:bg-surface-secondary rounded-lg text-xs">
                <RefreshCw className={`w-3.5 h-3.5 ${typesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <p className="text-[11px] text-txt-secondary mb-2">Discovered from TypeConfigured events over the last ~50,000 blocks — use Lookup for a type ID outside that window.</p>
            {knownTypes.length === 0 ? (
              <p className="text-sm text-txt-secondary">No types discovered yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-txt-secondary text-xs border-b border-white/10">
                      <th className="py-2 px-2 text-left">Type ID</th>
                      <th className="py-2 px-2 text-left">Max Claimable Points (pts)</th>
                      <th className="py-2 px-2 text-center">Configured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {knownTypes.map(t => (
                      <tr key={t.id} className="border-b border-white/5">
                        <td className="py-2 px-2 font-mono text-accent">#{t.id}</td>
                        <td className="py-2 px-2 text-txt-primary">{t.maxClaimablePoints}</td>
                        <td className="py-2 px-2 text-center">
                          {t.exists ? <Check className="w-4 h-4 text-green-400 inline" /> : <span className="text-txt-secondary text-xs">No</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Wallets ── */}
          <Card title="Wallets" icon={<ListChecks className="w-5 h-5 text-blue-400" />}>
            <p className="text-txt-secondary text-sm mb-3">Register wallets to an already-configured type (immediate, no approval needed), look up a wallet&apos;s status, or propose a type change for already-registered wallets (needs approvals).</p>

            {/* Register */}
            <div className="mb-5">
              <h4 className="text-sm font-medium mb-2">Register Wallets</h4>
              {!isConnectedOperator && <p className="text-xs text-yellow-400 mb-2">&#9888; Connected wallet is not a registered operator.</p>}
              <div className="space-y-2 mb-2">
                {registerRows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_120px_40px] gap-2">
                    <input value={r.address} onChange={e => updateRegisterRow(i, 'address', e.target.value)} placeholder="0x... wallet" className={inputCls} />
                    <input value={r.typeId} onChange={e => updateRegisterRow(i, 'typeId', e.target.value)} type="number" placeholder="Type ID" className={inputCls} />
                    {registerRows.length > 1 ? (
                      <button onClick={() => removeRegisterRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
                    ) : <div />}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={addRegisterRow} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus className="w-3.5 h-3.5" /> Add row</button>
                <button onClick={handleRegisterWallets} disabled={!isConnectedOperator} className={`ml-auto px-4 ${btnCls}`}>Register {registerRows.length} Wallet{registerRows.length !== 1 ? 's' : ''}</button>
              </div>
            </div>

            {/* Lookup */}
            <div className="mb-5 border-t border-white/10 pt-4">
              <h4 className="text-sm font-medium mb-2">Lookup Wallet</h4>
              <div className="flex gap-2">
                <input value={lookupWalletAddr} onChange={e => { setLookupWalletAddr(e.target.value); setWalletLookupResult(null); setWalletLookupError(''); }} placeholder="0x... wallet" className={inputCls} onKeyDown={e => e.key === 'Enter' && handleLookupWallet()} />
                <button onClick={handleLookupWallet} disabled={!lookupWalletAddr.trim()} className={`shrink-0 flex items-center gap-1.5 px-4 ${btnCls}`}><Search className="w-4 h-4" /> Lookup</button>
              </div>
              {walletLookupError && <p className="text-red-400 text-xs mt-2">{walletLookupError}</p>}
              {walletLookupResult && (
                <div className="mt-2 bg-surface-tertiary rounded-lg p-3 text-sm">
                  {walletLookupResult.registered ? (
                    <div className="flex items-center gap-4 flex-wrap">
                      <span className="text-green-400 font-medium">Registered</span>
                      <span>Type: <span className="text-accent font-mono">#{walletLookupResult.typeId}</span></span>
                      <span>Max Claimable: <span className="text-accent font-mono">{walletLookupResult.maxPoints} pts</span></span>
                    </div>
                  ) : (
                    <span className="text-txt-secondary">Not registered</span>
                  )}
                </div>
              )}
            </div>

            {/* Propose type change */}
            <div className="border-t border-white/10 pt-4">
              <h4 className="text-sm font-medium mb-2">Propose Wallet Type Change</h4>
              {!isConnectedOperator && <p className="text-xs text-yellow-400 mb-2">&#9888; Connected wallet is not a registered operator.</p>}
              <div className="space-y-2 mb-2">
                {typeChangeRows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_120px_40px] gap-2">
                    <input value={r.address} onChange={e => updateTypeChangeRow(i, 'address', e.target.value)} placeholder="0x... registered wallet" className={inputCls} />
                    <input value={r.typeId} onChange={e => updateTypeChangeRow(i, 'typeId', e.target.value)} type="number" placeholder="New Type ID" className={inputCls} />
                    {typeChangeRows.length > 1 ? (
                      <button onClick={() => removeTypeChangeRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
                    ) : <div />}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={addTypeChangeRow} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus className="w-3.5 h-3.5" /> Add row</button>
                <button onClick={handleProposeTypeChange} disabled={!isConnectedOperator} className={`ml-auto px-4 ${btnCls}`}>Propose Change for {typeChangeRows.length} Wallet{typeChangeRows.length !== 1 ? 's' : ''}</button>
              </div>
            </div>
          </Card>

          {/* ── Self Registration ── */}
          {supportsSelfRegister && (
            <Card title="Self Registration" icon={<UserCheck className="w-5 h-5 text-teal-400" />}>
              <p className="text-txt-secondary text-sm mb-3">
                Lets any wallet register itself to an already-configured type, no operator transaction needed.{' '}
                {isZero(efficacyContractAddr)
                  ? 'The gate is currently OPEN — anyone can self-register directly.'
                  : `The gate is currently GATED via ${efficacyContractAddr} — registering needs an efficacy code from that contract plus signatures from at least ${thresholdVal || 'the configured number of'} distinct operators.`}
              </p>

              {selfRegStatus && (
                <div className="bg-surface-tertiary rounded-lg p-3 mb-4 text-sm">
                  {selfRegStatus.registered
                    ? <span className="text-green-400">Your connected wallet is already registered to type #{selfRegStatus.typeId}.</span>
                    : <span className="text-txt-secondary">Your connected wallet is not registered yet.</span>}
                </div>
              )}

              {isZero(efficacyContractAddr) ? (
                <div className="bg-surface-tertiary rounded-lg p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="text-xs text-txt-secondary">Type ID</label>
                      <input value={selfRegTypeId} onChange={e => setSelfRegTypeId(e.target.value)} type="number" min={0} placeholder="1" className={`${inputCls} mt-1`} />
                    </div>
                    <div className="flex items-end">
                      <button onClick={handleUnsignedSelfRegister} disabled={!isConnected || !selfRegTypeId || !!selfRegStatus?.registered} className={`w-full ${btnCls}`}>Self Register</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-surface-tertiary rounded-lg p-4">
                    <h4 className="font-medium mb-2 flex items-center gap-1.5"><FileSignature className="w-4 h-4" /> Sign a Registration Request (for operators)</h4>
                    <p className="text-xs text-txt-secondary mb-3">Sign the exact wallet / type / expiration a requester will submit, then share the resulting signature back with them — sharing it grants no access by itself, it only counts toward the threshold once submitted with a matching request.</p>
                    {!isConnectedOperator && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not a registered operator — the contract will reject signatures from non-operators.</p>}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                      <div>
                        <label className="text-xs text-txt-secondary">Wallet to Register</label>
                        <input value={signWallet} onChange={e => setSignWallet(e.target.value)} placeholder="0x..." className={`${inputCls} mt-1`} />
                      </div>
                      <div>
                        <label className="text-xs text-txt-secondary">Type ID</label>
                        <input value={signTypeId} onChange={e => setSignTypeId(e.target.value)} type="number" min={0} className={`${inputCls} mt-1`} />
                      </div>
                      <div>
                        <label className="text-xs text-txt-secondary">Expiration (unix seconds)</label>
                        <input value={signExpiration} onChange={e => setSignExpiration(e.target.value)} type="number" className={`${inputCls} mt-1`} />
                        <div className="flex gap-2 mt-1">
                          <button onClick={() => quickSetExpiration(3600)} className="text-[10px] text-accent hover:underline">+1h</button>
                          <button onClick={() => quickSetExpiration(86400)} className="text-[10px] text-accent hover:underline">+24h</button>
                        </div>
                      </div>
                    </div>
                    <button onClick={handleSignForRegistration} disabled={!isConnected} className={`px-4 ${btnCls}`}>Sign</button>
                    {signError && <p className="text-red-400 text-xs mt-2">{signError}</p>}
                    {signResult && (
                      <div className="mt-3 flex items-start gap-2">
                        <code className="text-xs font-mono text-accent break-all flex-1">{signResult}</code>
                        <button onClick={() => copyAddr(signResult, 'sig')} className="shrink-0">
                          {copied === 'sig' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="bg-surface-tertiary rounded-lg p-4">
                    <h4 className="font-medium mb-2 flex items-center gap-1.5"><Lock className="w-4 h-4" /> Submit Signed Self-Registration</h4>
                    <p className="text-xs text-txt-secondary mb-3">Uses your connected wallet as the registrant. Type ID and Expiration must exactly match what was signed above. Needs a valid efficacy code plus at least {thresholdVal || 'the configured number of'} unique operator signatures.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                      <div>
                        <label className="text-xs text-txt-secondary">Type ID</label>
                        <input value={submitTypeId} onChange={e => setSubmitTypeId(e.target.value)} type="number" min={0} className={`${inputCls} mt-1`} />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="text-xs text-txt-secondary">Expiration (unix seconds)</label>
                        <input value={submitExpiration} onChange={e => setSubmitExpiration(e.target.value)} type="number" className={`${inputCls} mt-1`} />
                      </div>
                    </div>
                    <div className="mb-3">
                      <label className="text-xs text-txt-secondary">Efficacy Code (bytes32, from the efficacy contract&apos;s off-chain flow)</label>
                      <input value={submitCode} onChange={e => setSubmitCode(e.target.value)} placeholder="0x..." className={`${inputCls} mt-1`} />
                    </div>
                    <div className="space-y-2 mb-2">
                      <label className="text-xs text-txt-secondary">Operator Signatures</label>
                      {submitSignatures.map((s, i) => (
                        <div key={i} className="grid grid-cols-[1fr_40px] gap-2">
                          <div>
                            <input value={s} onChange={e => updateSubmitSignature(i, e.target.value)} placeholder="0x... 65-byte signature" className={inputCls} />
                            {signaturePreview[i] && <p className="text-[10px] text-txt-secondary mt-0.5 font-mono">Recovers to: {signaturePreview[i]}</p>}
                          </div>
                          {submitSignatures.length > 1 ? (
                            <button onClick={() => removeSubmitSignature(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
                          ) : <div />}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={addSubmitSignature} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus className="w-3.5 h-3.5" /> Add signature</button>
                      <button onClick={handleSubmitSignedSelfRegister} disabled={!isConnected || !!selfRegStatus?.registered} className={`ml-auto px-4 ${btnCls}`}>Submit Self Registration</button>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ── Proposals ── */}
          <Card title={
            <span className="flex items-center gap-2">
              Proposals
              <span className="text-xs text-txt-secondary font-normal">({proposalCountVal} total)</span>
              <button onClick={() => fetchProposals(pageStart)} disabled={proposalsLoading} className="p-1 rounded hover:bg-surface-tertiary ml-auto">
                <RefreshCw className={`w-4 h-4 text-txt-secondary ${proposalsLoading ? 'animate-spin' : ''}`} />
              </button>
            </span>
          } icon={<Vote className="w-5 h-5 text-purple-400" />}>
            {proposals.length === 0 && !proposalsLoading && (
              <p className="text-sm text-txt-secondary text-center py-6">No proposals yet.</p>
            )}
            <div className="space-y-2">
              {proposals.map(p => {
                const isExpanded = expandedProposal === p.id;
                const statusLabel = p.executed ? 'EXECUTED' : p.cancelled ? 'REJECTED' : 'PENDING';
                const statusColor = p.executed ? 'bg-green-500/20 text-green-400' : p.cancelled ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400';
                const canApprove = isConnectedOperator && !p.executed && !p.cancelled && !p.approvedByMe;
                const canReject = !p.executed && !p.cancelled && isConnected && (isOwnerConnected || address?.toLowerCase() === p.proposer.toLowerCase());
                return (
                  <div key={p.id} className="bg-surface-tertiary rounded-lg overflow-hidden">
                    <button onClick={() => setExpandedProposal(isExpanded ? null : p.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-secondary/30">
                      <span className="font-mono text-accent text-sm font-bold shrink-0">#{p.id}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-purple-500/20 text-purple-300">{REWARD_ELIGIBILITY_REGISTRY_PROPOSAL_TYPE_LABELS[p.proposalType] || 'Unknown'}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor}`}>{statusLabel}</span>
                          {p.approvedByMe && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-500/20 text-blue-300">You Approved</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-txt-secondary flex-wrap">
                          {p.proposalType === 1 ? (
                            (p.typeIds?.length ?? 0) === 1 ? (
                              <span>Type #{p.typeIds?.[0]} → max {p.maxPointsList?.[0]} pts</span>
                            ) : (
                              <span>{p.typeIds?.length ?? 0} type(s)</span>
                            )
                          ) : (
                            <span>{p.wallets?.length ?? 0} wallet(s)</span>
                          )}
                          <span>Approvals: <span className="text-accent">{p.approvalCount}/{p.snapshotThreshold}</span></span>
                          <span>By: <span className="font-mono">{fmtAddr(p.proposer)}</span></span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {canApprove && (
                          <button onClick={(e) => { e.stopPropagation(); handleApprove(p.id); }} className="flex items-center gap-1 text-[11px] bg-green-600 hover:bg-green-500 text-white font-semibold px-2 py-1 rounded transition-colors">
                            <ThumbsUp className="w-3 h-3" /> Approve
                          </button>
                        )}
                        {canReject && (
                          <button onClick={(e) => { e.stopPropagation(); handleReject(p.id); }} className="flex items-center gap-1 text-[11px] bg-red-600 hover:bg-red-500 text-white font-semibold px-2 py-1 rounded transition-colors">
                            <ThumbsDown className="w-3 h-3" /> Reject
                          </button>
                        )}
                      </div>
                    </button>
                    {isExpanded && p.proposalType === 0 && p.wallets && (
                      <div className="px-3 pb-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-txt-secondary border-b border-white/10">
                                <th className="py-1 px-2 text-left">Wallet</th>
                                <th className="py-1 px-2 text-left">New Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.wallets.map((w, i) => (
                                <tr key={i} className="border-b border-white/5">
                                  <td className="py-1 px-2 font-mono">{fmtAddr(w)}</td>
                                  <td className="py-1 px-2 font-mono text-accent">#{p.newTypeIds?.[i]}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {isExpanded && p.proposalType === 1 && p.typeIds && p.typeIds.length > 1 && (
                      <div className="px-3 pb-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-txt-secondary border-b border-white/10">
                                <th className="py-1 px-2 text-left">Type ID</th>
                                <th className="py-1 px-2 text-left">Max Claimable Points (pts)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.typeIds.map((id, i) => (
                                <tr key={i} className="border-b border-white/5">
                                  <td className="py-1 px-2 font-mono text-accent">#{id}</td>
                                  <td className="py-1 px-2 font-mono">{p.maxPointsList?.[i]}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {pageStart > 0 && (
              <button onClick={() => fetchProposals(Math.max(0, pageStart - PAGE_SIZE))} className="mt-3 text-xs text-accent hover:underline">
                Load older proposals
              </button>
            )}
          </Card>

          {/* ── Proxy Admin ── */}
          <Card title="Proxy Admin" icon={<Landmark className="w-5 h-5 text-orange-400" />}>
            <p className="text-txt-secondary text-sm mb-4">
              Upgrade the logic contract or change the proxy admin at <code className="text-accent">{rewardEligibilityRegistryAddress}</code>. Requires the connected wallet to be the proxy admin (<code className="text-accent">{fmtAddr(adminAddr)}</code>) — separate from the contract owner above.
            </p>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-4">&#9888; Connected wallet is not the proxy admin — these actions will revert.</p>}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Upgrade Implementation</h4>
                <button onClick={deployNewImplementation} disabled={!isConnected} className={`w-full mb-3 ${btnCls}`}>Deploy New Implementation</button>
                <input value={newImplAddress} onChange={e => setNewImplAddress(e.target.value)} placeholder="0x... new implementation" className={`${inputCls} mb-2`} />
                {newImplAddress && ethers.utils.isAddress(newImplAddress) && (
                  <p className="text-[11px] text-txt-secondary mb-2">New version: <span className="font-mono text-accent">{newImplVersion || 'loading...'}</span></p>
                )}
                <button onClick={handleUpgrade} disabled={!isAdminConnected || !newImplAddress} className={`w-full flex items-center justify-center gap-1.5 ${btnCls}`}>
                  <ArrowUpCircle className="w-4 h-4" /> Upgrade
                </button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Change Proxy Admin</h4>
                <p className="text-xs text-txt-secondary mb-3">Careful — this cannot be undone unless the new admin changes it back.</p>
                <input value={newAdminAddr} onChange={e => setNewAdminAddr(e.target.value)} placeholder="0x... new admin" className={`${inputCls} mb-3`} />
                <button onClick={handleChangeAdmin} disabled={!isAdminConnected || !newAdminAddr.trim()} className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
                  Change Admin
                </button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
