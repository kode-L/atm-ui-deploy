'use client';
import { useCallback, useMemo, useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import { ETHERSCAN_API_KEY } from '@/lib/contracts/config';
import { ARTIFACTS, AclSystem, Controller, decodeAclError, nameBook, readAclSystem } from '@/lib/contracts/acl';
import { Ctx, netName } from './shared';

export type TxState = { status: 'idle' | 'pending' | 'success' | 'error'; hash?: string; error?: string; message?: string };

/**
 * Live ACL contract set + the connected wallet, shared by the ACL & Management tab and the ATM
 * Upgrader tab: reads everything from the chain (File → ACL → DAO, proxy admins → Management),
 * sends txs / deploys with the connected wallet and reports them through one toast state.
 */
export function useAclCtx() {
  const { provider, signer, address, chainId, netChainId, isConnected } = useWeb3();
  const ns = netChainId;
  const [s, setS] = useState<AclSystem | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [rev, setRev] = useState(0);
  const [tx, setTx] = useState<TxState>({ status: 'idle' });
  const [apiKey, setApiKey] = useState('');
  const [extraCtl, setExtraCtl] = useState<Record<string, Controller>>({});
  const refresh = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    setLoading(true); setLoadErr('');
    readAclSystem(provider, ns)
      .then((r) => { if (!cancelled) setS(r); })
      .catch((e) => { if (!cancelled) setLoadErr(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [provider, ns, rev]);

  const wrongChain = isConnected && chainId !== ns;
  const fail = (message: string, error: string) => setTx({ status: 'error', message, error });

  const run: Ctx['run'] = useCallback(async (label, send) => {
    if (!signer) { fail(label, 'Connect a wallet first.'); return null; }
    if (wrongChain) { fail(label, `Your wallet is on chain ${chainId}; switch it to ${netName(ns)}.`); return null; }
    setTx({ status: 'pending', message: `${label} — confirm it in your wallet…` });
    try {
      const t = await send();
      setTx({ status: 'pending', hash: t.hash, message: `${label} — confirming on-chain…` });
      const rc = await t.wait();
      if (rc.status === 0) throw new Error('Reverted on-chain');
      setTx({ status: 'success', hash: t.hash, message: `${label} — done` });
      refresh();
      return rc;
    } catch (e: any) {
      fail(`${label} — failed`, decodeAclError(e));
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, wrongChain, chainId, ns, refresh]);

  const deploy: Ctx['deploy'] = useCallback(async (label, name, args = []) => {
    if (!signer) { fail(label, 'Connect a wallet first.'); return ''; }
    if (wrongChain) { fail(label, `Your wallet is on chain ${chainId}; switch it to ${netName(ns)}.`); return ''; }
    setTx({ status: 'pending', message: `${label} — confirm it in your wallet…` });
    try {
      const a = ARTIFACTS[name];
      const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
      setTx({ status: 'pending', hash: c.deployTransaction.hash, message: `${label} — confirming on-chain…` });
      await c.deployed();
      setTx({ status: 'success', hash: c.deployTransaction.hash, message: `${label} — deployed at ${c.address}` });
      refresh();
      return c.address;
    } catch (e: any) {
      fail(`${label} — failed`, decodeAclError(e));
      return '';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, wrongChain, chainId, ns, refresh]);

  const ctx: Ctx | null = useMemo(() => {
    if (!s) return null;
    const controllers = { ...extraCtl, ...s.controllers };
    return {
      s, ns, me: isConnected ? address : '', provider, signer, apiKey: apiKey || ETHERSCAN_API_KEY,
      nameOf: nameBook(s), controllerOf: (a?: string) => (a ? controllers[a.toLowerCase()] : undefined),
      run, deploy, refresh,
    };
  }, [s, ns, isConnected, address, provider, signer, apiKey, extraCtl, run, deploy, refresh]);

  const addController = useCallback((c: Controller) => setExtraCtl((m) => ({ ...m, [c.address.toLowerCase()]: c })), []);

  return { s, ctx, ns, chainId, provider, loading, loadErr, wrongChain, tx, refresh, apiKey, setApiKey, addController };
}
