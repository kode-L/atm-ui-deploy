'use client';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { sendWithGasBuffer } from '@/lib/contracts/gas';
import { networkStorageKey, getExplorerAddressUrl } from '@/lib/contracts/config';
import { CheckCircle, ListChecks, DollarSign, History, RefreshCw, ChevronDown, ChevronUp, Check, X, Wallet, MinusCircle, Download, Upload, Plus, Trash2, Network, ExternalLink } from 'lucide-react';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';

interface ReducePointsRow { address: string; amount: string; balance: string | null; }
const blankReduceRow = (): ReducePointsRow => ({ address: '', amount: '', balance: null });

// Mirrors the shape hub-section.tsx / operators-section.tsx cache to localStorage under
// `dg_cached_operators:<chainId>` — read-only here, just to label/switch the active instance.
interface CachedOperator { address: string; name: string; active: boolean; instance: string; }

// Second column is an optional suggested amount — blank is fine, the admin can fill it
// in after fetching each row's current balance.
const REDUCE_POINTS_CSV_TEMPLATE =
  'address,amount\n' +
  '0x1234567890123456789012345678901234567890,50\n' +
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd,\n';

function downloadReducePointsTemplate() {
  const blob = new Blob([REDUCE_POINTS_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'reduce-points-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

// First column must be an address; if row 1 isn't one, it's a header row — skip it.
function parseReducePointsCsv(text: string): { rows: ReducePointsRow[]; error?: string } {
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], error: 'File is empty.' };
  const startIdx = ethers.utils.isAddress((lines[0].split(',')[0] || '').trim()) ? 0 : 1;
  const rows: ReducePointsRow[] = [];
  const errors: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const addr = (cols[0] || '').trim();
    const amount = (cols[1] || '').trim();
    if (!ethers.utils.isAddress(addr)) { errors.push(`row ${i + 1}: invalid address "${addr}"`); continue; }
    if (amount && isNaN(Number(amount))) { errors.push(`row ${i + 1}: invalid amount "${amount}"`); continue; }
    rows.push({ address: addr, amount, balance: null });
  }
  if (errors.length > 0) {
    const shown = errors.slice(0, 5).join('; ');
    return { rows: [], error: `${shown}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}` };
  }
  if (rows.length === 0) return { rows: [], error: 'No data rows found.' };
  return { rows };
}

export default function DailyPointsSection() {
  const { signer, provider, isConnected, address, sessionManagerAddress, setSessionManagerAddress, chainId, netChainId } = useWeb3();
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

  /* \u2500\u2500 Reduce Points (CSV batch) \u2500\u2500 */
  const [reduceRows, setReduceRows] = useState<ReducePointsRow[]>([blankReduceRow()]);
  const [reduceBalancesLoading, setReduceBalancesLoading] = useState(false);
  const reduceCsvInputRef = useRef<HTMLInputElement>(null);

  // Which operator instance "Reduce Points" (and every other action on this page) is
  // pointed at \u2014 read-only cache populated by the Operators/Hub tabs, just so it's visible
  // here without having to jump tabs before an irreversible deduction.
  const [cachedOperators, setCachedOperators] = useState<CachedOperator[]>([]);
  useEffect(() => {
    // netChainId resolves immediately on load/network-switch (chainId lags one effect tick
    // behind AppKit, per use-web3.ts) — try it first, then fall back to chainId in case the
    // cache was written under whichever value operators-section.tsx saw at the time.
    try {
      const raw = localStorage.getItem(networkStorageKey('dg_cached_operators', netChainId))
        ?? (chainId ? localStorage.getItem(networkStorageKey('dg_cached_operators', chainId)) : null);
      setCachedOperators(raw ? JSON.parse(raw) : []);
    } catch { setCachedOperators([]); }
  }, [chainId, netChainId, sessionManagerAddress]);
  const activeOperator = cachedOperators.find(op => op.instance.toLowerCase() === (sessionManagerAddress || '').toLowerCase());

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
    setTxStatus({ status: 'pending', message: 'Finalizing operator points...', source: 'finalize' });
    try {
      const tx = await sendWithGasBuffer(contract, 'finalizeDailyPoints', [parseInt(finalizeDateKey)]);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...', source: 'finalize' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Operator finalized for dateKey ${finalizeDateKey} ✔`, source: 'finalize' });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e), source: 'finalize' });
    }
  };

  /* \u2500\u2500 Batch Update \u2500\u2500 */
  const handleBatchUpdate = async () => {
    if (!sessionManagerAddress) {
      setTxStatus({ status: 'error', error: 'No SessionManager instance loaded \u2014 select one from the Hub tab first.', source: 'batchUpdate' });
      return;
    }
    if (!signer) {
      setTxStatus({ status: 'error', error: 'Wallet not connected \u2014 click Connect Wallet and try again.', source: 'batchUpdate' });
      return;
    }
    if (!batchDateKey || !batchUsers || !batchPoints) {
      setTxStatus({ status: 'error', error: 'Fill in Date Key, User Addresses, and New Points first.', source: 'batchUpdate' });
      return;
    }
    const contract = getContract(true);
    if (!contract) {
      setTxStatus({ status: 'error', error: 'Could not create a contract instance \u2014 check your wallet connection and try again.', source: 'batchUpdate' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Batch updating points...', source: 'batchUpdate' });
    try {
      const users = batchUsers.split(',').map(s => s.trim()).filter(Boolean);
      let points: any[];
      try {
        points = batchPoints.split(',').map(s => ethers.utils.parseEther(s.trim()));
      } catch {
        setTxStatus({ status: 'error', error: 'New Points must be comma-separated numbers (e.g. "50, -10, 100").', source: 'batchUpdate' });
        return;
      }
      if (users.length === 0) {
        setTxStatus({ status: 'error', error: 'Enter at least one user address.', source: 'batchUpdate' });
        return;
      }
      if (users.length !== points.length) {
        setTxStatus({ status: 'error', error: `Users and points count must match (${users.length} users vs ${points.length} points).`, source: 'batchUpdate' });
        return;
      }
      for (const u of users) {
        if (!ethers.utils.isAddress(u)) {
          setTxStatus({ status: 'error', error: `"${u}" is not a valid Ethereum address.`, source: 'batchUpdate' });
          return;
        }
      }
      const tx = await contract.batchUpdateDailyUserPoints(parseInt(batchDateKey), users, points);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...', source: 'batchUpdate' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Updated ${users.length} user points`, source: 'batchUpdate' });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e), source: 'batchUpdate' });
    }
  };

  /* \u2500\u2500 Reduce Points (CSV batch) \u2500\u2500 */
  const updateReduceRow = (i: number, field: 'address' | 'amount', v: string) =>
    setReduceRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: v, ...(field === 'address' ? { balance: null } : {}) } : r));
  const addReduceRow = () => setReduceRows(prev => [...prev, blankReduceRow()]);
  const removeReduceRow = (i: number) => setReduceRows(prev => prev.filter((_, idx) => idx !== i));

  const handleReduceCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same file name
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { rows, error } = parseReducePointsCsv(String(reader.result || ''));
      if (error) { setTxStatus({ status: 'error', error: `CSV: ${error}`, source: 'reducePoints' }); return; }
      setReduceRows(rows);
      setTxStatus({ status: 'success', message: `Loaded ${rows.length} address(es) from CSV \u2014 fetch balances, then review amounts before submitting.`, source: 'reducePoints' });
    };
    reader.onerror = () => setTxStatus({ status: 'error', error: 'Failed to read CSV file.', source: 'reducePoints' });
    reader.readAsText(file);
  };

  /* \u2500\u2500 Fetch carry-forward balances for a given set of rows, merged back by address \u2500\u2500 */
  const fetchBalancesForRows = useCallback(async (rows: ReducePointsRow[]) => {
    const contract = getContract();
    if (!contract || rows.length === 0) return;
    setReduceBalancesLoading(true);
    try {
      const balances = await Promise.all(
        rows.map(r => contract.carryForwardPoints(r.address.trim()).catch(() => null))
      );
      setReduceRows(prev => prev.map(r => {
        const idx = rows.findIndex(v => v.address === r.address);
        if (idx === -1) return r;
        const bal = balances[idx];
        return { ...r, balance: bal === null ? 'Error' : ethers.utils.formatEther(bal) };
      }));
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e), source: 'reducePoints' });
    } finally {
      setReduceBalancesLoading(false);
    }
  }, [getContract]);

  /* \u2500\u2500 Manual "Fetch Balances" button \u2500\u2500 refetches every row with a valid address */
  const handleFetchReduceBalances = async () => {
    const validRows = reduceRows.filter(r => ethers.utils.isAddress(r.address.trim()));
    if (validRows.length === 0) {
      setTxStatus({ status: 'error', error: 'Enter or upload at least one valid address first.', source: 'reducePoints' });
      return;
    }
    await fetchBalancesForRows(validRows);
  };

  /* \u2500\u2500 Auto-fetch \u2500\u2500 debounced: as soon as a row has a valid address and no balance yet
   * (new row, pasted address, or freshly loaded from CSV), fetch it without waiting for the
   * admin to click "Fetch Balances". Rows that already have a balance (or an 'Error') are left
   * alone until their address changes \u2014 updateReduceRow resets balance to null on edit. */
  useEffect(() => {
    const pending = reduceRows.filter(r => r.balance === null && ethers.utils.isAddress(r.address.trim()));
    if (pending.length === 0 || reduceBalancesLoading) return;
    const timer = setTimeout(() => { fetchBalancesForRows(pending); }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceRows, reduceBalancesLoading]);

  const handleBatchReducePoints = async () => {
    if (!sessionManagerAddress) {
      setTxStatus({ status: 'error', error: 'No SessionManager instance loaded \u2014 select one from the Hub tab first.', source: 'reducePoints' });
      return;
    }
    if (!signer) {
      setTxStatus({ status: 'error', error: 'Wallet not connected \u2014 click Connect Wallet and try again.', source: 'reducePoints' });
      return;
    }
    const contract = getContract(true);
    if (!contract) {
      setTxStatus({ status: 'error', error: 'Could not create a contract instance \u2014 check your wallet connection and try again.', source: 'reducePoints' });
      return;
    }
    const rows = reduceRows.filter(r => r.address.trim() || r.amount.trim());
    if (rows.length === 0) {
      setTxStatus({ status: 'error', error: 'Add at least one address and amount to reduce.', source: 'reducePoints' });
      return;
    }
    for (const r of rows) {
      if (!ethers.utils.isAddress(r.address.trim())) {
        setTxStatus({ status: 'error', error: `"${r.address}" is not a valid Ethereum address.`, source: 'reducePoints' });
        return;
      }
      if (!r.amount.trim() || isNaN(Number(r.amount)) || Number(r.amount) <= 0) {
        setTxStatus({ status: 'error', error: `Enter a positive reduce amount for ${r.address}.`, source: 'reducePoints' });
        return;
      }
    }
    const users = rows.map(r => r.address.trim());
    let amounts: ethers.BigNumber[];
    try {
      amounts = rows.map(r => ethers.utils.parseEther(r.amount.trim()));
    } catch {
      setTxStatus({ status: 'error', error: 'Every amount must be a number.', source: 'reducePoints' });
      return;
    }
    setTxStatus({ status: 'pending', message: `Reducing points for ${users.length} address(es)...`, source: 'reducePoints' });
    try {
      const tx = await contract.batchReducePoints(users, amounts);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...', source: 'reducePoints' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Reduced points for ${users.length} address(es).`, source: 'reducePoints' });
      setReduceRows([blankReduceRow()]);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e), source: 'reducePoints' });
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
          {txStatus.source === 'finalize' && <TxStatus {...txStatus} chainId={chainId} />}
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
          {txStatus.source === 'batchUpdate' && <TxStatus {...txStatus} chainId={chainId} />}
        </div>
      </Card>

      {/* Reduce Points (Admin) */}
      <Card title="Reduce Points" icon={<MinusCircle className="w-5 h-5 text-red-400" />}>
        <p className="text-xs text-txt-secondary mb-3">Admin only — irreversibly deducts from each wallet&apos;s carry-forward point balance. Upload a CSV or add rows manually — balances load automatically once an address is valid. Review amounts before submitting.</p>

        <div className="flex items-center justify-between gap-3 flex-wrap bg-surface-tertiary rounded-lg p-3 mb-3">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <Network className="w-4 h-4 text-accent shrink-0" />
            <span className="text-txt-secondary shrink-0">Deducting on operator:</span>
            <span className="font-semibold truncate">
              {sessionManagerAddress ? (activeOperator?.name || 'Unknown — not in cached registry') : 'None loaded'}
            </span>
            {sessionManagerAddress && (
              <a href={getExplorerAddressUrl(chainId, sessionManagerAddress)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-accent shrink-0 hover:underline">
                <code className="font-mono">{sessionManagerAddress.slice(0, 6)}...{sessionManagerAddress.slice(-4)}</code>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          {cachedOperators.length > 1 ? (
            <select
              value={sessionManagerAddress || ''}
              onChange={(e) => setSessionManagerAddress(e.target.value)}
              className="bg-surface-secondary border border-white/10 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {cachedOperators.map(op => (
                <option key={op.instance} value={op.instance}>
                  {op.name || 'Unnamed'} ({op.instance.slice(0, 6)}...{op.instance.slice(-4)}){op.active ? '' : ' — deactivated'}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-txt-secondary">Switch instances from the Hub tab&apos;s Operator Registry.</span>
          )}
        </div>

        <div className="flex items-center gap-4 mb-3">
          <button type="button" onClick={downloadReducePointsTemplate} className="flex items-center gap-1 text-xs text-accent hover:underline">
            <Download className="w-3.5 h-3.5" /> Download template CSV
          </button>
          <button type="button" onClick={() => reduceCsvInputRef.current?.click()} className="flex items-center gap-1 text-xs text-accent hover:underline">
            <Upload className="w-3.5 h-3.5" /> Upload CSV
          </button>
          <input ref={reduceCsvInputRef} type="file" accept=".csv,text/csv" onChange={handleReduceCsvUpload} className="hidden" />
        </div>
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-[1fr_120px_140px_40px] gap-2 text-xs text-txt-secondary font-semibold px-1">
            <span>Address</span><span>Balance</span><span>Reduce By</span><span></span>
          </div>
          {reduceRows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_140px_40px] gap-2 items-center">
              <input value={r.address} onChange={(e) => updateReduceRow(i, 'address', e.target.value)} placeholder="0x..." className="bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
              <span className="text-sm text-center text-txt-secondary">{r.balance === null ? '—' : r.balance}</span>
              <input value={r.amount} onChange={(e) => updateReduceRow(i, 'amount', e.target.value)} placeholder="50" className="bg-surface-tertiary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              {reduceRows.length > 1 ? (
                <button onClick={() => removeReduceRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
              ) : <div />}
            </div>
          ))}
          <button onClick={addReduceRow} className="flex items-center gap-1 text-xs text-accent hover:underline mt-1">
            <Plus className="w-3.5 h-3.5" /> Add address
          </button>
        </div>
        <div className="flex gap-3">
          <button onClick={handleFetchReduceBalances} disabled={!isConnected || reduceBalancesLoading} className="flex-1 flex items-center justify-center gap-1.5 bg-surface-tertiary hover:bg-surface-tertiary/70 disabled:opacity-40 text-txt-primary font-semibold py-2.5 rounded-lg text-sm transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${reduceBalancesLoading ? 'animate-spin' : ''}`} /> Refresh Balances
          </button>
          <button onClick={handleBatchReducePoints} disabled={!isConnected} className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors">
            Reduce Points
          </button>
        </div>
        {txStatus.source === 'reducePoints' && <TxStatus {...txStatus} chainId={chainId} />}
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
    </div>
  );
}
