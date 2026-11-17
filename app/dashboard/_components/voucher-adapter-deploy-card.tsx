'use client';
// Deploy tab: deploy a VoucherAdapter (implementation, then proxy + initialize) for the loaded
// GameHub. Linking and everything after deployment lives in the GameHub tab (Voucher Adapter card),
// which picks this address up from the same per-chain saved address.
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

export default function VoucherAdapterDeployCard() {
  const { provider, signer, isConnected, address, chainId, hubAddress } = useWeb3();
  const [txStatus, setTxStatus] = useState<TxState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [implAddress, setImplAddress] = useState('');
  const [deployAdmin, setDeployAdmin] = useState('');
  const [deploySenator, setDeploySenator] = useState('');
  const [deploySignNum, setDeploySignNum] = useState('');
  const [deployVoucherNFT, setDeployVoucherNFT] = useState('');
  const [lastAdapter, setLastAdapter] = useState('');
  const senatorSet = useSenators(provider, deploySenator.trim());
  const signNumValue = parseInt(deploySignNum, 10);

  const inputCls = 'w-full mt-0.5 bg-surface-tertiary rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent';
  const primaryBtn = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2.5 rounded-lg text-sm transition-colors';

  useEffect(() => { if (chainId) setLastAdapter(loadVoucherAdapterAddress(chainId)); }, [chainId]);
  // Pre-fill once per network (and the admin once a wallet is connected). Only on a network
  // change - never when a field is emptied, so any field can be edited or cleared freely
  // (an empty VoucherNFT deploys with none; set it later in the GameHub tab).
  const prefilledChain = useRef<number | null>(null);
  const prefilledAdmin = useRef(false);
  useEffect(() => {
    if (address && !prefilledAdmin.current) { setDeployAdmin(address); prefilledAdmin.current = true; }
  }, [address]);
  useEffect(() => {
    if (!chainId || prefilledChain.current === chainId) return;
    prefilledChain.current = chainId;
    // senator + signatures: the same as the legacy Incentive contract on this chain
    setDeploySenator(chainId === 56 ? DEFAULT_SENATOR_ADDRESS_MAINNET : chainId === 97 ? DEFAULT_SENATOR_ADDRESS : '');
    setDeploySignNum(chainId === 56 ? String(DEFAULT_SIGN_NUM_MAINNET) : chainId === 97 ? String(DEFAULT_SIGN_NUM) : '');
    // VoucherNFT: the Voucher V2 tab's address book first, else the deployed one on this chain (optional)
    setDeployVoucherNFT(loadBook(chainId).contracts.VoucherNFT
      || (chainId === 56 ? DEFAULT_VOUCHER_NFT_ADDRESS_MAINNET : chainId === 97 ? DEFAULT_VOUCHER_NFT_ADDRESS : ''));
  }, [chainId]);

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
    if (!isAddr(hubAddress)) {
      setTxStatus({ status: 'error', error: 'Load the GameHub first (Load Existing Contracts below).' });
      return;
    }
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
      saveVoucherAdapterAddress(chainId, proxy.address);
      setLastAdapter(proxy.address);
      setImplAddress('');
      setTxStatus({
        status: 'success',
        hash: proxy.deployTransaction?.hash,
        message: `VoucherAdapter deployed at ${proxy.address}. Next: GameHub tab → Voucher Adapter → "Link to GameHub".`,
      });
    } catch (e: any) {
      setTxStatus({ status: 'error', error: decodeError(e) });
    }
  };

  return (
    <Card title="Deploy VoucherAdapter" icon={<Ticket className="w-5 h-5 text-accent" />}>
      <p className="text-txt-secondary text-sm mb-3">
        One adapter for every operator DSM under the hub at <code className="text-accent">{hubAddress || '(no GameHub loaded)'}</code>:
        Voucher V2 points/payout vouchers and PR-node signed points transfers. Deploy it after <b>Upgrade GameHub</b> (v1.0.6) and{' '}
        <b>Upgrade Fleet</b> (DSM v1.0.8); then link it in the <b>GameHub tab → Voucher Adapter</b>.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-[11px] text-txt-secondary">Admin</label>
          <input value={deployAdmin} onChange={e => setDeployAdmin(e.target.value)} placeholder="0x..." className={inputCls} />
        </div>
        <div>
          <label className="text-[11px] text-txt-secondary">Senator (PR-node multisig)</label>
          <input value={deploySenator} onChange={e => setDeploySenator(e.target.value)} placeholder="0x..." className={inputCls} />
        </div>
        <div>
          <label className="text-[11px] text-txt-secondary">Required PR-node signatures (same as Incentive)</label>
          <input value={deploySignNum} onChange={e => setDeploySignNum(e.target.value)} placeholder="e.g. 18" className={inputCls} />
          {senatorSet && (
            <p className={`text-[11px] mt-0.5 ${signNumValue > senatorSet.senators.length ? 'text-red-400' : 'text-txt-secondary'}`}>
              {senatorSet.senators.length} current senators (PR nodes){signNumValue > 0 ? ` — requires ${signNumValue} of ${senatorSet.senators.length}` : ''}
              {signNumValue > senatorSet.senators.length ? ' — more than exist, transfers would always fail' : ''}
            </p>
          )}
        </div>
        <div>
          <label className="text-[11px] text-txt-secondary">VoucherNFT (optional — can be set later)</label>
          <input value={deployVoucherNFT} onChange={e => setDeployVoucherNFT(e.target.value)} placeholder="empty = points transfers only for now" className={inputCls} />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={deployImplementation} disabled={!isConnected || !hubAddress || !!implAddress} className={primaryBtn + ' flex-1'}>1. Deploy implementation</button>
        <button onClick={deployProxy} disabled={!isConnected || !hubAddress || !implAddress} className={primaryBtn + ' flex-1'}>2. Deploy proxy + initialize</button>
      </div>
      {implAddress && <p className="text-[11px] text-txt-secondary mt-2">Implementation: <code className="text-accent">{implAddress}</code></p>}
      {lastAdapter && (
        <p className="text-[11px] text-txt-secondary mt-2 flex items-center gap-1 break-all">
          Last deployed / loaded on this network: <code className="text-accent">{lastAdapter}</code>
          <button onClick={() => { navigator.clipboard?.writeText?.(lastAdapter); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 hover:text-txt-primary" />}
          </button>
          <a href={getExplorerAddressUrl(chainId, lastAdapter)} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 hover:text-accent" /></a>
        </p>
      )}
      <div className="mt-3"><TxStatus {...txStatus} chainId={chainId} /></div>
    </Card>
  );
}
