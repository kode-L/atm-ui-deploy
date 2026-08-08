'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { decodeError } from '@/lib/contracts/error-decoder';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { getExplorerAddressUrl } from '@/lib/contracts/config';
import ATMVoucherArtifact from '@/lib/contracts/ATMVoucher.json';
import ATMVoucherProxyArtifact from '@/lib/contracts/ATMVoucherProxy.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';
import {
  Rocket, ExternalLink, Copy, Check, RefreshCw, Ticket, Plus, Trash2, Search,
  ArrowUpCircle, ShieldCheck, KeyRound, Landmark, ListChecks, UserCheck,
  Lock, Unlock, Gift, Network, Ban, CheckCircle2, Wallet, Tag, CalendarClock,
} from 'lucide-react';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };

interface VoucherTypeRow { id: number; name: string; mintCount: string; }
interface VoucherRow {
  tokenId: number;
  faceValue: string;
  voucherType: number;
  startDate: number;
  issueDate: number;
  expiryDate: number;
  redemptionDays: number;
  redeemableFlag: boolean;
  redeemed: boolean;
  transferable: boolean;
}
interface MintBatchRow { to: string; faceValue: string; }

const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent';
const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';
const fmtAddr = (a: string) => a ? `${a.slice(0, 8)}...${a.slice(-6)}` : '—';
const isZero = (a: string) => !a || a === ethers.constants.AddressZero;
const fmtTs = (ts: number) => ts === 0 ? 'Never' : new Date(ts * 1000).toLocaleString();
const toUnix = (dtLocal: string) => dtLocal ? Math.floor(new Date(dtLocal).getTime() / 1000) : 0;
const blankMintRow = (): MintBatchRow => ({ to: '', faceValue: '' });

export default function ATMVoucherSection() {
  const { provider, signer, isConnected, address, chainId, hubAddress, atmVoucherAddress, setAtmVoucherAddress } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');

  const copyAddr = (addr: string, label: string) => {
    navigator.clipboard?.writeText?.(addr);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const AddrBadge = ({ addr, label }: { addr: string; label: string }) => (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-xs text-txt-secondary">Address:</span>
      <code className="text-xs text-accent font-mono truncate flex-1">{addr}</code>
      <button onClick={() => copyAddr(addr, label)} className="shrink-0">
        {copied === label ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-txt-secondary hover:text-txt-primary" />}
      </button>
      <a href={getExplorerAddressUrl(chainId, addr)} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="w-3.5 h-3.5 text-txt-secondary hover:text-accent" />
      </a>
    </div>
  );

  // ── Deploy / Load ──
  const [voucherName, setVoucherName] = useState('ATM Voucher');
  const [voucherSymbol, setVoucherSymbol] = useState('ATMV');
  const [deployGameHub, setDeployGameHub] = useState('');
  const [deployVoidAddress, setDeployVoidAddress] = useState('');
  const [implAddress, setImplAddress] = useState('');
  const [manualLoad, setManualLoad] = useState('');

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying ATMVoucher implementation...' });
    try {
      const factory = new ethers.ContractFactory(ATMVoucherArtifact.abi, ATMVoucherArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now deploy the proxy.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // Proxy constructor delegatecalls initialize(admin, name, symbol, gameHub, voidAddress)
  // atomically — the connected wallet becomes admin (DEFAULT_ADMIN_ROLE) and minter
  // (MINTER_ROLE), and GameHub/void-address linking (otherwise two separate setGameHub /
  // setVoidAddress transactions) happen in the same one, if provided. Both are optional —
  // leave blank to skip and set them later from Admin Controls below.
  const deployProxy = async () => {
    if (!signer || !implAddress || !address) return;
    if (deployGameHub.trim() && !ethers.utils.isAddress(deployGameHub.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid GameHub address' });
      return;
    }
    if (deployVoidAddress.trim() && !ethers.utils.isAddress(deployVoidAddress.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid void address' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Deploying proxy + initializing...' });
    try {
      const iface = new ethers.utils.Interface(ATMVoucherArtifact.abi);
      const initData = iface.encodeFunctionData('initialize', [
        address,
        voucherName.trim() || 'ATM Voucher',
        voucherSymbol.trim() || 'ATMV',
        deployGameHub.trim() || ethers.constants.AddressZero,
        deployVoidAddress.trim() || ethers.constants.AddressZero,
      ]);
      const factory = new ethers.ContractFactory(ATMVoucherProxyArtifact.abi, ATMVoucherProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress, initData);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      setAtmVoucherAddress(proxy.address);
      setTxStatus({ status: 'success', hash: proxy.deployTransaction?.hash, message: `ATMVoucher deployed at ${proxy.address}. You are admin &amp; minter — register a voucher type below before minting.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const loadExisting = () => {
    if (!ethers.utils.isAddress(manualLoad.trim())) {
      setTxStatus({ status: 'error', error: 'Invalid address' });
      return;
    }
    setAtmVoucherAddress(manualLoad.trim());
    setManualLoad('');
    setTxStatus({ status: 'idle' });
  };

  // ── Contract instances ──
  const getRead = useCallback(() => {
    if (!provider || !atmVoucherAddress) return null;
    return new ethers.Contract(atmVoucherAddress, ATMVoucherArtifact.abi, provider);
  }, [provider, atmVoucherAddress]);
  const getWrite = useCallback(() => {
    if (!signer || !atmVoucherAddress) return null;
    return new ethers.Contract(atmVoucherAddress, ATMVoucherArtifact.abi, signer);
  }, [signer, atmVoucherAddress]);

  // ── Overview ──
  const [nameStr, setNameStr] = useState('');
  const [symbolStr, setSymbolStr] = useState('');
  const [versionStr, setVersionStr] = useState('');
  const [totalSupplyVal, setTotalSupplyVal] = useState('0');
  const [linkedGameHub, setLinkedGameHub] = useState('');
  const [linkedVoidAddress, setLinkedVoidAddress] = useState('');
  const [minterRoleHash, setMinterRoleHash] = useState('');
  const [adminRoleHash, setAdminRoleHash] = useState('');
  const [isAdminConnected, setIsAdminConnected] = useState(false);
  const [isMinterConnected, setIsMinterConnected] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewLoadError, setOverviewLoadError] = useState('');

  const fetchOverview = useCallback(async () => {
    const atm = getRead();
    if (!atm) return;
    setOverviewLoading(true);
    setOverviewLoadError('');
    try {
      const labels = ['name', 'symbol', 'version', 'totalSupply', 'gameHub', 'voidAddress', 'MINTER_ROLE', 'DEFAULT_ADMIN_ROLE'];
      const results = await Promise.allSettled([
        atm.name(), atm.symbol(), atm.version(), atm.totalSupply(), atm.gameHub(), atm.voidAddress(), atm.MINTER_ROLE(), atm.DEFAULT_ADMIN_ROLE(),
      ]);
      const [nm, sym, ver, supply, hub, voidAddr, minterRole, adminRole] = results.map(r => r.status === 'fulfilled' ? r.value : undefined);
      const firstFailure = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (firstFailure) {
        const failedLabel = labels[results.indexOf(firstFailure)];
        setOverviewLoadError(`Failed to read "${failedLabel}" from ${atmVoucherAddress} — ${decodeError(firstFailure.reason)}. Double-check this address is the ATMVoucher proxy on the network your wallet is connected to.`);
      }
      if (nm !== undefined) setNameStr(nm);
      if (sym !== undefined) setSymbolStr(sym);
      if (ver !== undefined) setVersionStr(ver);
      if (supply !== undefined) setTotalSupplyVal(supply.toString());
      if (hub !== undefined) setLinkedGameHub(hub);
      if (voidAddr !== undefined) setLinkedVoidAddress(voidAddr);
      if (minterRole !== undefined) setMinterRoleHash(minterRole);
      if (adminRole !== undefined) setAdminRoleHash(adminRole);
      if (address && adminRole !== undefined && minterRole !== undefined) {
        const [isAdmin, isMinter] = await Promise.all([
          atm.hasRole(adminRole, address).catch(() => false),
          atm.hasRole(minterRole, address).catch(() => false),
        ]);
        setIsAdminConnected(!!isAdmin);
        setIsMinterConnected(!!isMinter);
      } else {
        setIsAdminConnected(false);
        setIsMinterConnected(false);
      }
    } catch (e) {
      console.error('fetch ATMVoucher overview:', e);
      setOverviewLoadError(decodeError(e));
    } finally {
      setOverviewLoading(false);
    }
  }, [getRead, address, atmVoucherAddress]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  // ── Voucher Types ──
  const [newTypeId, setNewTypeId] = useState('');
  const [newTypeName, setNewTypeName] = useState('');
  const [knownTypes, setKnownTypes] = useState<VoucherTypeRow[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);

  const fetchTypes = useCallback(async () => {
    const atm = getRead();
    if (!atm) return;
    setTypesLoading(true);
    try {
      const ids: ethers.BigNumber[] = await atm.registeredVoucherTypes();
      const rows: VoucherTypeRow[] = await Promise.all(ids.map(async (idBn) => {
        const id = idBn.toNumber();
        const [name, mintCount] = await Promise.all([atm.voucherTypeName(id), atm.typeMintCount(id)]);
        return { id, name, mintCount: mintCount.toString() };
      }));
      rows.sort((a, b) => a.id - b.id);
      setKnownTypes(rows);
    } catch (e) {
      console.error('fetch voucher types:', e);
    } finally {
      setTypesLoading(false);
    }
  }, [getRead]);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  // Types 1 ("Point") and 2 ("Reward") are auto-registered by initialize() — redeemVoucher
  // (on DailySessionManager) decides Point-vs-Reward behavior directly from a voucher's
  // voucherType id matching one of those two; any other id is rejected there, not defaulted.
  const handleRegisterType = async () => {
    const atm = getWrite();
    const typeId = parseInt(newTypeId);
    if (!atm || isNaN(typeId) || typeId < 0) {
      setTxStatus({ status: 'error', error: 'Enter a valid type ID' });
      return;
    }
    if (!newTypeName.trim()) {
      setTxStatus({ status: 'error', error: 'Enter a type name' });
      return;
    }
    setTxStatus({ status: 'pending', message: `Registering voucher type #${typeId}...` });
    try {
      const tx = await atm.registerVoucherType(typeId, newTypeName.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Voucher type #${typeId} ("${newTypeName.trim()}") registered.` });
      setNewTypeId('');
      setNewTypeName('');
      await fetchTypes();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Mint (single) ──
  const [mintTo, setMintTo] = useState('');
  const [mintFaceValue, setMintFaceValue] = useState('');
  const [mintVoucherType, setMintVoucherType] = useState('');
  const [mintStartDate, setMintStartDate] = useState('');
  const [mintExpiryDate, setMintExpiryDate] = useState('');
  const [mintNeverExpires, setMintNeverExpires] = useState(true);
  const [mintRedemptionDays, setMintRedemptionDays] = useState('1');
  const [mintTransferable, setMintTransferable] = useState(true);
  const [mintUri, setMintUri] = useState('');

  const handleMint = async () => {
    const atm = getWrite();
    if (!atm) return;
    if (!ethers.utils.isAddress(mintTo.trim())) { setTxStatus({ status: 'error', error: 'Invalid recipient address' }); return; }
    const voucherType = parseInt(mintVoucherType);
    if (isNaN(voucherType) || voucherType < 0) { setTxStatus({ status: 'error', error: 'Select a voucher type' }); return; }
    const redemptionDays = parseInt(mintRedemptionDays);
    if (isNaN(redemptionDays) || redemptionDays < 0) { setTxStatus({ status: 'error', error: 'Redemption days must be 0 or more (0 = instant)' }); return; }
    let faceValueBn: ethers.BigNumber;
    try { faceValueBn = ethers.utils.parseEther(mintFaceValue || '0'); } catch {
      setTxStatus({ status: 'error', error: 'Face value must be a number (negative for a debit voucher)' });
      return;
    }
    const startDate = toUnix(mintStartDate);
    const expiryDate = mintNeverExpires ? 0 : toUnix(mintExpiryDate);
    setTxStatus({ status: 'pending', message: 'Minting voucher...' });
    try {
      const tx = await atm.mint(mintTo.trim(), faceValueBn, voucherType, startDate, expiryDate, redemptionDays, mintTransferable, mintUri.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      const receipt = await tx.wait();
      const mintedEvent = receipt.events?.find((e: any) => e.event === 'VoucherMinted');
      const tokenId = mintedEvent?.args?.tokenId?.toString();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Voucher minted${tokenId ? ` — token #${tokenId}` : ''} to ${mintTo.trim()}.` });
      setMintTo(''); setMintFaceValue(''); setMintUri('');
      await fetchTypes();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Mint Batch ──
  const [batchRows, setBatchRows] = useState<MintBatchRow[]>([blankMintRow()]);
  const [batchVoucherType, setBatchVoucherType] = useState('');
  const [batchStartDate, setBatchStartDate] = useState('');
  const [batchExpiryDate, setBatchExpiryDate] = useState('');
  const [batchNeverExpires, setBatchNeverExpires] = useState(true);
  const [batchRedemptionDays, setBatchRedemptionDays] = useState('1');
  const [batchTransferable, setBatchTransferable] = useState(true);
  const [batchUri, setBatchUri] = useState('');

  const updateBatchRow = (i: number, field: keyof MintBatchRow, v: string) => setBatchRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: v } : r));
  const addBatchRow = () => setBatchRows(prev => [...prev, blankMintRow()]);
  const removeBatchRow = (i: number) => setBatchRows(prev => prev.filter((_, idx) => idx !== i));

  const handleMintBatch = async () => {
    const atm = getWrite();
    if (!atm) return;
    const voucherType = parseInt(batchVoucherType);
    if (isNaN(voucherType) || voucherType < 0) { setTxStatus({ status: 'error', error: 'Select a voucher type' }); return; }
    const redemptionDays = parseInt(batchRedemptionDays);
    if (isNaN(redemptionDays) || redemptionDays < 0) { setTxStatus({ status: 'error', error: 'Redemption days must be 0 or more (0 = instant)' }); return; }
    const to = batchRows.map(r => r.to.trim());
    let faceValues: ethers.BigNumber[];
    try { faceValues = batchRows.map(r => ethers.utils.parseEther(r.faceValue || '0')); } catch {
      setTxStatus({ status: 'error', error: 'Every face value must be a number' });
      return;
    }
    for (let i = 0; i < to.length; i++) {
      if (!ethers.utils.isAddress(to[i])) { setTxStatus({ status: 'error', error: `Invalid address in row ${i + 1}` }); return; }
    }
    const startDate = toUnix(batchStartDate);
    const expiryDate = batchNeverExpires ? 0 : toUnix(batchExpiryDate);
    setTxStatus({ status: 'pending', message: `Minting ${to.length} voucher(s)...` });
    try {
      const tx = await atm.mintBatch(to, faceValues, voucherType, startDate, expiryDate, redemptionDays, batchTransferable, batchUri.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${to.length} voucher(s) minted.` });
      setBatchRows([blankMintRow()]);
      await fetchTypes();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── My Vouchers / Owner Lookup ──
  const PAGE_SIZE = 10;
  const [lookupOwner, setLookupOwner] = useState('');
  const [ownerVouchers, setOwnerVouchers] = useState<VoucherRow[]>([]);
  const [ownerOffset, setOwnerOffset] = useState(0);
  const [ownerVouchersLoading, setOwnerVouchersLoading] = useState(false);

  useEffect(() => { if (address && !lookupOwner) setLookupOwner(address); }, [address, lookupOwner]);

  const parseVoucherRows = (tokenIds: ethers.BigNumber[], metadata: any[]): VoucherRow[] =>
    tokenIds.map((idBn, i) => {
      const m = metadata[i];
      return {
        tokenId: idBn.toNumber(),
        faceValue: ethers.utils.formatEther(m.faceValue),
        voucherType: m.voucherType.toNumber(),
        startDate: m.startDate.toNumber(),
        issueDate: m.issueDate.toNumber(),
        expiryDate: m.expiryDate.toNumber(),
        redemptionDays: m.redemptionDays.toNumber(),
        redeemableFlag: m.redeemableFlag,
        redeemed: m.redeemed,
        transferable: m.transferable,
      };
    });

  const fetchOwnerVouchers = useCallback(async (offsetOverride?: number) => {
    const atm = getRead();
    if (!atm || !ethers.utils.isAddress(lookupOwner.trim())) return;
    const offset = offsetOverride ?? ownerOffset;
    setOwnerVouchersLoading(true);
    try {
      const [tokenIds, metadata] = await atm.vouchersOfOwner(lookupOwner.trim(), offset, PAGE_SIZE);
      setOwnerVouchers(parseVoucherRows(tokenIds, metadata));
      setOwnerOffset(offset);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setOwnerVouchersLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getRead, lookupOwner]);

  useEffect(() => { if (lookupOwner) fetchOwnerVouchers(0); }, [lookupOwner]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Token Lookup & Redeem ──
  const [lookupTokenId, setLookupTokenId] = useState('');
  const [tokenDetail, setTokenDetail] = useState<{ owner: string; row: VoucherRow; isRedeemableNow: boolean; isExpired: boolean; isVoided: boolean } | null>(null);
  const [tokenLookupError, setTokenLookupError] = useState('');

  const handleLookupToken = async () => {
    const atm = getRead();
    const tokenId = parseInt(lookupTokenId);
    if (!atm || isNaN(tokenId) || tokenId < 1) { setTokenLookupError('Enter a valid token ID'); return; }
    setTokenLookupError('');
    setTokenDetail(null);
    try {
      const [owner, metadata, redeemableNow, expired, voided] = await Promise.all([
        atm.ownerOf(tokenId), atm.voucherOf(tokenId), atm.isRedeemableNow(tokenId), atm.isExpired(tokenId), atm.isVoided(tokenId),
      ]);
      const [row] = parseVoucherRows([ethers.BigNumber.from(tokenId)], [metadata]);
      setTokenDetail({ owner, row, isRedeemableNow: redeemableNow, isExpired: expired, isVoided: voided });
    } catch (e: any) {
      setTokenLookupError(decodeError(e));
    }
  };

  const handleRedeem = async () => {
    const atm = getWrite();
    const tokenId = parseInt(lookupTokenId);
    if (!atm || isNaN(tokenId) || tokenId < 1) return;
    setTxStatus({ status: 'pending', message: `Redeeming voucher #${tokenId}...` });
    try {
      const tx = await atm.redeem(tokenId);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Voucher #${tokenId} redeemed.` });
      await handleLookupToken();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleSendToVoid = async () => {
    const atm = getWrite();
    const tokenId = parseInt(lookupTokenId);
    if (!atm || isNaN(tokenId) || tokenId < 1) return;
    setTxStatus({ status: 'pending', message: `Sending voucher #${tokenId} to void...` });
    try {
      const tx = await atm.sendToVoid(tokenId);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Voucher #${tokenId} sent to void. It still shows up in the original holder's Vouchers by Owner list as claim history.` });
      await handleLookupToken();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Admin: Redeemable kill-switch, Type URI, GameHub link ──
  const [srTokenId, setSrTokenId] = useState('');
  const [srFlag, setSrFlag] = useState(true);

  const handleSetRedeemable = async () => {
    const atm = getWrite();
    const tokenId = parseInt(srTokenId);
    if (!atm || isNaN(tokenId) || tokenId < 1) { setTxStatus({ status: 'error', error: 'Enter a valid token ID' }); return; }
    setTxStatus({ status: 'pending', message: `${srFlag ? 'Enabling' : 'Disabling'} redemption for #${tokenId}...` });
    try {
      const tx = await atm.setRedeemable(tokenId, srFlag);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Voucher #${tokenId} redeemable flag set to ${srFlag}.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const [typeUriId, setTypeUriId] = useState('');
  const [typeUriValue, setTypeUriValue] = useState('');

  const handleSetTypeURI = async () => {
    const atm = getWrite();
    const typeId = parseInt(typeUriId);
    if (!atm || isNaN(typeId) || typeId < 0) { setTxStatus({ status: 'error', error: 'Enter a valid type ID' }); return; }
    setTxStatus({ status: 'pending', message: `Setting default URI for type #${typeId}...` });
    try {
      const tx = await atm.setTypeURI(typeId, typeUriValue.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Default URI for type #${typeId} updated.` });
      setTypeUriValue('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const [gameHubInput, setGameHubInput] = useState('');

  const handleSetGameHub = async () => {
    const atm = getWrite();
    if (!atm || !ethers.utils.isAddress(gameHubInput.trim())) { setTxStatus({ status: 'error', error: 'Invalid GameHub address' }); return; }
    setTxStatus({ status: 'pending', message: 'Linking GameHub...' });
    try {
      const tx = await atm.setGameHub(gameHubInput.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `GameHub linked — any of its registered operator instances can now call redeemFor().` });
      setGameHubInput('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const [voidAddressInput, setVoidAddressInput] = useState('');

  const handleSetVoidAddress = async () => {
    const atm = getWrite();
    if (!atm || !ethers.utils.isAddress(voidAddressInput.trim())) { setTxStatus({ status: 'error', error: 'Invalid void address' }); return; }
    setTxStatus({ status: 'pending', message: 'Setting void address...' });
    try {
      const tx = await atm.setVoidAddress(voidAddressInput.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Void address set — sendToVoid() and redeemFor()'s auto-void now reach it.` });
      setVoidAddressInput('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Roles ──
  const [minterAddrInput, setMinterAddrInput] = useState('');
  const [adminAddrInput, setAdminAddrInput] = useState('');
  const [roleCheckAddr, setRoleCheckAddr] = useState('');
  const [roleCheckResult, setRoleCheckResult] = useState<{ isAdmin: boolean; isMinter: boolean } | null>(null);

  const handleRole = async (role: 'minter' | 'admin', grant: boolean, addrInput: string, setAddrInput: (v: string) => void) => {
    const atm = getWrite();
    const roleHash = role === 'minter' ? minterRoleHash : adminRoleHash;
    if (!atm || !roleHash || !ethers.utils.isAddress(addrInput.trim())) { setTxStatus({ status: 'error', error: 'Invalid address' }); return; }
    setTxStatus({ status: 'pending', message: `${grant ? 'Granting' : 'Revoking'} ${role} role...` });
    try {
      const tx = grant ? await atm.grantRole(roleHash, addrInput.trim()) : await atm.revokeRole(roleHash, addrInput.trim());
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `${role === 'minter' ? 'Minter' : 'Admin'} role ${grant ? 'granted to' : 'revoked from'} ${addrInput.trim()}.` });
      setAddrInput('');
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleCheckRoles = async () => {
    const atm = getRead();
    if (!atm || !ethers.utils.isAddress(roleCheckAddr.trim()) || !minterRoleHash || !adminRoleHash) return;
    try {
      const [isMinter, isAdmin] = await Promise.all([
        atm.hasRole(minterRoleHash, roleCheckAddr.trim()),
        atm.hasRole(adminRoleHash, roleCheckAddr.trim()),
      ]);
      setRoleCheckResult({ isAdmin, isMinter });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Redeemed Feed ──
  const [feedDateKey, setFeedDateKey] = useState('');
  const [feedOffset, setFeedOffset] = useState(0);
  const [feedRows, setFeedRows] = useState<VoucherRow[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedTotal, setFeedTotal] = useState(0);

  const fetchCurrentDateKey = useCallback(async () => {
    const atm = getRead();
    if (!atm) return;
    try {
      const dk = await atm.currentDateKey();
      setFeedDateKey(prev => prev || dk.toString());
    } catch { /* not loaded yet */ }
  }, [getRead]);

  useEffect(() => { fetchCurrentDateKey(); }, [fetchCurrentDateKey]);

  const fetchRedeemedFeed = useCallback(async (offsetOverride?: number) => {
    const atm = getRead();
    const dateKey = parseInt(feedDateKey);
    if (!atm || isNaN(dateKey) || dateKey < 0) return;
    const offset = offsetOverride ?? feedOffset;
    setFeedLoading(true);
    try {
      const [count, [tokenIds, metadata]] = await Promise.all([
        atm.redeemedCountOnDay(dateKey),
        atm.redeemedOnDay(dateKey, offset, PAGE_SIZE),
      ]);
      setFeedTotal(count.toNumber());
      setFeedRows(parseVoucherRows(tokenIds, metadata));
      setFeedOffset(offset);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setFeedLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getRead, feedDateKey]);

  // ── All Vouchers (admin) ──
  const [allOffset, setAllOffset] = useState(0);
  const [allRows, setAllRows] = useState<VoucherRow[]>([]);
  const [allLoading, setAllLoading] = useState(false);

  const fetchAllVouchers = useCallback(async (offsetOverride?: number) => {
    const atm = getRead();
    if (!atm) return;
    const offset = offsetOverride ?? allOffset;
    setAllLoading(true);
    try {
      const [tokenIds, metadata] = await atm.allVouchers(offset, PAGE_SIZE);
      setAllRows(parseVoucherRows(tokenIds, metadata));
      setAllOffset(offset);
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    } finally {
      setAllLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getRead]);

  // ── GameHub Integration ──
  const getHubRead = useCallback(() => {
    if (!provider || !hubAddress) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, provider);
  }, [provider, hubAddress]);
  const getHubWrite = useCallback(() => {
    if (!signer || !hubAddress) return null;
    return new ethers.Contract(hubAddress, GameHubArtifact.abi, signer);
  }, [signer, hubAddress]);

  const [hubAtmVoucher, setHubAtmVoucher] = useState('');
  const [hubLinkLoading, setHubLinkLoading] = useState(false);

  const fetchHubLink = useCallback(async () => {
    const hub = getHubRead();
    if (!hub) return;
    setHubLinkLoading(true);
    try {
      const addr = await hub.atmVoucher();
      setHubAtmVoucher(addr);
    } catch {
      setHubAtmVoucher('');
    } finally {
      setHubLinkLoading(false);
    }
  }, [getHubRead]);

  useEffect(() => { fetchHubLink(); }, [fetchHubLink]);

  const handleSetHubAtmVoucher = async () => {
    const hub = getHubWrite();
    if (!hub || !atmVoucherAddress) return;
    setTxStatus({ status: 'pending', message: "Setting hub's ATM Voucher..." });
    try {
      const tx = await hub.setATMVoucher(atmVoucherAddress);
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `GameHub now points at ${atmVoucherAddress}.` });
      await fetchHubLink();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Upgrade (UUPS) ──
  const [newImplAddress, setNewImplAddress] = useState('');
  const [newImplVersion, setNewImplVersion] = useState('');

  useEffect(() => {
    if (!provider || !newImplAddress || !ethers.utils.isAddress(newImplAddress)) {
      setNewImplVersion('');
      return;
    }
    let cancelled = false;
    const impl = new ethers.Contract(newImplAddress, ATMVoucherArtifact.abi, provider);
    impl.version()
      .then((v: string) => { if (!cancelled) setNewImplVersion(v); })
      .catch(() => { if (!cancelled) setNewImplVersion('unreadable'); });
    return () => { cancelled = true; };
  }, [provider, newImplAddress]);

  const deployNewImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying new implementation...' });
    try {
      const factory = new ethers.ContractFactory(ATMVoucherArtifact.abi, ATMVoucherArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setNewImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `New implementation deployed at ${impl.address}. Now upgrade.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const handleUpgrade = async () => {
    const atm = getWrite();
    if (!atm || !ethers.utils.isAddress(newImplAddress)) return;
    setTxStatus({ status: 'pending', message: 'Checking upgrade...' });
    try {
      await atm.callStatic.upgradeToAndCall(newImplAddress, '0x');
      setTxStatus({ status: 'pending', message: 'Upgrading implementation...' });
      const tx = await atm.upgradeToAndCall(newImplAddress, '0x');
      setTxStatus({ status: 'pending', hash: tx.hash, message: 'Waiting for confirmation...' });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Upgraded to ${newImplAddress}.` });
      setNewImplAddress('');
      await fetchOverview();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const VoucherTable = ({ rows }: { rows: VoucherRow[] }) => (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-txt-secondary text-left border-b border-white/10">
            <th className="py-1.5 pr-3">ID</th>
            <th className="py-1.5 pr-3">Type</th>
            <th className="py-1.5 pr-3">Face Value</th>
            <th className="py-1.5 pr-3">Start</th>
            <th className="py-1.5 pr-3">Expiry</th>
            <th className="py-1.5 pr-3">Days</th>
            <th className="py-1.5 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.tokenId} className="border-b border-white/5">
              <td className="py-1.5 pr-3 font-mono">#{r.tokenId}</td>
              <td className="py-1.5 pr-3">{r.voucherType}</td>
              <td className={`py-1.5 pr-3 font-mono ${r.faceValue.startsWith('-') ? 'text-red-400' : 'text-green-400'}`}>{r.faceValue}</td>
              <td className="py-1.5 pr-3">{fmtTs(r.startDate)}</td>
              <td className="py-1.5 pr-3">{fmtTs(r.expiryDate)}</td>
              <td className="py-1.5 pr-3">{r.redemptionDays}</td>
              <td className="py-1.5 pr-3">
                {r.redeemed ? <span className="text-txt-secondary">Redeemed</span> : r.redeemableFlag ? <span className="text-green-400">Live</span> : <span className="text-red-400">Blocked</span>}
                {!r.transferable && <span className="ml-1 text-yellow-400" title="Non-transferable">🔒</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-txt-secondary">No vouchers.</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <TxStatus {...txStatus} chainId={chainId} />

      {/* ── Deploy / Load ── */}
      <Card title="Deploy ATM Voucher" icon={<Rocket className="w-5 h-5 text-accent" />}>
        <p className="text-txt-secondary text-sm mb-4">
          Upgradeable ERC-721 voucher contract. Each token carries a face value (credit or debit), a validity window, and a redemption flag — standalone from the GameHub fleet unless you link it below.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">1. Implementation</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the ATMVoucher logic contract (constructor disables direct initialization).</p>
            <button onClick={deployImplementation} disabled={!isConnected} className={`w-full ${btnCls}`}>Deploy Implementation</button>
            {implAddress && <AddrBadge addr={implAddress} label="impl" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">2. Proxy</h4>
            <p className="text-xs text-txt-secondary mb-3">Deploys the proxy and atomically initializes it — your connected wallet becomes admin &amp; minter.</p>
            <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="Implementation address (step 1, or paste one)" className={`${inputCls} mb-2`} />
            <input value={voucherName} onChange={e => setVoucherName(e.target.value)} placeholder="Name (e.g. ATM Voucher)" className={`${inputCls} mb-2`} />
            <input value={voucherSymbol} onChange={e => setVoucherSymbol(e.target.value)} placeholder="Symbol (e.g. ATMV)" className={`${inputCls} mb-2`} />
            <input value={deployGameHub} onChange={e => setDeployGameHub(e.target.value)} placeholder="GameHub address (optional — skips a later setGameHub tx)" className={`${inputCls} mb-2`} />
            <input value={deployVoidAddress} onChange={e => setDeployVoidAddress(e.target.value)} placeholder="Void address (optional — skips a later setVoidAddress tx)" className={`${inputCls} mb-3`} />
            <button onClick={deployProxy} disabled={!isConnected || !implAddress} className={`w-full ${btnCls}`}>Deploy Proxy</button>
            {atmVoucherAddress && <AddrBadge addr={atmVoucherAddress} label="proxy" />}
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <h4 className="font-medium mb-2">Load Existing</h4>
            <p className="text-xs text-txt-secondary mb-3">Already deployed? Paste the proxy address to load it.</p>
            <input value={manualLoad} onChange={e => setManualLoad(e.target.value)} placeholder="0x... proxy address" className={`${inputCls} mb-3`} />
            <button onClick={loadExisting} className="w-full bg-surface-secondary hover:bg-surface-tertiary/80 border border-accent/30 text-accent font-medium py-2.5 rounded-lg text-sm transition-colors">Load Address</button>
          </div>
        </div>
      </Card>

      {!atmVoucherAddress ? (
        <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load an ATMVoucher to manage types, mint &amp; redeem vouchers.</p></Card>
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
          } icon={<Ticket className="w-5 h-5 text-accent" />}>
            {overviewLoadError && (
              <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 mb-3">
                <p className="text-red-300 text-xs">{overviewLoadError}</p>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
              <div>
                <p className="text-xs text-txt-secondary">Name / Symbol</p>
                <p className="text-sm font-bold text-txt-primary">{nameStr || '—'} <span className="text-txt-secondary text-xs">{symbolStr}</span></p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Version</p>
                <p className="text-sm font-bold text-accent">{versionStr || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Total Supply</p>
                <p className="text-sm font-bold text-accent">{totalSupplyVal}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Linked GameHub</p>
                <p className="text-xs font-mono text-txt-primary break-all">{isZero(linkedGameHub) ? 'Not linked' : fmtAddr(linkedGameHub)}</p>
              </div>
              <div>
                <p className="text-xs text-txt-secondary">Void Address</p>
                <p className="text-xs font-mono text-txt-primary break-all">{isZero(linkedVoidAddress) ? 'Not set — sendToVoid() will revert' : fmtAddr(linkedVoidAddress)}</p>
              </div>
            </div>
            {isConnected && (
              <p className="text-xs">
                Your wallet is: {isAdminConnected && <span className="text-yellow-400 font-medium">Admin </span>}
                {isMinterConnected && <span className="text-accent font-medium">Minter </span>}
                {!isAdminConnected && !isMinterConnected && <span className="text-txt-secondary">not an admin or minter</span>}
              </p>
            )}
          </Card>

          {/* ── Voucher Types ── */}
          <Card title="Voucher Types" icon={<Tag className="w-5 h-5 text-accent" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — registering a type will revert.</p>}
            <p className="text-xs text-txt-secondary mb-3">
              Types 1 (&quot;Point&quot;) and 2 (&quot;Reward&quot;) are auto-registered when this contract is deployed — redeemVoucher on DailySessionManager decides behavior directly from whichever of those two ids a voucher uses. Register additional types freely for vouchers redeemed via plain redeem() instead.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <input value={newTypeId} onChange={e => setNewTypeId(e.target.value)} placeholder="Type ID" type="number" min={0} className={`${inputCls} sm:w-32`} />
              <input value={newTypeName} onChange={e => setNewTypeName(e.target.value)} placeholder="Type name (e.g. Welcome Bonus)" className={inputCls} />
              <button onClick={handleRegisterType} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Register / Rename</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-secondary text-left border-b border-white/10">
                    <th className="py-1.5 pr-3">ID</th><th className="py-1.5 pr-3">Name</th><th className="py-1.5 pr-3">Minted</th>
                  </tr>
                </thead>
                <tbody>
                  {knownTypes.map(t => (
                    <tr key={t.id} className="border-b border-white/5">
                      <td className="py-1.5 pr-3 font-mono">{t.id}</td>
                      <td className="py-1.5 pr-3">{t.name}</td>
                      <td className="py-1.5 pr-3">{t.mintCount}</td>
                    </tr>
                  ))}
                  {knownTypes.length === 0 && <tr><td colSpan={3} className="py-3 text-center text-txt-secondary">{typesLoading ? 'Loading...' : 'No voucher types registered yet.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Mint ── */}
          <Card title="Mint Voucher" icon={<Gift className="w-5 h-5 text-accent" />}>
            {!isMinterConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet doesn&apos;t have MINTER_ROLE — minting will revert.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input value={mintTo} onChange={e => setMintTo(e.target.value)} placeholder="0x... recipient" className={inputCls} />
              <input value={mintFaceValue} onChange={e => setMintFaceValue(e.target.value)} placeholder="Face value (e.g. 50 or -50 for a debit)" className={inputCls} />
              <select value={mintVoucherType} onChange={e => setMintVoucherType(e.target.value)} className={inputCls}>
                <option value="">Select voucher type...</option>
                {knownTypes.map(t => <option key={t.id} value={t.id}>#{t.id} — {t.name}</option>)}
              </select>
              <input value={mintRedemptionDays} onChange={e => setMintRedemptionDays(e.target.value)} placeholder="Redemption days (0 = instant)" type="number" min={0} className={inputCls} />
              <div>
                <label className="text-xs text-txt-secondary">Start Date</label>
                <input value={mintStartDate} onChange={e => setMintStartDate(e.target.value)} type="datetime-local" className={`${inputCls} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary flex items-center gap-2">
                  Expiry Date
                  <span className="flex items-center gap-1 ml-auto">
                    <input type="checkbox" checked={mintNeverExpires} onChange={e => setMintNeverExpires(e.target.checked)} className="w-3.5 h-3.5 accent-accent" /> Never
                  </span>
                </label>
                <input value={mintExpiryDate} onChange={e => setMintExpiryDate(e.target.value)} type="datetime-local" disabled={mintNeverExpires} className={`${inputCls} mt-1 disabled:opacity-40`} />
              </div>
              <input value={mintUri} onChange={e => setMintUri(e.target.value)} placeholder="Per-token URI (optional — falls back to type default)" className={inputCls} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={mintTransferable} onChange={e => setMintTransferable(e.target.checked)} className="w-4 h-4 accent-accent" /> Transferable
              </label>
            </div>
            <button onClick={handleMint} disabled={!isMinterConnected} className={`w-full mt-4 ${btnCls}`}>Mint Voucher</button>
          </Card>

          {/* ── Mint Batch ── */}
          <Card title="Mint Batch" icon={<Landmark className="w-5 h-5 text-accent" />}>
            <p className="text-xs text-txt-secondary mb-3">One voucher per recipient/face-value pair, sharing the type &amp; terms below.</p>
            <div className="space-y-2 mb-3">
              <div className="grid grid-cols-[1fr_140px_40px] gap-2 text-xs text-txt-secondary font-semibold px-1">
                <span>Recipient</span><span>Face Value</span><span></span>
              </div>
              {batchRows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_40px] gap-2 items-center">
                  <input value={r.to} onChange={e => updateBatchRow(i, 'to', e.target.value)} placeholder="0x..." className={inputCls} />
                  <input value={r.faceValue} onChange={e => updateBatchRow(i, 'faceValue', e.target.value)} placeholder="50" className={inputCls} />
                  {batchRows.length > 1 ? (
                    <button onClick={() => removeBatchRow(i)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400"><Trash2 className="w-4 h-4" /></button>
                  ) : <div />}
                </div>
              ))}
              <button onClick={addBatchRow} className="flex items-center gap-1 text-xs text-accent hover:underline mt-1">
                <Plus className="w-3.5 h-3.5" /> Add recipient
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select value={batchVoucherType} onChange={e => setBatchVoucherType(e.target.value)} className={inputCls}>
                <option value="">Select voucher type...</option>
                {knownTypes.map(t => <option key={t.id} value={t.id}>#{t.id} — {t.name}</option>)}
              </select>
              <input value={batchRedemptionDays} onChange={e => setBatchRedemptionDays(e.target.value)} placeholder="Redemption days (0 = instant)" type="number" min={0} className={inputCls} />
              <div>
                <label className="text-xs text-txt-secondary">Start Date</label>
                <input value={batchStartDate} onChange={e => setBatchStartDate(e.target.value)} type="datetime-local" className={`${inputCls} mt-1`} />
              </div>
              <div>
                <label className="text-xs text-txt-secondary flex items-center gap-2">
                  Expiry Date
                  <span className="flex items-center gap-1 ml-auto">
                    <input type="checkbox" checked={batchNeverExpires} onChange={e => setBatchNeverExpires(e.target.checked)} className="w-3.5 h-3.5 accent-accent" /> Never
                  </span>
                </label>
                <input value={batchExpiryDate} onChange={e => setBatchExpiryDate(e.target.value)} type="datetime-local" disabled={batchNeverExpires} className={`${inputCls} mt-1 disabled:opacity-40`} />
              </div>
              <input value={batchUri} onChange={e => setBatchUri(e.target.value)} placeholder="Shared URI (optional)" className={inputCls} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={batchTransferable} onChange={e => setBatchTransferable(e.target.checked)} className="w-4 h-4 accent-accent" /> Transferable
              </label>
            </div>
            <button onClick={handleMintBatch} disabled={!isMinterConnected} className={`w-full mt-4 ${btnCls}`}>Mint Batch</button>
          </Card>

          {/* ── My Vouchers / Owner Lookup ── */}
          <Card title="Vouchers by Owner" icon={<Wallet className="w-5 h-5 text-accent" />}>
            <div className="flex gap-2 mb-3">
              <input value={lookupOwner} onChange={e => setLookupOwner(e.target.value)} placeholder="0x... owner (defaults to your wallet)" className={inputCls} />
              <button onClick={() => fetchOwnerVouchers(0)} className={`shrink-0 px-4 ${btnCls}`}><Search className="w-4 h-4" /></button>
            </div>
            <VoucherTable rows={ownerVouchers} />
            <div className="flex justify-between items-center mt-2">
              <button onClick={() => fetchOwnerVouchers(Math.max(0, ownerOffset - PAGE_SIZE))} disabled={ownerOffset === 0 || ownerVouchersLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">&larr; Prev</button>
              <span className="text-xs text-txt-secondary">Offset {ownerOffset}</span>
              <button onClick={() => fetchOwnerVouchers(ownerOffset + PAGE_SIZE)} disabled={ownerVouchers.length < PAGE_SIZE || ownerVouchersLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">Next &rarr;</button>
            </div>
          </Card>

          {/* ── Token Lookup & Redeem ── */}
          <Card title="Voucher Lookup &amp; Redeem" icon={<Search className="w-5 h-5 text-accent" />}>
            <div className="flex gap-2 mb-3">
              <input value={lookupTokenId} onChange={e => setLookupTokenId(e.target.value)} placeholder="Token ID" type="number" min={1} className={`${inputCls} max-w-[160px]`} />
              <button onClick={handleLookupToken} className={`shrink-0 px-4 ${btnCls}`}>Lookup</button>
            </div>
            {tokenLookupError && <p className="text-xs text-red-400 mb-2">{tokenLookupError}</p>}
            {tokenDetail && (
              <div className="bg-surface-tertiary rounded-lg p-4 space-y-2 text-sm">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div><p className="text-xs text-txt-secondary">Owner</p><p className="font-mono text-xs break-all">{tokenDetail.owner}</p></div>
                  <div><p className="text-xs text-txt-secondary">Type</p><p>{tokenDetail.row.voucherType}</p></div>
                  <div><p className="text-xs text-txt-secondary">Face Value</p><p className={tokenDetail.row.faceValue.startsWith('-') ? 'text-red-400' : 'text-green-400'}>{tokenDetail.row.faceValue}</p></div>
                  <div><p className="text-xs text-txt-secondary">Start</p><p>{fmtTs(tokenDetail.row.startDate)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Expiry</p><p>{fmtTs(tokenDetail.row.expiryDate)}</p></div>
                  <div><p className="text-xs text-txt-secondary">Redemption Days</p><p>{tokenDetail.row.redemptionDays}</p></div>
                </div>
                <div className="flex items-center gap-3 flex-wrap pt-1">
                  <span className={`text-xs flex items-center gap-1 ${tokenDetail.row.redeemed ? 'text-txt-secondary' : tokenDetail.isRedeemableNow ? 'text-green-400' : 'text-red-400'}`}>
                    {tokenDetail.row.redeemed ? <><CheckCircle2 className="w-3.5 h-3.5" /> Redeemed</> : tokenDetail.isRedeemableNow ? <><Unlock className="w-3.5 h-3.5" /> Redeemable now</> : <><Ban className="w-3.5 h-3.5" /> Not redeemable</>}
                  </span>
                  {tokenDetail.isExpired && <span className="text-xs text-red-400">Expired</span>}
                  {!tokenDetail.row.transferable && <span className="text-xs text-yellow-400">Non-transferable</span>}
                  {tokenDetail.isVoided && <span className="text-xs text-purple-400 flex items-center gap-1"><Ban className="w-3.5 h-3.5" /> Voided</span>}
                  <button
                    onClick={handleRedeem}
                    disabled={tokenDetail.row.redeemed || !tokenDetail.isRedeemableNow || tokenDetail.owner.toLowerCase() !== address?.toLowerCase()}
                    className="ml-auto bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-1.5 rounded-lg text-xs transition-colors"
                  >
                    Redeem
                  </button>
                  <button
                    onClick={handleSendToVoid}
                    disabled={tokenDetail.isVoided || isZero(linkedVoidAddress) || tokenDetail.owner.toLowerCase() !== address?.toLowerCase()}
                    title={isZero(linkedVoidAddress) ? 'Set a void address in Admin Controls first' : undefined}
                    className="bg-surface-secondary hover:bg-surface-tertiary/80 disabled:opacity-40 disabled:cursor-not-allowed border border-purple-400/30 text-purple-300 font-semibold px-4 py-1.5 rounded-lg text-xs transition-colors"
                  >
                    Send to Void
                  </button>
                </div>
                {tokenDetail.owner.toLowerCase() !== address?.toLowerCase() && (
                  <p className="text-[10px] text-txt-secondary">Only the current owner (or an approved address, via a direct contract call) can redeem or void this voucher.</p>
                )}
                <p className="text-[10px] text-txt-secondary">Sending to void works even on a redeemed or non-transferable voucher, and the voucher keeps showing up in the original holder&apos;s Vouchers by Owner list as claim history — only ownerOf() moves.</p>
              </div>
            )}
          </Card>

          {/* ── Admin ── */}
          <Card title="Admin Controls" icon={<ShieldCheck className="w-5 h-5 text-yellow-400" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — these actions will revert.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-txt-secondary">Redeemable Kill-Switch (recall a voucher)</label>
                <div className="flex gap-2 mt-1">
                  <input value={srTokenId} onChange={e => setSrTokenId(e.target.value)} placeholder="Token ID" type="number" min={1} className={inputCls} />
                  <select value={srFlag ? '1' : '0'} onChange={e => setSrFlag(e.target.value === '1')} className={`${inputCls} max-w-[120px]`}>
                    <option value="1">Enable</option>
                    <option value="0">Disable</option>
                  </select>
                  <button onClick={handleSetRedeemable} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Default Type URI</label>
                <div className="flex gap-2 mt-1">
                  <input value={typeUriId} onChange={e => setTypeUriId(e.target.value)} placeholder="Type ID" type="number" min={0} className={`${inputCls} max-w-[100px]`} />
                  <input value={typeUriValue} onChange={e => setTypeUriValue(e.target.value)} placeholder="ipfs://..." className={inputCls} />
                  <button onClick={handleSetTypeURI} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-txt-secondary">
                  Link GameHub ({isZero(linkedGameHub) ? 'not linked — redeemFor() will revert' : `currently ${fmtAddr(linkedGameHub)}`}) — lets any of that hub&apos;s registered operator instances call redeemFor() on a holder&apos;s behalf
                </label>
                <div className="flex gap-2 mt-1">
                  <input value={gameHubInput} onChange={e => setGameHubInput(e.target.value)} placeholder={hubAddress || '0x... GameHub proxy'} className={inputCls} />
                  <button onClick={() => setGameHubInput(hubAddress)} disabled={!hubAddress} className="shrink-0 px-3 bg-surface-tertiary border border-white/10 rounded-lg text-xs text-txt-secondary hover:text-txt-primary">Use loaded Hub</button>
                  <button onClick={handleSetGameHub} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-txt-secondary">
                  Void Address ({isZero(linkedVoidAddress) ? 'not set — sendToVoid() will revert' : `currently ${fmtAddr(linkedVoidAddress)}`}) — the one destination a redeemed or non-transferable voucher can still move to, via sendToVoid() or redeemFor()&apos;s auto-void
                </label>
                <div className="flex gap-2 mt-1">
                  <input value={voidAddressInput} onChange={e => setVoidAddressInput(e.target.value)} placeholder="0x... void/burn destination" className={inputCls} />
                  <button onClick={handleSetVoidAddress} disabled={!isAdminConnected} className={`shrink-0 px-4 ${btnCls}`}>Set</button>
                </div>
              </div>
            </div>
          </Card>

          {/* ── Roles ── */}
          <Card title="Roles" icon={<KeyRound className="w-5 h-5 text-yellow-400" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — granting/revoking roles will revert.</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="text-xs text-txt-secondary">Minter Role (required to mint)</label>
                <div className="flex gap-2 mt-1">
                  <input value={minterAddrInput} onChange={e => setMinterAddrInput(e.target.value)} placeholder="0x..." className={inputCls} />
                  <button onClick={() => handleRole('minter', true, minterAddrInput, setMinterAddrInput)} disabled={!isAdminConnected} className="shrink-0 px-3 bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold rounded-lg text-xs">Grant</button>
                  <button onClick={() => handleRole('minter', false, minterAddrInput, setMinterAddrInput)} disabled={!isAdminConnected} className="shrink-0 px-3 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white font-semibold rounded-lg text-xs">Revoke</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-txt-secondary">Admin Role (DEFAULT_ADMIN_ROLE — full control)</label>
                <div className="flex gap-2 mt-1">
                  <input value={adminAddrInput} onChange={e => setAdminAddrInput(e.target.value)} placeholder="0x..." className={inputCls} />
                  <button onClick={() => handleRole('admin', true, adminAddrInput, setAdminAddrInput)} disabled={!isAdminConnected} className="shrink-0 px-3 bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold rounded-lg text-xs">Grant</button>
                  <button onClick={() => handleRole('admin', false, adminAddrInput, setAdminAddrInput)} disabled={!isAdminConnected} className="shrink-0 px-3 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white font-semibold rounded-lg text-xs">Revoke</button>
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
                  {roleCheckResult.isMinter && <span className="text-accent font-medium mr-2">Minter</span>}
                  {!roleCheckResult.isAdmin && !roleCheckResult.isMinter && <span className="text-txt-secondary">Neither admin nor minter</span>}
                </p>
              )}
            </div>
          </Card>

          {/* ── Redeemed Feed ── */}
          <Card title="Redeemed Feed" icon={<CalendarClock className="w-5 h-5 text-accent" />}>
            <div className="flex gap-2 mb-3">
              <input value={feedDateKey} onChange={e => setFeedDateKey(e.target.value)} placeholder="Date key (UTC day)" type="number" min={0} className={`${inputCls} max-w-[200px]`} />
              <button onClick={() => fetchRedeemedFeed(0)} className={`shrink-0 px-4 ${btnCls}`}>Load</button>
              <span className="text-xs text-txt-secondary self-center">{feedTotal} redeemed that day</span>
            </div>
            <VoucherTable rows={feedRows} />
            <div className="flex justify-between items-center mt-2">
              <button onClick={() => fetchRedeemedFeed(Math.max(0, feedOffset - PAGE_SIZE))} disabled={feedOffset === 0 || feedLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">&larr; Prev</button>
              <span className="text-xs text-txt-secondary">Offset {feedOffset}</span>
              <button onClick={() => fetchRedeemedFeed(feedOffset + PAGE_SIZE)} disabled={feedRows.length < PAGE_SIZE || feedLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">Next &rarr;</button>
            </div>
          </Card>

          {/* ── All Vouchers (admin) ── */}
          <Card title="All Vouchers (Admin Only)" icon={<ListChecks className="w-5 h-5 text-yellow-400" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; This call is onlyRole(DEFAULT_ADMIN_ROLE) on-chain — it will revert for a non-admin wallet.</p>}
            <button onClick={() => fetchAllVouchers(0)} disabled={!isAdminConnected} className={`mb-3 px-4 ${btnCls}`}>Load</button>
            <VoucherTable rows={allRows} />
            <div className="flex justify-between items-center mt-2">
              <button onClick={() => fetchAllVouchers(Math.max(0, allOffset - PAGE_SIZE))} disabled={allOffset === 0 || allLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">&larr; Prev</button>
              <span className="text-xs text-txt-secondary">Offset {allOffset}</span>
              <button onClick={() => fetchAllVouchers(allOffset + PAGE_SIZE)} disabled={allRows.length < PAGE_SIZE || allLoading} className="text-xs text-accent disabled:opacity-30 hover:underline">Next &rarr;</button>
            </div>
          </Card>

          {/* ── GameHub Integration ── */}
          <Card title="GameHub Integration" icon={<Network className="w-5 h-5 text-accent" />}>
            <p className="text-xs text-txt-secondary mb-3">
              Optional: point the loaded GameHub at this ATMVoucher so every operator&apos;s DailySessionManager instance can process a voucher redemption. Requires GameHub admin on the Hub tab&apos;s hub, {hubAddress ? fmtAddr(hubAddress) : 'load one from the Hub tab first'}.
            </p>
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-xs text-txt-secondary">Hub&apos;s current ATM Voucher:</span>
              <span className="text-xs font-mono">{hubLinkLoading ? 'Loading...' : isZero(hubAtmVoucher) ? 'Not linked' : fmtAddr(hubAtmVoucher)}</span>
              <button onClick={handleSetHubAtmVoucher} disabled={!hubAddress || !atmVoucherAddress} className={`ml-auto px-4 ${btnCls}`}>Link This Voucher to Hub</button>
            </div>
            <p className="text-xs text-txt-secondary">
              redeemVoucher (on DailySessionManager) decides Point-vs-Reward behavior directly from a redeemed voucher&apos;s voucherType id (1 = Point, 2 = Reward) — any other id is rejected there, so there&apos;s nothing further to configure here beyond the two types registered above.
            </p>
          </Card>

          {/* ── Upgrade ── */}
          <Card title="Upgrade Implementation (UUPS)" icon={<ArrowUpCircle className="w-5 h-5 text-accent" />}>
            {!isAdminConnected && <p className="text-xs text-yellow-400 mb-3">&#9888; Connected wallet is not admin — upgrading will revert.</p>}
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
