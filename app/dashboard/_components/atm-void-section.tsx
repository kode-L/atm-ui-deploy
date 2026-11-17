'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { UtcTime } from '@/components/utc-datetime';
import {
  Flame, Plus, Settings, RefreshCw, ExternalLink, ShieldCheck, ChevronLeft, ChevronRight, Skull, Tag, History,
  UserCog, Coins, Layers, Pause, Play, Upload,
} from 'lucide-react';
import ATMVoidArtifact from '@/lib/contracts/ATMVoid.json';
import ATMVoidProxyArtifact from '@/lib/contracts/ATMVoidProxy.json';
import {
  BNB_TESTNET,
  BSC_MAINNET,
  DEFAULT_ATM_VOID_ADDRESS,
  DEFAULT_ATM_VOID_ADDRESS_MAINNET,
  getExplorerAddressUrl,
  networkStorageKey,
} from '@/lib/contracts/config';

type BN = ethers.BigNumber;

const STORAGE_KEY = 'dg_atmVoidAddress';
const PAGE_SIZE = 10;
const TOKENS_PAGE_SIZE = 50;

const ABI = ATMVoidArtifact.abi;
const voidIface = new ethers.utils.Interface(ABI);
const ADMIN_ROLE = ethers.constants.HashZero;
const OPERATOR_ROLE = ethers.utils.id('OPERATOR_ROLE');

// PancakeSwap V2 factories — prefilled for deploy / setDexFactory, editable.
const PANCAKE_V2_FACTORY: Record<number, string> = {
  [BSC_MAINNET.chainId]: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  [BNB_TESTNET.chainId]: '0x6725F303b657a9451d8BA641348b6761A6CC7a17',
};

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// Matches ATMVoid.TokenKind
const KIND_LABELS: Record<number, string> = { 0: 'None', 1: 'Token', 2: 'LP' };

const VOID_ERROR_MESSAGES: Record<string, string> = {
  ZeroAddress: 'Zero address not allowed',
  ZeroAmount: 'Amount must be greater than 0',
  NotAContract: 'Address has no contract code on this network',
  TokenAlreadyAdded: 'Token is already registered',
  TokenNotAdded: 'Token is not registered',
  TokenNotBurnable: 'Token is not registered or is disabled — add / enable it under Tokens first',
  InvalidLpToken: 'Not a V2 LP pair (token0()/token1() failed)',
  PairNotFound: 'The DEX factory has no pair for these two tokens',
  DexFactoryNotSet: 'DEX factory is not set',
  DefaultTokenNotSet: 'Default token is not set',
  DefaultTokenMustBePlainToken: 'Default token must be a registered plain token (not an LP)',
  EmptyBurnTypeName: 'Burn type name cannot be empty',
  BurnTypeExists: 'A burn type with this name already exists',
  InvalidBurnType: 'Invalid burn type id',
  BurnTypeInactive: 'Burn type is inactive',
  BurnTypeNotFound: 'Burn type not found',
  NothingBurned: 'Nothing reached the dead address (token took 100% fee?)',
  InvalidTimeRange: 'Invalid time range',
  EnforcedPause: 'Contract is paused',
  ExpectedPause: 'Contract is not paused',
  InvalidInitialization: 'Already initialized',
};

function decodeVoidError(e: any): string {
  const rawData = e?.error?.data?.data || e?.error?.data || e?.data?.data || e?.data;
  if (typeof rawData === 'string' && rawData.startsWith('0x') && rawData.length >= 10) {
    try {
      const parsed = voidIface.parseError(rawData);
      if (parsed.name === 'AccessControlUnauthorizedAccount') {
        const role = String(parsed.args[1]).toLowerCase();
        const roleName = role === OPERATOR_ROLE ? 'OPERATOR_ROLE' : role === ADMIN_ROLE ? 'DEFAULT_ADMIN_ROLE' : role;
        return `Access denied: ${String(parsed.args[0]).slice(0, 10)}... is missing ${roleName}`;
      }
      if (parsed.name === 'SafeERC20FailedOperation') return `ERC20 transfer failed for ${String(parsed.args[0]).slice(0, 10)}... — check balance and approval`;
      return VOID_ERROR_MESSAGES[parsed.name] || `Contract error: ${parsed.name}`;
    } catch { /* not an ATMVoid error */ }
  }
  return decodeError(e);
}

interface TokenRow {
  address: string;
  kind: number;
  enabled: boolean;
  token0: string;
  token1: string;
  totalBurned: BN;
}
interface TokenMeta { symbol: string; decimals: number; }
interface BurnTypeRow { id: number; name: string; active: boolean; }
interface BurnRecordRow { id: number; token: string; burner: string; amount: BN; timestamp: number; burnTypeId: number; }

const inputCls = 'w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2 rounded-lg text-sm transition-colors';
const smallBtn = 'shrink-0 px-3 py-1.5 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-lg text-xs';
const dangerBtn = 'shrink-0 px-3 py-1.5 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg text-xs';
const fmtAddr = (a: string) => (a ? `${a.slice(0, 8)}...${a.slice(-6)}` : '—');
const isZero = (a: string) => !a || a === ethers.constants.AddressZero;
const toNum = (v: any) => v?.toNumber?.() ?? Number(v);
const fmtUnits = (v: BN, decimals: number) => {
  const s = ethers.utils.formatUnits(v, decimals);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const splitAddresses = (v: string) => v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

export default function ATMVoidSection() {
  const { signer, provider, isConnected, address, tokenAddress, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<{ status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string }>({ status: 'idle' });
  const fail = (error: string) => setTxStatus({ status: 'error', error });

  const netNs = chainId === BSC_MAINNET.chainId ? BSC_MAINNET.chainId : BNB_TESTNET.chainId;
  const [voidAddress, setVoidAddress] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(networkStorageKey(STORAGE_KEY, netNs));
      setVoidAddress(saved || (netNs === BSC_MAINNET.chainId ? DEFAULT_ATM_VOID_ADDRESS_MAINNET : DEFAULT_ATM_VOID_ADDRESS));
    } catch { /* ignore */ }
  }, [netNs]);

  const saveVoidAddress = (addr: string) => {
    setVoidAddress(addr);
    try { localStorage.setItem(networkStorageKey(STORAGE_KEY, netNs), addr); } catch { /* ignore */ }
  };

  const getRead = useCallback(() => (provider && voidAddress ? new ethers.Contract(voidAddress, ABI, provider) : null), [provider, voidAddress]);
  const getWrite = useCallback(() => (signer && voidAddress ? new ethers.Contract(voidAddress, ABI, signer) : null), [signer, voidAddress]);

  // Generic "send tx → wait → refresh" helper for single contract calls.
  const send = async (label: string, fn: () => Promise<ethers.ContractTransaction>, after?: () => void) => {
    setTxStatus({ status: 'pending', message: `${label}...` });
    try {
      const tx = await fn();
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${label} — done` });
      after?.();
      return true;
    } catch (e: any) {
      fail(decodeVoidError(e));
      return false;
    }
  };

  // ── Token metadata cache (symbol / decimals; LPs shown as "A/B LP") ──
  const [meta, setMeta] = useState<Record<string, TokenMeta>>({});
  const loadMeta = useCallback(async (addrs: string[]) => {
    if (!provider) return;
    const missing = Array.from(new Set(addrs.map(a => a.toLowerCase()))).filter(a => !isZero(a) && !meta[a]);
    if (missing.length === 0) return;
    const entries = await Promise.all(missing.map(async a => {
      const t = new ethers.Contract(a, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([t.symbol().catch(() => '?'), t.decimals().catch(() => 18)]);
      return [a, { symbol, decimals: toNum(decimals) }] as const;
    }));
    setMeta(m => ({ ...m, ...Object.fromEntries(entries) }));
  }, [provider, meta]);
  const sym = (a: string) => meta[a?.toLowerCase()]?.symbol || fmtAddr(a);
  const dec = (a: string) => meta[a?.toLowerCase()]?.decimals ?? 18;

  // ── Deploy (implementation → proxy + initialize) / load ──
  const [showDeploy, setShowDeploy] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [loadAddr, setLoadAddr] = useState('');
  const [implAddress, setImplAddress] = useState('');
  const [initAdmin, setInitAdmin] = useState('');
  const [initDefaultToken, setInitDefaultToken] = useState('');
  const [initFactory, setInitFactory] = useState('');
  const [initBurnTypes, setInitBurnTypes] = useState('Rebase, Relay, Splitter, LP');

  useEffect(() => { if (address && !initAdmin) setInitAdmin(address); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tokenAddress && !initDefaultToken) setInitDefaultToken(tokenAddress); }, [tokenAddress]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setInitFactory(PANCAKE_V2_FACTORY[netNs] || ''); }, [netNs]);

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: '1/2 Deploying ATMVoid implementation...' });
    try {
      const factory = new ethers.ContractFactory(ABI, ATMVoidArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', hash: impl.deployTransaction?.hash, message: '1/2 Waiting for confirmation...' });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now deploy the proxy (step 2).` });
    } catch (e: any) {
      fail(decodeVoidError(e));
    }
  };

  const deployProxy = async () => {
    if (!signer || !implAddress) return;
    const admin = initAdmin.trim();
    const defToken = initDefaultToken.trim() || ethers.constants.AddressZero;
    const dexFactory = initFactory.trim() || ethers.constants.AddressZero;
    if (!ethers.utils.isAddress(admin)) return fail('Invalid admin address');
    if (!ethers.utils.isAddress(defToken)) return fail('Invalid default token address (leave blank for none)');
    if (!ethers.utils.isAddress(dexFactory)) return fail('Invalid DEX factory address (leave blank for none)');
    const names = initBurnTypes.split(',').map(s => s.trim()).filter(Boolean);
    if (new Set(names).size !== names.length) return fail('Duplicate burn type names');
    setTxStatus({ status: 'pending', message: '2/2 Deploying proxy + initializing...' });
    try {
      const initData = voidIface.encodeFunctionData('initialize', [admin, defToken, dexFactory, names]);
      const factory = new ethers.ContractFactory(ATMVoidProxyArtifact.abi, ATMVoidProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress, initData);
      setTxStatus({ status: 'pending', hash: proxy.deployTransaction?.hash, message: '2/2 Waiting for confirmation...' });
      await proxy.deployed();
      saveVoidAddress(proxy.address);
      setShowDeploy(false);
      setImplAddress('');
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `ATMVoid deployed at ${proxy.address}. Admin has DEFAULT_ADMIN_ROLE + OPERATOR_ROLE. Next: add tokens / LPs under Tokens.` });
    } catch (e: any) {
      fail(decodeVoidError(e));
    }
  };

  const handleLoad = () => {
    if (!ethers.utils.isAddress(loadAddr.trim())) return fail('Invalid ATMVoid address');
    saveVoidAddress(loadAddr.trim());
    setShowLoad(false);
    setLoadAddr('');
    setTxStatus({ status: 'idle' });
  };

  // ── Overview ──
  const [overview, setOverview] = useState<{ defaultToken: string; dexFactory: string; burnCount: number; tokenCount: number; paused: boolean } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isOperator, setIsOperator] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [burnTypes, setBurnTypes] = useState<BurnTypeRow[]>([]);

  const fetchOverview = useCallback(async () => {
    const c = getRead();
    if (!c) return;
    setOverviewLoading(true);
    setOverviewError('');
    try {
      const [defaultToken, dexFactory, burnCount, tokenCount, paused] = await Promise.all([
        c.defaultToken(), c.dexFactory(), c.burnCount(), c.getTokenCount(), c.paused(),
      ]);
      setOverview({ defaultToken, dexFactory, burnCount: toNum(burnCount), tokenCount: toNum(tokenCount), paused });

      // Tokens (all pages) + per-token total burned
      const total = toNum(tokenCount);
      const rows: TokenRow[] = [];
      for (let off = 0; off < total; off += TOKENS_PAGE_SIZE) {
        const [addrs, cfgs] = await c.getTokens(off, TOKENS_PAGE_SIZE);
        addrs.forEach((a: string, i: number) => rows.push({
          address: a, kind: toNum(cfgs[i].kind), enabled: cfgs[i].enabled, token0: cfgs[i].token0, token1: cfgs[i].token1,
          totalBurned: ethers.constants.Zero,
        }));
      }
      const burned = await Promise.all(rows.map(r => c.totalBurnedPerToken(r.address)));
      burned.forEach((b: BN, i: number) => { rows[i].totalBurned = b; });
      setTokens(rows);
      loadMeta(rows.flatMap(r => [r.address, r.token0, r.token1]).concat(isZero(defaultToken) ? [] : [defaultToken]));

      const [ids, names, active]: [any[], string[], boolean[]] = await c.getAllBurnTypes();
      setBurnTypes(ids.map((id, i) => ({ id: toNum(id), name: names[i], active: active[i] })));

      if (address) {
        const [a, o] = await Promise.all([c.hasRole(ADMIN_ROLE, address).catch(() => false), c.hasRole(OPERATOR_ROLE, address).catch(() => false)]);
        setIsAdmin(!!a);
        setIsOperator(!!o);
      } else {
        setIsAdmin(false);
        setIsOperator(false);
      }
    } catch (e) {
      console.error('fetch ATMVoid overview:', e);
      setOverviewError(`Failed to read from ${voidAddress} — ${decodeVoidError(e)}. Check this is the ATMVoid proxy on the network your wallet is connected to.`);
    } finally {
      setOverviewLoading(false);
    }
  }, [getRead, address, voidAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (voidAddress) fetchOverview(); }, [voidAddress, fetchOverview]);

  const tokenLabel = (a: string) => {
    const row = tokens.find(t => t.address.toLowerCase() === a.toLowerCase());
    if (row?.kind === 2) return `${sym(row.token0)}/${sym(row.token1)} LP`;
    return sym(a);
  };

  // ── Token config (operator) ──
  const [newTokens, setNewTokens] = useState('');
  const [newLp, setNewLp] = useState('');
  const [pairA, setPairA] = useState('');
  const [pairB, setPairB] = useState('');
  const [newDefaultToken, setNewDefaultToken] = useState('');
  const [newFactory, setNewFactory] = useState('');

  const handleAddTokens = () => {
    const c = getWrite();
    const list = splitAddresses(newTokens);
    if (!c || list.length === 0) return;
    const bad = list.find(a => !ethers.utils.isAddress(a));
    if (bad) return fail(`Invalid address: ${bad}`);
    send(list.length === 1 ? 'Adding token' : `Adding ${list.length} tokens`,
      () => (list.length === 1 ? c.addToken(list[0]) : c.addTokens(list)),
      () => { setNewTokens(''); fetchOverview(); });
  };

  const handleAddLp = () => {
    const c = getWrite();
    if (!c) return;
    if (!ethers.utils.isAddress(newLp.trim())) return fail('Invalid LP address');
    send('Adding LP token', () => c.addLpToken(newLp.trim()), () => { setNewLp(''); fetchOverview(); });
  };

  const handleAddLpByPair = () => {
    const c = getWrite();
    if (!c) return;
    if (!ethers.utils.isAddress(pairA.trim()) || !ethers.utils.isAddress(pairB.trim())) return fail('Enter two valid token addresses');
    send('Adding LP by pair', () => c.addLpTokenByPair(pairA.trim(), pairB.trim()), () => { setPairA(''); setPairB(''); fetchOverview(); });
  };

  const handleToggleToken = (t: TokenRow) => {
    const c = getWrite();
    if (!c) return;
    send(`${t.enabled ? 'Disabling' : 'Enabling'} ${tokenLabel(t.address)}`, () => c.setTokenEnabled(t.address, !t.enabled), fetchOverview);
  };

  const handleSetDefaultToken = () => {
    const c = getWrite();
    const v = newDefaultToken.trim() || ethers.constants.AddressZero;
    if (!c) return;
    if (!ethers.utils.isAddress(v)) return fail('Invalid address (blank = unset)');
    send('Setting default token', () => c.setDefaultToken(v), () => { setNewDefaultToken(''); fetchOverview(); });
  };

  const handleSetFactory = () => {
    const c = getWrite();
    const v = newFactory.trim() || ethers.constants.AddressZero;
    if (!c) return;
    if (!ethers.utils.isAddress(v)) return fail('Invalid address (blank = unset)');
    send('Setting DEX factory', () => c.setDexFactory(v), () => { setNewFactory(''); fetchOverview(); });
  };

  // ── Burn types (operator) ──
  const [newTypeName, setNewTypeName] = useState('');
  const handleAddBurnType = () => {
    const c = getWrite();
    if (!c || !newTypeName.trim()) return;
    send(`Adding burn type "${newTypeName.trim()}"`, () => c.addBurnType(newTypeName.trim()), () => { setNewTypeName(''); fetchOverview(); });
  };
  const handleToggleBurnType = (t: BurnTypeRow) => {
    const c = getWrite();
    if (!c) return;
    send(`${t.active ? 'Deactivating' : 'Activating'} burn type #${t.id}`, () => c.setBurnTypeActive(t.id, !t.active), fetchOverview);
  };

  // ── Burn ──
  const [burnToken, setBurnToken] = useState('');
  const [burnTypeId, setBurnTypeId] = useState('');
  const [burnAmount, setBurnAmount] = useState('');
  const [myBalance, setMyBalance] = useState<BN>(ethers.constants.Zero);
  const [myAllowance, setMyAllowance] = useState<BN>(ethers.constants.Zero);

  const enabledTokens = tokens.filter(t => t.enabled);
  const activeTypes = burnTypes.filter(t => t.active);

  useEffect(() => {
    if (!enabledTokens.find(t => t.address === burnToken)) setBurnToken(enabledTokens[0]?.address || '');
  }, [tokens]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeTypes.find(t => String(t.id) === burnTypeId)) setBurnTypeId(activeTypes[0] ? String(activeTypes[0].id) : '');
  }, [burnTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMyTokenState = useCallback(async () => {
    if (!provider || !address || !burnToken || !voidAddress) return;
    try {
      const t = new ethers.Contract(burnToken, ERC20_ABI, provider);
      const [bal, allow] = await Promise.all([t.balanceOf(address), t.allowance(address, voidAddress)]);
      setMyBalance(bal);
      setMyAllowance(allow);
    } catch { /* non-standard token */ }
  }, [provider, address, burnToken, voidAddress]);

  useEffect(() => { fetchMyTokenState(); }, [fetchMyTokenState]);

  const burnDecimals = dec(burnToken);
  let parsedBurn: BN | null = null;
  try { parsedBurn = burnAmount ? ethers.utils.parseUnits(burnAmount.trim(), burnDecimals) : null; } catch { parsedBurn = null; }
  const needsApproval = !!parsedBurn && myAllowance.lt(parsedBurn);

  const handleApprove = () => {
    if (!signer || !burnToken || !parsedBurn) return;
    const t = new ethers.Contract(burnToken, ERC20_ABI, signer);
    send(`Approving ${burnAmount} ${tokenLabel(burnToken)}`, () => t.approve(voidAddress, parsedBurn!), fetchMyTokenState);
  };

  const handleBurn = () => {
    const c = getWrite();
    if (!c || !burnToken || !burnTypeId || !parsedBurn || parsedBurn.isZero()) return;
    send(`Burning ${burnAmount} ${tokenLabel(burnToken)}`, () => c.burn(burnToken, parsedBurn!, parseInt(burnTypeId)), () => {
      setBurnAmount('');
      fetchMyTokenState();
      fetchOverview();
      fetchHistory();
    });
  };

  // ── History (latest first) ──
  const [historyScope, setHistoryScope] = useState<'all' | 'mine' | 'token' | 'type'>('all');
  const [historyToken, setHistoryToken] = useState('');
  const [historyType, setHistoryType] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [historyRows, setHistoryRows] = useState<BurnRecordRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    const c = getRead();
    if (!c) return;
    const page = (off: number, lim: number) => {
      if (historyScope === 'mine' && address) return c.getUserBurnRecords(address, off, lim);
      if (historyScope === 'token' && historyToken) return c.getBurnRecordsByToken(historyToken, off, lim);
      if (historyScope === 'type' && historyType) return c.getBurnRecordsByType(parseInt(historyType), off, lim);
      return c.getBurnRecords(off, lim);
    };
    setHistoryLoading(true);
    try {
      const [, totalBn] = await page(0, 0);
      const total = toNum(totalBn);
      const end = Math.max(0, total - historyPage * PAGE_SIZE);
      const start = Math.max(0, end - PAGE_SIZE);
      const [records] = end > start ? await page(start, end - start) : [[]];
      const rows: BurnRecordRow[] = records.map((r: any) => ({
        id: toNum(r.id), token: r.token, burner: r.burner, amount: r.amount, timestamp: toNum(r.timestamp), burnTypeId: toNum(r.burnTypeId),
      })).reverse();
      setHistoryRows(rows);
      setHistoryTotal(total);
      loadMeta(rows.map(r => r.token));
    } catch (e) {
      console.error('fetch ATMVoid history:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [getRead, historyScope, historyToken, historyType, historyPage, address]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (voidAddress) fetchHistory(); }, [voidAddress, fetchHistory]);
  useEffect(() => { setHistoryPage(0); }, [historyScope, historyToken, historyType]);

  // ── Roles / pause / rescue / upgrade ──
  const [roleAddr, setRoleAddr] = useState('');
  const [roleKind, setRoleKind] = useState<'operator' | 'admin'>('operator');
  const [roleCheck, setRoleCheck] = useState('');
  const [rescueToken, setRescueToken] = useState('');
  const [rescueAmount, setRescueAmount] = useState('');
  const [rescueTo, setRescueTo] = useState('');
  const [newImpl, setNewImpl] = useState('');

  const handleRole = (grant: boolean) => {
    const c = getWrite();
    if (!c) return;
    if (!ethers.utils.isAddress(roleAddr.trim())) return fail('Invalid address');
    const role = roleKind === 'operator' ? OPERATOR_ROLE : ADMIN_ROLE;
    const name = roleKind === 'operator' ? 'OPERATOR_ROLE' : 'DEFAULT_ADMIN_ROLE';
    send(`${grant ? 'Granting' : 'Revoking'} ${name} ${grant ? 'to' : 'from'} ${fmtAddr(roleAddr.trim())}`,
      () => (grant ? c.grantRole(role, roleAddr.trim()) : c.revokeRole(role, roleAddr.trim())),
      fetchOverview);
  };

  const handleCheckRole = async () => {
    const c = getRead();
    if (!c || !ethers.utils.isAddress(roleAddr.trim())) return fail('Invalid address');
    try {
      const [a, o] = await Promise.all([c.hasRole(ADMIN_ROLE, roleAddr.trim()), c.hasRole(OPERATOR_ROLE, roleAddr.trim())]);
      setRoleCheck(`${fmtAddr(roleAddr.trim())}: admin = ${a ? 'yes' : 'no'}, operator = ${o ? 'yes' : 'no'}`);
    } catch (e) { fail(decodeVoidError(e)); }
  };

  const handlePause = () => {
    const c = getWrite();
    if (!c || !overview) return;
    send(overview.paused ? 'Unpausing' : 'Pausing', () => (overview.paused ? c.unpause() : c.pause()), fetchOverview);
  };

  const handleRescue = async () => {
    const c = getWrite();
    if (!c || !provider) return;
    if (!ethers.utils.isAddress(rescueToken.trim()) || !ethers.utils.isAddress(rescueTo.trim())) return fail('Invalid token or recipient');
    let decimals = 18;
    try { decimals = toNum(await new ethers.Contract(rescueToken.trim(), ERC20_ABI, provider).decimals()); } catch { /* default 18 */ }
    let amt: BN;
    try { amt = ethers.utils.parseUnits(rescueAmount.trim(), decimals); } catch { return fail('Invalid amount'); }
    send('Rescuing tokens', () => c.rescueTokens(rescueToken.trim(), amt, rescueTo.trim()), () => { setRescueAmount(''); });
  };

  const handleDeployNewImpl = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new ATMVoid implementation...' });
    try {
      const impl = await new ethers.ContractFactory(ABI, ATMVoidArtifact.bytecode, signer).deploy();
      setTxStatus({ status: 'pending', hash: impl.deployTransaction?.hash, message: 'Waiting for confirmation...' });
      await impl.deployed();
      setNewImpl(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `New implementation at ${impl.address} — click Upgrade to point the proxy at it.` });
    } catch (e: any) { fail(decodeVoidError(e)); }
  };

  const handleUpgrade = () => {
    const c = getWrite();
    if (!c) return;
    if (!ethers.utils.isAddress(newImpl.trim())) return fail('Invalid implementation address');
    send('Upgrading proxy', () => c.upgradeToAndCall(newImpl.trim(), '0x'), () => { setNewImpl(''); fetchOverview(); });
  };

  const typeName = (id: number) => burnTypes.find(t => t.id === id)?.name || `#${id}`;
  const notOperator = voidAddress && address && !isOperator && (
    <p className="text-[11px] text-yellow-400 mb-3">&#9888; Connected wallet doesn&apos;t have OPERATOR_ROLE — these actions will revert.</p>
  );

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* Setup */}
      <Card title="ATM Void" icon={<Skull className="w-5 h-5 text-red-400" />}>
        <p className="text-xs text-txt-secondary mb-3">
          Configurable burn contract for any registered ERC-20 token or V2 LP token. Burns go straight from the caller to the dead
          address (<code className="text-accent">0x…dEaD</code>) and are recorded on-chain by user, token and burn type. Operators
          register tokens; anyone can burn a registered, enabled token. Also accepts the legacy LucaVoid calls
          (<code className="text-accent">burnTokens(amount, type)</code> / <code className="text-accent">burnTokens(stablecoin, amount, type)</code>) for the default token.
        </p>

        {voidAddress ? (
          <div className="flex items-center gap-3 flex-wrap bg-surface-tertiary rounded-lg px-3 py-2.5 mb-3">
            <Flame className="w-4 h-4 text-red-400 shrink-0" />
            <code className="text-xs font-mono text-txt-primary break-all">{voidAddress}</code>
            <a href={getExplorerAddressUrl(chainId, voidAddress)} target="_blank" rel="noopener noreferrer" className="text-txt-secondary hover:text-red-400 shrink-0">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button onClick={() => { saveVoidAddress(''); setOverview(null); setTokens([]); setBurnTypes([]); }} className="ml-auto text-xs text-txt-secondary hover:text-txt-primary shrink-0">
              Change
            </button>
          </div>
        ) : (
          <p className="text-sm text-txt-secondary mb-3">No ATMVoid loaded yet. Deploy a new one or load an existing proxy address.</p>
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
            <button onClick={() => { fetchOverview(); fetchHistory(); }} disabled={overviewLoading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-txt-secondary hover:text-txt-primary text-sm">
              <RefreshCw className={`w-4 h-4 ${overviewLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          )}
        </div>

        {showDeploy && (
          <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-red-700/30 space-y-3">
            <h4 className="text-sm font-semibold text-red-300">Deploy New ATMVoid (UUPS proxy)</h4>
            <p className="text-xs text-txt-secondary">
              2 transactions: deploy the implementation, then deploy the proxy which calls <code className="text-accent">initialize</code> atomically.
              The admin gets DEFAULT_ADMIN_ROLE and OPERATOR_ROLE. Default token and DEX factory are optional (blank = none) and can be changed later.
            </p>
            <div>
              <label className="text-xs text-txt-secondary">Step 1 — Implementation</label>
              <div className="flex gap-2 items-center mt-1">
                <button onClick={deployImplementation} disabled={!isConnected} className={`px-4 ${btnCls}`}>Deploy Implementation</button>
                {implAddress && <code className="text-xs text-green-400 break-all">{implAddress}</code>}
              </div>
              <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="…or paste an existing implementation address" className={inputCls} />
            </div>
            <div className="border-t border-white/10 pt-3 space-y-3">
              <label className="text-xs text-txt-secondary">Step 2 — Proxy + initialize</label>
              <div>
                <label className="text-xs text-txt-secondary">Admin</label>
                <input value={initAdmin} onChange={e => setInitAdmin(e.target.value)} placeholder="0x..." className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Default token (used by legacy burnTokens calls; e.g. LUCA)</label>
                <input value={initDefaultToken} onChange={e => setInitDefaultToken(e.target.value)} placeholder="0x... (blank = none)" className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">DEX factory (PancakeSwap V2 prefilled)</label>
                <input value={initFactory} onChange={e => setInitFactory(e.target.value)} placeholder="0x... (blank = none)" className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Initial burn types (comma-separated, ids 1..n in order)</label>
                <input value={initBurnTypes} onChange={e => setInitBurnTypes(e.target.value)} className={inputCls} />
              </div>
              <button onClick={deployProxy} disabled={!isConnected || !ethers.utils.isAddress(implAddress.trim())} className={`w-full ${btnCls}`}>Deploy Proxy + Initialize</button>
            </div>
          </div>
        )}

        {showLoad && (
          <div className="mt-4 p-4 bg-surface-tertiary/50 rounded-lg border border-white/10 space-y-3">
            <h4 className="text-sm font-semibold text-txt-primary">Load Existing ATMVoid</h4>
            <input value={loadAddr} onChange={e => setLoadAddr(e.target.value)} placeholder="0x... proxy address" className={inputCls} />
            <button onClick={handleLoad} className="px-4 py-2 rounded-lg bg-accent text-black text-sm font-semibold hover:bg-yellow-400 transition-colors">Load</button>
          </div>
        )}
      </Card>

      {voidAddress && overviewError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-400">{overviewError}</div>
      )}

      {voidAddress && overview && (
        <>
          {/* Overview */}
          <Card title="Overview" icon={<ShieldCheck className="w-5 h-5 text-red-400" />}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-txt-secondary">Default Token</p>
                <p className="text-xs font-mono text-txt-primary break-all">{isZero(overview.defaultToken) ? '— none' : `${sym(overview.defaultToken)} (${fmtAddr(overview.defaultToken)})`}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">DEX Factory</p>
                <p className="text-xs font-mono text-txt-primary break-all">{isZero(overview.dexFactory) ? '— none' : fmtAddr(overview.dexFactory)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Tokens / Burn Records</p>
                <p className="text-lg font-bold text-txt-primary">{overview.tokenCount} / {overview.burnCount}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Status</p>
                <p className={`text-sm font-bold ${overview.paused ? 'text-yellow-400' : 'text-green-400'}`}>{overview.paused ? 'Paused' : 'Active'}</p>
              </div>
            </div>
            {address && (
              <p className="text-[11px] mt-3 text-txt-secondary">
                Your wallet: admin = <span className={isAdmin ? 'text-green-400' : 'text-red-400'}>{isAdmin ? 'yes' : 'no'}</span>,
                {' '}operator = <span className={isOperator ? 'text-green-400' : 'text-red-400'}>{isOperator ? 'yes' : 'no'}</span>
              </p>
            )}
          </Card>

          {/* Tokens */}
          <Card title="Tokens" icon={<Coins className="w-5 h-5 text-red-400" />}>
            {tokens.length === 0 ? (
              <p className="text-sm text-txt-secondary mb-3">No tokens registered yet.</p>
            ) : (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-txt-secondary border-b border-white/10">
                      <th className="text-left py-1.5 px-2">Token</th>
                      <th className="text-left py-1.5 px-2">Kind</th>
                      <th className="text-left py-1.5 px-2">Address</th>
                      <th className="text-right py-1.5 px-2">Burned (via ATMVoid)</th>
                      <th className="text-left py-1.5 px-2">Status</th>
                      <th className="py-1.5 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map(t => (
                      <tr key={t.address} className="border-b border-white/5 hover:bg-surface-tertiary/50">
                        <td className="py-1.5 px-2 text-txt-primary">
                          {tokenLabel(t.address)}
                          {overview.defaultToken.toLowerCase() === t.address.toLowerCase() && <span className="ml-1.5 text-[10px] text-accent">default</span>}
                        </td>
                        <td className="py-1.5 px-2">{KIND_LABELS[t.kind]}</td>
                        <td className="py-1.5 px-2 font-mono">
                          <a href={getExplorerAddressUrl(chainId, t.address)} target="_blank" rel="noopener noreferrer" className="hover:text-red-400">{fmtAddr(t.address)}</a>
                        </td>
                        <td className="py-1.5 px-2 text-right text-red-400 font-bold">{fmtUnits(t.totalBurned, dec(t.address))}</td>
                        <td className={`py-1.5 px-2 ${t.enabled ? 'text-green-400' : 'text-txt-secondary'}`}>{t.enabled ? 'Enabled' : 'Disabled'}</td>
                        <td className="py-1.5 px-2 text-right">
                          <button onClick={() => handleToggleToken(t)} disabled={!isConnected} className={t.enabled ? dangerBtn : smallBtn}>
                            {t.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {notOperator}
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-txt-primary">Add plain token(s)</h4>
                <p className="text-xs text-txt-secondary">One or more ERC-20 addresses, separated by commas, spaces or new lines.</p>
                <textarea value={newTokens} onChange={e => setNewTokens(e.target.value)} rows={2} placeholder="0x..., 0x..." className={inputCls} />
                <button onClick={handleAddTokens} disabled={!isConnected || !newTokens.trim()} className={`mt-2 px-4 ${btnCls}`}>Add Token(s)</button>
              </div>
              <div className="border-t border-white/10 pt-4">
                <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-1.5"><Layers className="w-4 h-4" /> Add LP token</h4>
                <p className="text-xs text-txt-secondary">By pair address (any V2-style DEX), or by its two tokens via the configured DEX factory.</p>
                <div className="flex gap-2 mt-1">
                  <input value={newLp} onChange={e => setNewLp(e.target.value)} placeholder="0x... LP / pair address" className={inputCls} />
                  <button onClick={handleAddLp} disabled={!isConnected || !newLp.trim()} className={`mt-1 px-4 ${btnCls}`}>Add LP</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 mt-2">
                  <input value={pairA} onChange={e => setPairA(e.target.value)} placeholder="Token A (e.g. LUCA)" className={inputCls} />
                  <input value={pairB} onChange={e => setPairB(e.target.value)} placeholder="Token B (e.g. USDT)" className={inputCls} />
                  <button onClick={handleAddLpByPair} disabled={!isConnected || !pairA.trim() || !pairB.trim() || isZero(overview.dexFactory)} className={`mt-1 px-4 ${btnCls}`}>Add by Pair</button>
                </div>
                {isZero(overview.dexFactory) && <p className="text-[11px] text-yellow-400 mt-1">Set a DEX factory below to add LPs by pair.</p>}
              </div>
              <div className="border-t border-white/10 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-txt-primary">Default token</h4>
                  <p className="text-xs text-txt-secondary">Must be a registered plain token. Blank = unset.</p>
                  <select value={newDefaultToken} onChange={e => setNewDefaultToken(e.target.value)} className={inputCls}>
                    <option value="">— none (unset) —</option>
                    {tokens.filter(t => t.kind === 1).map(t => <option key={t.address} value={t.address}>{tokenLabel(t.address)} ({fmtAddr(t.address)})</option>)}
                  </select>
                  <button onClick={handleSetDefaultToken} disabled={!isConnected} className={`mt-2 px-4 ${btnCls}`}>Set Default Token</button>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-txt-primary">DEX factory</h4>
                  <p className="text-xs text-txt-secondary">V2 factory for LP lookups. Blank = unset.</p>
                  <input value={newFactory} onChange={e => setNewFactory(e.target.value)} placeholder={PANCAKE_V2_FACTORY[netNs] || '0x...'} className={inputCls} />
                  <button onClick={handleSetFactory} disabled={!isConnected} className={`mt-2 px-4 ${btnCls}`}>Set DEX Factory</button>
                </div>
              </div>
            </div>
          </Card>

          {/* Burn types */}
          <Card title="Burn Types" icon={<Tag className="w-5 h-5 text-red-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Tags for burn records. Inactive types can&apos;t be used for new burns; history stays.</p>
            {burnTypes.length === 0 ? (
              <p className="text-sm text-txt-secondary mb-3">No burn types yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-3">
                {burnTypes.map(t => (
                  <span key={t.id} className={`text-xs bg-surface-tertiary border rounded-full pl-3 pr-1 py-1 inline-flex items-center gap-2 ${t.active ? 'border-white/10' : 'border-white/5 opacity-60'}`}>
                    <span><span className="text-txt-secondary">#{t.id}</span> {t.name}{!t.active && ' (inactive)'}</span>
                    <button onClick={() => handleToggleBurnType(t)} disabled={!isConnected} className="text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary hover:text-accent">
                      {t.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {notOperator}
            <div className="flex gap-2">
              <input value={newTypeName} onChange={e => setNewTypeName(e.target.value)} placeholder="New burn type name" className="flex-1 bg-surface-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-txt-primary" />
              <button onClick={handleAddBurnType} disabled={!isConnected || !newTypeName.trim()} className={`px-4 ${btnCls}`}>Add</button>
            </div>
          </Card>

          {/* Burn */}
          <Card title="Burn Tokens" icon={<Flame className="w-5 h-5 text-red-400" />}>
            <p className="text-xs text-txt-secondary mb-3">Sends your own tokens straight to the dead address — irreversible. Approve ATMVoid first.</p>
            {overview.paused && <p className="text-[11px] text-yellow-400 mb-3">Contract is paused — burns will revert.</p>}
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-txt-secondary">Token</label>
                  <select value={burnToken} onChange={e => setBurnToken(e.target.value)} className={inputCls}>
                    {enabledTokens.length === 0 && <option value="">No enabled tokens — add one above</option>}
                    {enabledTokens.map(t => <option key={t.address} value={t.address}>{tokenLabel(t.address)} ({fmtAddr(t.address)})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-txt-secondary">Burn Type</label>
                  <select value={burnTypeId} onChange={e => setBurnTypeId(e.target.value)} className={inputCls}>
                    {activeTypes.length === 0 && <option value="">No active burn types</option>}
                    {activeTypes.map(t => <option key={t.id} value={t.id}>#{t.id} — {t.name}</option>)}
                  </select>
                </div>
              </div>
              {burnToken && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-txt-secondary">Your Balance</p>
                    <p className="text-sm font-bold text-accent">{fmtUnits(myBalance, burnDecimals)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-txt-secondary">ATMVoid Allowance</p>
                    <p className="text-sm font-bold text-green-400">{myAllowance.gte(ethers.constants.MaxUint256.div(2)) ? 'Unlimited' : fmtUnits(myAllowance, burnDecimals)}</p>
                  </div>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-txt-secondary">Amount</label>
                  <button type="button" onClick={() => setBurnAmount(ethers.utils.formatUnits(myBalance, burnDecimals))} className="text-xs text-accent hover:underline">Max</button>
                </div>
                <input value={burnAmount} onChange={e => setBurnAmount(e.target.value)} placeholder="100" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={handleApprove} disabled={!isConnected || !parsedBurn || !needsApproval}
                  className="py-2.5 rounded-lg bg-surface-tertiary hover:bg-surface-tertiary/80 disabled:opacity-40 border border-white/10 text-txt-primary text-sm font-semibold transition-colors">
                  Approve
                </button>
                <button onClick={handleBurn} disabled={!isConnected || !parsedBurn || parsedBurn.isZero() || !burnTypeId || !burnToken || needsApproval || overview.paused}
                  className="py-2.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                  <Flame className="w-4 h-4" /> Burn
                </button>
              </div>
              {needsApproval && <p className="text-[11px] text-yellow-400">Approve at least {burnAmount} before burning.</p>}
            </div>
          </Card>

          {/* History */}
          <Card title={<span className="flex items-center gap-2">Burn History <span className="text-xs text-txt-secondary font-normal">({historyTotal})</span></span>} icon={<History className="w-5 h-5 text-red-400" />}>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {(['all', 'mine', 'token', 'type'] as const).map(s => (
                <button key={s} onClick={() => setHistoryScope(s)} disabled={s === 'mine' && !address}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors disabled:opacity-40 ${historyScope === s ? 'bg-accent text-black' : 'bg-surface-tertiary text-txt-secondary hover:text-txt-primary'}`}>
                  {s === 'token' ? 'By token' : s === 'type' ? 'By type' : s}
                </button>
              ))}
              {historyScope === 'token' && (
                <select value={historyToken} onChange={e => setHistoryToken(e.target.value)} className="bg-surface-tertiary rounded-lg px-2 py-1.5 text-xs">
                  <option value="">Select token</option>
                  {tokens.map(t => <option key={t.address} value={t.address}>{tokenLabel(t.address)}</option>)}
                </select>
              )}
              {historyScope === 'type' && (
                <select value={historyType} onChange={e => setHistoryType(e.target.value)} className="bg-surface-tertiary rounded-lg px-2 py-1.5 text-xs">
                  <option value="">Select type</option>
                  {burnTypes.map(t => <option key={t.id} value={t.id}>#{t.id} — {t.name}</option>)}
                </select>
              )}
              <button onClick={fetchHistory} disabled={historyLoading} className="ml-auto p-1.5 rounded hover:bg-surface-tertiary">
                <RefreshCw className={`w-3.5 h-3.5 text-txt-secondary ${historyLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {historyRows.length === 0 ? (
              <p className="text-sm text-txt-secondary py-4 text-center">{historyLoading ? 'Loading...' : 'No burn records.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-txt-secondary border-b border-white/10">
                      <th className="text-left py-1.5 px-2">#</th>
                      <th className="text-left py-1.5 px-2">Token</th>
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
                        <td className="py-1.5 px-2 text-txt-primary">{tokenLabel(r.token)}</td>
                        <td className="py-1.5 px-2 text-txt-primary">{typeName(r.burnTypeId)}</td>
                        <td className="py-1.5 px-2 font-mono">{r.burner.slice(0, 8)}...{r.burner.slice(-4)}</td>
                        <td className="py-1.5 px-2 text-right text-red-400 font-bold">{fmtUnits(r.amount, dec(r.token))}</td>
                        <td className="py-1.5 px-2 text-txt-secondary"><UtcTime ts={r.timestamp} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0}
                className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-30">
                <ChevronLeft className="w-3.5 h-3.5" /> Newer
              </button>
              <span className="text-xs text-txt-secondary">Page {historyPage + 1} of {Math.max(1, Math.ceil(historyTotal / PAGE_SIZE))}</span>
              <button onClick={() => setHistoryPage(p => ((p + 1) * PAGE_SIZE < historyTotal ? p + 1 : p))} disabled={(historyPage + 1) * PAGE_SIZE >= historyTotal}
                className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-30">
                Older <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </Card>

          {/* Roles & admin */}
          <Card title="Roles & Admin" icon={<UserCog className="w-5 h-5 text-red-400" />}>
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-txt-primary">Operators &amp; admins</h4>
                <p className="text-xs text-txt-secondary mb-2">
                  Operators add tokens / LPs, manage burn types, set the default token and DEX factory, and pause. Admins grant roles, rescue tokens and upgrade. Granting / revoking needs DEFAULT_ADMIN_ROLE.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                  <input value={roleAddr} onChange={e => { setRoleAddr(e.target.value); setRoleCheck(''); }} placeholder="0x... wallet" className={inputCls} />
                  <select value={roleKind} onChange={e => setRoleKind(e.target.value as 'operator' | 'admin')} className={inputCls}>
                    <option value="operator">OPERATOR_ROLE</option>
                    <option value="admin">DEFAULT_ADMIN_ROLE</option>
                  </select>
                </div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  <button onClick={() => handleRole(true)} disabled={!isConnected || !roleAddr.trim()} className={smallBtn}>Grant</button>
                  <button onClick={() => handleRole(false)} disabled={!isConnected || !roleAddr.trim()} className={dangerBtn}>Revoke</button>
                  <button onClick={handleCheckRole} disabled={!roleAddr.trim()} className="shrink-0 px-3 py-1.5 bg-surface-tertiary border border-white/10 rounded-lg text-xs">Check</button>
                </div>
                {roleCheck && <p className="text-[11px] text-txt-secondary mt-1.5">{roleCheck}</p>}
                {!isAdmin && address && <p className="text-[11px] text-yellow-400 mt-1.5">Connected wallet isn&apos;t admin — grant / revoke will revert.</p>}
              </div>

              <div className="border-t border-white/10 pt-4">
                <h4 className="text-sm font-semibold text-txt-primary">Pause</h4>
                <p className="text-xs text-txt-secondary mb-2">Stops all burns (operator). Config and views keep working.</p>
                <button onClick={handlePause} disabled={!isConnected}
                  className={`flex items-center gap-1.5 ${overview.paused ? smallBtn : dangerBtn}`}>
                  {overview.paused ? <><Play className="w-3.5 h-3.5" /> Unpause</> : <><Pause className="w-3.5 h-3.5" /> Pause</>}
                </button>
              </div>

              <div className="border-t border-white/10 pt-4">
                <h4 className="text-sm font-semibold text-txt-primary">Rescue tokens</h4>
                <p className="text-xs text-txt-secondary mb-2">Recover tokens sent directly to the contract by mistake (burns never pass through it). Admin only.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input value={rescueToken} onChange={e => setRescueToken(e.target.value)} placeholder="Token address" className={inputCls} />
                  <input value={rescueAmount} onChange={e => setRescueAmount(e.target.value)} placeholder="Amount" className={inputCls} />
                  <input value={rescueTo} onChange={e => setRescueTo(e.target.value)} placeholder="Recipient" className={inputCls} />
                </div>
                <button onClick={handleRescue} disabled={!isConnected || !rescueToken || !rescueAmount || !rescueTo} className={`mt-2 ${dangerBtn}`}>Rescue</button>
              </div>

              <div className="border-t border-white/10 pt-4">
                <h4 className="text-sm font-semibold text-txt-primary flex items-center gap-1.5"><Upload className="w-4 h-4" /> Upgrade</h4>
                <p className="text-xs text-txt-secondary mb-2">Deploys the ATMVoid bytecode bundled with this UI as a new implementation, then points the proxy at it (admin only). State is kept.</p>
                <div className="flex gap-2 flex-wrap items-center">
                  <button onClick={handleDeployNewImpl} disabled={!isConnected} className={smallBtn}>Deploy New Implementation</button>
                </div>
                <div className="flex gap-2 mt-2">
                  <input value={newImpl} onChange={e => setNewImpl(e.target.value)} placeholder="0x... new implementation" className={inputCls} />
                  <button onClick={handleUpgrade} disabled={!isConnected || !newImpl.trim()} className={`mt-1 ${dangerBtn}`}>Upgrade</button>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
