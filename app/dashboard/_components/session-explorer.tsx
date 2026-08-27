'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { SESSION_STATUS_LABELS, MATCH_STATUS_LABELS, networkStorageKey } from '@/lib/contracts/config';
import { decodeError } from '@/lib/contracts/error-decoder';
import { sendWithGasBuffer } from '@/lib/contracts/gas';
import { Search, RefreshCw, Clock, Trophy, XCircle, ChevronDown, ChevronUp, AlertTriangle, GripVertical, Check, Hash, Medal, Lock } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';

/* ── Derived session display status ── */
type DerivedStatus = 'CREATED' | 'RUNNING' | 'GRACE' | 'EXPIRED' | 'FINALIZED' | 'CANCELLED';

function deriveDayStatus(contractStatus: number, timing: DayTiming | null): DerivedStatus {
  if (contractStatus === 3) return 'CANCELLED';
  if (!timing) {
    // No timing — fall back to raw contract status
    if (contractStatus === 0) return 'CREATED';
    if (contractStatus === 2) return 'EXPIRED';
    return 'RUNNING';
  }
  if (timing.isFinalized) return 'FINALIZED';
  if (timing.isGameWindowOpen) return 'RUNNING';
  if (timing.isGracePeriodOpen) return 'GRACE';
  // Past both windows
  const now = Math.floor(Date.now() / 1000);
  if (now > timing.finalizationDeadline) return 'EXPIRED';
  return 'GRACE';
}

const DERIVED_STATUS_COLORS: Record<DerivedStatus, string> = {
  CREATED: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  RUNNING: 'bg-green-500/20 text-green-400 border-green-500/30',
  GRACE: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  EXPIRED: 'bg-red-500/20 text-red-400 border-red-500/30',
  FINALIZED: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  CANCELLED: 'bg-red-500/20 text-red-400 border-red-500/30',
};

interface SessionInfo {
  id: number;
  dateKey: number;
  operator: string;
  startTime: number;
  endTime: number;
  matchCount: number;
  totalEntryCollected: string;
  status: number;
}

interface MatchInfo {
  id: number;
  rewardTypeId: number;
  matchRef: string;
  playerCount: number;
  entryFee: string;
  matchValue: string;
  winner: string;
  status: number; // 0=CREATED, 1=SETTLED, 2=CANCELLED
  settled: boolean;
  players: string[];
  rankings: string[];
  rewardTypeName: string;
  fixedPoints: boolean;
  placementBps: number[];
  placementDeltas: string[];
}

interface DayTiming {
  gameWindowStart: number;
  gameWindowEnd: number;
  finalizationDeadline: number;
  isGameWindowOpen: boolean;
  isGracePeriodOpen: boolean;
  isFinalized: boolean;
}

export default function SessionExplorer() {
  const { signer, provider, isConnected, address, sessionManagerAddress, hubAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });

  // Session selection
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [matches, setMatches] = useState<MatchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [dayTiming, setDayTiming] = useState<DayTiming | null>(null);
  const [countdown, setCountdown] = useState('');
  // On-chain per-operator auto-release toggle for the session's operator (checked live at finalize time)
  const [autoRelease, setAutoRelease] = useState(false);

  // Settle UI per-match
  const [settlingMatchId, setSettlingMatchId] = useState<number | null>(null);
  const [settleRanked, setSettleRanked] = useState<string[]>([]);

  // Expanded match details
  const [expandedMatch, setExpandedMatch] = useState<number | null>(null);

  // Finalize state
  const [finalizingDay, setFinalizingDay] = useState(false);

  // Recent sessions quick-select
  const [recentSessions, setRecentSessions] = useState<{ id: number; operator: string; status: number; matchCount: number; dateKey: number; derived: DerivedStatus }[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  const inputCls = 'w-full mt-1 rounded-lg bg-surface-tertiary border border-border px-3 py-2 text-sm font-mono text-txt-primary focus:ring-2 focus:ring-accent/50 focus:border-accent outline-none transition-all';
  const btnCls = 'px-4 py-2.5 rounded-lg bg-accent text-black font-semibold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all';

  const getReadContract = useCallback(() => {
    if (!provider || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider);
  }, [provider, sessionManagerAddress]);

  const getHubReadContract = useCallback(() => {
    if (!provider || !hubAddress) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
  }, [provider, hubAddress]);

  const getWriteContract = useCallback(() => {
    if (!signer || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, signer);
  }, [signer, sessionManagerAddress]);

  // Format seconds as HH:MM:SS
  const fmtTimer = (diff: number) => {
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  // Format timestamp
  const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString();
  const fmtDateTime = (ts: number) => new Date(ts * 1000).toLocaleString();

  // Truncate address
  const truncAddr = (a: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';

  // Load recent sessions with derived status from timing info
  const loadRecentSessions = useCallback(async () => {
    const c = getReadContract();
    if (!c) return;
    setLoadingRecent(true);
    try {
      const nextId = await c.nextSessionId();
      const total = nextId?.toNumber?.() ?? Number(nextId) ?? 0;
      const items: typeof recentSessions = [];
      // Cache timing per dateKey to avoid duplicate calls
      const timingCache: Record<number, DayTiming | null> = {};

      const start = Math.max(1, total - 20);
      for (let i = total - 1; i >= start; i--) {
        try {
          const s = await c.sessions(i);
          if (!s.exists) continue;
          const dk = s.dateKey?.toNumber?.() ?? 0;
          const contractStatus = s.status ?? 0;

          // Fetch timing once per dateKey
          if (dk && !(dk in timingCache)) {
            try {
              const info = await c.getDayTimingInfo(dk);
              timingCache[dk] = {
                gameWindowStart: info.gameWindowStart?.toNumber?.() ?? Number(info.gameWindowStart),
                gameWindowEnd: info.gameWindowEnd?.toNumber?.() ?? Number(info.gameWindowEnd),
                finalizationDeadline: info.finalizationDeadline?.toNumber?.() ?? Number(info.finalizationDeadline),
                isGameWindowOpen: info.isGameWindowOpen,
                isGracePeriodOpen: info.isGracePeriodOpen,
                isFinalized: info.isFinalized,
              };
            } catch { timingCache[dk] = null; }
          }

          const derived = deriveDayStatus(contractStatus, timingCache[dk] ?? null);

          items.push({
            id: s.id?.toNumber?.() ?? i,
            operator: s.operator,
            status: contractStatus,
            matchCount: s.matchCount?.toNumber?.() ?? 0,
            dateKey: dk,
            derived,
          });
        } catch { /* skip */ }
      }
      setRecentSessions(items);
    } catch { /* silent */ }
    setLoadingRecent(false);
  }, [getReadContract]);

  useEffect(() => { loadRecentSessions(); }, [loadRecentSessions]);

  // Load session + matches
  const loadSession = useCallback(async (sid?: number) => {
    const c = getReadContract();
    const id = sid ?? parseInt(sessionIdInput);
    if (!c || isNaN(id) || id < 1) return;
    setLoading(true);
    setSession(null);
    setMatches([]);
    setDayTiming(null);
    setSettlingMatchId(null);
    setExpandedMatch(null);
    setAutoRelease(false);
    try {
      // Load session
      const s = await c.sessions(id);
      if (!s.exists) {
        setTxStatus({ status: 'error', error: `Session #${id} not found.` });
        setLoading(false);
        return;
      }
      const sessionData: SessionInfo = {
        id: s.id?.toNumber?.() ?? id,
        dateKey: s.dateKey?.toNumber?.() ?? 0,
        operator: s.operator,
        startTime: s.startTime?.toNumber?.() ?? 0,
        endTime: s.endTime?.toNumber?.() ?? 0,
        matchCount: s.matchCount?.toNumber?.() ?? 0,
        totalEntryCollected: ethers.utils.formatEther(s.totalEntryCollected ?? 0),
        status: s.status ?? 0,
      };
      setSession(sessionData);
      if (sid !== undefined) setSessionIdInput(String(id));

      // Load operator's auto-release setting — lives on the Hub, checked live at finalize time
      try {
        const hub = getHubReadContract();
        const auto = hub ? await hub.operatorAutoReleaseDefault(sessionData.operator) : false;
        setAutoRelease(!!auto);
      } catch {
        setAutoRelease(false);
      }

      // Load timing info
      try {
        const info = await c.getDayTimingInfo(sessionData.dateKey);
        setDayTiming({
          gameWindowStart: info.gameWindowStart?.toNumber?.() ?? Number(info.gameWindowStart),
          gameWindowEnd: info.gameWindowEnd?.toNumber?.() ?? Number(info.gameWindowEnd),
          finalizationDeadline: info.finalizationDeadline?.toNumber?.() ?? Number(info.finalizationDeadline),
          isGameWindowOpen: info.isGameWindowOpen,
          isGracePeriodOpen: info.isGracePeriodOpen,
          isFinalized: info.isFinalized,
        });
      } catch { setDayTiming(null); }

      // Load matches
      const matchIds: number[] = (await c.getMatchIds(id)).map((x: any) => x?.toNumber?.() ?? Number(x));

      // Build reward type cache
      const rtCache: Record<number, { name: string; fixedPoints: boolean; placementBps: number[]; placementDeltas: string[] }> = {};
      try {
        const raw = localStorage.getItem(networkStorageKey('dg_cached_reward_types', chainId));
        if (raw) {
          for (const rt of JSON.parse(raw)) {
            if (rt.id && rt.name) rtCache[rt.id] = { name: rt.name, fixedPoints: !!rt.fixedPoints, placementBps: rt.placementBps ?? [], placementDeltas: rt.placementDeltas ?? [] };
          }
        }
      } catch {}

      const items: MatchInfo[] = [];
      for (const mid of matchIds) {
        try {
          const m: any = await c.getMatch(id, mid);
          const players: string[] = await c.getMatchPlayers(id, mid);
          let rankings: string[] = [];
          try { rankings = await c.getMatchRankings(id, mid); } catch {}

          const rtId = m.rewardTypeId?.toNumber?.() ?? Number(m.rewardTypeId);
          if (!rtCache[rtId]) {
            try {
              const rt = await c.getRewardType(rtId);
              if (rt.fixedPoints) {
                const deltas = await c.getRewardTypePlacementDeltas(rtId);
                rtCache[rtId] = { name: rt.name ?? `Type #${rtId}`, fixedPoints: true, placementBps: [], placementDeltas: deltas.map((d: any) => ethers.utils.formatEther(d)) };
              } else {
                const bps = await c.getRewardTypePlacementBps(rtId);
                rtCache[rtId] = { name: rt.name ?? `Type #${rtId}`, fixedPoints: false, placementBps: bps.map((x: any) => x?.toNumber?.() ?? Number(x)), placementDeltas: [] };
              }
            } catch { rtCache[rtId] = { name: `Type #${rtId}`, fixedPoints: false, placementBps: [], placementDeltas: [] }; }
          }

          items.push({
            id: m.id?.toNumber?.() ?? mid,
            rewardTypeId: rtId,
            matchRef: m.matchRef ?? '',
            playerCount: m.playerCount?.toNumber?.() ?? 0,
            entryFee: ethers.utils.formatEther(m.entryFee ?? 0),
            matchValue: ethers.utils.formatEther(m.matchValue ?? 0),
            winner: m.winner ?? ethers.constants.AddressZero,
            status: m.status ?? 0,
            settled: m.settled ?? false,
            players,
            rankings,
            rewardTypeName: rtCache[rtId]?.name ?? `Type #${rtId}`,
            fixedPoints: !!rtCache[rtId]?.fixedPoints,
            placementBps: rtCache[rtId]?.placementBps ?? [],
            placementDeltas: rtCache[rtId]?.placementDeltas ?? [],
          });
        } catch { /* skip */ }
      }
      setMatches(items);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getReadContract, getHubReadContract, sessionIdInput, address, signer, sessionManagerAddress]);

  // Countdown timer
  useEffect(() => {
    if (!dayTiming) { setCountdown(''); return; }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      if (dayTiming.isFinalized) { setCountdown('Finalized ✔'); return; }
      if (now < dayTiming.gameWindowEnd) {
        setCountdown(`Game window ends in ${fmtTimer(dayTiming.gameWindowEnd - now)}`);
      } else if (now <= dayTiming.finalizationDeadline) {
        setCountdown(`Grace period ends in ${fmtTimer(dayTiming.finalizationDeadline - now)}`);
      } else {
        setCountdown('Session expired');
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [dayTiming]);

  // Finalize daily points
  const handleFinalize = async () => {
    const contract = getWriteContract();
    if (!contract || !session) return;
    setFinalizingDay(true);
    setTxStatus({ status: 'pending', message: `Finalizing points for dateKey ${session.dateKey}...` });
    try {
      const tx = await sendWithGasBuffer(contract, 'finalizeDailyPoints', [session.dateKey]);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Operator finalized for dateKey ${session.dateKey} ✔` });
      // Reload session to refresh timing/status
      loadSession(session.id);
      loadRecentSessions();
    } catch (e: any) {
      let decoded = decodeError(e);
      let hint = '';
      if (decoded.includes('GameWindowStillOpen')) hint = '\n\nGame window is still open — cannot finalize yet.';
      if (decoded.includes('OperatorAlreadyFinalized')) hint = '\n\nThis operator has already been finalized for this day.';
      if (decoded.includes('DayAlreadyFinalized')) hint = '\n\nAll operators for this day are already finalized.';
      if (decoded.includes('UpdaterNotLinkedToOperator')) hint = '\n\nYour wallet is not linked to any operator. Register as an updater for this operator first.';
      if (decoded.includes('SplitterNotSet')) hint = '\n\nOperator splitter address not configured. Set it in the Admin tab first.';
      setTxStatus({ status: 'error', error: decoded + hint });
    } finally {
      setFinalizingDay(false);
    }
  };

  // Settle match
  const handleSettle = async (matchId: number) => {
    const contract = getWriteContract();
    if (!contract || !session) return;
    const validRanked = settleRanked.filter(r => r.trim());
    const match = matches.find(m => m.id === matchId);
    if (!match) return;

    if (validRanked.length !== match.playerCount) {
      setTxStatus({ status: 'error', error: `All ${match.playerCount} players must be ranked. You have ${validRanked.length}.` });
      return;
    }
    // Validate
    for (let i = 0; i < validRanked.length; i++) {
      if (!ethers.utils.isAddress(validRanked[i])) {
        setTxStatus({ status: 'error', error: `Position #${i + 1} is not a valid address.` });
        return;
      }
    }
    const lower = validRanked.map(a => a.toLowerCase());
    const seen = new Set<string>();
    for (let i = 0; i < lower.length; i++) {
      if (seen.has(lower[i])) {
        setTxStatus({ status: 'error', error: `Duplicate at positions #${lower.indexOf(lower[i]) + 1} and #${i + 1}.` });
        return;
      }
      seen.add(lower[i]);
    }

    setTxStatus({ status: 'pending', message: `Settling Match #${matchId}...` });
    try {
      const tx = await contract.settleMatch(session.id, matchId, validRanked);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Match #${matchId} settled ✔` });
      setSettlingMatchId(null);
      setSettleRanked([]);
      // Reload
      loadSession(session.id);
    } catch (e: any) {
      let decoded = decodeError(e);
      let hint = '';
      if (decoded.includes('GracePeriodExpired')) hint = '\n\nGrace period has expired — settling no longer possible.';
      if (decoded.includes('DayAlreadyFinalized')) hint = '\n\nDay already finalized.';
      setTxStatus({ status: 'error', error: decoded + hint });
    }
  };

  // Start settling a match — pre-fill empty ranked slots from players
  const startSettle = (match: MatchInfo) => {
    setSettlingMatchId(match.id);
    setSettleRanked(match.players.map(() => ''));
    setExpandedMatch(match.id);
  };

  // Move ranked player up/down
  const moveRanked = (from: number, to: number) => {
    if (to < 0 || to >= settleRanked.length) return;
    setSettleRanked(prev => {
      const arr = [...prev];
      [arr[from], arr[to]] = [arr[to], arr[from]];
      return arr;
    });
  };

  // Match status badge (uses raw contract status)
  const matchStatusBadge = (status: number) => {
    const label = MATCH_STATUS_LABELS[status] ?? 'UNKNOWN';
    const colors: Record<string, string> = {
      CREATED: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      SETTLED: 'bg-green-500/20 text-green-400 border-green-500/30',
      CANCELLED: 'bg-red-500/20 text-red-400 border-red-500/30',
    };
    return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${colors[label] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>{label}</span>;
  };

  // Derived session status badge (uses timing info)
  const derivedSessionBadge = (derived: DerivedStatus) => {
    return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${DERIVED_STATUS_COLORS[derived]}`}>{derived}</span>;
  };

  // Current selected session's derived status
  const sessionDerived = session ? deriveDayStatus(session.status, dayTiming) : null;

  const unsettledCount = matches.filter(m => m.status === 0).length;
  const settledCount = matches.filter(m => m.status === 1).length;
  const cancelledCount = matches.filter(m => m.status === 2).length;

  return (
    <div className="space-y-4">
      {/* Session Selector */}
      <Card title="Session Explorer" icon={<Search className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">Select a session to view all matches and settle them.</p>

        <div className="flex gap-2 mb-3">
          <input
            type="number"
            value={sessionIdInput}
            onChange={e => setSessionIdInput(e.target.value)}
            placeholder="Session ID"
            min="1"
            className={`${inputCls} !mt-0 flex-1`}
            onKeyDown={e => e.key === 'Enter' && loadSession()}
          />
          <button onClick={() => loadSession()} disabled={!isConnected || !sessionIdInput || loading} className={btnCls}>
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Load'}
          </button>
        </div>

        {/* Recent sessions quick-select */}
        {recentSessions.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-txt-secondary font-medium">Recent Sessions</span>
              <button onClick={loadRecentSessions} disabled={loadingRecent} className="text-[10px] text-accent hover:underline flex items-center gap-1">
                <RefreshCw className={`w-3 h-3 ${loadingRecent ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {recentSessions.slice(0, 12).map(rs => (
                <button
                  key={rs.id}
                  onClick={() => { setSessionIdInput(String(rs.id)); loadSession(rs.id); }}
                  className={`text-[10px] px-2.5 py-1 rounded-lg border transition-all ${
                    session?.id === rs.id
                      ? 'bg-accent/20 border-accent text-accent'
                      : 'bg-surface-tertiary border-border text-txt-secondary hover:border-accent/50 hover:text-txt-primary'
                  }`}
                >
                  <span className="font-bold">#{rs.id}</span>
                  <span className="ml-1 opacity-70">{truncAddr(rs.operator)}</span>
                  <span className="ml-1">{rs.matchCount}m</span>
                  <span className="ml-1">{derivedSessionBadge(rs.derived)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Session Info */}
      {session && (
        <Card
          title={<span className="flex items-center gap-2">Session #{session.id} <span className="ml-1">{sessionDerived && derivedSessionBadge(sessionDerived)}</span> <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${autoRelease ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'}`}>{autoRelease ? 'AUTO-RELEASE' : 'MANUAL RELEASE'}</span></span>}
          icon={<Hash className="w-5 h-5 text-accent" />}
        >
          {/* Timing countdown */}
          {countdown && (
            <div className={`border rounded-lg px-3 py-2 mb-3 text-xs flex items-center gap-1.5 ${
              dayTiming?.isGameWindowOpen
                ? 'bg-blue-500/10 border-blue-500/40 text-blue-300'
                : dayTiming?.isGracePeriodOpen
                  ? 'bg-yellow-500/10 border-yellow-500/40 text-yellow-400'
                  : dayTiming?.isFinalized
                    ? 'bg-green-500/10 border-green-500/40 text-green-400'
                    : 'bg-red-500/10 border-red-500/40 text-red-400'
            }`}>
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono font-semibold">{countdown}</span>
            </div>
          )}

          {/* Session details grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <div className="text-[10px] text-txt-secondary">Operator</div>
              <div className="text-xs font-mono text-txt-primary truncate" title={session.operator}>{truncAddr(session.operator)}</div>
            </div>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <div className="text-[10px] text-txt-secondary">Date Key</div>
              <div className="text-xs font-mono text-accent">{session.dateKey}</div>
            </div>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <div className="text-[10px] text-txt-secondary">Matches</div>
              <div className="text-xs font-mono text-txt-primary">{session.matchCount}</div>
            </div>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <div className="text-[10px] text-txt-secondary">Window</div>
              <div className="text-[11px] font-mono text-txt-primary">{fmtDateTime(session.startTime)} — {fmtTime(session.endTime)}</div>
            </div>
            <div className="bg-surface-tertiary rounded-lg px-3 py-2">
              <div className="text-[10px] text-txt-secondary">Total Collected</div>
              <div className="text-xs font-mono text-accent">{parseFloat(session.totalEntryCollected).toFixed(2)} pts</div>
            </div>
            {dayTiming && (
              <div className="bg-surface-tertiary rounded-lg px-3 py-2">
                <div className="text-[10px] text-txt-secondary">Grace Deadline</div>
                <div className="text-[11px] font-mono text-txt-primary">{fmtTime(dayTiming.finalizationDeadline)}</div>
              </div>
            )}
          </div>

          {/* Settle availability indicator */}
          {session.operator.toLowerCase() === address?.toLowerCase() && unsettledCount > 0 && dayTiming && (dayTiming.isGameWindowOpen || dayTiming.isGracePeriodOpen) && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 mb-3 text-xs text-green-400 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>You can settle unsettled matches in this session{dayTiming.isGracePeriodOpen ? ' (grace period active)' : ''}.</span>
            </div>
          )}
          {session.operator.toLowerCase() === address?.toLowerCase() && unsettledCount > 0 && dayTiming && !dayTiming.isGameWindowOpen && !dayTiming.isGracePeriodOpen && !dayTiming.isFinalized && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Grace period has expired for this session — settling is no longer possible.</span>
            </div>
          )}
          {dayTiming?.isFinalized && unsettledCount > 0 && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Day has been finalized — settling is no longer possible.</span>
            </div>
          )}

          {/* Match summary counts */}
          {matches.length > 0 && (
            <div className="flex gap-3 text-[11px] mb-2">
              <span className="text-txt-secondary">Total: <span className="text-txt-primary font-bold">{matches.length}</span></span>
              {unsettledCount > 0 && <span className="text-blue-400">Unsettled: <span className="font-bold">{unsettledCount}</span></span>}
              {settledCount > 0 && <span className="text-green-400">Settled: <span className="font-bold">{settledCount}</span></span>}
              {cancelledCount > 0 && <span className="text-red-400">Cancelled: <span className="font-bold">{cancelledCount}</span></span>}
            </div>
          )}

          {/* Finalize Daily Points button */}
          {dayTiming && !dayTiming.isFinalized && !dayTiming.isGameWindowOpen && (
            <div className="border-t border-border/50 pt-3 mt-3">
              <div className="flex items-start gap-2 mb-2">
                <Lock className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                <div className="text-xs text-txt-secondary">
                  <p><strong className="text-txt-primary">Finalize Daily Points</strong> for dateKey <span className="text-accent font-bold">{session.dateKey}</span>.</p>
                  <p className="text-[10px] mt-0.5">This locks all points, transfers collected funds to operators&apos; splitters, and enables PR boost claims. Requires <code className="text-accent">PLATFORM_UPDATER_ROLE</code>.</p>
                  <p className="text-[10px] mt-0.5">
                    {autoRelease
                      ? <span className="text-green-400">Auto-release is ON for this operator — finalizing will also immediately release the splitter&apos;s funds to payees in the same transaction.</span>
                      : <span className="text-yellow-400">Auto-release is OFF for this operator — finalizing will transfer funds to the splitter; release them manually from the Splitter tab afterward.</span>
                    }
                  </p>
                </div>
              </div>
              {unsettledCount > 0 && (
                <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-lg px-3 py-2 mb-2 text-xs text-yellow-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{unsettledCount} unsettled match{unsettledCount !== 1 ? 'es' : ''} remaining — settle or cancel all matches before finalizing.</span>
                </div>
              )}
              <button
                onClick={handleFinalize}
                disabled={!isConnected || finalizingDay || unsettledCount > 0}
                className="w-full px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2"
              >
                {finalizingDay ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                {finalizingDay ? 'Finalizing...' : unsettledCount > 0 ? `${unsettledCount} Unsettled — Cannot Finalize` : `Finalize DateKey ${session.dateKey}`}
              </button>
            </div>
          )}
          {dayTiming?.isFinalized && (
            <div className="border-t border-border/50 pt-3 mt-3">
              <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg px-3 py-2 text-xs text-purple-400 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span>DateKey {session.dateKey} has been finalized ✔ — points locked, funds transferred, PR boost claims enabled.</span>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Matches List */}
      {session && (
        <Card
          title={<span className="flex items-center gap-2">Matches ({matches.length}) <button onClick={() => loadSession(session.id)} className="text-accent hover:underline text-[10px] font-normal flex items-center gap-0.5"><RefreshCw className="w-3 h-3" /> Refresh</button></span>}
          icon={<Trophy className="w-5 h-5 text-accent" />}
        >
          {loading ? (
            <div className="flex items-center justify-center py-6 gap-2 text-xs text-txt-secondary">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading matches…
            </div>
          ) : matches.length === 0 ? (
            <div className="text-center py-6 text-xs text-txt-secondary">No matches found for this session.</div>
          ) : (
            <div className="space-y-2">
              {matches.map(m => {
                const isExpanded = expandedMatch === m.id;
                const isSettling = settlingMatchId === m.id;
                const canSettle = m.status === 0 && isConnected && session.operator.toLowerCase() === address?.toLowerCase() && !(dayTiming && !dayTiming.isGameWindowOpen && !dayTiming.isGracePeriodOpen && !dayTiming.isFinalized);

                return (
                  <div key={m.id} className={`bg-surface-tertiary rounded-lg border transition-all ${
                    m.status === 0 ? 'border-blue-500/30' : m.status === 1 ? 'border-green-500/20' : 'border-red-500/20'
                  }`}>
                    {/* Match header row */}
                    <div
                      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-tertiary/70"
                      onClick={() => setExpandedMatch(isExpanded ? null : m.id)}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-xs font-bold text-accent">#{m.id}</span>
                        <span className="text-[11px] text-txt-secondary truncate" title={m.matchRef}>{m.matchRef}</span>
                        {matchStatusBadge(m.status)}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-txt-secondary shrink-0">
                        <span title="Reward Type">🎮 {m.rewardTypeName}</span>
                        <span title="Players">👥 {m.playerCount}</span>
                        <span title="Match Value" className="text-accent">{parseFloat(m.matchValue).toFixed(2)} pts</span>
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </div>
                    </div>

                    {/* Expanded match details */}
                    {isExpanded && (
                      <div className="px-3 pb-3 border-t border-border/50">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 mb-3 text-[11px]">
                          <div><span className="text-txt-secondary">Entry Fee:</span> <span className="text-txt-primary">{m.entryFee} pts</span></div>
                          <div><span className="text-txt-secondary">Match Value:</span> <span className="text-accent font-bold">{m.matchValue} pts</span></div>
                          <div><span className="text-txt-secondary">Reward Type:</span> <span className="text-txt-primary">#{m.rewardTypeId} {m.rewardTypeName}</span></div>
                          <div><span className="text-txt-secondary">Winner:</span> <span className="font-mono text-txt-primary">{m.winner !== ethers.constants.AddressZero ? truncAddr(m.winner) : '—'}</span></div>
                        </div>

                        {/* Players / Rankings */}
                        <div className="mb-3">
                          <div className="text-[10px] text-txt-secondary font-semibold mb-1">Players{m.settled ? ' & Rankings' : ''}</div>
                          <div className="space-y-1">
                            {(() => {
                              // Build ranked map
                              const rankMap: Record<string, number> = {};
                              m.rankings.forEach((addr, idx) => { rankMap[addr.toLowerCase()] = idx + 1; });

                              const sorted = [...m.players].sort((a, b) => {
                                const ra = rankMap[a.toLowerCase()] ?? 999;
                                const rb = rankMap[b.toLowerCase()] ?? 999;
                                return ra - rb;
                              });

                              return sorted.map((p, idx) => {
                                const rank = rankMap[p.toLowerCase()] ?? 0;
                                let reward = '0';
                                if (rank > 0) {
                                  if (m.fixedPoints) {
                                    if (rank - 1 < m.placementDeltas.length) reward = m.placementDeltas[rank - 1];
                                  } else if (rank - 1 < m.placementBps.length) {
                                    reward = (parseFloat(m.matchValue) * m.placementBps[rank - 1] / 10000).toFixed(4);
                                  }
                                }
                                return (
                                  <div key={idx} className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded ${
                                    rank === 1 ? 'bg-yellow-500/10' : rank === 2 ? 'bg-gray-400/10' : rank === 3 ? 'bg-orange-500/10' : 'bg-surface/50'
                                  }`}>
                                    {rank > 0 ? (
                                      <span className={`w-5 text-center font-bold ${
                                        rank === 1 ? 'text-yellow-400' : rank === 2 ? 'text-gray-300' : rank === 3 ? 'text-orange-400' : 'text-txt-secondary'
                                      }`}>{rank}</span>
                                    ) : (
                                      <span className="w-5 text-center text-txt-secondary">—</span>
                                    )}
                                    <span className="font-mono text-txt-primary flex-1 truncate">{p}</span>
                                    {rank > 0 && parseFloat(reward) > 0 && (
                                      <span className="text-accent font-semibold">+{reward} pts</span>
                                    )}
                                    {rank > 0 && parseFloat(reward) < 0 && (
                                      <span className="text-red-400 font-semibold">{reward} pts</span>
                                    )}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        </div>

                        {/* Settle UI */}
                        {canSettle && !isSettling && (
                          <button onClick={() => startSettle(m)} className={`w-full ${btnCls} flex items-center justify-center gap-2`}>
                            <Medal className="w-4 h-4" /> Settle This Match
                          </button>
                        )}

                        {isSettling && (
                          <div className="mt-2 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-accent">Rank all {m.playerCount} players (1st → last)</span>
                              <button onClick={() => { setSettlingMatchId(null); setSettleRanked([]); }} className="text-[10px] text-red-400 hover:underline">Cancel</button>
                            </div>

                            {/* Ranked slots with dropdowns */}
                            <div className="space-y-1.5">
                              {settleRanked.map((addr, idx) => {
                                const usedAddrs = new Set(settleRanked.filter((a, i) => i !== idx && a).map(a => a.toLowerCase()));
                                const available = m.players.filter(p => !usedAddrs.has(p.toLowerCase()));
                                const payout = m.fixedPoints
                                  ? (idx < m.placementDeltas.length ? m.placementDeltas[idx] : '0')
                                  : (idx < m.placementBps.length ? (parseFloat(m.matchValue) * m.placementBps[idx] / 10000).toFixed(4) : '0');
                                return (
                                  <div key={idx} className="flex items-center gap-2">
                                    <div className="flex items-center gap-1 shrink-0">
                                      <button onClick={() => moveRanked(idx, idx - 1)} disabled={idx === 0} className="p-0.5 text-txt-secondary hover:text-accent disabled:opacity-20"><ChevronUp className="w-3 h-3" /></button>
                                      <button onClick={() => moveRanked(idx, idx + 1)} disabled={idx === settleRanked.length - 1} className="p-0.5 text-txt-secondary hover:text-accent disabled:opacity-20"><ChevronDown className="w-3 h-3" /></button>
                                    </div>
                                    <span className={`w-6 text-center text-xs font-bold ${
                                      idx === 0 ? 'text-yellow-400' : idx === 1 ? 'text-gray-300' : idx === 2 ? 'text-orange-400' : 'text-txt-secondary'
                                    }`}>{idx + 1}</span>
                                    <select
                                      value={addr}
                                      onChange={e => setSettleRanked(prev => prev.map((a, i) => i === idx ? e.target.value : a))}
                                      className={`${inputCls} !mt-0 flex-1 text-[11px]`}
                                    >
                                      <option value="">— Select Player —</option>
                                      {addr && <option value={addr}>{truncAddr(addr)}</option>}
                                      {available.filter(a => a.toLowerCase() !== addr.toLowerCase()).map(p => (
                                        <option key={p} value={p}>{truncAddr(p)}</option>
                                      ))}
                                    </select>
                                    {parseFloat(payout) > 0 && (
                                      <span className="text-[10px] text-accent font-semibold shrink-0">+{payout}</span>
                                    )}
                                    {parseFloat(payout) < 0 && (
                                      <span className="text-[10px] text-red-400 font-semibold shrink-0">{payout}</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Reward preview */}
                            {settleRanked.every(a => a) && (
                              <div className="bg-surface/50 rounded-lg px-3 py-2 space-y-1">
                                <div className="text-[10px] text-txt-secondary font-semibold">Reward Preview{m.fixedPoints ? ' (Fixed Points)' : ''}</div>
                                {settleRanked.map((addr, idx) => {
                                  const payoutStr = m.fixedPoints
                                    ? (idx < m.placementDeltas.length ? m.placementDeltas[idx] : '0')
                                    : (idx < m.placementBps.length ? (parseFloat(m.matchValue) * m.placementBps[idx] / 10000).toFixed(4) : '0');
                                  const payout = parseFloat(payoutStr) || 0;
                                  return (
                                    <div key={idx} className="flex items-center justify-between text-[11px]">
                                      <span><span className="font-bold text-accent">#{idx + 1}</span> <span className="font-mono">{truncAddr(addr)}</span></span>
                                      <span className={payout > 0 ? 'text-green-400 font-semibold' : payout < 0 ? 'text-red-400 font-semibold' : 'text-txt-secondary'}>{payout > 0 ? `+${payoutStr} pts` : payout < 0 ? `${payoutStr} pts` : '0 pts'}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            <button
                              onClick={() => handleSettle(m.id)}
                              disabled={!settleRanked.every(a => a.trim())}
                              className={`w-full ${btnCls} flex items-center justify-center gap-2`}
                            >
                              <Check className="w-4 h-4" /> Confirm Settlement
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}
