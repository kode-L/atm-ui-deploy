'use client';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { DEFAULT_TOKEN_VOID_ADDRESS, getExplorerAddressUrl, getExplorerTxUrl } from '@/lib/contracts/config';
import { Split, Plus, Trash2, RefreshCw, Send, Settings, ExternalLink, Copy, Check, X, History, Coins, ChevronDown, ChevronUp, Star, StarOff, User, Flame, Layers, Gauge } from 'lucide-react';
import SplitterArtifact from '@/lib/contracts/PaymentSplitter.json';
import SplitterProxyArtifact from '@/lib/contracts/PaymentSplitterProxy.json';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

interface PayeeRow {
  account: string;
  shareBps: string;
  label: string;
  isBurn: boolean;
  burnTypeId: string;
  percentDraft?: string; // transient raw text while the % input has focus, keeps it from snapping mid-typing
}

interface PayeeInfo {
  account: string;
  shareBps: number;
  label: string;
  isBurn: boolean;
  burnTypeId: number;
  viaVoid?: boolean; // whether the platform token would currently route through this payee's burnTokens
}

interface ShareChange {
  tier: number;
  changeId: number;
  updatedBy: string;
  payees: { account: string; shareBps: number; label: string; isBurn: boolean; burnTypeId: number }[];
  timestamp: number;
  txHash: string;
}

const bpsToPercentStr = (bps: string) => {
  const n = parseFloat(bps);
  return isNaN(n) ? '' : String(n / 100);
};

const blankRow = (): PayeeRow => ({ account: '', shareBps: '', label: '', isBurn: false, burnTypeId: '1' });

const copyAddr = (a: string) => { navigator.clipboard?.writeText(a); };

// Toggling Burn on prefills the platform's default void contract + type 1 (both
// editable) so the row isn't left pointing nowhere; toggling off clears the address
// since it was standing in for a void contract, not a real payee.
const toggleRowBurn = (setRow: (i: number, f: keyof PayeeRow, v: string | boolean) => void, idx: number, checked: boolean) => {
  setRow(idx, 'isBurn', checked);
  if (checked) {
    setRow(idx, 'account', DEFAULT_TOKEN_VOID_ADDRESS || '');
    setRow(idx, 'burnTypeId', '1');
  } else {
    setRow(idx, 'account', '');
  }
};

// Defined at module scope (not inside SplitterSection) so it keeps a stable component
// identity across renders — otherwise every parent re-render (e.g. on each keystroke)
// creates a new function/type, and React remounts the row's inputs, dropping focus
// after a single character.
const PayeeTable = ({ rows, setRow, addRow, removeRow, total, readOnly }: {
  rows: PayeeRow[];
  setRow: (i: number, f: keyof PayeeRow, v: string | boolean) => void;
  addRow: () => void;
  removeRow: (i: number) => void;
  total: number;
  readOnly?: boolean;
}) => (
  <div className="space-y-2">
    <div className="grid grid-cols-[1fr_90px_100px_50px_70px_40px] gap-2 text-xs text-txt-secondary font-semibold px-1">
      <span>Address</span><span>Share %</span><span>Label</span><span className="text-center">Burn</span><span className="text-center">Type ID</span><span></span>
    </div>
    {rows.map((r, i) => (
      <div key={i} className="grid grid-cols-[1fr_90px_100px_50px_70px_40px] gap-2 items-center">
        <input value={r.account} onChange={e => setRow(i, 'account', e.target.value)}
          placeholder={r.isBurn ? 'Void contract 0x...' : '0x... payee'}
          className="bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary font-mono" readOnly={readOnly} />
        <div>
          <input
            value={r.percentDraft !== undefined ? r.percentDraft : bpsToPercentStr(r.shareBps)}
            onChange={e => {
              const val = e.target.value;
              setRow(i, 'percentDraft', val);
              const num = parseFloat(val);
              if (!isNaN(num)) setRow(i, 'shareBps', String(Math.round(num * 100)));
            }}
            onBlur={() => setRow(i, 'percentDraft', undefined as unknown as string)}
            placeholder="50" type="text" inputMode="decimal"
            className="w-full bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary text-center" readOnly={readOnly} />
          <p className="text-[9px] text-txt-secondary text-center mt-0.5">{r.shareBps || '0'} bps</p>
        </div>
        <input value={r.label} onChange={e => setRow(i, 'label', e.target.value)}
          placeholder="Team" className="bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" readOnly={readOnly} />
        <div className="flex justify-center" title="Route this share through a void/burn contract instead of paying a real recipient">
          <input type="checkbox" checked={r.isBurn} disabled={readOnly}
            onChange={e => toggleRowBurn(setRow, i, e.target.checked)}
            className="w-4 h-4 accent-red-500" />
        </div>
        {r.isBurn ? (
          <input value={r.burnTypeId} onChange={e => setRow(i, 'burnTypeId', e.target.value)}
            placeholder="1" type="number" className="bg-surface-tertiary border border-white/10 rounded-lg px-2 py-2 text-sm text-txt-primary text-center" readOnly={readOnly} />
        ) : <div />}
        {!readOnly && rows.length > 1 ? (
          <button onClick={() => removeRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400">
            <Trash2 className="w-4 h-4" />
          </button>
        ) : <div />}
      </div>
    ))}
    {!readOnly && (
      <button onClick={addRow} className="flex items-center gap-1 text-xs text-accent hover:underline mt-1">
        <Plus className="w-3.5 h-3.5" /> Add payee
      </button>
    )}
    <div className={`text-xs font-semibold px-1 ${total === 10000 ? 'text-green-400' : 'text-red-400'}`}>
      Total: {(total / 100).toFixed(2)}% ({total} bps)
      {total === 10000 && <Check className="w-3.5 h-3.5 inline ml-1" />}
      {total !== 10000 && <X className="w-3.5 h-3.5 inline ml-1" />}
    </div>
  </div>
);

const PayeeSummaryTable = ({ list, tokenAddress }: { list: PayeeInfo[]; tokenAddress?: string }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-txt-secondary text-xs border-b border-white/10">
          <th className="py-2 px-2 text-left">#</th>
          <th className="py-2 px-2 text-left">Label</th>
          <th className="py-2 px-2 text-left">Address</th>
          <th className="py-2 px-2 text-center">Share</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p, i) => (
          <tr key={i} className="border-b border-white/5 hover:bg-surface-tertiary/50">
            <td className="py-2 px-2 text-txt-secondary">{i + 1}</td>
            <td className="py-2 px-2 text-txt-primary font-medium">
              {p.label || '—'}
              {p.isBurn && (
                <span
                  className="ml-1.5 text-[10px] bg-red-600/30 text-red-300 px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-0.5"
                  title={p.viaVoid ? 'Routes through this void contract’s burnTokens for the platform token' : 'Platform token doesn’t match this void contract’s testToken — falls back to a plain transfer'}
                >
                  <Flame className="w-2.5 h-2.5" /> Burn #{p.burnTypeId}{tokenAddress ? (p.viaVoid ? ' ✓' : ' ⚠︎') : ''}
                </span>
              )}
            </td>
            <td className="py-2 px-2 font-mono text-xs text-txt-primary">
              {p.account.slice(0, 8)}...{p.account.slice(-6)}
              <button onClick={() => copyAddr(p.account)} className="ml-1 text-txt-secondary hover:text-txt-primary inline"><Copy className="w-3 h-3 inline" /></button>
            </td>
            <td className="py-2 px-2 text-center">
              <span className="text-accent font-bold">{(p.shareBps / 100).toFixed(1)}%</span>
              <span className="text-txt-secondary text-[10px] ml-1">({p.shareBps} bps)</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function SplitterSection() {
  const { signer, provider, isConnected, address, tokenAddress, splitters, activeSplitter, addSplitter, removeSplitter, setActiveSplitter, walletRole, operatorInstance, operatorName, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string }>({ status: 'idle' });

  // Which splitter is currently being viewed
  const [viewAddr, setViewAddr] = useState('');
  const [ownSplitterAddr, setOwnSplitterAddr] = useState('');
  const [ownSplitterLoading, setOwnSplitterLoading] = useState(false);
  // Guards the auto-load below so it fires once per (wallet, instance) pair rather
  // than re-running (or clobbering a manual selection) on every render.
  const autoLoadedFor = useRef('');

  // Deploy state (tier 0 only — further tiers + staging are configured after deploy)
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployLabel, setDeployLabel] = useState('');
  const [deployRows, setDeployRows] = useState<PayeeRow[]>([
    { account: '', shareBps: '5000', label: 'Team', isBurn: false, burnTypeId: '1' },
    { account: '', shareBps: '3000', label: 'Treasury', isBurn: false, burnTypeId: '1' },
    { account: '', shareBps: '2000', label: 'Development', isBurn: false, burnTypeId: '1' },
  ]);

  // Load existing
  const [showLoad, setShowLoad] = useState(false);
  const [loadAddr, setLoadAddr] = useState('');
  const [loadLabel, setLoadLabel] = useState('');

  // Viewed splitter state
  const [tierCountVal, setTierCountVal] = useState(0);
  const [tierPayeesList, setTierPayeesList] = useState<PayeeInfo[][]>([]); // index = tier
  const [pendingToken, setPendingToken] = useState('0');
  const [pendingNative, setPendingNative] = useState('0');
  const [totalDistToken, setTotalDistToken] = useState('0');
  const [totalDistNative, setTotalDistNative] = useState('0');
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);
  const [shareChangeCount, setShareChangeCount] = useState(0);

  // Daily burn staging: ascending list of per-token burn-amount boundaries.
  // thresholds[i] is where tier i hands off to tier i+1.
  const [thresholds, setThresholds] = useState<string[]>([]);
  const [burnedTodayVal, setBurnedTodayVal] = useState('0');
  const [editingThresholds, setEditingThresholds] = useState(false);
  const [thresholdRows, setThresholdRows] = useState<string[]>([]);

  // Custom token
  const [customTokenAddr, setCustomTokenAddr] = useState('');
  const [customTokenBal, setCustomTokenBal] = useState<string | null>(null);

  // Tier tabs / edit mode — one tier at a time
  const [activeTier, setActiveTier] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [editRows, setEditRows] = useState<PayeeRow[]>([]);

  // New tier draft (tiers are append-only on-chain via addTier)
  const [showNewTierForm, setShowNewTierForm] = useState(false);
  const [newTierRows, setNewTierRows] = useState<PayeeRow[]>([blankRow()]);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [shareHistory, setShareHistory] = useState<ShareChange[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const getReadContract = useCallback((addr: string) => {
    if (!provider || !addr) return null;
    return new ethers.Contract(addr, SplitterArtifact.abi, provider);
  }, [provider]);

  const getWriteContract = useCallback((addr: string) => {
    if (!signer || !addr) return null;
    return new ethers.Contract(addr, SplitterArtifact.abi, signer);
  }, [signer]);

  // Fetch data for viewed splitter
  const fetchData = useCallback(async (addr?: string) => {
    const target = addr || viewAddr;
    const c = getReadContract(target);
    if (!c) return;
    setLoading(true);
    try {
      const tierCountRaw = await c.tierCount();
      const count = tierCountRaw?.toNumber?.() ?? Number(tierCountRaw);

      const promises: Promise<any>[] = [
        ...Array.from({ length: count }, (_, i) => c.getAllPayees(i)),
        c.pendingNative(),
        c.totalDistributed(ethers.constants.AddressZero),
        c.owner(),
        c.shareChangeCount(),
      ];
      if (tokenAddress) {
        promises.push(c.pendingERC20(tokenAddress));
        promises.push(c.totalDistributed(tokenAddress));
        promises.push(c.getDailyBurnThresholds(tokenAddress));
        promises.push(c.burnedToday(tokenAddress));
      }
      const results = await Promise.all(promises);
      const rawTiers = results.slice(0, count);
      const [nativePend, nativeDist, own, changeCount] = results.slice(count, count + 4);

      const mapPayees = (raw: any[]): PayeeInfo[] => raw.map((p: any) => ({
        account: p.account,
        shareBps: Number(p.shareBps),
        label: p.label,
        isBurn: !!p.isBurn,
        burnTypeId: p.burnTypeId?.toNumber?.() ?? Number(p.burnTypeId),
      }));
      const tierInfos = rawTiers.map(mapPayees);

      // Each burn payee's `account` is its own void contract — check per-payee whether
      // the platform token would actually route through burnTokens on it.
      if (tokenAddress) {
        await Promise.all(tierInfos.map(async (infos, tierIdx) => {
          const viaChecks = await Promise.all(
            infos.map((p, i) => p.isBurn ? c.burnsViaVoid(tierIdx, i, tokenAddress).catch(() => false) : Promise.resolve(false))
          );
          infos.forEach((p, i) => { p.viaVoid = !!viaChecks[i]; });
        }));

        const erc20Pend = results[count + 4];
        const erc20Dist = results[count + 5];
        const thresholdsRaw: any[] = results[count + 6];
        const burnedRaw = results[count + 7];
        setPendingToken(erc20Pend ? ethers.utils.formatUnits(erc20Pend, 18) : '0');
        setTotalDistToken(erc20Dist ? ethers.utils.formatUnits(erc20Dist, 18) : '0');
        setThresholds(thresholdsRaw.map((t: any) => ethers.utils.formatUnits(t, 18)));
        setBurnedTodayVal(ethers.utils.formatUnits(burnedRaw, 18));
      } else {
        setPendingToken('0');
        setTotalDistToken('0');
        setThresholds([]);
        setBurnedTodayVal('0');
      }

      setTierCountVal(count);
      setTierPayeesList(tierInfos);
      setPendingNative(ethers.utils.formatEther(nativePend));
      setTotalDistNative(ethers.utils.formatEther(nativeDist));
      setOwner(own);
      setShareChangeCount(Number(changeCount));
      setActiveTier(prev => Math.min(prev, Math.max(0, count - 1)));
    } catch (e: any) {
      console.error('fetch splitter:', e);
    } finally {
      setLoading(false);
    }
  }, [getReadContract, tokenAddress, viewAddr]);

  // When viewAddr changes, fetch data
  React.useEffect(() => {
    if (viewAddr) {
      fetchData(viewAddr);
      setEditMode(false);
      setShowNewTierForm(false);
      setEditingThresholds(false);
      setShowHistory(false);
      setShareHistory([]);
      setCustomTokenBal(null);
    }
  }, [viewAddr]); // eslint-disable-line react-hooks/exhaustive-deps

  // For operator wallets, auto-load the splitter already registered on their own
  // operator profile — no need to deploy/load anything manually. Fires once per
  // (wallet, instance) pair so it doesn't override a manual selection afterward.
  useEffect(() => {
    const isOperatorRole = walletRole === 'operator' || walletRole === 'admin+operator';
    if (!isOperatorRole || !operatorInstance || !address || !provider) return;
    const key = `${address.toLowerCase()}:${operatorInstance.toLowerCase()}`;
    if (autoLoadedFor.current === key) return;
    autoLoadedFor.current = key;

    (async () => {
      setOwnSplitterLoading(true);
      try {
        const instance = new ethers.Contract(operatorInstance, SessionManagerArtifact.abi, provider);
        const profile = await instance.getOperatorProfile(address);
        const splitterAddr: string = profile?.splitterAddress;
        if (splitterAddr && splitterAddr !== ethers.constants.AddressZero) {
          setOwnSplitterAddr(splitterAddr);
          const alreadyTracked = splitters.some(s => s.address.toLowerCase() === splitterAddr.toLowerCase());
          if (!alreadyTracked) addSplitter(splitterAddr, `${operatorName || 'My'} Splitter`);
          setViewAddr(splitterAddr);
        }
      } catch { /* profile may not exist yet on this instance */ }
      setOwnSplitterLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletRole, operatorInstance, address, provider]);

  // Fetch history
  const fetchHistory = useCallback(async () => {
    if (!provider || !viewAddr) return;
    setHistoryLoading(true);
    try {
      const c = new ethers.Contract(viewAddr, SplitterArtifact.abi, provider);
      const filter = c.filters.PayeesUpdated();
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50000);
      const events = await c.queryFilter(filter, fromBlock, 'latest');
      const changes: ShareChange[] = events.map(e => {
        const args = (e as any).args;
        return {
          tier: Number(args.tierIndex),
          changeId: Number(args.changeId),
          updatedBy: args.updatedBy,
          payees: args.payees.map((p: any) => ({
            account: p.account, shareBps: Number(p.shareBps), label: p.label,
            isBurn: !!p.isBurn, burnTypeId: p.burnTypeId?.toNumber?.() ?? Number(p.burnTypeId),
          })),
          timestamp: Number(args.timestamp),
          txHash: e.transactionHash,
        };
      });
      setShareHistory(changes.reverse());
    } catch (e: any) {
      console.error('fetch history:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [provider, viewAddr]);

  // Validates a payee row set before deploy/save. A burn payee's `account` is treated
  // as a void/burn contract (not the bare dead address) — the actual "is this really a
  // burn contract" check happens on-chain (updatePayees calls its burnTypeCount()).
  const validatePayeeRows = (accounts: string[], burnFlags: boolean[], burnTypeIds: number[]): string | null => {
    for (let i = 0; i < accounts.length; i++) {
      if (!ethers.utils.isAddress(accounts[i])) {
        return `Invalid address in row ${i + 1}: ${accounts[i]}`;
      }
      if (burnFlags[i]) {
        if (!burnTypeIds[i] || burnTypeIds[i] < 1) {
          return `Row ${i + 1} is marked Burn but has no Burn Type ID.`;
        }
      } else if (accounts[i].toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
        return `Row ${i + 1} uses the dead address but isn't marked Burn — check the Burn box for that row.`;
      }
    }
    return null;
  };

  // Deploy — PaymentSplitter is UUPS-upgradeable: deploy the implementation, then a
  // PaymentSplitterProxy whose constructor calls initialize(owner, accounts, shares,
  // labels, isBurnFlags, burnTypeIds) for tier 0. 2 transactions. Further tiers + daily
  // burn staging are configured afterward from the detail view below.
  const handleDeploy = async () => {
    if (!signer) return;
    const accounts = deployRows.map(r => r.account.trim());
    const shares = deployRows.map(r => parseInt(r.shareBps));
    const labels = deployRows.map(r => r.label.trim());
    const isBurnFlags = deployRows.map(r => r.isBurn);
    const burnTypeIds = deployRows.map(r => parseInt(r.burnTypeId) || 0);
    const totalBps = shares.reduce((a, b) => a + b, 0);
    if (totalBps !== 10000) {
      setTxStatus({ status: 'error', error: `Shares must total 10000 bps (100%). Currently ${totalBps}` });
      return;
    }
    const validationError = validatePayeeRows(accounts, isBurnFlags, burnTypeIds);
    if (validationError) {
      setTxStatus({ status: 'error', error: validationError });
      return;
    }
    try {
      setTxStatus({ status: 'pending', message: '1/2 Deploying PaymentSplitter implementation...' });
      const factory = new ethers.ContractFactory(SplitterArtifact.abi, SplitterArtifact.bytecode, signer);
      const implementation = await factory.deploy();
      await implementation.deployed();

      setTxStatus({ status: 'pending', message: '2/2 Deploying proxy + initializing Tier 0...' });
      const connectedAddr = await signer.getAddress();
      const iface = new ethers.utils.Interface(SplitterArtifact.abi);
      const initData = iface.encodeFunctionData('initialize', [connectedAddr, accounts, shares, labels, isBurnFlags, burnTypeIds]);
      const proxyFactory = new ethers.ContractFactory(SplitterProxyArtifact.abi, SplitterProxyArtifact.bytecode, signer);
      const proxy = await proxyFactory.deploy(implementation.address, initData);
      setTxStatus({ status: 'pending', hash: proxy.deployTransaction.hash, message: '2/2 Waiting for confirmation...' });
      await proxy.deployed();

      const label = deployLabel.trim() || `Splitter ${splitters.length + 1}`;
      addSplitter(proxy.address, label);
      setViewAddr(proxy.address);
      setShowDeploy(false);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction.hash, message: `PaymentSplitter deployed at ${proxy.address}` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Load existing
  const handleLoad = () => {
    if (!ethers.utils.isAddress(loadAddr.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid splitter address' });
      return;
    }
    const label = loadLabel.trim() || `Splitter ${splitters.length + 1}`;
    addSplitter(loadAddr.trim(), label);
    setViewAddr(loadAddr.trim());
    setShowLoad(false);
    setLoadAddr('');
    setLoadLabel('');
    setTxStatus({ status: 'idle' });
  };

  // Remove from UI
  const handleRemove = (addr: string) => {
    removeSplitter(addr);
    if (viewAddr.toLowerCase() === addr.toLowerCase()) {
      setViewAddr('');
      setTierPayeesList([]);
      setTierCountVal(0);
    }
  };

  // Release handlers
  const handleReleaseERC20 = async () => {
    const c = getWriteContract(viewAddr);
    if (!c || !tokenAddress) return;
    setTxStatus({ status: 'pending', message: 'Releasing ERC-20 points...' });
    try {
      const tx = await c.releaseERC20(tokenAddress);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'ERC-20 points distributed!' });
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleReleaseNative = async () => {
    const c = getWriteContract(viewAddr);
    if (!c) return;
    setTxStatus({ status: 'pending', message: 'Releasing native BNB...' });
    try {
      const tx = await c.releaseNative();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Native BNB distributed!' });
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleCheckCustomToken = async () => {
    const c = getReadContract(viewAddr);
    if (!c || !ethers.utils.isAddress(customTokenAddr.trim())) return;
    try {
      const bal = await c.pendingERC20(customTokenAddr.trim());
      setCustomTokenBal(ethers.utils.formatUnits(bal, 18));
    } catch { setCustomTokenBal('Error'); }
  };

  const handleReleaseCustomToken = async () => {
    const c = getWriteContract(viewAddr);
    if (!c || !ethers.utils.isAddress(customTokenAddr.trim())) return;
    setTxStatus({ status: 'pending', message: 'Releasing custom ERC-20...' });
    try {
      const tx = await c.releaseERC20(customTokenAddr.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Custom ERC-20 distributed!' });
      setCustomTokenBal(null);
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Daily burn thresholds (ascending boundaries, per platform token)
  const startEditThresholds = () => {
    setThresholdRows(thresholds.length > 0 ? [...thresholds] : ['']);
    setEditingThresholds(true);
  };
  const addThresholdRow = () => setThresholdRows(prev => [...prev, '']);
  const removeThresholdRow = (idx: number) => setThresholdRows(prev => prev.filter((_, i) => i !== idx));
  const updateThresholdRow = (idx: number, val: string) => setThresholdRows(prev => prev.map((v, i) => i === idx ? val : v));

  const handleSaveThresholds = async () => {
    const c = getWriteContract(viewAddr);
    if (!c || !tokenAddress) return;
    const filtered = thresholdRows.map(v => v.trim()).filter(v => v !== '');
    let raw;
    try { raw = filtered.map(v => ethers.utils.parseUnits(v, 18)); } catch {
      setTxStatus({ status: 'error', error: 'Invalid threshold amount' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Updating daily burn thresholds...' });
    try {
      const tx = await c.setDailyBurnThresholds(tokenAddress, raw);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: raw.length === 0 ? 'Staging disabled for this token' : 'Daily burn thresholds updated' });
      setEditingThresholds(false);
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Edit an existing tier's payees
  const startEdit = (tierIndex: number) => {
    setActiveTier(tierIndex);
    const source = tierPayeesList[tierIndex] || [];
    setEditRows(source.length > 0
      ? source.map(p => ({ account: p.account, shareBps: String(p.shareBps), label: p.label, isBurn: p.isBurn, burnTypeId: String(p.burnTypeId || 1) }))
      : [blankRow()]);
    setEditMode(true);
    setShowNewTierForm(false);
  };

  const handleSavePayees = async () => {
    const c = getWriteContract(viewAddr);
    if (!c) return;
    const accounts = editRows.map(r => r.account.trim());
    const shares = editRows.map(r => parseInt(r.shareBps));
    const labels = editRows.map(r => r.label.trim());
    const isBurnFlags = editRows.map(r => r.isBurn);
    const burnTypeIds = editRows.map(r => parseInt(r.burnTypeId) || 0);
    const totalBps = shares.reduce((a, b) => a + b, 0);
    if (totalBps !== 10000) {
      setTxStatus({ status: 'error', error: `Shares must total 10000 bps. Currently ${totalBps}` });
      return;
    }
    const validationError = validatePayeeRows(accounts, isBurnFlags, burnTypeIds);
    if (validationError) {
      setTxStatus({ status: 'error', error: validationError });
      return;
    }
    setTxStatus({ status: 'pending', message: `Updating Tier ${activeTier} payees on-chain...` });
    try {
      const tx = await c.updatePayees(activeTier, accounts, shares, labels, isBurnFlags, burnTypeIds);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Payees updated!' });
      setEditMode(false);
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // New tier draft — starts as a copy of Tier 0's current payees (usually the same
  // people, just reweighted or with a different burn cut), which you adjust before
  // committing on-chain via addTier.
  const openNewTierForm = () => {
    const source = tierPayeesList[0] || [];
    setNewTierRows(source.length > 0
      ? source.map(p => ({ account: p.account, shareBps: String(p.shareBps), label: p.label, isBurn: p.isBurn, burnTypeId: String(p.burnTypeId || 1) }))
      : [blankRow()]);
    setShowNewTierForm(true);
    setEditMode(false);
  };

  const handleAddTier = async () => {
    const c = getWriteContract(viewAddr);
    if (!c) return;
    const accounts = newTierRows.map(r => r.account.trim());
    const shares = newTierRows.map(r => parseInt(r.shareBps));
    const labels = newTierRows.map(r => r.label.trim());
    const isBurnFlags = newTierRows.map(r => r.isBurn);
    const burnTypeIds = newTierRows.map(r => parseInt(r.burnTypeId) || 0);
    const totalBps = shares.reduce((a, b) => a + b, 0);
    if (totalBps !== 10000) {
      setTxStatus({ status: 'error', error: `Shares must total 10000 bps. Currently ${totalBps}` });
      return;
    }
    const validationError = validatePayeeRows(accounts, isBurnFlags, burnTypeIds);
    if (validationError) {
      setTxStatus({ status: 'error', error: validationError });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Adding new tier...' });
    try {
      const tx = await c.addTier(accounts, shares, labels, isBurnFlags, burnTypeIds);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: 'Tier added!' });
      setShowNewTierForm(false);
      await fetchData();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Row helpers
  const updateDeployRow = (idx: number, field: keyof PayeeRow, val: string | boolean) => setDeployRows(prev => prev.map((r, i) => i === idx ? ({ ...r, [field]: val } as PayeeRow) : r));
  const addDeployRow = () => setDeployRows(prev => [...prev, blankRow()]);
  const removeDeployRow = (idx: number) => setDeployRows(prev => prev.filter((_, i) => i !== idx));
  const updateEditRow = (idx: number, field: keyof PayeeRow, val: string | boolean) => setEditRows(prev => prev.map((r, i) => i === idx ? ({ ...r, [field]: val } as PayeeRow) : r));
  const addEditRow = () => setEditRows(prev => [...prev, blankRow()]);
  const removeEditRow = (idx: number) => setEditRows(prev => prev.filter((_, i) => i !== idx));
  const updateNewTierRow = (idx: number, field: keyof PayeeRow, val: string | boolean) => setNewTierRows(prev => prev.map((r, i) => i === idx ? ({ ...r, [field]: val } as PayeeRow) : r));
  const addNewTierRow = () => setNewTierRows(prev => [...prev, blankRow()]);
  const removeNewTierRow = (idx: number) => setNewTierRows(prev => prev.filter((_, i) => i !== idx));

  const deployTotal = deployRows.reduce((a, r) => a + (parseInt(r.shareBps) || 0), 0);
  const editTotal = editRows.reduce((a, r) => a + (parseInt(r.shareBps) || 0), 0);
  const newTierTotal = newTierRows.reduce((a, r) => a + (parseInt(r.shareBps) || 0), 0);
  const formatDate = (ts: number) => { try { return new Date(ts * 1000).toLocaleString(); } catch { return String(ts); } };

  const viewedSplitter = splitters.find(s => s.address.toLowerCase() === viewAddr.toLowerCase());
  // Only the admin can deploy/load splitters here — a pure operator's splitter is
  // whatever their profile is registered with (set by the admin), so Deploy/Load
  // are hidden for them. admin+operator wallets keep full access via the admin half.
  const isPureOperator = walletRole === 'operator';
  const isOwnerConnected = !!(isConnected && owner && address?.toLowerCase() === owner.toLowerCase());
  const stagingEnabled = thresholds.length > 0;
  const activeTiersForToken = thresholds.length + 1;
  const finalThreshold = thresholds.length > 0 ? parseFloat(thresholds[thresholds.length - 1]) : 0;
  const burnedPct = stagingEnabled && finalThreshold > 0 ? Math.min(100, (parseFloat(burnedTodayVal) / finalThreshold) * 100) : 0;

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* Splitter List */}
      <Card title={
        <span className="flex items-center gap-2">
          Your Payment Splitters
          <span className="text-xs text-txt-secondary font-normal">({splitters.length})</span>
        </span>
      } icon={<Split className="w-5 h-5 text-purple-400" />}>
        {ownSplitterLoading && splitters.length === 0 && (
          <p className="text-sm text-txt-secondary flex items-center gap-1.5 mb-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading your registered splitter…</p>
        )}
        {splitters.length === 0 ? (
          !ownSplitterLoading && (
            <p className="text-sm text-txt-secondary">
              {isPureOperator
                ? 'No splitter is registered on your operator profile yet — ask the admin to set one for you.'
                : (walletRole === 'admin+operator')
                ? 'No splitter is registered on your operator profile yet — ask the admin to set one, or deploy a new one below and hand them the address.'
                : 'No splitters added yet. Deploy a new one or load an existing contract address.'}
            </p>
          )
        ) : (
          <div className="space-y-2 mb-4">
            {splitters.map(s => {
              const isActive = activeSplitter.toLowerCase() === s.address.toLowerCase();
              const isViewing = viewAddr.toLowerCase() === s.address.toLowerCase();
              const isOwn = !!ownSplitterAddr && s.address.toLowerCase() === ownSplitterAddr.toLowerCase();
              return (
                <div key={s.address} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                  isViewing ? 'bg-purple-900/30 border-purple-600/50' : 'bg-surface-tertiary border-white/5 hover:border-white/15'
                }`}>
                  {/* Active indicator */}
                  <button onClick={() => setActiveSplitter(isActive ? '' : s.address)}
                    title={isActive ? 'Active for finalize (click to deactivate)' : 'Set as active for finalize'}
                    className={`shrink-0 ${isActive ? 'text-yellow-400' : 'text-txt-secondary hover:text-yellow-400'}`}>
                    {isActive ? <Star className="w-4 h-4 fill-yellow-400" /> : <StarOff className="w-4 h-4" />}
                  </button>

                  {/* Info */}
                  <button onClick={() => setViewAddr(isViewing ? '' : s.address)} className="flex-1 text-left min-w-0">
                    <p className="text-sm font-medium text-txt-primary truncate">{s.label}</p>
                    <p className="text-[10px] font-mono text-txt-secondary truncate">{s.address}</p>
                  </button>

                  {/* Badges */}
                  {isOwn && <span className="text-[10px] bg-purple-600/30 text-purple-300 px-1.5 py-0.5 rounded font-semibold shrink-0 flex items-center gap-1"><User className="w-3 h-3" /> Your Splitter</span>}
                  {isActive && <span className="text-[10px] bg-yellow-600/30 text-yellow-300 px-1.5 py-0.5 rounded font-semibold shrink-0">Active</span>}

                  {/* Actions */}
                  <a href={getExplorerAddressUrl(chainId, s.address)} target="_blank" rel="noopener noreferrer"
                    className="text-txt-secondary hover:text-purple-400 shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>
                  <button onClick={() => copyAddr(s.address)} className="text-txt-secondary hover:text-txt-primary shrink-0"><Copy className="w-3.5 h-3.5" /></button>
                  <button onClick={() => handleRemove(s.address)} title="Remove from UI"
                    className="text-txt-secondary hover:text-red-400 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              );
            })}
          </div>
        )}

        {/* Deploy/Load — admin only. A pure operator's splitter is whatever their
            profile is registered with (set by the admin); deploying a new one here
            wouldn't do anything until the admin points their profile at it. */}
        {!isPureOperator && (
          <>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => { setShowDeploy(!showDeploy); setShowLoad(false); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-semibold transition-colors">
                <Plus className="w-4 h-4" /> Deploy New
              </button>
              <button onClick={() => { setShowLoad(!showLoad); setShowDeploy(false); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary/80 text-txt-primary text-sm font-semibold transition-colors border border-white/10">
                <Settings className="w-4 h-4" /> Load Existing
              </button>
            </div>

            {/* Deploy form */}
            {showDeploy && (
              <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-purple-700/30 space-y-3">
                <h4 className="text-sm font-semibold text-purple-300">Deploy New Payment Splitter</h4>
                <p className="text-xs text-txt-secondary">Supports any ERC-20 token and native BNB. Define Tier 0&apos;s payees and shares (must total 100%). Check &quot;Burn&quot; on a row to route its share through a void/burn contract instead of paying a real recipient. Further tiers and daily burn staging can be added after deploying.</p>
                <div>
                  <label className="text-xs text-txt-secondary">Label (for your reference)</label>
                  <input value={deployLabel} onChange={e => setDeployLabel(e.target.value)}
                    placeholder="e.g. Main Revenue Split" className="w-full mt-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" />
                </div>
                <PayeeTable rows={deployRows} setRow={updateDeployRow} addRow={addDeployRow} removeRow={removeDeployRow} total={deployTotal} />
                <button onClick={handleDeploy} disabled={!isConnected || deployTotal !== 10000}
                  className="w-full py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
                  Deploy Splitter
                </button>
              </div>
            )}

            {/* Load form */}
            {showLoad && (
              <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-white/10 space-y-3">
                <h4 className="text-sm font-semibold text-txt-primary">Load Existing Splitter</h4>
                <div className="flex gap-2">
                  <input value={loadAddr} onChange={e => setLoadAddr(e.target.value)}
                    placeholder="0x... contract address" className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary font-mono" />
                  <input value={loadLabel} onChange={e => setLoadLabel(e.target.value)}
                    placeholder="Label" className="w-32 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" />
                </div>
                <button onClick={handleLoad} className="px-4 py-2 rounded-lg bg-accent text-black text-sm font-semibold hover:bg-yellow-400 transition-colors">
                  Add Splitter
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* =============== Splitter Detail View =============== */}
      {viewAddr && viewedSplitter && (
        <>
          {/* Banner */}
          <div className="bg-purple-900/20 border border-purple-700/40 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <Split className="w-5 h-5 text-purple-400 shrink-0" />
            <span className="text-purple-300 text-sm font-medium">Viewing: {viewedSplitter.label}</span>
            <code className="text-purple-200 text-xs font-mono break-all">{viewAddr}</code>
            <button onClick={() => setViewAddr('')} className="ml-auto text-txt-secondary hover:text-txt-primary text-xs">Close</button>
          </div>

          {/* Overview */}
          <Card title={
            <span className="flex items-center gap-2">
              Splitter Overview
              <button onClick={() => fetchData()} disabled={loading} className="p-1 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-4 h-4 text-txt-secondary ${loading ? 'animate-spin' : ''}`} />
              </button>
            </span>
          } icon={<Split className="w-5 h-5 text-purple-400" />}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-xs text-txt-secondary">ERC-20 Pending</p>
                <p className="text-lg font-bold text-accent">{parseFloat(pendingToken).toFixed(4)}</p>
                <p className="text-[10px] text-txt-secondary">Distributed: {parseFloat(totalDistToken).toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Native BNB Pending</p>
                <p className="text-lg font-bold text-yellow-400">{parseFloat(pendingNative).toFixed(6)}</p>
                <p className="text-[10px] text-txt-secondary">Distributed: {parseFloat(totalDistNative).toFixed(6)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Daily Burn Staging</p>
                <p className={`text-lg font-bold ${stagingEnabled ? 'text-red-400' : 'text-txt-secondary'}`}>{stagingEnabled ? 'ON' : 'OFF'}</p>
                <p className="text-[10px] text-txt-secondary">{stagingEnabled ? `${activeTiersForToken} of ${tierCountVal} tiers active` : `${tierCountVal} tier(s) defined`}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Owner</p>
                <p className="text-xs font-mono text-txt-primary break-all">{owner?.slice(0, 10)}...{owner?.slice(-6)}</p>
              </div>
            </div>

            {/* Tier 0 payees (the default split) */}
            <PayeeSummaryTable list={tierPayeesList[0] || []} tokenAddress={tokenAddress} />

            {/* Release */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button onClick={handleReleaseERC20} disabled={!isConnected || !tokenAddress || parseFloat(pendingToken) === 0}
                className="py-2.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                <Send className="w-4 h-4" /> Release {parseFloat(pendingToken).toFixed(4)} ERC-20
              </button>
              <button onClick={handleReleaseNative} disabled={!isConnected || parseFloat(pendingNative) === 0}
                className="py-2.5 rounded-lg bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                <Coins className="w-4 h-4" /> Release {parseFloat(pendingNative).toFixed(6)} BNB
              </button>
            </div>
          </Card>

          {/* Daily Burn Staging */}
          <Card title="Daily Burn Staging" icon={<Gauge className="w-5 h-5 text-red-400" />}>
            <p className="text-xs text-txt-secondary mb-3">
              Each boundary is where one tier hands off to the next once today&apos;s burned total for the platform token crosses it — tier 0 → tier 1 at boundary 1, tier 1 → tier 2 at boundary 2, and so on. A release straddling a boundary splits proportionally and can cascade through several tiers in one call. Resets every UTC day. Needs enough tiers added below to reach as many boundaries as you set.
            </p>
            {tokenAddress ? (
              <>
                <div className="mb-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-txt-secondary">Burned today</span>
                    <span className="text-txt-primary font-mono">{parseFloat(burnedTodayVal).toFixed(4)}{finalThreshold > 0 ? ` / ${finalThreshold.toFixed(4)}` : ''}</span>
                  </div>
                  {finalThreshold > 0 && (
                    <div className="h-2 rounded-full bg-surface-tertiary overflow-hidden">
                      <div className={`h-full rounded-full ${burnedPct >= 100 ? 'bg-red-500' : 'bg-yellow-500'}`} style={{ width: `${burnedPct}%` }} />
                    </div>
                  )}
                </div>

                {thresholds.length > 0 && !editingThresholds && (
                  <div className="space-y-1 mb-3">
                    {thresholds.map((t, i) => {
                      const crossed = parseFloat(burnedTodayVal) >= parseFloat(t);
                      return (
                        <div key={i} className="flex items-center justify-between text-xs bg-surface-tertiary rounded-lg px-3 py-1.5">
                          <span className="text-txt-secondary">Tier {i} → Tier {i + 1}</span>
                          <span className={`font-mono flex items-center gap-1 ${crossed ? 'text-red-400' : 'text-txt-primary'}`}>
                            {parseFloat(t).toFixed(4)} {crossed && <Check className="w-3 h-3" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {isOwnerConnected && (
                  editingThresholds ? (
                    <div className="space-y-2">
                      {thresholdRows.map((v, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <span className="text-xs text-txt-secondary w-20 shrink-0">{i} → {i + 1}:</span>
                          <input value={v} onChange={e => updateThresholdRow(i, e.target.value)} type="number" placeholder="e.g. 500"
                            className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" />
                          <button onClick={() => removeThresholdRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <button onClick={addThresholdRow} disabled={thresholdRows.length + 1 >= tierCountVal}
                        className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40 disabled:no-underline">
                        <Plus className="w-3.5 h-3.5" /> Add boundary
                      </button>
                      {thresholdRows.length + 1 > tierCountVal && (
                        <p className="text-[11px] text-yellow-400">Only {tierCountVal} tier(s) exist — add more tiers below before using this many boundaries.</p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button onClick={handleSaveThresholds} className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors">
                          Save
                        </button>
                        <button onClick={() => setEditingThresholds(false)} className="px-4 py-2 rounded-lg bg-surface-tertiary text-txt-secondary text-sm font-semibold hover:text-txt-primary transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={startEditThresholds}
                      className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors">
                      {thresholds.length > 0 ? 'Edit Boundaries' : 'Set Up Staging'}
                    </button>
                  )
                )}
              </>
            ) : (
              <p className="text-sm text-txt-secondary">Load the platform token (Deploy tab) to configure staging.</p>
            )}
          </Card>

          {/* Custom Token */}
          <Card title="Release Other ERC-20 Token" icon={<Coins className="w-5 h-5 text-blue-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Check and release any ERC-20 token held by this splitter.</p>
            <div className="flex gap-2 mb-2">
              <input value={customTokenAddr} onChange={e => { setCustomTokenAddr(e.target.value); setCustomTokenBal(null); }}
                placeholder="0x... token contract address" className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary font-mono" />
              <button onClick={handleCheckCustomToken} disabled={!isConnected || !customTokenAddr}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
                Check
              </button>
            </div>
            {customTokenBal !== null && (
              <div className="flex items-center gap-3">
                <p className="text-sm text-txt-primary">Balance: <span className="font-bold text-accent">{customTokenBal}</span></p>
                {customTokenBal !== 'Error' && parseFloat(customTokenBal) > 0 && (
                  <button onClick={handleReleaseCustomToken}
                    className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-semibold transition-colors">
                    Release
                  </button>
                )}
              </div>
            )}
          </Card>

          {/* Payee Tiers — dynamic list, append-only */}
          <Card title="Payee Tiers" icon={<Layers className="w-5 h-5 text-yellow-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Only the contract owner can update. All changes recorded on-chain. A Burn row&apos;s address is a void/burn contract (validated on-chain against its own burn-type catalog when saved) — not the bare dead address. Tiers are append-only; to stop using tiers beyond a point, shorten the boundaries above rather than emptying a tier.</p>

            <div className="flex gap-1 mb-3 bg-surface-tertiary rounded-lg p-1 flex-wrap w-fit">
              {Array.from({ length: tierCountVal }, (_, i) => i).map(i => (
                <button key={i} onClick={() => { setActiveTier(i); setEditMode(false); setShowNewTierForm(false); }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${activeTier === i && !showNewTierForm ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
                  Tier {i}{i === 0 ? ' (Default)' : ''}
                </button>
              ))}
              <button onClick={openNewTierForm} disabled={!isConnected || !isOwnerConnected}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1 disabled:opacity-40 ${showNewTierForm ? 'bg-accent text-black' : 'text-txt-secondary hover:text-txt-primary'}`}>
                <Plus className="w-3.5 h-3.5" /> Add Tier
              </button>
            </div>

            {showNewTierForm ? (
              <div className="space-y-3">
                <p className="text-sm text-txt-secondary">New tier — starts as a copy of Tier 0&apos;s current payees; adjust before creating (must total 100%).</p>
                <PayeeTable rows={newTierRows} setRow={updateNewTierRow} addRow={addNewTierRow} removeRow={removeNewTierRow} total={newTierTotal} />
                <div className="flex gap-2">
                  <button onClick={handleAddTier} disabled={newTierTotal !== 10000}
                    className="flex-1 py-2.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
                    Create Tier
                  </button>
                  <button onClick={() => setShowNewTierForm(false)}
                    className="px-4 py-2.5 rounded-lg bg-surface-tertiary text-txt-secondary text-sm font-semibold hover:text-txt-primary transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3">
                  <PayeeSummaryTable list={tierPayeesList[activeTier] || []} tokenAddress={tokenAddress} />
                </div>

                {!editMode ? (
                  <button onClick={() => startEdit(activeTier)} disabled={!isConnected || !isOwnerConnected}
                    className="py-2 px-4 rounded-lg bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
                    <Settings className="w-4 h-4 inline mr-1" /> Edit Tier {activeTier}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <PayeeTable rows={editRows} setRow={updateEditRow} addRow={addEditRow} removeRow={removeEditRow} total={editTotal} />
                    <div className="flex gap-2">
                      <button onClick={handleSavePayees} disabled={editTotal !== 10000}
                        className="flex-1 py-2.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
                        Save On-Chain
                      </button>
                      <button onClick={() => setEditMode(false)}
                        className="px-4 py-2.5 rounded-lg bg-surface-tertiary text-txt-secondary text-sm font-semibold hover:text-txt-primary transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {isConnected && owner && !isOwnerConnected && (
              <p className="text-red-400 text-xs mt-2">You are not the owner of this splitter contract.</p>
            )}
          </Card>

          {/* Share History */}
          <Card title={
            <button onClick={() => { setShowHistory(!showHistory); if (!showHistory && shareHistory.length === 0) fetchHistory(); }}
              className="flex items-center gap-2 w-full text-left">
              Share Change History
              {showHistory ? <ChevronUp className="w-4 h-4 text-txt-secondary" /> : <ChevronDown className="w-4 h-4 text-txt-secondary" />}
            </button>
          } icon={<History className="w-5 h-5 text-blue-400" />}>
            {showHistory && (
              <div className="space-y-3">
                {historyLoading && <p className="text-xs text-txt-secondary">Loading history...</p>}
                {!historyLoading && shareHistory.length === 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-txt-secondary">No share change events found.</p>
                    <button onClick={fetchHistory} className="text-xs text-accent hover:underline flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Retry</button>
                  </div>
                )}
                {shareHistory.map((ch, idx) => (
                  <div key={idx} className="bg-surface-tertiary rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <span className="bg-purple-600/30 text-purple-300 text-[10px] font-bold px-2 py-0.5 rounded">Change #{ch.changeId}</span>
                        <span className="bg-yellow-600/30 text-yellow-300 text-[10px] font-bold px-2 py-0.5 rounded">Tier {ch.tier}</span>
                        <span className="text-[11px] text-txt-secondary">{formatDate(ch.timestamp)}</span>
                      </div>
                      <a href={getExplorerTxUrl(chainId, ch.txHash)} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-[10px] flex items-center gap-0.5"><ExternalLink className="w-3 h-3" /> Tx</a>
                    </div>
                    <p className="text-[10px] text-txt-secondary">By: <span className="font-mono">{ch.updatedBy}</span></p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-txt-secondary border-b border-white/10">
                            <th className="py-1 px-2 text-left">Label</th>
                            <th className="py-1 px-2 text-left">Address</th>
                            <th className="py-1 px-2 text-center">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ch.payees.map((p, pi) => (
                            <tr key={pi} className="border-b border-white/5">
                              <td className="py-1 px-2 text-txt-primary">
                                {p.label || '—'}
                                {p.isBurn && <span className="ml-1 text-[9px] bg-red-600/30 text-red-300 px-1 py-0.5 rounded">Burn #{p.burnTypeId}</span>}
                              </td>
                              <td className="py-1 px-2 font-mono text-[10px] text-txt-primary">{p.account.slice(0, 8)}...{p.account.slice(-4)}</td>
                              <td className="py-1 px-2 text-center text-accent font-bold">{(p.shareBps / 100).toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
