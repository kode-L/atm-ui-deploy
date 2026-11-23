'use client';
import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { BadgeCheck } from 'lucide-react';
import TxStatus from '@/components/tx-status';
import { ETHERSCAN_API_KEY, getExplorerAddressUrl } from '@/lib/contracts/config';
import { constructorArgsFromCreation, getCreationTxHash, isVerified, verifySource } from '@/lib/contracts/etherscan-verify';

type State = { status: 'idle' | 'pending' | 'success' | 'error'; message?: string; error?: string };

/**
 * Verifies `address` on BscScan from the bundled build (Etherscan V2 API). Constructor arguments
 * are read from the deploy transaction, which also proves the contract was deployed from this
 * exact build. Shows "Verified" when the explorer already has the source. Sends no transaction.
 */
export default function VerifyButton({ chainId, address, name, bytecode, load, apiKey, provider }: {
  chainId: number;
  address: string;
  name: string;                       // shown to the user, e.g. "ATMAccessControl implementation"
  bytecode: string;                   // bundled creation bytecode
  load: () => Promise<{ compilerVersion: string; contractName: string; input: unknown }>;
  apiKey?: string;                    // falls back to NEXT_PUBLIC_ETHERSCAN_API_KEY
  provider: ethers.providers.Provider | null;
}) {
  const key = (apiKey || '').trim() || ETHERSCAN_API_KEY;
  const [verified, setVerified] = useState<boolean | null>(null);
  const [st, setSt] = useState<State>({ status: 'idle' });

  useEffect(() => {
    setVerified(null);
    if (!key || !ethers.utils.isAddress(address)) return;
    let cancelled = false;
    isVerified(chainId, key, address).then((v) => { if (!cancelled) setVerified(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, [chainId, key, address]);

  if (!ethers.utils.isAddress(address)) return null;
  if (verified) {
    return (
      <a href={`${getExplorerAddressUrl(chainId, address)}#code`} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-green-400 hover:underline" title={`${name} source is verified on the explorer`}>
        <BadgeCheck className="w-3.5 h-3.5" /> Verified
      </a>
    );
  }

  const verify = async () => {
    if (!key) { setSt({ status: 'error', message: `Verify ${name}`, error: 'Enter an Etherscan API key at the top of this tab first (one key covers BscScan mainnet and testnet).' }); return; }
    if (!provider) return;
    setSt({ status: 'pending', message: `Verifying ${name} (${address})…` });
    try {
      const hash = await getCreationTxHash(chainId, key, address);
      const tx = await provider.getTransaction(hash);
      if (!tx) throw new Error(`Creation tx ${hash} not found on this network.`);
      const constructorArgs = constructorArgsFromCreation(tx.data, bytecode);
      const bundle = await load();
      const result = await verifySource({
        chainId, apiKey: key, address, constructorArgs,
        contractName: bundle.contractName, compilerVersion: bundle.compilerVersion, input: bundle.input,
        onStatus: (m) => setSt({ status: 'pending', message: `Verifying ${name}: ${m}` }),
      });
      setVerified(true);
      setSt({ status: 'success', message: `${name} verified — ${result}` });
    } catch (e: any) {
      setSt({ status: 'error', message: `Verify ${name} failed`, error: e?.message || String(e) });
    }
  };

  return (
    <>
      <button type="button" onClick={verify} className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40"
        title={`Verify ${name} source on the explorer (no transaction)`}>
        <BadgeCheck className="w-3.5 h-3.5" /> Verify
      </button>
      <TxStatus {...st} />
    </>
  );
}
