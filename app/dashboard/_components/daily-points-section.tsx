'use client';
import React, { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { sendWithGasBuffer } from '@/lib/contracts/gas';
import { CheckCircle, ListChecks, DollarSign, History, RefreshCw, ChevronDown, ChevronUp, Check, X, Wallet } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';

export default function DailyPointsSection() {
  const { signer, provider, isConnected, address, sessionManagerAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });



  /* \u2500\u2500 Check Points \u2500\u2500 */
  const [checkDateKey, setCheckDateKey] = useState('');
  const [checkUser, setCheckUser] = useState('');
  const [pointsResult, setPointsResult] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isFinalized, setIsFinalized] = useState<boolean | null>(null);

  /* ── Current Balance Summary ── */
  const [summaryUser, setSummaryUser] = useState('');
  const [summaryResult, setSummaryResult] = useState<{ dailyPoints: string; dateKey: string; totalBalance: string } | null>(null);

  /* \u2500\u2500 Finalize \u2500\u2500 */
  const [finalizeDateKey, setFinalizeDateKey] = useState('');

  /* \u2500\u2500 Batch Update \u2500\u2500 */
  const [batchDateKey, setBatchDateKey] = useState('');
  const [batchUsers, setBatchUsers] = useState('');
  const [batchPoints, setBatchPoints] = useState('');

  /* \u2500\u2500 User History \u2500\u2500 */
  const [historyUser, setHistoryUser] = useState('');
  const [historyDays, setHistoryDays] = useState('7');
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const todayDateKey = Math.floor(Date.now() / 1000 / 86400);

  const getContract = useCallback((useSigner = false) => {
    if (!sessionManagerAddress) return null;
    const p = useSigner ? signer : provider;
    if (!p) return null;
    return new ethers.Contract(sessionManagerAddress, SessionManagerArtifact.abi, p);
  }, [signer, provider, sessionManagerAddress]);

  /* \u2500\u2500 Check points for user \u2500\u2500 */
  const handleCheckPoints = async () => {
    const contract = getContract();
    if (!contract || !checkDateKey) return;
    const userAddr = checkUser || address;
    if (!userAddr) return;
    try {
      const bal = await contract.getDailyUserPoints(parseInt(checkDateKey), userAddr);
      setPointsResult(ethers.utils.formatEther(bal));
      const init = await contract.isDailyUserPointsInitialized(parseInt(checkDateKey), userAddr);
      setIsInitialized(init);
      const fin = await contract.dailyPointsFinalized(parseInt(checkDateKey));
      setIsFinalized(fin);
    } catch (e: any) {
      console.error('Check points error:', e);
      setPointsResult('Error');
    }
  };

  /* \u2500\u2500 Fetch current-day balance + carry-forward total in one call \u2500\u2500 */
  const handleFetchSummary = async () => {
    const contract = getContract();
    if (!contract) return;
    const userAddr = summaryUser || address;
    if (!userAddr) return;
    try {
      const [dailyPoints, dateKey, totalBalance] = await contract.getUserPointsSummary(userAddr);
      setSummaryResult({
        dailyPoints: ethers.utils.formatEther(dailyPoints),
        dateKey: dateKey.toString(),
        totalBalance: ethers.utils.formatEther(totalBalance),
      });
    } catch (e: any) {
      console.error('Fetch summary error:', e);
    }
  };


  /* \u2500\u2500 Finalize \u2500\u2500 */
  const handleFinalize = async () => {
    const contract = getContract(true);
    if (!contract || !finalizeDateKey) return;
    setTxStatus({ status: 'pending', message: 'Finalizing operator points...' });
    try {
      const tx = await sendWithGasBuffer(contract, 'finalizeDailyPoints', [parseInt(finalizeDateKey)]);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Operator finalized for dateKey ${finalizeDateKey} ✔` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  /* \u2500\u2500 Batch Update \u2500\u2500 */
  const handleBatchUpdate = async () => {
    if (!sessionManagerAddress) {
      setTxStatus({ status: 'error', error: 'No SessionManager instance loaded \u2014 select one from the Hub tab first.' });
      return;
    }
    if (!signer) {
      setTxStatus({ status: 'error', error: 'Wallet not connected \u2014 click Connect Wallet and try again.' });
      return;
    }
    if (!batchDateKey || !batchUsers || !batchPoints) {
      setTxStatus({ status: 'error', error: 'Fill in Date Key, User Addresses, and New Points first.' });
      return;
    }
    const contract = getContract(true);
    if (!contract) {
      setTxStatus({ status: 'error', error: 'Could not create a contract instance \u2014 check your wallet connection and try again.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Batch updating points...' });
    try {
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
      const tx = await contract.batchUpdateDailyUserPoints(parseInt(batchDateKey), users, points);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Updated ${users.length} user points` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  /* \u2500\u2500 User History \u2500\u2500
   * getUserLastNDaysData was removed from the contract \u2014 walk currentDateKey() backward
   * and pull each day individually instead (see PR_BOOST_FETCH_SPEC.md, Request B). */
  const handleFetchHistory = async () => {
    const contract = getContract();
    if (!contract) return;
    const userAddr = historyUser || address;
    if (!userAddr) return;
    try {
      const todayRaw = await contract.currentDateKey();
      const today = todayRaw?.toNumber?.() ?? Number(todayRaw);
      const daysCount = parseInt(historyDays) || 7;
      const rows = [];
      const startDateKey = Math.max(0, today - daysCount + 1);
      for (let dateKey = startDateKey; dateKey <= today; dateKey++) {
        const [points, prBoostEnabled, finalized] = await Promise.all([
          contract.getDailyUserPoints(dateKey, userAddr),
          contract.isDailyPrBoostEnabled(dateKey, userAddr),
          contract.dailyPointsFinalized(dateKey),
        ]);
        rows.push({
          dateKey: String(dateKey),
          points: ethers.utils.formatEther(points),
          prBoostEnabled,
          finalized,
        });
      }
      setHistoryData(rows);
      setHistoryOpen(true);
    } catch (e: any) {
      console.error('History fetch error:', e);
    }
  };

  if (!sessionManagerAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load SessionManager address first.</p></Card>;
  }

  return (
    <div className="space-y-4">
      {/* Current Balance Summary */}
      <Card title="Current Balance" icon={<Wallet className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">Fetches today's daily points, the current date key, and the carry-forward total balance in a single call.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div className="sm:col-span-2">
            <label className="text-xs text-txt-secondary">User Address (blank = self)</label>
            <input value={summaryUser} onChange={(e) => setSummaryUser(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="flex items-end">
            <button onClick={handleFetchSummary} disabled={!isConnected} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Fetch
            </button>
          </div>
        </div>
        {summaryResult && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Daily Points</p>
              <p className="text-lg font-bold text-accent">{summaryResult.dailyPoints}</p>
            </div>
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Date Key</p>
              <p className="text-lg font-bold text-accent">{summaryResult.dateKey}</p>
            </div>
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Total Balance</p>
              <p className="text-lg font-bold text-accent">{summaryResult.totalBalance}</p>
            </div>
          </div>
        )}
      </Card>

      {/* Check Points */}
      <Card title="Check Daily Points" icon={<DollarSign className="w-5 h-5 text-accent" />}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">Date Key (today: {todayDateKey})</label>
            <input value={checkDateKey} onChange={(e) => setCheckDateKey(e.target.value)} type="number" placeholder={String(todayDateKey)} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">User Address (blank = self)</label>
            <input value={checkUser} onChange={(e) => setCheckUser(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="flex items-end">
            <button onClick={handleCheckPoints} disabled={!isConnected || !checkDateKey} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Check
            </button>
          </div>
        </div>
        {pointsResult !== null && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Points</p>
              <p className="text-lg font-bold text-accent">{pointsResult}</p>
            </div>
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Initialized</p>
              <p className={`text-lg font-bold ${isInitialized ? 'text-green-400' : 'text-txt-secondary'}`}>{isInitialized === null ? '\u2014' : isInitialized ? 'Yes' : 'No'}</p>
            </div>
            <div className="bg-surface-tertiary rounded-lg p-3 text-center">
              <p className="text-xs text-txt-secondary">Finalized</p>
              <p className={`text-lg font-bold ${isFinalized ? 'text-green-400' : 'text-txt-secondary'}`}>{isFinalized === null ? '\u2014' : isFinalized ? 'Yes' : 'No'}</p>
            </div>
          </div>
        )}
      </Card>


      {/* Finalize Daily Points (Admin) */}
      <Card title="Finalize Daily Points" icon={<CheckCircle className="w-5 h-5 text-blue-400" />}>
        <p className="text-xs text-txt-secondary mb-3">Admin only — finalize a day so points are locked. Cannot be undone.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-txt-secondary">Date Key</label>
            <input value={finalizeDateKey} onChange={(e) => setFinalizeDateKey(e.target.value)} type="number" placeholder={String(todayDateKey)} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button onClick={handleFinalize} disabled={!isConnected || !finalizeDateKey} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
            Finalize Points
          </button>
        </div>
      </Card>

      {/* Batch Update (Admin) */}
      <Card title="Batch Update User Points" icon={<ListChecks className="w-5 h-5 text-yellow-400" />}>
        <p className="text-xs text-txt-secondary mb-3">PLATFORM_UPDATER_ROLE required. New points must be \u2264 current points (downward only).</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-txt-secondary">Date Key</label>
            <input value={batchDateKey} onChange={(e) => setBatchDateKey(e.target.value)} type="number" placeholder={String(todayDateKey)} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">User Addresses (comma-separated)</label>
            <textarea value={batchUsers} onChange={(e) => setBatchUsers(e.target.value)} placeholder="0xABC..., 0xDEF..." rows={2} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">New Points (comma-separated)</label>
            <textarea value={batchPoints} onChange={(e) => setBatchPoints(e.target.value)} placeholder="50, 100" rows={2} className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
          </div>
          <button onClick={handleBatchUpdate} disabled={!isConnected || !batchDateKey || !batchUsers || !batchPoints} className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
            Batch Update Points
          </button>
        </div>
      </Card>

      {/* User History */}
      <Card title="User Daily History" icon={<History className="w-5 h-5 text-purple-400" />}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-txt-secondary">User Address (blank = self)</label>
            <input value={historyUser} onChange={(e) => setHistoryUser(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs text-txt-secondary">Days</label>
            <input value={historyDays} onChange={(e) => setHistoryDays(e.target.value)} type="number" placeholder="7" className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="flex items-end">
            <button onClick={handleFetchHistory} disabled={!isConnected} className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> Fetch History
            </button>
          </div>
        </div>
        {historyData.length > 0 && (
          <div>
            <button onClick={() => setHistoryOpen(!historyOpen)} className="flex items-center gap-1 text-xs text-accent mb-2">
              {historyOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {historyOpen ? 'Collapse' : 'Expand'} ({historyData.length} days)
            </button>
            {historyOpen && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-txt-secondary border-b border-white/10">
                      <th className="text-left py-2 px-2">DateKey</th>
                      <th className="text-right py-2 px-2">Points</th>
                      <th className="text-center py-2 px-2">PR Boost</th>
                      <th className="text-center py-2 px-2">Finalized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.map((d, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-surface-tertiary/50">
                        <td className="py-2 px-2 font-mono">{d.dateKey}</td>
                        <td className="py-2 px-2 text-right font-bold text-accent">{parseFloat(d.points).toFixed(4)}</td>
                        <td className="py-2 px-2 text-center">{d.prBoostEnabled ? <span className="text-green-400"><Check className="w-3.5 h-3.5 inline" /></span> : <span className="text-txt-secondary"><X className="w-3.5 h-3.5 inline" /></span>}</td>
                        <td className="py-2 px-2 text-center">{d.finalized ? <span className="text-green-400"><Check className="w-3.5 h-3.5 inline" /></span> : <span className="text-yellow-400">Pending</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}