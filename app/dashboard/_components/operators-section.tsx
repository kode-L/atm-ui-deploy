'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import { decodeError } from '@/lib/contracts/error-decoder';
import { getExplorerAddressUrl, networkStorageKey } from '@/lib/contracts/config';
import { Users, RefreshCw, ChevronDown, ChevronUp, CheckCircle, XCircle, AlertTriangle, Plus, Search, Calculator } from 'lucide-react';

interface OperatorInfo {
  address: string;
  active: boolean;
  name: string;
  metadataURI: string;
  registeredAt: number;
  splitterAddress: string;
  instance: string;
}

interface RewardTypeInfo {
  id: number;
  name: string;
  entryFee: string;
  active: boolean;
  minPlayers: number;
  maxPlayers: number;
  collectionBps: number;
  fixedPoints: boolean;
  placementBps: number[];
  placementDeltas: string[];
}

interface RewardRuleInfo {
  rewardTypeId: number;
  allowed: boolean;
  exists: boolean;
}

export default function OperatorsSection() {
  const { provider, sessionManagerAddress, hubAddress, address, chainId } = useWeb3();
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [rewardTypes, setRewardTypes] = useState<RewardTypeInfo[]>([]);
  const [operatorRules, setOperatorRules] = useState<Record<string, RewardRuleInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const [expandedRt, setExpandedRt] = useState<number | null>(null);
  const [lastFetched, setLastFetched] = useState<string>('');
  const [lookupAddr, setLookupAddr] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');

  // Placement Reward Calculator
  const [calcRtId, setCalcRtId] = useState('');
  const [calcPlayers, setCalcPlayers] = useState('');
  const [calcLoading, setCalcLoading] = useState(false);
  const [calcError, setCalcError] = useState('');
  const [calcResult, setCalcResult] = useState<{
    entryFee: string; matchPool: string; placements: { place: number; bps: number; reward: string }[];
    minPlayers: number; maxPlayers: number; rtName: string; fixedPoints: boolean;
  } | null>(null);

  const getContract = useCallback(() => {
    if (!provider || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider);
  }, [provider, sessionManagerAddress]);

  const getHubContract = useCallback(() => {
    if (!provider || !hubAddress) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
  }, [provider, hubAddress]);

  const getInstanceContract = useCallback((instanceAddr: string) => {
    if (!provider || !instanceAddr) return null;
    return new ethers.Contract(instanceAddr, SessionManagerArtifact.abi, provider);
  }, [provider]);

  // Fetch a single operator's profile from its own dedicated instance contract
  const fetchOperatorProfile = useCallback(async (contract: ethers.Contract, addr: string, instance?: string): Promise<OperatorInfo | null> => {
    try {
      const profile = await contract.getOperatorProfile(addr);
      const regAt = profile.registeredAt?.toNumber?.() ?? Number(profile.registeredAt);
      if (regAt === 0 && !profile.active && !profile.name) return null;
      return {
        address: addr.toLowerCase(),
        active: profile.active,
        name: profile.name,
        metadataURI: profile.metadataURI,
        registeredAt: regAt,
        splitterAddress: profile.splitterAddress || '',
        instance: instance || contract.address,
      };
    } catch {
      return null;
    }
  }, []);

  // Fetch reward rules for one operator
  const fetchRulesForOperator = useCallback(async (contract: ethers.Contract, opAddr: string, rts: RewardTypeInfo[]): Promise<RewardRuleInfo[]> => {
    const rules: RewardRuleInfo[] = [];
    for (const rt of rts) {
      try {
        const rule = await contract.getOperatorRewardRule(opAddr, rt.id);
        rules.push({
          rewardTypeId: rt.id,
          allowed: rule.allowed,
          exists: rule.exists,
        });
      } catch {
        rules.push({ rewardTypeId: rt.id, allowed: false, exists: false });
      }
    }
    return rules;
  }, []);

  const fetchAll = useCallback(async () => {
    const hub = getHubContract();
    const contract = getContract();
    if (!hub && !contract) return;
    setLoading(true);
    setError('');
    try {
      // 1. Discover ALL operators. The Hub is the source of truth — each
      // operator gets its OWN dedicated instance (BeaconProxy), so scanning
      // events off a single instance would only ever find that instance's
      // one operator, never the full fleet.
      const opInfos: OperatorInfo[] = [];
      if (hub) {
        const opAddrs: string[] = await hub.getOperators();
        for (const addr of opAddrs) {
          try {
            const rec = await hub.getOperatorRecord(addr);
            const instanceContract = getInstanceContract(rec.instance);
            if (!instanceContract) continue;
            const info = await fetchOperatorProfile(instanceContract, addr, rec.instance);
            if (info) opInfos.push(info);
          } catch { /* skip */ }
        }
      } else if (contract) {
        // Fallback for pre-Hub deployments: a single shared instance where
        // multiple operators register directly — discover via events + scan.
        const operatorAddrs = new Set<string>();
        try {
          const currentBlock = await contract.provider.getBlockNumber();
          const fromBlock = Math.max(0, currentBlock - 50000);
          const regFilter = contract.filters.SessionOperatorRegistered();
          const regEvents = await contract.queryFilter(regFilter, fromBlock, 'latest');
          for (const ev of regEvents) {
            const opAddr = (ev as any).args?.operator;
            if (opAddr && opAddr !== ethers.constants.AddressZero) {
              operatorAddrs.add(opAddr.toLowerCase());
            }
          }
        } catch (evErr) {
          console.warn('Event query failed, falling back to session scan:', evErr);
        }
        try {
          const nextId = await contract.nextSessionId();
          const totalSessions = nextId?.toNumber?.() ?? Number(nextId);
          for (let i = 1; i < totalSessions; i++) {
            try {
              const session = await contract.sessions(i);
              if (session.exists && session.operator && session.operator !== ethers.constants.AddressZero) {
                operatorAddrs.add(session.operator.toLowerCase());
              }
            } catch { /* skip */ }
          }
        } catch { /* skip session scan */ }
        if (address) operatorAddrs.add(address.toLowerCase());
        for (const addr of operatorAddrs) {
          const info = await fetchOperatorProfile(contract, addr, sessionManagerAddress || '');
          if (info) opInfos.push(info);
        }
      }

      opInfos.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setOperators(opInfos);

      // Cache operators to localStorage for cross-tab use (e.g. Admin rules)
      try {
        localStorage.setItem(networkStorageKey('dg_cached_operators', chainId), JSON.stringify(opInfos.map(o => ({
          address: o.address, name: o.name, active: o.active, splitterAddress: o.splitterAddress, metadataURI: o.metadataURI, instance: o.instance,
        }))));
      } catch { /* quota exceeded, ignore */ }

      // 3. Fetch all reward types with placement config (BPS or fixed-point deltas).
      // Prefer the Hub catalog (source of truth, mirrored to every instance).
      const rtSource = hub || contract;
      const rts: RewardTypeInfo[] = [];
      if (rtSource) {
        const nextRtId = await rtSource.nextRewardTypeId();
        const totalRt = nextRtId?.toNumber?.() ?? Number(nextRtId);
        for (let i = 1; i < totalRt; i++) {
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
              id: rt.id?.toNumber?.() ?? Number(rt.id),
              name: rt.name,
              entryFee: ethers.utils.formatEther(rt.entryFee),
              active: rt.active,
              minPlayers: rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers),
              maxPlayers: rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers),
              collectionBps: rt.collectionBps?.toNumber?.() ?? Number(rt.collectionBps),
              fixedPoints: rt.fixedPoints,
              placementBps,
              placementDeltas,
            });
          } catch { /* skip */ }
        }
      }
      setRewardTypes(rts);

      // Cache reward types to localStorage for cross-tab use (e.g. Admin, Matches tabs).
      // Must include every field the shared cache carries — this write is shared, and a
      // lossy version here would clobber richer data written by the Admin tab.
      try {
        localStorage.setItem(networkStorageKey('dg_cached_reward_types', chainId), JSON.stringify(rts.map(r => ({
          id: r.id, name: r.name, entryFee: r.entryFee, active: r.active,
          minPlayers: r.minPlayers, maxPlayers: r.maxPlayers, collectionBps: r.collectionBps,
          fixedPoints: r.fixedPoints, placementBps: r.placementBps, placementDeltas: r.placementDeltas,
        }))));
      } catch { /* quota exceeded, ignore */ }

      // 4. Fetch reward rules for each operator — against THEIR OWN instance,
      // since operatorRewardRules is stored per-instance, not on the Hub.
      const rulesMap: Record<string, RewardRuleInfo[]> = {};
      for (const op of opInfos) {
        const opInstanceContract = getInstanceContract(op.instance) || contract;
        if (!opInstanceContract) continue;
        rulesMap[op.address] = await fetchRulesForOperator(opInstanceContract, op.address, rts);
      }
      setOperatorRules(rulesMap);
      setLastFetched(new Date().toLocaleTimeString());
    } catch (e: any) {
      console.error('Fetch operators error:', e);
      setError(e?.message || 'Failed to fetch operators');
    } finally {
      setLoading(false);
    }
  }, [getContract, getHubContract, getInstanceContract, address, sessionManagerAddress, fetchOperatorProfile, fetchRulesForOperator]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Listen for refresh signals from admin-section (after rule/operator/reward type changes)
  useEffect(() => {
    const handler = () => { fetchAll(); };
    window.addEventListener('dg_operators_refresh', handler);
    return () => window.removeEventListener('dg_operators_refresh', handler);
  }, [fetchAll]);

  // Manual lookup to add an operator by address — resolves their own
  // dedicated instance via the Hub when available.
  const handleLookup = useCallback(async () => {
    if (!lookupAddr.trim()) return;

    const addr = lookupAddr.trim();
    if (!ethers.utils.isAddress(addr)) {
      setLookupError('Invalid address format');
      return;
    }

    if (operators.find(o => o.address === addr.toLowerCase())) {
      setLookupError('Operator already in list');
      return;
    }

    setLookupLoading(true);
    setLookupError('');
    try {
      const hub = getHubContract();
      let instanceContract: ethers.Contract | null = null;
      let instanceAddr = '';
      if (hub) {
        const instance = await hub.getInstance(addr);
        if (instance && instance !== ethers.constants.AddressZero) {
          instanceAddr = instance;
          instanceContract = getInstanceContract(instance);
        }
      }
      if (!instanceContract) {
        instanceContract = getContract();
        instanceAddr = sessionManagerAddress || '';
      }
      if (!instanceContract) {
        setLookupError('No SessionManager instance available for this address.');
        return;
      }

      const info = await fetchOperatorProfile(instanceContract, addr, instanceAddr);
      if (!info) {
        setLookupError('No operator profile found at this address');
        return;
      }

      const newOps = [...operators, info].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setOperators(newOps);

      const rules = await fetchRulesForOperator(instanceContract, info.address, rewardTypes);
      setOperatorRules(prev => ({ ...prev, [info.address]: rules }));
      setLookupAddr('');
    } catch (e: any) {
      setLookupError(e?.message || 'Failed to lookup operator');
    } finally {
      setLookupLoading(false);
    }
  }, [lookupAddr, getHubContract, getInstanceContract, getContract, sessionManagerAddress, operators, fetchOperatorProfile, fetchRulesForOperator, rewardTypes]);

  // Placement Reward Calculator
  const handleCalcReward = async () => {
    const contract = getContract();
    if (!contract || !calcRtId) return;
    setCalcLoading(true);
    setCalcError('');
    setCalcResult(null);
    try {
      const rtId = parseInt(calcRtId);
      const rt = await contract.getRewardType(rtId);
      const entryFeeBN = rt.entryFee;
      const entryFee = ethers.utils.formatEther(entryFeeBN);
      const minPlayers = rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers);
      const maxPlayers = rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers);
      const rtName = rt.name || `Type #${rtId}`;

      const numPlayers = calcPlayers ? parseInt(calcPlayers) : minPlayers;
      if (numPlayers < minPlayers || numPlayers > maxPlayers) {
        setCalcError(`Player count must be between ${minPlayers} and ${maxPlayers} for this reward type.`);
        setCalcLoading(false);
        return;
      }

      const matchPoolBN = entryFeeBN.mul(numPlayers);
      const matchPool = ethers.utils.formatEther(matchPoolBN);

      const placements: { place: number; bps: number; reward: string }[] = [];
      if (rt.fixedPoints) {
        const deltasRaw: any[] = await contract.getRewardTypePlacementDeltas(rtId);
        for (let i = 0; i < numPlayers; i++) {
          const reward = i < deltasRaw.length ? ethers.utils.formatEther(deltasRaw[i]) : '0';
          placements.push({ place: i + 1, bps: 0, reward });
        }
      } else {
        const bpsRaw: any[] = await contract.getRewardTypePlacementBps(rtId);
        const placementBps: number[] = bpsRaw.map((b: any) => b?.toNumber?.() ?? Number(b));
        for (let i = 0; i < numPlayers; i++) {
          const bps = i < placementBps.length ? placementBps[i] : 0;
          const rewardBN = matchPoolBN.mul(bps).div(10000);
          placements.push({ place: i + 1, bps, reward: ethers.utils.formatEther(rewardBN) });
        }
      }

      setCalcResult({ entryFee, matchPool, placements, minPlayers, maxPlayers, rtName, fixedPoints: !!rt.fixedPoints });
    } catch (e: any) {
      setCalcError(decodeError(e));
    } finally {
      setCalcLoading(false);
    }
  };

  if (!sessionManagerAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load SessionManager first.</p></Card>;
  }

  const fmtBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const fmtAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
  const fmtDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString() : '\u2014';
  const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
  const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2 rounded-lg text-sm transition-colors';

  return (
    <div className="space-y-4">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-accent" />
          <h3 className="text-lg font-semibold">Operators & Reward Types</h3>
          <span className="text-xs text-txt-secondary">({operators.length} operator{operators.length !== 1 ? 's' : ''}, {rewardTypes.length} type{rewardTypes.length !== 1 ? 's' : ''})</span>
        </div>
        <div className="flex items-center gap-3">
          {lastFetched && <span className="text-xs text-txt-secondary">Updated: {lastFetched}</span>}
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-1.5 bg-surface-tertiary hover:bg-surface-secondary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-red-300 text-xs">{error}</p>
        </div>
      )}

      {/* Reward Types — Enhanced */}
      {rewardTypes.length > 0 && (
        <Card title={`Reward Types (${rewardTypes.length})`} icon={<span className="text-accent">\ud83c\udf81</span>}>
          <p className="text-xs text-txt-secondary mb-3">Click a reward type to see placement details. Each defines how many players can join and what % each placement earns.</p>
          <div className="space-y-2">
            {rewardTypes.map(rt => {
              const isExp = expandedRt === rt.id;
              const totalBps = rt.placementBps.reduce((s, b) => s + b, 0);
              const totalPositiveDelta = rt.placementDeltas.reduce((s, d) => s + Math.max(0, parseFloat(d) || 0), 0);
              return (
                <div key={rt.id} className="bg-surface-tertiary rounded-lg overflow-hidden">
                  {/* Reward Type Header */}
                  <button onClick={() => setExpandedRt(isExp ? null : rt.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-secondary/30 transition-colors">
                    <span className="font-mono text-accent text-sm font-bold">#{rt.id}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{rt.name || '(unnamed)'}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          rt.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                        }`}>{rt.active ? 'ACTIVE' : 'INACTIVE'}</span>
                        {rt.fixedPoints && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-yellow-500/20 text-yellow-400">FIXED POINTS</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-txt-secondary flex-wrap">
                        <span>Fee: <span className="text-accent">{rt.entryFee} pts</span></span>
                        <span>Players: <span className="text-txt-primary">{rt.minPlayers}–{rt.maxPlayers}</span></span>
                        {rt.fixedPoints ? (
                          <>
                            <span>Placements: <span className="text-txt-primary">{rt.placementDeltas.length}</span></span>
                            <span>Total Positive: <span className="text-green-400">{totalPositiveDelta} pts</span></span>
                          </>
                        ) : (
                          <>
                            <span>Placements: <span className="text-txt-primary">{rt.placementBps.length}</span></span>
                            <span>Total Payout: <span className={totalBps === 10000 ? 'text-green-400' : 'text-yellow-400'}>{fmtBps(totalBps)}</span></span>
                          </>
                        )}
                      </div>
                    </div>
                    {isExp ? <ChevronUp className="w-4 h-4 text-txt-secondary shrink-0" /> : <ChevronDown className="w-4 h-4 text-txt-secondary shrink-0" />}
                  </button>

                  {/* Expanded: Placement Details */}
                  {isExp && rt.fixedPoints && (
                    <div className="px-3 pb-3 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                        {rt.placementDeltas.map((d, i) => {
                          const val = parseFloat(d) || 0;
                          return (
                            <div key={i} className={`rounded-lg p-2 text-center text-xs ${
                              val > 0 ? 'bg-green-500/10 border border-green-500/20' : val < 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-surface-secondary border border-white/5'
                            }`}>
                              <span className="text-txt-secondary">{i === 0 ? '\ud83e\udd47 1st' : i === 1 ? '\ud83e\udd48 2nd' : i === 2 ? '\ud83e\udd49 3rd' : `#${i + 1}`}</span>
                              <p className={`font-bold ${val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-txt-secondary'}`}>{val > 0 ? `+${d}` : d} pts</p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-txt-secondary">
                        Exact signed points per rank, independent of pool size. Total positive points are capped at each match's actual pot when settled.
                      </p>
                    </div>
                  )}
                  {isExp && !rt.fixedPoints && (
                    <div className="px-3 pb-3 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                        {rt.placementBps.map((bps, i) => {
                          const pool = parseFloat(rt.entryFee) * rt.minPlayers;
                          const reward = pool * bps / 10000;
                          return (
                            <div key={i} className={`rounded-lg p-2 text-center text-xs ${
                              bps > 0 ? 'bg-green-500/10 border border-green-500/20' : 'bg-surface-secondary border border-white/5'
                            }`}>
                              <span className="text-txt-secondary">{i === 0 ? '\ud83e\udd47 1st' : i === 1 ? '\ud83e\udd48 2nd' : i === 2 ? '\ud83e\udd49 3rd' : `#${i + 1}`}</span>
                              <p className={`font-bold ${bps > 0 ? 'text-green-400' : 'text-txt-secondary'}`}>{bps} bps</p>
                              <p className="text-[10px] text-txt-secondary">{fmtBps(bps)}</p>
                              {pool > 0 && bps > 0 && (
                                <p className="text-[10px] text-accent mt-0.5">~{reward.toFixed(4)} pts*</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-txt-secondary">
                        Total distributed: <span className="text-accent font-semibold">{totalBps}</span> / 10000 bps ({fmtBps(totalBps)})
                        {totalBps < 10000 && <span className="text-txt-secondary/60"> — remaining {10000 - totalBps} bps stays in contract</span>}
                      </p>
                      <p className="text-[10px] text-txt-secondary/50">*Example rewards shown for {rt.minPlayers} players (min). Use the calculator below for exact numbers.</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Placement Reward Calculator */}
      <Card title="Placement Reward Calculator" icon={<Calculator className="w-5 h-5 text-green-400" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Calculate per-placement rewards for a match based on the <strong>entry fee</strong> and <strong>placementBps[]</strong> from the Reward Type.
          Each placement (1st, 2nd, 3rd…) gets a share of the match pool.
        </p>
        <div className="bg-surface-tertiary rounded-lg p-3 mb-4 text-xs text-txt-secondary space-y-1">
          <p className="font-semibold text-txt-primary">Formula:</p>
          <p><code className="text-accent">matchPool</code> = entryFee × numPlayers</p>
          <p><code className="text-green-400">reward[i]</code> = matchPool × placementBps[i] / 10000</p>
          <p className="mt-1 text-[11px]">BPS = basis points (100 bps = 1%, 10000 bps = 100%). placementBps[0] = 1st place share, [1] = 2nd, etc.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">Reward Type ID</label>
            <input value={calcRtId} onChange={e => setCalcRtId(e.target.value)} type="number" placeholder="1"
              className={inputCls + ' mt-1'} />
          </div>
          <div>
            <label className="text-xs text-txt-secondary"># Players (blank = min)</label>
            <input value={calcPlayers} onChange={e => setCalcPlayers(e.target.value)} type="number" placeholder="min"
              className={inputCls + ' mt-1'} />
          </div>
          <div className="flex items-end">
            <button onClick={handleCalcReward} disabled={!provider || !calcRtId || calcLoading}
              className={`w-full ${btnCls} mt-1`}>
              {calcLoading ? 'Loading...' : 'Calculate'}
            </button>
          </div>
        </div>
        {calcError && <p className="text-xs text-red-400 mb-2">{calcError}</p>}
        {calcResult && (
          <div className="bg-surface-secondary rounded-lg p-4 space-y-3">
            <div className="text-xs text-txt-secondary mb-1 font-medium">Results for <span className="text-accent">{calcResult.rtName}</span></div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-[11px] text-txt-secondary">Entry Fee (per player)</p>
                <p className="text-accent font-bold">{calcResult.entryFee} pts</p>
              </div>
              <div>
                <p className="text-[11px] text-txt-secondary">Match Pool ({calcResult.placements.length} players)</p>
                <p className="text-accent font-bold">{calcResult.matchPool} pts</p>
              </div>
              <div>
                <p className="text-[11px] text-txt-secondary">Players Range</p>
                <p className="text-txt-primary font-bold">{calcResult.minPlayers}–{calcResult.maxPlayers}</p>
              </div>
            </div>
            <div className="border-t border-white/10 pt-2">
              <p className="text-[11px] text-txt-secondary mb-2 font-semibold">Per-Placement Rewards:</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {calcResult.placements.map(p => {
                  const rewardVal = parseFloat(p.reward) || 0;
                  const positive = calcResult.fixedPoints ? rewardVal > 0 : p.bps > 0;
                  const negative = calcResult.fixedPoints && rewardVal < 0;
                  return (
                  <div key={p.place} className={`rounded-lg p-2 text-center ${positive ? 'bg-green-500/10 border border-green-500/20' : negative ? 'bg-red-500/10 border border-red-500/20' : 'bg-surface-tertiary'}`}>
                    <p className="text-[11px] text-txt-secondary">
                      {p.place === 1 ? '\ud83e\udd47' : p.place === 2 ? '\ud83e\udd48' : p.place === 3 ? '\ud83e\udd49' : `#${p.place}`} {p.place === 1 ? '1st' : p.place === 2 ? '2nd' : p.place === 3 ? '3rd' : `${p.place}th`}
                    </p>
                    <p className={`font-bold text-sm ${positive ? 'text-green-400' : negative ? 'text-red-400' : 'text-txt-secondary'}`}>{calcResult.fixedPoints && positive ? '+' : ''}{p.reward} pts</p>
                    {!calcResult.fixedPoints && <p className="text-[10px] text-txt-secondary">{p.bps} bps ({(p.bps / 100).toFixed(1)}%)</p>}
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Lookup Operator by Address */}
      <Card title="Lookup Operator" icon={<Search className="w-4 h-4 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-2">All registered operators are loaded automatically from on-chain events. Use this to manually look up an operator by address if needed.</p>
        <div className="flex gap-2">
          <input
            value={lookupAddr}
            onChange={e => { setLookupAddr(e.target.value); setLookupError(''); }}
            placeholder="0x... operator address"
            className={inputCls}
            onKeyDown={e => e.key === 'Enter' && handleLookup()}
          />
          <button
            onClick={handleLookup}
            disabled={lookupLoading || !lookupAddr.trim()}
            className={`shrink-0 flex items-center gap-1.5 px-4 ${btnCls}`}
          >
            <Plus className="w-4 h-4" />
            {lookupLoading ? 'Looking up...' : 'Lookup'}
          </button>
        </div>
        {lookupError && <p className="text-red-400 text-xs mt-2">{lookupError}</p>}
      </Card>

      {/* Operators List */}
      {operators.length === 0 && !loading && (
        <Card>
          <p className="text-txt-secondary text-sm text-center py-8">No operators found. Use the Lookup above to check an operator by address, or register operators from the Admin tab.</p>
        </Card>
      )}

      {operators.map(op => {
        const isExpanded = expandedOp === op.address;
        const rules = operatorRules[op.address] || [];
        const allowedCount = rules.filter(r => r.allowed).length;

        return (
          <Card key={op.address}>
            {/* Operator Header */}
            <button
              onClick={() => setExpandedOp(isExpanded ? null : op.address)}
              className="w-full flex items-center gap-3 text-left"
            >
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${op.active ? 'bg-green-400' : 'bg-red-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{op.name || 'Unnamed'}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    op.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    {op.active ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-txt-secondary flex-wrap">
                  <span className="font-mono">{fmtAddr(op.address)}</span>
                  <span>Registered: {fmtDate(op.registeredAt)}</span>
                  <span>Reward Rules: <span className="text-accent">{allowedCount}/{rewardTypes.length}</span></span>
                </div>
              </div>
              {isExpanded ? <ChevronUp className="w-4 h-4 text-txt-secondary shrink-0" /> : <ChevronDown className="w-4 h-4 text-txt-secondary shrink-0" />}
            </button>

            {/* Expanded Details */}
            {isExpanded && (
              <div className="mt-4 space-y-3">
                {/* Full Address + Metadata */}
                <div className="bg-surface-tertiary/50 rounded-lg p-3 space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-txt-secondary w-20 shrink-0">Address:</span>
                    <code className="text-accent font-mono break-all select-all">{op.address}</code>
                    <a
                      href={getExplorerAddressUrl(chainId, op.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 underline shrink-0"
                    >\u2197</a>
                  </div>
                  {op.metadataURI && (
                    <div className="flex items-center gap-2">
                      <span className="text-txt-secondary w-20 shrink-0">Metadata:</span>
                      <span className="font-mono break-all">{op.metadataURI}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-txt-secondary w-20 shrink-0">Splitter:</span>
                    {op.splitterAddress && op.splitterAddress !== ethers.constants.AddressZero ? (
                      <>
                        <code className="text-green-400 font-mono break-all select-all">{op.splitterAddress}</code>
                        <a
                          href={getExplorerAddressUrl(chainId, op.splitterAddress)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline shrink-0"
                        >↗</a>
                      </>
                    ) : (
                      <span className="text-red-400">Not Set ⚠️</span>
                    )}
                  </div>
                </div>

                {/* Reward Rules Table */}
                {rules.length > 0 ? (
                  <div>
                    <h4 className="text-xs font-medium text-txt-secondary mb-2">Reward Rules</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-txt-secondary border-b border-surface-tertiary">
                            <th className="text-left py-1.5 px-2">Reward Type</th>
                            <th className="text-center py-1.5 px-2">Players</th>
                            <th className="text-center py-1.5 px-2">Allowed</th>
                            <th className="text-center py-1.5 px-2">Configured</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rules.map(rule => {
                            const rt = rewardTypes.find(r => r.id === rule.rewardTypeId);
                            return (
                              <tr key={rule.rewardTypeId} className={`border-b border-surface-tertiary/50 ${
                                rule.allowed ? 'bg-green-500/5' : ''
                              }`}>
                                <td className="py-1.5 px-2">
                                  <span className="font-mono text-accent">#{rule.rewardTypeId}</span>{' '}
                                  <span className="text-txt-secondary">{rt?.name || '\u2014'}</span>
                                  {rt && !rt.active && <span className="text-red-400 ml-1 text-[10px]">(inactive)</span>}
                                </td>
                                <td className="py-1.5 px-2 text-center text-txt-secondary">
                                  {rt ? `${rt.minPlayers}–${rt.maxPlayers}` : '\u2014'}
                                </td>
                                <td className="py-1.5 px-2 text-center">
                                  {rule.allowed
                                    ? <CheckCircle className="w-4 h-4 text-green-400 inline" />
                                    : <XCircle className="w-4 h-4 text-red-400/50 inline" />
                                  }
                                </td>
                                <td className="py-1.5 px-2 text-center">
                                  {rule.exists
                                    ? <span className="text-green-400 text-[10px]">Yes</span>
                                    : <span className="text-txt-secondary text-[10px]">No</span>
                                  }
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-txt-secondary">No reward types exist yet. Create reward types from the Admin tab first.</p>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {loading && operators.length === 0 && (
        <Card>
          <div className="flex items-center justify-center gap-2 py-8">
            <RefreshCw className="w-4 h-4 animate-spin text-accent" />
            <span className="text-txt-secondary text-sm">Discovering all registered operators...</span>
          </div>
        </Card>
      )}
    </div>
  );
}
