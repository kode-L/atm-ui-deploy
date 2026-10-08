'use client';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import {
  ARTIFACTS, Book, ContractKey, PoolKind, ZERO, emptyBook, poolKind, loadBook, saveBook, decodeVoucherError, sameAddr, shortAddr,
} from '@/lib/contracts/voucher-v2';

export interface TxLogEntry {
  id: number;
  label: string;
  // 'unknown': was still pending when the page closed — check the hash on the explorer
  status: 'pending' | 'success' | 'error' | 'unknown';
  hash?: string;
  // contract the tx was sent to (calls) — for deploys, the newly created contract
  to?: string;
  deployed?: string;
  error?: string;
  at: string; // ISO timestamp
}

// Kept per chain in localStorage so the hashes + deployed addresses survive reloads.
const TX_LOG_MAX = 500;
const txLogKey = (chainId: number) => `dg_voucherV2TxLog:${chainId}`;
function loadTxLog(chainId: number): TxLogEntry[] {
  try {
    const raw = localStorage.getItem(txLogKey(chainId));
    if (!raw) return [];
    return (JSON.parse(raw) as TxLogEntry[]).map((e) => (e.status === 'pending' ? { ...e, status: 'unknown' as const } : e));
  } catch {
    return [];
  }
}
function saveTxLog(chainId: number, log: TxLogEntry[]) {
  try {
    localStorage.setItem(txLogKey(chainId), JSON.stringify(log));
  } catch {
    // storage unavailable — the log still works for this session
  }
}

interface VoucherV2Ctx {
  account: string;
  chainId: number;
  signer: ethers.Signer | null;
  reader: ethers.providers.Provider | null;
  book: Book;
  // latest book, including updates made earlier in the same async flow (e.g. "Deploy all")
  getBook: () => Book;
  setAddress: (key: ContractKey, address: string) => void;
  setToken: (name: string, address: string | null) => void;
  replaceBook: (b: Book) => void;
  // call after the user downloads the address book, so the "not backed up" warning clears
  markExported: () => void;
  read: (key: ContractKey, address?: string) => ethers.Contract;
  write: (key: ContractKey, address?: string) => ethers.Contract;
  send: (label: string, contract: ethers.Contract, method: string, args: any[], overrides?: ethers.PayableOverrides) => Promise<ethers.ContractReceipt>;
  sendValue: (label: string, to: string, value: string) => Promise<ethers.providers.TransactionReceipt>;
  // impl: use this implementation instead of the pending/new one (pasted or from step 1)
  deployProxy: (key: ContractKey, initArgs: any[], impl?: string) => Promise<string>;
  // step 1 on its own: deploy the implementation and park it in pendingImpl for the proxy step
  deployImpl: (key: ContractKey) => Promise<string>;
  setPendingImpl: (key: ContractKey, address: string | null) => void;
  deployPlain: (key: ContractKey, ctorArgs: any[]) => Promise<string>;
  // another RewardSink pool (impl + proxy + setName), kept in book.extraSinks — never replaces the main one
  deployExtraSink: (name: string, admin: string, impl?: string, accessControl?: string, kind?: PoolKind) => Promise<string>;
  // an implementation for an extra pool — doesn't touch the main contract's pending impl
  deployExtraSinkImpl: (kind?: PoolKind) => Promise<string>;
  // friendly label for a known address: contract/token name from the book, else shortened
  nameOf: (address: string) => string;
  txLog: TxLogEntry[];
  clearTxLog: () => void;
  // bumped after every confirmed tx so tabs know to re-read chain state
  revision: number;
  // the voucher type being worked on, shared by the Types / Roles / DAO tabs (-1 = none picked)
  typeId: number;
  setTypeId: (id: number) => void;
}

const Ctx = createContext<VoucherV2Ctx | null>(null);

export function useVoucherV2() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useVoucherV2 must be used inside <VoucherV2Provider>');
  return c;
}

export function VoucherV2Provider({ children }: { children: React.ReactNode }) {
  const { provider, signer, address, chainId: walletChainId, netChainId } = useWeb3();
  const chainId = walletChainId || netChainId;
  const [book, setBook] = useState<Book>(emptyBook());
  const bookRef = useRef(book);
  const [txLog, setTxLog] = useState<TxLogEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const [typeId, setTypeId] = useState(-1);
  const txId = useRef(0);
  const chainRef = useRef(chainId);
  // every log change is written straight to this chain's storage key (idempotent, so safe in an updater)
  const updateLog = useCallback((fn: (log: TxLogEntry[]) => TxLogEntry[]) => {
    setTxLog((log) => {
      const next = fn(log);
      saveTxLog(chainRef.current, next);
      return next;
    });
  }, []);

  useEffect(() => {
    const b = loadBook(chainId);
    bookRef.current = b;
    setBook(b);
    const log = loadTxLog(chainId);
    txId.current = log.reduce((m, e) => Math.max(m, e.id), 0);
    chainRef.current = chainId;
    setTxLog(log);
    setTypeId(-1); // type ids are per deployment / chain
  }, [chainId]);

  // deployProxy() updates the book twice in one flow — go through a ref so the second
  // update never overwrites the first with a stale copy.
  const updateBook = useCallback((fn: (b: Book) => Book, touch = true) => {
    const next = fn(bookRef.current);
    if (touch) next.lastChangeAt = new Date().toISOString();
    bookRef.current = next;
    saveBook(chainId, next);
    setBook(next);
  }, [chainId]);

  const setAddress = useCallback((key: ContractKey, addr: string) => {
    updateBook((b) => {
      const contracts = { ...b.contracts };
      if (addr) contracts[key] = ethers.utils.getAddress(addr.trim());
      else delete contracts[key];
      return { ...b, contracts };
    });
    setRevision((r) => r + 1);
  }, [updateBook]);

  const setToken = useCallback((name: string, addr: string | null) => {
    updateBook((b) => {
      const tokens = { ...b.tokens };
      if (addr) tokens[name] = ethers.utils.getAddress(addr.trim());
      else delete tokens[name];
      return { ...b, tokens };
    });
  }, [updateBook]);

  // An import counts as already backed up (it came from a file); a clear has nothing to back up.
  const replaceBook = useCallback((b: Book) => {
    const now = new Date().toISOString();
    updateBook(() => ({ ...b, lastChangeAt: now, lastExportAt: now }), false);
    setRevision((r) => r + 1);
  }, [updateBook]);

  const markExported = useCallback(() => {
    updateBook((b) => ({ ...b, lastExportAt: new Date().toISOString() }), false);
  }, [updateBook]);

  // Reads go through the app's multi-RPC fallback provider when the chain is one it knows
  // (BSC testnet/mainnet), else straight through the wallet (e.g. a local hardhat node).
  // The fallback provider is always for testnet or mainnet, so a wallet on any other chain
  // (walletChainId !== netChainId) must read through the wallet, or reads hit the wrong chain.
  const onKnownChain = !walletChainId || walletChainId === netChainId;
  const reader = (onKnownChain ? provider : null) ?? signer?.provider ?? null;

  const read = useCallback((key: ContractKey, addr?: string) => {
    const at = addr || bookRef.current.contracts[key];
    if (!at) throw new Error(`${key} has no address yet — deploy it or set it on the Overview tab`);
    if (!reader) throw new Error('Connect a wallet first');
    return new ethers.Contract(at, ARTIFACTS[key].abi, reader);
  }, [reader]);

  const write = useCallback((key: ContractKey, addr?: string) => {
    const at = addr || bookRef.current.contracts[key];
    if (!at) throw new Error(`${key} has no address yet — deploy it or set it on the Overview tab`);
    if (!signer) throw new Error('Connect a wallet first');
    return new ethers.Contract(at, ARTIFACTS[key].abi, signer);
  }, [signer]);

  const track = useCallback(async <T,>(
    label: string,
    run: (onHash: (h: string) => void) => Promise<T>,
    meta: { to?: string; deployedFrom?: (result: T) => string } = {},
  ): Promise<T> => {
    const id = ++txId.current;
    const patch = (p: Partial<TxLogEntry>) => updateLog((log) => log.map((e) => (e.id === id ? { ...e, ...p } : e)));
    updateLog((log) => [{ id, label, status: 'pending' as const, to: meta.to, at: new Date().toISOString() }, ...log].slice(0, TX_LOG_MAX));
    try {
      const result = await run((hash) => patch({ hash }));
      patch({ status: 'success', ...(meta.deployedFrom ? { deployed: meta.deployedFrom(result) } : {}) });
      setRevision((r) => r + 1);
      return result;
    } catch (e: any) {
      const error = decodeVoucherError(e);
      patch({ status: 'error', error });
      throw new Error(error);
    }
  }, [updateLog]);

  // Estimate first so a revert shows its decoded reason instead of costing a failed tx,
  // then send with a 25% buffer (same idea as lib/contracts/gas.ts).
  const send = useCallback((label: string, contract: ethers.Contract, method: string, args: any[], overrides: ethers.PayableOverrides = {}) =>
    track(label, async (onHash) => {
      const { gasLimit: minGas, ...rest } = overrides;
      const estimated = await contract.estimateGas[method](...args, rest);
      // a passed gasLimit is a floor, not a replacement: VoucherDAO's auto-execute runs inside a
      // try/catch, so the estimate can land on a limit where the inner mint fails silently
      let gasLimit = estimated.mul(125).div(100);
      const floor = minGas ? ethers.BigNumber.from(await minGas) : null;
      if (floor && gasLimit.lt(floor)) gasLimit = floor;
      const tx: ethers.ContractTransaction = await contract[method](...args, { ...rest, gasLimit });
      onHash(tx.hash);
      return tx.wait();
    }, { to: contract.address }), [track]);

  const sendValue = useCallback((label: string, to: string, value: string) =>
    track(label, async (onHash) => {
      if (!signer) throw new Error('Connect a wallet first');
      const tx = await signer.sendTransaction({ to, value });
      onHash(tx.hash);
      return tx.wait();
    }, { to }), [track, signer]);

  const deployRaw = useCallback((key: string, args: any[], label: string) =>
    track(label, async (onHash) => {
      if (!signer) throw new Error('Connect a wallet first');
      const { abi, bytecode } = ARTIFACTS[key];
      const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
      onHash(c.deployTransaction.hash);
      await c.deployed();
      return ethers.utils.getAddress(c.address);
    }, { deployedFrom: (a) => a }), [track, signer]);

  const setPendingImpl = useCallback((key: ContractKey, addr: string | null) => {
    updateBook((b) => {
      const pendingImpl = { ...b.pendingImpl };
      if (addr) pendingImpl[key] = ethers.utils.getAddress(addr.trim());
      else delete pendingImpl[key];
      return { ...b, pendingImpl };
    });
  }, [updateBook]);

  const deployImpl = useCallback(async (key: ContractKey) => {
    const impl = await deployRaw(key, [], `Deploy ${key} implementation`);
    setPendingImpl(key, impl);
    return impl;
  }, [deployRaw, setPendingImpl]);

  // UUPS = implementation + ERC1967Proxy(impl, initialize(...) calldata), the same layout
  // hardhat-upgrades' deployProxy() produces. The implementation is saved before the proxy
  // tx, so a failed/abandoned second step resumes instead of redeploying the implementation.
  const deployProxy = useCallback(async (key: ContractKey, initArgs: any[], implOverride?: string) => {
    let impl = implOverride ? ethers.utils.getAddress(implOverride.trim()) : bookRef.current.pendingImpl[key];
    if (impl) {
      const code = reader ? await reader.getCode(impl) : '0x';
      if (!code || code === '0x') throw new Error(`No contract code at implementation ${impl} on this network`);
      if (!sameAddr(impl, bookRef.current.pendingImpl[key])) setPendingImpl(key, impl);
    } else {
      impl = await deployImpl(key);
    }
    const initData = new ethers.utils.Interface(ARTIFACTS[key].abi).encodeFunctionData('initialize', initArgs);
    const proxy = await deployRaw('ERC1967Proxy', [impl, initData], `Deploy ${key} proxy`);
    const implAddr = impl;
    updateBook((b) => {
      const pendingImpl = { ...b.pendingImpl };
      delete pendingImpl[key];
      return {
        ...b,
        pendingImpl,
        contracts: { ...b.contracts, [key]: proxy },
        implementations: { ...b.implementations, [key]: implAddr },
        deployedAt: b.deployedAt || new Date().toISOString(),
      };
    });
    return proxy;
  }, [deployRaw, deployImpl, setPendingImpl, updateBook, reader]);

  const deployExtraSinkImpl = useCallback((kind: PoolKind = 'RewardSink') => deployRaw(kind, [], `Deploy ${kind} implementation (extra pool)`), [deployRaw]);

  // impl: an existing RewardSink implementation (auto-filled / pasted) — many pools can share one
  // RewardSink and VoucherIncentive share initialize(admin, nft, name, accessControl)
  const deployExtraSink = useCallback(async (name: string, admin: string, implIn?: string, accessControl?: string, kind: PoolKind = 'RewardSink') => {
    const nft = bookRef.current.contracts.VoucherNFT;
    if (!nft) throw new Error(`Deploy VoucherNFT first — every ${kind} is tied to one VoucherNFT`);
    let impl = implIn ? ethers.utils.getAddress(implIn.trim()) : '';
    if (impl) {
      const code = reader ? await reader.getCode(impl) : '0x';
      if (!code || code === '0x') throw new Error(`No contract code at implementation ${impl} on this network`);
    } else {
      impl = await deployRaw(kind, [], `Deploy ${kind} "${name}" implementation`);
    }
    // name + access control (blank = off) go straight into initialize(admin, nft, name, accessControl)
    const acl = accessControl && accessControl.trim() ? ethers.utils.getAddress(accessControl.trim()) : ZERO;
    if (acl !== ZERO && reader && (await reader.getCode(acl)) === '0x') throw new Error(`No contract code at access control ${acl} on this network`);
    const initData = new ethers.utils.Interface(ARTIFACTS[kind].abi).encodeFunctionData('initialize', [admin, nft, name, acl]);
    const proxy = await deployRaw('ERC1967Proxy', [impl, initData], `Deploy ${kind} "${name}" proxy`);
    updateBook((b) => ({ ...b, extraSinks: [...(b.extraSinks || []), { name, address: proxy, implementation: impl, kind }] }));
    return proxy;
  }, [deployRaw, updateBook, reader]);

  const deployPlain = useCallback(async (key: ContractKey, ctorArgs: any[]) => {
    const addr = await deployRaw(key, ctorArgs, `Deploy ${key}`);
    updateBook((b) => ({ ...b, contracts: { ...b.contracts, [key]: addr } }));
    return addr;
  }, [deployRaw, updateBook]);

  const nameOf = useCallback((a: string) => {
    if (!a || sameAddr(a, ZERO)) return 'none';
    for (const [k, v] of Object.entries(book.contracts)) if (sameAddr(v, a)) return k;
    for (const x of book.extraSinks || []) if (sameAddr(x.address, a)) return `${poolKind(x)} "${x.name}"`;
    for (const [k, v] of Object.entries(book.tokens)) if (sameAddr(v, a)) return k;
    if (sameAddr(a, address)) return 'connected wallet';
    return shortAddr(a);
  }, [book, address]);

  const value = useMemo<VoucherV2Ctx>(() => ({
    account: address,
    chainId,
    signer,
    reader,
    book,
    getBook: () => bookRef.current,
    setAddress,
    setToken,
    replaceBook,
    markExported,
    read,
    write,
    send,
    sendValue,
    deployProxy,
    deployImpl,
    setPendingImpl,
    deployPlain,
    deployExtraSink,
    deployExtraSinkImpl,
    nameOf,
    txLog,
    clearTxLog: () => updateLog(() => []),
    revision,
    typeId,
    setTypeId,
  }), [address, chainId, signer, reader, book, setAddress, setToken, replaceBook, markExported, read, write, send, sendValue, deployProxy, deployImpl, setPendingImpl, deployPlain, deployExtraSink, deployExtraSinkImpl, nameOf, txLog, updateLog, revision, typeId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
