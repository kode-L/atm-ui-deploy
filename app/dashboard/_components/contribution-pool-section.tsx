'use client';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import ContributionPoolArtifact from '@/lib/contracts/ContributionPool.json';
import ContributionPoolProxyArtifact from '@/lib/contracts/ContributionPoolProxy.json';
import {
  Rocket, ExternalLink, Copy, Check, RefreshCw, PiggyBank, Search, ArrowUpCircle, ShieldCheck,
  KeyRound, Layers, HandCoins, Undo2, History, Users, Vote, Settings2, FileCode2, Download, Plus,
} from 'lucide-react';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };
type TokenMeta = { symbol: string; decimals: number };
type BN = ethers.BigNumber;

const ABI = ContributionPoolArtifact.abi;
const poolIface = new ethers.utils.Interface(ABI);
const OPERATOR_ROLE = ethers.utils.id('OPERATOR_ROLE');
const ADMIN_ROLE = ethers.constants.HashZero;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
const PAGE_SIZE = 10;

// Common stablecoins to copy/paste when whitelisting tokens or creating a pool.
const KNOWN_TOKENS: { network: string; chainId: number; symbol: string; address: string; decimals: number }[] = [
  { network: 'BSC Mainnet', chainId: 56, symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { network: 'BSC Mainnet', chainId: 56, symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { network: 'BNB Testnet', chainId: 97, symbol: 'tUSDT', address: '0x411A593ff4caa135Ce4b51976dF4D79Bf904b6Fc', decimals: 18 },
  { network: 'BNB Testnet', chainId: 97, symbol: 'tUSDC', address: '0x802ffc9086DD99e0eFcf0f49CC19d455848935C2', decimals: 18 },
];

// Matches ContributionPool.ProposalType (append-only on-chain)
const PROPOSAL_TYPES = ['Release', 'SetAllowedTokens', 'SetBeneficiary', 'StartRefund', 'SetFees', 'SetFeeRecipient', 'SetAccessControl'];

// ContributionPool's custom errors — the shared decodeError only knows the GameHub /
// DailySessionManager ABI, so these are parsed here first and anything else falls through to it.
const POOL_ERROR_MESSAGES: Record<string, string> = {
  InvalidAddress: 'Invalid address (zero address not allowed)',
  InvalidValue: 'Invalid value (zero amount, empty list, or out of range)',
  InvalidTimeRange: 'Invalid time range (end must be after start)',
  UnsupportedDecimals: 'Token has more than 18 decimals — not supported',
  TokenNotAllowed: 'Token is not on the global whitelist (propose it under Proposals → Allowed Tokens)',
  TokenNotAccepted: 'Token is not accepted by this pool',
  DuplicateToken: 'Same token listed twice',
  TooManyTokens: 'Too many tokens for one pool (max 10)',
  PoolNotFound: 'Pool does not exist',
  ContributionsClosed: 'Contributions are closed for this pool',
  NotStarted: 'Pool has not started yet',
  Ended: 'Pool has ended',
  BelowMinContribution: 'Below the pool minimum contribution',
  TargetExceeded: 'Would exceed the pool target',
  UserCapExceeded: 'Would exceed the per-user cap',
  InsufficientBalance: 'Not enough pool balance for this amount',
  ExceedsShortfall: 'Amount is more than the pool is missing (raised - balance)',
  FeeTooHigh: 'Fee too high (max 1000 bps = 10%)',
  RefundActive: 'Pool is in refund mode',
  RefundNotActive: 'Pool is not in refund mode',
  NothingToClaim: 'Nothing to claim',
  Restricted: 'Wallet is restricted by ATMAccessControl',
  ProposalNotFound: 'Proposal does not exist',
  ProposalClosed: 'Proposal is already executed or rejected',
  AlreadyApproved: 'You already approved this proposal',
  NotProposerOrAdmin: 'Only the proposer or an admin can reject',
  UnknownProposalType: 'Unknown proposal type',
  EnforcedPause: 'Contract is paused',
  ExpectedPause: 'Contract is not paused',
};

function decodePoolError(e: any): string {
  const rawData = e?.error?.data?.data || e?.error?.data || e?.data?.data || e?.data;
  if (typeof rawData === 'string' && rawData.startsWith('0x') && rawData.length >= 10) {
    try {
      const parsed = poolIface.parseError(rawData);
      if (parsed.name === 'AccessControlUnauthorizedAccount') {
        const role = String(parsed.args[1]).toLowerCase();
        const roleName = role === OPERATOR_ROLE ? 'OPERATOR_ROLE' : role === ADMIN_ROLE ? 'DEFAULT_ADMIN_ROLE' : role;
        return `Access denied: ${String(parsed.args[0]).slice(0, 10)}... is missing ${roleName}`;
      }
      if (parsed.name === 'SafeERC20FailedOperation') return `ERC20 transfer failed for token ${String(parsed.args[0]).slice(0, 10)}... — check balance and approval`;
      return POOL_ERROR_MESSAGES[parsed.name] || `Contract error: ${parsed.name}`;
    } catch { /* not a ContributionPool error */ }
  }
  return decodeError(e);
}

const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';
const smallBtn = 'shrink-0 px-3 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-lg text-xs';
const dangerBtn = 'shrink-0 px-3 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg text-xs';
const pagerBtn = 'text-xs text-accent disabled:opacity-30 hover:underline';
const fmtAddr = (a: string) => a ? `${a.slice(0, 8)}...${a.slice(-6)}` : '—';
const isZero = (a: string) => !a || a === ethers.constants.AddressZero;
const fmtTs = (ts: number) => ts === 0 ? '—' : new Date(ts * 1000).toLocaleString();
const toUnix = (dtLocal: string) => dtLocal ? Math.floor(new Date(dtLocal).getTime() / 1000) : 0;
const toDtLocal = (ts: number) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmtUnits = (v: BN, decimals: number) => {
  const s = ethers.utils.formatUnits(v, decimals);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const fmtShare = (share: BN) => `${(Number(ethers.utils.formatUnits(share, 16))).toFixed(2)}%`;
const parseAmount = (v: string, decimals: number): BN => ethers.utils.parseUnits((v || '0').trim(), decimals);
// Free text becomes a bytes32 string; a 0x-prefixed 32-byte hex value is passed through as is.
const toRef = (v: string) => {
  const t = v.trim();
  if (!t) return ethers.constants.HashZero;
  if (ethers.utils.isHexString(t, 32)) return t;
  return ethers.utils.formatBytes32String(t);
};
const fmtRef = (ref: string) => {
  if (ref === ethers.constants.HashZero) return '—';
  try { return ethers.utils.parseBytes32String(ref); } catch { return ref; }
};
const parseAddressList = (v: string) => v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

interface PoolRow {
  id: number;
  beneficiary: string;
  target: BN;
  maxPerUser: BN;
  minContribution: BN;
  raised: BN;
  totalContributed: BN;
  totalRefunded: BN;
  contributorCount: number;
  activeContributors: number;
  startTime: number;
  endTime: number;
  contributionsOpen: boolean;
  refunding: boolean;
  ref: string;
}
interface PoolTokenRow {
  token: string;
  accepted: boolean;
  balance: BN;
  raised: BN;
  totalContributed: BN;
  totalRefunded: BN;
  released: BN;
  returned: BN;
}
interface TokenPositionRow { token: string; principal: BN; totalContributed: BN; refunded: BN; refundable: BN; share: BN }
interface ContributorRow { user: string; principal: BN; totalContributed: BN; totalRefunded: BN; refundable: BN; share: BN; tokens: TokenPositionRow[] }
interface HistoryRow { poolId: number; token: string; amount: BN; timestamp: number }
interface ProposalRow {
  id: number;
  proposalType: number;
  poolId: number;
  token: string;
  amount: BN;
  account: string;
  releaseFeeBps: number;
  refundFeeBps: number;
  allowed: boolean;
  proposer: string;
  approvalCount: number;
  snapshotThreshold: number;
  executed: boolean;
  cancelled: boolean;
  tokens: string[];
  approvedByMe: boolean;
}

const toPoolRow = (id: number, p: any): PoolRow => ({
  id,
  beneficiary: p.beneficiary,
  target: p.target,
  maxPerUser: p.maxPerUser,
  minContribution: p.minContribution,
  raised: p.raised,
  totalContributed: p.totalContributed,
  totalRefunded: p.totalRefunded,
  contributorCount: p.contributorCount.toNumber(),
  activeContributors: p.activeContributors.toNumber(),
  startTime: p.startTime.toNumber(),
  endTime: p.endTime.toNumber(),
  contributionsOpen: p.contributionsOpen,
  refunding: p.refunding,
  ref: p.ref,
});
const toContributorRow = (c: any): ContributorRow => ({
  user: c.user,
  principal: c.principal,
  totalContributed: c.totalContributed,
  totalRefunded: c.totalRefunded,
  refundable: c.refundable,
  share: c.share,
  tokens: c.tokens.map((t: any) => ({ token: t.token, principal: t.principal, totalContributed: t.totalContributed, refunded: t.refunded, refundable: t.refundable, share: t.share })),
});

const ABI_JSON = JSON.stringify(ABI, null, 2);
const ABI_FUNCTIONS = ABI.filter((f: any) => f.type === 'function');

function downloadAbi() {
  const blob = new Blob([ABI_JSON], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ContributionPool.abi.json';
  link.click();
  URL.revokeObjectURL(url);
}

export default function ContributionPoolSection() {
  const { provider, signer, isConnected, address, chainId, netChainId, contributionPoolAddress, setContributionPoolAddress } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText?.(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const AddrBadge = ({ addr, label }: { addr: string; label: string }) => (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-xs text-txt-secondary">Address:</span>
      <code className="text-xs text-accent font-mono truncate flex-1">{addr}</code>
      <button onClick={() => copyText(addr, label)} className="shrink-0">
        {copied === label ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
      </button>
      <a href={getExplorerAddressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="w-3.5 h-3.5 text-txt-secondary hover:text-accent" />
      </a>
    </div>
  );

  // Sends a tx, tracks it in TxStatus, and returns the receipt (null on failure).
  // `onSuccess` builds the success message from the receipt and may refresh views.
  const runTx = async (
    pendingMsg: string,
    send: () => Promise<ethers.ContractTransaction>,
    onSuccess?: (r: ethers.ContractReceipt) => string | void | Promise<string | void>,
  ): Promise<ethers.ContractReceipt | null> => {
    setTxStatus({ status: 'pending', message: pendingMsg });
    try {
      const tx = await send();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      const receipt = await tx.wait();
      const msg = onSuccess ? await onSuccess(receipt) : undefined;
      setTxStatus({ status: 'success', hash: tx.hash, message: msg || 'Done.' });
      return receipt;
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodePoolError(e) });
      return null;
    }
  };
  const fail = (error: string) => setTxStatus({ status: 'error', error });

  // ── Contract instances ──
  const getRead = useCallback(() => {
    if (!provider || !contributionPoolAddress) return null;
    return new ethers.Contract(contributionPoolAddress, ABI, provider);
  }, [provider, contributionPoolAddress]);
  const getWrite = useCallback(() => {
    if (!signer || !contributionPoolAddress) return null;
    return new ethers.Contract(contributionPoolAddress, ABI, signer);
  }, [signer, contributionPoolAddress]);

  // ── Token metadata (symbol / decimals), cached per address ──
  const [tokenMeta, setTokenMeta] = useState<Record<string, TokenMeta>>({});
  const loadTokenMeta = useCallback(async (tokens: string[]) => {
    if (!provider) return;
    const missing = Array.from(new Set(tokens.map(t => t.toLowerCase()))).filter(t => !tokenMeta[t]);
    if (missing.length === 0) return;
    const entries = await Promise.all(missing.map(async (t) => {
      const erc20 = new ethers.Contract(t, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        erc20.symbol().catch(() => fmtAddr(t)),
        erc20.decimals().catch(() => 18),
      ]);
      return [t, { symbol, decimals: Number(decimals) }] as const;
    }));
    setTokenMeta(prev => ({ ...prev, ...Object.fromEntries(entries) }));
  }, [provider, tokenMeta]);
  const metaOf = (token: string): TokenMeta => tokenMeta[token?.toLowerCase()] || { symbol: fmtAddr(token), decimals: 18 };
  const symOf = (token: string) => metaOf(token).symbol;
  const decOf = (token: string) => metaOf(token).decimals;

  // ── Deploy / Load ──
  const [implAddress, setImplAddress] = useState('');
  const [initFeeRecipient, setInitFeeRecipient] = useState('');
  const feeRecipientPrefilledFor = useRef('');
  const [initThreshold, setInitThreshold] = useState('1');
  const [manualLoad, setManualLoad] = useState('');

  useEffect(() => {
    // prefill once per wallet, so clearing the field to type another address doesn't refill it
    if (address && feeRecipientPrefilledFor.current !== address) {
      feeRecipientPrefilledFor.current = address;
      setInitFeeRecipient(address);
    }
  }, [address]);

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying ContributionPool implementation...' });
    try {
      const factory = new ethers.ContractFactory(ABI, ContributionPoolArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now deploy the proxy.` });
    } catch (e: any) {
      fail(decodePoolError(e));
    }
  };

  // Proxy constructor delegatecalls initialize(admin, feeRecipient, proposalThreshold) atomically —
  // the connected (deploying) wallet is passed as admin (DEFAULT_ADMIN_ROLE). initialize() grants
  // no OPERATOR_ROLE — grant it in Roles below before creating pools or proposing anything.
  const deployProxy = async () => {
    if (!signer || !implAddress || !address) return;
    if (!ethers.utils.isAddress(initFeeRecipient.trim())) return fail('Invalid fee recipient address');
    const threshold = parseInt(initThreshold);
    if (isNaN(threshold) || threshold < 1 || threshold > 100) return fail('Proposal threshold must be 1-100');
    setTxStatus({ status: 'pending', message: 'Deploying proxy + initializing...' });
    try {
      const initData = poolIface.encodeFunctionData('initialize', [address, initFeeRecipient.trim(), threshold]);
      const factory = new ethers.ContractFactory(ContributionPoolProxyArtifact.abi, ContributionPoolProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress, initData);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      setContributionPoolAddress(proxy.address);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `ContributionPool deployed at ${proxy.address}. You are admin — grant OPERATOR_ROLE (Roles below), whitelist tokens (Proposals), then create a pool.` });
    } catch (e: any) {
      fail(decodePoolError(e));
    }
  };

  const loadExisting = () => {
    if (!ethers.utils.isAddress(manualLoad.trim())) return fail('Invalid address');
    setContributionPoolAddress(manualLoad.trim());
    setManualLoad('');
    setTxStatus({ status: 'idle' });
  };

  // ── Overview ──
  const [overview, setOverview] = useState<{
    version: string; poolCount: number; proposalCount: number; proposalThreshold: number;
    releaseFeeBps: number; refundFeeBps: number; feeRecipient: string; accessControl: string; paused: boolean;
  } | null>(null);
  const [allowedTokens, setAllowedTokens] = useState<string[]>([]);
  const [isAdminConnected, setIsAdminConnected] = useState(false);
  const [isOperatorConnected, setIsOperatorConnected] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewLoadError, setOverviewLoadError] = useState('');

  const fetchOverview = useCallback(async () => {
    const pool = getRead();
    if (!pool) return;
    setOverviewLoading(true);
    setOverviewLoadError('');
    try {
      const [version, poolCount, proposalCount, proposalThreshold, releaseFeeBps, refundFeeBps, feeRecipient, accessControl, paused, allowed] = await Promise.all([
        pool.version(), pool.poolCount(), pool.proposalCount(), pool.proposalThreshold(), pool.releaseFeeBps(), pool.refundFeeBps(),
        pool.feeRecipient(), pool.accessControl(), pool.paused(), pool.getAllowedTokens(),
      ]);
      setOverview({
        version, poolCount: poolCount.toNumber(), proposalCount: proposalCount.toNumber(), proposalThreshold: proposalThreshold.toNumber(),
        releaseFeeBps: releaseFeeBps.toNumber(), refundFeeBps: refundFeeBps.toNumber(), feeRecipient, accessControl, paused,
      });
      setAllowedTokens(allowed);
      if (address) {
        const [isAdmin, isOperator] = await Promise.all([
          pool.hasRole(ADMIN_ROLE, address).catch(() => false),
          pool.hasRole(OPERATOR_ROLE, address).catch(() => false),
        ]);
        setIsAdminConnected(!!isAdmin);
        setIsOperatorConnected(!!isOperator);
      } else {
        setIsAdminConnected(false);
        setIsOperatorConnected(false);
      }
    } catch (e) {
      console.error('fetch ContributionPool overview:', e);
      setOverviewLoadError(`Failed to read from ${contributionPoolAddress} — ${decodePoolError(e)}. Double-check this address is the ContributionPool proxy on the network your wallet is connected to.`);
    } finally {
      setOverviewLoading(false);
    }
  }, [getRead, address, contributionPoolAddress]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);
  useEffect(() => { if (allowedTokens.length) loadTokenMeta(allowedTokens); }, [allowedTokens]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pools list (newest first) ──
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [poolsPage, setPoolsPage] = useState(0);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const poolCount = overview?.poolCount ?? 0;

  const fetchPools = useCallback(async (page = 0) => {
    const pool = getRead();
    if (!pool || poolCount === 0) { setPools([]); return; }
    setPoolsLoading(true);
    try {
      const top = poolCount - page * PAGE_SIZE;
      const ids = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, top)) }, (_, i) => top - i);
      const rows = await Promise.all(ids.map(async id => toPoolRow(id, await pool.getPool(id))));
      setPools(rows);
      setPoolsPage(page);
    } catch (e) {
      fail(decodePoolError(e));
    } finally {
      setPoolsLoading(false);
    }
  }, [getRead, poolCount]);

  useEffect(() => { fetchPools(0); }, [fetchPools]);

  // ── Selected pool detail ──
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [poolDetail, setPoolDetail] = useState<{ pool: PoolRow; tokens: PoolTokenRow[] } | null>(null);
  const [poolDetailError, setPoolDetailError] = useState('');

  const fetchPoolDetail = useCallback(async (idStr?: string) => {
    const pool = getRead();
    const id = parseInt(idStr ?? selectedPoolId);
    if (!pool || isNaN(id) || id < 1) return;
    setPoolDetailError('');
    try {
      const [p, infos] = await Promise.all([pool.getPool(id), pool.getPoolTokens(id)]);
      const tokens: PoolTokenRow[] = infos.map((i: any) => ({ token: i.token, ...i.ledger }));
      await loadTokenMeta(tokens.map(t => t.token));
      setPoolDetail({ pool: toPoolRow(id, p), tokens });
    } catch (e) {
      setPoolDetail(null);
      setPoolDetailError(decodePoolError(e));
    }
  }, [getRead, selectedPoolId, loadTokenMeta]);

  useEffect(() => { if (!selectedPoolId && poolCount > 0) setSelectedPoolId(String(poolCount)); }, [poolCount, selectedPoolId]);
  useEffect(() => { if (selectedPoolId) fetchPoolDetail(selectedPoolId); }, [selectedPoolId, contributionPoolAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTokens = poolDetail?.tokens ?? [];
  const acceptedTokens = selectedTokens.filter(t => t.accepted);

  const refreshAll = async () => {
    await fetchOverview();
    await fetchPools(poolsPage);
    await fetchPoolDetail();
  };

  // ── Contribute ──
  const [contribToken, setContribToken] = useState('');
  const [contribAmount, setContribAmount] = useState('');
  const [walletInfo, setWalletInfo] = useState<{ balance: BN; allowance: BN } | null>(null);

  useEffect(() => {
    if (acceptedTokens.length && !acceptedTokens.some(t => t.token === contribToken)) setContribToken(acceptedTokens[0].token);
  }, [acceptedTokens, contribToken]);

  const fetchWalletInfo = useCallback(async () => {
    if (!provider || !address || !contribToken || !contributionPoolAddress) { setWalletInfo(null); return; }
    try {
      const erc20 = new ethers.Contract(contribToken, ERC20_ABI, provider);
      const [balance, allowance] = await Promise.all([erc20.balanceOf(address), erc20.allowance(address, contributionPoolAddress)]);
      setWalletInfo({ balance, allowance });
    } catch {
      setWalletInfo(null);
    }
  }, [provider, address, contribToken, contributionPoolAddress]);

  useEffect(() => { fetchWalletInfo(); }, [fetchWalletInfo]);

  // Approves exactly `amount` first when the current allowance is too low (two wallet prompts).
  const ensureAllowance = async (token: string, amount: BN): Promise<boolean> => {
    if (!signer || !address) return false;
    const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
    const allowance: BN = await erc20.allowance(address, contributionPoolAddress);
    if (allowance.gte(amount)) return true;
    const receipt = await runTx(`Approving ${fmtUnits(amount, decOf(token))} ${symOf(token)}...`, () => erc20.approve(contributionPoolAddress, amount));
    return !!receipt;
  };

  const handleContribute = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!contribToken) return fail('Select a token');
    let amount: BN;
    try { amount = parseAmount(contribAmount, decOf(contribToken)); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    if (walletInfo && walletInfo.balance.lt(amount)) return fail(`Insufficient ${symOf(contribToken)} balance`);
    try {
      if (!(await ensureAllowance(contribToken, amount))) return;
    } catch (e) { return fail(decodePoolError(e)); }
    await runTx(`Contributing ${contribAmount} ${symOf(contribToken)} to pool #${poolId}...`, () => pool.contribute(poolId, contribToken, amount), async (r) => {
      const ev = r.events?.find((e: any) => e.event === 'Contributed');
      setContribAmount('');
      await Promise.all([refreshAll(), fetchWalletInfo()]);
      return `Contributed ${ev ? fmtUnits(ev.args!.amount, decOf(contribToken)) : contribAmount} ${symOf(contribToken)} to pool #${poolId}.`;
    });
  };

  // ── Refund claims ──
  const [refundToken, setRefundToken] = useState('');

  const handleClaimRefund = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!refundToken) return fail('Select a token');
    await runTx(`Claiming ${symOf(refundToken)} refund from pool #${poolId}...`, () => pool.claimRefund(poolId, refundToken), async () => {
      await refreshAll();
      return `Refund claimed from pool #${poolId}.`;
    });
  };

  const handleClaimAllRefunds = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    await runTx(`Claiming all refunds from pool #${poolId}...`, () => pool.claimAllRefunds(poolId), async () => {
      await refreshAll();
      return `All refunds claimed from pool #${poolId}.`;
    });
  };

  // ── User lookup: memberOf / positionOf / getUserContributions / getUserContributionHistory ──
  const [lookupUser, setLookupUser] = useState('');
  const [member, setMember] = useState<ContributorRow | null>(null);
  const [userPools, setUserPools] = useState<{ poolId: number; info: ContributorRow }[]>([]);
  const [userPoolsTotal, setUserPoolsTotal] = useState(0);
  const [userPoolsOffset, setUserPoolsOffset] = useState(0);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [lookupLoading, setLookupLoading] = useState(false);

  useEffect(() => { if (address && !lookupUser) setLookupUser(address); }, [address, lookupUser]);

  const fetchMember = useCallback(async () => {
    const pool = getRead();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId) || !ethers.utils.isAddress(lookupUser.trim())) { setMember(null); return; }
    try {
      setMember(toContributorRow(await pool.memberOf(poolId, lookupUser.trim())));
    } catch { setMember(null); }
  }, [getRead, selectedPoolId, lookupUser]);

  const fetchUserPools = useCallback(async (offset = 0) => {
    const pool = getRead();
    if (!pool || !ethers.utils.isAddress(lookupUser.trim())) return;
    try {
      const [poolIds, infos, total] = await pool.getUserContributions(lookupUser.trim(), offset, PAGE_SIZE);
      const rows = poolIds.map((id: BN, i: number) => ({ poolId: id.toNumber(), info: toContributorRow(infos[i]) }));
      await loadTokenMeta(rows.flatMap((r: any) => r.info.tokens.map((t: TokenPositionRow) => t.token)));
      setUserPools(rows);
      setUserPoolsTotal(total.toNumber());
      setUserPoolsOffset(offset);
    } catch (e) { fail(decodePoolError(e)); }
  }, [getRead, lookupUser, loadTokenMeta]);

  const fetchHistory = useCallback(async (offset = 0) => {
    const pool = getRead();
    if (!pool || !ethers.utils.isAddress(lookupUser.trim())) return;
    try {
      const [page, total] = await pool.getUserContributionHistory(lookupUser.trim(), offset, PAGE_SIZE);
      const rows: HistoryRow[] = page.map((r: any) => ({ poolId: r.poolId.toNumber(), token: r.token, amount: r.amount, timestamp: r.timestamp.toNumber() }));
      await loadTokenMeta(rows.map(r => r.token));
      setHistory(rows);
      setHistoryTotal(total.toNumber());
      setHistoryOffset(offset);
    } catch (e) { fail(decodePoolError(e)); }
  }, [getRead, lookupUser, loadTokenMeta]);

  // newest page first: history is stored oldest-first on-chain
  const fetchLatestHistory = async () => {
    const pool = getRead();
    if (!pool || !ethers.utils.isAddress(lookupUser.trim())) return;
    try {
      const [, total] = await pool.getUserContributionHistory(lookupUser.trim(), 0, 0);
      await fetchHistory(Math.max(0, total.toNumber() - PAGE_SIZE));
    } catch (e) { fail(decodePoolError(e)); }
  };

  const runLookup = async () => {
    if (!ethers.utils.isAddress(lookupUser.trim())) return fail('Invalid address');
    setLookupLoading(true);
    await Promise.all([fetchMember(), fetchUserPools(0), fetchHistory(0)]);
    setLookupLoading(false);
  };

  useEffect(() => { if (contributionPoolAddress && ethers.utils.isAddress(lookupUser.trim())) runLookup(); }, [contributionPoolAddress, lookupUser]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchMember(); }, [fetchMember]);

  // ── Contributors of the selected pool ──
  const [contributors, setContributors] = useState<ContributorRow[]>([]);
  const [contributorsTotal, setContributorsTotal] = useState(0);
  const [contributorsOffset, setContributorsOffset] = useState(0);

  const fetchContributors = useCallback(async (offset = 0) => {
    const pool = getRead();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return;
    try {
      const [page, total] = await pool.getContributors(poolId, offset, PAGE_SIZE);
      setContributors(page.map(toContributorRow));
      setContributorsTotal(total.toNumber());
      setContributorsOffset(offset);
    } catch (e) { fail(decodePoolError(e)); }
  }, [getRead, selectedPoolId]);

  useEffect(() => { fetchContributors(0); }, [fetchContributors]);

  // ── Operator: create / update pools ──
  const [cpTokens, setCpTokens] = useState<string[]>([]);
  const [cpExtraToken, setCpExtraToken] = useState('');
  const [cpBeneficiary, setCpBeneficiary] = useState('');
  const [cpTarget, setCpTarget] = useState('');
  const [cpMaxPerUser, setCpMaxPerUser] = useState('');
  const [cpMin, setCpMin] = useState('');
  const [cpStart, setCpStart] = useState('');
  const [cpEnd, setCpEnd] = useState('');
  const [cpRef, setCpRef] = useState('');

  const toggleCpToken = (t: string) => setCpTokens(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  // ticked whitelisted tokens + typed addresses, de-duplicated (case-insensitive)
  const cpCreateTokens = useMemo(() => {
    const out: string[] = [];
    for (const t of [...cpTokens, ...parseAddressList(cpExtraToken).filter(a => ethers.utils.isAddress(a))]) {
      if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out;
  }, [cpTokens, cpExtraToken]);
  const cpNotListed = cpCreateTokens.filter(t => !allowedTokens.some(a => a.toLowerCase() === t.toLowerCase()));
  useEffect(() => { if (cpCreateTokens.length) loadTokenMeta(cpCreateTokens); }, [cpCreateTokens]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pool limits are normalized to 18 decimals (1 token = 1 unit), blank = 0 = no limit.
  type Limits = { target: BN; maxPerUser: BN; minContribution: BN; startTime: number; endTime: number };
  const buildLimits = (target: string, maxPerUser: string, min: string, start: string, end: string): Limits => ({
    target: parseAmount(target, 18),
    maxPerUser: parseAmount(maxPerUser, 18),
    minContribution: parseAmount(min, 18),
    startTime: toUnix(start),
    endTime: toUnix(end),
  });

  const handleCreatePool = async () => {
    const pool = getWrite();
    if (!pool) return;
    const extra = parseAddressList(cpExtraToken);
    const bad = extra.find(t => !ethers.utils.isAddress(t));
    if (bad) return fail(`Invalid token address: ${bad}`);
    const tokens = cpCreateTokens;
    if (tokens.length === 0) return fail('Pick at least one token');
    if (tokens.length > 10) return fail('A pool can have at most 10 tokens');
    // createPool reverts TokenNotAllowed for any token not on the global whitelist
    const notListed = tokens.filter(t => !allowedTokens.some(a => a.toLowerCase() === t.toLowerCase()));
    if (notListed.length) return fail(`Not whitelisted yet: ${notListed.join(', ')} — propose them under Proposals → Allowed Tokens first (or use "Whitelist these" below).`);
    if (!ethers.utils.isAddress(cpBeneficiary.trim())) return fail('Invalid beneficiary address');
    let limits: Limits;
    try { limits = buildLimits(cpTarget, cpMaxPerUser, cpMin, cpStart, cpEnd); } catch { return fail('Limits must be numbers'); }
    await runTx('Creating pool...', () => pool.createPool(tokens, cpBeneficiary.trim(), limits, toRef(cpRef)), async (r) => {
      const id = r.events?.find((e: any) => e.event === 'PoolCreated')?.args?.poolId?.toString();
      setCpTokens([]); setCpExtraToken(''); setCpRef('');
      await fetchOverview();
      if (id) setSelectedPoolId(id);
      return `Pool #${id ?? '?'} created.`;
    });
  };

  const [upTarget, setUpTarget] = useState('');
  const [upMaxPerUser, setUpMaxPerUser] = useState('');
  const [upMin, setUpMin] = useState('');
  const [upStart, setUpStart] = useState('');
  const [upEnd, setUpEnd] = useState('');

  const loadCurrentLimits = () => {
    if (!poolDetail) return;
    const p = poolDetail.pool;
    const s = (v: BN) => v.isZero() ? '' : fmtUnits(v, 18);
    setUpTarget(s(p.target)); setUpMaxPerUser(s(p.maxPerUser)); setUpMin(s(p.minContribution));
    setUpStart(toDtLocal(p.startTime)); setUpEnd(toDtLocal(p.endTime));
  };

  useEffect(() => { loadCurrentLimits(); }, [poolDetail?.pool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdatePool = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    let limits: Limits;
    try { limits = buildLimits(upTarget, upMaxPerUser, upMin, upStart, upEnd); } catch { return fail('Limits must be numbers'); }
    await runTx(`Updating pool #${poolId} limits...`, () => pool.updatePool(poolId, limits), async () => {
      await refreshAll();
      return `Pool #${poolId} limits updated.`;
    });
  };

  const [ptToken, setPtToken] = useState('');
  const [ptAccepted, setPtAccepted] = useState(true);

  const handleSetPoolToken = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!ethers.utils.isAddress(ptToken.trim())) return fail('Invalid token address');
    await runTx(`${ptAccepted ? 'Accepting' : 'De-listing'} token on pool #${poolId}...`, () => pool.setPoolToken(poolId, ptToken.trim(), ptAccepted), async () => {
      setPtToken('');
      await refreshAll();
      return `Token ${ptAccepted ? 'accepted' : 'de-listed'} on pool #${poolId}.`;
    });
  };

  const handleSetOpen = async (open: boolean) => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    await runTx(`${open ? 'Opening' : 'Closing'} pool #${poolId}...`, () => pool.setContributionsOpen(poolId, open), async () => {
      await refreshAll();
      return `Pool #${poolId} contributions ${open ? 'opened' : 'closed'}.`;
    });
  };

  const [rfToken, setRfToken] = useState('');
  const [rfAmount, setRfAmount] = useState('');

  const handleReturnFunds = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!rfToken) return fail('Select a token');
    let amount: BN;
    try { amount = parseAmount(rfAmount, decOf(rfToken)); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    try {
      if (!(await ensureAllowance(rfToken, amount))) return;
    } catch (e) { return fail(decodePoolError(e)); }
    await runTx(`Returning ${rfAmount} ${symOf(rfToken)} to pool #${poolId}...`, () => pool.returnFunds(poolId, rfToken, amount), async () => {
      setRfAmount('');
      await refreshAll();
      return `Returned ${rfAmount} ${symOf(rfToken)} to pool #${poolId}.`;
    });
  };

  // ── Proposals ──
  // Every propose* counts as the proposer's own approval; with threshold 1 it executes at once.
  const proposalResult = (r: ethers.ContractReceipt) => {
    const id = r.events?.find((e: any) => e.event === 'ProposalCreated')?.args?.proposalId?.toString();
    const executed = r.events?.some((e: any) => e.event === 'ProposalExecuted');
    return `Proposal #${id ?? '?'} ${executed ? 'created and executed' : 'created — waiting for more operator approvals'}.`;
  };
  const propose = (label: string, send: () => Promise<ethers.ContractTransaction>) =>
    runTx(label, send, async (r) => {
      const msg = proposalResult(r);
      await refreshAll();
      await fetchProposals(0);
      return msg;
    });

  const [prToken, setPrToken] = useState('');
  const [prAmount, setPrAmount] = useState('');
  const [patTokens, setPatTokens] = useState('');
  const [patAllowed, setPatAllowed] = useState(true);
  const [pbBeneficiary, setPbBeneficiary] = useState('');
  const [pfRelease, setPfRelease] = useState('');
  const [pfRefund, setPfRefund] = useState('');
  const [pfrRecipient, setPfrRecipient] = useState('');
  const [pacAddress, setPacAddress] = useState('');

  const handleProposeRelease = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!prToken) return fail('Select a token');
    let amount: BN;
    try { amount = parseAmount(prAmount, decOf(prToken)); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    await propose(`Proposing release of ${prAmount} ${symOf(prToken)} from pool #${poolId}...`, () => pool.proposeRelease(poolId, prToken, amount));
  };

  const handleProposeAllowedTokens = async () => {
    const pool = getWrite();
    if (!pool) return;
    const tokens = parseAddressList(patTokens);
    if (tokens.length === 0) return fail('Enter at least one token address');
    const bad = tokens.find(t => !ethers.utils.isAddress(t));
    if (bad) return fail(`Invalid token address: ${bad}`);
    await propose(`Proposing to ${patAllowed ? 'whitelist' : 'de-list'} ${tokens.length} token(s)...`, () => pool.proposeAllowedTokens(tokens, patAllowed));
    setPatTokens('');
  };

  const handleProposeBeneficiary = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!ethers.utils.isAddress(pbBeneficiary.trim())) return fail('Invalid beneficiary address');
    await propose(`Proposing new beneficiary for pool #${poolId}...`, () => pool.proposeBeneficiary(poolId, pbBeneficiary.trim()));
  };

  const handleProposeStartRefund = async () => {
    const pool = getWrite();
    const poolId = parseInt(selectedPoolId);
    if (!pool || isNaN(poolId)) return fail('Select a pool');
    if (!window.confirm(`Start refund on pool #${poolId}? This is final: contributions and releases stop for good.`)) return;
    await propose(`Proposing refund for pool #${poolId}...`, () => pool.proposeStartRefund(poolId));
  };

  const handleProposeFees = async () => {
    const pool = getWrite();
    const release = parseInt(pfRelease || '0');
    const refund = parseInt(pfRefund || '0');
    if (!pool || isNaN(release) || isNaN(refund) || release < 0 || refund < 0) return fail('Fees must be whole bps (0-1000)');
    await propose(`Proposing fees ${release}/${refund} bps...`, () => pool.proposeFees(release, refund));
  };

  const handleProposeFeeRecipient = async () => {
    const pool = getWrite();
    if (!pool || !ethers.utils.isAddress(pfrRecipient.trim())) return fail('Invalid fee recipient address');
    await propose('Proposing new fee recipient...', () => pool.proposeFeeRecipient(pfrRecipient.trim()));
  };

  const handleProposeAccessControl = async () => {
    const pool = getWrite();
    const target = pacAddress.trim() || ethers.constants.AddressZero;
    if (!pool || !ethers.utils.isAddress(target)) return fail('Invalid access control address');
    await propose(`Proposing access control ${isZero(target) ? '(disable)' : fmtAddr(target)}...`, () => pool.proposeAccessControl(target));
  };

  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [proposalsPage, setProposalsPage] = useState(0);
  const [proposalsLoading, setProposalsLoading] = useState(false);

  const fetchProposals = useCallback(async (page = 0) => {
    const pool = getRead();
    if (!pool) return;
    setProposalsLoading(true);
    try {
      const count: number = (await pool.proposalCount()).toNumber();
      const top = count - page * PAGE_SIZE;
      const ids = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, top)) }, (_, i) => top - i);
      const rows: ProposalRow[] = await Promise.all(ids.map(async (id) => {
        const [p, tokens, approvedByMe] = await Promise.all([
          pool.proposals(id),
          pool.getProposalTokens(id),
          address ? pool.hasApproved(id, address) : Promise.resolve(false),
        ]);
        return {
          id, proposalType: Number(p.proposalType), poolId: p.poolId.toNumber(), token: p.token, amount: p.amount, account: p.account,
          releaseFeeBps: p.releaseFeeBps.toNumber(), refundFeeBps: p.refundFeeBps.toNumber(), allowed: p.allowed, proposer: p.proposer,
          approvalCount: p.approvalCount.toNumber(), snapshotThreshold: p.snapshotThreshold.toNumber(), executed: p.executed, cancelled: p.cancelled,
          tokens, approvedByMe,
        };
      }));
      await loadTokenMeta(rows.flatMap(r => [...r.tokens, ...(isZero(r.token) ? [] : [r.token])]));
      setProposals(rows);
      setProposalsPage(page);
    } catch (e) {
      fail(decodePoolError(e));
    } finally {
      setProposalsLoading(false);
    }
  }, [getRead, address, loadTokenMeta]);

  useEffect(() => { fetchProposals(0); }, [contributionPoolAddress, address]); // eslint-disable-line react-hooks/exhaustive-deps

  const describeProposal = (p: ProposalRow) => {
    switch (PROPOSAL_TYPES[p.proposalType]) {
      case 'Release': return `Release ${fmtUnits(p.amount, decOf(p.token))} ${symOf(p.token)} from pool #${p.poolId}`;
      case 'SetAllowedTokens': return `${p.allowed ? 'Whitelist' : 'De-list'} ${p.tokens.map(symOf).join(', ')}`;
      case 'SetBeneficiary': return `Pool #${p.poolId} beneficiary → ${fmtAddr(p.account)}`;
      case 'StartRefund': return `Start refund on pool #${p.poolId}`;
      case 'SetFees': return `Fees → release ${p.releaseFeeBps} bps / refund ${p.refundFeeBps} bps`;
      case 'SetFeeRecipient': return `Fee recipient → ${fmtAddr(p.account)}`;
      case 'SetAccessControl': return `Access control → ${isZero(p.account) ? 'disabled' : fmtAddr(p.account)}`;
      default: return `Type ${p.proposalType}`;
    }
  };

  const handleApproveProposal = async (id: number) => {
    const pool = getWrite();
    if (!pool) return;
    await runTx(`Approving proposal #${id}...`, () => pool.approveProposal(id), async (r) => {
      const executed = r.events?.some((e: any) => e.event === 'ProposalExecuted');
      await refreshAll();
      await fetchProposals(proposalsPage);
      return `Proposal #${id} approved${executed ? ' and executed' : ''}.`;
    });
  };

  const handleRejectProposal = async (id: number) => {
    const pool = getWrite();
    if (!pool) return;
    await runTx(`Rejecting proposal #${id}...`, () => pool.rejectProposal(id), async () => {
      await fetchProposals(proposalsPage);
      return `Proposal #${id} rejected.`;
    });
  };

  // ── Admin ──
  const [thresholdInput, setThresholdInput] = useState('');
  const [rescueToken, setRescueToken] = useState('');
  const [rescueTo, setRescueTo] = useState('');
  const [rescueAmount, setRescueAmount] = useState('');
  const [rescuable, setRescuable] = useState<BN | null>(null);

  useEffect(() => {
    if (!provider || !contributionPoolAddress || !ethers.utils.isAddress(rescueToken.trim())) { setRescuable(null); return; }
    let cancelled = false;
    const token = rescueToken.trim();
    loadTokenMeta([token]);
    (async () => {
      try {
        const pool = new ethers.Contract(contributionPoolAddress, ABI, provider);
        const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
        const [bal, tracked] = await Promise.all([erc20.balanceOf(contributionPoolAddress), pool.trackedBalance(token)]);
        if (!cancelled) setRescuable(bal.sub(tracked));
      } catch { if (!cancelled) setRescuable(null); }
    })();
    return () => { cancelled = true; };
  }, [provider, contributionPoolAddress, rescueToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePause = async (pause: boolean) => {
    const pool = getWrite();
    if (!pool) return;
    await runTx(pause ? 'Pausing...' : 'Unpausing...', () => pause ? pool.pause() : pool.unpause(), async () => {
      await fetchOverview();
      return pause ? 'Paused — contributions, releases and fund returns are blocked; refund claims still work.' : 'Unpaused.';
    });
  };

  const handleSetThreshold = async () => {
    const pool = getWrite();
    const t = parseInt(thresholdInput);
    if (!pool || isNaN(t) || t < 1 || t > 100) return fail('Threshold must be 1-100');
    await runTx(`Setting proposal threshold to ${t}...`, () => pool.setProposalThreshold(t), async () => {
      setThresholdInput('');
      await fetchOverview();
      return `Proposal threshold set to ${t} (open proposals keep their own snapshot).`;
    });
  };

  const handleRescue = async () => {
    const pool = getWrite();
    const token = rescueToken.trim();
    if (!pool || !ethers.utils.isAddress(token)) return fail('Invalid token address');
    if (!ethers.utils.isAddress(rescueTo.trim())) return fail('Invalid recipient address');
    let amount: BN;
    try { amount = parseAmount(rescueAmount, decOf(token)); } catch { return fail('Amount must be a number'); }
    await runTx('Rescuing tokens...', () => pool.rescueToken(token, rescueTo.trim(), amount), () => {
      setRescueAmount('');
      return `Rescued ${rescueAmount} ${symOf(token)} to ${fmtAddr(rescueTo.trim())}.`;
    });
  };

  // ── Roles ──
  const [operatorAddrInput, setOperatorAddrInput] = useState('');
  const [adminAddrInput, setAdminAddrInput] = useState('');
  const [roleCheckAddr, setRoleCheckAddr] = useState('');
  const [roleCheckResult, setRoleCheckResult] = useState<{ isAdmin: boolean; isOperator: boolean } | null>(null);

  const handleRole = async (role: 'operator' | 'admin', grant: boolean, addrInput: string, setAddrInput: (v: string) => void) => {
    const pool = getWrite();
    if (!pool || !ethers.utils.isAddress(addrInput.trim())) return fail('Invalid address');
    const roleHash = role === 'operator' ? OPERATOR_ROLE : ADMIN_ROLE;
    await runTx(`${grant ? 'Granting' : 'Revoking'} ${role} role...`, () => grant ? pool.grantRole(roleHash, addrInput.trim()) : pool.revokeRole(roleHash, addrInput.trim()), async () => {
      const who = addrInput.trim();
      setAddrInput('');
      await fetchOverview();
      return `${role === 'operator' ? 'Operator' : 'Admin'} role ${grant ? 'granted to' : 'revoked from'} ${who}.`;
    });
  };

  // live role status of the address typed in the Operators card
  const [operatorInputStatus, setOperatorInputStatus] = useState<{ isOperator: boolean; isAdmin: boolean } | null>(null);
  useEffect(() => {
    const pool = getRead();
    const addr = operatorAddrInput.trim();
    if (!pool || !ethers.utils.isAddress(addr)) { setOperatorInputStatus(null); return; }
    let cancelled = false;
    Promise.all([pool.hasRole(OPERATOR_ROLE, addr), pool.hasRole(ADMIN_ROLE, addr)])
      .then(([isOperator, isAdmin]) => { if (!cancelled) setOperatorInputStatus({ isOperator, isAdmin }); })
      .catch(() => { if (!cancelled) setOperatorInputStatus(null); });
    return () => { cancelled = true; };
  }, [getRead, operatorAddrInput, txStatus.status]);

  const handleCheckRoles = async () => {
    const pool = getRead();
    if (!pool || !ethers.utils.isAddress(roleCheckAddr.trim())) return fail('Invalid address');
    try {
      const [isAdmin, isOperator] = await Promise.all([pool.hasRole(ADMIN_ROLE, roleCheckAddr.trim()), pool.hasRole(OPERATOR_ROLE, roleCheckAddr.trim())]);
      setRoleCheckResult({ isAdmin, isOperator });
    } catch (e) { fail(decodePoolError(e)); }
  };

  // ── Upgrade (UUPS) ──
  const [newImplAddress, setNewImplAddress] = useState('');
  const [newImplVersion, setNewImplVersion] = useState('');

  useEffect(() => {
    if (!provider || !newImplAddress || !ethers.utils.isAddress(newImplAddress)) { setNewImplVersion(''); return; }
    let cancelled = false;
    new ethers.Contract(newImplAddress, ABI, provider).version()
      .then((v: string) => { if (!cancelled) setNewImplVersion(v); })
      .catch(() => { if (!cancelled) setNewImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newImplAddress]);

  const deployNewImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new implementation...' });
    try {
      const factory = new ethers.ContractFactory(ABI, ContributionPoolArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setNewImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `New implementation deployed at ${impl.address}. Now upgrade.` });
    } catch (e: any) {
      fail(decodePoolError(e));
    }
  };

  const handleUpgrade = async () => {
    const pool = getWrite();
    if (!pool || !ethers.utils.isAddress(newImplAddress)) return;
    try {
      await pool.callStatic.upgradeToAndCall(newImplAddress, '0x');
    } catch (e) { return fail(decodePoolError(e)); }
    await runTx('Upgrading implementation...', () => pool.upgradeToAndCall(newImplAddress, '0x'), async () => {
      const impl = newImplAddress;
      setNewImplAddress('');
      await fetchOverview();
      return `Upgraded to ${impl}.`;
    });
  };

  // ── Render helpers ──
  const poolStatus = (p: PoolRow) =>
    p.refunding ? <span className="text-red-400">Refunding</span>
      : p.contributionsOpen ? <span className="text-green-400">Open</span>
        : <span className="text-yellow-400">Closed</span>;
  const limitStr = (v: BN) => v.isZero() ? 'No limit' : fmtUnits(v, 18);

  const Pager = ({ offset, total, onPage, loading }: { offset: number; total: number; onPage: (o: number) => void; loading?: boolean }) => (
    <div className="flex justify-between items-center mt-2">
      <button onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading} className={pagerBtn}>&larr; Prev</button>
      <span className="text-xs text-txt-secondary">{total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}</span>
      <button onClick={() => onPage(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading} className={pagerBtn}>Next &rarr;</button>
    </div>
  );

  // Render functions, not components: a component declared in here remounts every render and
  // its inputs would lose focus on each keystroke.
  const tokenSelect = (value: string, onChange: (v: string) => void, tokens: string[], placeholder = 'Select token...') => (
    <select value={value} onChange={e => onChange(e.target.value)} className={inputCls}>
      <option value="">{placeholder}</option>
      {tokens.map(t => <option key={t} value={t}>{symOf(t)} — {fmtAddr(t)}</option>)}
    </select>
  );

  const PositionsTable = ({ rows }: { rows: TokenPositionRow[] }) => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-txt-secondary text-left border-b border-white/10">
          <th className="py-1.5 pr-3">Token</th><th className="py-1.5 pr-3">Principal</th><th className="py-1.5 pr-3">Contributed</th>
          <th className="py-1.5 pr-3">Refunded</th><th className="py-1.5 pr-3">Refundable</th><th className="py-1.5 pr-3">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(t => (
          <tr key={t.token} className="border-b border-white/5">
            <td className="py-1.5 pr-3">{symOf(t.token)}</td>
            <td className="py-1.5 pr-3 font-mono">{fmtUnits(t.principal, decOf(t.token))}</td>
            <td className="py-1.5 pr-3 font-mono">{fmtUnits(t.totalContributed, decOf(t.token))}</td>
            <td className="py-1.5 pr-3 font-mono">{fmtUnits(t.refunded, decOf(t.token))}</td>
            <td className="py-1.5 pr-3 font-mono">{fmtUnits(t.refundable, decOf(t.token))}</td>
            <td className="py-1.5 pr-3">{fmtShare(t.share)}</td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-txt-secondary">No positions.</td></tr>}
      </tbody>
    </table>
  );

  const limitFields = (
    target: string, setTarget: (v: string) => void, maxPerUser: string, setMaxPerUser: (v: string) => void, min: string, setMin: (v: string) => void,
    start: string, setStart: (v: string) => void, end: string, setEnd: (v: string) => void,
  ) => (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <div><label className="text-xs text-txt-secondary">Target</label><input value={target} onChange={e => setTarget(e.target.value)} placeholder="0 = no limit" className={`${inputCls} mt-1`} /></div>
      <div><label className="text-xs text-txt-secondary">Max per user</label><input value={maxPerUser} onChange={e => setMaxPerUser(e.target.value)} placeholder="0 = no limit" className={`${inputCls} mt-1`} /></div>
      <div><label className="text-xs text-txt-secondary">Min contribution</label><input value={min} onChange={e => setMin(e.target.value)} placeholder="0 = no minimum" className={`${inputCls} mt-1`} /></div>
      <div className="sm:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div><label className="text-xs text-txt-secondary">Start (blank = now)</label><input value={start} onChange={e => setStart(e.target.value)} type="datetime-local" className={`${inputCls} mt-1`} /></div>
        <div><label className="text-xs text-txt-secondary">End (blank = no end)</label><input value={end} onChange={e => setEnd(e.target.value)} type="datetime-local" className={`${inputCls} mt-1`} /></div>
      </div>
    </div>
  );

  // Known stablecoins with Copy + Use ("Use" hands the address to `onUse`); the connected
  // network's tokens are highlighted since the other network's addresses won't work there.
  const knownTokens = (onUse: (addr: string) => void) => (
    <div className="bg-surface-secondary rounded-lg p-3 mb-3">
      <p className="text-xs text-txt-secondary mb-1">Common tokens</p>
      <p className="text-[11px] text-yellow-400 mb-2">&#9888; USDT / USDC below are the real <b>BSC Mainnet</b> token contracts — only use them on a mainnet deployment. tUSDT / tUSDC are BNB Testnet test tokens.</p>
      <div className="space-y-1.5">
        {KNOWN_TOKENS.map(t => {
          const current = t.chainId === netChainId;
          return (
            <div key={t.address} className={`flex items-center gap-2 text-xs ${current ? '' : 'opacity-50'}`}>
              <span className="w-24 shrink-0 text-txt-secondary">{t.network}</span>
              <span className="w-12 shrink-0 font-medium">{t.symbol}</span>
              <code className="font-mono text-accent truncate flex-1">{t.address}</code>
              <span className="text-txt-secondary shrink-0 hidden sm:inline">{t.decimals} dec</span>
              <button onClick={() => copyText(t.address, `known-${t.address}`)} className="shrink-0" title="Copy address">
                {copied === `known-${t.address}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
              </button>
              <button onClick={() => onUse(t.address)} disabled={!current} className="shrink-0 text-accent hover:underline disabled:opacity-40 disabled:no-underline" title={current ? 'Use this token' : 'Switch your wallet to this network to use it'}>Use</button>
            </div>
          );
        })}
      </div>
    </div>
  );
  const appendToken = (setter: React.Dispatch<React.SetStateAction<string>>) => (addr: string) =>
    setter(prev => parseAddressList(prev).some(a => a.toLowerCase() === addr.toLowerCase()) ? prev : [...parseAddressList(prev), addr].join('\n'));

  const selectedPoolTokenAddrs = useMemo(() => selectedTokens.map(t => t.token), [selectedTokens]);
  const notOperator = !isOperatorConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet doesn&apos;t have OPERATOR_ROLE — these actions will revert.</p>;
  const notAdmin = !isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — these actions will revert.</p>;

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* ── Deploy / Load ── */}
      <Card title="Deploy Contribution Pool" icon={<Rocket className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Upgradeable (UUPS) pooled-contribution contract. Users contribute whitelisted stablecoins to a pool; operators release funds to the pool&apos;s beneficiary or start a refund through multi-approval proposals.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the ContributionPool logic contract (constructor disables direct initialization).</p>
            <button onClick={deployImplementation} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy Implementation</button>
            {implAddress && <AddrBadge addr={implAddress} label="impl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Proxy + initialize</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the proxy and atomically calls <code className="text-accent">initialize(admin, feeRecipient, proposalThreshold)</code> — your connected wallet becomes admin.</p>
            <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="Implementation address (step 1, or paste one)" className={`${inputCls} mb-2`} />
            <label className="text-xs text-txt-secondary">Admin (DEFAULT_ADMIN_ROLE) — the deploying wallet</label>
            <p className="text-xs font-mono text-accent break-all mt-1 mb-2">{address || 'Connect a wallet'}</p>
            <label className="text-xs text-txt-secondary">Fee recipient (any address — defaults to your wallet; change later via Proposals → Fee Recipient)</label>
            <div className="flex gap-2 mt-1 mb-2">
              <input value={initFeeRecipient} onChange={e => setInitFeeRecipient(e.target.value)} placeholder="0x... fee recipient" className={inputCls} />
              <button onClick={() => setInitFeeRecipient(address)} disabled={!address} className="shrink-0 px-3 bg-surface-secondary border border-white/10 rounded-lg text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-40">Use mine</button>
            </div>
            <label className="text-xs text-txt-secondary">Proposal threshold (operator approvals per proposal, 1 = single wallet)</label>
            <input value={initThreshold} onChange={e => setInitThreshold(e.target.value)} type="number" min={1} max={100} className={`${inputCls} mt-1 mb-3`} />
            <button onClick={deployProxy} disabled={!isConnected || !implAddress} className={`w-full ${btnCls}`}>Deploy Proxy</button>
            {contributionPoolAddress && <AddrBadge addr={contributionPoolAddress} label="proxy" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">Load Existing</h4>
            <p className="text-xs text-txt-secondary mb-3">Already deployed? Paste the proxy address to load it.</p>
            <input value={manualLoad} onChange={e => setManualLoad(e.target.value)} placeholder="0x... proxy address" className={`${inputCls} mb-3`} />
            <button onClick={loadExisting} className="w-full bg-surface-secondary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm transition-colors">Load Address</button>
          </div>
        </div>
      </Card>

      {/* ── Operators ── */}
      {contributionPoolAddress && (
        <Card title="Operators" icon={<Users className="w-5 h-5 text-accent" />}>
          <p className="text-xs text-txt-secondary mb-3">
            Register an operator by granting it <code className="text-accent">OPERATOR_ROLE</code> (admin only). Operators create and manage pools, propose and approve releases / refunds / whitelist changes, and return funds. The deploying wallet is admin but not an operator — grant yourself first if you&apos;ll manage pools.
          </p>
          {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — granting/revoking operators will revert.</p>}
          <div className="flex items-center gap-2 mb-3 text-xs">
            <span className="text-txt-secondary">You:</span>
            {isConnected ? (
              <>
                <span className={isAdminConnected ? 'text-yellow-400 font-medium' : 'text-txt-secondary'}>{isAdminConnected ? '✓ Admin' : '✗ Admin'}</span>
                <span className={isOperatorConnected ? 'text-accent font-medium' : 'text-txt-secondary'}>{isOperatorConnected ? '✓ Operator' : '✗ Operator'}</span>
              </>
            ) : <span className="text-txt-secondary">Not connected</span>}
          </div>
          <label className="text-xs text-txt-secondary">Operator address</label>
          <div className="flex gap-2 mt-1">
            <input value={operatorAddrInput} onChange={e => setOperatorAddrInput(e.target.value)} placeholder="0x... operator wallet" className={inputCls} />
            <button onClick={() => setOperatorAddrInput(address)} disabled={!address} className="shrink-0 px-3 bg-surface-tertiary border border-white/10 rounded-lg text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-40">Use mine</button>
            <button onClick={() => handleRole('operator', true, operatorAddrInput, setOperatorAddrInput)} disabled={!isAdminConnected || operatorInputStatus?.isOperator} className={smallBtn}>Register</button>
            <button onClick={() => handleRole('operator', false, operatorAddrInput, setOperatorAddrInput)} disabled={!isAdminConnected || operatorInputStatus?.isOperator === false} className={dangerBtn}>Remove</button>
          </div>
          {operatorInputStatus && (
            <p className="text-xs mt-2">
              {operatorInputStatus.isOperator ? <span className="text-accent">Already an operator</span> : <span className="text-txt-secondary">Not an operator yet</span>}
              {operatorInputStatus.isAdmin && <span className="text-yellow-400 ml-2">· Admin</span>}
            </p>
          )}
        </Card>
      )}

      {/* ── ABI ── */}
      <Card title="ABI" icon={<FileCode2 className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          ContributionPool ABI ({ABI_FUNCTIONS.length} functions, {ABI.length} entries) — use it with the proxy address to call the contract from a frontend or backend.
        </p>
        <div className="flex gap-2 mb-3 flex-wrap">
          <button onClick={() => copyText(ABI_JSON, 'abi')} className={`flex items-center gap-1.5 px-4 ${btnCls}`}>
            {copied === 'abi' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied === 'abi' ? 'Copied' : 'Copy ABI'}
          </button>
          <button onClick={downloadAbi} className="flex items-center gap-1.5 px-4 bg-surface-tertiary border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm">
            <Download className="w-4 h-4" /> Download ContributionPool.abi.json
          </button>
        </div>
        <details className="bg-surface-tertiary rounded-lg p-3 mb-2">
          <summary className="text-xs text-txt-secondary cursor-pointer">Functions</summary>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
            {ABI_FUNCTIONS.map((f: any) => (
              <code key={`${f.name}(${f.inputs.map((i: any) => i.type).join(',')})`} className="text-[11px] font-mono text-txt-primary break-all">
                <span className={f.stateMutability === 'view' || f.stateMutability === 'pure' ? 'text-accent' : 'text-yellow-400'}>{f.name}</span>
                ({f.inputs.map((i: any) => `${i.type} ${i.name}`).join(', ')})
              </code>
            ))}
          </div>
          <p className="text-[10px] text-txt-secondary mt-2"><span className="text-accent">Blue</span> = view (free), <span className="text-yellow-400">yellow</span> = transaction.</p>
        </details>
        <details className="bg-surface-tertiary rounded-lg p-3">
          <summary className="text-xs text-txt-secondary cursor-pointer">Raw JSON</summary>
          <pre className="mt-2 text-[11px] font-mono max-h-80 overflow-auto whitespace-pre">{ABI_JSON}</pre>
        </details>
      </Card>

      {!contributionPoolAddress ? (
        <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load a ContributionPool to manage pools, contributions and proposals.</p></Card>
      ) : (
        <>
          {/* ── Overview ── */}
          <Card title={
            <span className="flex items-center gap-2">
              Overview
              <button onClick={fetchOverview} disabled={overviewLoading} className="p-1 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-4 h-4 text-txt-secondary ${overviewLoading ? 'animate-spin' : ''}`} />
              </button>
            </span>
          } icon={<PiggyBank className="w-5 h-5 text-accent" />}>
            {overviewLoadError && (
              <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 mb-3">
                <p className="text-red-300 text-xs">{overviewLoadError}</p>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
              <div><p className="text-xs text-txt-secondary">Version</p><p className="text-sm font-bold text-accent">{overview?.version || '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Pools / Proposals</p><p className="text-sm font-bold text-accent">{overview ? `${overview.poolCount} / ${overview.proposalCount}` : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Proposal Threshold</p><p className="text-sm font-bold text-txt-primary">{overview?.proposalThreshold ?? '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Status</p><p className={`text-sm font-bold ${overview?.paused ? 'text-red-400' : 'text-green-400'}`}>{overview ? (overview.paused ? 'Paused' : 'Active') : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Fees (release / refund)</p><p className="text-sm text-txt-primary">{overview ? `${overview.releaseFeeBps} / ${overview.refundFeeBps} bps` : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Fee Recipient</p><p className="text-xs font-mono text-txt-primary">{overview ? fmtAddr(overview.feeRecipient) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Access Control</p><p className="text-xs font-mono text-txt-primary">{overview ? (isZero(overview.accessControl) ? 'Disabled' : fmtAddr(overview.accessControl)) : '—'}</p></div>
              <div>
                <p className="text-xs text-txt-secondary">Your Roles</p>
                <p className="text-xs">
                  {isAdminConnected && <span className="text-yellow-400 font-medium mr-2">Admin</span>}
                  {isOperatorConnected && <span className="text-accent font-medium mr-2">Operator</span>}
                  {!isAdminConnected && !isOperatorConnected && <span className="text-txt-secondary">{isConnected ? 'Contributor' : 'Not connected'}</span>}
                </p>
              </div>
            </div>
            <AddrBadge addr={contributionPoolAddress} label="loaded" />
            <div className="mt-4">
              <p className="text-xs text-txt-secondary mb-1">Whitelisted tokens ({allowedTokens.length})</p>
              <div className="flex flex-wrap gap-2">
                {allowedTokens.map(t => (
                  <a key={t} href={getExplorerAddressUrl(chainId, t)} target="_blank" rel="noopener noreferrer" className="text-xs bg-surface-tertiary rounded-lg px-2.5 py-1 hover:text-accent">
                    {symOf(t)} <span className="text-txt-secondary font-mono">{fmtAddr(t)}</span> <span className="text-txt-secondary">({decOf(t)} dec)</span>
                  </a>
                ))}
                {allowedTokens.length === 0 && <span className="text-xs text-txt-secondary">None — propose tokens under Proposals before creating a pool.</span>}
              </div>
            </div>
          </Card>

          {/* ── Pools ── */}
          <Card title={
            <span className="flex items-center gap-2">
              Pools
              <button onClick={() => fetchPools(poolsPage)} disabled={poolsLoading} className="p-1 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-4 h-4 text-txt-secondary ${poolsLoading ? 'animate-spin' : ''}`} />
              </button>
            </span>
          } icon={<Layers className="w-5 h-5 text-accent" />}>
            <p className="text-xs text-txt-secondary mb-2">Totals are normalized to 18 decimals across tokens (1 token = 1 unit). Click a pool to select it for the sections below.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">ID</th><th className="py-1.5 pr-3">Beneficiary</th><th className="py-1.5 pr-3">Raised</th>
                    <th className="py-1.5 pr-3">Total Contributed</th><th className="py-1.5 pr-3">Contributors</th><th className="py-1.5 pr-3">Target</th><th className="py-1.5 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map(p => (
                    <tr key={p.id} onClick={() => setSelectedPoolId(String(p.id))} className={`border-b border-white/5 cursor-pointer hover:bg-surface-tertiary ${String(p.id) === selectedPoolId ? 'bg-accent/10' : ''}`}>
                      <td className="py-1.5 pr-3 font-mono">#{p.id}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtAddr(p.beneficiary)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(p.raised, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(p.totalContributed, 18)}</td>
                      <td className="py-1.5 pr-3">{p.activeContributors} active / {p.contributorCount}</td>
                      <td className="py-1.5 pr-3">{limitStr(p.target)}</td>
                      <td className="py-1.5 pr-3">{poolStatus(p)}</td>
                    </tr>
                  ))}
                  {pools.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-txt-secondary">No pools yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager offset={poolsPage * PAGE_SIZE} total={poolCount} onPage={(o) => fetchPools(Math.floor(o / PAGE_SIZE))} loading={poolsLoading} />
          </Card>

          {/* ── Selected pool ── */}
          <Card title={
            <span className="flex items-center gap-2">
              Pool Details
              <button onClick={() => fetchPoolDetail()} className="p-1 rounded hover:bg-surface-tertiary"><RefreshCw className="w-4 h-4 text-txt-secondary" /></button>
            </span>
          } icon={<Search className="w-5 h-5 text-accent" />}>
            <div className="flex gap-2 mb-3">
              <input value={selectedPoolId} onChange={e => setSelectedPoolId(e.target.value)} placeholder="Pool ID" type="number" min={1} className={`${inputCls} max-w-[160px]`} />
              <button onClick={() => fetchPoolDetail()} className={`shrink-0 px-4 ${btnCls}`}>Load</button>
            </div>
            {poolDetailError && <p className="text-xs text-red-400 mb-2">{poolDetailError}</p>}
            {poolDetail && (
              <div className="space-y-3">
                <div className="bg-surface-tertiary rounded-lg p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div><p className="text-xs text-txt-secondary">Pool</p><p className="font-bold">#{poolDetail.pool.id} {poolStatus(poolDetail.pool)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Beneficiary</p><p className="font-mono text-xs break-all">{poolDetail.pool.beneficiary}</p></div>
                  <div><p className="text-xs text-txt-secondary">Raised (outstanding)</p><p className="font-mono">{fmtUnits(poolDetail.pool.raised, 18)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Total Contributed / Refunded</p><p className="font-mono">{fmtUnits(poolDetail.pool.totalContributed, 18)} / {fmtUnits(poolDetail.pool.totalRefunded, 18)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Target</p><p>{limitStr(poolDetail.pool.target)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Max per user</p><p>{limitStr(poolDetail.pool.maxPerUser)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Min contribution</p><p>{limitStr(poolDetail.pool.minContribution)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Contributors</p><p>{poolDetail.pool.activeContributors} active / {poolDetail.pool.contributorCount}</p></div>
                  <div><p className="text-xs text-txt-secondary">Start</p><p className="text-xs">{fmtTs(poolDetail.pool.startTime)}</p></div>
                  <div><p className="text-xs text-txt-secondary">End</p><p className="text-xs">{fmtTs(poolDetail.pool.endTime)}</p></div>
                  <div className="col-span-2"><p className="text-xs text-txt-secondary">Ref</p><p className="font-mono text-xs break-all">{fmtRef(poolDetail.pool.ref)}</p></div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-txt-secondary text-left border-b border-white/10">
                        <th className="py-1.5 pr-3">Token</th><th className="py-1.5 pr-3">Accepted</th><th className="py-1.5 pr-3">Balance</th><th className="py-1.5 pr-3">Raised</th>
                        <th className="py-1.5 pr-3">Contributed</th><th className="py-1.5 pr-3">Refunded</th><th className="py-1.5 pr-3">Released</th><th className="py-1.5 pr-3">Returned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poolDetail.tokens.map(t => (
                        <tr key={t.token} className="border-b border-white/5">
                          <td className="py-1.5 pr-3">{symOf(t.token)} <span className="text-txt-secondary font-mono">{fmtAddr(t.token)}</span></td>
                          <td className="py-1.5 pr-3">{t.accepted ? <span className="text-green-400">Yes</span> : <span className="text-txt-secondary">No</span>}</td>
                          {[t.balance, t.raised, t.totalContributed, t.totalRefunded, t.released, t.returned].map((v, i) => (
                            <td key={i} className="py-1.5 pr-3 font-mono">{fmtUnits(v, decOf(t.token))}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>

          {/* ── Contribute & refunds ── */}
          <Card title={`Contribute${selectedPoolId ? ` to Pool #${selectedPoolId}` : ''}`} icon={<HandCoins className="w-5 h-5 text-accent" />}>
            {poolDetail?.pool.refunding ? (
              <p className="text-xs text-yellow-400 mb-3">This pool is in refund mode — contributions are closed, claim your refund below.</p>
            ) : poolDetail && !poolDetail.pool.contributionsOpen ? (
              <p className="text-xs text-yellow-400 mb-3">Contributions are closed for this pool.</p>
            ) : null}
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <div>
                <label className="text-xs text-txt-secondary">Token</label>
                <div className="mt-1">{tokenSelect(contribToken, setContribToken, acceptedTokens.map(t => t.token))}</div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Amount {contribToken && `(${symOf(contribToken)})`}</label>
                <input value={contribAmount} onChange={e => setContribAmount(e.target.value)} placeholder="100" className={`${inputCls} mt-1`} />
              </div>
              <button onClick={handleContribute} disabled={!isConnected || !contribToken || !contribAmount} className={`px-6 ${btnCls}`}>Contribute</button>
            </div>
            {walletInfo && contribToken && (
              <p className="text-xs text-txt-secondary mt-2">
                Your balance: <span className="text-txt-primary font-mono">{fmtUnits(walletInfo.balance, decOf(contribToken))} {symOf(contribToken)}</span>
                {' · '}Approved for pool: <span className="text-txt-primary font-mono">{walletInfo.allowance.gt(ethers.constants.MaxUint256.div(2)) ? 'Unlimited' : fmtUnits(walletInfo.allowance, decOf(contribToken))}</span>
                {' — '}an approve() is sent first if the allowance is too low.
              </p>
            )}
            <div className="border-t border-white/10 mt-4 pt-4">
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2"><Undo2 className="w-4 h-4 text-accent" /> Refund Claims</h4>
              <p className="text-xs text-txt-secondary mb-2">Only after an operator starts a refund on the pool. Pays principal × balance / raised per token, minus the refund fee. Works while paused.</p>
              <div className="flex gap-2 flex-wrap">
                <div className="flex-1 min-w-[200px]">{tokenSelect(refundToken, setRefundToken, selectedPoolTokenAddrs)}</div>
                <button onClick={handleClaimRefund} disabled={!isConnected || !refundToken} className={`px-4 ${btnCls}`}>Claim Refund</button>
                <button onClick={handleClaimAllRefunds} disabled={!isConnected} className="px-4 bg-surface-tertiary border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm disabled:opacity-40">Claim All Tokens</button>
              </div>
            </div>
          </Card>

          {/* ── User lookup ── */}
          <Card title="Contributions by User" icon={<History className="w-5 h-5 text-accent" />}>
            <div className="flex gap-2 mb-4">
              <input value={lookupUser} onChange={e => setLookupUser(e.target.value)} placeholder="0x... user (defaults to your wallet)" className={inputCls} />
              <button onClick={runLookup} disabled={lookupLoading} className={`shrink-0 px-4 ${btnCls}`}><Search className="w-4 h-4" /></button>
            </div>

            <h4 className="text-sm font-medium mb-1">Position in pool #{selectedPoolId || '—'} <span className="text-xs text-txt-secondary font-normal">memberOf / positionOf</span></h4>
            {member ? (
              <>
                <p className="text-xs text-txt-secondary mb-2">
                  Principal <span className="text-txt-primary font-mono">{fmtUnits(member.principal, 18)}</span>
                  {' · '}Contributed <span className="text-txt-primary font-mono">{fmtUnits(member.totalContributed, 18)}</span>
                  {' · '}Refunded <span className="text-txt-primary font-mono">{fmtUnits(member.totalRefunded, 18)}</span>
                  {' · '}Refundable <span className="text-txt-primary font-mono">{fmtUnits(member.refundable, 18)}</span>
                  {' · '}Share <span className="text-accent">{fmtShare(member.share)}</span>
                </p>
                <div className="overflow-x-auto mb-4"><PositionsTable rows={member.tokens} /></div>
              </>
            ) : <p className="text-xs text-txt-secondary mb-4">Select a pool and a user.</p>}

            <h4 className="text-sm font-medium mb-1">Totals per pool <span className="text-xs text-txt-secondary font-normal">getUserContributions — one row per pool</span></h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">Pool</th><th className="py-1.5 pr-3">Principal</th><th className="py-1.5 pr-3">Contributed</th>
                    <th className="py-1.5 pr-3">Refunded</th><th className="py-1.5 pr-3">Refundable</th><th className="py-1.5 pr-3">Share</th><th className="py-1.5 pr-3">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {userPools.map(({ poolId, info }) => (
                    <tr key={poolId} className="border-b border-white/5">
                      <td className="py-1.5 pr-3 font-mono"><button onClick={() => setSelectedPoolId(String(poolId))} className="text-accent hover:underline">#{poolId}</button></td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(info.principal, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(info.totalContributed, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(info.totalRefunded, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(info.refundable, 18)}</td>
                      <td className="py-1.5 pr-3">{fmtShare(info.share)}</td>
                      <td className="py-1.5 pr-3">{info.tokens.filter(t => !t.totalContributed.isZero()).map(t => `${fmtUnits(t.totalContributed, decOf(t.token))} ${symOf(t.token)}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                  {userPools.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-txt-secondary">No contributions.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager offset={userPoolsOffset} total={userPoolsTotal} onPage={fetchUserPools} />

            <h4 className="text-sm font-medium mb-1 mt-5 flex items-center gap-2">
              History <span className="text-xs text-txt-secondary font-normal">getUserContributionHistory — every contribution, oldest first</span>
              <button onClick={fetchLatestHistory} className="ml-auto text-xs text-accent hover:underline font-normal">Latest page</button>
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">#</th><th className="py-1.5 pr-3">Time</th><th className="py-1.5 pr-3">Pool</th><th className="py-1.5 pr-3">Token</th><th className="py-1.5 pr-3">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={historyOffset + i} className="border-b border-white/5">
                      <td className="py-1.5 pr-3 font-mono text-txt-secondary">{historyOffset + i + 1}</td>
                      <td className="py-1.5 pr-3">{fmtTs(h.timestamp)}</td>
                      <td className="py-1.5 pr-3 font-mono"><button onClick={() => setSelectedPoolId(String(h.poolId))} className="text-accent hover:underline">#{h.poolId}</button></td>
                      <td className="py-1.5 pr-3">{symOf(h.token)}</td>
                      <td className="py-1.5 pr-3 font-mono text-green-400">{fmtUnits(h.amount, decOf(h.token))}</td>
                    </tr>
                  ))}
                  {history.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-txt-secondary">No contributions.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager offset={historyOffset} total={historyTotal} onPage={fetchHistory} />
          </Card>

          {/* ── Contributors ── */}
          <Card title={`Contributors${selectedPoolId ? ` of Pool #${selectedPoolId}` : ''}`} icon={<Users className="w-5 h-5 text-accent" />}>
            <p className="text-xs text-txt-secondary mb-2">getContributors — in order of first contribution; users who claimed a full refund stay listed with 0 principal.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">User</th><th className="py-1.5 pr-3">Principal</th><th className="py-1.5 pr-3">Contributed</th>
                    <th className="py-1.5 pr-3">Refunded</th><th className="py-1.5 pr-3">Share</th><th className="py-1.5 pr-3">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {contributors.map(c => (
                    <tr key={c.user} className="border-b border-white/5">
                      <td className="py-1.5 pr-3 font-mono"><button onClick={() => setLookupUser(c.user)} className="text-accent hover:underline">{fmtAddr(c.user)}</button></td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(c.principal, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(c.totalContributed, 18)}</td>
                      <td className="py-1.5 pr-3 font-mono">{fmtUnits(c.totalRefunded, 18)}</td>
                      <td className="py-1.5 pr-3">{fmtShare(c.share)}</td>
                      <td className="py-1.5 pr-3">{c.tokens.filter(t => !t.principal.isZero()).map(t => `${fmtUnits(t.principal, decOf(t.token))} ${symOf(t.token)}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                  {contributors.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-txt-secondary">No contributors.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager offset={contributorsOffset} total={contributorsTotal} onPage={fetchContributors} />
          </Card>

          {/* ── Operator: pool management ── */}
          <Card title="Pool Management (Operator)" icon={<Settings2 className="w-5 h-5 text-accent" />}>
            {notOperator}
            <div className="bg-surface-tertiary rounded-lg p-4 mb-4">
              <h4 className="font-medium mb-2 flex items-center gap-2"><Plus className="w-4 h-4 text-accent" /> Create Pool</h4>
              <label className="text-xs text-txt-secondary">Tokens — tick any number (max 10 per pool)</label>
              <div className="flex flex-wrap gap-3 mt-1 mb-2">
                {allowedTokens.map(t => (
                  <label key={t} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={cpTokens.includes(t)} onChange={() => toggleCpToken(t)} className="w-4 h-4 accent-accent" /> {symOf(t)}
                  </label>
                ))}
                {allowedTokens.length === 0 && <span className="text-xs text-txt-secondary">No whitelisted tokens yet.</span>}
              </div>
              <textarea value={cpExtraToken} onChange={e => setCpExtraToken(e.target.value)} placeholder="More token addresses (optional) — comma or newline separated" rows={2} className={`${inputCls} mb-2`} />
              {knownTokens((addr) => {
                const listed = allowedTokens.find(t => t.toLowerCase() === addr.toLowerCase());
                if (listed) setCpTokens(prev => prev.includes(listed) ? prev : [...prev, listed]);
                else appendToken(setCpExtraToken)(addr);
              })}
              <div className="text-xs mb-2 -mt-1">
                <span className="text-txt-secondary">Pool tokens ({cpCreateTokens.length}/10): </span>
                {cpCreateTokens.length === 0 ? <span className="text-txt-secondary">none selected</span> : cpCreateTokens.map(t => (
                  <span key={t} className={`mr-2 ${cpNotListed.includes(t) ? 'text-red-400' : 'text-accent'}`}>{symOf(t)}{cpNotListed.includes(t) && ' (not whitelisted)'}</span>
                ))}
                {cpNotListed.length > 0 && (
                  <button onClick={() => setPatTokens(cpNotListed.join('\n'))} className="text-accent hover:underline ml-1">Whitelist these →</button>
                )}
              </div>
              <p className="text-[10px] text-txt-secondary -mt-2 mb-2">A token must be whitelisted (Proposals → Allowed Tokens) before a pool can use it.</p>
              <label className="text-xs text-txt-secondary">Beneficiary (only address released funds can go to)</label>
              <input value={cpBeneficiary} onChange={e => setCpBeneficiary(e.target.value)} placeholder="0x..." className={`${inputCls} mt-1 mb-2`} />
              <p className="text-xs text-txt-secondary mb-1">Limits — whole tokens, counted across tokens as 1 token = 1 unit</p>
              {limitFields(cpTarget, setCpTarget, cpMaxPerUser, setCpMaxPerUser, cpMin, setCpMin, cpStart, setCpStart, cpEnd, setCpEnd)}
              <label className="text-xs text-txt-secondary mt-2 block">Ref (optional external id — text up to 31 chars or 0x bytes32)</label>
              <input value={cpRef} onChange={e => setCpRef(e.target.value)} placeholder="e.g. campaign-001" className={`${inputCls} mt-1`} />
              <button onClick={handleCreatePool} disabled={!isOperatorConnected} className={`w-full mt-3 ${btnCls}`}>Create Pool</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  Update Limits — Pool #{selectedPoolId || '—'}
                  <button onClick={loadCurrentLimits} className="ml-auto text-xs text-accent hover:underline font-normal">Load current</button>
                </h4>
                {limitFields(upTarget, setUpTarget, upMaxPerUser, setUpMaxPerUser, upMin, setUpMin, upStart, setUpStart, upEnd, setUpEnd)}
                <button onClick={handleUpdatePool} disabled={!isOperatorConnected || !selectedPoolId} className={`w-full mt-3 ${btnCls}`}>Update Pool</button>
              </div>
              <div className="space-y-4">
                <div className="bg-surface-tertiary rounded-lg p-4">
                  <h4 className="font-medium mb-2">Contributions — Pool #{selectedPoolId || '—'}</h4>
                  <div className="flex gap-2">
                    <button onClick={() => handleSetOpen(true)} disabled={!isOperatorConnected || !selectedPoolId} className={`flex-1 ${btnCls}`}>Open</button>
                    <button onClick={() => handleSetOpen(false)} disabled={!isOperatorConnected || !selectedPoolId} className="flex-1 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm">Close</button>
                  </div>
                </div>
                <div className="bg-surface-tertiary rounded-lg p-4">
                  <h4 className="font-medium mb-2">Pool Token — Pool #{selectedPoolId || '—'}</h4>
                  <p className="text-xs text-txt-secondary mb-2">Accept a whitelisted token, or stop new contributions in one (existing balances stay releasable / refundable).</p>
                  <div className="flex gap-2">
                    <input value={ptToken} onChange={e => setPtToken(e.target.value)} placeholder="0x... token" className={inputCls} />
                    <select value={ptAccepted ? '1' : '0'} onChange={e => setPtAccepted(e.target.value === '1')} className={`${inputCls} max-w-[120px]`}>
                      <option value="1">Accept</option>
                      <option value="0">De-list</option>
                    </select>
                    <button onClick={handleSetPoolToken} disabled={!isOperatorConnected || !selectedPoolId} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                  </div>
                </div>
                <div className="bg-surface-tertiary rounded-lg p-4">
                  <h4 className="font-medium mb-2">Return Funds — Pool #{selectedPoolId || '—'}</h4>
                  <p className="text-xs text-txt-secondary mb-2">Top the pool back up after a release (up to raised − balance), e.g. before users claim refunds. Approves first if needed.</p>
                  <div className="flex gap-2">
                    <div className="flex-1">{tokenSelect(rfToken, setRfToken, selectedPoolTokenAddrs)}</div>
                    <input value={rfAmount} onChange={e => setRfAmount(e.target.value)} placeholder="Amount" className={`${inputCls} max-w-[140px]`} />
                    <button onClick={handleReturnFunds} disabled={!isOperatorConnected || !selectedPoolId} className={`shrink-0 px-4 ${btnCls}`}>Return</button>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Proposals ── */}
          <Card title="Proposals (Operator)" icon={<Vote className="w-5 h-5 text-accent" />}>
            {notOperator}
            <p className="text-xs text-txt-secondary mb-3">
              Releases, token whitelist, beneficiary, refunds, fees, fee recipient and access control all go through proposals. Proposing counts as your approval — it executes once it has {overview?.proposalThreshold ?? '?'} operator approval(s).
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Release — Pool #{selectedPoolId || '—'}</h4>
                <p className="text-xs text-txt-secondary mb-2">Sends funds to the beneficiary {poolDetail ? fmtAddr(poolDetail.pool.beneficiary) : ''}, minus the release fee.</p>
                <div className="flex gap-2">
                  <div className="flex-1">{tokenSelect(prToken, setPrToken, selectedPoolTokenAddrs)}</div>
                  <input value={prAmount} onChange={e => setPrAmount(e.target.value)} placeholder="Amount" className={`${inputCls} max-w-[140px]`} />
                  <button onClick={handleProposeRelease} disabled={!isOperatorConnected || !selectedPoolId} className={smallBtn}>Propose</button>
                </div>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Allowed Tokens (global whitelist)</h4>
                <textarea value={patTokens} onChange={e => setPatTokens(e.target.value)} placeholder="Token addresses, comma or newline separated (max 20)" rows={2} className={`${inputCls} mb-2`} />
                {knownTokens(appendToken(setPatTokens))}
                <div className="flex gap-2">
                  <select value={patAllowed ? '1' : '0'} onChange={e => setPatAllowed(e.target.value === '1')} className={inputCls}>
                    <option value="1">Whitelist</option>
                    <option value="0">De-list</option>
                  </select>
                  <button onClick={handleProposeAllowedTokens} disabled={!isOperatorConnected} className={smallBtn}>Propose</button>
                </div>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Beneficiary — Pool #{selectedPoolId || '—'}</h4>
                <div className="flex gap-2">
                  <input value={pbBeneficiary} onChange={e => setPbBeneficiary(e.target.value)} placeholder="0x... new beneficiary" className={inputCls} />
                  <button onClick={handleProposeBeneficiary} disabled={!isOperatorConnected || !selectedPoolId} className={smallBtn}>Propose</button>
                </div>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Start Refund — Pool #{selectedPoolId || '—'}</h4>
                <p className="text-xs text-txt-secondary mb-2">Final: stops contributions and releases, users claim back their own tokens pro-rata.</p>
                <button onClick={handleProposeStartRefund} disabled={!isOperatorConnected || !selectedPoolId || poolDetail?.pool.refunding} className="w-full bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm">Propose Refund</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Fees (bps, max 1000 = 10%)</h4>
                <div className="flex gap-2">
                  <input value={pfRelease} onChange={e => setPfRelease(e.target.value)} placeholder={`Release (now ${overview?.releaseFeeBps ?? '?'})`} type="number" min={0} max={1000} className={inputCls} />
                  <input value={pfRefund} onChange={e => setPfRefund(e.target.value)} placeholder={`Refund (now ${overview?.refundFeeBps ?? '?'})`} type="number" min={0} max={1000} className={inputCls} />
                  <button onClick={handleProposeFees} disabled={!isOperatorConnected} className={smallBtn}>Propose</button>
                </div>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Fee Recipient</h4>
                <div className="flex gap-2">
                  <input value={pfrRecipient} onChange={e => setPfrRecipient(e.target.value)} placeholder={overview ? `Now ${fmtAddr(overview.feeRecipient)}` : '0x...'} className={inputCls} />
                  <button onClick={handleProposeFeeRecipient} disabled={!isOperatorConnected} className={smallBtn}>Propose</button>
                </div>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4 md:col-span-2">
                <h4 className="font-medium mb-2">Access Control (ATMAccessControl)</h4>
                <p className="text-xs text-txt-secondary mb-2">Restricted users can&apos;t contribute; frozen users&apos; refunds go to their safe wallet. Leave blank to disable checks.</p>
                <div className="flex gap-2">
                  <input value={pacAddress} onChange={e => setPacAddress(e.target.value)} placeholder={overview ? (isZero(overview.accessControl) ? 'Now disabled' : `Now ${fmtAddr(overview.accessControl)}`) : '0x...'} className={inputCls} />
                  <button onClick={handleProposeAccessControl} disabled={!isOperatorConnected} className={smallBtn}>Propose</button>
                </div>
              </div>
            </div>

            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              All Proposals (newest first)
              <button onClick={() => fetchProposals(proposalsPage)} disabled={proposalsLoading} className="p-1 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-3.5 h-3.5 text-txt-secondary ${proposalsLoading ? 'animate-spin' : ''}`} />
              </button>
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">ID</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">Details</th>
                    <th className="py-1.5 pr-3">Proposer</th><th className="py-1.5 pr-3">Approvals</th><th className="py-1.5 pr-3">Status</th><th className="py-1.5 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map(p => {
                    const open = !p.executed && !p.cancelled;
                    const canReject = open && (isAdminConnected || p.proposer.toLowerCase() === address?.toLowerCase());
                    return (
                      <tr key={p.id} className="border-b border-white/5">
                        <td className="py-1.5 pr-3 font-mono">#{p.id}</td>
                        <td className="py-1.5 pr-3">{PROPOSAL_TYPES[p.proposalType] ?? p.proposalType}</td>
                        <td className="py-1.5 pr-3">{describeProposal(p)}</td>
                        <td className="py-1.5 pr-3 font-mono">{fmtAddr(p.proposer)}</td>
                        <td className="py-1.5 pr-3">{p.approvalCount} / {p.snapshotThreshold}{p.approvedByMe && <span className="text-accent ml-1">(you)</span>}</td>
                        <td className="py-1.5 pr-3">
                          {p.executed ? <span className="text-green-400">Executed</span> : p.cancelled ? <span className="text-txt-secondary">Rejected</span> : <span className="text-yellow-400">Open</span>}
                        </td>
                        <td className="py-1.5 pr-3">
                          {open && (
                            <div className="flex gap-1.5 justify-end">
                              <button onClick={() => handleApproveProposal(p.id)} disabled={!isOperatorConnected || p.approvedByMe} className={`${smallBtn} py-1`}>Approve</button>
                              <button onClick={() => handleRejectProposal(p.id)} disabled={!canReject} className={`${dangerBtn} py-1`}>Reject</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {proposals.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-txt-secondary">No proposals.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager offset={proposalsPage * PAGE_SIZE} total={overview?.proposalCount ?? 0} onPage={(o) => fetchProposals(Math.floor(o / PAGE_SIZE))} loading={proposalsLoading} />
          </Card>

          {/* ── Admin ── */}
          <Card title="Admin Controls" icon={<ShieldCheck className="w-5 h-5 text-yellow-400" />}>
            {notAdmin}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-txt-secondary">Pause (blocks contributions, releases, fund returns — never refund claims or proposals)</label>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => handlePause(true)} disabled={!isAdminConnected || overview?.paused} className="flex-1 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white font-semibold py-2.5 rounded-lg text-sm">Pause</button>
                  <button onClick={() => handlePause(false)} disabled={!isAdminConnected || !overview?.paused} className={`flex-1 ${btnCls}`}>Unpause</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Proposal Threshold (now {overview?.proposalThreshold ?? '?'}; open proposals keep theirs)</label>
                <div className="flex gap-2 mt-1">
                  <input value={thresholdInput} onChange={e => setThresholdInput(e.target.value)} placeholder="1-100" type="number" min={1} max={100} className={inputCls} />
                  <button onClick={handleSetThreshold} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-txt-secondary">
                  Rescue Tokens — only tokens not owed to any pool
                  {rescuable && ethers.utils.isAddress(rescueToken.trim()) && <> (rescuable now: <span className="text-txt-primary font-mono">{fmtUnits(rescuable, decOf(rescueToken.trim()))} {symOf(rescueToken.trim())}</span>)</>}
                </label>
                <div className="flex gap-2 mt-1 flex-wrap md:flex-nowrap">
                  <input value={rescueToken} onChange={e => setRescueToken(e.target.value)} placeholder="0x... token" className={inputCls} />
                  <input value={rescueTo} onChange={e => setRescueTo(e.target.value)} placeholder="0x... send to" className={inputCls} />
                  <input value={rescueAmount} onChange={e => setRescueAmount(e.target.value)} placeholder="Amount" className={`${inputCls} md:max-w-[140px]`} />
                  <button onClick={handleRescue} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Rescue</button>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Roles ── */}
          <Card title="Roles" icon={<KeyRound className="w-5 h-5 text-yellow-400" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — granting/revoking roles will revert.</p>}
            <p className="text-xs text-txt-secondary mb-3">Operators are registered in the Operators section at the top.</p>
            <div className="grid grid-cols-1 gap-4 mb-4">
              <div>
                <label className="text-xs text-txt-secondary">Admin Role (DEFAULT_ADMIN_ROLE — upgrades, pause, roles, rescue)</label>
                <div className="flex gap-2 mt-1">
                  <input value={adminAddrInput} onChange={e => setAdminAddrInput(e.target.value)} placeholder="0x..." className={inputCls} />
                  <button onClick={() => handleRole('admin', true, adminAddrInput, setAdminAddrInput)} disabled={!isAdminConnected} className={smallBtn}>Grant</button>
                  <button onClick={() => handleRole('admin', false, adminAddrInput, setAdminAddrInput)} disabled={!isAdminConnected} className={dangerBtn}>Revoke</button>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-txt-secondary">Check Roles</label>
              <div className="flex gap-2 mt-1">
                <input value={roleCheckAddr} onChange={e => setRoleCheckAddr(e.target.value)} placeholder="0x..." className={inputCls} />
                <button onClick={handleCheckRoles} className={`shrink-0 px-4 ${btnCls}`}><Search className="w-4 h-4" /></button>
              </div>
              {roleCheckResult && (
                <p className="text-xs mt-2">
                  {roleCheckResult.isAdmin && <span className="text-yellow-400 font-medium mr-2">Admin</span>}
                  {roleCheckResult.isOperator && <span className="text-accent font-medium mr-2">Operator</span>}
                  {!roleCheckResult.isAdmin && !roleCheckResult.isOperator && <span className="text-txt-secondary">Neither admin nor operator</span>}
                </p>
              )}
            </div>
          </Card>

          {/* ── Upgrade ── */}
          <Card title="Upgrade Implementation (UUPS)" icon={<ArrowUpCircle className="w-5 h-5 text-accent" />}>
            {notAdmin}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">1. New Implementation</h4>
                <button onClick={deployNewImplementation} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy New Implementation</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">2. Upgrade Proxy</h4>
                <input value={newImplAddress} onChange={e => setNewImplAddress(e.target.value)} placeholder="New implementation address" className={`${inputCls} mb-2`} />
                {newImplVersion && <p className="text-xs text-txt-secondary mb-2">version(): <span className="text-accent">{newImplVersion}</span></p>}
                <button onClick={handleUpgrade} disabled={!isAdminConnected || !newImplAddress} className={`w-full ${btnCls}`}>Upgrade</button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
