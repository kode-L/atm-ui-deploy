'use client';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { getExplorerAddressUrl, networkStorageKey } from '@/lib/contracts/config';
import { Shield, UserPlus, UserMinus, Settings, Layers, Lock, Unlock, ChevronDown, ChevronUp, Wallet, Search, Calculator, RefreshCw, Check, Calendar } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import TestTokenArtifact from '@/lib/contracts/TestToken.json';

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

interface ViewedRewardType {
  id: number;
  name: string;
  entryFee: string;
  entryFeeRaw: any; // BigNumber for calc
  active: boolean;
  minPlayers: number;
  maxPlayers: number;
  collectionBps: number;
  fixedPoints: boolean;
  placementBps: number[];
  placementDeltas: string[]; // formatted, e.g. "-1.0"
}

interface CachedOperator { address: string; name: string; active: boolean; splitterAddress: string; metadataURI: string; instance: string; }
interface CachedRewardType { id: number; name: string; entryFee: string; minPlayers: number; maxPlayers: number; active: boolean; collectionBps?: number; fixedPoints?: boolean; placementBps?: number[]; placementDeltas?: string[]; }

export default function AdminSection() {
  const { signer, provider, isConnected, address, hubAddress, sessionManagerAddress, tokenAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });

  // Admin wallet (DEFAULT_ADMIN_ROLE holder set at deployment)
  const [adminWallet, setAdminWallet] = useState<string>('');
  const [adminLoading, setAdminLoading] = useState(false);

  // Section collapse state
  const [openSection, setOpenSection] = useState<string>('operators');
  const toggle = (s: string) => setOpenSection(prev => prev === s ? '' : s);

  // View Reward Type
  const [viewRtId, setViewRtId] = useState('');
  const [viewRtLoading, setViewRtLoading] = useState(false);
  const [viewRtError, setViewRtError] = useState('');
  const [viewedRt, setViewedRt] = useState<ViewedRewardType | null>(null);
  const [viewCalcPlayers, setViewCalcPlayers] = useState('');

  // Operator management
  const [operatorAddr, setOperatorAddr] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [operatorMeta, setOperatorMeta] = useState('');
  const [operatorSplitter, setOperatorSplitter] = useState(''); // PaymentSplitter address

  // Platform Updater management
  const [updaterAddr, setUpdaterAddr] = useState('');
  const [updaterLinkedOp, setUpdaterLinkedOp] = useState('');

  // ── Reward Type management ──
  const [rtName, setRtName] = useState('');
  const [rtEntryFee, setRtEntryFee] = useState(''); // in points
  const [rtMinPlayers, setRtMinPlayers] = useState('2');
  const [rtMaxPlayers, setRtMaxPlayers] = useState('10');
  const [rtCollectionPct, setRtCollectionPct] = useState('100'); // % of matchValue actually collected on-chain
  const [rtPlacementBps, setRtPlacementBps] = useState<string[]>(['0', '5000', '3000']); // 1st=0%, 2nd=50%, 3rd=30%
  // Fixed Points mode: each placement gets an exact signed point amount, independent of
  // pool size — the only way to express a per-placement PENALTY (e.g. 1st −1, 2nd −1,
  // 3rd +10), since placementBps is unsigned and always a % of the pool.
  const [rtFixedPoints, setRtFixedPoints] = useState(false);
  const [rtPlacementDeltas, setRtPlacementDeltas] = useState<string[]>(['-1', '-1', '10']);
  const [rtUpdateId, setRtUpdateId] = useState('');
  const [rtUpdateName, setRtUpdateName] = useState('');
  const [rtUpdateFee, setRtUpdateFee] = useState('');
  const [rtUpdateMinPlayers, setRtUpdateMinPlayers] = useState('2');
  const [rtUpdateMaxPlayers, setRtUpdateMaxPlayers] = useState('10');
  const [rtUpdateCollectionPct, setRtUpdateCollectionPct] = useState('100');
  const [rtUpdatePlacementBps, setRtUpdatePlacementBps] = useState<string[]>(['0', '5000', '3000']);
  const [rtUpdateFixedPoints, setRtUpdateFixedPoints] = useState(false);
  const [rtUpdatePlacementDeltas, setRtUpdatePlacementDeltas] = useState<string[]>(['-1', '-1', '10']);
  const [rtUpdateActive, setRtUpdateActive] = useState(true);

  // Track focused field to prevent overwriting user input during round-trip recalculation
  const [focusedField, setFocusedField] = useState<string | null>(null);
  // Local edit buffers for pct and payout fields (to avoid BPS round-trip overwrite)
  const [localPctEdit, setLocalPctEdit] = useState<{ key: string; value: string } | null>(null);
  const [localPayoutEdit, setLocalPayoutEdit] = useState<{ key: string; value: string } | null>(null);

  // ── Operator Reward Rules (checklist) ──
  const [ruleOperator, setRuleOperator] = useState('');
  const [ruleChecklist, setRuleChecklist] = useState<Record<number, boolean>>({}); // rtId => allowed
  const [ruleOnChain, setRuleOnChain] = useState<Record<number, boolean>>({}); // original on-chain state
  const [ruleLoading, setRuleLoading] = useState(false);

  // Shared cached lists (loaded once, used by operators, reward types, rules sections)
  const [cachedOperators, setCachedOperators] = useState<CachedOperator[]>([]);
  const [cachedRewardTypes, setCachedRewardTypes] = useState<CachedRewardType[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // ── DateKey Overview (all operators) ──
  const [dkInput, setDkInput] = useState(String(Math.floor(Date.now() / 1000 / 86400)));
  const [dkLoading, setDkLoading] = useState(false);
  const [dkError, setDkError] = useState('');
  const [dkLoaded, setDkLoaded] = useState(false);
  const [dkRows, setDkRows] = useState<Array<{
    address: string; name: string; active: boolean; instance: string;
    sessionId: number; matchCount: number; totalCollected: string; playerAddrs: string[]; tokenBalance: string;
  }>>([]);

  // \u2500\u2500 Schedule \u2500\u2500
  const [newOffset, setNewOffset] = useState('0');
  const [graceHours, setGraceHours] = useState('');
  const [currentGrace, setCurrentGrace] = useState<number | null>(null);
  const [durationMinutes, setDurationMinutes] = useState('');
  const [currentDuration, setCurrentDuration] = useState<number | null>(null);

  // Per-operator session duration override (written directly to that operator's
  // instance, bypassing the hub broadcast so the rest of the fleet is untouched)
  const [opDurationOperator, setOpDurationOperator] = useState('');
  const [opDurationMinutes, setOpDurationMinutes] = useState('');
  const [opCurrentDuration, setOpCurrentDuration] = useState<number | null>(null);
  const [opDurationLoading, setOpDurationLoading] = useState(false);

  // \u2500\u2500 Withdraw \u2500\u2500
  const [withdrawTo, setWithdrawTo] = useState('');
  const [withdrawAmt, setWithdrawAmt] = useState('');

  // \u2500\u2500 Reward Eligibility Registry (hub-wide) \u2500\u2500
  const [rewardEligibilityRegistryOnChain, setRewardEligibilityRegistryOnChain] = useState<string>('');
  const [rewardEligibilityRegistryInput, setRewardEligibilityRegistryInput] = useState('');
  const [rewardEligibilityRegistryLoading, setRewardEligibilityRegistryLoading] = useState(false);

  const getContract = () => {
    if (!signer || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, signer);
  };

  const getReadContract = useCallback(() => {
    if (!provider || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider);
  }, [provider, sessionManagerAddress]);

  // Platform-level writes (operators, reward types, schedule, pause) go through the
  // GameHub, which broadcasts to every operator instance. Managing these directly on
  // an instance would desync it from the fleet (e.g. reward-type IDs diverge).
  const getHubContract = () => {
    if (!hubAddress) throw new Error('GameHub not loaded — deploy or load it from the Deploy tab first.');
    if (!signer) throw new Error('Connect your wallet first.');
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, signer);
  };

  const getHubReadContract = useCallback(() => {
    if (!provider || !hubAddress) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
  }, [provider, hubAddress]);

  const loadAdminWallet = useCallback(async () => {
    const c = getHubReadContract() || getReadContract();
    if (!c) return;
    setAdminLoading(true);
    try {
      const a = await c.adminWallet();
      setAdminWallet(a);
    } catch (e) {
      console.error('Load admin wallet error:', e);
      setAdminWallet('');
    } finally {
      setAdminLoading(false);
    }
  }, [getHubReadContract, getReadContract]);

  useEffect(() => {
    if (sessionManagerAddress || hubAddress) loadAdminWallet();
  }, [sessionManagerAddress, hubAddress, loadAdminWallet]);

  const fetchRewardType = async () => {
    const c = getReadContract();
    if (!c || !viewRtId) return;
    setViewRtLoading(true);
    setViewRtError('');
    setViewedRt(null);
    try {
      const rtId = parseInt(viewRtId);
      const rt = await c.getRewardType(rtId);
      const minP = rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers);
      const maxP = rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers);
      let placementBps: number[] = [];
      let placementDeltas: string[] = [];
      if (rt.fixedPoints) {
        const deltasRaw: any[] = await c.getRewardTypePlacementDeltas(rtId);
        placementDeltas = deltasRaw.map((d: any) => ethers.utils.formatEther(d));
      } else {
        const bpsRaw: any[] = await c.getRewardTypePlacementBps(rtId);
        placementBps = bpsRaw.map((b: any) => b?.toNumber?.() ?? Number(b));
      }
      setViewedRt({
        id: rtId,
        name: rt.name,
        entryFee: ethers.utils.formatEther(rt.entryFee),
        entryFeeRaw: rt.entryFee,
        active: rt.active,
        minPlayers: minP,
        maxPlayers: maxP,
        collectionBps: rt.collectionBps?.toNumber?.() ?? Number(rt.collectionBps),
        fixedPoints: rt.fixedPoints,
        placementBps,
        placementDeltas,
      });
      setViewCalcPlayers(String(minP));
    } catch (e: any) {
      setViewRtError(decodeError(e));
    } finally {
      setViewRtLoading(false);
    }
  };

  const exec = async (label: string, fn: () => Promise<any>, onSuccess?: () => void) => {
    setTxStatus({ status: 'pending', message: `${label}...` });
    try {
      const tx = await fn();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${label} \u2714` });
      if (onSuccess) onSuccess();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Signal the Operators tab to refresh its data
  const signalOperatorsRefresh = () => {
    window.dispatchEvent(new CustomEvent('dg_operators_refresh'));
  };

  // Refresh local admin cache + signal Operators tab
  const refreshAfterChange = () => {
    setCacheLoaded(false);
    setCachedOperators([]);
    setCachedRewardTypes([]);
    fetchFromChain();
    signalOperatorsRefresh();
  };

  // Operator actions — registration/removal go through the hub, which deploys/deactivates
  // the operator's dedicated instance. Profile updates are instance-level (no hub mirror).
  const registerOperator = () => exec('Register Operator (via Hub)', () => getHubContract().registerOperator(operatorAddr, operatorName, operatorMeta, operatorSplitter), refreshAfterChange);
  const updateOperator = () => exec('Update Session Operator', () => getContract()!.updateSessionOperator(operatorAddr, operatorName, operatorMeta, operatorSplitter), refreshAfterChange);
  const removeOperator = () => exec('Remove Operator (via Hub)', () => getHubContract().removeOperator(operatorAddr), refreshAfterChange);

  // Platform Updater actions (operator-scoped)
  const registerUpdater = () => exec('Register Platform Updater', () => getContract()!.registerPlatformUpdater(updaterAddr, updaterLinkedOp));
  const removeUpdater = () => exec('Remove Platform Updater', () => getContract()!.removePlatformUpdater(updaterAddr));

  // Reward Type actions. placementBps is a uint256[] on-chain — negative entries
  // (typed via the %/payout sync fields) would revert client-side when ethers
  // encodes them, so clamp to 0 defensively even though the inputs also clamp live.
  const toBps = (b: string) => Math.max(0, parseInt(b) || 0);
  // Fixed Points deltas are signed — parsed at 18-decimal precision like entryFee, e.g.
  // "-1" -> -1e18. Invalid input falls back to 0 rather than throwing mid-array.
  const toDelta = (d: string) => {
    try { return ethers.utils.parseEther((d || '0').trim() || '0'); } catch { return ethers.constants.Zero; }
  };
  const createRewardType = () => {
    const fee = ethers.utils.parseEther(rtEntryFee || '0');
    const minP = parseInt(rtMinPlayers) || 2;
    const maxP = parseInt(rtMaxPlayers) || 10;
    const collectionBps = Math.max(0, Math.round((parseFloat(rtCollectionPct) || 0) * 100));
    if (rtFixedPoints) {
      const deltas = rtPlacementDeltas.map(toDelta);
      return exec('Create Reward Type (Fixed Points, via Hub)', () => getHubContract().createRewardType(rtName, fee, minP, maxP, collectionBps, [], true, deltas), refreshAfterChange);
    }
    const bps = rtPlacementBps.map(toBps);
    return exec('Create Reward Type (via Hub)', () => getHubContract().createRewardType(rtName, fee, minP, maxP, collectionBps, bps, false, []), refreshAfterChange);
  };
  const updateRewardType = () => {
    const fee = ethers.utils.parseEther(rtUpdateFee || '0');
    const minP = parseInt(rtUpdateMinPlayers) || 2;
    const maxP = parseInt(rtUpdateMaxPlayers) || 10;
    const collectionBps = Math.max(0, Math.round((parseFloat(rtUpdateCollectionPct) || 0) * 100));
    if (rtUpdateFixedPoints) {
      const deltas = rtUpdatePlacementDeltas.map(toDelta);
      return exec('Update Reward Type (Fixed Points, via Hub)', () => getHubContract().updateRewardType(parseInt(rtUpdateId), rtUpdateName, fee, minP, maxP, collectionBps, rtUpdateActive, [], true, deltas), refreshAfterChange);
    }
    const bps = rtUpdatePlacementBps.map(toBps);
    return exec('Update Reward Type (via Hub)', () => getHubContract().updateRewardType(parseInt(rtUpdateId), rtUpdateName, fee, minP, maxP, collectionBps, rtUpdateActive, bps, false, []), refreshAfterChange);
  };

  // Operator Reward Rules are stored per-instance (each operator has its own
  // dedicated DailySessionManager), so rules must be read/written against
  // THAT operator's instance — never the globally-loaded sessionManagerAddress,
  // which usually belongs to a different operator entirely.
  const getOperatorInstanceAddress = useCallback((operator: string) => {
    const op = cachedOperators.find(o => o.address === operator.toLowerCase());
    return op?.instance || sessionManagerAddress;
  }, [cachedOperators, sessionManagerAddress]);

  // Operator Reward Rules — load checklist for selected operator
  const loadRulesForOperator = useCallback(async (operator: string) => {
    const instanceAddr = getOperatorInstanceAddress(operator);
    if (!provider || !instanceAddr || !operator) { setRuleChecklist({}); setRuleOnChain({}); return; }
    const c = new ethers.Contract(instanceAddr, SessionManagerArtifact.abi, provider);
    setRuleLoading(true);
    try {
      const map: Record<number, boolean> = {};
      for (const rt of cachedRewardTypes) {
        try {
          const rule = await c.getOperatorRewardRule(operator, rt.id);
          map[rt.id] = !!(rule.exists && rule.allowed);
        } catch { map[rt.id] = false; }
      }
      setRuleChecklist({ ...map });
      setRuleOnChain({ ...map });
    } catch {}
    setRuleLoading(false);
  }, [provider, cachedRewardTypes, getOperatorInstanceAddress]);

  const toggleRule = (rtId: number) => {
    setRuleChecklist(prev => ({ ...prev, [rtId]: !prev[rtId] }));
  };

  const saveRules = () => {
    const instanceAddr = getOperatorInstanceAddress(ruleOperator);
    if (!instanceAddr) {
      setTxStatus({ status: 'error', error: 'Could not resolve this operator\'s instance address.' });
      return;
    }
    if (!signer) {
      setTxStatus({ status: 'error', error: 'Connect your wallet first.' });
      return;
    }
    const instanceContract = new ethers.Contract(instanceAddr, SessionManagerArtifact.abi, signer);
    // Find which rules changed
    const changedIds: number[] = [];
    const changedAllowed: boolean[] = [];
    for (const rt of cachedRewardTypes) {
      if (ruleChecklist[rt.id] !== ruleOnChain[rt.id]) {
        changedIds.push(rt.id);
        changedAllowed.push(!!ruleChecklist[rt.id]);
      }
    }
    if (changedIds.length === 0) {
      setTxStatus({ status: 'error', error: 'No changes to save.' });
      return;
    }
    if (changedIds.length === 1) {
      return exec(`Set Rule #${changedIds[0]}`, () => instanceContract.setOperatorRewardRule(ruleOperator, changedIds[0], changedAllowed[0]), () => { refreshAfterChange(); loadRulesForOperator(ruleOperator); });
    }
    return exec(`Batch Set ${changedIds.length} Rules`, () => instanceContract.batchSetOperatorRewardRules(ruleOperator, changedIds, changedAllowed), () => { refreshAfterChange(); loadRulesForOperator(ruleOperator); });
  };

  const selectAllRules = (allowed: boolean) => {
    const map: Record<number, boolean> = {};
    for (const rt of cachedRewardTypes) { map[rt.id] = allowed; }
    setRuleChecklist(map);
  };

  // Fetch operators & reward types from chain (fallback when cache is empty)
  const fetchFromChain = useCallback(async () => {
    const hub = getHubReadContract();
    const c = getReadContract();
    if (!hub && !c) return;
    setCacheLoading(true);
    try {
      const ops: CachedOperator[] = [];
      if (hub) {
        // Hub is the source of truth: each operator gets its OWN dedicated
        // instance, so scanning events off a single instance only ever finds
        // that instance's one operator. getOperators() returns every operator
        // ever registered (active + deactivated) across the whole fleet.
        const opAddrs: string[] = await hub.getOperators();
        for (const addr of opAddrs) {
          try {
            const rec = await hub.getOperatorRecord(addr);
            const instance = rec.instance;
            let metadataURI = '';
            let splitterAddress = '';
            try {
              if (provider) {
                const instanceContract = new ethers.Contract(instance, SessionManagerArtifact.abi, provider);
                const profile = await instanceContract.getOperatorProfile(addr);
                metadataURI = profile.metadataURI || '';
                splitterAddress = profile.splitterAddress || '';
              }
            } catch { /* instance profile unavailable */ }
            ops.push({
              address: addr.toLowerCase(),
              name: rec.name || 'Unnamed',
              active: rec.active,
              splitterAddress,
              metadataURI,
              instance,
            });
          } catch { /* skip */ }
        }
      } else if (c) {
        // Fallback for pre-Hub deployments: a single shared instance where
        // multiple operators register directly — discover via events.
        const currentBlock = await c.provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 50000);
        const regFilter = c.filters.SessionOperatorRegistered();
        const events = await c.queryFilter(regFilter, fromBlock, 'latest');
        const seen = new Set<string>();
        for (const ev of events) {
          const addr = (ev as any).args?.operator?.toLowerCase?.() || '';
          if (!addr || seen.has(addr)) continue;
          seen.add(addr);
          try {
            const profile = await c.getOperatorProfile(addr);
            ops.push({
              address: addr,
              name: profile.name || 'Unnamed',
              active: profile.active,
              splitterAddress: profile.splitterAddress || '',
              metadataURI: profile.metadataURI || '',
              instance: sessionManagerAddress || '',
            });
          } catch { /* skip */ }
        }
      }
      setCachedOperators(ops);
      try { localStorage.setItem(networkStorageKey('dg_cached_operators', chainId), JSON.stringify(ops)); } catch { /* ignore */ }

      // Load reward types — prefer the Hub catalog (source of truth, mirrored
      // to every instance); fall back to the loaded instance if no hub.
      const rtSource = hub || c;
      const rts: CachedRewardType[] = [];
      if (rtSource) {
        const nextIdRaw = await rtSource.nextRewardTypeId();
        const nextId = nextIdRaw?.toNumber?.() ?? Number(nextIdRaw);
        for (let i = 1; i < nextId; i++) {
          try {
            const rt = await rtSource.getRewardType(i);
            let placementBps: number[] = [];
            let placementDeltas: string[] = [];
            if (rt.fixedPoints) {
              const deltasRaw: any[] = await rtSource.getRewardTypePlacementDeltas(i);
              placementDeltas = deltasRaw.map((d: any) => ethers.utils.formatEther(d));
            } else {
              const bpsRaw: any[] = await rtSource.getRewardTypePlacementBps(i);
              placementBps = bpsRaw.map((b: any) => b?.toNumber?.() ?? Number(b));
            }
            rts.push({
              id: i, name: rt.name, entryFee: ethers.utils.formatEther(rt.entryFee),
              minPlayers: rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers),
              maxPlayers: rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers),
              collectionBps: rt.collectionBps?.toNumber?.() ?? Number(rt.collectionBps),
              active: rt.active, fixedPoints: rt.fixedPoints, placementBps, placementDeltas,
            });
          } catch { /* skip */ }
        }
      }
      setCachedRewardTypes(rts);
      try { localStorage.setItem(networkStorageKey('dg_cached_reward_types', chainId), JSON.stringify(rts)); } catch { /* ignore */ }

      setCacheLoaded(true);
    } catch { /* silent */ }
    setCacheLoading(false);
  }, [getReadContract, getHubReadContract, provider, sessionManagerAddress, chainId]);

  // Load from cache first, fall back to chain fetch if empty
  const loadCachedData = useCallback(async () => {
    let foundOps = false;
    let foundRts = false;
    try {
      const opsJson = localStorage.getItem(networkStorageKey('dg_cached_operators', chainId));
      if (opsJson) {
        const cached = JSON.parse(opsJson) as CachedOperator[];
        if (cached.length > 0) { setCachedOperators(cached); foundOps = true; }
      }
      const rtsJson = localStorage.getItem(networkStorageKey('dg_cached_reward_types', chainId));
      if (rtsJson) {
        const cached = JSON.parse(rtsJson) as CachedRewardType[];
        if (cached.length > 0) { setCachedRewardTypes(cached); foundRts = true; }
      }
    } catch { /* parse error */ }

    if (foundOps || foundRts) {
      setCacheLoaded(true);
    } else {
      await fetchFromChain();
    }
  }, [fetchFromChain, chainId]);

  // The operators/reward-types cache is namespaced per chainId (see loadCachedData/
  // fetchFromChain above), so a network switch must force a reload from that chain's own
  // cache/localStorage key rather than keep showing whatever the previous network loaded.
  useEffect(() => {
    setCacheLoaded(false);
    setCachedOperators([]);
    setCachedRewardTypes([]);
  }, [chainId]);

  // Auto-load on mount when either the Hub or an instance is available — the
  // Hub alone is enough to discover every operator, no instance selection needed.
  useEffect(() => {
    if (!cacheLoaded && !cacheLoading && (hubAddress || sessionManagerAddress)) {
      loadCachedData();
    }
  }, [cacheLoaded, cacheLoading, hubAddress, sessionManagerAddress, loadCachedData]);

  // DateKey Overview — for every registered operator, pull their session (if
  // any) on this dateKey, unique player count, points collected, and their
  // instance's current TestToken balance.
  const loadDateKeyOverview = useCallback(async () => {
    if (!provider) return;
    const dateKey = parseInt(dkInput);
    if (isNaN(dateKey)) { setDkError('Enter a valid numeric date key.'); return; }
    if (cachedOperators.length === 0) {
      setDkError('No operators loaded yet — expand "Operator Reward Rules" below and click Refresh, then try again.');
      return;
    }
    setDkLoading(true);
    setDkError('');
    try {
      const results = await Promise.all(cachedOperators.map(async (op) => {
        try {
          const instanceContract = new ethers.Contract(op.instance, SessionManagerArtifact.abi, provider);
          const sessionIdRaw = await instanceContract.getSessionIdByOperatorAndDate(op.address, dateKey);
          const sessionId = sessionIdRaw?.toNumber?.() ?? Number(sessionIdRaw);
          let matchCount = 0;
          let totalCollected = '0';
          let playerAddrs: string[] = [];
          if (sessionId > 0) {
            const s = await instanceContract.sessions(sessionId);
            matchCount = s.matchCount?.toNumber?.() ?? Number(s.matchCount);
            totalCollected = ethers.utils.formatEther(s.totalEntryCollected ?? 0);
            const matchIds: number[] = (await instanceContract.getMatchIds(sessionId)).map((x: any) => x?.toNumber?.() ?? Number(x));
            const playerSet = new Set<string>();
            for (const mid of matchIds) {
              try {
                const ps: string[] = await instanceContract.getMatchPlayers(sessionId, mid);
                ps.forEach((p: string) => playerSet.add(p.toLowerCase()));
              } catch { /* skip match */ }
            }
            playerAddrs = Array.from(playerSet);
          }
          let tokenBalance = '0';
          if (tokenAddress) {
            try {
              const tokenContract = new ethers.Contract(tokenAddress, TestTokenArtifact.abi, provider);
              const bal = await tokenContract.balanceOf(op.instance);
              tokenBalance = ethers.utils.formatEther(bal);
            } catch { /* token unavailable */ }
          }
          return { address: op.address, name: op.name, active: op.active, instance: op.instance, sessionId, matchCount, totalCollected, playerAddrs, tokenBalance };
        } catch {
          return { address: op.address, name: op.name, active: op.active, instance: op.instance, sessionId: 0, matchCount: 0, totalCollected: '0', playerAddrs: [] as string[], tokenBalance: '0' };
        }
      }));
      setDkRows(results);
      setDkLoaded(true);
    } catch (e: any) {
      setDkError(e?.message || 'Failed to load date key overview.');
    } finally {
      setDkLoading(false);
    }
  }, [provider, dkInput, cachedOperators, tokenAddress]);

  // Helper: select an operator to pre-fill update/remove form
  const selectOperatorForEdit = (addr: string) => {
    const op = cachedOperators.find(o => o.address === addr);
    if (op) {
      setOperatorAddr(op.address);
      setOperatorName(op.name);
      setOperatorMeta(op.metadataURI);
      setOperatorSplitter(op.splitterAddress);
    }
  };

  // Helper: select a reward type to pre-fill update form
  const selectRewardTypeForEdit = (id: string) => {
    const rt = cachedRewardTypes.find(r => r.id === parseInt(id));
    if (rt) {
      setRtUpdateId(String(rt.id));
      setRtUpdateName(rt.name);
      setRtUpdateFee(rt.entryFee);
      setRtUpdateMinPlayers(String(rt.minPlayers));
      setRtUpdateMaxPlayers(String(rt.maxPlayers));
      setRtUpdateCollectionPct(String((rt.collectionBps ?? 10000) / 100));
      setRtUpdateActive(rt.active);
      setRtUpdateFixedPoints(!!rt.fixedPoints);
      if (rt.fixedPoints && rt.placementDeltas && rt.placementDeltas.length > 0) {
        setRtUpdatePlacementDeltas(rt.placementDeltas);
      } else if (rt.placementBps && rt.placementBps.length > 0) {
        setRtUpdatePlacementBps(rt.placementBps.map(b => String(b)));
      }
    }
  };

  // Helper: select a reward type for the view section (sets ID; user clicks Fetch for full on-chain data)
  const selectRewardTypeForView = (id: string) => {
    setViewRtId(id);
  };

  // Schedule
  const setOffset = () => exec('Set Session Start Offset (via Hub)', () => getHubContract().setSessionStartOffset(parseInt(newOffset) || 0));

  // Session duration & grace period
  const loadScheduleConfig = useCallback(async () => {
    // The hub is the source of truth for schedule config (it broadcasts to instances).
    const c = getHubReadContract() || getReadContract();
    if (!c) return;
    try {
      const [dur, gp] = await Promise.all([
        c.sessionDuration(),
        c.finalizationGracePeriod(),
      ]);
      const durSecs = dur?.toNumber?.() ?? Number(dur);
      const gpSecs = gp?.toNumber?.() ?? Number(gp);
      setCurrentDuration(durSecs);
      setDurationMinutes(String(durSecs / 60));
      setCurrentGrace(gpSecs);
      setGraceHours(String(gpSecs / 3600));
    } catch {}
  }, [getHubReadContract, getReadContract]);

  useEffect(() => { loadScheduleConfig(); }, [loadScheduleConfig]);

  const setSessionDuration = () => {
    const mins = parseFloat(durationMinutes);
    if (isNaN(mins) || mins < 1 || mins > 10080) {
      setTxStatus({ status: 'error', error: 'Session duration must be between 1 minute and 7 days (10080 min).' });
      return;
    }
    const seconds = Math.round(mins * 60);
    return exec('Set Session Duration (via Hub)', () => getHubContract().setSessionDuration(seconds), loadScheduleConfig);
  };

  // Per-operator session duration — reads/writes straight against that operator's
  // dedicated instance (same resolution as Operator Reward Rules), never the hub.
  const loadOperatorSessionDuration = useCallback(async (operator: string) => {
    const instanceAddr = getOperatorInstanceAddress(operator);
    if (!provider || !instanceAddr || !operator) { setOpCurrentDuration(null); return; }
    setOpDurationLoading(true);
    try {
      const c = new ethers.Contract(instanceAddr, SessionManagerArtifact.abi, provider);
      const dur = await c.sessionDuration();
      const durSecs = dur?.toNumber?.() ?? Number(dur);
      setOpCurrentDuration(durSecs);
      setOpDurationMinutes(String(durSecs / 60));
    } catch {
      setOpCurrentDuration(null);
    } finally {
      setOpDurationLoading(false);
    }
  }, [provider, getOperatorInstanceAddress]);

  const selectOperatorForDuration = (operator: string) => {
    setOpDurationOperator(operator);
    if (operator) loadOperatorSessionDuration(operator);
    else setOpCurrentDuration(null);
  };

  const setOperatorSessionDuration = () => {
    const mins = parseFloat(opDurationMinutes);
    if (isNaN(mins) || mins < 1 || mins > 10080) {
      setTxStatus({ status: 'error', error: 'Session duration must be between 1 minute and 7 days (10080 min).' });
      return;
    }
    if (!opDurationOperator) {
      setTxStatus({ status: 'error', error: 'Select an operator first.' });
      return;
    }
    const instanceAddr = getOperatorInstanceAddress(opDurationOperator);
    if (!instanceAddr || !signer) {
      setTxStatus({ status: 'error', error: 'Could not resolve this operator\'s instance, or wallet not connected.' });
      return;
    }
    const seconds = Math.round(mins * 60);
    const instanceContract = new ethers.Contract(instanceAddr, SessionManagerArtifact.abi, signer);
    return exec(
      'Set Session Duration (this operator only)',
      () => instanceContract.setSessionDuration(seconds),
      () => loadOperatorSessionDuration(opDurationOperator)
    );
  };

  const setGracePeriod = () => {
    const hrs = parseFloat(graceHours);
    if (isNaN(hrs) || hrs < 0 || hrs > 48) {
      setTxStatus({ status: 'error', error: 'Grace period must be between 0 and 48 hours.' });
      return;
    }
    const seconds = Math.round(hrs * 3600);
    return exec('Set Grace Period (via Hub)', () => getHubContract().setFinalizationGracePeriod(seconds), loadScheduleConfig);
  };

  // Reward Eligibility Registry — a single registry shared by every operator instance
  // (read live from the hub, same as schedule config), so claimDailyPrBoost's cap check
  // resolves the same registry no matter which instance a wallet claims through.
  const loadRewardEligibilityRegistry = useCallback(async () => {
    const c = getHubReadContract();
    if (!c) return;
    setRewardEligibilityRegistryLoading(true);
    try {
      const addr = await c.rewardEligibilityRegistry();
      setRewardEligibilityRegistryOnChain(addr);
    } catch {
      setRewardEligibilityRegistryOnChain('');
    } finally {
      setRewardEligibilityRegistryLoading(false);
    }
  }, [getHubReadContract]);

  useEffect(() => { loadRewardEligibilityRegistry(); }, [loadRewardEligibilityRegistry]);

  const setRewardEligibilityRegistryOnHub = () => {
    if (!ethers.utils.isAddress(rewardEligibilityRegistryInput)) {
      setTxStatus({ status: 'error', error: 'Enter a valid registry contract address.' });
      return;
    }
    return exec(
      'Set Reward Eligibility Registry (via Hub)',
      () => getHubContract().setRewardEligibilityRegistry(rewardEligibilityRegistryInput),
      loadRewardEligibilityRegistry
    );
  };

  const clearRewardEligibilityRegistryOnHub = () => exec(
    'Clear Reward Eligibility Registry (via Hub)',
    () => getHubContract().setRewardEligibilityRegistry(ethers.constants.AddressZero),
    loadRewardEligibilityRegistry
  );

  // Withdraw
  const withdraw = () => {
    const amt = ethers.utils.parseEther(withdrawAmt || '0');
    return exec('Withdraw Retained', () => getContract()!.withdrawRetained(withdrawTo, amt));
  };

  // Pause — platform-wide via the hub (per-instance failures are logged, not fatal)
  const doPause = () => exec('Pause All Instances (via Hub)', () => getHubContract().pauseAll());
  const doUnpause = () => exec('Unpause All Instances (via Hub)', () => getHubContract().unpauseAll());

  if (!sessionManagerAddress && !hubAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load a GameHub first (Deploy tab), then select an operator instance from the Hub tab.</p></Card>;
  }

  const SectionHeader = ({ id, label, icon: Icon }: { id: string; label: string; icon: any }) => (
    <button onClick={() => toggle(id)} className="flex items-center gap-2 w-full text-left py-2">
      <Icon className="w-4 h-4 text-accent" />
      <span className="font-medium text-sm">{label}</span>
      {openSection === id ? <ChevronUp className="w-4 h-4 ml-auto text-txt-secondary" /> : <ChevronDown className="w-4 h-4 ml-auto text-txt-secondary" />}
    </button>
  );

  const inputCls = 'w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
  const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2 rounded-lg text-sm transition-colors';
  const btnOutlineCls = 'bg-transparent border border-red-500/50 hover:bg-red-500/10 text-red-400 font-medium py-2 rounded-lg text-sm transition-colors';

  // Placement payouts (both modes) are sized off the FULL pot (entryFee × players), but
  // only collectionBps% of that pot is actually pulled from the operator's wallet into
  // the contract at createMatch. If placements promise more than collectionBps collects,
  // the contract can't back that match's payouts on its own — it would depend on other
  // matches'/operators' funds sitting in the same contract to cover the gap. So the
  // invariant that actually keeps a reward type solvent is totalPayout ≤ collected,
  // not totalBps ≤ 10000 (which the contract itself enforces). For Fixed Points mode,
  // "totalPayout" is the sum of positive deltas (negatives don't draw from the pot);
  // "pool"/"collected" use the same entryFee×minPlayers preview convention as bps mode.
  const rtTotalBps = rtPlacementBps.reduce((s, b) => s + toBps(b), 0);
  const rtCollectionBps = Math.max(0, Math.round((parseFloat(rtCollectionPct) || 0) * 100));
  const rtPool = (parseFloat(rtEntryFee) || 0) * (parseInt(rtMinPlayers) || 2);
  const rtCollectedPoints = rtPool * rtCollectionBps / 10000;
  const rtTotalPositiveDelta = rtPlacementDeltas.reduce((s, d) => s + Math.max(0, parseFloat(d) || 0), 0);
  const rtUnderfunded = rtFixedPoints
    ? rtTotalPositiveDelta > rtCollectedPoints
    : rtTotalBps > rtCollectionBps;

  const rtUpdateTotalBps = rtUpdatePlacementBps.reduce((s, b) => s + toBps(b), 0);
  const rtUpdateCollectionBps = Math.max(0, Math.round((parseFloat(rtUpdateCollectionPct) || 0) * 100));
  const rtUpdatePool = (parseFloat(rtUpdateFee) || 0) * (parseInt(rtUpdateMinPlayers) || 2);
  const rtUpdateCollectedPoints = rtUpdatePool * rtUpdateCollectionBps / 10000;
  const rtUpdateTotalPositiveDelta = rtUpdatePlacementDeltas.reduce((s, d) => s + Math.max(0, parseFloat(d) || 0), 0);
  const rtUpdateUnderfunded = rtUpdateFixedPoints
    ? rtUpdateTotalPositiveDelta > rtUpdateCollectedPoints
    : rtUpdateTotalBps > rtUpdateCollectionBps;

  return (
    <div className="space-y-4">
      {/* Current Contract Address Banner */}
      <div className="bg-surface-secondary border border-accent/30 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <span className="text-xs text-txt-secondary font-medium shrink-0">📋 Current SessionManager Address:</span>
        <code className="text-xs text-accent font-mono break-all select-all">{sessionManagerAddress}</code>
        <a
          href={getExplorerAddressUrl(chainId, sessionManagerAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 underline shrink-0"
        >
          View on BscScan ↗
        </a>
      </div>

      {/* Admin Wallet Banner */}
      <div className="bg-surface-secondary border border-yellow-500/30 rounded-lg px-4 py-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-xs text-txt-secondary font-medium shrink-0 inline-flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-yellow-400" /> Admin Wallet (DEFAULT_ADMIN):
          </span>
          {adminLoading ? (
            <span className="text-xs text-txt-secondary inline-flex items-center gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> Loading…</span>
          ) : adminWallet ? (
            <>
              <code className="text-xs text-yellow-400 font-mono break-all select-all">{adminWallet}</code>
              <a
                href={getExplorerAddressUrl(chainId, adminWallet)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 underline shrink-0"
              >
                View on BscScan ↗
              </a>
              <button onClick={loadAdminWallet} className="text-[11px] text-accent hover:underline inline-flex items-center gap-1 shrink-0">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </>
          ) : (
            <span className="text-xs text-txt-secondary">Unavailable (contract may predate this field — redeploy to enable).</span>
          )}
        </div>
        {adminWallet && address && (
          <p className="text-[11px] mt-1.5">
            {adminWallet.toLowerCase() === address.toLowerCase() ? (
              <span className="text-green-400 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Your connected wallet IS the admin.</span>
            ) : (
              <span className="text-txt-secondary">Your connected wallet is <span className="text-red-400">not</span> the admin.</span>
            )}
          </p>
        )}
      </div>

      {/* DateKey Overview — All Operators */}
      <Card>
        <SectionHeader id="dateKeyOverview" label="DateKey Overview — All Operators" icon={Calendar} />
        {openSection === 'dateKeyOverview' && (
          <div className="space-y-3 mt-2">
            <p className="text-xs text-txt-secondary">See every registered operator&apos;s session, player count, and points collected for a given date key, plus the points balance currently sitting in each operator&apos;s contract instance.</p>

            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="text-xs text-txt-secondary">Date Key (today: {Math.floor(Date.now() / 1000 / 86400)})</label>
                <input type="number" value={dkInput} onChange={e => setDkInput(e.target.value)} className={inputCls} />
              </div>
              <button onClick={loadDateKeyOverview} disabled={!provider || dkLoading} className={`shrink-0 px-4 py-2 mt-1 ${btnCls}`}>
                {dkLoading ? 'Loading...' : 'Load Overview'}
              </button>
            </div>

            {cachedOperators.length === 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-xs text-yellow-400">
                ⚠️ No operators loaded yet. Expand &quot;Operator Reward Rules&quot; below and click Refresh, then try again.
              </div>
            )}

            {dkError && <p className="text-xs text-red-400">{dkError}</p>}

            {dkLoaded && dkRows.length > 0 && (() => {
              const allPlayers = new Set<string>();
              dkRows.forEach(r => r.playerAddrs.forEach((p: string) => allPlayers.add(p)));
              const totalCollected = dkRows.reduce((s, r) => s + (parseFloat(r.totalCollected) || 0), 0);
              const totalBalance = dkRows.reduce((s, r) => s + (parseFloat(r.tokenBalance) || 0), 0);
              const withSession = dkRows.filter(r => r.sessionId > 0).length;
              return (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-surface-tertiary rounded-lg p-3 text-center">
                      <p className="text-[10px] text-txt-secondary">Operators w/ Session</p>
                      <p className="text-lg font-bold text-txt-primary">{withSession} / {dkRows.length}</p>
                    </div>
                    <div className="bg-surface-tertiary rounded-lg p-3 text-center">
                      <p className="text-[10px] text-txt-secondary">Total Players</p>
                      <p className="text-lg font-bold text-accent">{allPlayers.size}</p>
                    </div>
                    <div className="bg-surface-tertiary rounded-lg p-3 text-center">
                      <p className="text-[10px] text-txt-secondary">Total Collected (dateKey)</p>
                      <p className="text-lg font-bold text-green-400">{totalCollected.toFixed(4)}</p>
                    </div>
                    <div className="bg-surface-tertiary rounded-lg p-3 text-center">
                      <p className="text-[10px] text-txt-secondary">Total Contract Balance</p>
                      <p className="text-lg font-bold text-yellow-400">{totalBalance.toFixed(4)}</p>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-txt-secondary border-b border-white/10">
                          <th className="text-left py-1.5 px-2">Operator</th>
                          <th className="text-center py-1.5 px-2">Session</th>
                          <th className="text-center py-1.5 px-2">Matches</th>
                          <th className="text-center py-1.5 px-2">Players</th>
                          <th className="text-right py-1.5 px-2">Collected</th>
                          <th className="text-right py-1.5 px-2">Contract Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dkRows.map(r => (
                          <tr key={r.address} className="border-b border-white/5">
                            <td className="py-1.5 px-2">
                              <span className="font-medium">{r.name || 'Unnamed'}</span>{' '}
                              <span className={`text-[9px] px-1 py-0.5 rounded ${r.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{r.active ? 'ACTIVE' : 'INACTIVE'}</span>
                              <div className="font-mono text-txt-secondary text-[10px]">{r.address.slice(0, 6)}…{r.address.slice(-4)}</div>
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {r.sessionId > 0 ? <span className="text-green-400">#{r.sessionId}</span> : <span className="text-txt-secondary">— none —</span>}
                            </td>
                            <td className="py-1.5 px-2 text-center">{r.matchCount}</td>
                            <td className="py-1.5 px-2 text-center">{r.playerAddrs.length}</td>
                            <td className="py-1.5 px-2 text-right text-accent">{parseFloat(r.totalCollected).toFixed(4)}</td>
                            <td className="py-1.5 px-2 text-right text-yellow-400">{parseFloat(r.tokenBalance).toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[10px] text-txt-secondary/70">Total Players counts each unique address once even if they played under multiple operators. Contract Balance is each instance&apos;s current points balance (not dateKey-specific) — Total Collected is what was actually gathered into that instance for this date key&apos;s session.</p>
                </>
              );
            })()}
          </div>
        )}
      </Card>

      {/* Operator Management */}
      <Card>
        <SectionHeader id="operators" label="Session Operator Management (DEFAULT_ADMIN only)" icon={UserPlus} />
        {openSection === 'operators' && (
          <div className="space-y-3 mt-2">
            <p className="text-xs text-txt-secondary">Register/update/remove session operators. Select an existing operator to pre-fill fields for update/remove, or enter a new address to register.</p>
            <p className="text-[11px] text-accent/80">Registering an operator also grants it the Platform Updater role for its own game only — it can update/finalize its own daily points but never another operator&apos;s. Removing an operator revokes both roles.</p>

            {/* Quick-select existing operator */}
            {cachedOperators.filter(o => o.active).length > 0 && (
              <div className="bg-surface-tertiary/50 rounded-lg p-3">
                <label className="text-xs text-txt-secondary font-medium">Load Existing Operator</label>
                <div className="flex gap-2 items-end">
                  <select
                    className={inputCls + ' flex-1'}
                    defaultValue=""
                    onChange={e => { if (e.target.value) selectOperatorForEdit(e.target.value); }}
                  >
                    <option value="">— Select to pre-fill fields —</option>
                    {cachedOperators.filter(o => o.active).map(op => (
                      <option key={op.address} value={op.address}>
                        {op.name} ({op.address.slice(0, 6)}…{op.address.slice(-4)})
                      </option>
                    ))}
                  </select>
                  <button onClick={() => { setOperatorAddr(''); setOperatorName(''); setOperatorMeta(''); setOperatorSplitter(''); }} className="shrink-0 px-3 py-2 mt-1 bg-surface-tertiary hover:bg-surface-tertiary/70 text-txt-secondary text-xs rounded-lg">Clear</button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-txt-secondary">Operator Address</label>
                <input value={operatorAddr} onChange={e => setOperatorAddr(e.target.value)} placeholder="0x..." className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Name</label>
                <input value={operatorName} onChange={e => setOperatorName(e.target.value)} placeholder="Operator Name" className={inputCls.replace('font-mono', '')} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Metadata URI</label>
                <input value={operatorMeta} onChange={e => setOperatorMeta(e.target.value)} placeholder="ipfs://... or https://..." className={inputCls} />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-txt-secondary">Payment Splitter Address <span className="text-accent">*</span></label>
                <input value={operatorSplitter} onChange={e => setOperatorSplitter(e.target.value)} placeholder="0x... (PaymentSplitter contract)" className={inputCls} />
                <p className="text-[10px] text-txt-secondary mt-0.5">Funds are auto-transferred here when the day is finalized.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={registerOperator} disabled={!isConnected} className={`flex-1 ${btnCls}`}>Register</button>
              <button onClick={updateOperator} disabled={!isConnected} className={`flex-1 ${btnCls}`}>Update</button>
              <button onClick={removeOperator} disabled={!isConnected} className={`flex-1 ${btnOutlineCls}`}>Remove</button>
            </div>
          </div>
        )}
      </Card>

      {/* Platform Updater Management */}
      <Card>
        <SectionHeader id="updaters" label="Platform Updater Management (DEFAULT_ADMIN only)" icon={Shield} />
        {openSection === 'updaters' && (
          <div className="space-y-3 mt-2">
            <p className="text-xs text-txt-secondary">Every operator already gets platform-updater rights over its own game automatically when registered above — <strong>you don&apos;t need this section for that.</strong> Use this only to register an <strong>extra/delegate</strong> updater wallet (e.g. a teammate) for an operator. Each updater is <strong>linked to one operator</strong> and can only finalize that operator&apos;s sessions, never another&apos;s.</p>
            <div>
              <label className="text-xs text-txt-secondary">Updater Address</label>
              <input value={updaterAddr} onChange={e => setUpdaterAddr(e.target.value)} placeholder="0x..." className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-txt-secondary">Linked Operator Address <span className="text-yellow-500">(required for registration)</span></label>
              <input value={updaterLinkedOp} onChange={e => setUpdaterLinkedOp(e.target.value)} placeholder="0x... operator this updater manages" className={inputCls} />
            </div>
            <div className="flex gap-2">
              <button onClick={registerUpdater} disabled={!isConnected || !updaterLinkedOp} className={`flex-1 ${btnCls}`}>Register Updater</button>
              <button onClick={removeUpdater} disabled={!isConnected} className={`flex-1 ${btnOutlineCls}`}>Remove Updater</button>
            </div>
          </div>
        )}
      </Card>

      {/* Reward Type Management */}
      <Card>
        <SectionHeader id="rewardtypes" label="Reward Type Management" icon={Layers} />
        {openSection === 'rewardtypes' && (
          <div className="space-y-4 mt-2">
            <p className="text-xs text-txt-secondary">Create, view, and manage reward types. Each has a name, entryFee, min/max players, and placement reward BPS (basis points per placement: index 0 = 1st place, index 1 = 2nd place, etc.). Changes go through the GameHub and sync to every operator instance.</p>
            <p className="text-xs text-txt-secondary">Note: placement BPS only apply when a match is settled in <strong>Placement %</strong> mode. Settling in <strong>Point Deltas (±)</strong> mode (Matches tab) ignores them and applies exact signed amounts per player instead — the reward type then just defines the entry fee, player range and pot cap.</p>

            {/* View / Preview Reward Type */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-3">
              <h5 className="text-xs font-semibold text-accent flex items-center gap-1.5"><Search className="w-3.5 h-3.5" /> View Reward Type</h5>
              {cachedRewardTypes.length > 0 && (
                <div>
                  <label className="text-xs text-txt-secondary">Quick Select from Cache</label>
                  <div className="flex gap-2">
                    <select value={viewRtId} onChange={e => { if (e.target.value) selectRewardTypeForView(e.target.value); else setViewRtId(''); }} className={`flex-1 ${inputCls}`}>
                      <option value="">— Select Reward Type —</option>
                      {cachedRewardTypes.map(rt => (
                        <option key={rt.id} value={String(rt.id)}>
                          #{rt.id} {rt.name} — {rt.entryFee} pts ({rt.minPlayers}-{rt.maxPlayers}P){!rt.active ? ' [INACTIVE]' : ''}
                        </option>
                      ))}
                    </select>
                    {viewRtId && <button onClick={() => { setViewRtId(''); }} className="px-2 text-xs text-txt-secondary hover:text-red-400 transition-colors" title="Clear">✕</button>}
                  </div>
                </div>
              )}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-xs text-txt-secondary">Reward Type ID</label>
                  <input type="number" value={viewRtId} onChange={e => setViewRtId(e.target.value)} placeholder="1" className={inputCls} />
                </div>
                <button onClick={fetchRewardType} disabled={!provider || !viewRtId || viewRtLoading}
                  className={`shrink-0 px-4 py-2 mt-1 ${btnCls}`}>
                  {viewRtLoading ? 'Loading...' : 'Fetch'}
                </button>
              </div>
              {viewRtError && <p className="text-xs text-red-400">{viewRtError}</p>}
              {viewedRt && (
                <div className="space-y-3">
                  {/* Basic Info */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Name</p>
                      <p className="font-semibold text-txt-primary mt-0.5">{viewedRt.name || '(unnamed)'}</p>
                    </div>
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Entry Fee</p>
                      <p className="font-semibold text-accent mt-0.5">{viewedRt.entryFee} pts</p>
                    </div>
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Players</p>
                      <p className="font-semibold text-txt-primary mt-0.5">{viewedRt.minPlayers} – {viewedRt.maxPlayers}</p>
                    </div>
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Collect % of Pot</p>
                      <p className="font-semibold text-txt-primary mt-0.5">{(viewedRt.collectionBps / 100).toFixed(2)}%</p>
                    </div>
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Status</p>
                      <p className={`font-semibold mt-0.5 ${viewedRt.active ? 'text-green-400' : 'text-red-400'}`}>{viewedRt.active ? 'Active' : 'Inactive'}</p>
                    </div>
                    <div className="bg-surface-secondary rounded-lg p-2.5">
                      <p className="text-txt-secondary text-[10px] uppercase tracking-wide">Mode</p>
                      <p className="font-semibold text-txt-primary mt-0.5">{viewedRt.fixedPoints ? 'Fixed Points (±)' : 'Percentage of Pool'}</p>
                    </div>
                  </div>

                  {viewedRt.fixedPoints ? (
                    <div>
                      <p className="text-[11px] text-txt-secondary font-medium mb-1.5">Placement Points ({viewedRt.placementDeltas.length} placements configured)</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                        {viewedRt.placementDeltas.map((d, i) => {
                          const val = parseFloat(d) || 0;
                          return (
                            <div key={i} className={`rounded-lg p-2 text-center text-xs ${val > 0 ? 'bg-green-500/10 border border-green-500/20' : val < 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-surface-secondary border border-white/5'}`}>
                              <span className="text-txt-secondary">{i === 0 ? '🥇 1st' : i === 1 ? '🥈 2nd' : i === 2 ? '🥉 3rd' : `#${i + 1}`}</span>
                              <p className={`font-bold ${val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-txt-secondary'}`}>{val > 0 ? `+${d}` : d} pts</p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-txt-secondary mt-1.5">
                        These are exact signed amounts applied by settleMatch — independent of player count. Total positive points are capped at each match&apos;s actual pot (entryFee × that match&apos;s players) when settled.
                      </p>
                    </div>
                  ) : (
                  <>
                  {/* Placement BPS breakdown */}
                  <div>
                    <p className="text-[11px] text-txt-secondary font-medium mb-1.5">Placement Rewards ({viewedRt.placementBps.length} placements configured)</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                      {viewedRt.placementBps.map((bps, i) => (
                        <div key={i} className={`rounded-lg p-2 text-center text-xs ${bps > 0 ? 'bg-green-500/10 border border-green-500/20' : 'bg-surface-secondary border border-white/5'}`}>
                          <span className="text-txt-secondary">{i === 0 ? '🥇 1st' : i === 1 ? '🥈 2nd' : i === 2 ? '🥉 3rd' : `#${i + 1}`}</span>
                          <p className={`font-bold ${bps > 0 ? 'text-green-400' : 'text-txt-secondary'}`}>{bps} bps</p>
                          <p className="text-[10px] text-txt-secondary">{(bps / 100).toFixed(1)}%</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-txt-secondary mt-1.5">
                      Total distributed: <span className="text-accent font-semibold">{viewedRt.placementBps.reduce((s, b) => s + b, 0)}</span> / 10000 bps
                      ({(viewedRt.placementBps.reduce((s, b) => s + b, 0) / 100).toFixed(1)}%)
                      {viewedRt.placementBps.reduce((s, b) => s + b, 0) < 10000 && (
                        <span className="text-txt-secondary/60"> — remaining {10000 - viewedRt.placementBps.reduce((s, b) => s + b, 0)} bps stays in contract</span>
                      )}
                    </p>
                  </div>

                  {/* Mini Calculator */}
                  <div className="border-t border-white/10 pt-3">
                    <p className="text-[11px] text-txt-secondary font-medium flex items-center gap-1 mb-2"><Calculator className="w-3 h-3" /> Quick Reward Calculator</p>
                    <div className="flex gap-2 items-end mb-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-txt-secondary"># Players in match</label>
                        <input type="number" value={viewCalcPlayers} onChange={e => setViewCalcPlayers(e.target.value)}
                          min={viewedRt.minPlayers} max={viewedRt.maxPlayers} placeholder={String(viewedRt.minPlayers)}
                          className="w-full mt-0.5 bg-surface-secondary rounded px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
                      </div>
                      <div className="text-xs text-txt-secondary py-1.5">
                        Range: {viewedRt.minPlayers}–{viewedRt.maxPlayers}
                      </div>
                    </div>
                    {(() => {
                      const numP = parseInt(viewCalcPlayers) || viewedRt.minPlayers;
                      if (numP < viewedRt.minPlayers || numP > viewedRt.maxPlayers) {
                        return <p className="text-xs text-red-400">Player count must be between {viewedRt.minPlayers} and {viewedRt.maxPlayers}</p>;
                      }
                      const poolStr = (parseFloat(viewedRt.entryFee) * numP).toFixed(6).replace(/\.?0+$/, '');
                      const pool = parseFloat(viewedRt.entryFee) * numP;
                      const collected = pool * viewedRt.collectionBps / 10000;
                      const collectedStr = collected.toFixed(6).replace(/\.?0+$/, '');
                      return (
                        <div className="bg-surface-secondary rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-txt-secondary">Match Pool (used for rewards)</span>
                            <span className="text-accent font-bold">{poolStr} pts</span>
                          </div>
                          <div className="text-[11px] text-txt-secondary mb-1">= {viewedRt.entryFee} × {numP} players</div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-txt-secondary">Actually Collected from Operator</span>
                            <span className="text-txt-primary font-bold">{collectedStr} pts</span>
                          </div>
                          <div className="text-[11px] text-txt-secondary/70 mb-1">= Match Pool × {(viewedRt.collectionBps / 100).toFixed(2)}%</div>
                          <div className="space-y-1">
                            {Array.from({ length: numP }).map((_, i) => {
                              const bps = i < viewedRt.placementBps.length ? viewedRt.placementBps[i] : 0;
                              const reward = pool * bps / 10000;
                              const rewardStr = reward.toFixed(6).replace(/\.?0+$/, '');
                              const label = i === 0 ? '🥇 1st' : i === 1 ? '🥈 2nd' : i === 2 ? '🥉 3rd' : `#${i + 1}`;
                              return (
                                <div key={i} className="flex items-center justify-between text-xs">
                                  <span className="text-txt-secondary">{label} <span className="text-txt-secondary/50">({bps} bps)</span></span>
                                  <span className={`font-semibold ${reward > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                                    {reward > 0 ? `+${rewardStr}` : '0'} pts
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {(() => {
                            const totalBps = Array.from({ length: numP }).reduce<number>((s, _, i) => s + (i < viewedRt.placementBps.length ? viewedRt.placementBps[i] : 0), 0);
                            const totalReward = pool * totalBps / 10000;
                            const remaining = pool - totalReward;
                            return (
                              <div className="border-t border-white/5 pt-1.5 mt-1 flex items-center justify-between text-xs">
                                <span className="text-txt-secondary">Total paid out</span>
                                <span className="text-green-400 font-bold">{totalReward.toFixed(6).replace(/\.?0+$/, '')} pts</span>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </div>
                  </>
                  )}
                </div>
              )}
            </div>

            {/* Create */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Create Reward Type</h5>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <div>
                  <label className="text-xs text-txt-secondary">Name</label>
                  <input value={rtName} onChange={e => setRtName(e.target.value)} placeholder="e.g. Gold Match" className={inputCls.replace('font-mono', '')} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Entry Fee (points)</label>
                  <input value={rtEntryFee} onChange={e => setRtEntryFee(e.target.value)} placeholder="10" className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Min Players</label>
                  <input type="number" value={rtMinPlayers} onChange={e => setRtMinPlayers(e.target.value)} min="2" className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Max Players</label>
                  <input type="number" value={rtMaxPlayers} onChange={e => setRtMaxPlayers(e.target.value)} min="2" className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary" title="% of the full pot (entryFee × players) actually pulled from the operator on createMatch. matchValue/rewards stay based on the full pot.">Collect % of Pot</label>
                  <input type="number" value={rtCollectionPct} onChange={e => { const v = e.target.value; setRtCollectionPct(v === '' ? '' : String(Math.max(0, parseFloat(v) || 0))); }} min="0" max="100" step="0.01" placeholder="100" className={inputCls} />
                </div>
              </div>
              <div className="bg-surface rounded-lg p-2.5">
                <p className="text-[11px] text-txt-secondary mb-1.5">
                  Want negative points for a placement (e.g. a penalty rule: 1st <span className="text-red-400 font-mono">-1</span>, 2nd <span className="text-red-400 font-mono">-1</span>, 3rd <span className="text-green-400 font-mono">+10</span>)?
                  The BPS/%/Payout fields below can only go to 0 — switch to <strong>Fixed Points (±)</strong> to type exact signed points instead.
                </p>
                <div className="flex items-center gap-2 w-fit">
                  <button onClick={() => setRtFixedPoints(false)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!rtFixedPoints ? 'bg-accent text-black' : 'bg-surface-secondary text-txt-secondary hover:text-txt-primary'}`}>Percentage of Pool</button>
                  <button onClick={() => setRtFixedPoints(true)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${rtFixedPoints ? 'bg-accent text-black' : 'bg-surface-secondary text-txt-secondary hover:text-txt-primary'}`}>Fixed Points (±)</button>
                </div>
              </div>

              {!rtFixedPoints && (
              <div>
                <label className="text-xs text-txt-secondary">Placement Rewards — enter BPS, % or Payout points (all sync automatically)</label>
                <div className="space-y-1.5 mt-1">
                  <div className="flex items-center gap-2 text-[10px] text-txt-secondary font-medium">
                    <span className="w-10 shrink-0"></span>
                    <span className="flex-1 text-center">BPS (out of 10000)</span>
                    <span className="w-4 shrink-0 text-center">↔</span>
                    <span className="flex-1 text-center">Percentage (%)</span>
                    <span className="w-4 shrink-0 text-center">↔</span>
                    <span className="flex-1 text-center">Payout (points)</span>
                    <span className="w-20 shrink-0 text-center">Actual</span>
                    <span className="w-14 shrink-0"></span>
                  </div>
                  {rtPlacementBps.map((bps, i) => {
                    const bpsVal = parseInt(bps) || 0;
                    const pctFromBps = (bpsVal / 100).toFixed(2);
                    const fee = parseFloat(rtEntryFee) || 0;
                    const minP = parseInt(rtMinPlayers) || 2;
                    const pool = fee * minP;
                    const actualPayout = pool > 0 ? ((pool * bpsVal) / 10000) : 0;
                    const actualPayoutStr = actualPayout.toFixed(4).replace(/\.?0+$/, '');
                    const labels = ['🥇', '🥈', '🥉'];
                    const pctKey = `create-pct-${i}`;
                    const payKey = `create-pay-${i}`;
                    const isPctFocused = focusedField === pctKey;
                    const isPayFocused = focusedField === payKey;
                    const displayPct = isPctFocused && localPctEdit?.key === pctKey ? localPctEdit.value : pctFromBps;
                    const displayPayout = isPayFocused && localPayoutEdit?.key === payKey ? localPayoutEdit.value : (pool > 0 ? actualPayoutStr : '');
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-[11px] text-txt-secondary w-10 shrink-0">{labels[i] ?? `#${i + 1}`}</span>
                        <input type="number" value={bps} onChange={e => { const v = e.target.value; const clamped = v === '' ? '' : String(Math.max(0, parseInt(v) || 0)); setRtPlacementBps(prev => prev.map((b, idx) => idx === i ? clamped : b)); }} placeholder="0" min="0" max="10000" className={inputCls + ' !mt-0'} />
                        <span className="text-[11px] text-txt-secondary w-4 shrink-0 text-center">↔</span>
                        <input type="number" value={displayPct}
                          onFocus={() => { setFocusedField(pctKey); setLocalPctEdit({ key: pctKey, value: pctFromBps }); }}
                          onChange={e => {
                            const val = e.target.value;
                            setLocalPctEdit({ key: pctKey, value: val });
                            const pct = Math.max(0, parseFloat(val) || 0);
                            const newBps = String(Math.round(pct * 100));
                            setRtPlacementBps(prev => prev.map((b, idx) => idx === i ? newBps : b));
                          }}
                          onBlur={() => { setFocusedField(null); setLocalPctEdit(null); }}
                          placeholder="0" min="0" max="100" step="0.01" className={inputCls + ' !mt-0'} />
                        <span className="text-[11px] text-txt-secondary w-4 shrink-0 text-center">↔</span>
                        <input type="number" value={displayPayout}
                          onFocus={() => { setFocusedField(payKey); setLocalPayoutEdit({ key: payKey, value: pool > 0 ? actualPayoutStr : '' }); }}
                          onChange={e => {
                            const val = e.target.value;
                            setLocalPayoutEdit({ key: payKey, value: val });
                            const payVal = Math.max(0, parseFloat(val) || 0);
                            if (pool > 0) {
                              const newBps = String(Math.round((payVal * 10000) / pool));
                              setRtPlacementBps(prev => prev.map((b, idx) => idx === i ? newBps : b));
                            }
                          }}
                          onBlur={() => { setFocusedField(null); setLocalPayoutEdit(null); }}
                          placeholder={pool > 0 ? '0' : 'Set fee & min'} disabled={pool <= 0} min="0" step="0.01" className={inputCls + ' !mt-0' + (pool <= 0 ? ' opacity-40' : '')} />
                        <span className={`text-[11px] w-20 shrink-0 text-right font-semibold ${actualPayout > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                          {pool > 0 ? (actualPayout > 0 ? actualPayoutStr : '0') : '—'}
                        </span>
                        {rtPlacementBps.length > 1 ? (
                          <button onClick={() => setRtPlacementBps(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 text-xs hover:underline w-14 shrink-0 text-right">Remove</button>
                        ) : <span className="w-14 shrink-0" />}
                      </div>
                    );
                  })}
                  <button onClick={() => setRtPlacementBps(prev => [...prev, '0'])} className="text-xs text-accent hover:underline">+ Add placement</button>
                  {(() => {
                    const totalBps = rtPlacementBps.reduce((s, b) => s + (parseInt(b) || 0), 0);
                    const remaining = 10000 - totalBps;
                    const fee = parseFloat(rtEntryFee) || 0;
                    const minP = parseInt(rtMinPlayers) || 2;
                    const pool = fee * minP;
                    const totalPayout = pool > 0 ? (pool * totalBps / 10000) : 0;
                    return (
                      <div className="text-[11px] text-txt-secondary mt-1 space-y-0.5">
                        <div className="flex flex-wrap gap-x-3">
                          <span>Total: <span className={`font-semibold ${totalBps > 10000 ? 'text-red-400' : 'text-accent'}`}>{totalBps}</span> / 10000 BPS ({(totalBps / 100).toFixed(1)}%)</span>
                          {pool > 0 && <span>Total payout: <span className="text-green-400 font-semibold">{totalPayout.toFixed(4).replace(/\.?0+$/, '')}</span> / {pool} pts</span>}
                          {totalBps > 10000 && <span className="text-red-400 font-semibold">⚠ Exceeds 100%!</span>}
                          {remaining > 0 && totalBps <= 10000 && <span>Retained (operator fee): <span className="text-yellow-400 font-semibold">{remaining} BPS ({(remaining / 100).toFixed(1)}%)</span></span>}
                        </div>
                        {pool > 0 && totalBps > 0 && totalPayout !== Math.round(totalPayout * 100) / 100 && (
                          <p className="text-[10px] text-yellow-400/70">ℹ Actual payouts may differ slightly from desired values due to BPS integer rounding. The &quot;Actual&quot; column shows the on-chain payout.</p>
                        )}
                        {rtUnderfunded && (
                          <p className="text-yellow-400/80">
                            ℹ Placement rewards total {(totalBps / 100).toFixed(2)}% of the pot, but Collect % of Pot is only {(rtCollectionBps / 100).toFixed(2)}%.
                            This is only a problem if you treat daily points as tokens redeemable 1:1 — this contract never pays them out itself
                            (finalizeDailyPoints only transfers the operator&apos;s collected amount to their splitter, independent of any player&apos;s points).
                            If points are a score/leaderboard value with payouts handled separately, this is fine to ignore.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              )}

              {rtFixedPoints && (
              <div>
                <label className="text-xs text-txt-secondary">Placement Points — exact signed points per rank (negatives allowed, e.g. 1st: -1, 2nd: -1, 3rd: 10)</label>
                <div className="space-y-1.5 mt-1">
                  {rtPlacementDeltas.map((d, i) => {
                    const labels = ['🥇', '🥈', '🥉'];
                    const val = parseFloat(d) || 0;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-[11px] text-txt-secondary w-10 shrink-0">{labels[i] ?? `#${i + 1}`}</span>
                        <input value={d} onChange={e => setRtPlacementDeltas(prev => prev.map((x, idx) => idx === i ? e.target.value : x))} placeholder="0" className={`${inputCls} !mt-0 ${val < 0 ? 'text-red-400' : val > 0 ? 'text-green-400' : ''}`} />
                        <span className="text-[11px] text-txt-secondary w-12 shrink-0">points</span>
                        {rtPlacementDeltas.length > 1 ? (
                          <button onClick={() => setRtPlacementDeltas(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 text-xs hover:underline w-14 shrink-0 text-right">Remove</button>
                        ) : <span className="w-14 shrink-0" />}
                      </div>
                    );
                  })}
                  <button onClick={() => setRtPlacementDeltas(prev => [...prev, '0'])} className="text-xs text-accent hover:underline">+ Add placement</button>
                  <div className="text-[11px] text-txt-secondary mt-1 space-y-0.5">
                    <div className="flex flex-wrap gap-x-3">
                      <span>Total positive: <span className="text-green-400 font-semibold">{rtTotalPositiveDelta}</span> pts (capped per-match at that match&apos;s actual pot)</span>
                      <span>Preview pool ({parseInt(rtMinPlayers) || 2} players): <span className="text-accent font-semibold">{rtPool.toFixed(2)}</span> pts</span>
                    </div>
                    {rtUnderfunded && (
                      <p className="text-yellow-400/80">
                        ℹ Positive placement points total {rtTotalPositiveDelta.toFixed(2)}, but Collect % of Pot only collects {rtCollectedPoints.toFixed(2)} pts at the preview pool.
                        Only matters if points are redeemed 1:1 for tokens elsewhere — this contract's daily points are a score/ledger it never pays out directly.
                        If payouts are handled separately (e.g. your own splitter logic), this is fine to ignore.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              )}

              {/* Payout Preview (Percentage mode only — Fixed Points payouts don't scale with player count) */}
              {!rtFixedPoints && (() => {
                const fee = parseFloat(rtEntryFee) || 0;
                const bpsArr = rtPlacementBps.map(toBps);
                const totalBps = bpsArr.reduce((s, b) => s + b, 0);
                const minP = parseInt(rtMinPlayers) || 2;
                const maxP = parseInt(rtMaxPlayers) || 10;
                const previewCounts = [minP];
                if (maxP !== minP) {
                  const mid = Math.round((minP + maxP) / 2);
                  if (mid !== minP && mid !== maxP) previewCounts.push(mid);
                  previewCounts.push(maxP);
                }
                return fee > 0 && bpsArr.length > 0 && totalBps > 0 ? (
                  <div className="bg-surface-secondary/60 rounded-lg p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Payout Preview</p>
                    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(previewCounts.length, 3)}, 1fr)` }}>
                      {previewCounts.map(numP => {
                        const pool = fee * numP;
                        const retained = totalBps < 10000 ? pool * (10000 - totalBps) / 10000 : 0;
                        return (
                          <div key={numP} className="space-y-1">
                            <p className="text-[11px] text-accent font-semibold">{numP} Players — Pool: {pool.toFixed(2)}</p>
                            {bpsArr.map((bps, i) => {
                              const reward = (pool * bps) / 10000;
                              const labels = ['🥇', '🥈', '🥉'];
                              return bps > 0 ? (
                                <div key={i} className="flex justify-between text-[11px]">
                                  <span className="text-txt-secondary">{labels[i] ?? `#${i + 1}`} {i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`}</span>
                                  <span className="text-green-400 font-semibold">+{reward.toFixed(4)}</span>
                                </div>
                              ) : null;
                            })}
                            {retained > 0 && (
                              <div className="flex justify-between text-[11px] border-t border-white/5 pt-1 mt-1">
                                <span className="text-txt-secondary">Retained (fee)</span>
                                <span className="text-yellow-400">{retained.toFixed(4)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null;
              })()}
              <button onClick={createRewardType} disabled={!isConnected} className={`w-full ${btnCls}`}>Create Reward Type</button>
            </div>
            {/* Update */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Update Reward Type</h5>
              {cachedRewardTypes.length > 0 && (
                <div>
                  <label className="text-xs text-txt-secondary">Load Existing Reward Type</label>
                  <div className="flex gap-2">
                    <select value={rtUpdateId} onChange={e => { if (e.target.value) selectRewardTypeForEdit(e.target.value); else { setRtUpdateId(''); setRtUpdateName(''); setRtUpdateFee(''); setRtUpdateMinPlayers(''); setRtUpdateMaxPlayers(''); setRtUpdateCollectionPct('100'); setRtUpdateActive(true); setRtUpdateFixedPoints(false); setRtUpdatePlacementBps([]); setRtUpdatePlacementDeltas(['-1', '-1', '10']); } }} className={`flex-1 ${inputCls}`}>
                      <option value="">— Select Reward Type —</option>
                      {cachedRewardTypes.map(rt => (
                        <option key={rt.id} value={String(rt.id)}>
                          #{rt.id} {rt.name} — {rt.entryFee} pts ({rt.minPlayers}-{rt.maxPlayers}P){!rt.active ? ' [INACTIVE]' : ''}
                        </option>
                      ))}
                    </select>
                    {rtUpdateId && <button onClick={() => { setRtUpdateId(''); setRtUpdateName(''); setRtUpdateFee(''); setRtUpdateMinPlayers(''); setRtUpdateMaxPlayers(''); setRtUpdateCollectionPct('100'); setRtUpdateActive(true); setRtUpdateFixedPoints(false); setRtUpdatePlacementBps([]); setRtUpdatePlacementDeltas(['-1', '-1', '10']); }} className="px-2 text-xs text-txt-secondary hover:text-red-400 transition-colors" title="Clear">✕</button>}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                <div>
                  <label className="text-xs text-txt-secondary">Type ID</label>
                  <input type="number" value={rtUpdateId} onChange={e => setRtUpdateId(e.target.value)} placeholder="1" className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Name</label>
                  <input value={rtUpdateName} onChange={e => setRtUpdateName(e.target.value)} className={inputCls.replace('font-mono', '')} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Entry Fee (points)</label>
                  <input value={rtUpdateFee} onChange={e => setRtUpdateFee(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Min / Max Players</label>
                  <div className="flex gap-1 mt-1">
                    <input type="number" value={rtUpdateMinPlayers} onChange={e => setRtUpdateMinPlayers(e.target.value)} min="2" className="w-1/2 bg-surface-secondary rounded px-2 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" placeholder="2" />
                    <input type="number" value={rtUpdateMaxPlayers} onChange={e => setRtUpdateMaxPlayers(e.target.value)} min="2" className="w-1/2 bg-surface-secondary rounded px-2 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" placeholder="10" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Active</label>
                  <select value={rtUpdateActive ? '1' : '0'} onChange={e => setRtUpdateActive(e.target.value === '1')} className={inputCls}>
                    <option value="1">Active</option>
                    <option value="0">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-txt-secondary" title="% of the full pot (entryFee × players) actually pulled from the operator on createMatch. matchValue/rewards stay based on the full pot.">Collect % of Pot</label>
                  <input type="number" value={rtUpdateCollectionPct} onChange={e => { const v = e.target.value; setRtUpdateCollectionPct(v === '' ? '' : String(Math.max(0, parseFloat(v) || 0))); }} min="0" max="100" step="0.01" placeholder="100" className={inputCls} />
                </div>
              </div>
              <div className="bg-surface rounded-lg p-2.5">
                <p className="text-[11px] text-txt-secondary mb-1.5">
                  Want negative points for a placement (e.g. a penalty rule: 1st <span className="text-red-400 font-mono">-1</span>, 2nd <span className="text-red-400 font-mono">-1</span>, 3rd <span className="text-green-400 font-mono">+10</span>)?
                  The BPS/%/Payout fields below can only go to 0 — switch to <strong>Fixed Points (±)</strong> to type exact signed points instead.
                </p>
                <div className="flex items-center gap-2 w-fit">
                  <button onClick={() => setRtUpdateFixedPoints(false)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!rtUpdateFixedPoints ? 'bg-accent text-black' : 'bg-surface-secondary text-txt-secondary hover:text-txt-primary'}`}>Percentage of Pool</button>
                  <button onClick={() => setRtUpdateFixedPoints(true)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${rtUpdateFixedPoints ? 'bg-accent text-black' : 'bg-surface-secondary text-txt-secondary hover:text-txt-primary'}`}>Fixed Points (±)</button>
                </div>
              </div>

              {!rtUpdateFixedPoints && (
              <div>
                <label className="text-xs text-txt-secondary">Placement Rewards — enter BPS, % or Payout points (all sync automatically)</label>
                <div className="space-y-1.5 mt-1">
                  <div className="flex items-center gap-2 text-[10px] text-txt-secondary font-medium">
                    <span className="w-10 shrink-0"></span>
                    <span className="flex-1 text-center">BPS (out of 10000)</span>
                    <span className="w-4 shrink-0 text-center">↔</span>
                    <span className="flex-1 text-center">Percentage (%)</span>
                    <span className="w-4 shrink-0 text-center">↔</span>
                    <span className="flex-1 text-center">Payout (points)</span>
                    <span className="w-20 shrink-0 text-center">Actual</span>
                    <span className="w-14 shrink-0"></span>
                  </div>
                  {rtUpdatePlacementBps.map((bps, i) => {
                    const bpsVal = parseInt(bps) || 0;
                    const pctFromBps = (bpsVal / 100).toFixed(2);
                    const fee = parseFloat(rtUpdateFee) || 0;
                    const minP = parseInt(rtUpdateMinPlayers) || 2;
                    const pool = fee * minP;
                    const actualPayout = pool > 0 ? ((pool * bpsVal) / 10000) : 0;
                    const actualPayoutStr = actualPayout.toFixed(4).replace(/\.?0+$/, '');
                    const labels = ['🥇', '🥈', '🥉'];
                    const pctKey = `update-pct-${i}`;
                    const payKey = `update-pay-${i}`;
                    const isPctFocused = focusedField === pctKey;
                    const isPayFocused = focusedField === payKey;
                    const displayPct = isPctFocused && localPctEdit?.key === pctKey ? localPctEdit.value : pctFromBps;
                    const displayPayout = isPayFocused && localPayoutEdit?.key === payKey ? localPayoutEdit.value : (pool > 0 ? actualPayoutStr : '');
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-[11px] text-txt-secondary w-10 shrink-0">{labels[i] ?? `#${i + 1}`}</span>
                        <input type="number" value={bps} onChange={e => { const v = e.target.value; const clamped = v === '' ? '' : String(Math.max(0, parseInt(v) || 0)); setRtUpdatePlacementBps(prev => prev.map((b, idx) => idx === i ? clamped : b)); }} placeholder="0" min="0" max="10000" className={inputCls + ' !mt-0'} />
                        <span className="text-[11px] text-txt-secondary w-4 shrink-0 text-center">↔</span>
                        <input type="number" value={displayPct}
                          onFocus={() => { setFocusedField(pctKey); setLocalPctEdit({ key: pctKey, value: pctFromBps }); }}
                          onChange={e => {
                            const val = e.target.value;
                            setLocalPctEdit({ key: pctKey, value: val });
                            const pct = Math.max(0, parseFloat(val) || 0);
                            const newBps = String(Math.round(pct * 100));
                            setRtUpdatePlacementBps(prev => prev.map((b, idx) => idx === i ? newBps : b));
                          }}
                          onBlur={() => { setFocusedField(null); setLocalPctEdit(null); }}
                          placeholder="0" min="0" max="100" step="0.01" className={inputCls + ' !mt-0'} />
                        <span className="text-[11px] text-txt-secondary w-4 shrink-0 text-center">↔</span>
                        <input type="number" value={displayPayout}
                          onFocus={() => { setFocusedField(payKey); setLocalPayoutEdit({ key: payKey, value: pool > 0 ? actualPayoutStr : '' }); }}
                          onChange={e => {
                            const val = e.target.value;
                            setLocalPayoutEdit({ key: payKey, value: val });
                            const payVal = Math.max(0, parseFloat(val) || 0);
                            if (pool > 0) {
                              const newBps = String(Math.round((payVal * 10000) / pool));
                              setRtUpdatePlacementBps(prev => prev.map((b, idx) => idx === i ? newBps : b));
                            }
                          }}
                          onBlur={() => { setFocusedField(null); setLocalPayoutEdit(null); }}
                          placeholder={pool > 0 ? '0' : 'Set fee & min'} disabled={pool <= 0} min="0" step="0.01" className={inputCls + ' !mt-0' + (pool <= 0 ? ' opacity-40' : '')} />
                        <span className={`text-[11px] w-20 shrink-0 text-right font-semibold ${actualPayout > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                          {pool > 0 ? (actualPayout > 0 ? actualPayoutStr : '0') : '—'}
                        </span>
                        {rtUpdatePlacementBps.length > 1 ? (
                          <button onClick={() => setRtUpdatePlacementBps(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 text-xs hover:underline w-14 shrink-0 text-right">Remove</button>
                        ) : <span className="w-14 shrink-0" />}
                      </div>
                    );
                  })}
                  <button onClick={() => setRtUpdatePlacementBps(prev => [...prev, '0'])} className="text-xs text-accent hover:underline">+ Add placement</button>
                  {(() => {
                    const totalBps = rtUpdatePlacementBps.reduce((s, b) => s + (parseInt(b) || 0), 0);
                    const remaining = 10000 - totalBps;
                    const fee = parseFloat(rtUpdateFee) || 0;
                    const minP = parseInt(rtUpdateMinPlayers) || 2;
                    const pool = fee * minP;
                    const totalPayout = pool > 0 ? (pool * totalBps / 10000) : 0;
                    return (
                      <div className="text-[11px] text-txt-secondary mt-1 space-y-0.5">
                        <div className="flex flex-wrap gap-x-3">
                          <span>Total: <span className={`font-semibold ${totalBps > 10000 ? 'text-red-400' : 'text-accent'}`}>{totalBps}</span> / 10000 BPS ({(totalBps / 100).toFixed(1)}%)</span>
                          {pool > 0 && <span>Total payout: <span className="text-green-400 font-semibold">{totalPayout.toFixed(4).replace(/\.?0+$/, '')}</span> / {pool} pts</span>}
                          {totalBps > 10000 && <span className="text-red-400 font-semibold">⚠ Exceeds 100%!</span>}
                          {remaining > 0 && totalBps <= 10000 && <span>Retained (operator fee): <span className="text-yellow-400 font-semibold">{remaining} BPS ({(remaining / 100).toFixed(1)}%)</span></span>}
                        </div>
                        {pool > 0 && totalBps > 0 && totalPayout !== Math.round(totalPayout * 100) / 100 && (
                          <p className="text-[10px] text-yellow-400/70">ℹ Actual payouts may differ slightly from desired values due to BPS integer rounding. The &quot;Actual&quot; column shows the on-chain payout.</p>
                        )}
                        {rtUpdateUnderfunded && (
                          <p className="text-yellow-400/80">
                            ℹ Placement rewards total {(totalBps / 100).toFixed(2)}% of the pot, but Collect % of Pot is only {(rtUpdateCollectionBps / 100).toFixed(2)}%.
                            This is only a problem if you treat daily points as tokens redeemable 1:1 — this contract never pays them out itself
                            (finalizeDailyPoints only transfers the operator&apos;s collected amount to their splitter, independent of any player&apos;s points).
                            If points are a score/leaderboard value with payouts handled separately, this is fine to ignore.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              )}

              {rtUpdateFixedPoints && (
              <div>
                <label className="text-xs text-txt-secondary">Placement Points — exact signed points per rank (negatives allowed, e.g. 1st: -1, 2nd: -1, 3rd: 10)</label>
                <div className="space-y-1.5 mt-1">
                  {rtUpdatePlacementDeltas.map((d, i) => {
                    const labels = ['🥇', '🥈', '🥉'];
                    const val = parseFloat(d) || 0;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-[11px] text-txt-secondary w-10 shrink-0">{labels[i] ?? `#${i + 1}`}</span>
                        <input value={d} onChange={e => setRtUpdatePlacementDeltas(prev => prev.map((x, idx) => idx === i ? e.target.value : x))} placeholder="0" className={`${inputCls} !mt-0 ${val < 0 ? 'text-red-400' : val > 0 ? 'text-green-400' : ''}`} />
                        <span className="text-[11px] text-txt-secondary w-12 shrink-0">points</span>
                        {rtUpdatePlacementDeltas.length > 1 ? (
                          <button onClick={() => setRtUpdatePlacementDeltas(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 text-xs hover:underline w-14 shrink-0 text-right">Remove</button>
                        ) : <span className="w-14 shrink-0" />}
                      </div>
                    );
                  })}
                  <button onClick={() => setRtUpdatePlacementDeltas(prev => [...prev, '0'])} className="text-xs text-accent hover:underline">+ Add placement</button>
                  <div className="text-[11px] text-txt-secondary mt-1 space-y-0.5">
                    <div className="flex flex-wrap gap-x-3">
                      <span>Total positive: <span className="text-green-400 font-semibold">{rtUpdateTotalPositiveDelta}</span> pts (capped per-match at that match&apos;s actual pot)</span>
                      <span>Preview pool ({parseInt(rtUpdateMinPlayers) || 2} players): <span className="text-accent font-semibold">{rtUpdatePool.toFixed(2)}</span> pts</span>
                    </div>
                    {rtUpdateUnderfunded && (
                      <p className="text-yellow-400/80">
                        ℹ Positive placement points total {rtUpdateTotalPositiveDelta.toFixed(2)}, but Collect % of Pot only collects {rtUpdateCollectedPoints.toFixed(2)} pts at the preview pool.
                        Only matters if points are redeemed 1:1 for tokens elsewhere — this contract's daily points are a score/ledger it never pays out directly.
                        If payouts are handled separately (e.g. your own splitter logic), this is fine to ignore.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              )}

              {/* Update Payout Preview (Percentage mode only) */}
              {!rtUpdateFixedPoints && (() => {
                const fee = parseFloat(rtUpdateFee) || 0;
                const bpsArr = rtUpdatePlacementBps.map(toBps);
                const totalBps = bpsArr.reduce((s, b) => s + b, 0);
                const minP = parseInt(rtUpdateMinPlayers) || 2;
                const maxP = parseInt(rtUpdateMaxPlayers) || 10;
                const previewCounts = [minP];
                if (maxP !== minP) {
                  const mid = Math.round((minP + maxP) / 2);
                  if (mid !== minP && mid !== maxP) previewCounts.push(mid);
                  previewCounts.push(maxP);
                }
                return fee > 0 && bpsArr.length > 0 && totalBps > 0 ? (
                  <div className="bg-surface-secondary/60 rounded-lg p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Payout Preview</p>
                    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(previewCounts.length, 3)}, 1fr)` }}>
                      {previewCounts.map(numP => {
                        const pool = fee * numP;
                        const retained = totalBps < 10000 ? pool * (10000 - totalBps) / 10000 : 0;
                        return (
                          <div key={numP} className="space-y-1">
                            <p className="text-[11px] text-accent font-semibold">{numP} Players — Pool: {pool.toFixed(2)}</p>
                            {bpsArr.map((bps, i) => {
                              const reward = (pool * bps) / 10000;
                              const labels = ['🥇', '🥈', '🥉'];
                              return bps > 0 ? (
                                <div key={i} className="flex justify-between text-[11px]">
                                  <span className="text-txt-secondary">{labels[i] ?? `#${i + 1}`} {i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`}</span>
                                  <span className="text-green-400 font-semibold">+{reward.toFixed(4)}</span>
                                </div>
                              ) : null;
                            })}
                            {retained > 0 && (
                              <div className="flex justify-between text-[11px] border-t border-white/5 pt-1 mt-1">
                                <span className="text-txt-secondary">Retained (fee)</span>
                                <span className="text-yellow-400">{retained.toFixed(4)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null;
              })()}
              <button onClick={updateRewardType} disabled={!isConnected} className={`w-full ${btnCls}`}>Update Reward Type</button>
            </div>
          </div>
        )}
      </Card>

      {/* Operator Reward Rules — Checklist */}
      <Card>
        <SectionHeader id="rules" label="Operator Reward Rules" icon={Settings} />
        {openSection === 'rules' && (
          <div className="space-y-3 mt-2">
            <p className="text-xs text-txt-secondary">Select an operator, then toggle which reward types they can use. Save changes in one batch transaction.</p>

            {cacheLoading && (
              <div className="flex items-center gap-2 text-xs text-txt-secondary py-2">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading operators & reward types...
              </div>
            )}

            {cacheLoaded && cachedOperators.length === 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-xs text-yellow-400">
                ⚠️ No operators found. Register operators first.
              </div>
            )}

            {/* Operator selector */}
            <div>
              <label className="text-xs text-txt-secondary">Operator</label>
              {cachedOperators.filter(o => o.active).length > 0 ? (
                <select value={ruleOperator} onChange={e => { setRuleOperator(e.target.value); if (e.target.value) loadRulesForOperator(e.target.value); else { setRuleChecklist({}); setRuleOnChain({}); } }} className={inputCls}>
                  <option value="">— Select Operator —</option>
                  {cachedOperators.filter(o => o.active).map(op => (
                    <option key={op.address} value={op.address}>
                      {op.name} ({op.address.slice(0, 6)}…{op.address.slice(-4)})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex gap-2">
                  <input value={ruleOperator} onChange={e => setRuleOperator(e.target.value)} placeholder="0x..." className={`flex-1 ${inputCls}`} />
                  <button onClick={() => { if (ruleOperator) loadRulesForOperator(ruleOperator); }} disabled={!ruleOperator || ruleLoading} className={`px-3 ${btnCls} !py-1.5 text-xs`}>Load</button>
                </div>
              )}
            </div>

            {/* Operator detail */}
            {ruleOperator && cachedOperators.length > 0 && (() => {
              const sel = cachedOperators.find(o => o.address === ruleOperator);
              return sel ? (
                <div className="bg-surface-tertiary/50 rounded-lg px-3 py-2 text-[11px] flex flex-wrap gap-x-4 gap-y-1">
                  <span className="text-txt-secondary">Operator:</span>
                  <span className="text-accent font-semibold">{sel.name}</span>
                  <span className="font-mono text-txt-secondary">{sel.address}</span>
                </div>
              ) : null;
            })()}

            {/* Loading rules */}
            {ruleLoading && (
              <div className="flex items-center gap-2 text-xs text-txt-secondary py-2">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading current rules from chain...
              </div>
            )}

            {/* Checklist */}
            {ruleOperator && !ruleLoading && cachedRewardTypes.length > 0 && (
              <div className="space-y-1">
                {/* Select all / none */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-txt-secondary font-medium">{cachedRewardTypes.length} Reward Types</span>
                  <div className="flex gap-2">
                    <button onClick={() => selectAllRules(true)} className="text-[10px] text-green-400 hover:underline">Allow All</button>
                    <button onClick={() => selectAllRules(false)} className="text-[10px] text-red-400 hover:underline">Disallow All</button>
                    <button onClick={() => loadRulesForOperator(ruleOperator)} className="text-[10px] text-accent hover:underline flex items-center gap-0.5"><RefreshCw className="w-2.5 h-2.5" />Reload</button>
                  </div>
                </div>

                {/* Summary counts */}
                {(() => {
                  const allowed = cachedRewardTypes.filter(rt => ruleChecklist[rt.id]).length;
                  const disallowed = cachedRewardTypes.length - allowed;
                  const changed = cachedRewardTypes.filter(rt => ruleChecklist[rt.id] !== ruleOnChain[rt.id]).length;
                  return (
                    <div className="flex gap-3 text-[11px] mb-2">
                      <span className="text-green-400">✓ {allowed} allowed</span>
                      <span className="text-red-400">✗ {disallowed} disallowed</span>
                      {changed > 0 && <span className="text-yellow-400">⚡ {changed} changed</span>}
                    </div>
                  );
                })()}

                {/* Reward type rows */}
                <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                  {cachedRewardTypes.map(rt => {
                    const isAllowed = !!ruleChecklist[rt.id];
                    const wasAllowed = !!ruleOnChain[rt.id];
                    const isChanged = isAllowed !== wasAllowed;
                    return (
                      <div key={rt.id}
                        onClick={() => toggleRule(rt.id)}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors select-none ${
                          isAllowed
                            ? 'bg-green-500/10 border border-green-500/30 hover:bg-green-500/20'
                            : 'bg-surface-tertiary border border-transparent hover:bg-surface-tertiary/80'
                        } ${isChanged ? 'ring-1 ring-yellow-500/50' : ''}`}
                      >
                        {/* Checkbox */}
                        <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${isAllowed ? 'bg-green-500 text-black' : 'bg-surface border border-border'}`}>
                          {isAllowed && <Check className="w-3.5 h-3.5" />}
                        </div>
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-txt-primary">#{rt.id} {rt.name}</span>
                            {!rt.active && <span className="text-[9px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">INACTIVE</span>}
                            {isChanged && <span className="text-[9px] px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">CHANGED</span>}
                          </div>
                          <div className="text-[10px] text-txt-secondary flex gap-3 mt-0.5">
                            <span>{rt.entryFee} pts</span>
                            <span>{rt.minPlayers}–{rt.maxPlayers}P</span>
                            {rt.placementBps && <span>[{rt.placementBps.slice(0, 3).join(', ')}{rt.placementBps.length > 3 ? '…' : ''}]</span>}
                          </div>
                        </div>
                        {/* Status */}
                        <span className={`text-xs font-semibold shrink-0 ${isAllowed ? 'text-green-400' : 'text-red-400'}`}>
                          {isAllowed ? '✓ Allowed' : '✗ Denied'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {ruleOperator && !ruleLoading && cachedRewardTypes.length === 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-xs text-yellow-400">
                ⚠️ No reward types found. Create reward types first.
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={saveRules} disabled={!isConnected || !ruleOperator || ruleLoading || cachedRewardTypes.every(rt => ruleChecklist[rt.id] === ruleOnChain[rt.id])} className={`flex-1 ${btnCls}`}>
                Save Rules {(() => { const c = cachedRewardTypes.filter(rt => ruleChecklist[rt.id] !== ruleOnChain[rt.id]).length; return c > 0 ? `(${c} change${c !== 1 ? 's' : ''})` : ''; })()}
              </button>
              <button onClick={() => { setCacheLoaded(false); setCachedOperators([]); setCachedRewardTypes([]); fetchFromChain(); }} disabled={cacheLoading} title="Refresh from chain" className="px-4 bg-surface-tertiary hover:bg-surface-tertiary/70 text-txt-secondary text-sm rounded-lg transition-colors">
                <RefreshCw className={`w-4 h-4 ${cacheLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Schedule, Withdraw, Pause */}
      <Card>
        <SectionHeader id="misc" label="Schedule / Withdraw / Pause" icon={Lock} />
        {openSection === 'misc' && (
          <div className="space-y-4 mt-2">
            {/* Session Duration */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Session Duration</h5>
              <p className="text-[11px] text-txt-secondary">How long each session window lasts. Sessions auto-cycle at fixed intervals from the start offset. E.g. 5 min → slots at :00, :05, :10… Current: <span className="text-accent font-semibold">{currentDuration !== null ? (currentDuration >= 3600 ? `${currentDuration / 3600}h` : `${currentDuration / 60} min`) : '—'}</span></p>
              <p className="text-[10px] text-yellow-400/70">⚠ Changing duration shifts all dateKeys — only do this before starting sessions or after redeploying.</p>
              <div className="flex gap-2">
                <input type="number" value={durationMinutes} onChange={e => setDurationMinutes(e.target.value)} min="1" max="10080" step="1" placeholder="1440" className={`flex-1 ${inputCls}`} />
                <span className="text-xs text-txt-secondary self-center">minutes</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {[{label:'5 min',v:'5'},{label:'30 min',v:'30'},{label:'1 hr',v:'60'},{label:'6 hr',v:'360'},{label:'24 hr',v:'1440'}].map(p => (
                  <button key={p.v} onClick={() => setDurationMinutes(p.v)} className="text-[10px] px-2 py-0.5 bg-surface rounded border border-border hover:border-accent text-txt-secondary hover:text-accent transition-colors">{p.label}</button>
                ))}
              </div>
              <button onClick={setSessionDuration} disabled={!isConnected} className={`w-full ${btnCls}`}>Update Duration</button>
            </div>
            {/* Per-Operator Session Duration Override */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2 border border-accent/20">
              <h5 className="text-xs font-semibold text-accent">Per-Operator Session Duration (Override)</h5>
              <p className="text-[11px] text-txt-secondary">Set a different session duration for just one operator&apos;s instance, without touching the rest of the fleet. Writes directly to that operator&apos;s instance, bypassing the hub broadcast.</p>
              <p className="text-[10px] text-yellow-400/70">⚠ Only affects that operator&apos;s next created session — one already in progress keeps its original window.</p>
              <select
                className={inputCls}
                value={opDurationOperator}
                onChange={e => selectOperatorForDuration(e.target.value)}
              >
                <option value="">— Select operator —</option>
                {cachedOperators.filter(o => o.active).map(op => (
                  <option key={op.address} value={op.address}>
                    {op.name} ({op.address.slice(0, 6)}…{op.address.slice(-4)})
                  </option>
                ))}
              </select>
              {opDurationOperator && (
                <p className="text-[11px] text-txt-secondary">
                  Current: <span className="text-accent font-semibold">
                    {opDurationLoading ? 'Loading…' : opCurrentDuration !== null ? (opCurrentDuration >= 3600 ? `${opCurrentDuration / 3600}h` : `${opCurrentDuration / 60} min`) : '—'}
                  </span>
                </p>
              )}
              <div className="flex gap-2">
                <input type="number" value={opDurationMinutes} onChange={e => setOpDurationMinutes(e.target.value)} min="1" max="10080" step="1" placeholder="1440" className={`flex-1 ${inputCls}`} />
                <span className="text-xs text-txt-secondary self-center">minutes</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {[{label:'5 min',v:'5'},{label:'30 min',v:'30'},{label:'1 hr',v:'60'},{label:'6 hr',v:'360'},{label:'24 hr',v:'1440'}].map(p => (
                  <button key={p.v} onClick={() => setOpDurationMinutes(p.v)} className="text-[10px] px-2 py-0.5 bg-surface rounded border border-border hover:border-accent text-txt-secondary hover:text-accent transition-colors">{p.label}</button>
                ))}
              </div>
              <button onClick={setOperatorSessionDuration} disabled={!isConnected || !opDurationOperator} className={`w-full ${btnCls}`}>Update Duration (this operator only)</button>
              {cachedOperators.filter(o => o.active).length === 0 && (
                <p className="text-[10px] text-txt-secondary/70">No operators loaded yet — expand &quot;Operator Reward Rules&quot; above and click Refresh.</p>
              )}
            </div>
            {/* Schedule */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Set Session Start Offset</h5>
              <p className="text-[11px] text-txt-secondary">Seconds from 00:00 UTC. 0 = midnight, 3600 = 01:00 UTC.</p>
              <div className="flex gap-2 mt-1">
                <input type="number" value={newOffset} onChange={e => setNewOffset(e.target.value)} min="0" max="86399" className="flex-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
                <input type="time" value={secondsToUtcTime(parseInt(newOffset) || 0)} onChange={e => setNewOffset(utcTimeToSeconds(e.target.value))} className="bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <p className="text-[10px] text-txt-secondary/70">Pick a UTC clock time (e.g. 18:00 = 6:00 PM UTC) or type raw seconds directly — both stay in sync.</p>
              <button onClick={setOffset} disabled={!isConnected} className={`w-full ${btnCls}`}>Update Offset</button>
            </div>
            {/* Grace Period */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Finalization Grace Period</h5>
              <p className="text-[11px] text-txt-secondary">Extra time (hours) after each session window ends for operators to settle remaining matches and for updaters to finalize. Current: <span className="text-accent font-semibold">{currentGrace !== null ? `${currentGrace / 3600}h` : '—'}</span></p>
              <div className="flex gap-2">
                <input type="number" value={graceHours} onChange={e => setGraceHours(e.target.value)} min="0" max="48" step="0.5" placeholder="2" className={`flex-1 ${inputCls}`} />
                <span className="text-xs text-txt-secondary self-center">hours</span>
              </div>
              <button onClick={setGracePeriod} disabled={!isConnected} className={`w-full ${btnCls}`}>Update Grace Period</button>
            </div>
            {/* Reward Eligibility Registry */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Reward Eligibility Registry</h5>
              <p className="text-[11px] text-txt-secondary">Wires the hub to a RewardEligibilityRegistry contract. Once set, claimDailyPrBoost on every operator instance checks it for eligibility and caps the daily boost — same registry no matter which instance a wallet claims through.</p>
              <p className="text-[11px] text-txt-secondary">Current: <span className="text-accent font-semibold font-mono">{rewardEligibilityRegistryLoading ? 'Loading…' : (rewardEligibilityRegistryOnChain && rewardEligibilityRegistryOnChain !== ethers.constants.AddressZero ? rewardEligibilityRegistryOnChain : 'Not set (unlimited)')}</span></p>
              <input value={rewardEligibilityRegistryInput} onChange={e => setRewardEligibilityRegistryInput(e.target.value)} placeholder="0x..." className={inputCls} />
              <div className="flex gap-2">
                <button onClick={setRewardEligibilityRegistryOnHub} disabled={!isConnected} className={`flex-1 ${btnCls}`}>Set Registry</button>
                <button onClick={clearRewardEligibilityRegistryOnHub} disabled={!isConnected || !rewardEligibilityRegistryOnChain || rewardEligibilityRegistryOnChain === ethers.constants.AddressZero} className={`flex-1 ${btnOutlineCls}`}>Clear (Unlimited)</button>
              </div>
            </div>
            {/* Withdraw */}
            <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h5 className="text-xs font-semibold text-accent">Withdraw Retained Points</h5>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-txt-secondary">To Address</label>
                  <input value={withdrawTo} onChange={e => setWithdrawTo(e.target.value)} placeholder="0x..." className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Amount (points)</label>
                  <input value={withdrawAmt} onChange={e => setWithdrawAmt(e.target.value)} placeholder="100" className={inputCls} />
                </div>
              </div>
              <button onClick={withdraw} disabled={!isConnected} className={`w-full ${btnCls}`}>Withdraw</button>
            </div>
            {/* Pause */}
            <div className="flex gap-2">
              <button onClick={doPause} disabled={!isConnected} className={`flex-1 ${btnOutlineCls}`}>
                <Lock className="w-3.5 h-3.5 inline mr-1" />Pause Contract
              </button>
              <button onClick={doUnpause} disabled={!isConnected} className={`flex-1 ${btnCls}`}>
                <Unlock className="w-3.5 h-3.5 inline mr-1" />Unpause Contract
              </button>
            </div>
          </div>
        )}
      </Card>

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}