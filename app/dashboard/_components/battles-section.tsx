'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { MATCH_STATUS_LABELS, networkStorageKey } from '@/lib/contracts/config';
import { decodeError } from '@/lib/contracts/error-decoder';
import { Swords, Plus, RefreshCw, Hash, Trophy, XCircle, Trash2, AlertTriangle, Info, UserPlus, Medal, Clock, Shuffle } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import TestTokenArtifact from '@/lib/contracts/TestToken.json';

interface PlayerInfo {
  address: string;
  placement: number; // 1-based, 0 = not ranked (match unsettled)
  reward: string;
}

interface MatchData {
  id: number;
  sessionId: number;
  rewardTypeId: number;
  matchRef: string;
  playerCount: number;
  entryFee: string;
  matchValue: string;
  winner: string;
  status: number;
  settled: boolean;
  players: string[];
  rankings: string[];
  playerInfos: PlayerInfo[];
  dateKey: number;
}

export default function MatchesSection() {
  const { signer, provider, isConnected, address, sessionManagerAddress, tokenAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });

  // View matches
  const [viewSessionId, setViewSessionId] = useState('');
  const [matches, setMatches] = useState<MatchData[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);

  // Create match
  const [createRewardTypeId, setCreateRewardTypeId] = useState('');
  const [createMatchRef, setCreateMatchRef] = useState('');
  const [playerAddresses, setPlayerAddresses] = useState<string[]>(['', '']);
  const [dayFinalized, setDayFinalized] = useState(false);
  const [dayFinalizedKey, setDayFinalizedKey] = useState<number | null>(null);
  const [matchRefTouched, setMatchRefTouched] = useState(false);

  // Day timing info
  interface DayTiming { gameWindowStart: number; gameWindowEnd: number; finalizationDeadline: number; isGameWindowOpen: boolean; isGracePeriodOpen: boolean; isFinalized: boolean; }
  const [dayTiming, setDayTiming] = useState<DayTiming | null>(null);
  const [countdown, setCountdown] = useState('');

  // Operator's allowed reward types for Create Match dropdown
  interface AllowedRewardType { id: number; name: string; entryFee: string; minPlayers: number; maxPlayers: number; fixedPoints: boolean; placementBps: number[]; placementDeltas: string[]; }
  const [allowedRewardTypes, setAllowedRewardTypes] = useState<AllowedRewardType[]>([]);
  const [loadingAllowed, setLoadingAllowed] = useState(false);

  // Settle — ranked placements
  const [settleMatchId, setSettleMatchId] = useState('');
  const [settleRanked, setSettleRanked] = useState<string[]>(['']);
  // Batch settle
  const [batchSettleRows, setBatchSettleRows] = useState<{ matchId: string; ranked: string[] }[]>([]);
  const [settleMode, setSettleMode] = useState<'single' | 'batch'>('single');

  // Unsettled matches from current session
  interface UnsettledMatch {
    id: number;
    sessionId: number;
    rewardTypeId: number;
    matchRef: string;
    playerCount: number;
    entryFee: string;
    matchValue: string;
    players: string[];
    rewardTypeName: string;
    fixedPoints: boolean; // reward type mode: Fixed Points (±) vs Percentage of Pool
    winSlots: number; // how many placements pay out (percentage mode)
    placementBps: number[]; // BPS for each placement position (percentage mode)
    placementDeltas: string[]; // formatted signed points per placement (fixed points mode)
  }
  const [unsettledMatches, setUnsettledMatches] = useState<UnsettledMatch[]>([]);
  const [loadingUnsettled, setLoadingUnsettled] = useState(false);

  // Current session ID (needed for settle/cancel calls)
  const [currentSessionId, setCurrentSessionId] = useState<number>(0);

  // Cancel
  const [cancelMatchId, setCancelMatchId] = useState('');

  // Quick Test — generate N matches with random player addresses (for the currently
  // selected reward type, chosen independently below from the same allowed list),
  // then batch-settle them all with randomly shuffled rankings in a single
  // transaction. Lets an operator load-test the full create → settle →
  // points-credit pipeline without hand-typing addresses.
  const [quickTestRewardTypeId, setQuickTestRewardTypeId] = useState('');
  const [quickTestCount, setQuickTestCount] = useState('5');
  const [quickTestRunning, setQuickTestRunning] = useState(false);
  const [quickTestProgress, setQuickTestProgress] = useState('');
  const [quickTestMatches, setQuickTestMatches] = useState<{ matchId: number; players: string[] }[]>([]);
  const [quickTestSettling, setQuickTestSettling] = useState(false);
  const [quickTestResults, setQuickTestResults] = useState<{ matchId: number; winner: string; ranked: string[] }[]>([]);
  // Persistent pool of test player addresses, reused across Quick Test runs (and
  // grown with fresh random addresses only when a run needs more than the pool has)
  // so repeat players build up points history instead of every run using
  // addresses that never appear again.
  const [testPlayerPool, setTestPlayerPool] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('dg_quicktest_player_pool');
      if (raw) setTestPlayerPool(JSON.parse(raw));
    } catch {}
  }, []);

  const persistPlayerPool = (pool: string[]) => {
    setTestPlayerPool(pool);
    try { localStorage.setItem('dg_quicktest_player_pool', JSON.stringify(pool)); } catch {}
  };

  const resetPlayerPool = () => persistPlayerPool([]);

  const getReadContract = useCallback(() => {
    if (!provider || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider ?? undefined);
  }, [provider, sessionManagerAddress]);

  const getWriteContract = useCallback(() => {
    if (!signer || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, signer);
  }, [signer, sessionManagerAddress]);

  // Load operator's allowed reward types (cache-first, then check on-chain rules)
  useEffect(() => {
    const load = async () => {
      const c = getReadContract();
      if (!c || !address) { setAllowedRewardTypes([]); return; }
      setLoadingAllowed(true);
      try {
        // Step 1: Load cached reward types from localStorage
        let rewardTypes: { id: number; name: string; entryFee: string; minPlayers: number; maxPlayers: number; active: boolean; fixedPoints?: boolean; placementBps?: number[]; placementDeltas?: string[] }[] = [];
        try {
          const raw = localStorage.getItem(networkStorageKey('dg_cached_reward_types', chainId));
          if (raw) rewardTypes = JSON.parse(raw);
        } catch {}

        // Step 2: If cache empty, fetch from chain
        if (rewardTypes.length === 0) {
          try {
            const nextIdBN = await c.nextRewardTypeId();
            const nextId = nextIdBN?.toNumber?.() ?? Number(nextIdBN);
            for (let i = 1; i < nextId; i++) {
              try {
                const rt = await c.getRewardType(i);
                let placementBps: number[] = [];
                let placementDeltas: string[] = [];
                if (rt.fixedPoints) {
                  const deltas = await c.getRewardTypePlacementDeltas(i);
                  placementDeltas = deltas.map((d: any) => ethers.utils.formatEther(d));
                } else {
                  const bps = await c.getRewardTypePlacementBps(i);
                  placementBps = bps.map((x: any) => x?.toNumber?.() ?? Number(x));
                }
                rewardTypes.push({
                  id: i,
                  name: rt.name,
                  entryFee: ethers.utils.formatEther(rt.entryFee),
                  minPlayers: rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers),
                  maxPlayers: rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers),
                  active: rt.active,
                  fixedPoints: rt.fixedPoints,
                  placementBps,
                  placementDeltas,
                });
              } catch { break; }
            }
          } catch {}
        }

        // Step 3: Filter to active + check operator reward rules
        const activeRts = rewardTypes.filter(r => r.active);
        const allowed: AllowedRewardType[] = [];
        for (const rt of activeRts) {
          try {
            const rule = await c.getOperatorRewardRule(address, rt.id);
            if (rule.allowed) {
              allowed.push({
                id: rt.id, name: rt.name, entryFee: rt.entryFee, minPlayers: rt.minPlayers, maxPlayers: rt.maxPlayers,
                fixedPoints: !!rt.fixedPoints, placementBps: rt.placementBps ?? [], placementDeltas: rt.placementDeltas ?? [],
              });
            }
          } catch {}
        }
        setAllowedRewardTypes(allowed);
        // Auto-select first if nothing selected & adjust player slots
        if (allowed.length > 0 && !createRewardTypeId) {
          const first = allowed[0];
          setCreateRewardTypeId(String(first.id));
          setPlayerAddresses(prev => {
            let arr = [...prev];
            if (arr.length > first.maxPlayers) arr = arr.slice(0, first.maxPlayers);
            if (arr.length < first.minPlayers) arr = [...arr, ...Array(first.minPlayers - arr.length).fill('')];
            return arr;
          });
        }
        // Quick Test picks its own reward type independently from the same allowed
        // list, defaulting to the first one too.
        if (allowed.length > 0 && !quickTestRewardTypeId) {
          setQuickTestRewardTypeId(String(allowed[0].id));
        }
      } catch {
        setAllowedRewardTypes([]);
      } finally {
        setLoadingAllowed(false);
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getReadContract, address]);

  // Check if current day is finalized + fetch timing info
  useEffect(() => {
    const check = async () => {
      const c = getReadContract();
      if (!c || !signer || !sessionManagerAddress) { setDayFinalized(false); setDayFinalizedKey(null); setDayTiming(null); return; }
      try {
        const signerContract = new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, signer);
        const sessionIdBN = await signerContract.getMyCurrentSessionId();
        const sid = sessionIdBN?.toNumber?.() ?? Number(sessionIdBN);
        if (!sid) { setDayFinalized(false); setDayFinalizedKey(null); setDayTiming(null); return; }
        const dateKeyBN = await c.getSessionDateKey(sid);
        const dk = dateKeyBN?.toNumber?.() ?? Number(dateKeyBN);
        setDayFinalizedKey(dk);

        // Fetch timing info
        try {
          const info = await c.getDayTimingInfo(dk);
          const timing: DayTiming = {
            gameWindowStart: (info.gameWindowStart?.toNumber?.() ?? Number(info.gameWindowStart)),
            gameWindowEnd: (info.gameWindowEnd?.toNumber?.() ?? Number(info.gameWindowEnd)),
            finalizationDeadline: (info.finalizationDeadline?.toNumber?.() ?? Number(info.finalizationDeadline)),
            isGameWindowOpen: info.isGameWindowOpen,
            isGracePeriodOpen: info.isGracePeriodOpen,
            isFinalized: info.isFinalized,
          };
          setDayTiming(timing);
          setDayFinalized(timing.isFinalized);
        } catch {
          const fin = await c.dailyPointsFinalized(dk);
          setDayFinalized(!!fin);
          setDayTiming(null);
        }
      } catch { setDayFinalized(false); setDayFinalizedKey(null); setDayTiming(null); }
    };
    check();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getReadContract, signer, sessionManagerAddress]);

  // Format seconds as HH:MM:SS
  const fmtTimer = (diff: number) => {
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  // Countdown timer
  useEffect(() => {
    if (!dayTiming) { setCountdown(''); return; }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      if (dayTiming.isFinalized) {
        setCountdown('');
        return;
      }
      if (now < dayTiming.gameWindowEnd) {
        setCountdown(`Game window ends in ${fmtTimer(dayTiming.gameWindowEnd - now)}`);
      } else if (now <= dayTiming.finalizationDeadline) {
        setCountdown(`Grace period ends in ${fmtTimer(dayTiming.finalizationDeadline - now)} — settle now!`);
      } else {
        setCountdown('Grace period expired');
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [dayTiming]);

  // Load unsettled matches from operator's current session (cache-first for reward type names/placement BPS)
  const loadUnsettledMatches = useCallback(async () => {
    const c = getReadContract();
    if (!c || !signer) { setUnsettledMatches([]); return; }
    setLoadingUnsettled(true);
    try {
      // Get current session ID via signer (msg.sender call)
      const signerContract = new ethers.Contract(sessionManagerAddress!, SessionManagerArtifact.abi, signer);
      const sessionIdBN = await signerContract.getMyCurrentSessionId();
      const sessionId = sessionIdBN?.toNumber?.() ?? Number(sessionIdBN);
      if (!sessionId) { setUnsettledMatches([]); setCurrentSessionId(0); setLoadingUnsettled(false); return; }
      setCurrentSessionId(sessionId);

      const matchIds: number[] = (await c.getMatchIds(sessionId)).map((x: any) => x?.toNumber?.() ?? Number(x));
      if (matchIds.length === 0) { setUnsettledMatches([]); setLoadingUnsettled(false); return; }

      // Build reward type cache from localStorage
      const rtCache: Record<number, { name: string; fixedPoints: boolean; placementBps: number[]; placementDeltas: string[] }> = {};
      try {
        const raw = localStorage.getItem(networkStorageKey('dg_cached_reward_types', chainId));
        if (raw) {
          const parsed = JSON.parse(raw);
          for (const rt of parsed) {
            if (rt.id && rt.name) {
              rtCache[rt.id] = { name: rt.name, fixedPoints: !!rt.fixedPoints, placementBps: rt.placementBps ?? [], placementDeltas: rt.placementDeltas ?? [] };
            }
          }
        }
      } catch {}

      const items: UnsettledMatch[] = [];
      for (const mid of matchIds) {
        try {
          const m: any = await c.getMatch(sessionId, mid);
          const status = m.status ?? 0;
          if (status !== 0) continue; // only CREATED (unsettled)
          const players: string[] = await c.getMatchPlayers(sessionId, mid);
          const rtId = m.rewardTypeId?.toNumber?.() ?? Number(m.rewardTypeId);

          // Get reward type info from cache or chain
          if (!rtCache[rtId]) {
            try {
              const rt = await c.getRewardType(rtId);
              if (rt.fixedPoints) {
                const deltas = await c.getRewardTypePlacementDeltas(rtId);
                rtCache[rtId] = {
                  name: rt.name ?? `Type #${rtId}`, fixedPoints: true,
                  placementBps: [], placementDeltas: deltas.map((d: any) => ethers.utils.formatEther(d)),
                };
              } else {
                const bps = await c.getRewardTypePlacementBps(rtId);
                rtCache[rtId] = {
                  name: rt.name ?? `Type #${rtId}`, fixedPoints: false,
                  placementBps: bps.map((x: any) => x?.toNumber?.() ?? Number(x)), placementDeltas: [],
                };
              }
            } catch {
              rtCache[rtId] = { name: `Type #${rtId}`, fixedPoints: false, placementBps: [], placementDeltas: [] };
            }
          }

          const bpsArr = rtCache[rtId]?.placementBps ?? [];
          const deltasArr = rtCache[rtId]?.placementDeltas ?? [];
          const fixedPoints = !!rtCache[rtId]?.fixedPoints;
          const winSlots = fixedPoints ? deltasArr.filter(d => parseFloat(d) > 0).length : bpsArr.filter(b => b > 0).length;

          items.push({
            id: m.id?.toNumber?.() ?? mid,
            sessionId,
            rewardTypeId: rtId,
            matchRef: m.matchRef ?? '',
            playerCount: m.playerCount?.toNumber?.() ?? 0,
            entryFee: ethers.utils.formatEther(m.entryFee ?? 0),
            matchValue: ethers.utils.formatEther(m.matchValue ?? 0),
            players,
            rewardTypeName: rtCache[rtId]?.name ?? `Type #${rtId}`,
            fixedPoints,
            winSlots,
            placementBps: bpsArr,
            placementDeltas: deltasArr,
          });
        } catch { /* skip */ }
      }
      setUnsettledMatches(items);
    } catch {
      setUnsettledMatches([]);
    } finally {
      setLoadingUnsettled(false);
    }
  }, [getReadContract, signer, sessionManagerAddress]);

  useEffect(() => { loadUnsettledMatches(); }, [loadUnsettledMatches]);

  const exec = async (label: string, fn: () => Promise<any>, onSuccess?: () => void) => {
    setTxStatus({ status: 'pending', message: `${label}...` });
    try {
      const tx = await fn();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${label} ✔` });
      if (onSuccess) onSuccess();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Fetch matches for a session ──
  const fetchMatches = useCallback(async () => {
    const contract = getReadContract();
    const sid = parseInt(viewSessionId);
    if (!contract || isNaN(sid)) return;
    setLoadingMatches(true);
    try {
      let sessionDateKey = 0;
      try {
        const dk = await contract.getSessionDateKey(sid);
        sessionDateKey = dk?.toNumber?.() ?? Number(dk);
      } catch { /* skip */ }

      const matchIds: number[] = (await contract.getMatchIds(sid)).map((x: any) => x?.toNumber?.() ?? Number(x));
      const items: MatchData[] = [];
      for (const mid of matchIds) {
        try {
          const m = await contract.getMatch(sid, mid);
          const players: string[] = await contract.getMatchPlayers(sid, mid);
          let rankings: string[] = [];
          try {
            rankings = await contract.getMatchRankings(sid, mid);
          } catch { /* not settled yet */ }
          // players collected per-match
          items.push({
            id: m.id?.toNumber?.() ?? mid,
            sessionId: sid,
            rewardTypeId: m.rewardTypeId?.toNumber?.() ?? 0,
            matchRef: m.matchRef ?? '',
            playerCount: m.playerCount?.toNumber?.() ?? 0,
            entryFee: ethers.utils.formatEther(m.entryFee ?? 0),
            matchValue: ethers.utils.formatEther(m.matchValue ?? 0),
            winner: m.winner ?? ethers.constants.AddressZero,
            status: m.status ?? 0,
            settled: m.settled ?? false,
            players,
            rankings,
            playerInfos: [],
            dateKey: sessionDateKey,
          });
        } catch { /* skip */ }
      }

      // Fetch placement config (BPS or fixed-point deltas) for reward calculation display
      const rtModeCache: Record<number, { fixedPoints: boolean; placementBps: number[]; placementDeltas: string[] }> = {};
      for (const match of items) {
        if (!rtModeCache[match.rewardTypeId]) {
          try {
            const rt = await contract.getRewardType(match.rewardTypeId);
            if (rt.fixedPoints) {
              const deltas = await contract.getRewardTypePlacementDeltas(match.rewardTypeId);
              rtModeCache[match.rewardTypeId] = { fixedPoints: true, placementBps: [], placementDeltas: deltas.map((d: any) => ethers.utils.formatEther(d)) };
            } else {
              const bps = await contract.getRewardTypePlacementBps(match.rewardTypeId);
              rtModeCache[match.rewardTypeId] = { fixedPoints: false, placementBps: bps.map((x: any) => x?.toNumber?.() ?? Number(x)), placementDeltas: [] };
            }
          } catch { rtModeCache[match.rewardTypeId] = { fixedPoints: false, placementBps: [], placementDeltas: [] }; }
        }
      }

      // Attach player info with placement & reward
      for (const match of items) {
        const rankMap: Record<string, number> = {};
        match.rankings.forEach((addr, idx) => { rankMap[addr.toLowerCase()] = idx + 1; });
        const rtMode = rtModeCache[match.rewardTypeId] ?? { fixedPoints: false, placementBps: [], placementDeltas: [] };

        match.playerInfos = match.players.map(p => {
          const pLower = p.toLowerCase();
          const placement = rankMap[pLower] ?? 0;
          let reward = '0';
          if (placement > 0) {
            if (rtMode.fixedPoints) {
              if (placement - 1 < rtMode.placementDeltas.length) reward = rtMode.placementDeltas[placement - 1];
            } else if (placement - 1 < rtMode.placementBps.length) {
              reward = (parseFloat(match.matchValue) * rtMode.placementBps[placement - 1] / 10000).toFixed(6);
            }
          }
          return { address: p, placement, reward };
        });

        // Sort by placement (placed first, then unplaced)
        match.playerInfos.sort((a, b) => {
          if (a.placement === 0 && b.placement === 0) return 0;
          if (a.placement === 0) return 1;
          if (b.placement === 0) return -1;
          return a.placement - b.placement;
        });
      }

      setMatches(items);
    } catch (e: any) {
      console.error('Fetch matches error:', e);
      setMatches([]);
    } finally {
      setLoadingMatches(false);
    }
  }, [getReadContract, viewSessionId]);

  // ── Create Match ──
  const handleCreateMatch = async () => {
    const contract = getWriteContract();
    if (!contract || !tokenAddress || !signer) return;

    const rewardTypeId = parseInt(createRewardTypeId);
    const validPlayers = playerAddresses.filter(p => p.trim());
    if (isNaN(rewardTypeId) || !createMatchRef || validPlayers.length < 2) {
      setTxStatus({ status: 'error', error: 'Fill in all fields: Reward Type ID, Match Ref, and at least 2 player addresses.' });
      return;
    }

    // Validate addresses: must be valid Ethereum addresses and non-zero
    for (let i = 0; i < validPlayers.length; i++) {
      if (!ethers.utils.isAddress(validPlayers[i])) {
        setTxStatus({ status: 'error', error: `Player P${i + 1} ("${validPlayers[i]}") is not a valid Ethereum address.` });
        return;
      }
      if (validPlayers[i] === ethers.constants.AddressZero) {
        setTxStatus({ status: 'error', error: `Player P${i + 1} cannot be the zero address (0x000...0).` });
        return;
      }
    }

    // Check for duplicate addresses (case-insensitive)
    const lowerPlayers = validPlayers.map(p => p.toLowerCase());
    const seen = new Set<string>();
    for (let i = 0; i < lowerPlayers.length; i++) {
      if (seen.has(lowerPlayers[i])) {
        const dupIdx = lowerPlayers.indexOf(lowerPlayers[i]);
        setTxStatus({ status: 'error', error: `Duplicate address detected: P${dupIdx + 1} and P${i + 1} are the same address (${validPlayers[i].slice(0, 6)}…${validPlayers[i].slice(-4)}). Each player must be unique.` });
        return;
      }
      seen.add(lowerPlayers[i]);
    }

    // Inline field-level validation
    setMatchRefTouched(true);
    if (dayFinalized || !createMatchRef.trim()) return;
    if (dayTiming && !dayTiming.isGameWindowOpen) {
      setTxStatus({ status: 'error', error: `Game window has ended for day ${dayFinalizedKey}. Matches can only be created while the game window is open. Check session duration in Admin tab.` });
      return;
    }

    setTxStatus({ status: 'pending', message: 'Running pre-flight checks...' });
    try {
      const readC = getReadContract()!;

      let entryFee: any;
      let collectionBps: any;
      try {
        const rt = await readC.getRewardType(rewardTypeId);
        if (!rt.exists) {
          setTxStatus({ status: 'error', error: `Reward type ${rewardTypeId} does not exist.` });
          return;
        }
        if (!rt.active) {
          setTxStatus({ status: 'error', error: `Reward type ${rewardTypeId} is inactive.` });
          return;
        }
        const minP = rt.minPlayers?.toNumber?.() ?? Number(rt.minPlayers);
        const maxP = rt.maxPlayers?.toNumber?.() ?? Number(rt.maxPlayers);
        if (validPlayers.length < minP || validPlayers.length > maxP) {
          setTxStatus({ status: 'error', error: `Player count ${validPlayers.length} is out of range [${minP}, ${maxP}] for this reward type.` });
          return;
        }
        entryFee = rt.entryFee;
        collectionBps = rt.collectionBps;
      } catch {
        setTxStatus({ status: 'error', error: `Reward type ${rewardTypeId} not found.` });
        return;
      }

      const matchPool = entryFee.mul(validPlayers.length);
      const totalCost = matchPool.mul(collectionBps).div(10000);
      setTxStatus({ status: 'pending', message: `Pool: ${ethers.utils.formatEther(matchPool)} pts (${ethers.utils.formatEther(entryFee)} × ${validPlayers.length}) — collecting ${ethers.utils.formatEther(totalCost)} pts from you` });

      const tokenContract = new ethers.Contract(tokenAddress, TestTokenArtifact.abi, signer);
      const balance = await tokenContract.balanceOf(address);
      if (balance.lt(totalCost)) {
        setTxStatus({ status: 'error', error: `Insufficient balance. Need ${ethers.utils.formatEther(totalCost)} but have ${ethers.utils.formatEther(balance)}.` });
        return;
      }

      const allowance = await tokenContract.allowance(address, sessionManagerAddress);
      if (allowance.lt(totalCost)) {
        setTxStatus({ status: 'pending', message: `Approving ${ethers.utils.formatEther(totalCost)} pts...` });
        const approveTx = await tokenContract.approve(sessionManagerAddress, totalCost);
        setTxStatus({ status: 'pending', hash: approveTx.hash, message: 'Waiting for approval...' });
        await approveTx.wait();
        setTxStatus({ status: 'pending', message: 'Approved! Creating match...' });
      }

      setTxStatus({ status: 'pending', message: 'Creating match — confirm in MetaMask...' });
      const tx = await contract.createMatch(rewardTypeId, createMatchRef, validPlayers);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Match tx sent...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Match created with ${validPlayers.length} players!` });
      // Auto-refresh unsettled matches after creating a new match
      setCreateMatchRef('');
      setMatchRefTouched(false);
      loadUnsettledMatches();
    } catch (e: any) {
      const decoded = decodeError(e);
      let hint = '';
      if (decoded.includes('InvalidSessionStatus')) {
        hint = '\n\nHint: Make sure you have an ACTIVE session for today.';
      } else if (decoded.includes('PlayerCountOutOfRange')) {
        hint = '\n\nHint: Player count is outside the reward type\'s minPlayers/maxPlayers range.';
      } else if (decoded.includes('RewardTypeNotAllowed')) {
        hint = '\n\nHint: Operator reward rules must be set for this reward type.';
      } else if (decoded.includes('GameWindowStillOpen')) {
        hint = '\n\nHint: The game window is still open — wait for it to end.';
      } else if (decoded.includes('GracePeriodExpired')) {
        hint = '\n\nHint: The grace period has expired — settling is no longer possible.';
      }
      setTxStatus({ status: 'error', error: decoded + hint });
    }
  };

  // ── Quick Test (load test) ──
  const shuffleArray = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const handleQuickTest = async () => {
    const contract = getWriteContract();
    const readC = getReadContract();
    if (!contract || !readC || !tokenAddress || !signer || !address) return;

    const count = Math.max(1, Math.min(20, parseInt(quickTestCount) || 5));
    const rewardTypeId = parseInt(quickTestRewardTypeId);
    const selectedRtForTest = allowedRewardTypes.find(r => r.id === rewardTypeId);
    if (!selectedRtForTest) {
      setTxStatus({ status: 'error', error: 'Select a Reward Type for Quick Test first.' });
      return;
    }
    if (dayFinalized) {
      setTxStatus({ status: 'error', error: 'Today is already finalized — cannot create more matches.' });
      return;
    }
    if (dayTiming && !dayTiming.isGameWindowOpen) {
      setTxStatus({ status: 'error', error: 'Game window has ended for today — cannot create more matches.' });
      return;
    }

    setQuickTestRunning(true);
    setQuickTestMatches([]);
    setQuickTestResults([]);
    try {
      const playersPerMatch = selectedRtForTest.minPlayers;

      // Grow the pool only enough to cover the shortfall, keeping every existing
      // entry — so old test players resurface across runs (their points history
      // builds up) instead of every match using addresses that never appear again.
      const targetPoolSize = Math.max(testPlayerPool.length, playersPerMatch * 3, 10);
      const pool = [...testPlayerPool];
      const addedThisRun: string[] = [];
      while (pool.length < targetPoolSize) {
        const addr = ethers.Wallet.createRandom().address;
        pool.push(addr);
        addedThisRun.push(addr);
      }
      if (addedThisRun.length > 0) persistPlayerPool(pool);

      const entryFeeBN = ethers.utils.parseEther(selectedRtForTest.entryFee);
      // Upper-bound cost assuming 100% collectionBps — approving this once up front
      // means the create loop below needs no further approvals.
      const totalNeeded = entryFeeBN.mul(playersPerMatch).mul(count);

      const tokenContract = new ethers.Contract(tokenAddress, TestTokenArtifact.abi, signer);
      const balance = await tokenContract.balanceOf(address);
      if (balance.lt(totalNeeded)) {
        setTxStatus({ status: 'error', error: `Insufficient balance for ${count} test matches. Need up to ${ethers.utils.formatEther(totalNeeded)} pts, have ${ethers.utils.formatEther(balance)}.` });
        return;
      }
      const allowance = await tokenContract.allowance(address, sessionManagerAddress);
      if (allowance.lt(totalNeeded)) {
        setQuickTestProgress('Approving points for the whole batch — confirm in MetaMask...');
        const approveTx = await tokenContract.approve(sessionManagerAddress, totalNeeded);
        await approveTx.wait();
      }

      const created: { matchId: number; players: string[] }[] = [];
      for (let i = 0; i < count; i++) {
        setQuickTestProgress(`Creating test match ${i + 1}/${count} — confirm in MetaMask...`);
        // Draw players from the pool each time (a fresh shuffle per match) — the
        // same player can land in different matches across a run, and will keep
        // resurfacing across future runs since the pool persists.
        const players = shuffleArray(pool).slice(0, playersPerMatch);
        const matchRef = `quicktest-${Date.now()}-${i + 1}`;
        const tx = await contract.createMatch(rewardTypeId, matchRef, players);
        setQuickTestProgress(`Test match ${i + 1}/${count}: waiting for confirmation...`);
        const receipt = await tx.wait();
        const ev = receipt.events?.find((e: any) => e.event === 'MatchCreated');
        const matchId = ev?.args?.matchId?.toNumber?.() ?? Number(ev?.args?.matchId);
        created.push({ matchId, players });
        setQuickTestMatches([...created]);
      }
      const reusedCount = pool.length - addedThisRun.length;
      setTxStatus({ status: 'success', message: `Created ${created.length} test matches (${playersPerMatch} players each) — drew from a pool of ${pool.length} test players (${reusedCount} reused from before, ${addedThisRun.length} new). Now batch settle with random winners below.` });
      loadUnsettledMatches();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setQuickTestRunning(false);
      setQuickTestProgress('');
    }
  };

  const handleQuickTestBatchSettle = async () => {
    const contract = getWriteContract();
    if (!contract || quickTestMatches.length === 0) return;
    if (!currentSessionId) {
      setTxStatus({ status: 'error', error: 'No current session found — reload the page or refresh unsettled matches.' });
      return;
    }
    setQuickTestSettling(true);
    try {
      const matchIds = quickTestMatches.map(m => m.matchId);
      const rankedArrays = quickTestMatches.map(m => shuffleArray(m.players));
      setTxStatus({ status: 'pending', message: `Batch settling ${matchIds.length} test matches with random winners — confirm in MetaMask...` });
      const tx = await contract.batchSettleMatches(currentSessionId, matchIds, rankedArrays);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Batch settled ${matchIds.length} test matches with random winners!` });
      setQuickTestResults(quickTestMatches.map((m, i) => ({ matchId: m.matchId, winner: rankedArrays[i][0], ranked: rankedArrays[i] })));
      setQuickTestMatches([]);
      loadUnsettledMatches();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setQuickTestSettling(false);
    }
  };

  // ── Settle (single) ──
  const handleSettleSingle = async () => {
    const contract = getWriteContract();
    if (!contract) return;
    const mid = parseInt(settleMatchId);
    const validRanked = settleRanked.filter(r => r.trim());
    if (isNaN(mid) || validRanked.length < 2) {
      setTxStatus({ status: 'error', error: 'Enter match ID and at least 2 ranked players (all match players must be listed).' });
      return;
    }
    // Validate addresses
    for (let i = 0; i < validRanked.length; i++) {
      if (!ethers.utils.isAddress(validRanked[i])) {
        setTxStatus({ status: 'error', error: `Ranked position #${i + 1} ("${validRanked[i]}") is not a valid Ethereum address.` });
        return;
      }
      if (validRanked[i] === ethers.constants.AddressZero) {
        setTxStatus({ status: 'error', error: `Ranked position #${i + 1} cannot be the zero address.` });
        return;
      }
    }
    // Check for duplicates
    const lowerRanked = validRanked.map(r => r.toLowerCase());
    const seen = new Set<string>();
    for (let i = 0; i < lowerRanked.length; i++) {
      if (seen.has(lowerRanked[i])) {
        const dupIdx = lowerRanked.indexOf(lowerRanked[i]);
        setTxStatus({ status: 'error', error: `Duplicate in ranked list: position #${dupIdx + 1} and #${i + 1} are the same address. Each player must appear exactly once.` });
        return;
      }
      seen.add(lowerRanked[i]);
    }
    if (!currentSessionId) { setTxStatus({ status: 'error', error: 'No current session found. Create a session first.' }); return; }

    // The reward type assigned at createMatch determines payout mode automatically —
    // Percentage of Pool or Fixed Points (±) — settleMatch needs nothing beyond rankings.
    await exec('Settle Match', () => contract.settleMatch(currentSessionId, mid, validRanked), () => {
      // Auto-refresh: clear form and reload unsettled matches
      setSettleMatchId('');
      setSettleRanked(['']);
      loadUnsettledMatches();
    });
  };

  // ── Settle (batch) ──
  const handleSettleBatch = async () => {
    const contract = getWriteContract();
    if (!contract) return;
    const validRows = batchSettleRows.filter(r => r.matchId && r.ranked.filter(a => a.trim()).length >= 2);
    if (validRows.length === 0) {
      setTxStatus({ status: 'error', error: 'Add at least one valid row.' });
      return;
    }
    // Validate each row's addresses
    for (let ri = 0; ri < validRows.length; ri++) {
      const row = validRows[ri];
      const ranked = row.ranked.filter(a => a.trim());
      for (let i = 0; i < ranked.length; i++) {
        if (!ethers.utils.isAddress(ranked[i])) {
          setTxStatus({ status: 'error', error: `Match ${row.matchId}, position #${i + 1}: "${ranked[i]}" is not a valid address.` });
          return;
        }
        if (ranked[i] === ethers.constants.AddressZero) {
          setTxStatus({ status: 'error', error: `Match ${row.matchId}, position #${i + 1}: zero address not allowed.` });
          return;
        }
      }
      const lower = ranked.map(a => a.toLowerCase());
      const seen = new Set<string>();
      for (let i = 0; i < lower.length; i++) {
        if (seen.has(lower[i])) {
          setTxStatus({ status: 'error', error: `Match ${row.matchId}: duplicate address at positions #${lower.indexOf(lower[i]) + 1} and #${i + 1}. Each player must appear exactly once.` });
          return;
        }
        seen.add(lower[i]);
      }
    }
    const ids = validRows.map(r => parseInt(r.matchId));
    const rankedArrays = validRows.map(r => r.ranked.filter(a => a.trim()));
    if (!currentSessionId) { setTxStatus({ status: 'error', error: 'No current session found. Create a session first.' }); return; }
    await exec(`Batch Settle ${ids.length} Matches`, () => contract.batchSettleMatches(currentSessionId, ids, rankedArrays), () => {
      // Auto-refresh: clear batch rows and reload unsettled matches
      setBatchSettleRows([]);
      loadUnsettledMatches();
    });
  };

  // ── Cancel ──
  const handleCancelMatch = () => {
    const contract = getWriteContract();
    if (!contract || !cancelMatchId) return;
    if (!currentSessionId) { setTxStatus({ status: 'error', error: 'No current session found.' }); return; }
    exec('Cancel Match', () => contract.cancelMatch(currentSessionId, parseInt(cancelMatchId)), () => {
      setCancelMatchId('');
      loadUnsettledMatches();
    });
  };

  // Player list management for create
  // Get current reward type's min/max players
  const selectedRt = allowedRewardTypes.find(r => r.id === parseInt(createRewardTypeId));
  const minPlayers = selectedRt?.minPlayers ?? 2;
  const maxPlayers = selectedRt?.maxPlayers ?? 100;

  // Ensure player slots are within [min, max] for the selected reward type
  const adjustPlayerSlots = (min: number, max: number) => {
    setPlayerAddresses(prev => {
      let arr = [...prev];
      // Trim to max (remove empty slots from the end first, then truncate)
      if (arr.length > max) {
        // Try to remove empty trailing slots first
        while (arr.length > max) {
          const lastEmpty = arr.lastIndexOf('');
          if (lastEmpty >= min) arr.splice(lastEmpty, 1);
          else arr = arr.slice(0, max);
        }
      }
      // Expand to min
      if (arr.length < min) {
        arr = [...arr, ...Array(min - arr.length).fill('')];
      }
      return arr;
    });
  };

  const addPlayer = () => {
    if (playerAddresses.length >= maxPlayers) return;
    setPlayerAddresses(prev => [...prev, '']);
  };
  const removePlayer = (i: number) => {
    if (playerAddresses.length <= minPlayers) return;
    setPlayerAddresses(prev => prev.filter((_, idx) => idx !== i));
  };
  const updatePlayer = (i: number, val: string) => setPlayerAddresses(prev => prev.map((p, idx) => idx === i ? val : p));

  // Ranked list management for single settle
  const addRankedSlot = () => setSettleRanked(prev => [...prev, '']);
  const removeRankedSlot = (i: number) => setSettleRanked(prev => prev.filter((_, idx) => idx !== i));
  const updateRankedSlot = (i: number, val: string) => setSettleRanked(prev => prev.map((r, idx) => idx === i ? val : r));

  // Batch settle row management
  const addBatchRow = () => setBatchSettleRows(prev => [...prev, { matchId: '', ranked: ['', ''] }]);
  const removeBatchRow = (i: number) => setBatchSettleRows(prev => prev.filter((_, idx) => idx !== i));
  const updateBatchRowMatchId = (i: number, val: string) => setBatchSettleRows(prev => prev.map((r, idx) => idx === i ? { ...r, matchId: val } : r));
  const addBatchRanked = (i: number) => setBatchSettleRows(prev => prev.map((r, idx) => idx === i ? { ...r, ranked: [...r.ranked, ''] } : r));
  const updateBatchRanked = (rowIdx: number, slotIdx: number, val: string) => {
    setBatchSettleRows(prev => prev.map((r, idx) => idx === rowIdx ? { ...r, ranked: r.ranked.map((a, si) => si === slotIdx ? val : a) } : r));
  };

  // Extra fetched players cache for manually entered match IDs
  const [fetchedMatchPlayers, setFetchedMatchPlayers] = useState<Record<number, string[]>>({});
  const [loadingSinglePlayers, setLoadingSinglePlayers] = useState(false);

  // Get the player list for the currently selected match (unsettled, viewed, or fetched)
  const getMatchPlayers = (matchId: string): string[] => {
    const mid = parseInt(matchId);
    if (isNaN(mid)) return [];
    const um = unsettledMatches.find(u => u.id === mid);
    if (um) return um.players;
    const vm = matches.find(m => m.id === mid);
    if (vm) return vm.players;
    if (fetchedMatchPlayers[mid]) return fetchedMatchPlayers[mid];
    return [];
  };

  // Auto-fetch players when single settle match ID changes
  useEffect(() => {
    const mid = parseInt(settleMatchId);
    if (isNaN(mid) || !mid) return;
    // Already have players from unsettled or view cache
    const um = unsettledMatches.find(u => u.id === mid);
    if (um) {
      setSettleRanked(um.players.map(() => ''));
      return;
    }
    const vm = matches.find(m => m.id === mid);
    if (vm) {
      setSettleRanked(vm.players.map(() => ''));
      return;
    }
    if (fetchedMatchPlayers[mid]) {
      setSettleRanked(fetchedMatchPlayers[mid].map(() => ''));
      return;
    }
    // Fetch from chain
    const c = getReadContract();
    if (!c || !currentSessionId) return;
    let cancelled = false;
    setLoadingSinglePlayers(true);
    (async () => {
      try {
        const players: string[] = await c.getMatchPlayers(currentSessionId, mid);
        if (!cancelled && players.length > 0) {
          setFetchedMatchPlayers(prev => ({ ...prev, [mid]: players }));
          setSettleRanked(players.map(() => ''));
        }
      } catch {
        // match might not exist — leave as-is
      } finally {
        if (!cancelled) setLoadingSinglePlayers(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleMatchId, currentSessionId]);

  // Quick-fill ranked from loaded match players (view matches) or unsettled matches
  const fillRankedFromMatch = (matchId: number) => {
    const m = matches.find(m => m.id === matchId);
    const um = unsettledMatches.find(u => u.id === matchId);
    const players = m?.players ?? um?.players ?? fetchedMatchPlayers[matchId];
    if (players) {
      setSettleMatchId(String(matchId));
      // Initialize empty slots matching player count — user picks via dropdowns
      setSettleRanked(players.map(() => ''));
      setSettleMode('single');
    }
  };

  // Load all unsettled matches into batch settle rows (empty slots for dropdown selection)
  const loadAllUnsettledIntoBatch = () => {
    if (unsettledMatches.length === 0) return;
    setBatchSettleRows(unsettledMatches.map(m => ({
      matchId: String(m.id),
      ranked: m.players.map(() => ''),
    })));
    setSettleMode('batch');
  };

  // Get players for a batch row's match
  const getBatchMatchPlayers = (matchId: string): string[] => {
    const mid = parseInt(matchId);
    if (isNaN(mid)) return [];
    const um = unsettledMatches.find(u => u.id === mid);
    if (um) return um.players;
    const vm = matches.find(m => m.id === mid);
    if (vm) return vm.players;
    return [];
  };

  if (!sessionManagerAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load SessionManager first.</p></Card>;
  }

  const inputCls = 'w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
  const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';
  const placementLabels = ['🥇 1st', '🥈 2nd', '🥉 3rd'];
  const getPlacementLabel = (i: number) => i < placementLabels.length ? placementLabels[i] : `#${i + 1}`;

  return (
    <div className="space-y-4">
      {/* Info Banner */}
      <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3 flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
        <div className="text-xs text-blue-300">
          <p className="font-semibold mb-1">How Matches Work (N Players + Ranked Placements)</p>
          <p>The operator calls <code className="text-accent">createMatch(rewardTypeId, matchRef, players[])</code> with N player addresses. The operator's wallet is charged <strong>collectionBps%</strong> of the match pool (entryFee × N) — reward math still uses the full pool.</p>
          <p className="mt-1">After the match, call <code className="text-accent">settleMatch(matchId, rankedPlayers[])</code> with ALL players ordered by placement (1st, 2nd, 3rd...). Payout mode comes from the match's reward type: <strong>Percentage of Pool</strong> credits <code className="text-accent">matchValue × placementBps[rank] / 10000</code>, while <strong>Fixed Points (±)</strong> credits that placement's exact signed points (negatives allowed, points can go below zero) — configured once on the reward type in the Admin tab, applied automatically here.</p>
        </div>
      </div>

      {/* Create Match */}
      <Card title="Create Match (SESSION_OPERATOR_ROLE)" icon={<Plus className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">Auto-uses your current-day session. Add N players (min/max set per reward type).</p>
        {/* Timing status banner */}
        {countdown && !dayFinalized && dayTiming?.isGameWindowOpen && (
          <div className="border rounded-lg px-3 py-2 mb-3 text-xs flex items-center gap-1.5 bg-blue-500/10 border-blue-500/40 text-blue-300">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span className="font-mono font-semibold">{countdown}</span>
          </div>
        )}
        {dayFinalized && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Day {dayFinalizedKey} has already been finalized. No new matches can be created.
          </div>
        )}
        {!dayFinalized && dayTiming && !dayTiming.isGameWindowOpen && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-red-400">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Game window has ended for day {dayFinalizedKey}. Match creation is disabled.</span>
            </div>
            <div className="mt-1.5 text-[10px] text-red-400/70">
              Window was {new Date(dayTiming.gameWindowStart * 1000).toLocaleTimeString()} – {new Date(dayTiming.gameWindowEnd * 1000).toLocaleTimeString()}.
              {dayTiming.isGracePeriodOpen ? ' Grace period still open for settling matches.' : ' Grace period also expired.'}
              {' '}If using short durations for testing, adjust Session Duration in the Admin tab.
            </div>
          </div>
        )}
        {loadingAllowed && (
          <div className="flex items-center gap-2 text-xs text-txt-secondary py-1 mb-2">
            <RefreshCw className="w-3 h-3 animate-spin" /> Loading your allowed reward types...
          </div>
        )}
        {!loadingAllowed && allowedRewardTypes.length === 0 && address && sessionManagerAddress && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-2 text-xs text-yellow-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> No allowed reward types found for your operator. Ask an admin to set Operator Reward Rules in the Admin tab.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">Reward Type</label>
            {allowedRewardTypes.length > 0 ? (
              <select value={createRewardTypeId} onChange={e => {
                const val = e.target.value;
                setCreateRewardTypeId(val);
                const rt = allowedRewardTypes.find(r => r.id === parseInt(val));
                if (rt) adjustPlayerSlots(rt.minPlayers, rt.maxPlayers);
              }} className={inputCls}>
                <option value="">— Select Reward Type —</option>
                {allowedRewardTypes.map(rt => (
                  <option key={rt.id} value={String(rt.id)}>
                    #{rt.id} {rt.name} — {rt.entryFee} pts ({rt.minPlayers}-{rt.maxPlayers}P)
                  </option>
                ))}
              </select>
            ) : (
              <input type="number" value={createRewardTypeId} onChange={e => setCreateRewardTypeId(e.target.value)} min="1" placeholder="Reward Type ID" className={inputCls} />
            )}
          </div>
          <div>
            <label className="text-xs text-txt-secondary">Match Ref (unique identifier)</label>
            <input value={createMatchRef} onChange={e => { setCreateMatchRef(e.target.value); setMatchRefTouched(true); }} onBlur={() => setMatchRefTouched(true)} placeholder="match-001" className={`${inputCls.replace('font-mono', '')} ${matchRefTouched && !createMatchRef.trim() ? '!ring-2 !ring-red-500/60' : ''}`} />
            {matchRefTouched && !createMatchRef.trim() && <p className="text-[10px] text-red-400 mt-0.5">⚠ Match Ref is required</p>}
          </div>
        </div>
        {/* Selected reward type info */}
        {createRewardTypeId && allowedRewardTypes.length > 0 && (() => {
          const sel = allowedRewardTypes.find(r => r.id === parseInt(createRewardTypeId));
          return sel ? (
            <div className="bg-surface-tertiary/50 rounded-lg px-3 py-2 mb-3 text-[11px] flex flex-wrap gap-x-4 gap-y-1">
              <span className="text-txt-secondary">Reward Type #{sel.id}:</span>
              <span className="text-accent font-semibold">{sel.name}</span>
              <span>Entry Fee: <span className="text-accent">{sel.entryFee}</span> pts/player</span>
              <span>Players: {sel.minPlayers}–{sel.maxPlayers}</span>
              <span className={sel.fixedPoints ? 'text-yellow-400' : 'text-txt-secondary'}>{sel.fixedPoints ? 'Fixed Points (±) — settleMatch applies configured deltas' : 'Percentage of Pool'}</span>
            </div>
          ) : null;
        })()}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-txt-secondary">Player Addresses</label>
            <span className="text-[10px] text-txt-secondary">
              {playerAddresses.length} slots {selectedRt && <span className="text-accent">(min {minPlayers}, max {maxPlayers})</span>}
            </span>
          </div>
          {playerAddresses.map((p, i) => {
            const trimmed = p.trim().toLowerCase();
            const isDuplicate = trimmed && playerAddresses.some((other, j) => j !== i && other.trim().toLowerCase() === trimmed);
            const isInvalid = trimmed && !ethers.utils.isAddress(trimmed);
            const isZero = trimmed && trimmed === ethers.constants.AddressZero.toLowerCase();
            const hasError = isDuplicate || isInvalid || isZero;
            return (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-txt-secondary w-8 shrink-0">P{i + 1}</span>
                  <input value={p} onChange={e => updatePlayer(i, e.target.value)} placeholder="0x..." className={`${inputCls} !mt-0 ${hasError ? '!ring-2 !ring-red-500/60' : ''}`} />
                  {playerAddresses.length > minPlayers && (
                    <button onClick={() => removePlayer(i)} className="p-1.5 text-red-400 hover:text-red-300">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {isDuplicate && <p className="text-[10px] text-red-400 ml-10 mt-0.5">⚠ Duplicate address</p>}
                {isInvalid && <p className="text-[10px] text-red-400 ml-10 mt-0.5">⚠ Invalid Ethereum address</p>}
                {isZero && <p className="text-[10px] text-red-400 ml-10 mt-0.5">⚠ Zero address not allowed</p>}
              </div>
            );
          })}
          <button onClick={addPlayer} disabled={playerAddresses.length >= maxPlayers} className={`text-xs text-accent hover:underline flex items-center gap-1 ${playerAddresses.length >= maxPlayers ? 'opacity-40 cursor-not-allowed' : ''}`}>
            <UserPlus className="w-3 h-3" /> Add Player {playerAddresses.length >= maxPlayers && '(max reached)'}
          </button>
        </div>
        {!tokenAddress && <p className="text-xs text-yellow-400 mt-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Token address not set — go to Deploy tab first.</p>}
        <button onClick={handleCreateMatch} disabled={!isConnected || !tokenAddress || dayFinalized || (dayTiming !== null && !dayTiming.isGameWindowOpen)}
          className={`mt-4 w-full ${btnCls}`}>
          Create Match ({playerAddresses.filter(p => p.trim()).length} Players)
        </button>
      </Card>

      {/* Quick Test / Load Test */}
      <Card title="Quick Test (Load Test)" icon={<Shuffle className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-2">
          Generates N matches using the Reward Type picked below, each filled with test wallet addresses drawn from a reusable player pool
          (no real players needed) — you approve one transaction per match created. Then batch-settle all of them with randomly shuffled
          rankings in a single transaction.
        </p>
        <div className="flex items-center gap-2 mb-3 text-xs text-txt-secondary">
          <UserPlus className="w-3.5 h-3.5 shrink-0" />
          {testPlayerPool.length > 0
            ? <>Reusing a pool of <strong className="text-accent">{testPlayerPool.length}</strong> test players from previous runs — new ones are only added if a run needs more.</>
            : 'No test player pool yet — one will be created on your first run.'}
          {testPlayerPool.length > 0 && (
            <button onClick={resetPlayerPool} className="text-red-400 hover:underline shrink-0">Reset Pool</button>
          )}
        </div>
        <div className="flex items-end gap-3 flex-wrap mb-1">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs text-txt-secondary">Reward Type</label>
            {allowedRewardTypes.length > 0 ? (
              <select value={quickTestRewardTypeId} onChange={e => setQuickTestRewardTypeId(e.target.value)} className={inputCls}>
                <option value="">— Select Reward Type —</option>
                {allowedRewardTypes.map(rt => (
                  <option key={rt.id} value={String(rt.id)}>
                    #{rt.id} {rt.name} — {rt.entryFee} pts ({rt.minPlayers}-{rt.maxPlayers}P)
                  </option>
                ))}
              </select>
            ) : (
              <input type="number" value={quickTestRewardTypeId} onChange={e => setQuickTestRewardTypeId(e.target.value)} min="1" placeholder="Reward Type ID" className={inputCls} />
            )}
          </div>
          <div>
            <label className="text-xs text-txt-secondary"># Test Matches</label>
            <input type="number" min="1" max="20" value={quickTestCount} onChange={e => setQuickTestCount(e.target.value)}
              className={`${inputCls} w-24`} />
          </div>
        </div>
        {!loadingAllowed && allowedRewardTypes.length === 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-3 text-xs text-yellow-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> No allowed reward types found for your operator. Ask an admin to set Operator Reward Rules in the Admin tab.
          </div>
        )}
        {(() => {
          const selectedQuickTestRt = allowedRewardTypes.find(r => r.id === parseInt(quickTestRewardTypeId));
          return (
            <>
              <p className="text-txt-secondary text-xs mb-3">
                {selectedQuickTestRt ? <>Each match will use <strong className="text-accent">{selectedQuickTestRt.minPlayers}</strong> random players (min for &quot;{selectedQuickTestRt.name}&quot;).</> : 'Select a Reward Type above first.'}
              </p>
              <button onClick={handleQuickTest} disabled={!isConnected || !tokenAddress || !selectedQuickTestRt || quickTestRunning || dayFinalized}
                className={`${btnCls} flex items-center gap-2`}>
                <Shuffle className="w-4 h-4" /> {quickTestRunning ? 'Generating…' : `Generate & Create ${quickTestCount || 5} Test Matches`}
              </button>
            </>
          );
        })()}
        {quickTestRunning && quickTestProgress && (
          <p className="text-xs text-accent mt-2 flex items-center gap-1.5"><RefreshCw className="w-3 h-3 animate-spin" /> {quickTestProgress}</p>
        )}

        {quickTestMatches.length > 0 && (
          <div className="mt-4 bg-surface-tertiary rounded-lg p-3 space-y-2">
            <p className="text-xs font-semibold text-txt-secondary">{quickTestMatches.length} test match{quickTestMatches.length !== 1 ? 'es' : ''} created, unsettled:</p>
            <div className="flex flex-wrap gap-1.5">
              {quickTestMatches.map(m => (
                <span key={m.matchId} className="text-[10px] bg-blue-900/40 text-blue-300 px-2 py-1 rounded-full font-mono">#{m.matchId} ({m.players.length}p)</span>
              ))}
            </div>
            <button onClick={handleQuickTestBatchSettle} disabled={!isConnected || quickTestSettling}
              className={`w-full mt-2 ${btnCls} flex items-center justify-center gap-2`}>
              <Trophy className="w-4 h-4" /> {quickTestSettling ? 'Settling…' : `Batch Settle All ${quickTestMatches.length} With Random Winners`}
            </button>
          </div>
        )}

        {quickTestResults.length > 0 && (
          <div className="mt-4 bg-surface-tertiary rounded-lg p-3 space-y-1.5">
            <p className="text-xs font-semibold text-txt-secondary">Results — random winner per match:</p>
            {quickTestResults.map(r => (
              <div key={r.matchId} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-txt-secondary">#{r.matchId}</span>
                <Trophy className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                <span className="font-mono text-accent truncate">{r.winner}</span>
                <span className="text-txt-secondary">({r.ranked.length} ranked)</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Settle Matches */}
      <Card title={
        <div className="flex items-center justify-between w-full">
          <span>Settle Matches (Ranked Placements)</span>
          <button onClick={loadUnsettledMatches} disabled={loadingUnsettled}
            className="text-[11px] text-accent hover:underline flex items-center gap-1 font-normal">
            <RefreshCw className={`w-3 h-3 ${loadingUnsettled ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      } icon={<Trophy className="w-5 h-5 text-accent" />}>

        {/* Grace period countdown for settle */}
        {dayTiming && dayTiming.isGracePeriodOpen && !dayFinalized && countdown && (
          <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-yellow-400 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span className="font-mono font-semibold">{countdown}</span>
          </div>
        )}
        {dayTiming && !dayTiming.isGameWindowOpen && !dayTiming.isGracePeriodOpen && !dayFinalized && Math.floor(Date.now() / 1000) > dayTiming.finalizationDeadline && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-red-400">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Grace period expired — settling is no longer possible for day {dayFinalizedKey}.
            </div>
            <div className="mt-1 text-[10px] text-red-400/70">
              Deadline was {new Date(dayTiming.finalizationDeadline * 1000).toLocaleTimeString()}. Adjust Session Duration or Grace Period in Admin tab for future sessions.
            </div>
          </div>
        )}

        {/* Unsettled Matches List */}
        {loadingUnsettled ? (
          <div className="flex items-center justify-center py-4 gap-2 text-xs text-txt-secondary">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading unsettled matches…
          </div>
        ) : unsettledMatches.length > 0 ? (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-txt-secondary font-medium">
                {unsettledMatches.length} Unsettled Match{unsettledMatches.length !== 1 ? 'es' : ''} — click to settle
              </p>
              {unsettledMatches.length > 1 && (
                <button onClick={loadAllUnsettledIntoBatch} className="text-[11px] text-accent hover:underline flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Load All → Batch
                </button>
              )}
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {unsettledMatches.map(m => (
                <div key={m.id}
                  className={`bg-surface-tertiary rounded-lg p-3 cursor-pointer hover:ring-1 hover:ring-accent/50 transition-all ${settleMatchId === String(m.id) ? 'ring-2 ring-accent' : ''}`}
                  onClick={() => fillRankedFromMatch(m.id)}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Hash className="w-3.5 h-3.5 text-accent" />
                      <span className="text-xs font-semibold">Match #{m.id}</span>
                      <span className="text-[10px] text-txt-secondary">{m.matchRef}</span>
                    </div>
                    <span className="text-[10px] bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded-full">CREATED</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
                    <span className="text-txt-secondary">Type: <span className="text-txt-primary">{m.rewardTypeName}</span></span>
                    <span className="text-txt-secondary">Pool: <span className="text-accent">{m.matchValue}</span></span>
                    <span className="text-txt-secondary">Players: <span className="text-txt-primary">{m.playerCount}</span></span>
                    <span className="text-txt-secondary">{m.fixedPoints ? 'Mode:' : 'Win Slots:'} <span className="text-yellow-400 font-semibold">{m.fixedPoints ? 'Fixed Points (±)' : (m.winSlots > 0 ? `${m.winSlots} of ${m.playerCount}` : 'N/A')}</span></span>
                  </div>
                  {/* Reward breakdown per position */}
                  {m.fixedPoints ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from({ length: m.playerCount }).map((_, i) => {
                        const val = i < m.placementDeltas.length ? parseFloat(m.placementDeltas[i]) || 0 : 0;
                        return (
                          <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${val > 0 ? 'bg-green-500/10 text-green-400' : val < 0 ? 'bg-red-500/10 text-red-400' : 'bg-surface-secondary text-txt-secondary/50'}`}>
                            {getPlacementLabel(i)}: {val > 0 ? `+${val}` : val}
                          </span>
                        );
                      })}
                    </div>
                  ) : m.placementBps.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from({ length: m.playerCount }).map((_, i) => {
                        const bps = i < m.placementBps.length ? m.placementBps[i] : 0;
                        const reward = parseFloat(m.matchValue) * bps / 10000;
                        return (
                          <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${bps > 0 ? 'bg-green-500/10 text-green-400 font-semibold' : 'bg-surface-secondary text-txt-secondary/50'}`}>
                            {getPlacementLabel(i)}: {bps > 0 ? `+${reward.toFixed(2)}` : '0'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.players.map((p, i) => (
                      <span key={i} className="text-[10px] font-mono bg-surface-secondary px-1.5 py-0.5 rounded text-txt-secondary truncate max-w-[120px]" title={p}>
                        P{i + 1}: {p.slice(0, 6)}…{p.slice(-4)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-txt-secondary text-center py-3 mb-3">No unsettled matches in your current session.</p>
        )}

        {/* Mode Tabs */}
        <div className="flex gap-2 mb-3">
          <button onClick={() => setSettleMode('single')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${settleMode === 'single' ? 'bg-accent text-black' : 'bg-surface-tertiary text-txt-secondary'}`}>Single</button>
          <button onClick={() => setSettleMode('batch')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${settleMode === 'batch' ? 'bg-accent text-black' : 'bg-surface-tertiary text-txt-secondary'}`}>Batch</button>
        </div>

        {settleMode === 'single' ? (
          (() => {
            const singleMatchPlayers = getMatchPlayers(settleMatchId);
            const hasDropdown = singleMatchPlayers.length > 0;
            return (
              <div>
                <p className="text-xs text-txt-secondary mb-3">
                  {hasDropdown
                    ? 'Select each player\'s placement using the dropdowns below. Already-assigned players are filtered out.'
                    : 'List ALL players in order of placement (1st place first). Every player must be included.'}
                </p>
                <div className="mb-3">
                  <label className="text-xs text-txt-secondary">Match ID</label>
                  <input type="number" value={settleMatchId} onChange={e => setSettleMatchId(e.target.value)} placeholder="1" className={inputCls} />
                  {loadingSinglePlayers && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-txt-secondary">
                      <RefreshCw className="w-3 h-3 animate-spin" /> Loading players for match #{settleMatchId}…
                    </div>
                  )}
                </div>
                {/* Show match info + reward breakdown if match is selected */}
                {settleMatchId && (() => {
                  const um = unsettledMatches.find(u => u.id === parseInt(settleMatchId));
                  if (!um) return null;
                  const pool = parseFloat(um.matchValue);
                  const totalDistBps = um.placementBps.slice(0, um.playerCount).reduce((s, b) => s + b, 0);
                  const retained = pool * (10000 - totalDistBps) / 10000;
                  return (
                    <div className="bg-surface-tertiary/50 rounded-lg px-3 py-2.5 mb-3 space-y-2">
                      <div className="text-[11px] flex flex-wrap gap-x-4 gap-y-1">
                        <span className="text-txt-secondary">Match #{um.id}:</span>
                        <span className="text-accent font-semibold">{um.rewardTypeName}</span>
                        <span>Pool: <span className="text-accent font-semibold">{um.matchValue} pts</span></span>
                        <span>Players: <span className="text-txt-primary">{um.playerCount}</span></span>
                        {um.fixedPoints ? (
                          <span className="text-yellow-400 font-semibold">Fixed Points (±) — settleMatch applies configured deltas automatically</span>
                        ) : (
                          <span>Win Slots: <span className="text-yellow-400 font-semibold">{um.winSlots} of {um.playerCount}</span></span>
                        )}
                      </div>
                      {/* Reward breakdown table */}
                      {um.fixedPoints ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                          {Array.from({ length: um.playerCount }).map((_, i) => {
                            const val = i < um.placementDeltas.length ? parseFloat(um.placementDeltas[i]) || 0 : 0;
                            return (
                              <div key={i} className={`rounded-lg px-2 py-1.5 text-center text-[11px] ${val > 0 ? 'bg-green-500/10 border border-green-500/20' : val < 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-surface-secondary border border-white/5'}`}>
                                <span className="text-txt-secondary">{getPlacementLabel(i)}</span>
                                <p className={`font-bold ${val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-txt-secondary/40'}`}>
                                  {val > 0 ? `+${val}` : val} <span className="font-normal text-[10px]">pts</span>
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                          {Array.from({ length: um.playerCount }).map((_, i) => {
                            const bps = i < um.placementBps.length ? um.placementBps[i] : 0;
                            const reward = pool * bps / 10000;
                            return (
                              <div key={i} className={`rounded-lg px-2 py-1.5 text-center text-[11px] ${bps > 0 ? 'bg-green-500/10 border border-green-500/20' : 'bg-surface-secondary border border-white/5'}`}>
                                <span className="text-txt-secondary">{getPlacementLabel(i)}</span>
                                <p className={`font-bold ${bps > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                                  {bps > 0 ? `+${reward.toFixed(4).replace(/\.?0+$/, '')}` : '0'} <span className="font-normal text-[10px]">pts</span>
                                </p>
                                <p className="text-[10px] text-txt-secondary">{(bps / 100).toFixed(1)}%</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {!um.fixedPoints && retained > 0 && (
                        <p className="text-[10px] text-yellow-400/80">Retained (operator fee): {retained.toFixed(4).replace(/\.?0+$/, '')} pts ({((10000 - totalDistBps) / 100).toFixed(1)}%)</p>
                      )}
                    </div>
                  );
                })()}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-txt-secondary">Ranked Players (1st → Last)</label>
                    {hasDropdown && (
                      <span className="text-[10px] text-txt-secondary">
                        {settleRanked.filter(r => r).length}/{singleMatchPlayers.length} assigned
                      </span>
                    )}
                  </div>
                  {settleRanked.map((r, i) => {
                    // Build available options: unselected players + current selection
                    const selectedElsewhere = new Set(settleRanked.filter((v, j) => j !== i && v).map(v => v.toLowerCase()));
                    const available = singleMatchPlayers.filter(p => !selectedElsewhere.has(p.toLowerCase()));
                    const um = unsettledMatches.find(u => u.id === parseInt(settleMatchId));
                    const isWinSlot = um ? i < um.winSlots : false;
                    const pool = um ? parseFloat(um.matchValue) : 0;
                    const deltaVal = um && um.fixedPoints && i < um.placementDeltas.length ? parseFloat(um.placementDeltas[i]) || 0 : null;
                    const bps = um && !um.fixedPoints && i < um.placementBps.length ? um.placementBps[i] : 0;
                    const reward = pool * bps / 10000;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className={`text-xs w-12 shrink-0 ${isWinSlot ? 'font-semibold' : ''}`}>{getPlacementLabel(i)}</span>
                        {hasDropdown ? (
                          <select value={r} onChange={e => updateRankedSlot(i, e.target.value)}
                            className={`${inputCls} !mt-0 ${isWinSlot ? '!ring-1 !ring-yellow-500/40' : ''}`}>
                            <option value="">— Select Player —</option>
                            {available.map(p => (
                              <option key={p} value={p}>
                                {p.slice(0, 6)}…{p.slice(-4)} {p.toLowerCase() === r.toLowerCase() ? '✓' : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input value={r} onChange={e => updateRankedSlot(i, e.target.value)} placeholder="0x..." className={inputCls + ' !mt-0'} />
                        )}
                        {/* Reward preview — read-only, derived from the match's reward type */}
                        {deltaVal !== null ? (
                          <span className={`text-[11px] w-24 shrink-0 text-right font-semibold ${deltaVal > 0 ? 'text-green-400' : deltaVal < 0 ? 'text-red-400' : 'text-txt-secondary/40'}`}>
                            {deltaVal > 0 ? `+${deltaVal}` : deltaVal}
                          </span>
                        ) : (
                          <span className={`text-[11px] w-24 shrink-0 text-right font-semibold ${reward > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                            {reward > 0 ? `+${reward.toFixed(4).replace(/\.?0+$/, '')}` : '0'}
                          </span>
                        )}
                        {settleRanked.length > 1 && !hasDropdown && (
                          <button onClick={() => removeRankedSlot(i)} className="p-1.5 text-red-400 hover:text-red-300">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {!hasDropdown && (
                    <button onClick={addRankedSlot} className="text-xs text-accent hover:underline">+ Add placement slot</button>
                  )}
                </div>
                <button onClick={handleSettleSingle} disabled={!isConnected} className={`mt-3 w-full ${btnCls}`}>
                  Settle Match #{settleMatchId || '?'}
                </button>
              </div>
            );
          })()
        ) : (
          <div>
            <p className="text-xs text-txt-secondary mb-3">Batch settle multiple matches at once. Each row needs a match ID and a full ranked player list.</p>
            {batchSettleRows.length === 0 && (
              <div className="text-center py-3">
                <p className="text-xs text-txt-secondary mb-2">No rows. Click &quot;Add Match&quot; below or load unsettled matches.</p>
                {unsettledMatches.length > 0 && (
                  <button onClick={loadAllUnsettledIntoBatch} className="text-xs text-accent hover:underline flex items-center gap-1 mx-auto">
                    <Plus className="w-3 h-3" /> Load {unsettledMatches.length} Unsettled Match{unsettledMatches.length !== 1 ? 'es' : ''}
                  </button>
                )}
              </div>
            )}
            {batchSettleRows.map((row, ri) => {
              const um = unsettledMatches.find(u => String(u.id) === row.matchId);
              const batchPlayers = getBatchMatchPlayers(row.matchId);
              const hasBatchDropdown = batchPlayers.length > 0;
              return (
                <div key={ri} className="bg-surface-tertiary rounded-lg p-3 mb-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-txt-primary">Match #{row.matchId || '?'}</span>
                      {um && <span className="text-[10px] text-txt-secondary">{um.rewardTypeName}</span>}
                      {um && <span className="text-[10px] text-yellow-400">{um.fixedPoints ? 'Fixed Points (±)' : `Win ${um.winSlots}/${um.playerCount}`}</span>}
                      {hasBatchDropdown && <span className="text-[10px] text-txt-secondary">{row.ranked.filter(a => a).length}/{batchPlayers.length} assigned</span>}
                    </div>
                    <button onClick={() => removeBatchRow(ri)} className="text-red-400 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="mb-2">
                    <label className="text-[11px] text-txt-secondary">Match ID</label>
                    <input type="number" value={row.matchId} onChange={e => updateBatchRowMatchId(ri, e.target.value)} placeholder="1" className={inputCls} />
                  </div>
                  {row.ranked.map((addr, si) => {
                    const selectedElsewhere = new Set(row.ranked.filter((v, j) => j !== si && v).map(v => v.toLowerCase()));
                    const availableBatch = batchPlayers.filter(p => !selectedElsewhere.has(p.toLowerCase()));
                    const deltaBatch = um && um.fixedPoints && si < um.placementDeltas.length ? parseFloat(um.placementDeltas[si]) || 0 : null;
                    const isWin = um ? (um.fixedPoints ? (deltaBatch ?? 0) > 0 : si < um.winSlots) : false;
                    const bpsBatch = um && !um.fixedPoints && si < um.placementBps.length ? um.placementBps[si] : 0;
                    const poolBatch = um ? parseFloat(um.matchValue) : 0;
                    const rewardBatch = poolBatch * bpsBatch / 10000;
                    return (
                      <div key={si} className="flex items-center gap-2 mb-1">
                        <span className={`text-[11px] w-10 shrink-0 ${isWin ? 'font-semibold' : ''}`}>{getPlacementLabel(si)}</span>
                        {hasBatchDropdown ? (
                          <select value={addr} onChange={e => updateBatchRanked(ri, si, e.target.value)}
                            className={`${inputCls} !mt-0 text-xs ${isWin ? '!ring-1 !ring-yellow-500/40' : ''}`}>
                            <option value="">— Select Player —</option>
                            {availableBatch.map(p => (
                              <option key={p} value={p}>
                                {p.slice(0, 6)}…{p.slice(-4)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input value={addr} onChange={e => updateBatchRanked(ri, si, e.target.value)} placeholder="0x..." className={inputCls + ' !mt-0 text-xs'} />
                        )}
                        {deltaBatch !== null ? (
                          <span className={`text-[10px] w-20 shrink-0 text-right font-semibold ${deltaBatch > 0 ? 'text-green-400' : deltaBatch < 0 ? 'text-red-400' : 'text-txt-secondary/40'}`}>
                            {deltaBatch > 0 ? `+${deltaBatch}` : deltaBatch}
                          </span>
                        ) : (
                          <span className={`text-[10px] w-20 shrink-0 text-right font-semibold ${rewardBatch > 0 ? 'text-green-400' : 'text-txt-secondary/40'}`}>
                            {rewardBatch > 0 ? `+${rewardBatch.toFixed(4).replace(/\.?0+$/, '')}` : '0'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {!hasBatchDropdown && (
                    <button onClick={() => addBatchRanked(ri)} className="text-[11px] text-accent hover:underline">+ Add slot</button>
                  )}
                </div>
              );
            })}
            <button onClick={addBatchRow} className="text-xs text-accent hover:underline mb-3">+ Add Match</button>
            <button onClick={handleSettleBatch} disabled={!isConnected || batchSettleRows.length === 0} className={`w-full ${btnCls}`}>
              Batch Settle ({batchSettleRows.length} matches)
            </button>
          </div>
        )}
      </Card>

      {/* Cancel Match */}
      <Card title="Cancel Match" icon={<XCircle className="w-5 h-5 text-red-400" />}>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="text-xs text-txt-secondary">Match ID</label>
            <input type="number" value={cancelMatchId} onChange={e => setCancelMatchId(e.target.value)} placeholder="1" className={inputCls} />
          </div>
          <button onClick={handleCancelMatch} disabled={!isConnected}
            className="bg-transparent border border-red-500/50 hover:bg-red-500/10 text-red-400 font-medium px-6 py-2 rounded-lg text-sm transition-colors">
            Cancel
          </button>
        </div>
      </Card>

      {/* View Matches */}
      <Card title="View Matches" icon={<Swords className="w-5 h-5 text-accent" />}>
        <div className="flex items-end gap-3 mb-4">
          <div className="flex-1">
            <label className="text-xs text-txt-secondary">Session ID</label>
            <input type="number" value={viewSessionId} onChange={e => setViewSessionId(e.target.value)} placeholder="1" className={inputCls} />
          </div>
          <button onClick={fetchMatches} disabled={loadingMatches || !viewSessionId}
            className="flex items-center gap-1.5 bg-surface-tertiary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium px-5 py-2 rounded-lg text-sm">
            <RefreshCw className={`w-3.5 h-3.5 ${loadingMatches ? 'animate-spin' : ''}`} /> Load
          </button>
        </div>
        {matches.length === 0 ? (
          <p className="text-txt-secondary text-sm text-center py-4">No matches loaded. Enter a Session ID and click Load.</p>
        ) : (
          <div className="space-y-3">
            {matches.map(m => (
              <div key={`${m.sessionId}-${m.id}`} className="bg-surface-tertiary rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Hash className="w-4 h-4 text-accent" />
                    <span className="font-semibold">Match #{m.id}</span>
                    <span className="text-xs text-txt-secondary">(Session #{m.sessionId})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.status === 0 && (
                      <button onClick={() => fillRankedFromMatch(m.id)}
                        className="text-[11px] text-accent hover:underline flex items-center gap-1">
                        <Medal className="w-3 h-3" /> Settle
                      </button>
                    )}
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                      m.status === 0 ? 'bg-blue-900/40 text-blue-300' :
                      m.status === 1 ? 'bg-green-900/40 text-green-300' :
                      'bg-red-900/40 text-red-300'
                    }`}>
                      {MATCH_STATUS_LABELS[m.status] ?? `Status(${m.status})`}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-txt-secondary">Reward Type:</span> <span className="text-txt-primary">{m.rewardTypeId}</span></div>
                  <div><span className="text-txt-secondary">Entry Fee:</span> <span className="text-accent">{m.entryFee}</span></div>
                  <div><span className="text-txt-secondary">Pool:</span> <span className="text-accent">{m.matchValue}</span></div>
                  <div><span className="text-txt-secondary">Players:</span> <span className="text-txt-primary">{m.playerCount}</span></div>
                  <div className="col-span-2"><span className="text-txt-secondary">Ref:</span> <span className="text-txt-primary">{m.matchRef}</span></div>
                  {m.settled && <div className="col-span-2"><span className="text-txt-secondary">Winner (1st):</span> <span className="text-green-400 font-mono text-[11px]">{m.winner}</span></div>}
                </div>
                {/* Players with Placements */}
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] text-txt-secondary font-medium uppercase tracking-wide">
                    {m.settled ? 'Final Rankings' : 'Players'}
                  </p>
                  {m.playerInfos.map((pb, i) => (
                    <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                      pb.placement === 1 ? 'bg-yellow-900/30 border border-yellow-500/30' :
                      pb.placement === 2 ? 'bg-gray-600/20 border border-gray-400/30' :
                      pb.placement === 3 ? 'bg-orange-900/20 border border-orange-500/30' :
                      pb.placement > 0 ? 'bg-surface-secondary border border-white/5' :
                      'bg-surface-secondary'
                    }`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs shrink-0 w-12">{pb.placement > 0 ? getPlacementLabel(pb.placement - 1) : `P${i + 1}`}</span>
                        <span className="font-mono truncate text-txt-primary">{pb.address}</span>
                      </div>
                      {pb.placement > 0 && parseFloat(pb.reward) > 0 && (
                        <span className="shrink-0 text-green-400 font-semibold ml-3">+{parseFloat(pb.reward).toFixed(4)} pts</span>
                      )}
                      {pb.placement > 0 && parseFloat(pb.reward) < 0 && (
                        <span className="shrink-0 text-red-400 font-semibold ml-3">{parseFloat(pb.reward).toFixed(4)} pts</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}
