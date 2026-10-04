'use client';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { getExplorerAddressUrl, NETWORKS } from '@/lib/contracts/config';
import RGSTArtifact from '@/lib/contracts/RGST.json';
import RGSTProxyArtifact from '@/lib/contracts/RGSTProxy.json';
import {
  Rocket, ExternalLink, Copy, Check, RefreshCw, TrendingUp, ArrowUpCircle, ShieldCheck, KeyRound,
  Send, Coins, Timer, FileCode2, Download, Settings2, Search,
} from 'lucide-react';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };
type BN = ethers.BigNumber;

// The proxy is not transparent: its own admin/upgrade functions sit on the proxy and every other
// selector is delegated to RGST. Token and proxy ABIs share no names, so one merged interface
// talks to both at the proxy address.
const onlyCallable = (abi: any[]) => abi.filter((f: any) => f.type === 'function' || f.type === 'event' || f.type === 'error');
const TOKEN_ABI = RGSTArtifact.abi;
const PROXY_ABI = RGSTProxyArtifact.abi;
const ABI = [...onlyCallable(TOKEN_ABI), ...onlyCallable(PROXY_ABI)];

const BASE = ethers.constants.WeiPerEther; // scalingFactor 1e18 = 1.0x
const MAX_REBASE_PERCENT = 10; // MAX_REBASE_DELTA = 10**17
const MIN_SCALING_FACTOR = ethers.BigNumber.from(10).pow(12);
const MIN_DELAY_HOURS = 3; // MIN_TIMELOCK_DELAY / MIN_PROXY_DELAY
const MAX_DELAY_HOURS = 7 * 24; // MAX_TIMELOCK_DELAY / MAX_PROXY_DELAY

// Matches RGST.ROLE_MINTER / ROLE_REBASER / ROLE_RECEIVER
const ROLES = [
  { id: 0, key: 'minter', label: 'Minter', setter: 'setMinter', hint: 'mint(to, amount) and mint(amount) → receiver' },
  { id: 1, key: 'rebaser', label: 'Rebaser', setter: 'setRebaser', hint: 'rebase / rebaseByMilli' },
  { id: 2, key: 'receiver', label: 'Receiver', setter: 'setReceiver', hint: 'gets tokens from mint(amount)' },
] as const;
type RoleKey = typeof ROLES[number]['key'];

// RGST reverts with require strings — decode Error(string) from the raw revert data first,
// then fall back to the shared decoder for wallet rejections and generic failures.
function decodeRgstError(e: any): string {
  const rawData = e?.error?.data?.data || e?.error?.data || e?.data?.data || e?.data;
  if (typeof rawData === 'string') {
    if (rawData.startsWith('0x08c379a0')) {
      try { return ethers.utils.defaultAbiCoder.decode(['string'], '0x' + rawData.slice(10))[0]; } catch { /* fall through */ }
    }
    if (rawData === '0x') return 'Reverted with no reason — check that the loaded address is the RGST proxy on the network your wallet is connected to.';
  }
  const reason: string | undefined = e?.reason || e?.error?.reason;
  if (reason) return reason.match(/reason string '([^']+)'/)?.[1] ?? reason.replace(/^execution reverted: /, '');
  return decodeError(e);
}

const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';
const smallBtn = 'shrink-0 px-3 bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold rounded-lg text-xs';
const dangerBtn = 'shrink-0 px-3 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg text-xs';
const ghostBtn = 'shrink-0 px-3 bg-surface-tertiary border border-white/10 rounded-lg text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-40';
const fmtAddr = (a: string) => a ? `${a.slice(0, 8)}...${a.slice(-6)}` : '—';
const isZero = (a: string) => !a || a === ethers.constants.AddressZero;
const sameAddr = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const fmtTs = (ts: number) => ts === 0 ? '—' : new Date(ts * 1000).toLocaleString();
const fmtDuration = (secs: number) => {
  if (secs <= 0) return '0m';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(' ');
};
const fmtTokens = (v: BN) => {
  const s = ethers.utils.commify(ethers.utils.formatUnits(v, 18));
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const fmtScaling = (sf: BN) => `${Number(ethers.utils.formatUnits(sf, 18)).toFixed(6)}x`;
const parseTokens = (v: string): BN => ethers.utils.parseUnits((v || '0').trim().replace(/,/g, ''), 18);

const ABI_JSON = JSON.stringify(ABI, null, 2);
const ABI_FUNCTIONS = ABI.filter((f: any) => f.type === 'function');

function downloadJson(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

interface Overview {
  name: string; symbol: string; decimals: number; version: string;
  totalSupply: BN; scalingFactor: BN; lastEpoch: number;
  owner: string; pendingOwner: string; ownershipUnlock: number;
  minter: string; rebaser: string; receiver: string;
  pendingRoles: Record<RoleKey, { user: string; unlock: number }>;
  timelockDelay: number; pendingTimelockDelay: number; timelockDelayUnlock: number;
  admin: string; pendingAdmin: string; adminUnlock: number;
  logic: string; pendingLogic: string; pendingLogicDataHash: string; upgradeUnlock: number;
  proxyDelay: number; pendingProxyDelay: number; proxyDelayUnlock: number;
}

export default function RgstSection() {
  const { provider, signer, isConnected, address, chainId, rgstAddress, setRgstAddress } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');

  // ticks so unlock countdowns move without refetching
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15000);
    return () => clearInterval(id);
  }, []);

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

  const AddrLink = ({ addr }: { addr: string }) => isZero(addr)
    ? <span className="text-txt-secondary">—</span>
    : (
      <a href={getExplorerAddressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer" className="font-mono text-txt-primary hover:text-accent">
        {fmtAddr(addr)}{sameAddr(addr, address) && <span className="text-accent font-sans"> (you)</span>}
      </a>
    );

  const Unlock = ({ ts }: { ts: number }) => ts === 0
    ? <span className="text-txt-secondary">—</span>
    : now >= ts
      ? <span className="text-green-400">Ready (since {fmtTs(ts)})</span>
      : <span className="text-yellow-400">in {fmtDuration(ts - now)} ({fmtTs(ts)})</span>;

  // Sends a tx, tracks it in TxStatus, and returns the receipt (null on failure).
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
      setTxStatus({ status: 'error', error: decodeRgstError(e) });
      return null;
    }
  };
  const fail = (error: string) => setTxStatus({ status: 'error', error });

  // ── Contract instances ──
  const getRead = useCallback(() => {
    if (!provider || !rgstAddress) return null;
    return new ethers.Contract(rgstAddress, ABI, provider);
  }, [provider, rgstAddress]);
  const getWrite = useCallback(() => {
    if (!signer || !rgstAddress) return null;
    return new ethers.Contract(rgstAddress, ABI, signer);
  }, [signer, rgstAddress]);

  // ── Deploy / Load ──
  const [implAddress, setImplAddress] = useState('');
  const [initName, setInitName] = useState('RGST');
  const [initSymbol, setInitSymbol] = useState('RGST');
  const [initSupply, setInitSupply] = useState('0');
  const [manualLoad, setManualLoad] = useState('');

  const deployImplementation = async (onDeployed: (a: string) => void, label: string) => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: `Deploying ${label}...` });
    try {
      const factory = new ethers.ContractFactory(TOKEN_ABI, RGSTArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      onDeployed(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `${label} deployed at ${impl.address}.` });
    } catch (e: any) {
      fail(decodeRgstError(e));
    }
  };

  // RGSTProxy's constructor sets the deployer as proxy admin and delegatecalls
  // initialize(name, symbol, totalSupply) in the same tx, so the deployer also becomes token
  // owner, minter, rebaser and receiver, and receives the initial supply.
  const deployProxy = async () => {
    if (!signer || !address) return;
    if (!ethers.utils.isAddress(implAddress.trim())) return fail('Invalid implementation address');
    if (!initName.trim() || !initSymbol.trim()) return fail('Name and symbol are required');
    if (!/^\d+$/.test(initSupply.trim())) return fail('Initial supply must be a whole number of tokens (0 or more)');
    setTxStatus({ status: 'pending', message: 'Deploying RGST proxy + initializing...' });
    try {
      const factory = new ethers.ContractFactory(PROXY_ABI, RGSTProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress.trim(), initName.trim(), initSymbol.trim(), ethers.BigNumber.from(initSupply.trim()));
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      setRgstAddress(proxy.address);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `RGST deployed at ${proxy.address}. You are proxy admin, token owner, minter, rebaser and receiver — hand roles over below (each change waits for the timelock).` });
    } catch (e: any) {
      fail(decodeRgstError(e));
    }
  };

  const loadExisting = () => {
    if (!ethers.utils.isAddress(manualLoad.trim())) return fail('Invalid address');
    setRgstAddress(manualLoad.trim());
    setManualLoad('');
    setTxStatus({ status: 'idle' });
  };

  // ── Overview ──
  const [overview, setOverview] = useState<Overview | null>(null);
  const [myBalance, setMyBalance] = useState<BN | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewLoadError, setOverviewLoadError] = useState('');

  const fetchOverview = useCallback(async () => {
    const t = getRead();
    if (!t) { setOverview(null); return; }
    setOverviewLoading(true);
    setOverviewLoadError('');
    try {
      const [
        name, symbol, decimals, version, totalSupply, scalingFactor, lastEpoch,
        owner, pendingOwner, ownershipUnlock, minter, rebaser, receiver,
        timelockDelay, pendingTimelockDelay, timelockDelayUnlock,
        admin, pendingAdmin, adminUnlock, logic, pendingLogic, pendingLogicDataHash, upgradeUnlock,
        proxyDelay, pendingProxyDelay, proxyDelayUnlock,
      ] = await Promise.all([
        t.name(), t.symbol(), t.decimals(), t.version(), t.totalSupply(), t.scalingFactor(), t.lastEpoch(),
        t.owner(), t.pendingOwner(), t.ownershipTransferUnlockTime(), t.minter(), t.rebaser(), t.receiver(),
        t.timelockDelay(), t.pendingTimelockDelay(), t.timelockDelayUnlockTime(),
        t.admin(), t.pendingAdmin(), t.adminChangeUnlockTime(), t.logic(), t.pendingLogic(), t.pendingLogicDataHash(), t.upgradeUnlockTime(),
        t.proxyDelay(), t.pendingProxyDelay(), t.proxyDelayUnlockTime(),
      ]);
      const pending = await Promise.all(ROLES.map(r => Promise.all([t.pendingRole(r.id), t.roleChangeUnlockTime(r.id)])));
      const pendingRoles = Object.fromEntries(ROLES.map((r, i) => [r.key, { user: pending[i][0], unlock: pending[i][1].toNumber() }])) as Overview['pendingRoles'];
      setOverview({
        name, symbol, decimals: Number(decimals), version, totalSupply, scalingFactor, lastEpoch: lastEpoch.toNumber(),
        owner, pendingOwner, ownershipUnlock: ownershipUnlock.toNumber(), minter, rebaser, receiver, pendingRoles,
        timelockDelay: timelockDelay.toNumber(), pendingTimelockDelay: pendingTimelockDelay.toNumber(), timelockDelayUnlock: timelockDelayUnlock.toNumber(),
        admin, pendingAdmin, adminUnlock: adminUnlock.toNumber(), logic, pendingLogic, pendingLogicDataHash, upgradeUnlock: upgradeUnlock.toNumber(),
        proxyDelay: proxyDelay.toNumber(), pendingProxyDelay: pendingProxyDelay.toNumber(), proxyDelayUnlock: proxyDelayUnlock.toNumber(),
      });
      setMyBalance(address ? await t.balanceOf(address) : null);
    } catch (e) {
      console.error('fetch RGST overview:', e);
      setOverview(null);
      setOverviewLoadError(`Failed to read from ${rgstAddress} — ${decodeRgstError(e)}. Double-check this address is the RGST proxy on the network your wallet is connected to.`);
    } finally {
      setOverviewLoading(false);
    }
  }, [getRead, address, rgstAddress]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const isOwner = !!overview && sameAddr(overview.owner, address);
  const isPendingOwner = !!overview && sameAddr(overview.pendingOwner, address);
  const isMinter = !!overview && sameAddr(overview.minter, address);
  const isRebaser = !!overview && sameAddr(overview.rebaser, address);
  const isAdmin = !!overview && sameAddr(overview.admin, address);
  const isPendingAdmin = !!overview && sameAddr(overview.pendingAdmin, address);

  const warn = (ok: boolean, who: string) => !ok && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not the {who} — these actions will revert.</p>;

  // ── Token: transfer / approve / burn / lookup ──
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [approveSpender, setApproveSpender] = useState('');
  const [approveAmount, setApproveAmount] = useState('');
  const [burnAmount, setBurnAmount] = useState('');
  const [lookupAddr, setLookupAddr] = useState('');
  const [lookupResult, setLookupResult] = useState<{ balance: BN; allowanceToYou: BN | null } | null>(null);

  const handleTransfer = async () => {
    const t = getWrite();
    if (!t) return;
    if (!ethers.utils.isAddress(transferTo.trim())) return fail('Invalid recipient');
    let amount: BN;
    try { amount = parseTokens(transferAmount); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    await runTx(`Transferring ${transferAmount} ${overview?.symbol ?? 'RGST'}...`, () => t.transfer(transferTo.trim(), amount), async () => {
      setTransferAmount('');
      await fetchOverview();
      return `Sent ${transferAmount} ${overview?.symbol ?? 'RGST'} to ${fmtAddr(transferTo.trim())}.`;
    });
  };

  const handleApprove = async () => {
    const t = getWrite();
    if (!t) return;
    if (!ethers.utils.isAddress(approveSpender.trim())) return fail('Invalid spender');
    let amount: BN;
    try { amount = approveAmount.trim().toLowerCase() === 'max' ? ethers.constants.MaxUint256 : parseTokens(approveAmount); } catch { return fail('Amount must be a number or "max"'); }
    await runTx('Approving...', () => t.approve(approveSpender.trim(), amount), () =>
      `Approved ${amount.eq(ethers.constants.MaxUint256) ? 'unlimited' : approveAmount} for ${fmtAddr(approveSpender.trim())}.`);
  };

  const handleBurn = async () => {
    const t = getWrite();
    if (!t) return;
    let amount: BN;
    try { amount = parseTokens(burnAmount); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    await runTx(`Burning ${burnAmount}...`, () => t.burn(amount), async () => {
      setBurnAmount('');
      await fetchOverview();
      return `Burned ${burnAmount} ${overview?.symbol ?? 'RGST'}.`;
    });
  };

  const handleLookup = async () => {
    const t = getRead();
    if (!t) return;
    if (!ethers.utils.isAddress(lookupAddr.trim())) return fail('Invalid address');
    try {
      const [balance, allowanceToYou] = await Promise.all([
        t.balanceOf(lookupAddr.trim()),
        address ? t.allowance(lookupAddr.trim(), address) : Promise.resolve(null),
      ]);
      setLookupResult({ balance, allowanceToYou });
    } catch (e) { fail(decodeRgstError(e)); }
  };

  // ── Minter ──
  const [mintTo, setMintTo] = useState('');
  const [mintAmount, setMintAmount] = useState('');

  const handleMint = async (toReceiver: boolean) => {
    const t = getWrite();
    if (!t) return;
    let amount: BN;
    try { amount = parseTokens(mintAmount); } catch { return fail('Amount must be a number'); }
    if (amount.isZero()) return fail('Amount must be > 0');
    if (!toReceiver && !ethers.utils.isAddress(mintTo.trim())) return fail('Invalid recipient');
    const target = toReceiver ? overview?.receiver ?? '' : mintTo.trim();
    // mint is overloaded on RGST, so the signature must be spelled out for ethers
    await runTx(`Minting ${mintAmount}...`, () => toReceiver ? t['mint(uint256)'](amount) : t['mint(address,uint256)'](target, amount), async () => {
      setMintAmount('');
      await fetchOverview();
      return `Minted ${mintAmount} ${overview?.symbol ?? 'RGST'} to ${fmtAddr(target)}${toReceiver ? ' (receiver)' : ''}.`;
    });
  };

  // ── Rebaser ──
  const [rebaseEpoch, setRebaseEpoch] = useState('');
  const [rebasePercent, setRebasePercent] = useState('');
  const [rebasePositive, setRebasePositive] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [rawDelta, setRawDelta] = useState('');

  useEffect(() => { if (overview) setRebaseEpoch(String(overview.lastEpoch + 1)); }, [overview?.lastEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // indexDelta as the contract sees it (1e18 = 100%); null when the input is invalid
  const rebaseDelta = useMemo((): BN | null => {
    try {
      if (rawMode) return rawDelta.trim() ? ethers.BigNumber.from(rawDelta.trim()) : null;
      if (!/^\d+(\.\d)?$/.test(rebasePercent.trim())) return null; // rebaseByMilli: 0.1% steps
      return ethers.utils.parseUnits(rebasePercent.trim(), 16);
    } catch { return null; }
  }, [rawMode, rawDelta, rebasePercent]);

  const rebasePreview = useMemo(() => {
    if (!overview || !rebaseDelta || rebaseDelta.gt(BASE.div(10))) return null;
    const sf = overview.scalingFactor;
    const newSf = sf.mul(rebasePositive ? BASE.add(rebaseDelta) : BASE.sub(rebaseDelta)).div(BASE);
    return { newSf, newSupply: overview.totalSupply.mul(newSf).div(sf), tooLow: newSf.lt(MIN_SCALING_FACTOR) };
  }, [overview, rebaseDelta, rebasePositive]);

  const handleRebase = async () => {
    const t = getWrite();
    if (!t || !overview) return;
    const epoch = parseInt(rebaseEpoch);
    if (isNaN(epoch) || epoch <= overview.lastEpoch) return fail(`Epoch must be greater than the last epoch (${overview.lastEpoch})`);
    if (!rebaseDelta) return fail(rawMode ? 'indexDelta must be an integer (1e18 = 100%)' : 'Percent must be a number with at most one decimal (e.g. 2.5)');
    if (rebaseDelta.gt(BASE.div(10))) return fail(`Rebase is capped at ${MAX_REBASE_PERCENT}% per call`);
    if (rebasePreview?.tooLow) return fail('This negative rebase would push scalingFactor below MIN_SCALING_FACTOR');
    const label = rawMode ? `indexDelta ${rebaseDelta.toString()}` : `${rebasePositive ? '+' : '-'}${rebasePercent}%`;
    await runTx(`Rebasing ${label} (epoch ${epoch})...`, () => rawMode
      ? t.rebase(epoch, rebaseDelta, rebasePositive)
      : t.rebaseByMilli(epoch, rebaseDelta.div(ethers.BigNumber.from(10).pow(15)), rebasePositive), async () => {
      setRebasePercent('');
      setRawDelta('');
      await fetchOverview();
      return `Rebased ${label} at epoch ${epoch}.`;
    });
  };

  // ── Owner: timelocked roles / ownership / timelock delay ──
  const [roleInputs, setRoleInputs] = useState<Record<RoleKey, string>>({ minter: '', rebaser: '', receiver: '' });
  const [newOwnerInput, setNewOwnerInput] = useState('');
  const [timelockHoursInput, setTimelockHoursInput] = useState('');

  const handleProposeRole = async (role: typeof ROLES[number]) => {
    const t = getWrite();
    if (!t) return;
    const user = roleInputs[role.key].trim();
    if (!ethers.utils.isAddress(user)) return fail(`Invalid ${role.label.toLowerCase()} address`);
    await runTx(`Proposing ${role.label}...`, () => t[role.setter](user), async () => {
      setRoleInputs(prev => ({ ...prev, [role.key]: '' }));
      await fetchOverview();
      return `${role.label} change to ${fmtAddr(user)} proposed — apply it after ${fmtDuration(overview?.timelockDelay ?? 0)}.`;
    });
  };

  const handleRoleStep = async (role: typeof ROLES[number], step: 'apply' | 'cancel') => {
    const t = getWrite();
    if (!t) return;
    await runTx(`${step === 'apply' ? 'Applying' : 'Cancelling'} ${role.label} change...`,
      () => step === 'apply' ? t.applyRoleChange(role.id) : t.cancelRoleChange(role.id), async () => {
        await fetchOverview();
        return `${role.label} change ${step === 'apply' ? 'applied' : 'cancelled'}.`;
      });
  };

  const handleTransferOwnership = async () => {
    const t = getWrite();
    if (!t) return;
    if (!ethers.utils.isAddress(newOwnerInput.trim())) return fail('Invalid new owner address');
    await runTx('Starting ownership transfer...', () => t.transferOwnership(newOwnerInput.trim()), async () => {
      setNewOwnerInput('');
      await fetchOverview();
      return `Ownership transfer started — the new owner accepts after ${fmtDuration(overview?.timelockDelay ?? 0)}.`;
    });
  };

  const simpleTx = async (pendingMsg: string, call: (t: ethers.Contract) => Promise<ethers.ContractTransaction>, doneMsg: string) => {
    const t = getWrite();
    if (!t) return;
    await runTx(pendingMsg, () => call(t), async () => { await fetchOverview(); return doneMsg; });
  };

  // hours → seconds, within the shared 3h–7d bounds; null when out of range
  const parseDelayHours = (v: string): number | null => {
    const h = Number(v);
    if (!v.trim() || isNaN(h) || h < MIN_DELAY_HOURS || h > MAX_DELAY_HOURS) return null;
    return Math.round(h * 3600);
  };

  const handleSetTimelockDelay = async () => {
    const secs = parseDelayHours(timelockHoursInput);
    if (secs === null) return fail(`Delay must be between ${MIN_DELAY_HOURS} and ${MAX_DELAY_HOURS} hours`);
    await simpleTx('Proposing timelock delay...', t => t.setTimelockDelay(secs), `Timelock delay change to ${fmtDuration(secs)} proposed — apply it after the current delay.`);
    setTimelockHoursInput('');
  };

  // ── Proxy admin: admin change / proxy delay ──
  const [newAdminInput, setNewAdminInput] = useState('');
  const [proxyDelayHoursInput, setProxyDelayHoursInput] = useState('');

  const handleChangeAdmin = async () => {
    if (!ethers.utils.isAddress(newAdminInput.trim())) return fail('Invalid new admin address');
    await simpleTx('Starting proxy admin change...', t => t.changeAdmin(newAdminInput.trim()), `Admin change started — the new admin accepts after ${fmtDuration(overview?.proxyDelay ?? 0)}.`);
    setNewAdminInput('');
  };

  const handleSetProxyDelay = async () => {
    const secs = parseDelayHours(proxyDelayHoursInput);
    if (secs === null) return fail(`Delay must be between ${MIN_DELAY_HOURS} and ${MAX_DELAY_HOURS} hours`);
    await simpleTx('Proposing proxy delay...', t => t.setProxyDelay(secs), `Proxy delay change to ${fmtDuration(secs)} proposed — apply it after the current delay.`);
    setProxyDelayHoursInput('');
  };

  // ── Upgrade (timelocked: propose → wait proxyDelay → execute) ──
  const [newImplAddress, setNewImplAddress] = useState('');
  const [newImplVersion, setNewImplVersion] = useState('');
  const [upgradeData, setUpgradeData] = useState('0x');
  const implPrefilledFor = useRef('');

  useEffect(() => {
    if (!provider || !newImplAddress || !ethers.utils.isAddress(newImplAddress)) { setNewImplVersion(''); return; }
    let cancelled = false;
    new ethers.Contract(newImplAddress, TOKEN_ABI, provider).version()
      .then((v: string) => { if (!cancelled) setNewImplVersion(v); })
      .catch(() => { if (!cancelled) setNewImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newImplAddress]);

  // prefill the pending implementation once per proposal so execute/cancel work after a reload
  useEffect(() => {
    if (overview && !isZero(overview.pendingLogic) && implPrefilledFor.current !== overview.pendingLogic) {
      implPrefilledFor.current = overview.pendingLogic;
      setNewImplAddress(overview.pendingLogic);
    }
  }, [overview]);

  const upgradeDataValid = ethers.utils.isHexString(upgradeData.trim()) && upgradeData.trim().length % 2 === 0;
  const upgradeDataHash = upgradeDataValid ? ethers.utils.keccak256(upgradeData.trim()) : '';
  const hasPendingUpgrade = !!overview && !isZero(overview.pendingLogic);
  const dataMatchesPending = hasPendingUpgrade && upgradeDataHash.toLowerCase() === overview!.pendingLogicDataHash.toLowerCase();

  const handleProposeUpgrade = async () => {
    if (!ethers.utils.isAddress(newImplAddress.trim())) return fail('Invalid implementation address');
    if (!upgradeDataValid) return fail('Upgrade data must be hex (use 0x for none)');
    await simpleTx('Proposing upgrade...', t => t.proposeUpgrade(newImplAddress.trim(), upgradeData.trim()),
      `Upgrade to ${fmtAddr(newImplAddress.trim())} proposed — execute it after ${fmtDuration(overview?.proxyDelay ?? 0)} with the same data.`);
  };

  const handleExecuteUpgrade = async () => {
    if (!upgradeDataValid) return fail('Upgrade data must be hex (use 0x for none)');
    if (!dataMatchesPending) return fail('Upgrade data does not match what was proposed (hash mismatch)');
    await simpleTx('Executing upgrade...', t => t.executeUpgrade(upgradeData.trim()), 'Upgrade executed.');
  };

  // ── Config snapshot (paste into chain.json / backend config) ──
  const configJson = useMemo(() => !overview || !rgstAddress ? '' : JSON.stringify({
    chainId,
    network: NETWORKS[chainId]?.chainName ?? 'unknown',
    rgstAddress,
    implementation: overview.logic,
    name: overview.name,
    symbol: overview.symbol,
    decimals: overview.decimals,
    version: overview.version,
    proxyAdmin: overview.admin,
    owner: overview.owner,
    minter: overview.minter,
    rebaser: overview.rebaser,
    receiver: overview.receiver,
    timelockDelaySeconds: overview.timelockDelay,
    proxyDelaySeconds: overview.proxyDelay,
  }, null, 2), [overview, rgstAddress, chainId]);

  const symbol = overview?.symbol ?? 'RGST';

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* ── Deploy / Load ── */}
      <Card title="Deploy RGST Token" icon={<Rocket className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Rebasing ERC20 (18 decimals) behind a timelocked EIP-1967 proxy. Balances move with <code className="text-accent">scalingFactor</code> on each rebase; role, ownership, admin and upgrade changes all wait for a 12h timelock (adjustable 3h–7d).
          {isConnected && <> Deploying to <span className="text-txt-primary">{NETWORKS[chainId]?.chainName ?? `chain ${chainId}`}</span>.</>}
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the RGST logic contract (its constructor locks it against direct initialization).</p>
            <button onClick={() => deployImplementation(setImplAddress, 'RGST implementation')} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy Implementation</button>
            {implAddress && ethers.utils.isAddress(implAddress) && <AddrBadge addr={implAddress} label="impl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Proxy + initialize</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys <code className="text-accent">RGSTProxy</code>, which calls <code className="text-accent">initialize(name, symbol, totalSupply)</code> in the same tx. Your wallet becomes proxy admin, owner, minter, rebaser and receiver.</p>
            <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="Implementation address (step 1, or paste one)" className={`${inputCls} mb-2`} />
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="text-xs text-txt-secondary">Name</label>
                <input value={initName} onChange={e => setInitName(e.target.value)} className={`${inputCls} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Symbol</label>
                <input value={initSymbol} onChange={e => setInitSymbol(e.target.value)} className={`${inputCls} mt-1`} />
              </div>
            </div>
            <label className="text-xs text-txt-secondary">Initial supply in whole tokens, minted to you (0 = start empty, mint later)</label>
            <input value={initSupply} onChange={e => setInitSupply(e.target.value)} type="number" min={0} step={1} className={`${inputCls} mt-1 mb-3`} />
            <button onClick={deployProxy} disabled={!isConnected || !implAddress} className={`w-full ${btnCls}`}>Deploy Proxy</button>
            {rgstAddress && <AddrBadge addr={rgstAddress} label="proxy" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">Load Existing</h4>
            <p className="text-xs text-txt-secondary mb-3">Already deployed? Paste the proxy address to load it.</p>
            <input value={manualLoad} onChange={e => setManualLoad(e.target.value)} placeholder="0x... proxy address" className={`${inputCls} mb-3`} />
            <button onClick={loadExisting} className="w-full bg-surface-secondary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm transition-colors">Load Address</button>
            <p className="text-[11px] text-txt-secondary mt-3">To make it the default for everyone, set <code className="text-accent">rgstAddress</code> for this chain in <code className="text-accent">lib/contracts/chain.json</code>.</p>
          </div>
        </div>
      </Card>

      {/* ── ABI ── */}
      <Card title="ABI" icon={<FileCode2 className="w-5 h-5 text-accent" />}>
        <p className="text-xs text-txt-secondary mb-3">
          RGST + RGSTProxy ABI merged ({ABI_FUNCTIONS.length} functions, {ABI.length} entries) — use it with the proxy address for both token calls and proxy admin calls.
        </p>
        <div className="flex gap-2 mb-3 flex-wrap">
          <button onClick={() => copyText(ABI_JSON, 'abi')} className={`flex items-center gap-1.5 px-4 ${btnCls}`}>
            {copied === 'abi' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied === 'abi' ? 'Copied' : 'Copy ABI'}
          </button>
          <button onClick={() => downloadJson(ABI_JSON, 'RGST.abi.json')} className="flex items-center gap-1.5 px-4 bg-surface-tertiary border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm">
            <Download className="w-4 h-4" /> Download RGST.abi.json
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

      {!rgstAddress ? (
        <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load an RGST proxy to manage the token, rebases, roles and upgrades.</p></Card>
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
          } icon={<TrendingUp className="w-5 h-5 text-accent" />}>
            {overviewLoadError && (
              <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 mb-3">
                <p className="text-red-300 text-xs">{overviewLoadError}</p>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
              <div><p className="text-xs text-txt-secondary">Token</p><p className="text-sm font-bold text-accent">{overview ? `${overview.name} (${overview.symbol})` : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Version</p><p className="text-sm font-bold text-accent">{overview?.version || '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Total Supply</p><p className="text-sm font-bold text-txt-primary">{overview ? fmtTokens(overview.totalSupply) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Your Balance</p><p className="text-sm font-bold text-txt-primary">{myBalance ? fmtTokens(myBalance) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Scaling Factor</p><p className="text-sm text-txt-primary">{overview ? fmtScaling(overview.scalingFactor) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Last Epoch</p><p className="text-sm text-txt-primary">{overview?.lastEpoch ?? '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Timelock Delay (token)</p><p className="text-sm text-txt-primary">{overview ? fmtDuration(overview.timelockDelay) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Proxy Delay</p><p className="text-sm text-txt-primary">{overview ? fmtDuration(overview.proxyDelay) : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Owner</p><p className="text-xs">{overview ? <AddrLink addr={overview.owner} /> : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Minter</p><p className="text-xs">{overview ? <AddrLink addr={overview.minter} /> : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Rebaser</p><p className="text-xs">{overview ? <AddrLink addr={overview.rebaser} /> : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Receiver</p><p className="text-xs">{overview ? <AddrLink addr={overview.receiver} /> : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Proxy Admin</p><p className="text-xs">{overview ? <AddrLink addr={overview.admin} /> : '—'}</p></div>
              <div><p className="text-xs text-txt-secondary">Implementation</p><p className="text-xs">{overview ? <AddrLink addr={overview.logic} /> : '—'}</p></div>
              <div className="col-span-2">
                <p className="text-xs text-txt-secondary">Your Roles</p>
                <p className="text-xs">
                  {isAdmin && <span className="text-yellow-400 font-medium mr-2">Proxy Admin</span>}
                  {isOwner && <span className="text-yellow-400 font-medium mr-2">Owner</span>}
                  {isMinter && <span className="text-accent font-medium mr-2">Minter</span>}
                  {isRebaser && <span className="text-accent font-medium mr-2">Rebaser</span>}
                  {isPendingOwner && <span className="text-green-400 font-medium mr-2">Pending Owner</span>}
                  {isPendingAdmin && <span className="text-green-400 font-medium mr-2">Pending Admin</span>}
                  {!isAdmin && !isOwner && !isMinter && !isRebaser && !isPendingOwner && !isPendingAdmin && <span className="text-txt-secondary">{isConnected ? 'Holder' : 'Not connected'}</span>}
                </p>
              </div>
            </div>
            <AddrBadge addr={rgstAddress} label="loaded" />
          </Card>

          {/* ── Config snapshot ── */}
          {configJson && (
            <Card title="Deployment Config" icon={<Settings2 className="w-5 h-5 text-accent" />}>
              <p className="text-xs text-txt-secondary mb-3">Live snapshot of this deployment — copy it into your backend config or notes. For this UI&apos;s default, add the proxy as <code className="text-accent">rgstAddress</code> under chain <code className="text-accent">&quot;{chainId}&quot;</code> in <code className="text-accent">lib/contracts/chain.json</code>.</p>
              <div className="flex gap-2 mb-3 flex-wrap">
                <button onClick={() => copyText(configJson, 'config')} className={`flex items-center gap-1.5 px-4 ${btnCls}`}>
                  {copied === 'config' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied === 'config' ? 'Copied' : 'Copy Config'}
                </button>
                <button onClick={() => downloadJson(configJson, `rgst-${chainId}.json`)} className="flex items-center gap-1.5 px-4 bg-surface-tertiary border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm">
                  <Download className="w-4 h-4" /> Download rgst-{chainId}.json
                </button>
              </div>
              <pre className="bg-surface-tertiary rounded-lg p-3 text-[11px] font-mono max-h-80 overflow-auto whitespace-pre">{configJson}</pre>
            </Card>
          )}

          {/* ── Token ── */}
          <Card title="Token" icon={<Send className="w-5 h-5 text-accent" />}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-txt-secondary">Transfer {symbol}</label>
                <div className="flex gap-2 mt-1">
                  <input value={transferTo} onChange={e => setTransferTo(e.target.value)} placeholder="0x... recipient" className={inputCls} />
                  <input value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="Amount" className={`${inputCls} max-w-[120px]`} />
                  <button onClick={handleTransfer} disabled={!isConnected} className={smallBtn}>Send</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Approve spender (type &quot;max&quot; for unlimited)</label>
                <div className="flex gap-2 mt-1">
                  <input value={approveSpender} onChange={e => setApproveSpender(e.target.value)} placeholder="0x... spender" className={inputCls} />
                  <input value={approveAmount} onChange={e => setApproveAmount(e.target.value)} placeholder="Amount" className={`${inputCls} max-w-[120px]`} />
                  <button onClick={handleApprove} disabled={!isConnected} className={smallBtn}>Approve</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Burn from your balance{myBalance && <> (have <span className="text-txt-primary">{fmtTokens(myBalance)}</span>)</>}</label>
                <div className="flex gap-2 mt-1">
                  <input value={burnAmount} onChange={e => setBurnAmount(e.target.value)} placeholder="Amount" className={inputCls} />
                  <button onClick={() => myBalance && setBurnAmount(ethers.utils.formatUnits(myBalance, 18))} disabled={!myBalance} className={ghostBtn}>Max</button>
                  <button onClick={handleBurn} disabled={!isConnected} className={dangerBtn}>Burn</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Balance lookup</label>
                <div className="flex gap-2 mt-1">
                  <input value={lookupAddr} onChange={e => setLookupAddr(e.target.value)} placeholder="0x... holder" className={inputCls} />
                  <button onClick={handleLookup} className={`shrink-0 px-4 ${btnCls}`}><Search className="w-4 h-4" /></button>
                </div>
                {lookupResult && (
                  <p className="text-xs mt-2 text-txt-secondary">
                    Balance: <span className="text-txt-primary">{fmtTokens(lookupResult.balance)} {symbol}</span>
                    {lookupResult.allowanceToYou && <> · Allowance to you: <span className="text-txt-primary">{lookupResult.allowanceToYou.eq(ethers.constants.MaxUint256) ? 'unlimited' : fmtTokens(lookupResult.allowanceToYou)}</span></>}
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* ── Minter ── */}
          <Card title="Mint (Minter)" icon={<Coins className="w-5 h-5 text-accent" />}>
            {warn(isMinter, 'minter')}
            <label className="text-xs text-txt-secondary">Amount ({symbol}, 18 decimals)</label>
            <input value={mintAmount} onChange={e => setMintAmount(e.target.value)} placeholder="e.g. 1000" className={`${inputCls} mt-1 mb-3`} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-txt-secondary">Mint to address — <code className="text-accent">mint(to, amount)</code></label>
                <div className="flex gap-2 mt-1">
                  <input value={mintTo} onChange={e => setMintTo(e.target.value)} placeholder="0x... recipient" className={inputCls} />
                  <button onClick={() => setMintTo(address)} disabled={!address} className={ghostBtn}>Use mine</button>
                  <button onClick={() => handleMint(false)} disabled={!isMinter} className={smallBtn}>Mint</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Mint to receiver ({overview ? fmtAddr(overview.receiver) : '—'}) — <code className="text-accent">mint(amount)</code></label>
                <button onClick={() => handleMint(true)} disabled={!isMinter} className={`w-full mt-1 ${btnCls}`}>Mint to Receiver</button>
              </div>
            </div>
          </Card>

          {/* ── Rebaser ── */}
          <Card title="Rebase (Rebaser)" icon={<TrendingUp className="w-5 h-5 text-accent" />}>
            {warn(isRebaser, 'rebaser')}
            <p className="text-xs text-txt-secondary mb-3">Scales every balance by the same factor. Max {MAX_REBASE_PERCENT}% per call; the epoch must be higher than the last one ({overview?.lastEpoch ?? '?'}).</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="text-xs text-txt-secondary">Epoch</label>
                <input value={rebaseEpoch} onChange={e => setRebaseEpoch(e.target.value)} type="number" className={`${inputCls} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Direction</label>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => setRebasePositive(true)} className={`flex-1 py-2 rounded-lg text-sm font-medium ${rebasePositive ? 'bg-green-600/80 text-white' : 'bg-surface-tertiary text-txt-secondary'}`}>+ Expand</button>
                  <button onClick={() => setRebasePositive(false)} className={`flex-1 py-2 rounded-lg text-sm font-medium ${!rebasePositive ? 'bg-red-600/80 text-white' : 'bg-surface-tertiary text-txt-secondary'}`}>− Contract</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary flex items-center justify-between">
                  {rawMode ? 'indexDelta (1e18 = 100%) — rebase()' : 'Percent (0.1% steps) — rebaseByMilli()'}
                  <button onClick={() => setRawMode(m => !m)} className="text-accent hover:underline">{rawMode ? 'use %' : 'raw'}</button>
                </label>
                {rawMode
                  ? <input value={rawDelta} onChange={e => setRawDelta(e.target.value)} placeholder="e.g. 25000000000000000" className={`${inputCls} mt-1`} />
                  : <input value={rebasePercent} onChange={e => setRebasePercent(e.target.value)} placeholder={`0 – ${MAX_REBASE_PERCENT}`} className={`${inputCls} mt-1`} />}
              </div>
            </div>
            {rebasePreview && overview && (
              <p className={`text-xs mb-3 ${rebasePreview.tooLow ? 'text-red-400' : 'text-txt-secondary'}`}>
                Preview: scaling {fmtScaling(overview.scalingFactor)} → <span className="text-txt-primary">{fmtScaling(rebasePreview.newSf)}</span>,
                supply {fmtTokens(overview.totalSupply)} → <span className="text-txt-primary">{fmtTokens(rebasePreview.newSupply)}</span>
                {rebasePreview.tooLow && ' — below MIN_SCALING_FACTOR, will revert'}
                {rebasePositive && ' (positive rebases are capped at the contract max scaling factor)'}
              </p>
            )}
            {rebaseDelta && rebaseDelta.gt(BASE.div(10)) && <p className="text-xs text-red-400 mb-3">Above the {MAX_REBASE_PERCENT}% cap — will revert.</p>}
            <button onClick={handleRebase} disabled={!isRebaser} className={`w-full ${btnCls}`}>Rebase</button>
          </Card>

          {/* ── Owner: roles ── */}
          <Card title="Roles (Owner, timelocked)" icon={<KeyRound className="w-5 h-5 text-yellow-400" />}>
            {warn(isOwner, 'owner')}
            <p className="text-xs text-txt-secondary mb-3">Each change is two steps: propose, then apply after the timelock ({overview ? fmtDuration(overview.timelockDelay) : '?'}). Proposing again replaces the pending address and restarts the wait.</p>
            <div className="space-y-3">
              {ROLES.map(role => {
                const current = overview ? overview[role.key] : '';
                const pending = overview?.pendingRoles[role.key];
                const hasPending = !!pending && !isZero(pending.user);
                return (
                  <div key={role.key} className="bg-surface-tertiary rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mb-2">
                      <span className="font-medium text-sm text-txt-primary">{role.label}</span>
                      <span className="text-txt-secondary">{role.hint}</span>
                      <span className="text-txt-secondary">Current: <AddrLink addr={current} /></span>
                      {hasPending && <span className="text-txt-secondary">Pending: <AddrLink addr={pending!.user} /> · <Unlock ts={pending!.unlock} /></span>}
                    </div>
                    <div className="flex gap-2">
                      <input value={roleInputs[role.key]} onChange={e => setRoleInputs(prev => ({ ...prev, [role.key]: e.target.value }))} placeholder={`0x... new ${role.label.toLowerCase()}`} className={inputCls} />
                      <button onClick={() => handleProposeRole(role)} disabled={!isOwner} className={smallBtn}>Propose</button>
                      <button onClick={() => handleRoleStep(role, 'apply')} disabled={!isOwner || !hasPending || now < pending!.unlock} className={smallBtn}>Apply</button>
                      <button onClick={() => handleRoleStep(role, 'cancel')} disabled={!isOwner || !hasPending} className={dangerBtn}>Cancel</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── Owner: ownership + timelock delay ── */}
          <Card title="Ownership & Timelock" icon={<ShieldCheck className="w-5 h-5 text-yellow-400" />}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Transfer Ownership</h4>
                <p className="text-xs text-txt-secondary mb-1">Owner: <AddrLink addr={overview?.owner ?? ''} /></p>
                {overview && !isZero(overview.pendingOwner) && (
                  <p className="text-xs text-txt-secondary mb-1">Pending: <AddrLink addr={overview.pendingOwner} /> · <Unlock ts={overview.ownershipUnlock} /></p>
                )}
                <div className="flex gap-2 mt-2">
                  <input value={newOwnerInput} onChange={e => setNewOwnerInput(e.target.value)} placeholder="0x... new owner" className={inputCls} />
                  <button onClick={handleTransferOwnership} disabled={!isOwner} className={smallBtn}>Start</button>
                  <button onClick={() => simpleTx('Cancelling ownership transfer...', t => t.cancelOwnershipTransfer(), 'Ownership transfer cancelled.')} disabled={!isOwner || !overview || isZero(overview.pendingOwner)} className={dangerBtn}>Cancel</button>
                </div>
                <button onClick={() => simpleTx('Accepting ownership...', t => t.acceptOwnership(), 'You are now the owner.')} disabled={!isPendingOwner || now < (overview?.ownershipUnlock ?? 0)} className={`w-full mt-3 ${btnCls}`}>Accept Ownership (pending owner)</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2 flex items-center gap-1.5"><Timer className="w-4 h-4" /> Token Timelock Delay</h4>
                <p className="text-xs text-txt-secondary mb-1">Current: <span className="text-txt-primary">{overview ? fmtDuration(overview.timelockDelay) : '—'}</span> — applies to role and ownership changes. A change waits for the current delay.</p>
                {overview && overview.pendingTimelockDelay > 0 && (
                  <p className="text-xs text-txt-secondary mb-1">Pending: <span className="text-txt-primary">{fmtDuration(overview.pendingTimelockDelay)}</span> · <Unlock ts={overview.timelockDelayUnlock} /></p>
                )}
                <div className="flex gap-2 mt-2">
                  <input value={timelockHoursInput} onChange={e => setTimelockHoursInput(e.target.value)} placeholder={`Hours (${MIN_DELAY_HOURS}–${MAX_DELAY_HOURS})`} type="number" className={inputCls} />
                  <button onClick={handleSetTimelockDelay} disabled={!isOwner} className={smallBtn}>Propose</button>
                  <button onClick={() => simpleTx('Applying timelock delay...', t => t.applyTimelockDelay(), 'Timelock delay updated.')} disabled={!isOwner || !overview?.pendingTimelockDelay || now < overview.timelockDelayUnlock} className={smallBtn}>Apply</button>
                  <button onClick={() => simpleTx('Cancelling timelock delay change...', t => t.cancelTimelockDelay(), 'Timelock delay change cancelled.')} disabled={!isOwner || !overview?.pendingTimelockDelay} className={dangerBtn}>Cancel</button>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Proxy admin ── */}
          <Card title="Proxy Admin (timelocked)" icon={<ShieldCheck className="w-5 h-5 text-yellow-400" />}>
            {warn(isAdmin || isPendingAdmin, 'proxy admin')}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">Change Admin</h4>
                <p className="text-xs text-txt-secondary mb-1">Admin: <AddrLink addr={overview?.admin ?? ''} /></p>
                {overview && !isZero(overview.pendingAdmin) && (
                  <p className="text-xs text-txt-secondary mb-1">Pending: <AddrLink addr={overview.pendingAdmin} /> · <Unlock ts={overview.adminUnlock} /></p>
                )}
                <div className="flex gap-2 mt-2">
                  <input value={newAdminInput} onChange={e => setNewAdminInput(e.target.value)} placeholder="0x... new admin" className={inputCls} />
                  <button onClick={handleChangeAdmin} disabled={!isAdmin} className={smallBtn}>Start</button>
                  <button onClick={() => simpleTx('Cancelling admin change...', t => t.cancelAdminChange(), 'Admin change cancelled.')} disabled={!isAdmin || !overview || isZero(overview.pendingAdmin)} className={dangerBtn}>Cancel</button>
                </div>
                <button onClick={() => simpleTx('Accepting proxy admin...', t => t.acceptAdmin(), 'You are now the proxy admin.')} disabled={!isPendingAdmin || now < (overview?.adminUnlock ?? 0)} className={`w-full mt-3 ${btnCls}`}>Accept Admin (pending admin)</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2 flex items-center gap-1.5"><Timer className="w-4 h-4" /> Proxy Delay</h4>
                <p className="text-xs text-txt-secondary mb-1">Current: <span className="text-txt-primary">{overview ? fmtDuration(overview.proxyDelay) : '—'}</span> — applies to admin changes and upgrades. A change waits for the current delay.</p>
                {overview && overview.pendingProxyDelay > 0 && (
                  <p className="text-xs text-txt-secondary mb-1">Pending: <span className="text-txt-primary">{fmtDuration(overview.pendingProxyDelay)}</span> · <Unlock ts={overview.proxyDelayUnlock} /></p>
                )}
                <div className="flex gap-2 mt-2">
                  <input value={proxyDelayHoursInput} onChange={e => setProxyDelayHoursInput(e.target.value)} placeholder={`Hours (${MIN_DELAY_HOURS}–${MAX_DELAY_HOURS})`} type="number" className={inputCls} />
                  <button onClick={handleSetProxyDelay} disabled={!isAdmin} className={smallBtn}>Propose</button>
                  <button onClick={() => simpleTx('Applying proxy delay...', t => t.applyProxyDelay(), 'Proxy delay updated.')} disabled={!isAdmin || !overview?.pendingProxyDelay || now < overview.proxyDelayUnlock} className={smallBtn}>Apply</button>
                  <button onClick={() => simpleTx('Cancelling proxy delay change...', t => t.cancelProxyDelay(), 'Proxy delay change cancelled.')} disabled={!isAdmin || !overview?.pendingProxyDelay} className={dangerBtn}>Cancel</button>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Upgrade ── */}
          <Card title="Upgrade Implementation (timelocked)" icon={<ArrowUpCircle className="w-5 h-5 text-accent" />}>
            {warn(isAdmin, 'proxy admin')}
            <p className="text-xs text-txt-secondary mb-3">
              Current: <AddrLink addr={overview?.logic ?? ''} /> ({overview?.version ?? '?'})
              {hasPendingUpgrade && <> · Pending: <AddrLink addr={overview!.pendingLogic} /> · <Unlock ts={overview!.upgradeUnlock} /></>}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">1. New Implementation</h4>
                <p className="text-xs text-txt-secondary mb-3">Deploys the RGST logic bundled with this UI.</p>
                <button onClick={() => deployImplementation(setNewImplAddress, 'New RGST implementation')} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy New Implementation</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">2. Propose</h4>
                <input value={newImplAddress} onChange={e => setNewImplAddress(e.target.value)} placeholder="New implementation address" className={`${inputCls} mb-2`} />
                {newImplVersion && <p className="text-xs text-txt-secondary mb-2">version(): <span className="text-accent">{newImplVersion}</span></p>}
                <label className="text-xs text-txt-secondary">Optional migration call data (0x = none) — must be re-entered identically to execute</label>
                <input value={upgradeData} onChange={e => setUpgradeData(e.target.value)} className={`${inputCls} mt-1 mb-2`} />
                <button onClick={handleProposeUpgrade} disabled={!isAdmin || !newImplAddress} className={`w-full ${btnCls}`}>Propose Upgrade</button>
              </div>
              <div className="bg-surface-tertiary rounded-lg p-4">
                <h4 className="font-medium mb-2">3. Execute / Cancel</h4>
                <p className="text-xs text-txt-secondary mb-3">
                  {!hasPendingUpgrade ? 'No upgrade pending.'
                    : dataMatchesPending ? <span className="text-green-400">Call data matches the proposal.</span>
                      : <span className="text-red-400">Call data does not match the proposal — enter the exact data used when proposing.</span>}
                </p>
                <button onClick={handleExecuteUpgrade} disabled={!isAdmin || !hasPendingUpgrade || !dataMatchesPending || now < (overview?.upgradeUnlock ?? 0)} className={`w-full mb-2 ${btnCls}`}>Execute Upgrade</button>
                <button onClick={() => simpleTx('Cancelling upgrade...', t => t.cancelUpgrade(), 'Upgrade cancelled.')} disabled={!isAdmin || !hasPendingUpgrade} className="w-full bg-red-600/80 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm">Cancel Upgrade</button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
