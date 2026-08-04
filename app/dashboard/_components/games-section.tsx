'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { SESSION_STATUS_LABELS, getExplorerAddressUrl } from '@/lib/contracts/config';
import { decodeError } from '@/lib/contracts/error-decoder';
import { sendWithGasBuffer } from '@/lib/contracts/gas';
import { Gamepad2, Plus, RefreshCw, Clock, Hash, XCircle, Zap, Users, ChevronDown, ChevronUp, ListChecks, CheckCircle, Check, X, Split } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';

interface SessionData {
  sessionId: number;
  dateKey: number;
  operator: string;
  startTime: number;
  endTime: number;
  matchCount: number;
  totalEntryCollected: string;
  status: number;
  exists: boolean;
}

interface PlayerInfo {
  address: string;
  points: string;
  initialized: boolean;
  prBoost: boolean;
}

// How many sessions to fetch per page. Session IDs are sequential per-operator-instance
// and never pruned, so an instance with a long history (e.g. from a short test
// sessionDuration) can accumulate thousands of them — fetching every one sequentially
// on load made this tab effectively hang (~200ms/RPC-call x thousands of sessions).
// Loading newest-first in small parallel batches keeps the initial load fast regardless
// of history size; "Load More" pages further back on demand.
const SESSIONS_PAGE_SIZE = 25;

export default function SessionsSection() {
  const { signer, provider, isConnected, address, sessionManagerAddress, chainId } = useWeb3();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalSessionCount, setTotalSessionCount] = useState(0);
  const [oldestLoadedId, setOldestLoadedId] = useState<number | null>(null);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });
  const [mySessionId, setMySessionId] = useState<number | null>(null);
  const [scheduleInfo, setScheduleInfo] = useState<{ offset: number; duration: number } | null>(null);

  // On-chain operator splitter address (fetched from OperatorProfile)
  const [operatorSplitter, setOperatorSplitter] = useState<string>('');

  // Players for a session
  const [expandedSessionId, setExpandedSessionId] = useState<number | null>(null);
  const [sessionPlayers, setSessionPlayers] = useState<Record<number, PlayerInfo[]>>({});
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  // Batch update points
  const [batchSessionId, setBatchSessionId] = useState('');
  const [batchUsers, setBatchUsers] = useState('');
  const [batchPoints, setBatchPoints] = useState('');

  // Finalize — only own session
  const [finalizeSessionId, setFinalizeSessionId] = useState('');

  // Day timing for finalization window
  interface DayTiming { gameWindowStart: number; gameWindowEnd: number; finalizationDeadline: number; isGameWindowOpen: boolean; isGracePeriodOpen: boolean; isFinalized: boolean; }
  const [finalizeTiming, setFinalizeTiming] = useState<DayTiming | null>(null);
  const [finalizeCountdown, setFinalizeCountdown] = useState('');

  const todayDateKey = Math.floor(Date.now() / 1000 / 86400);

  const getReadContract = useCallback(() => {
    if (!provider || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, provider ?? undefined);
  }, [provider, sessionManagerAddress]);

  const getWriteContract = useCallback(() => {
    if (!signer || !sessionManagerAddress) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, signer);
  }, [signer, sessionManagerAddress]);

  // Fetch a contiguous range of session IDs in parallel (order of `ids` is preserved
  // in the result, so callers pass IDs newest-first to get newest-first output).
  const fetchSessionRange = useCallback(async (contract: ethers.Contract, ids: number[]): Promise<SessionData[]> => {
    const results = await Promise.all(ids.map(async i => {
      try {
        const s = await contract.sessions(i);
        const item: SessionData = {
          sessionId: s.id?.toNumber?.() ?? i,
          dateKey: s.dateKey?.toNumber?.() ?? 0,
          operator: s.operator ?? '',
          startTime: s.startTime?.toNumber?.() ?? 0,
          endTime: s.endTime?.toNumber?.() ?? 0,
          matchCount: s.matchCount?.toNumber?.() ?? 0,
          totalEntryCollected: ethers.utils.formatEther(s.totalEntryCollected ?? 0),
          status: s.status ?? 0,
          exists: s.exists ?? false,
        };
        return item;
      } catch {
        return null;
      }
    }));
    return results.filter((s): s is SessionData => s !== null);
  }, []);

  const fetchSessions = useCallback(async () => {
    const contract = getReadContract();
    if (!contract) return;
    setLoading(true);
    try {
      const nextId = await contract.nextSessionId();
      const total = nextId?.toNumber?.() ?? Number(nextId) ?? 0;
      const highestId = total - 1;
      setTotalSessionCount(Math.max(0, highestId));

      if (highestId >= 1) {
        const lowestId = Math.max(1, highestId - SESSIONS_PAGE_SIZE + 1);
        const ids: number[] = [];
        for (let i = highestId; i >= lowestId; i--) ids.push(i);
        const items = await fetchSessionRange(contract, ids);
        setSessions(items);
        setOldestLoadedId(lowestId);
        setHasMoreSessions(lowestId > 1);
      } else {
        setSessions([]);
        setOldestLoadedId(null);
        setHasMoreSessions(false);
      }

      // Fetch schedule
      try {
        const schedule = await contract.getSessionSchedule();
        setScheduleInfo({ offset: schedule[0]?.toNumber?.() ?? 0, duration: schedule[1]?.toNumber?.() ?? 0 });
      } catch { /* ignore */ }

      // Fetch my current session ID
      if (address) {
        try {
          const writeC = getWriteContract();
          if (writeC) {
            const myId = await writeC.getMyCurrentSessionId();
            const n = myId?.toNumber?.() ?? Number(myId) ?? 0;
            setMySessionId(n > 0 ? n : null);
          }
        } catch { setMySessionId(null); }
      }
    } catch (e: any) {
      console.error('Fetch sessions error:', e);
    } finally {
      setLoading(false);
    }
  }, [getReadContract, getWriteContract, address, fetchSessionRange]);

  const loadMoreSessions = useCallback(async () => {
    const contract = getReadContract();
    if (!contract || oldestLoadedId === null || oldestLoadedId <= 1) return;
    setLoadingMore(true);
    try {
      const highestId = oldestLoadedId - 1;
      const lowestId = Math.max(1, highestId - SESSIONS_PAGE_SIZE + 1);
      const ids: number[] = [];
      for (let i = highestId; i >= lowestId; i--) ids.push(i);
      const items = await fetchSessionRange(contract, ids);
      setSessions(prev => [...prev, ...items]);
      setOldestLoadedId(lowestId);
      setHasMoreSessions(lowestId > 1);
    } catch (e: any) {
      console.error('Load more sessions error:', e);
    } finally {
      setLoadingMore(false);
    }
  }, [getReadContract, oldestLoadedId, fetchSessionRange]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Fetch operator's on-chain splitter address
  useEffect(() => {
    const load = async () => {
      const c = getReadContract();
      if (!c || !address) { setOperatorSplitter(''); return; }
      try {
        const profile = await c.getOperatorProfile(address);
        const sp = profile.splitterAddress || '';
        setOperatorSplitter(sp && sp !== ethers.constants.AddressZero ? sp : '');
      } catch {
        setOperatorSplitter('');
      }
    };
    load();
  }, [getReadContract, address]);

  const exec = async (label: string, fn: () => Promise<any>) => {
    setTxStatus({ status: 'pending', message: `${label}...` });
    try {
      const tx = await fn();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${label} \u2714` });
      fetchSessions();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleCreateTodaySession = () => exec('Create Today Session', () => sendWithGasBuffer(getWriteContract()!, 'createTodaySession', []));
  const handleSyncStatus = () => exec('Sync Session Status', () => getWriteContract()!.syncMyTodaySessionStatus());
  const handleCancel = () => exec('Cancel Today Session', () => getWriteContract()!.cancelMyTodaySession());

  // Fetch all players for a session by collecting from all matches
  const fetchPlayersForSession = useCallback(async (sessionId: number, dateKey: number) => {
    const contract = getReadContract();
    if (!contract) return;
    setLoadingPlayers(true);
    try {
      const matchIds: number[] = (await contract.getMatchIds(sessionId)).map((x: any) => x?.toNumber?.() ?? Number(x));
      const uniquePlayers = new Set<string>();
      for (const mid of matchIds) {
        try {
          const players: string[] = await contract.getMatchPlayers(sessionId, mid);
          players.forEach(p => uniquePlayers.add(p));
        } catch { /* skip */ }
      }

      // Fetch points + PR boost for each player
      const playerInfos: PlayerInfo[] = [];
      for (const addr of uniquePlayers) {
        try {
          const [bal, init, prBoost] = await Promise.all([
            contract.getDailyUserPoints(dateKey, addr),
            contract.isDailyUserPointsInitialized(dateKey, addr),
            contract.isDailyPrBoostEnabled(dateKey, addr),
          ]);
          playerInfos.push({
            address: addr,
            points: ethers.utils.formatEther(bal),
            initialized: init,
            prBoost: prBoost,
          });
        } catch {
          playerInfos.push({ address: addr, points: '0', initialized: false, prBoost: false });
        }
      }

      // Sort by points descending
      playerInfos.sort((a, b) => parseFloat(b.points) - parseFloat(a.points));
      setSessionPlayers(prev => ({ ...prev, [sessionId]: playerInfos }));
    } catch (e: any) {
      console.error('Fetch players error:', e);
    } finally {
      setLoadingPlayers(false);
    }
  }, [getReadContract]);

  const toggleSessionExpand = (sessionId: number, dateKey: number) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
    } else {
      setExpandedSessionId(sessionId);
      if (!sessionPlayers[sessionId]) {
        fetchPlayersForSession(sessionId, dateKey);
      }
    }
  };

  // Batch Update Points
  const handleBatchUpdate = async () => {
    if (!sessionManagerAddress) {
      setTxStatus({ status: 'error', error: 'No SessionManager instance loaded — select one from the Hub tab first.' });
      return;
    }
    if (!signer) {
      setTxStatus({ status: 'error', error: 'Wallet not connected — click Connect Wallet and try again.' });
      return;
    }
    if (!batchSessionId || !batchUsers || !batchPoints) {
      setTxStatus({ status: 'error', error: 'Fill in Session ID, User Addresses, and New Points first.' });
      return;
    }
    const contract = getWriteContract();
    if (!contract) {
      setTxStatus({ status: 'error', error: 'Could not create a contract instance — check your wallet connection and try again.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Resolving dateKey for session...' });
    try {
      const readC = getReadContract()!;
      const sid = parseInt(batchSessionId);
      const dk = await readC.getSessionDateKey(sid);
      const dateKey = dk?.toNumber?.() ?? Number(dk);

      const users = batchUsers.split(',').map(s => s.trim()).filter(Boolean);
      let points: any[];
      try {
        points = batchPoints.split(',').map(s => ethers.utils.parseEther(s.trim()));
      } catch {
        setTxStatus({ status: 'error', error: 'New Points must be comma-separated numbers (e.g. "50, -10, 100").' });
        return;
      }
      if (users.length === 0) {
        setTxStatus({ status: 'error', error: 'Enter at least one user address.' });
        return;
      }
      if (users.length !== points.length) {
        setTxStatus({ status: 'error', error: `Users and points count must match (${users.length} users vs ${points.length} points).` });
        return;
      }
      for (const u of users) {
        if (!ethers.utils.isAddress(u)) {
          setTxStatus({ status: 'error', error: `"${u}" is not a valid Ethereum address.` });
          return;
        }
      }
      setTxStatus({ status: 'pending', message: `Updating ${users.length} points for dateKey ${dateKey}...` });
      const tx = await contract.batchUpdateDailyUserPoints(dateKey, users, points);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Updated ${users.length} user points for dateKey ${dateKey}` });
      // Refresh players if this session is expanded
      if (expandedSessionId === sid) {
        fetchPlayersForSession(sid, dateKey);
      }
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Fetch timing when finalizeSessionId changes
  useEffect(() => {
    const load = async () => {
      const c = getReadContract();
      if (!c || !finalizeSessionId) { setFinalizeTiming(null); return; }
      try {
        const sid = parseInt(finalizeSessionId);
        const s = await c.sessions(sid);
        if (!s.exists) { setFinalizeTiming(null); return; }
        const dk = s.dateKey?.toNumber?.() ?? Number(s.dateKey);
        const info = await c.getDayTimingInfo(dk);
        setFinalizeTiming({
          gameWindowStart: info.gameWindowStart?.toNumber?.() ?? Number(info.gameWindowStart),
          gameWindowEnd: info.gameWindowEnd?.toNumber?.() ?? Number(info.gameWindowEnd),
          finalizationDeadline: info.finalizationDeadline?.toNumber?.() ?? Number(info.finalizationDeadline),
          isGameWindowOpen: info.isGameWindowOpen,
          isGracePeriodOpen: info.isGracePeriodOpen,
          isFinalized: info.isFinalized,
        });
      } catch { setFinalizeTiming(null); }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getReadContract, finalizeSessionId]);

  // Format seconds as HH:MM:SS
  const fmtTimer = (diff: number) => {
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  // Finalization countdown timer
  useEffect(() => {
    if (!finalizeTiming) { setFinalizeCountdown(''); return; }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      if (finalizeTiming.isFinalized) { setFinalizeCountdown(''); return; }
      if (now < finalizeTiming.gameWindowEnd) {
        setFinalizeCountdown(`Game window ends in ${fmtTimer(finalizeTiming.gameWindowEnd - now)} — cannot finalize yet`);
      } else if (now <= finalizeTiming.finalizationDeadline) {
        setFinalizeCountdown(`Finalization window: ${fmtTimer(finalizeTiming.finalizationDeadline - now)} remaining`);
      } else {
        setFinalizeCountdown('Finalization window passed');
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [finalizeTiming]);

  // Finalize — only for own session (resolves dateKey from sessionId, checks operator == connected wallet)
  // finalizeDailyPoints itself transfers the session's collected funds to the operator's splitter, if registered.
  const handleFinalize = async () => {
    const contract = getWriteContract();
    const readC = getReadContract();
    if (!contract || !readC || !finalizeSessionId) return;
    setTxStatus({ status: 'pending', message: 'Verifying session ownership...' });
    try {
      const sid = parseInt(finalizeSessionId);
      const s = await readC.sessions(sid);
      const operator = s.operator;
      if (operator.toLowerCase() !== address?.toLowerCase()) {
        setTxStatus({ status: 'error', error: `You (${address}) are not the operator of Session #${sid}. Operator is ${operator}. You can only finalize your own session.` });
        return;
      }
      const dk = await readC.getSessionDateKey(sid);
      const dateKey = dk?.toNumber?.() ?? Number(dk);

      setTxStatus({ status: 'pending', message: `Finalizing your Session #${sid} (dateKey ${dateKey})...` });
      const tx = await sendWithGasBuffer(contract, 'finalizeDailyPoints', [dateKey]);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for finalize confirmation...' });
      await tx.wait();

      const msg = operatorSplitter
        ? `Finalized Session #${sid} (dateKey ${dateKey}) and sent collected funds to Splitter (${operatorSplitter.slice(0, 6)}…${operatorSplitter.slice(-4)}).`
        : `Finalized Session #${sid} (dateKey ${dateKey}). No splitter registered in your operator profile — register one in the Admin → Operator Management section.`;
      setTxStatus({ status: 'success', hash: tx.hash, message: msg });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Auto-fill batch from expanded session players
  const autoFillBatch = (sessionId: number) => {
    const players = sessionPlayers[sessionId];
    if (!players || players.length === 0) return;
    setBatchSessionId(String(sessionId));
    setBatchUsers(players.map(p => p.address).join(', '));
    setBatchPoints(players.map(p => p.points).join(', '));
  };

  const fmtTime = (ts: number) => ts > 0 ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'N/A';
  const fmtDateKey = (dk: number) => {
    if (dk === 0) return 'N/A';
    const d = new Date(dk * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  };

  if (!sessionManagerAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load SessionManager address first.</p></Card>;
  }

  return (
    <div className="space-y-4">
      {/* Current Contract Address Banner */}
      <div className="bg-surface-secondary border border-accent/30 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <span className="text-xs text-txt-secondary font-medium shrink-0">📋 SessionManager:</span>
        <code className="text-xs text-accent font-mono break-all select-all">{sessionManagerAddress}</code>
        <a
          href={getExplorerAddressUrl(chainId, sessionManagerAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 underline shrink-0"
        >
          BscScan ↗
        </a>
      </div>

      {/* Today's DateKey + Schedule Info */}
      <div className="bg-surface-secondary rounded-lg px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-accent" />
            <span className="text-txt-secondary">Today&apos;s DateKey:</span>
            <span className="text-accent font-bold text-sm">{todayDateKey}</span>
            <span className="text-txt-secondary">({fmtDateKey(todayDateKey)})</span>
          </div>
          {scheduleInfo && (
            <>
              <span className="text-txt-secondary">Offset: <span className="text-accent">{scheduleInfo.offset}s</span></span>
              <span className="text-txt-secondary">Duration: <span className="text-accent">{scheduleInfo.duration / 3600}h</span></span>
            </>
          )}
          {mySessionId && <span className="text-txt-secondary">My Session: <span className="text-accent font-semibold">#{mySessionId}</span></span>}
        </div>
      </div>

      {/* Create / Sync / Cancel */}
      <Card title="Session Actions (SESSION_OPERATOR_ROLE)" icon={<Plus className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          <code>createTodaySession()</code> creates one session for the current UTC day. Only one session per operator per day.
          The session status is auto-determined from the schedule (CREATED / ACTIVE / ENDED).
        </p>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleCreateTodaySession} disabled={!isConnected}
            className="bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors">
            <Plus className="w-4 h-4 inline mr-1" />Create Today Session
          </button>
          <button onClick={handleSyncStatus} disabled={!isConnected}
            className="bg-surface-tertiary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium px-5 py-2.5 rounded-lg text-sm transition-colors">
            <Zap className="w-4 h-4 inline mr-1" />Sync Status
          </button>
          <button onClick={handleCancel} disabled={!isConnected}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors">
            <XCircle className="w-4 h-4 inline mr-1" />Cancel Today&apos;s Session
          </button>
        </div>
      </Card>

      {/* Update Points + Finalize (own session only) */}
      <Card title="Update & Finalize Daily Points (Your Session)" icon={<ListChecks className="w-5 h-5 text-yellow-400" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Update final points for all users of <strong>your own session</strong>, then finalize so users can claim.
          New points must be ≤ current (downward only). Click a session&apos;s &quot;Fill from Players&quot; to auto-populate.
        </p>
        {mySessionId && (
          <p className="text-xs text-accent mb-3 bg-accent/10 rounded px-3 py-1.5">
            Your current session: <strong>#{mySessionId}</strong> — use this Session ID below.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Batch Update */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-1.5"><ListChecks className="w-4 h-4 text-yellow-400" />Batch Update Points</h4>
            <div>
              <label className="text-xs text-txt-secondary">Your Session ID (auto-resolves dateKey)</label>
              <input value={batchSessionId} onChange={e => setBatchSessionId(e.target.value)} type="number" placeholder={mySessionId ? String(mySessionId) : '1'}
                className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="text-xs text-txt-secondary">User Addresses (comma-separated)</label>
              <textarea value={batchUsers} onChange={e => setBatchUsers(e.target.value)} placeholder="0xABC..., 0xDEF..." rows={2}
                className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
            </div>
            <div>
              <label className="text-xs text-txt-secondary">New Points (comma-separated)</label>
              <textarea value={batchPoints} onChange={e => setBatchPoints(e.target.value)} placeholder="50, 100" rows={2}
                className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
            </div>
            <button onClick={handleBatchUpdate} disabled={!isConnected || !batchSessionId || !batchUsers || !batchPoints}
              className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Update Points
            </button>
          </div>

          {/* Finalize — own session only */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-1.5"><CheckCircle className="w-4 h-4 text-blue-400" />Finalize Your Session</h4>
            <p className="text-xs text-txt-secondary">Finalize <strong>your own session</strong> so users can claim. Cannot be undone.</p>
            {operatorSplitter ? (
              <div className="bg-purple-900/20 border border-purple-700/30 rounded-lg px-3 py-2 flex items-center gap-2">
                <Split className="w-4 h-4 text-purple-400 shrink-0" />
                <p className="text-xs text-purple-300">On-chain Splitter registered — collected funds will auto-transfer to <span className="font-mono text-[10px]">{operatorSplitter.slice(0, 10)}…{operatorSplitter.slice(-6)}</span> after finalize.</p>
              </div>
            ) : (
              <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 flex items-center gap-2">
                <Split className="w-4 h-4 text-yellow-400 shrink-0" />
                <p className="text-xs text-yellow-300">No splitter registered in your operator profile. Register one via <strong>Admin → Operator Management</strong> to auto-transfer collected funds after finalize.</p>
              </div>
            )}
            <div>
              <label className="text-xs text-txt-secondary">Your Session ID</label>
              <input value={finalizeSessionId} onChange={e => setFinalizeSessionId(e.target.value)} type="number" placeholder={mySessionId ? String(mySessionId) : '1'}
                className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            {/* Finalization timing banner */}
            {finalizeCountdown && !finalizeTiming?.isFinalized && (
              <div className={`border rounded-lg px-3 py-2 text-xs flex items-center gap-1.5 ${
                finalizeTiming?.isGameWindowOpen
                  ? 'bg-yellow-500/10 border-yellow-500/40 text-yellow-400'
                  : finalizeTiming?.isGracePeriodOpen
                    ? 'bg-green-500/10 border-green-500/40 text-green-400'
                    : 'bg-red-500/10 border-red-500/40 text-red-400'
              }`}>
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono font-semibold">{finalizeCountdown}</span>
              </div>
            )}
            {finalizeTiming?.isFinalized && (
              <div className="bg-green-500/10 border border-green-500/40 rounded-lg px-3 py-2 text-xs text-green-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" /> This day has already been finalized.
              </div>
            )}
            <button onClick={handleFinalize} disabled={!isConnected || !finalizeSessionId || finalizeTiming?.isGameWindowOpen === true || finalizeTiming?.isFinalized === true}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Finalize My Session{operatorSplitter ? ' & Split Funds' : ' Points'}
            </button>
          </div>
        </div>
      </Card>

      {/* All Sessions List */}
      <Card title="All Sessions" icon={<Gamepad2 className="w-5 h-5 text-accent" />}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-txt-secondary">
            Showing {sessions.length} of {totalSessionCount} session(s), newest first (IDs start at 1)
          </p>
          <button onClick={fetchSessions} disabled={loading} className="flex items-center gap-1.5 text-xs text-accent hover:underline">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-txt-secondary text-sm text-center py-6">No sessions yet. Create one above.</p>
        ) : (
          <div className="space-y-3">
            {sessions.map(s => (
              <div key={s.sessionId} className="bg-surface-tertiary rounded-lg p-4 hover:shadow-lg hover:shadow-black/20 transition-shadow">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Hash className="w-4 h-4 text-accent" />
                    <span className="font-semibold">Session #{s.sessionId}</span>
                    <span className="text-xs bg-surface-secondary px-2 py-0.5 rounded font-mono text-accent">DateKey: {s.dateKey}</span>
                    <span className="text-xs text-txt-secondary">({fmtDateKey(s.dateKey)})</span>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                    s.status === 0 ? 'bg-blue-900/40 text-blue-300' :
                    s.status === 1 ? 'bg-green-900/40 text-green-300' :
                    s.status === 2 ? 'bg-gray-700/40 text-gray-300' :
                    'bg-red-900/40 text-red-300'
                  }`}>
                    {SESSION_STATUS_LABELS[s.status] ?? `Status(${s.status})`}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  <div><span className="text-txt-secondary">Matches:</span> <span className="text-txt-primary">{s.matchCount}</span></div>
                  <div><span className="text-txt-secondary">Collected:</span> <span className="text-txt-primary">{s.totalEntryCollected}</span></div>
                  <div className="col-span-2"><Clock className="w-3 h-3 inline text-txt-secondary mr-1" />Start: {fmtTime(s.startTime)}</div>
                  <div className="col-span-2"><Clock className="w-3 h-3 inline text-txt-secondary mr-1" />End: {fmtTime(s.endTime)}</div>
                </div>
                <p className="text-xs text-txt-secondary mt-2 font-mono">Operator: {s.operator}</p>

                {/* Expand to show players */}
                <div className="mt-3 border-t border-white/10 pt-2">
                  <button onClick={() => toggleSessionExpand(s.sessionId, s.dateKey)}
                    className="flex items-center gap-1.5 text-xs text-accent hover:underline">
                    {expandedSessionId === s.sessionId ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    <Users className="w-3.5 h-3.5" />
                    {expandedSessionId === s.sessionId ? 'Hide' : 'Show'} Players & Points
                  </button>

                  {expandedSessionId === s.sessionId && (
                    <div className="mt-2">
                      {loadingPlayers ? (
                        <p className="text-xs text-txt-secondary animate-pulse">Loading players...</p>
                      ) : !sessionPlayers[s.sessionId] || sessionPlayers[s.sessionId].length === 0 ? (
                        <p className="text-xs text-txt-secondary">No players found (no matches in this session).</p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-txt-secondary">{sessionPlayers[s.sessionId].length} player(s) — DateKey: <span className="text-accent font-mono">{s.dateKey}</span></p>
                            <div className="flex gap-2">
                              <button onClick={() => autoFillBatch(s.sessionId)}
                                className="text-[11px] text-yellow-400 hover:underline flex items-center gap-1">
                                <ListChecks className="w-3 h-3" /> Fill from Players
                              </button>
                              <button onClick={() => fetchPlayersForSession(s.sessionId, s.dateKey)}
                                className="text-[11px] text-accent hover:underline flex items-center gap-1">
                                <RefreshCw className="w-3 h-3" /> Refresh
                              </button>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-txt-secondary border-b border-white/10">
                                  <th className="text-left py-1.5 px-2">#</th>
                                  <th className="text-left py-1.5 px-2">Player Address</th>
                                  <th className="text-right py-1.5 px-2">Daily Points</th>
                                  <th className="text-center py-1.5 px-2">Initialized</th>
                                  <th className="text-center py-1.5 px-2">PR Boost</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sessionPlayers[s.sessionId].map((p, i) => (
                                  <tr key={p.address} className={`border-b border-white/5 ${p.prBoost ? 'bg-green-900/15' : 'hover:bg-surface-secondary/50'}`}>
                                    <td className="py-1.5 px-2 text-txt-secondary">{i + 1}</td>
                                    <td className="py-1.5 px-2 font-mono text-txt-primary">{p.address}</td>
                                    <td className={`py-1.5 px-2 text-right font-bold ${
                                      parseFloat(p.points) > 0 ? 'text-accent' : 'text-txt-secondary'
                                    }`}>{parseFloat(p.points).toFixed(4)}</td>
                                    <td className="py-1.5 px-2 text-center">{p.initialized ? <span className="text-green-400"><Check className="w-3.5 h-3.5 inline" /></span> : <span className="text-txt-secondary"><X className="w-3.5 h-3.5 inline" /></span>}</td>
                                    <td className="py-1.5 px-2 text-center">{p.prBoost ? <span className="text-green-400 font-bold inline-flex items-center gap-0.5"><Check className="w-3.5 h-3.5" /> ON</span> : <span className="text-red-400 inline-flex items-center gap-0.5"><X className="w-3.5 h-3.5" /> OFF</span>}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-white/10">
                                  <td colSpan={2} className="py-1.5 px-2 text-txt-secondary font-semibold">Total</td>
                                  <td className="py-1.5 px-2 text-right font-bold text-accent">
                                    {sessionPlayers[s.sessionId].reduce((sum, p) => sum + parseFloat(p.points), 0).toFixed(4)}
                                  </td>
                                  <td></td>
                                  <td className="py-1.5 px-2 text-center text-[11px] text-txt-secondary">
                                    {sessionPlayers[s.sessionId].filter(p => p.prBoost).length}/{sessionPlayers[s.sessionId].length} boosted
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {hasMoreSessions && (
          <button
            onClick={loadMoreSessions}
            disabled={loadingMore}
            className="w-full mt-3 flex items-center justify-center gap-1.5 bg-surface-tertiary hover:bg-surface-secondary disabled:opacity-40 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingMore ? 'animate-spin' : ''}`} />
            {loadingMore ? 'Loading...' : `Load ${Math.min(SESSIONS_PAGE_SIZE, oldestLoadedId ? oldestLoadedId - 1 : 0)} Older Session(s)`}
          </button>
        )}
      </Card>
      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}