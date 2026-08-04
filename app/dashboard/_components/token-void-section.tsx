'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { Flame, Plus, Settings, RefreshCw, ExternalLink, ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, Skull, Tag, History, UserCog } from 'lucide-react';
import VoidArtifact from '@/lib/contracts/TokenVoid.json';
import TestTokenArtifact from '@/lib/contracts/TestToken.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import {
  BNB_TESTNET,
  BSC_MAINNET,
  DEFAULT_TOKEN_VOID_ADDRESS,
  DEFAULT_TOKEN_VOID_ADDRESS_MAINNET,
  DEFAULT_VOID_OWNER_ADDRESS,
  DEFAULT_VOID_OWNER_ADDRESS_MAINNET,
  getExplorerAddressUrl,
  networkStorageKey,
} from '@/lib/contracts/config';

const STORAGE_KEY = 'dg_tokenVoidAddress';
const PAGE_SIZE = 10;

interface BurnType { id: number; name: string; }
interface BurnRecord {
  id: number;
  token: string;
  burner: string;
  amount: string;
  timestamp: number;
  burnTypeId: number;
}

export default function TokenVoidSection() {
  const { signer, provider, isConnected, address, tokenAddress, hubAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string }>({ status: 'idle' });

  const [voidAddress, setVoidAddress] = useState('');
  const [platformAdminWallet, setPlatformAdminWallet] = useState('');

  // Setup: deploy new / load existing
  const [showDeploy, setShowDeploy] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [deployToken, setDeployToken] = useState('');
  const [loadAddr, setLoadAddr] = useState('');

  // Overview
  const [owner, setOwner] = useState('');
  const [linkedToken, setLinkedToken] = useState('');
  const [burnTypeCount, setBurnTypeCount] = useState(0);
  const [burnCount, setBurnCount] = useState(0);
  const [totalBurned, setTotalBurned] = useState('0');
  const [strandedBalance, setStrandedBalance] = useState('0');
  const [overviewLoading, setOverviewLoading] = useState(false);

  // Burn types
  const [burnTypes, setBurnTypes] = useState<BurnType[]>([]);
  const [newTypeName, setNewTypeName] = useState('');

  // Burn
  const [burnAmount, setBurnAmount] = useState('');
  const [burnTypeId, setBurnTypeId] = useState('');
  const [myBalance, setMyBalance] = useState('0');
  const [myAllowance, setMyAllowance] = useState('0');

  // History
  const [historyScope, setHistoryScope] = useState<'all' | 'mine'>('all');
  const [historyPage, setHistoryPage] = useState(0);
  const [historyRows, setHistoryRows] = useState<BurnRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Owner actions
  const [newOwner, setNewOwner] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawTo, setWithdrawTo] = useState('');

  // Same per-network namespacing as the addresses in providers.tsx — testnet and mainnet
  // Void deployments are unrelated contracts. Defaults to testnet when disconnected/unknown.
  const netNs = chainId === BSC_MAINNET.chainId ? BSC_MAINNET.chainId : BNB_TESTNET.chainId;
  const envOwnerAddress = netNs === BSC_MAINNET.chainId ? DEFAULT_VOID_OWNER_ADDRESS_MAINNET : DEFAULT_VOID_OWNER_ADDRESS;

  // Recognized as owner by any of: the live on-chain Void owner() call, the GameHub's
  // on-chain adminWallet() (the platform admin role used elsewhere in the Admin tab), or
  // the env-configured fallback (NEXT_PUBLIC_VOID_OWNER_ADDRESS[_MAINNET]).
  const isOwner = !!(address && (
    (owner && address.toLowerCase() === owner.toLowerCase()) ||
    (platformAdminWallet && address.toLowerCase() === platformAdminWallet.toLowerCase()) ||
    (envOwnerAddress && address.toLowerCase() === envOwnerAddress.toLowerCase())
  ));

  useEffect(() => {
    const isMainnet = netNs === BSC_MAINNET.chainId;
    try {
      // Testnet predates per-network namespacing; fall back to the old unnamespaced key.
      const saved = localStorage.getItem(networkStorageKey(STORAGE_KEY, netNs)) || (!isMainnet ? localStorage.getItem(STORAGE_KEY) : null);
      setVoidAddress(saved || (isMainnet ? DEFAULT_TOKEN_VOID_ADDRESS_MAINNET : DEFAULT_TOKEN_VOID_ADDRESS));
    } catch { /* ignore */ }
  }, [netNs]);

  const saveVoidAddress = (addr: string) => {
    setVoidAddress(addr);
    try { localStorage.setItem(networkStorageKey(STORAGE_KEY, netNs), addr); } catch { /* ignore */ }
  };

  const getReadContract = useCallback(() => {
    if (!provider || !voidAddress) return null;
    return new ethers.Contract(voidAddress, VoidArtifact.abi, provider);
  }, [provider, voidAddress]);

  const getWriteContract = useCallback(() => {
    if (!signer || !voidAddress) return null;
    return new ethers.Contract(voidAddress, VoidArtifact.abi, signer);
  }, [signer, voidAddress]);

  // ── Overview + burn types ──
  const fetchOverview = useCallback(async () => {
    const c = getReadContract();
    if (!c) return;
    setOverviewLoading(true);
    try {
      const [own, tok, btCount, bCount] = await Promise.all([
        c.owner(), c.lucaToken(), c.burnTypeCount(), c.burnCount(),
      ]);
      setOwner(own);
      setLinkedToken(tok);
      setBurnTypeCount(btCount?.toNumber?.() ?? Number(btCount));
      setBurnCount(bCount?.toNumber?.() ?? Number(bCount));
      if (tok && tok !== ethers.constants.AddressZero) {
        const [burned, stranded] = await Promise.all([c.getBurnedAmount(tok), c.getTokenBalance(tok)]);
        setTotalBurned(ethers.utils.formatEther(burned));
        setStrandedBalance(ethers.utils.formatEther(stranded));
      }
      const [ids, names]: [any[], string[]] = await c.getAllBurnTypes();
      const types = ids.map((id: any, i: number) => ({ id: id?.toNumber?.() ?? Number(id), name: names[i] }));
      setBurnTypes(types);
      if (!burnTypeId && types.length > 0) setBurnTypeId(String(types[0].id));
    } catch (e) {
      console.error('fetch tokenvoid overview:', e);
    } finally {
      setOverviewLoading(false);
    }
  }, [getReadContract]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (voidAddress) fetchOverview(); }, [voidAddress, fetchOverview]);

  // ── Platform admin (GameHub adminWallet) — a second, independent path to owner-only UI ──
  useEffect(() => {
    if (!provider || !hubAddress) { setPlatformAdminWallet(''); return; }
    const hub = new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
    hub.adminWallet().then(setPlatformAdminWallet).catch(() => setPlatformAdminWallet(''));
  }, [provider, hubAddress]);

  // ── My balance/allowance on the linked token ──
  const fetchMyTokenState = useCallback(async () => {
    if (!provider || !address || !linkedToken || linkedToken === ethers.constants.AddressZero || !voidAddress) return;
    try {
      const token = new ethers.Contract(linkedToken, TestTokenArtifact.abi, provider);
      const [bal, allow] = await Promise.all([token.balanceOf(address), token.allowance(address, voidAddress)]);
      setMyBalance(ethers.utils.formatEther(bal));
      setMyAllowance(ethers.utils.formatEther(allow));
    } catch { /* token may not be the standard ABI */ }
  }, [provider, address, linkedToken, voidAddress]);

  useEffect(() => { fetchMyTokenState(); }, [fetchMyTokenState]);

  // ── History ──
  // The contract only supports fetching in oldest-first order (offset 0 = the very first
  // burn ever), so to show latest-first we probe the total count first (a free view call),
  // then walk backward from the end and reverse the slice for display.
  const fetchHistory = useCallback(async () => {
    const c = getReadContract();
    if (!c) return;
    setHistoryLoading(true);
    try {
      const useMine = historyScope === 'mine' && !!address;
      const [, totalBn] = useMine
        ? await c.getUserBurnRecords(address, 0, 0)
        : await c.getBurnRecords(0, 0);
      const total = totalBn?.toNumber?.() ?? Number(totalBn);

      const end = Math.max(0, total - historyPage * PAGE_SIZE);
      const start = Math.max(0, end - PAGE_SIZE);
      const limit = end - start;

      const [records] = limit > 0
        ? (useMine ? await c.getUserBurnRecords(address, start, limit) : await c.getBurnRecords(start, limit))
        : [[]];
      const rows: BurnRecord[] = records.map((r: any) => ({
        id: r.id?.toNumber?.() ?? Number(r.id),
        token: r.token,
        burner: r.burner,
        amount: ethers.utils.formatEther(r.amount),
        timestamp: r.timestamp?.toNumber?.() ?? Number(r.timestamp),
        burnTypeId: r.burnTypeId?.toNumber?.() ?? Number(r.burnTypeId),
      })).reverse();
      setHistoryRows(rows);
      setHistoryTotal(total);
    } catch (e) {
      console.error('fetch burn history:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [getReadContract, historyPage, historyScope, address]);

  useEffect(() => { if (voidAddress) fetchHistory(); }, [voidAddress, fetchHistory]);

  useEffect(() => { setHistoryPage(0); }, [historyScope]);

  // ── Deploy / load ──
  const handleDeploy = async () => {
    if (!signer) return;
    const token = (deployToken || tokenAddress || '').trim();
    if (!ethers.utils.isAddress(token)) {
      setTxStatus({ status: 'error', error: 'Enter a valid ERC-20 token address to link this void contract to.' });
      return;
    }
    try {
      setTxStatus({ status: 'pending', message: '1/2 Deploying Void...' });
      const factory = new ethers.ContractFactory(VoidArtifact.abi, VoidArtifact.bytecode, signer);
      const contract = await factory.deploy();
      setTxStatus({ status: 'pending', hash: contract.deployTransaction.hash, message: '1/2 Waiting for confirmation...' });
      await contract.deployed();

      setTxStatus({ status: 'pending', message: `2/2 Initializing with token ${token}...` });
      const initTx = await contract.init(token);
      setTxStatus({ status: 'pending', hash: initTx.hash, message: '2/2 Waiting for confirmation...' });
      await initTx.wait();

      saveVoidAddress(contract.address);
      setShowDeploy(false);
      setTxStatus({ status: 'success', hash: initTx.hash, message: `Void deployed at ${contract.address}` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Deploy failed' });
    }
  };

  const handleLoad = () => {
    if (!ethers.utils.isAddress(loadAddr.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid Void address' });
      return;
    }
    saveVoidAddress(loadAddr.trim());
    setShowLoad(false);
    setLoadAddr('');
    setTxStatus({ status: 'idle' });
  };

  // ── Burn types ──
  const handleAddBurnType = async () => {
    const c = getWriteContract();
    if (!c || !newTypeName.trim()) return;
    setTxStatus({ status: 'pending', message: 'Adding burn type...' });
    try {
      const tx = await c.addBurnType(newTypeName.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Burn type "${newTypeName.trim()}" added` });
      setNewTypeName('');
      fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Add burn type failed' });
    }
  };

  // ── Approve + burn ──
  const handleApprove = async () => {
    if (!signer || !linkedToken || !voidAddress || !burnAmount) return;
    setTxStatus({ status: 'pending', message: 'Approving Void to spend your tokens...' });
    try {
      const token = new ethers.Contract(linkedToken, TestTokenArtifact.abi, signer);
      const tx = await token.approve(voidAddress, ethers.utils.parseEther(burnAmount));
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Approved ${burnAmount}` });
      fetchMyTokenState();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Approve failed' });
    }
  };

  const handleBurn = async () => {
    const c = getWriteContract();
    if (!c || !burnAmount || !burnTypeId) return;
    setTxStatus({ status: 'pending', message: 'Burning tokens...' });
    try {
      const tx = await c.burnTokens(ethers.utils.parseEther(burnAmount), parseInt(burnTypeId));
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Burned ${burnAmount} — sent to the dead address forever` });
      setBurnAmount('');
      fetchMyTokenState();
      fetchOverview();
      if (historyPage === 0) fetchHistory();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Burn failed' });
    }
  };

  // ── Owner actions ──
  const handleTransferOwnership = async () => {
    const c = getWriteContract();
    if (!c || !ethers.utils.isAddress(newOwner)) return;
    setTxStatus({ status: 'pending', message: 'Transferring ownership...' });
    try {
      const tx = await c.transferOwnership(newOwner);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Ownership transferred to ${newOwner}` });
      setNewOwner('');
      fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Transfer ownership failed' });
    }
  };

  const handleEmergencyWithdraw = async () => {
    const c = getWriteContract();
    if (!c || !ethers.utils.isAddress(withdrawToken) || !ethers.utils.isAddress(withdrawTo) || !withdrawAmount) return;
    setTxStatus({ status: 'pending', message: 'Withdrawing stranded tokens...' });
    try {
      const tx = await c.emergencyWithdraw(withdrawToken, ethers.utils.parseEther(withdrawAmount), withdrawTo);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Withdrew ${withdrawAmount} to ${withdrawTo}` });
      setWithdrawAmount('');
      fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Emergency withdraw failed' });
    }
  };

  const formatDate = (ts: number) => { try { return new Date(ts * 1000).toLocaleString(); } catch { return String(ts); } };
  const typeName = (id: number) => burnTypes.find(t => t.id === id)?.name || `#${id}`;
  const inputCls = 'w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
  const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2 rounded-lg text-sm transition-colors';

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* Owner Banner */}
      {voidAddress && (
        <div className="bg-surface-secondary border border-yellow-500/30 rounded-lg px-4 py-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="text-xs text-txt-secondary font-medium shrink-0 inline-flex items-center gap-1.5">
              <UserCog className="w-4 h-4 text-yellow-400" /> Void Owner:
            </span>
            {overviewLoading && !owner ? (
              <span className="text-xs text-txt-secondary inline-flex items-center gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> Loading…</span>
            ) : owner ? (
              <>
                <code className="text-xs text-yellow-400 font-mono break-all select-all">{owner}</code>
                <a href={getExplorerAddressUrl(chainId, owner)} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 underline shrink-0">
                  View on BscScan ↗
                </a>
              </>
            ) : (
              <span className="text-xs text-txt-secondary">Unavailable.</span>
            )}
          </div>
          {owner && address && (
            <p className="text-[11px] mt-1.5">
              {isOwner ? (
                <span className="text-green-400 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Your connected wallet IS the owner — you can add burn types below.</span>
              ) : (
                <span className="text-txt-secondary">Your connected wallet is <span className="text-red-400">not</span> recognized as the owner — you can still try adding a burn type below, but the transaction will revert on-chain unless you actually hold ownership.</span>
              )}
            </p>
          )}
        </div>
      )}

      {/* Setup */}
      <Card title="Void" icon={<Skull className="w-5 h-5 text-red-400" />}>
        <p className="text-xs text-txt-secondary mb-3">
          A burn split routes points to the standard dead address instead of a payee. Void gives users a self-serve way to burn their own points directly (via <code className="text-accent">transferFrom → DEAD_ADDRESS</code>), tagged with a burn type and recorded on-chain for history/leaderboards.
        </p>

        {voidAddress ? (
          <div className="flex items-center gap-3 flex-wrap bg-surface-tertiary rounded-lg px-3 py-2.5 mb-3">
            <Flame className="w-4 h-4 text-red-400 shrink-0" />
            <code className="text-xs font-mono text-txt-primary break-all">{voidAddress}</code>
            <a href={getExplorerAddressUrl(chainId, voidAddress)} target="_blank" rel="noopener noreferrer"
              className="text-txt-secondary hover:text-red-400 shrink-0"><ExternalLink className="w-3.5 h-3.5" /></a>
            <button onClick={() => { saveVoidAddress(''); setOwner(''); setLinkedToken(''); }} className="ml-auto text-xs text-txt-secondary hover:text-txt-primary shrink-0">
              Change
            </button>
          </div>
        ) : (
          <p className="text-sm text-txt-secondary mb-3">No Void contract loaded yet. Deploy a new one or load an existing address.</p>
        )}

        <div className="flex gap-2 flex-wrap">
          <button onClick={() => { setShowDeploy(!showDeploy); setShowLoad(false); }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors">
            <Plus className="w-4 h-4" /> Deploy New
          </button>
          <button onClick={() => { setShowLoad(!showLoad); setShowDeploy(false); }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary/80 text-txt-primary text-sm font-semibold transition-colors border border-white/10">
            <Settings className="w-4 h-4" /> Load Existing
          </button>
          {voidAddress && (
            <button onClick={fetchOverview} disabled={overviewLoading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-txt-secondary hover:text-txt-primary text-sm">
              <RefreshCw className={`w-4 h-4 ${overviewLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          )}
        </div>

        {showDeploy && (
          <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-red-700/30 space-y-3">
            <h4 className="text-sm font-semibold text-red-300">Deploy New Void</h4>
            <p className="text-xs text-txt-secondary">2 transactions: deploy, then initialize with the token it burns. Defaults to the platform&apos;s token if left blank.</p>
            <div>
              <label className="text-xs text-txt-secondary">Token to link (blank = platform token{tokenAddress ? '' : ' — none loaded'})</label>
              <input value={deployToken} onChange={e => setDeployToken(e.target.value)} placeholder={tokenAddress || '0x...'} className={inputCls} />
            </div>
            <button onClick={handleDeploy} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy Void</button>
          </div>
        )}

        {showLoad && (
          <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-white/10 space-y-3">
            <h4 className="text-sm font-semibold text-txt-primary">Load Existing Void</h4>
            <input value={loadAddr} onChange={e => setLoadAddr(e.target.value)} placeholder="0x... contract address" className={inputCls} />
            <button onClick={handleLoad} className="px-4 py-2 rounded-lg bg-accent text-black text-sm font-semibold hover:bg-yellow-400 transition-colors">Load</button>
          </div>
        )}
      </Card>

      {voidAddress && (
        <>
          {/* Overview */}
          <Card title="Overview" icon={<ShieldCheck className="w-5 h-5 text-red-400" />}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-txt-secondary">Linked Token</p>
                <p className="text-xs font-mono text-txt-primary break-all">{linkedToken ? `${linkedToken.slice(0, 8)}...${linkedToken.slice(-6)}` : '—'}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Total Burned</p>
                <p className="text-lg font-bold text-red-400">{parseFloat(totalBurned).toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Burn Records</p>
                <p className="text-lg font-bold text-txt-primary">{burnCount}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Owner</p>
                <p className="text-xs font-mono text-txt-primary break-all">{owner ? `${owner.slice(0, 8)}...${owner.slice(-6)}` : '—'}</p>
              </div>
            </div>
            {parseFloat(strandedBalance) > 0 && (
              <div className="mt-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-xs text-yellow-400 flex items-center gap-2">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                {strandedBalance} tokens are sitting in the contract itself (sent here directly rather than via burnTokens) — recoverable via Emergency Withdraw below.
              </div>
            )}
          </Card>

          {/* Burn Types */}
          <Card title="Burn Types" icon={<Tag className="w-5 h-5 text-red-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Tags for burn records (e.g. &quot;Marketplace Fee&quot;, &quot;Penalty&quot;). Owner-only to add; anyone can view.</p>
            {burnTypes.length === 0 ? (
              <p className="text-sm text-txt-secondary mb-3">No burn types yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-3">
                {burnTypes.map(t => (
                  <span key={t.id} className="text-xs bg-surface-tertiary border border-white/10 rounded-full px-3 py-1">
                    <span className="text-txt-secondary">#{t.id}</span> {t.name}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input value={newTypeName} onChange={e => setNewTypeName(e.target.value)} placeholder="New burn type name" className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" />
              <button onClick={handleAddBurnType} disabled={!isConnected || !newTypeName.trim()} className={`px-4 ${btnCls}`}>Add</button>
            </div>
            {!isOwner && (
              <p className="text-[11px] text-yellow-400 mt-1.5">Not recognized as owner — this will revert on-chain unless your wallet actually holds ownership.</p>
            )}
          </Card>

          {/* Burn */}
          <Card title="Burn Tokens" icon={<Flame className="w-5 h-5 text-red-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Sends your own tokens straight to the dead address (0x000...dEaD) — irreversible. Requires approving Void first.</p>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <p className="text-xs text-txt-secondary">Your Balance</p>
                <p className="text-sm font-bold text-accent">{parseFloat(myBalance).toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Void Allowance</p>
                <p className="text-sm font-bold text-green-400">{parseFloat(myAllowance).toFixed(4)}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-txt-secondary">Burn Type</label>
                <select value={burnTypeId} onChange={e => setBurnTypeId(e.target.value)} className={inputCls}>
                  {burnTypes.length === 0 && <option value="">No burn types — add one above first</option>}
                  {burnTypes.map(t => <option key={t.id} value={t.id}>#{t.id} — {t.name}</option>)}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-txt-secondary">Amount</label>
                  <button type="button" onClick={() => setBurnAmount(myBalance)} className="text-xs text-accent hover:underline">Max: {parseFloat(myBalance).toFixed(4)}</button>
                </div>
                <input value={burnAmount} onChange={e => setBurnAmount(e.target.value)} placeholder="100" type="number" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={handleApprove} disabled={!isConnected || !burnAmount}
                  className="py-2.5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary/80 border border-white/10 text-txt-primary text-sm font-semibold transition-colors">
                  Approve
                </button>
                <button onClick={handleBurn} disabled={!isConnected || !burnAmount || !burnTypeId || parseFloat(myAllowance) < (parseFloat(burnAmount) || 0)}
                  className="py-2.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                  <Flame className="w-4 h-4" /> Burn
                </button>
              </div>
              {parseFloat(myAllowance) < (parseFloat(burnAmount) || 0) && burnAmount && (
                <p className="text-[11px] text-yellow-400">Approve at least {burnAmount} before burning.</p>
              )}
            </div>
          </Card>

          {/* History */}
          <Card title={
            <span className="flex items-center gap-2">
              Burn History
              <span className="text-xs text-txt-secondary font-normal">({historyTotal})</span>
            </span>
          } icon={<History className="w-5 h-5 text-red-400" />}>
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => setHistoryScope('all')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${historyScope === 'all' ? 'bg-accent text-black' : 'bg-surface-tertiary text-txt-secondary hover:text-txt-primary'}`}>All</button>
              <button onClick={() => setHistoryScope('mine')} disabled={!address} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${historyScope === 'mine' ? 'bg-accent text-black' : 'bg-surface-tertiary text-txt-secondary hover:text-txt-primary'} disabled:opacity-40`}>Mine</button>
              <button onClick={fetchHistory} disabled={historyLoading} className="ml-auto p-1.5 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-3.5 h-3.5 text-txt-secondary ${historyLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {historyRows.length === 0 ? (
              <p className="text-sm text-txt-secondary py-4 text-center">{historyLoading ? 'Loading...' : 'No burn records yet.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-txt-secondary border-b border-white/10">
                      <th className="text-left py-1.5 px-2">#</th>
                      <th className="text-left py-1.5 px-2">Type</th>
                      <th className="text-left py-1.5 px-2">Burner</th>
                      <th className="text-right py-1.5 px-2">Amount</th>
                      <th className="text-left py-1.5 px-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map(r => (
                      <tr key={r.id} className="border-b border-white/5 hover:bg-surface-tertiary/50">
                        <td className="py-1.5 px-2 text-txt-secondary">{r.id}</td>
                        <td className="py-1.5 px-2 text-txt-primary">{typeName(r.burnTypeId)}</td>
                        <td className="py-1.5 px-2 font-mono">{r.burner.slice(0, 8)}...{r.burner.slice(-4)}</td>
                        <td className="py-1.5 px-2 text-right text-red-400 font-bold">{parseFloat(r.amount).toFixed(4)}</td>
                        <td className="py-1.5 px-2 text-txt-secondary">{formatDate(r.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0}
                className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-30">
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <span className="text-xs text-txt-secondary">Page {historyPage + 1} of {Math.max(1, Math.ceil(historyTotal / PAGE_SIZE))}</span>
              <button onClick={() => setHistoryPage(p => (p + 1) * PAGE_SIZE < historyTotal ? p + 1 : p)} disabled={(historyPage + 1) * PAGE_SIZE >= historyTotal}
                className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-30">
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </Card>

          {/* Owner Actions */}
          {isOwner && (
            <Card title="Owner Actions" icon={<UserCog className="w-5 h-5 text-red-400" />}>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-txt-primary mb-2">Emergency Withdraw</h4>
                  <p className="text-xs text-txt-secondary mb-2">Recover tokens sent directly to this contract by mistake (burnTokens never leaves a balance here — it transfers straight to the dead address).</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input value={withdrawToken} onChange={e => setWithdrawToken(e.target.value)} placeholder="Token address" className="bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm font-mono" />
                    <input value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder="Amount" type="number" className="bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm" />
                    <input value={withdrawTo} onChange={e => setWithdrawTo(e.target.value)} placeholder="Recipient" className="bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm font-mono" />
                  </div>
                  <button onClick={handleEmergencyWithdraw} disabled={!isConnected || !withdrawToken || !withdrawAmount || !withdrawTo}
                    className="mt-2 w-full sm:w-auto px-4 py-2 rounded-lg bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-black font-semibold text-sm transition-colors">
                    Withdraw
                  </button>
                </div>
                <div className="border-t border-white/10 pt-4">
                  <h4 className="text-sm font-semibold text-txt-primary mb-2">Transfer Ownership</h4>
                  <p className="text-xs text-txt-secondary mb-2">Irreversible — you will lose owner access unless the new owner transfers it back.</p>
                  <div className="flex gap-2">
                    <input value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder="0x... new owner" className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm font-mono" />
                    <button onClick={handleTransferOwnership} disabled={!isConnected || !ethers.utils.isAddress(newOwner)}
                      className="px-4 py-2 rounded-lg bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-black font-semibold text-sm transition-colors">
                      Transfer
                    </button>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
