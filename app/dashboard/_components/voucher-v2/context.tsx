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

// A multi-transaction action shown as numbered steps (see FlowPanel). Steps can be planned up
// front (beginFlow with labels) or are added automatically as transactions start.
export interface FlowStep { label: string; status: 'todo' | 'pending' | 'done' | 'error'; hash?: string; error?: string; stuck?: boolean; note?: string; key?: string }
export interface Flow { id: number; title: string; steps: FlowStep[] }

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
  // another RewardVault pool (impl + proxy + setName), kept in book.extraPools — never replaces the main one
  deployExtraPool: (name: string, admin: string, impl?: string, accessControl?: string, kind?: PoolKind) => Promise<string>;
  // an implementation for an extra pool — doesn't touch the main contract's pending impl
  deployExtraPoolImpl: (kind?: PoolKind) => Promise<string>;
  // friendly label for a known address: contract/token name from the book, else shortened
  nameOf: (address: string) => string;
  txLog: TxLogEntry[];
  clearTxLog: () => void;
  // bumped after every confirmed tx so tabs know to re-read chain state
  revision: number;
  flow: Flow | null;
  // start a numbered multi-step action; labels = the transactions it will send, in order (optional)
  beginFlow: (title: string, labels?: string[]) => void;
  closeFlow: () => void;
  // look a logged transaction up on-chain by hash (for ones the wallet never reported back)
  recheckTx: (id: number) => Promise<void>;
  // for a step whose wallet popup never answered: look for it on-chain, or ask the wallet again
  stepAction: (key: string, action: 'find' | 'retry') => void;
  // the chain already shows the effect of the tx sent under `label` (before the wallet reported it):
  // mark it done in the log and progress panel; a later wallet timeout won't turn it into an error
  confirmedByChain: (label: string, note?: string) => void;
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
  const [flow, setFlow] = useState<Flow | null>(null);
  const flowRef = useRef<Flow | null>(null);
  const flowIds = useRef(0);
  const putFlow = useCallback((f: Flow | null) => { flowRef.current = f; setFlow(f); }, []);
  const beginFlow = useCallback((title: string, labels: string[] = []) => {
    putFlow({ id: ++flowIds.current, title, steps: labels.map((label) => ({ label, status: 'todo' as const })) });
  }, [putFlow]);
  const closeFlow = useCallback(() => putFlow(null), [putFlow]);
  // a transaction starting: take the next planned step, or add one (new flow if none is running)
  const flowStart = useCallback((label: string): [number, number] => {
    let f = flowRef.current;
    const busy = f && f.steps.some((x) => x.status === 'todo' || x.status === 'pending');
    // a finished or failed action never swallows the next, unrelated transaction
    if (!f || f.steps.some((x) => x.status === 'error') || (!busy && f.steps.length && f.steps.every((x) => x.status === 'done'))) {
      f = { id: ++flowIds.current, title: label, steps: [] };
    }
    const steps = [...f.steps];
    let i = steps.findIndex((x) => x.status === 'todo');
    // a planned step keeps its friendly name; an unplanned tx is added under its own label
    if (i < 0) { steps.push({ label, status: 'pending' }); i = steps.length - 1; } else steps[i] = { ...steps[i], status: 'pending' };
    putFlow({ ...f, steps });
    return [f.id, i];
  }, [putFlow]);
  const flowPatch = useCallback((fid: number, i: number, p: Partial<FlowStep>) => {
    const f = flowRef.current;
    if (!f || f.id !== fid) return;
    const steps = f.steps.map((x, n) => (n === i ? { ...x, ...p } : x));
    putFlow({ ...f, steps });
  }, [putFlow]);
  const txId = useRef(0);
  // txs in flight by label (for confirmedByChain), and the ones the chain already confirmed
  const inFlight = useRef(new Map<string, { id: number; fid: number; i: number }>());
  const chainSettled = useRef(new Set<number>());
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

  // Wallets don't always report back (e.g. a sped-up / replaced tx gets a new hash, or the
  // wallet's own RPC lags), so also poll the chain for the receipt and take whichever answers first.
  const waitMined = useCallback((hash: string, walletWait: () => Promise<ethers.providers.TransactionReceipt>) =>
    new Promise<ethers.providers.TransactionReceipt>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, v: any) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(giveUp);
        ok ? resolve(v) : reject(v);
      };
      const onReceipt = (rc: ethers.providers.TransactionReceipt | null) => {
        if (!rc || rc.blockNumber == null) return;
        if (rc.status === 0) finish(false, Object.assign(new Error('Transaction reverted on-chain'), { receipt: rc }));
        else finish(true, rc);
      };
      walletWait().then(onReceipt).catch((e: any) => {
        if (e?.code === 'TRANSACTION_REPLACED') {
          // sped up in the wallet = same action under a new hash; cancelled = it won't happen
          if (e.cancelled) finish(false, new Error('The transaction was cancelled / replaced in the wallet'));
          else onReceipt(e.receipt);
        } else if (e?.receipt?.status === 0) {
          finish(false, e);
        }
        // anything else (wallet RPC hiccup): keep polling below
      });
      const providers = [reader, signer?.provider].filter(Boolean) as ethers.providers.Provider[];
      const poll = () => providers.forEach((p) => p.getTransactionReceipt(hash).then(onReceipt).catch(() => {}));
      const timer = setInterval(poll, 3000);
      const giveUp = setTimeout(() => finish(false, new Error(`Not confirmed after 10 minutes — check ${hash} on the explorer (Transactions → Check status)`)), 600_000);
    }), [reader, signer]);

  // Some wallets (seen with Brave Wallet) drop or never answer a request that comes right after the
  // previous confirmation, or send it without telling the page. So: leave a short gap, and while
  // waiting, watch the account's nonce — if a tx went out, find it on-chain by nonce. After 25s the
  // step offers "find it" / "ask again" (ask again only if nothing was sent since the step started).
  const lastConfirmedAt = useRef(0);
  const stepControls = useRef(new Map<string, { find: () => void; retry: () => void }>());
  const walletRequest = useCallback(async (
    request: () => Promise<ethers.providers.TransactionResponse>,
    step: { fid: number; i: number; key: string },
  ): Promise<{ hash: string; wait: () => Promise<ethers.providers.TransactionReceipt> }> => {
    if (!signer) throw new Error('Connect a wallet first');
    const from = await signer.getAddress();
    const gap = 1500 - (Date.now() - lastConfirmedAt.current);
    if (gap > 0) await new Promise((res) => setTimeout(res, gap));
    const startNonce: number | null = reader ? await reader.getTransactionCount(from, 'latest').catch(() => null) : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, v: any) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        clearTimeout(nudge);
        stepControls.current.delete(step.key);
        flowPatch(step.fid, step.i, { stuck: false, note: undefined });
        ok ? resolve(v) : reject(v);
      };
      const ask = () => request()
        .then((tx) => finish(true, { hash: tx.hash, wait: () => tx.wait() }))
        .catch((e) => finish(false, e));
      // a tx from this account with the nonce we started at = the one the wallet sent
      const find = async (manual: boolean) => {
        if (settled || startNonce === null || !reader) return false;
        const now = await reader.getTransactionCount(from, 'latest').catch(() => startNonce);
        if (now <= startNonce) {
          if (manual) flowPatch(step.fid, step.i, { note: 'Nothing has been sent from your wallet yet — confirm it in the wallet, or ask the wallet again.' });
          return false;
        }
        const latest = await reader.getBlockNumber();
        for (let b = latest; b >= Math.max(0, latest - 40); b--) {
          const blk = await reader.getBlockWithTransactions(b).catch(() => null);
          const t = blk?.transactions.find((x) => sameAddr(x.from, from) && x.nonce === startNonce);
          if (t) {
            finish(true, { hash: t.hash, wait: () => reader.waitForTransaction(t.hash) });
            return true;
          }
        }
        if (manual) flowPatch(step.fid, step.i, { note: 'Your wallet did send something, but it is not in the recent blocks yet — try again in a moment.' });
        return false;
      };
      const watch = setInterval(() => { find(false); }, 4000);
      const nudge = setTimeout(() => flowPatch(step.fid, step.i, { stuck: true }), 25_000);
      stepControls.current.set(step.key, {
        find: () => { find(true); },
        retry: async () => {
          const now = startNonce !== null && reader ? await reader.getTransactionCount(from, 'latest').catch(() => startNonce) : startNonce;
          if (startNonce !== null && now !== null && now > startNonce) { find(true); return; } // it was sent — don't send twice
          flowPatch(step.fid, step.i, { stuck: false, note: 'Asked the wallet again — check for a new popup.' });
          ask();
        },
      });
      ask();
    });
  }, [signer, reader, flowPatch]);

  const stepAction = useCallback((key: string, action: 'find' | 'retry') => {
    stepControls.current.get(key)?.[action]();
  }, []);

  const track = useCallback(async <T,>(
    label: string,
    run: (onHash: (h: string) => void, step: { fid: number; i: number; key: string }) => Promise<T>,
    meta: { to?: string; deployedFrom?: (result: T) => string } = {},
  ): Promise<T> => {
    const id = ++txId.current;
    const [fid, fstep] = flowStart(label);
    const stepRef = { fid, i: fstep, key: `${fid}:${fstep}:${id}` };
    flowPatch(fid, fstep, { key: stepRef.key });
    const patch = (p: Partial<TxLogEntry>) => {
      updateLog((log) => log.map((e) => (e.id === id ? { ...e, ...p } : e)));
      if (p.hash) flowPatch(fid, fstep, { hash: p.hash });
    };
    updateLog((log) => [{ id, label, status: 'pending' as const, to: meta.to, at: new Date().toISOString() }, ...log].slice(0, TX_LOG_MAX));
    inFlight.current.set(label, { id, fid, i: fstep });
    try {
      const result = await run((hash) => patch({ hash }), stepRef);
      inFlight.current.delete(label);
      lastConfirmedAt.current = Date.now();
      patch({ status: 'success', ...(meta.deployedFrom ? { deployed: meta.deployedFrom(result) } : {}) });
      flowPatch(fid, fstep, { status: 'done' });
      setRevision((r) => r + 1);
      return result;
    } catch (e: any) {
      inFlight.current.delete(label);
      const error = decodeVoucherError(e);
      // already confirmed from the chain (e.g. the wallet timed out later): keep it as done
      if (!chainSettled.current.has(id)) {
        patch({ status: 'error', error });
        flowPatch(fid, fstep, { status: 'error', error });
      }
      throw new Error(error);
    }
  }, [updateLog, flowStart, flowPatch]);

  const confirmedByChain = useCallback((label: string, note?: string) => {
    const t = inFlight.current.get(label);
    if (!t) return;
    inFlight.current.delete(label);
    chainSettled.current.add(t.id);
    updateLog((log) => log.map((e) => (e.id === t.id ? { ...e, status: 'success' as const, ...(note ? { error: undefined, label: `${e.label} — ${note}` } : {}) } : e)));
    flowPatch(t.fid, t.i, { status: 'done' });
    setRevision((r) => r + 1);
  }, [updateLog, flowPatch]);

  // Estimate first so a revert shows its decoded reason instead of costing a failed tx,
  // then send with a 25% buffer (same idea as lib/contracts/gas.ts).
  const send = useCallback((label: string, contract: ethers.Contract, method: string, args: any[], overrides: ethers.PayableOverrides = {}) =>
    track(label, async (onHash, step) => {
      const { gasLimit: minGas, ...rest } = overrides;
      const estimated = await contract.estimateGas[method](...args, rest);
      // a passed gasLimit is a floor, not a replacement: VoucherDAO's auto-execute runs inside a
      // try/catch, so the estimate can land on a limit where the inner mint fails silently
      let gasLimit = estimated.mul(125).div(100);
      const floor = minGas ? ethers.BigNumber.from(await minGas) : null;
      if (floor && gasLimit.lt(floor)) gasLimit = floor;
      const sent = await walletRequest(() => contract[method](...args, { ...rest, gasLimit }), step);
      onHash(sent.hash);
      return waitMined(sent.hash, sent.wait);
    }, { to: contract.address }), [track, waitMined, walletRequest]);

  const sendValue = useCallback((label: string, to: string, value: string) =>
    track(label, async (onHash, step) => {
      if (!signer) throw new Error('Connect a wallet first');
      const sent = await walletRequest(() => signer.sendTransaction({ to, value }), step);
      onHash(sent.hash);
      return waitMined(sent.hash, sent.wait);
    }, { to }), [track, signer, waitMined, walletRequest]);

  const deployRaw = useCallback((key: string, args: any[], label: string) =>
    track(label, async (onHash, step) => {
      if (!signer) throw new Error('Connect a wallet first');
      const { abi, bytecode } = ARTIFACTS[key];
      const tx = new ethers.ContractFactory(abi, bytecode, signer).getDeployTransaction(...args);
      const sent = await walletRequest(() => signer.sendTransaction(tx), step);
      onHash(sent.hash);
      const rc = await waitMined(sent.hash, sent.wait);
      if (!rc.contractAddress) throw new Error('Deployment receipt has no contract address');
      return ethers.utils.getAddress(rc.contractAddress);
    }, { deployedFrom: (a) => a }), [track, signer, waitMined, walletRequest]);

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

  const deployExtraPoolImpl = useCallback((kind: PoolKind = 'RewardVault') => deployRaw(kind, [], `Deploy ${kind} implementation (extra pool)`), [deployRaw]);

  // impl: an existing RewardVault implementation (auto-filled / pasted) — many pools can share one
  // RewardVault and VoucherSettlement share initialize(admin, nft, name, accessControl)
  const deployExtraPool = useCallback(async (name: string, admin: string, implIn?: string, accessControl?: string, kind: PoolKind = 'RewardVault') => {
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
    updateBook((b) => ({ ...b, extraPools: [...(b.extraPools || []), { name, address: proxy, implementation: impl, kind }] }));
    return proxy;
  }, [deployRaw, updateBook, reader]);

  const deployPlain = useCallback(async (key: ContractKey, ctorArgs: any[]) => {
    const addr = await deployRaw(key, ctorArgs, `Deploy ${key}`);
    updateBook((b) => ({ ...b, contracts: { ...b.contracts, [key]: addr } }));
    return addr;
  }, [deployRaw, updateBook]);

  const recheckTx = useCallback(async (id: number) => {
    const e = txLog.find((x) => x.id === id);
    if (!e?.hash) return;
    const providers = [reader, signer?.provider].filter(Boolean) as ethers.providers.Provider[];
    for (const p of providers) {
      const rc = await p.getTransactionReceipt(e.hash).catch(() => null);
      if (rc && rc.blockNumber != null) {
        updateLog((log) => log.map((x) => (x.id === id ? { ...x, status: rc.status === 0 ? 'error' : 'success', error: rc.status === 0 ? 'Reverted on-chain' : undefined, deployed: x.deployed || rc.contractAddress || undefined } : x)));
        setRevision((r) => r + 1);
        return;
      }
    }
    updateLog((log) => log.map((x) => (x.id === id ? { ...x, error: 'Not found on-chain yet — still pending, dropped, or replaced (sped up) in the wallet' } : x)));
  }, [txLog, reader, signer, updateLog]);

  const nameOf = useCallback((a: string) => {
    if (!a || sameAddr(a, ZERO)) return 'none';
    for (const [k, v] of Object.entries(book.contracts)) if (sameAddr(v, a)) return k;
    for (const x of book.extraPools || []) if (sameAddr(x.address, a)) return `${poolKind(x)} "${x.name}"`;
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
    deployExtraPool,
    deployExtraPoolImpl,
    nameOf,
    txLog,
    clearTxLog: () => updateLog(() => []),
    revision,
    typeId,
    setTypeId,
    flow,
    beginFlow,
    closeFlow,
    recheckTx,
    stepAction,
    confirmedByChain,
  }), [address, chainId, signer, reader, book, setAddress, setToken, replaceBook, markExported, read, write, send, sendValue, deployProxy, deployImpl, setPendingImpl, deployPlain, deployExtraPool, deployExtraPoolImpl, nameOf, txLog, updateLog, revision, typeId, flow, beginFlow, closeFlow, recheckTx, stepAction, confirmedByChain]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
