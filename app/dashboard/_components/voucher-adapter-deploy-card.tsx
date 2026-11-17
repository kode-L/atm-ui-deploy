'use client';
// Deploy tab: deploy a VoucherAdapter for the loaded GameHub - same two-step layout as the other
// deploy/upgrade cards (1. implementation, 2. proxy + initialize). Linking happens in the GameHub tab
// (Linked Contracts -> Voucher Adapter), which picks this address up automatically.
import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { decodeError } from '@/lib/contracts/error-decoder';
import {
  getExplorerAddressUrl, DEFAULT_SENATOR_ADDRESS, DEFAULT_SENATOR_ADDRESS_MAINNET, DEFAULT_SIGN_NUM,
  DEFAULT_SIGN_NUM_MAINNET, DEFAULT_VOUCHER_NFT_ADDRESS, DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET,
} from '@/lib/contracts/config';
import { loadBook } from '@/lib/contracts/voucher-v2';
import VoucherAdapterArtifact from '@/lib/contracts/VoucherAdapter.json';
import VoucherAdapterProxyArtifact from '@/lib/contracts/VoucherAdapterProxy.json';
import { Ticket, ExternalLink, Copy, Check } from 'lucide-react';
import { saveVoucherAdapterAddress, loadVoucherAdapterAddress, useSenators } from './voucher-adapter-card';

type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };

const ZERO = ethers.constants.AddressZero;
const isAddr = (a: string) => !!a && ethers.utils.isAddress(a.trim());
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const inputCls = 'w-full bg-surface rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent';
const btnCls = 'w-full bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold py-2.5 rounded-lg text-sm transition-colors';

/** Shown under a pre-filled field once it differs from its default: one click puts the default back. */
function DefaultHint({ value, def, onUse, fmt = short }: { value: string; def: string; onUse: () => void; fmt?: (v: string) => string }) {
  if (!def || value.trim().toLowerCase() === def.toLowerCase()) return null;
  return (
    <p className="text-[11px] text-txt-secondary mt-0.5">
      Default: <span className="font-mono text-accent">{fmt(def)}</span>{' '}
      <button onClick={onUse} className="underline hover:text-accent">Use default</button>
    </p>
  );
}

export default function VoucherAdapterDeployCard() {
  const { provider, signer, isConnected, address, chainId, hubAddress } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState('');
  const [implAddress, setImplAddress] = useState('');
  const [deployAdmin, setDeployAdmin] = useState('');
  const [deploySenator, setDeploySenator] = useState('');
  const [deploySignNum, setDeploySignNum] = useState('');
  const [deployVoucherNFT, setDeployVoucherNFT] = useState('');
  const [lastAdapter, setLastAdapter] = useState('');
  const senatorSet = useSenators(provider, deploySenator.trim());
  const signNumValue = parseInt(deploySignNum, 10);

  // per-chain defaults (chain.json); the admin default is the connected wallet
  const defSenator = chainId === 56 ? DEFAULT_SENATOR_ADDRESS_MAINNET : chainId === 97 ? DEFAULT_SENATOR_ADDRESS : '';
  const defSignNum = chainId === 56 ? String(DEFAULT_SIGN_NUM_MAINNET) : chainId === 97 ? String(DEFAULT_SIGN_NUM) : '';
  const defVoucherNFT = chainId
    ? loadBook(chainId).contracts.VoucherNFT || (chainId === 56 ? DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET : chainId === 97 ? DEFAULT_VOUCHER_NFT_ADDRESS : '')
    : '';
  const defAdmin = address || '';

  useEffect(() => { if (chainId) setLastAdapter(loadVoucherAdapterAddress(chainId)); }, [chainId]);
  // Pre-fill once per network (and the admin once a wallet is connected) - never when a field is
  // emptied, so fields stay editable; "Use default" under a field restores it.
  const prefilledChain = useRef<number | null>(null);
  const prefilledAdmin = useRef(false);
  useEffect(() => {
    if (address && !prefilledAdmin.current) { setDeployAdmin(address); prefilledAdmin.current = true; }
  }, [address]);
  useEffect(() => {
    if (!chainId || prefilledChain.current === chainId) return;
    prefilledChain.current = chainId;
    setDeploySenator(defSenator);
    setDeploySignNum(defSignNum);
    setDeployVoucherNFT(defVoucherNFT);
  }, [chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (a: string, k: string) => { navigator.clipboard?.writeText?.(a); setCopied(k); setTimeout(() => setCopied(''), 2000); };

  const deployImplementation = async () => {
    if (!signer) return;
    setTxStatus({ status: 'pending', message: 'Deploying VoucherAdapter implementation...' });
    try {
      const factory = new ethers.ContractFactory(VoucherAdapterArtifact.abi, VoucherAdapterArtifact.bytecode, signer);
      const impl = await factory.deploy();
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: impl.deployTransaction?.hash });
      await impl.deployed();
      setImplAddress(impl.address);
      setTxStatus({ status: 'success', hash: impl.deployTransaction?.hash, message: `Implementation deployed at ${impl.address}. Now step 2: deploy proxy + initialize.` });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const deployProxy = async () => {
    if (!signer) return;
    const impl = implAddress.trim();
    const admin = deployAdmin.trim();
    const senator = deploySenator.trim();
    const nft = deployVoucherNFT.trim() || ZERO;
    const signNum = parseInt(deploySignNum, 10);
    if (!isAddr(hubAddress)) { setTxStatus({ status: 'error', error: 'Load the GameHub first (Load Existing Contracts below).' }); return; }
    if (!isAddr(impl)) { setTxStatus({ status: 'error', error: 'Implementation address missing: run step 1 or paste one.' }); return; }
    if (!isAddr(admin) || !isAddr(senator)) { setTxStatus({ status: 'error', error: 'Admin and senator must be valid addresses.' }); return; }
    if (nft !== ZERO && !isAddr(nft)) { setTxStatus({ status: 'error', error: 'VoucherNFT must be a valid address, or empty to set it later.' }); return; }
    if (!signNum || signNum < 1) { setTxStatus({ status: 'error', error: 'Required PR-node signatures must be at least 1.' }); return; }
    setTxStatus({ status: 'pending', message: 'Deploying proxy + initializing...' });
    try {
      const initData = new ethers.utils.Interface(VoucherAdapterArtifact.abi).encodeFunctionData('initialize', [admin, hubAddress, nft, senator, signNum]);
      const factory = new ethers.ContractFactory(VoucherAdapterProxyArtifact.abi, VoucherAdapterProxyArtifact.bytecode, signer);
      const proxy = await factory.deploy(impl, initData);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: proxy.deployTransaction?.hash });
      await proxy.deployed();
      saveVoucherAdapterAddress(chainId, proxy.address);
      setLastAdapter(proxy.address);
      setImplAddress('');
      setTxStatus({
        status: 'success',
        hash: proxy.deployTransaction?.hash,
        message: `VoucherAdapter deployed at ${proxy.address}. Next: GameHub tab → Linked Contracts → Voucher Adapter → "Link to GameHub".`,
      });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  const addrRow = (a: string, k: string) => (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-accent break-all">{a}</code>
      <button onClick={() => copy(a, k)}>{copied === k ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}</button>
      <a href={getExplorerAddressUrl(chainId, a)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
    </span>
  );

  return (
    <Card collapsible title="Deploy VoucherAdapter" icon={<Ticket className="w-5 h-5 text-accent" />}>
      <p className="text-txt-secondary text-sm mb-4">
        One adapter for every operator DSM under the hub at <code className="text-accent">{hubAddress || '(no GameHub loaded)'}</code>:
        Voucher V2 points/payout vouchers and PR-node signed points transfers. Deploy it after <b>Upgrade GameHub</b> (v1.0.6) and{' '}
        <b>Upgrade Fleet</b> (DSM v1.0.8), then link it in the <b>GameHub tab → Linked Contracts → Voucher Adapter</b>.
      </p>
      {lastAdapter && (
        <div className="bg-surface-tertiary rounded-lg px-4 py-2.5 mb-4 flex items-center gap-2 text-sm flex-wrap">
          <span className="text-txt-secondary">Last deployed / known on this network:</span>
          {addrRow(lastAdapter, 'last')}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface-tertiary rounded-lg p-4">
          <h4 className="font-medium mb-2">1. Deploy Implementation</h4>
          <p className="text-xs text-txt-secondary mb-3">Deploy the VoucherAdapter logic contract.</p>
          <button onClick={deployImplementation} disabled={!isConnected || !hubAddress} className={btnCls}>Deploy Implementation</button>
          {implAddress && <p className="text-[11px] text-txt-secondary mt-2">Implementation: {addrRow(implAddress, 'impl')}</p>}
        </div>
        <div className="bg-surface-tertiary rounded-lg p-4 space-y-2">
          <h4 className="font-medium">2. Deploy Proxy + Initialize</h4>
          <p className="text-xs text-txt-secondary">Pre-filled for this network — edit or clear any field; &quot;Use default&quot; puts it back.</p>
          <div>
            <label className="text-[11px] text-txt-secondary">Implementation (from step 1, or paste an existing one)</label>
            <input value={implAddress} onChange={e => setImplAddress(e.target.value)} placeholder="0x..." className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Admin</label>
            <input value={deployAdmin} onChange={e => setDeployAdmin(e.target.value)} placeholder="0x..." className={inputCls} />
            <DefaultHint value={deployAdmin} def={defAdmin} onUse={() => setDeployAdmin(defAdmin)} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Senator (PR-node multisig)</label>
            <input value={deploySenator} onChange={e => setDeploySenator(e.target.value)} placeholder="0x..." className={inputCls} />
            <DefaultHint value={deploySenator} def={defSenator} onUse={() => setDeploySenator(defSenator)} />
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">Required PR-node signatures (same as Incentive)</label>
            <input value={deploySignNum} onChange={e => setDeploySignNum(e.target.value)} placeholder="e.g. 18" className={inputCls} />
            <DefaultHint value={deploySignNum} def={defSignNum} onUse={() => setDeploySignNum(defSignNum)} fmt={v => v} />
            {senatorSet && (
              <p className={`text-[11px] mt-0.5 ${signNumValue > senatorSet.senators.length ? 'text-red-400' : 'text-txt-secondary'}`}>
                {senatorSet.senators.length} current senators (PR nodes){signNumValue > 0 ? ` — requires ${signNumValue} of ${senatorSet.senators.length}` : ''}
                {signNumValue > senatorSet.senators.length ? ' — more than exist, transfers would always fail' : ''}
              </p>
            )}
          </div>
          <div>
            <label className="text-[11px] text-txt-secondary">VoucherNFT (optional — empty = set it later)</label>
            <input value={deployVoucherNFT} onChange={e => setDeployVoucherNFT(e.target.value)} placeholder="empty = points transfers only for now" className={inputCls} />
            <DefaultHint value={deployVoucherNFT} def={defVoucherNFT} onUse={() => setDeployVoucherNFT(defVoucherNFT)} />
          </div>
          <button onClick={deployProxy} disabled={!isConnected || !hubAddress || !implAddress} className={btnCls}>Deploy Proxy + Initialize</button>
          {!hubAddress && <p className="text-xs text-yellow-400">&#9888; Deploy or load a GameHub first</p>}
        </div>
      </div>
      <div className="mt-3"><TxStatus {...txStatus} chainId={chainId} /></div>
    </Card>
  );
}
