'use client';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { Zap, Users, Search, Info, RefreshCw, ShieldCheck, ShieldAlert, Check, X, Settings } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';

interface PlayerBoostInfo {
  address: string;
  prBoost: boolean;
  points: string;
  hasPoints: boolean;
}

export default function PrBoostSection() {
  const { signer, provider, isConnected, address, sessionManagerAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });

  /* ── Timing state ── */
  const [currentDateKey, setCurrentDateKey] = useState<number | null>(null);
  const [prevDateKey, setPrevDateKey] = useState<number | null>(null);

  /* ── Stake-based PR boost claim for today (currentDateKey) ── */
  const [stakeAmount, setStakeAmount] = useState('');
  const [carryForwardBalance, setCarryForwardBalance] = useState<string | null>(null);
  const [dailyStake, setDailyStake] = useState<string | null>(null);
  const [myBoostEnabled, setMyBoostEnabled] = useState<boolean | null>(null);

  /* ── Check boost status (manual) ── */
  const [checkDateKey, setCheckDateKey] = useState('');
  const [checkUser, setCheckUser] = useState('');
  const [checkResult, setCheckResult] = useState<{ enabled: boolean; points: string } | null>(null);

  /* ── Players list with PR status ── */
  const [listSessionId, setListSessionId] = useState('');
  const [playerList, setPlayerList] = useState<PlayerBoostInfo[]>([]);
  const [listLoading, setListLoading] = useState(false);

  /* ── Operator override: set/batch-set PR boost directly ── */
  const [ovSessionId, setOvSessionId] = useState('');
  const [ovDateKey, setOvDateKey] = useState('');
  const [ovAddresses, setOvAddresses] = useState('');
  const [ovEnabled, setOvEnabled] = useState(true);
  const [ovLoading, setOvLoading] = useState(false);
  const [ovEligibleLoading, setOvEligibleLoading] = useState(false);

  const getContract = useCallback((useSigner = false) => {
    if (!sessionManagerAddress) return null;
    const p = useSigner ? signer : provider;
    if (!p) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, p);
  }, [signer, provider, sessionManagerAddress]);

  /* ── Load basic reference timing: current + previous dateKey ── */
  const loadTimingInfo = useCallback(async () => {
    const c = getContract();
    if (!c) return;
    try {
      const curDkRaw = await c.currentDateKey();
      const curDk = curDkRaw?.toNumber?.() ?? Number(curDkRaw);
      setCurrentDateKey(curDk);
      setPrevDateKey(curDk > 0 ? curDk - 1 : 0);
    } catch (e) {
      console.error('Load timing error:', e);
    }
  }, [getContract]);

  useEffect(() => { loadTimingInfo(); }, [loadTimingInfo]);

  /* ── Load carry-forward balance / today's stake / boost status for the connected player ── */
  const loadClaimStatus = useCallback(async () => {
    const c = getContract();
    if (!c || !address || currentDateKey === null) return;
    try {
      const [balance, stake, enabled] = await Promise.all([
        c.carryForwardPoints(address),
        c.dailyBoostStake(currentDateKey, address),
        c.isDailyPrBoostEnabled(currentDateKey, address),
      ]);
      setCarryForwardBalance(ethers.utils.formatEther(balance));
      setDailyStake(ethers.utils.formatEther(stake));
      setMyBoostEnabled(enabled);
    } catch (e) {
      console.error('Load claim status error:', e);
    }
  }, [getContract, address, currentDateKey]);

  useEffect(() => { loadClaimStatus(); }, [loadClaimStatus]);

  /* ── Check if PR boost is enabled + points (manual query) ── */
  const handleCheck = async () => {
    const contract = getContract();
    if (!contract || !checkDateKey) return;
    const userAddr = checkUser || address;
    if (!userAddr) return;
    try {
      const dk = parseInt(checkDateKey);
      const [enabled, bal] = await Promise.all([
        contract.isDailyPrBoostEnabled(dk, userAddr),
        contract.getDailyUserPoints(dk, userAddr),
      ]);
      setCheckResult({ enabled, points: ethers.utils.formatEther(bal) });
    } catch (e: any) {
      console.error('Check boost error:', e);
      setCheckResult(null);
    }
  };

  /* ── Stake points from my carry-forward balance toward today's PR boost ── */
  const handleClaimBoost = async () => {
    const contract = getContract(true);
    if (!contract || !address || currentDateKey === null) return;
    const amt = parseFloat(stakeAmount);
    if (!amt || amt <= 0) {
      setTxStatus({ status: 'error', error: 'Enter an amount greater than 0 to stake.' });
      return;
    }
    setTxStatus({ status: 'pending', message: `Staking ${amt} pts toward PR boost for dateKey ${currentDateKey}...` });
    try {
      const amountWei = ethers.utils.parseEther(stakeAmount);
      const tx = await contract.claimDailyPrBoost(currentDateKey, amountWei);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `PR boost claimed for dateKey ${currentDateKey}! (Staked: ${amt} pts)` });
      setStakeAmount('');
      setMyBoostEnabled(true);
      loadClaimStatus();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  /* ── Shared: fetch every player of a session + their PR boost status ── */
  const fetchSessionPlayers = useCallback(async (sid: number): Promise<{ dateKey: number; players: PlayerBoostInfo[] }> => {
    const contract = getContract();
    if (!contract) throw new Error('Contract not available');

    const dk = await contract.getSessionDateKey(sid);
    const dateKey = dk?.toNumber?.() ?? Number(dk);

    const matchIds: number[] = (await contract.getMatchIds(sid)).map((x: any) => x?.toNumber?.() ?? Number(x));
    const uniquePlayers = new Set<string>();
    for (const mid of matchIds) {
      try {
        const players: string[] = await contract.getMatchPlayers(sid, mid);
        players.forEach(p => uniquePlayers.add(p));
      } catch { /* skip */ }
    }

    const results: PlayerBoostInfo[] = [];
    for (const addr of uniquePlayers) {
      try {
        const [boost, bal] = await Promise.all([
          contract.isDailyPrBoostEnabled(dateKey, addr),
          contract.getDailyUserPoints(dateKey, addr),
        ]);
        const pointsStr = ethers.utils.formatEther(bal);
        results.push({ address: addr, prBoost: boost, points: pointsStr, hasPoints: parseFloat(pointsStr) > 0 });
      } catch {
        results.push({ address: addr, prBoost: false, points: '0', hasPoints: false });
      }
    }
    return { dateKey, players: results };
  }, [getContract]);

  /* ── Fetch all players for a session with their PR boost status ── */
  const handleFetchPlayers = async () => {
    if (!listSessionId) return;
    setListLoading(true);
    setPlayerList([]);
    try {
      const sid = parseInt(listSessionId);
      const { players } = await fetchSessionPlayers(sid);
      players.sort((a, b) => {
        if (a.prBoost !== b.prBoost) return a.prBoost ? -1 : 1;
        return parseFloat(b.points) - parseFloat(a.points);
      });
      setPlayerList(players);
    } catch (e: any) {
      console.error('Fetch players error:', e);
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setListLoading(false);
    }
  };

  /* ── Load all eligible-but-not-yet-boosted wallets for a session into the override form ── */
  const handleLoadEligibleWallets = async () => {
    if (!ovSessionId) return;
    setOvEligibleLoading(true);
    try {
      const sid = parseInt(ovSessionId);
      const { dateKey, players } = await fetchSessionPlayers(sid);
      const eligible = players.filter(p => p.hasPoints && !p.prBoost);

      setOvDateKey(String(dateKey));
      setOvAddresses(eligible.map(p => p.address).join('\n'));
      setOvEnabled(true);

      setTxStatus(eligible.length > 0
        ? { status: 'success', message: `Loaded ${eligible.length} eligible wallet(s) for session ${sid} (dateKey ${dateKey}). Review the list, then click "Set PR Boost ON".` }
        : { status: 'error', error: `No eligible wallets found for session ${sid} (dateKey ${dateKey}) — every player either has 0 points or is already boosted.` });
    } catch (e: any) {
      console.error('Load eligible wallets error:', e);
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setOvEligibleLoading(false);
    }
  };

  /* ── Operator override: set PR boost for one or many users directly (PLATFORM_UPDATER_ROLE) ── */
  const handleSetBoostOverride = async () => {
    const contract = getContract(true);
    if (!contract || !ovDateKey || !ovAddresses.trim()) return;

    const rawList = ovAddresses.split(/[\s,]+/).map(a => a.trim()).filter(Boolean);
    if (rawList.length === 0) return;

    let addrs: string[];
    try {
      addrs = rawList.map(a => ethers.utils.getAddress(a));
    } catch {
      setTxStatus({ status: 'error', error: 'One or more addresses are invalid.' });
      return;
    }

    const dk = parseInt(ovDateKey);
    setOvLoading(true);
    setTxStatus({ status: 'pending', message: `Setting PR boost (${ovEnabled ? 'ON' : 'OFF'}) for ${addrs.length} address(es) at dateKey ${dk}...` });
    try {
      const tx = addrs.length === 1
        ? await contract.setDailyPrBoost(dk, addrs[0], ovEnabled)
        : await contract.batchSetDailyPrBoost(dk, addrs, addrs.map(() => ovEnabled));
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `PR boost set to ${ovEnabled ? 'ON' : 'OFF'} for ${addrs.length} address(es) at dateKey ${dk}.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setOvLoading(false);
    }
  };

  if (!sessionManagerAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load SessionManager address first.</p></Card>;
  }

  const boostedCount = playerList.filter(p => p.prBoost).length;
  const withPointsCount = playerList.filter(p => p.hasPoints).length;
  const balanceNum = carryForwardBalance ? parseFloat(carryForwardBalance) : 0;
  const stakeNum = parseFloat(stakeAmount) || 0;
  const insufficientBalance = stakeNum > 0 && stakeNum > balanceNum;

  return (
    <div className="space-y-4">
      {/* Explanation Banner */}
      <div className="bg-surface-secondary rounded-lg px-4 py-3">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-accent mt-0.5 shrink-0" />
          <div className="text-xs text-txt-secondary space-y-1">
            <p className="font-semibold text-txt-primary">How PR Boost Works</p>
            <p>PR Boost is <strong>stake-based</strong>: you stake any amount of your rolling <strong>carry-forward points balance</strong> toward today&apos;s boost. It marks your daily points for PR purposes in your off-chain logic &mdash; it does not grant extra points.</p>
            <p>PR Boost is <span className="text-red-400 font-semibold">off by default</span> for every user every day (stake amount is 0).</p>
            <p><span className="text-green-400 font-semibold">Only you can stake from your own carry-forward balance</span> via the button below, and only for <strong>today&apos;s dateKey</strong> (one stake per day). A Platform Updater can also set/override PR boost directly for one or many users (see &quot;Operator Override&quot; below) &mdash; use this for exceptional cases only.</p>
            <p className="text-accent">Workflow: Points earned flow into your carry-forward balance as they&apos;re credited &mdash; finalization no longer gates anything here. Stake from that balance any time today to mark your PR boost on.</p>
          </div>
        </div>
      </div>

      {/* Claim My PR Boost — always targets today's dateKey (current) */}
      <Card title="Claim My PR Boost" icon={<Zap className="w-5 h-5 text-yellow-400" />}>
        <div className="flex items-start gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
          <p className="text-xs text-txt-secondary">
            Stake any amount from your carry-forward balance to enable PR boost for <strong>today</strong> (dateKey {currentDateKey ?? '—'}).
            One stake per day — the amount can&apos;t exceed your current balance.
            Only you (the player) can claim — no admin can do it for you.
          </p>
        </div>

        {/* Status tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-surface-tertiary rounded-lg p-3 text-center">
            <p className="text-[10px] text-txt-secondary uppercase tracking-wider">Current DateKey</p>
            <p className="text-lg font-bold text-txt-primary">{currentDateKey ?? '—'}</p>
          </div>
          <div className="bg-surface-tertiary rounded-lg p-3 text-center">
            <p className="text-[10px] text-txt-secondary uppercase tracking-wider">Carry-Forward Balance</p>
            <p className={`text-lg font-bold ${balanceNum > 0 ? 'text-accent' : 'text-txt-secondary'}`}>{carryForwardBalance !== null ? `${balanceNum.toFixed(4)} pts` : '—'}</p>
          </div>
          <div className="bg-surface-tertiary rounded-lg p-3 text-center">
            <p className="text-[10px] text-txt-secondary uppercase tracking-wider">Staked Today</p>
            <p className={`text-lg font-bold ${dailyStake && parseFloat(dailyStake) > 0 ? 'text-accent' : 'text-txt-secondary'}`}>{dailyStake !== null ? `${parseFloat(dailyStake).toFixed(4)} pts` : '—'}</p>
          </div>
          <div className="bg-surface-tertiary rounded-lg p-3 text-center">
            <p className="text-[10px] text-txt-secondary uppercase tracking-wider">Boost Status</p>
            <p className={`text-lg font-bold ${myBoostEnabled === true ? 'text-green-400' : 'text-txt-secondary'}`}>
              {myBoostEnabled === true ? '✓ ON' : myBoostEnabled === false ? 'OFF' : '—'}
            </p>
          </div>
        </div>

        {/* Stake amount input */}
        <div className="flex items-end gap-3 mb-4">
          <div className="flex-1">
            <label className="text-xs text-txt-secondary">Amount to Stake</label>
            <input value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} type="number" placeholder="0.0"
              disabled={myBoostEnabled === true}
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-40" />
          </div>
          {carryForwardBalance !== null && myBoostEnabled !== true && (
            <button onClick={() => setStakeAmount(carryForwardBalance)} className="text-xs text-accent hover:underline pb-2.5 shrink-0">
              Max ({balanceNum.toFixed(4)})
            </button>
          )}
        </div>

        {/* Status banners */}
        {myBoostEnabled === true && (
          <div className="bg-green-900/30 border border-green-700/50 rounded-lg p-3 mb-3 flex items-center gap-2">
            <Check className="w-4 h-4 text-green-400 shrink-0" />
            <p className="text-xs text-green-400 font-semibold">PR Boost already claimed for dateKey {currentDateKey} ({dailyStake} pts staked)!</p>
          </div>
        )}
        {insufficientBalance && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 mb-3 flex items-center gap-2">
            <X className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-xs text-red-400 font-semibold">Amount exceeds your carry-forward balance ({balanceNum.toFixed(4)} pts available).</p>
          </div>
        )}

        <button
          onClick={handleClaimBoost}
          disabled={!isConnected || myBoostEnabled === true || !stakeAmount || stakeNum <= 0 || insufficientBalance}
          className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
        >
          {myBoostEnabled === true ? 'Already Claimed ✓' : `Stake ${stakeAmount || '—'} pts for DateKey ${currentDateKey ?? '—'}`}
        </button>

        <button onClick={() => { loadTimingInfo(); loadClaimStatus(); }} className="mt-2 text-[11px] text-accent hover:underline flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> Refresh Status
        </button>
      </Card>

      {/* Players PR Boost Status List */}
      <Card title="Players PR Boost Status" icon={<Users className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">Enter a Session ID to see all players, their points, and PR boost status. <span className="text-green-400">Only players with points &gt; 0 are eligible</span> for PR boost.</p>
        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <input value={listSessionId} onChange={e => setListSessionId(e.target.value)} type="number" placeholder="Session ID (e.g. 1)"
              className="w-full bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button onClick={handleFetchPlayers} disabled={!isConnected || !listSessionId || listLoading}
            className="bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors">
            {listLoading ? 'Loading...' : 'Load Players'}
          </button>
        </div>
        {playerList.length > 0 && (
          <>
            <div className="flex items-center gap-3 mb-2 text-xs flex-wrap">
              <span className="text-txt-secondary">{playerList.length} player(s)</span>
              <span className="text-green-400 font-semibold">{boostedCount} boosted</span>
              <span className="text-blue-400">{withPointsCount} with points (eligible)</span>
              <span className="text-red-400">{playerList.length - withPointsCount} no points (ineligible)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary border-b border-white/10">
                    <th className="text-left py-1.5 px-2">#</th>
                    <th className="text-left py-1.5 px-2">Player Address</th>
                    <th className="text-right py-1.5 px-2">Daily Points</th>
                    <th className="text-center py-1.5 px-2">Eligible</th>
                    <th className="text-center py-1.5 px-2">PR Boost</th>
                  </tr>
                </thead>
                <tbody>
                  {playerList.map((p, i) => (
                    <tr key={p.address} className={`border-b border-white/5 ${
                      p.prBoost ? 'bg-green-900/20' : !p.hasPoints ? 'opacity-50' : 'hover:bg-surface-secondary/50'
                    }`}>
                      <td className="py-1.5 px-2 text-txt-secondary">{i + 1}</td>
                      <td className="py-1.5 px-2 font-mono text-txt-primary">{p.address}</td>
                      <td className={`py-1.5 px-2 text-right font-bold ${
                        p.hasPoints ? 'text-accent' : 'text-txt-secondary'
                      }`}>{parseFloat(p.points).toFixed(4)}</td>
                      <td className="py-1.5 px-2 text-center">
                        {p.hasPoints
                          ? <span className="text-green-400 inline-flex items-center justify-center gap-0.5"><Check className="w-3.5 h-3.5" /> Yes</span>
                          : <span className="text-red-400 inline-flex items-center justify-center gap-0.5"><X className="w-3.5 h-3.5" /> No points</span>
                        }
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        {p.prBoost
                          ? <span className="text-green-400 font-bold inline-flex items-center justify-center gap-0.5"><Check className="w-3.5 h-3.5" /> ON</span>
                          : p.hasPoints
                            ? <span className="text-yellow-400 inline-flex items-center justify-center gap-0.5"><X className="w-3.5 h-3.5" /> OFF (can boost)</span>
                            : <span className="text-txt-secondary">— N/A</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2">
              <button onClick={handleFetchPlayers} className="text-[11px] text-accent hover:underline flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
          </>
        )}
        {playerList.length === 0 && listSessionId && !listLoading && (
          <p className="text-xs text-txt-secondary text-center py-3">No players found. Click &quot;Load Players&quot; to fetch.</p>
        )}
      </Card>

      {/* Operator Override: set/batch-set PR boost directly */}
      <Card title="Operator Override: Set PR Boost" icon={<Settings className="w-5 h-5 text-accent" />}>
        <div className="flex items-start gap-2 mb-4">
          <ShieldAlert className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" />
          <p className="text-xs text-txt-secondary">
            Directly set the PR boost flag for one or many users at once &mdash; bypasses self-claim.
            Requires an active <strong>Platform Updater</strong> role. The dateKey must be <strong>finalized</strong> and within the same admin-configurable claim window as a normal claim (Admin tab, via the GameHub).
          </p>
        </div>

        <div className="flex items-end gap-3 mb-3">
          <div className="flex-1">
            <label className="text-xs text-txt-secondary">Load From Session ID</label>
            <input value={ovSessionId} onChange={(e) => setOvSessionId(e.target.value)} type="number" placeholder="e.g. 1"
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button onClick={handleLoadEligibleWallets} disabled={!isConnected || !ovSessionId || ovEligibleLoading}
            className="bg-surface-tertiary hover:bg-surface-secondary disabled:opacity-40 text-txt-primary font-semibold px-4 py-2.5 rounded-lg text-sm transition-colors flex items-center gap-1.5 shrink-0">
            <Users className="w-4 h-4" /> {ovEligibleLoading ? 'Loading...' : 'Load Eligible Wallets'}
          </button>
        </div>
        <p className="text-[11px] text-txt-secondary mb-3">Fills in the dateKey and address list below with every player who has points &gt; 0 and isn&apos;t already boosted for that session.</p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">Date Key{prevDateKey !== null ? ` (prev: ${prevDateKey})` : ''}</label>
            <input value={ovDateKey} onChange={(e) => setOvDateKey(e.target.value)} type="number" placeholder={prevDateKey !== null ? String(prevDateKey) : '0'}
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs text-txt-secondary">User Addresses (comma, space, or newline separated)</label>
            <textarea value={ovAddresses} onChange={(e) => setOvAddresses(e.target.value)} rows={2} placeholder="0xabc..., 0xdef..."
              className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent resize-y" />
          </div>
        </div>

        <div className="flex items-center gap-4 mb-3">
          <span className="text-xs text-txt-secondary">Set boost to:</span>
          <div className="flex gap-2">
            <button onClick={() => setOvEnabled(true)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${ovEnabled ? 'bg-green-600 text-black' : 'bg-surface-tertiary text-txt-secondary'}`}>
              ON
            </button>
            <button onClick={() => setOvEnabled(false)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!ovEnabled ? 'bg-red-600 text-white' : 'bg-surface-tertiary text-txt-secondary'}`}>
              OFF
            </button>
          </div>
        </div>

        <button
          onClick={handleSetBoostOverride}
          disabled={!isConnected || !ovDateKey || !ovAddresses.trim() || ovLoading}
          className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors"
        >
          {ovLoading ? 'Submitting...' : `Set PR Boost ${ovEnabled ? 'ON' : 'OFF'} for Entered Addresses`}
        </button>
      </Card>

      {/* Check Boost Status (manual) */}
      <Card title="Check PR Boost Status" icon={<Search className="w-5 h-5 text-accent" />}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">Date Key{prevDateKey !== null ? ` (prev: ${prevDateKey})` : ''}</label>
            <input value={checkDateKey} onChange={(e) => setCheckDateKey(e.target.value)} type="number" placeholder={prevDateKey !== null ? String(prevDateKey) : '0'} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">User Address (blank = self)</label>
            <input value={checkUser} onChange={(e) => setCheckUser(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="flex items-end">
            <button onClick={handleCheck} disabled={!isConnected || !checkDateKey} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Check
            </button>
          </div>
        </div>
        {checkResult !== null && (
          <div className="bg-surface-tertiary rounded-lg p-3">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-xs text-txt-secondary">Daily Points</p>
                <p className={`text-lg font-bold ${parseFloat(checkResult.points) > 0 ? 'text-accent' : 'text-txt-secondary'}`}>{parseFloat(checkResult.points).toFixed(4)} pts</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">PR Boost</p>
                <p className={`text-xl font-bold ${checkResult.enabled ? 'text-green-400' : 'text-red-400'}`}>
                  {checkResult.enabled ? <span className="inline-flex items-center gap-1">ON <Check className="w-4 h-4" /></span> : <span className="inline-flex items-center gap-1">OFF <X className="w-4 h-4" /></span>}
                </p>
                {!checkResult.enabled && parseFloat(checkResult.points) <= 0 && (
                  <p className="text-[11px] text-red-400 mt-1">No points — not eligible for PR boost</p>
                )}
                {!checkResult.enabled && parseFloat(checkResult.points) > 0 && (
                  <p className="text-[11px] text-yellow-400 mt-1">Has points — eligible but not claimed yet</p>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}