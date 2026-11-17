'use client';
// VoucherAdapter — lives in the GameHub tab because it is part of the hub: one adapter serves every
// operator instance, and it only works once the hub lists it as a points manager
// (GameHub.setPointsManager). It is:
//   - the settlement target for VoucherNFT (Voucher V2) Points / Reward types:
//       Points -> DSM.applyPointsDelta on the DSM mapped to the type (setTypeInstance)
//       Reward -> mapped type: that DSM pays its paymentToken (LUCA) from uncommitted funds
//                 (DSM.withdrawRetained); unmapped type: paid from the adapter's own balance
//   - a drop-in PointsTransfer (same ABI): PR-node signed transfers between two wallets.
// pagerank-service finds it the same way it finds PointsTransfer (getPointsManagers + hub()), so
// keep exactly one transfer-capable points manager registered on the hub.
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import { getExplorerAddressUrl, networkStorageKey, DEFAULT_SENATOR_ADDRESS, DEFAULT_SENATOR_ADDRESS_MAINNET, DEFAULT_VOUCHER_NFT_ADDRESS, DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET } from '@/lib/contracts/config';
import { loadBook } from '@/lib/contracts/voucher-v2';
import VoucherAdapterArtifact from '@/lib/contracts/VoucherAdapter.json';
import VoucherAdapterProxyArtifact from '@/lib/contracts/VoucherAdapterProxy.json';
import { Ticket, Copy, Check, ExternalLink, RefreshCw, Link2, Unlink, PauseCircle, PlayCircle, AlertTriangle } from 'lucide-react';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };

export interface AdapterOperator {
  address: string;
  instance: string;
  active: boolean;
  name: string;
}

interface AdapterInfo {
  version: string;
  hub: string;
  voucherNFT: string;
  senator: string;
  signNum: number;
  paused: boolean;
  isAdmin: boolean;
}

const ZERO = ethers.constants.AddressZero;
const isAddr = (a: string) => !!a && ethers.utils.isAddress(a.trim());
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const STORAGE_BASE = 'dg_voucherAdapterAddress';

export default function VoucherAdapterCard({
  hubAddress,
  operators,
  pointsManagers,
  onHubChanged,
}: {
  hubAddress: string;
  operators: AdapterOperator[];
  pointsManagers: string[];
  onHubChanged: () => void;
}) {
  const { provider, signer, isConnected, address, chainId } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');
  const [adapterAddress, setAdapterAddressState] = useState('');
  const [info, setInfo] = useState<AdapterInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // points managers that look like a transfer contract (PointsTransfer or VoucherAdapter):
  // pagerank-service refuses to sign when more than one of these is registered
  const [transferManagers, setTransferManagers] = useState<string[]>([]);

  const inputCls = 'w-full mt-0.5 bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent';
  const primaryBtn = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors';
  const secondaryBtn = 'bg-surface-tertiary hover:bg-accent/20 border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  const copyAddr = (addr: string, label: string) => {
    navigator.clipboard?.writeText?.(addr);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const setAdapterAddress = (a: string) => {
    setAdapterAddressState(a);
    try { localStorage.setItem(networkStorageKey(STORAGE_BASE, chainId), a); } catch { /* storage unavailable */ }
  };

  // ── find the adapter: the one linked on the hub wins, else the last one deployed/loaded here ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!provider) return;
      const transfer: string[] = [];
      let linkedAdapter = '';
      for (const pm of pointsManagers) {
        const c = new ethers.Contract(pm, VoucherAdapterArtifact.abi, provider);
        try {
          if (!same(await c.hub(), hubAddress)) continue;
          transfer.push(pm);
          await c.voucherNFT(); // only VoucherAdapter has this; PointsTransfer reverts
          if (!linkedAdapter) linkedAdapter = pm;
        } catch {
          // not a transfer contract, or a PointsTransfer (no voucherNFT())
        }
      }
      if (cancelled) return;
      setTransferManagers(transfer);
      if (linkedAdapter) {
        setAdapterAddressState(linkedAdapter);
      } else {
        let saved = '';
        try { saved = localStorage.getItem(networkStorageKey(STORAGE_BASE, chainId)) || ''; } catch { /* ignore */ }
        setAdapterAddressState(saved);
      }
    })();
    return () => { cancelled = true; };
  }, [pointsManagers, provider, hubAddress, chainId]);

  const getAdapter = useCallback((withSigner = false) => {
    if (!isAddr(adapterAddress)) return null;
    const signerOrProvider = withSigner ? signer : provider;
    if (!signerOrProvider) return null;
    return new ethers.Contract(adapterAddress, VoucherAdapterArtifact.abi, signerOrProvider);
  }, [adapterAddress, provider, signer]);

  const fetchInfo = useCallback(async () => {
    const c = getAdapter();
    if (!c) { setInfo(null); return; }
    setLoading(true);
    try {
      const [version, hub, voucherNFT, senator, signNum, paused, isAdmin] = await Promise.all([
        c.version(),
        c.hub(),
        c.voucherNFT(),
        c.senator(),
        c.signNum(),
        c.paused(),
        address ? c.hasRole(ethers.constants.HashZero, address) : Promise.resolve(false),
      ]);
      setInfo({ version, hub, voucherNFT, senator, signNum: Number(signNum), paused, isAdmin });
    } catch (e: any) {
      setInfo(null);
      setTxStatus({ status: 'error', error: `Could not read ${adapterAddress} as a VoucherAdapter: ${decodeError(e)}` });
    } finally {
      setLoading(false);
    }
  }, [getAdapter, address, adapterAddress]);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  const isLinked = pointsManagers.some(pm => same(pm, adapterAddress));
  const otherTransferManagers = transferManagers.filter(pm => !same(pm, adapterAddress));

  // generic "send tx, wait, report" helper
  const run = async (label: string, send: () => Promise<any>, done: string, after?: () => void) => {
    setTxStatus({ status: 'pending', message: `${label}...` });
    try {
      const tx = await send();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: done });
      after?.();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  // ── Deploy (implementation, then proxy + initialize) ──
  const [implAddress, setImplAddress] = useState('');
  const [deployAdmin, setDeployAdmin] = useState('');
  const [deploySenator, setDeploySenator] = useState('');
  const [deploySignNum, setDeploySignNum] = useState('');
  const [deployVoucherNFT, setDeployVoucherNFT] = useState('');
  const [manualLoad, setManualLoad] = useState('');

  useEffect(() => { if (address && !deployAdmin) setDeployAdmin(address); }, [address, deployAdmin]);
  useEffect(() => {
    if (deploySenator) return;
    if (chainId === 97) setDeploySenator(DEFAULT_SENATOR_ADDRESS);
    else if (chainId === 56) setDeploySenator(DEFAULT_SENATOR_ADDRESS_MAINNET);
  }, [chainId, deploySenator]);
  useEffect(() => {
    // pre-fill VoucherNFT: the Voucher V2 tab's address book first, else the deployed one per chain
    // (optional - can be left empty and set later)
    if (deployVoucherNFT || !chainId) return;
    const nft = loadBook(chainId).contracts.VoucherNFT
      || (chainId === 56 ? DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET : chainId === 97 ? DEFAULT_VOUCHER_NFT_ADDRESS : '');
    if (nft) setDeployVoucherNFT(nft);
  }, [chainId, deployVoucherNFT]);

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying VoucherAdapter implementation...' });
    try {
      const factory = new ethers.ContractFactory(VoucherAdapterArtifact.abi, VoucherAdapterArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now deploy the proxy.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const deployProxy = async () => {
    if (!signer || !implAddress) return;
    const admin = deployAdmin.trim();
    const senator = deploySenator.trim();
    const nft = deployVoucherNFT.trim() || ZERO;
    const signNum = parseInt(deploySignNum, 10);
    if (!isAddr(admin) || !isAddr(senator)) {
      setTxStatus({ status: 'error', error: 'Admin and senator must be valid addresses.' });
      return;
    }
    if (nft !== ZERO && !isAddr(nft)) {
      setTxStatus({ status: 'error', error: 'VoucherNFT must be a valid address, or empty to set it later.' });
      return;
    }
    if (!signNum || signNum < 1) {
      setTxStatus({ status: 'error', error: 'Required PR-node signatures must be at least 1.' });
      return;
    }
    setTxStatus({ status: 'pending', message: 'Deploying proxy + initializing...' });
    try {
      const iface = new ethers.utils.Interface(VoucherAdapterArtifact.abi);
      const initData = iface.encodeFunctionData('initialize', [admin, hubAddress, nft, senator, signNum]);
      const factory = new ethers.ContractFactory(VoucherAdapterProxyArtifact.abi, VoucherAdapterProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(implAddress, initData);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      setAdapterAddress(proxy.address);
      setImplAddress('');
      setTxStatus({
        status: 'success',
        hash: proxy.deployTransaction?.hash,
        message: `VoucherAdapter deployed at ${proxy.address}. Next: "Link to GameHub" below so the DSMs accept it.`,
      });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const loadExisting = () => {
    if (!isAddr(manualLoad)) {
      setTxStatus({ status: 'error', error: 'Invalid address' });
      return;
    }
    setAdapterAddress(ethers.utils.getAddress(manualLoad.trim()));
    setManualLoad('');
    setTxStatus({ status: 'idle' });
  };

  // ── Link to the hub (points-manager allowlist) ──
  const linkToHub = (allowed: boolean) => {
    if (!signer || !isAddr(adapterAddress)) return;
    const hub = new ethers.Contract(hubAddress, ['function setPointsManager(address,bool)'], signer);
    run(
      allowed ? 'Linking VoucherAdapter to GameHub' : 'Unlinking VoucherAdapter from GameHub',
      () => hub.setPointsManager(adapterAddress, allowed),
      allowed ? 'Linked ✔ — every operator DSM now accepts this adapter.' : 'Unlinked ✔ — the adapter can no longer change points or pay from DSMs.',
      onHubChanged,
    );
  };

  // ── Settings ──
  const [nftInput, setNftInput] = useState('');
  const [senatorInput, setSenatorInput] = useState('');
  const [signNumInput, setSignNumInput] = useState('');

  const setVoucherNFT = () => {
    const c = getAdapter(true);
    if (!c || !isAddr(nftInput)) { setTxStatus({ status: 'error', error: 'Enter a valid VoucherNFT address.' }); return; }
    run('Setting VoucherNFT', () => c.setVoucherNFT(nftInput.trim()), 'VoucherNFT set ✔ — voucher claims are now accepted from it.', () => { setNftInput(''); fetchInfo(); });
  };
  const setSenator = () => {
    const c = getAdapter(true);
    if (!c || !isAddr(senatorInput)) { setTxStatus({ status: 'error', error: 'Enter a valid senator address.' }); return; }
    run('Setting senator', () => c.setSenator(senatorInput.trim()), 'Senator updated ✔', () => { setSenatorInput(''); fetchInfo(); });
  };
  const setSignNum = () => {
    const c = getAdapter(true);
    const n = parseInt(signNumInput, 10);
    if (!c || !n || n < 1) { setTxStatus({ status: 'error', error: 'Required signatures must be at least 1.' }); return; }
    run('Setting required signatures', () => c.setSignNum(n), 'Required signatures updated ✔', () => { setSignNumInput(''); fetchInfo(); });
  };
  const togglePause = () => {
    const c = getAdapter(true);
    if (!c || !info) return;
    run(info.paused ? 'Unpausing' : 'Pausing', () => (info.paused ? c.unpause() : c.pause()),
      info.paused ? 'Unpaused ✔' : 'Paused ✔ — voucher claims and points transfers are stopped.', fetchInfo);
  };

  // ── Voucher type -> DSM mapping ──
  const [typeIdInput, setTypeIdInput] = useState('');
  const [typeInstanceInput, setTypeInstanceInput] = useState('');
  const [typeLookup, setTypeLookup] = useState<{ typeId: string; instance: string } | null>(null);

  const lookupType = async () => {
    const c = getAdapter();
    if (!c || typeIdInput.trim() === '') return;
    try {
      const inst: string = await c.typeInstance(typeIdInput.trim());
      setTypeLookup({ typeId: typeIdInput.trim(), instance: inst });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };
  const mapType = (unmap: boolean) => {
    const c = getAdapter(true);
    if (!c || typeIdInput.trim() === '') { setTxStatus({ status: 'error', error: 'Enter a VoucherNFT type id.' }); return; }
    const instance = unmap ? ZERO : typeInstanceInput;
    if (!unmap && !isAddr(instance)) { setTxStatus({ status: 'error', error: 'Pick the operator DSM to map this type to.' }); return; }
    run(
      unmap ? `Unmapping type ${typeIdInput}` : `Mapping type ${typeIdInput}`,
      () => c.setTypeInstance(typeIdInput.trim(), instance),
      unmap
        ? `Type ${typeIdInput} unmapped ✔ (Points: claims now revert; Reward: paid from the adapter's own balance).`
        : `Type ${typeIdInput} → ${instance} ✔`,
      lookupType,
    );
  };

  // ── Points callers (e.g. VoucherTransfer) ──
  const [callerInput, setCallerInput] = useState('');
  const setPointsCaller = (allowed: boolean) => {
    const c = getAdapter(true);
    if (!c || !isAddr(callerInput)) { setTxStatus({ status: 'error', error: 'Enter a valid contract address.' }); return; }
    run(allowed ? 'Allowing points caller' : 'Removing points caller', () => c.setPointsCaller(callerInput.trim(), allowed),
      allowed ? 'Points caller allowed ✔' : 'Points caller removed ✔', () => setCallerInput(''));
  };

  // ── Withdraw (adapter-funded Reward types only; never touches DSM funds) ──
  const [wToken, setWToken] = useState('');
  const [wTo, setWTo] = useState('');
  const [wAmount, setWAmount] = useState('');
  const withdraw = () => {
    const c = getAdapter(true);
    if (!c || !isAddr(wTo) || !wAmount) { setTxStatus({ status: 'error', error: 'Enter a recipient and an amount.' }); return; }
    let amount: ethers.BigNumber;
    try { amount = ethers.utils.parseEther(wAmount.trim()); } catch { setTxStatus({ status: 'error', error: 'Invalid amount.' }); return; }
    if (wToken.trim() === '') {
      run('Withdrawing BNB', () => c.withdrawNative(wTo.trim(), amount), 'BNB withdrawn ✔');
    } else {
      if (!isAddr(wToken)) { setTxStatus({ status: 'error', error: 'Invalid token address.' }); return; }
      run('Withdrawing token', () => c.withdrawERC20(wToken.trim(), wTo.trim(), amount), 'Token withdrawn ✔');
    }
  };

  const addrLine = (label: string, a: string) => (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-txt-secondary">{label}</span>
      {a && a !== ZERO ? (
        <span className="flex items-center gap-1">
          <code className="font-mono text-accent break-all">{a}</code>
          <button onClick={() => copyAddr(a, label)}>{copied === label ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}</button>
          <a href={getExplorerAddressUrl(chainId, a)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
        </span>
      ) : <span className="text-yellow-400/80">Not set</span>}
    </div>
  );

  const activeOps = operators.filter(o => o.active);

  return (
    <Card title="Voucher Adapter" icon={<Ticket className="w-4 h-4 text-accent" />}>
      <p className="text-[11px] text-txt-secondary mb-3">
        One contract for every operator DSM: <b>Voucher V2</b> points vouchers (credit/debit a DSM&apos;s points), payout vouchers
        (LUCA paid by the mapped DSM from its <i>uncommitted</i> funds, or any token from the adapter&apos;s own balance), and
        PR-node <b>signed points transfers</b> (same ABI as PointsTransfer). It works only while it is linked here as a GameHub points manager.
      </p>

      {/* ── Status ── */}
      {isAddr(adapterAddress) ? (
        <div className="bg-surface-tertiary rounded-lg p-3 space-y-1.5 mb-3">
          <div className="flex items-center justify-between">
            <h5 className="text-xs font-semibold text-accent">Status</h5>
            <button onClick={fetchInfo} disabled={loading} className="flex items-center gap-1 text-[11px] text-txt-secondary hover:text-accent disabled:opacity-40">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
          {addrLine('Adapter', adapterAddress)}
          {info && (
            <>
              <div className="flex justify-between text-xs"><span className="text-txt-secondary">Version</span><span>{info.version}</span></div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-secondary">Linked to this GameHub</span>
                <span className={isLinked ? 'text-green-400' : 'text-yellow-400'}>{isLinked ? 'Yes (points manager)' : 'No — not active yet'}</span>
              </div>
              {!same(info.hub, hubAddress) && (
                <p className="text-[11px] text-red-400">⚠ This adapter points at a different hub ({info.hub}). Do not link it here.</p>
              )}
              {addrLine('VoucherNFT', info.voucherNFT)}
              {addrLine('Senator', info.senator)}
              <div className="flex justify-between text-xs"><span className="text-txt-secondary">Required PR-node signatures</span><span>{info.signNum}</span></div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-secondary">State</span>
                <span className={info.paused ? 'text-red-400' : 'text-green-400'}>{info.paused ? 'Paused' : 'Active'}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-txt-secondary">Connected wallet is adapter admin</span>
                <span className={info.isAdmin ? 'text-green-400' : 'text-txt-secondary'}>{info.isAdmin ? 'Yes' : 'No'}</span>
              </div>
            </>
          )}
          {otherTransferManagers.length > 0 && (
            <div className="flex gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded p-2 mt-2">
              <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
              <p className="text-[11px] text-yellow-300">
                Other transfer contract(s) registered on this hub: {otherTransferManagers.join(', ')}. pagerank-service picks the
                transfer contract from the hub and refuses to sign when there is more than one — remove the old one in Points Managers.
              </p>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            {!isLinked ? (
              <button onClick={() => linkToHub(true)} disabled={!isConnected || !info || !same(info?.hub, hubAddress)} className={primaryBtn + ' flex items-center gap-1.5'}>
                <Link2 className="w-4 h-4" /> Link to GameHub
              </button>
            ) : (
              <button onClick={() => linkToHub(false)} disabled={!isConnected} className={secondaryBtn + ' flex items-center gap-1.5'}>
                <Unlink className="w-4 h-4" /> Unlink from GameHub
              </button>
            )}
            {info && (
              <button onClick={togglePause} disabled={!isConnected || !info.isAdmin} className={secondaryBtn + ' flex items-center gap-1.5'}>
                {info.paused ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />} {info.paused ? 'Unpause' : 'Pause'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-txt-secondary text-sm text-center py-3">No VoucherAdapter linked on this hub yet — deploy one below, or load an existing address.</p>
      )}

      {/* ── Deploy ── */}
      <details className="bg-surface-tertiary rounded-lg p-3 mb-3" open={!isAddr(adapterAddress)}>
        <summary className="text-xs font-semibold text-accent cursor-pointer">Deploy new VoucherAdapter</summary>
        <div className="space-y-2 mt-2">
          <p className="text-[11px] text-txt-secondary">
            Needs GameHub v1.0.6 and DailySessionManager v1.0.8 (Deploy tab → Upgrade GameHub, then Upgrade Fleet) — older versions
            have no points-manager allowlist. Hub is this GameHub. Use the same senator and signature count the PR nodes already use.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-txt-secondary">Admin</label>
              <input value={deployAdmin} onChange={e => setDeployAdmin(e.target.value)} placeholder="0x..." className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-txt-secondary">Senator (PR-node multisig)</label>
              <input value={deploySenator} onChange={e => setDeploySenator(e.target.value)} placeholder="0x..." className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-txt-secondary">Required PR-node signatures</label>
              <input value={deploySignNum} onChange={e => setDeploySignNum(e.target.value)} placeholder="e.g. 2" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-txt-secondary">VoucherNFT (optional — can be set later)</label>
              <input value={deployVoucherNFT} onChange={e => setDeployVoucherNFT(e.target.value)} placeholder="empty = points transfers only for now" className={inputCls} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={deployImplementation} disabled={!isConnected || !!implAddress} className={primaryBtn + ' flex-1'}>1. Deploy implementation</button>
            <button onClick={deployProxy} disabled={!isConnected || !implAddress} className={primaryBtn + ' flex-1'}>2. Deploy proxy + initialize</button>
          </div>
          {implAddress && <p className="text-[11px] text-txt-secondary">Implementation: <code className="text-accent">{implAddress}</code></p>}
          <div className="flex gap-2 pt-1">
            <input value={manualLoad} onChange={e => setManualLoad(e.target.value)} placeholder="or load an existing VoucherAdapter: 0x..." className={inputCls + ' flex-1'} />
            <button onClick={loadExisting} disabled={!manualLoad} className={secondaryBtn}>Load</button>
          </div>
        </div>
      </details>

      {info && (
        <div className="space-y-3">
          {/* ── Voucher type -> DSM ── */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Voucher Type → Operator DSM</h5>
            <p className="text-[11px] text-txt-secondary">
              Map each Voucher V2 type to the operator DSM it settles on. <b>Points</b> types must be mapped (credit/debit that DSM&apos;s
              points). <b>Reward</b> types mapped here are paid by that DSM in its payment token (LUCA) from uncommitted funds — register
              them with funding mode <i>OnClaim</i>. Leave other-token / BNB Reward types unmapped (paid from this adapter&apos;s balance).
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] text-txt-secondary">VoucherNFT type id</label>
                <input value={typeIdInput} onChange={e => { setTypeIdInput(e.target.value); setTypeLookup(null); }} placeholder="0" className={inputCls} />
              </div>
              <div className="md:col-span-2">
                <label className="text-[11px] text-txt-secondary">Operator DSM</label>
                <select value={typeInstanceInput} onChange={e => setTypeInstanceInput(e.target.value)} className={inputCls}>
                  <option value="">Select operator…</option>
                  {activeOps.map(o => <option key={o.instance} value={o.instance}>{o.name} — {o.instance}</option>)}
                </select>
              </div>
            </div>
            {typeLookup && (
              <p className="text-[11px] text-txt-secondary break-all">
                Type {typeLookup.typeId} currently: <span className="text-accent font-mono">
                  {typeLookup.instance === ZERO ? 'not mapped' : `${operators.find(o => same(o.instance, typeLookup.instance))?.name || ''} ${typeLookup.instance}`}
                </span>
              </p>
            )}
            <div className="flex gap-2">
              <button onClick={lookupType} disabled={typeIdInput === ''} className={secondaryBtn}>Look up</button>
              <button onClick={() => mapType(false)} disabled={!isConnected || !info.isAdmin || typeIdInput === '' || !typeInstanceInput} className={primaryBtn + ' flex-1'}>Map type</button>
              <button onClick={() => mapType(true)} disabled={!isConnected || !info.isAdmin || typeIdInput === ''} className={secondaryBtn}>Unmap</button>
            </div>
          </div>

          {/* ── Settings ── */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Settings</h5>
            <div className="flex gap-2">
              <input value={nftInput} onChange={e => setNftInput(e.target.value)} placeholder="VoucherNFT 0x... (enables voucher claims)" className={inputCls + ' flex-1'} />
              <button onClick={setVoucherNFT} disabled={!isConnected || !info.isAdmin || !nftInput} className={secondaryBtn}>Set VoucherNFT</button>
            </div>
            <div className="flex gap-2">
              <input value={senatorInput} onChange={e => setSenatorInput(e.target.value)} placeholder="Senator 0x..." className={inputCls + ' flex-1'} />
              <button onClick={setSenator} disabled={!isConnected || !info.isAdmin || !senatorInput} className={secondaryBtn}>Set Senator</button>
            </div>
            <div className="flex gap-2">
              <input value={signNumInput} onChange={e => setSignNumInput(e.target.value)} placeholder="Required PR-node signatures" className={inputCls + ' flex-1'} />
              <button onClick={setSignNum} disabled={!isConnected || !info.isAdmin || !signNumInput} className={secondaryBtn}>Set Signatures</button>
            </div>
          </div>

          {/* ── Points callers ── */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Points Callers (optional)</h5>
            <p className="text-[11px] text-yellow-400/80">
              ⚠ Extra contracts allowed to change DSM points through the adapter, e.g. Voucher V2&apos;s VoucherTransfer. VoucherTransfer lets
              any holder send their own points to any address without PR-node signatures — only allow it if that is intended.
            </p>
            <div className="flex gap-2">
              <input value={callerInput} onChange={e => setCallerInput(e.target.value)} placeholder="0x..." className={inputCls + ' flex-1'} />
              <button onClick={() => setPointsCaller(true)} disabled={!isConnected || !info.isAdmin || !callerInput} className={secondaryBtn}>Allow</button>
              <button onClick={() => setPointsCaller(false)} disabled={!isConnected || !info.isAdmin || !callerInput} className={secondaryBtn}>Remove</button>
            </div>
          </div>

          {/* ── Withdraw ── */}
          <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
            <h5 className="text-xs font-semibold text-accent">Withdraw From Adapter Balance</h5>
            <p className="text-[11px] text-txt-secondary">
              Only the adapter&apos;s own balance (unmapped Reward types). Amount in whole tokens (18-decimal fixed point, rescaled to the
              token&apos;s decimals). Funds reserved for minted-but-unclaimed vouchers can&apos;t be withdrawn. Never touches DSM funds.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <input value={wToken} onChange={e => setWToken(e.target.value)} placeholder="Token 0x... (empty = BNB)" className={inputCls} />
              <input value={wTo} onChange={e => setWTo(e.target.value)} placeholder="To 0x..." className={inputCls} />
              <input value={wAmount} onChange={e => setWAmount(e.target.value)} placeholder="Amount" className={inputCls} />
            </div>
            <button onClick={withdraw} disabled={!isConnected || !info.isAdmin || !wTo || !wAmount} className={secondaryBtn}>Withdraw</button>
          </div>
        </div>
      )}

      <div className="mt-3"><TxStatus {...txStatus} chainId={chainId} /></div>
    </Card>
  );
}
