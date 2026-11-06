// Safe Transaction Service (read-only, no API key): follows a tx a Safe queued for us, so the page can
// show "1/2 signatures", "ready to execute", "executed" and get the real on-chain tx hash.
// Only BSC mainnet: the service has no BSC testnet route. Everything here is a convenience on top of
// the on-chain checks, which stay the source of truth — any failure just returns null.

const SERVICE: Record<number, { base: string; prefix: string }> = {
  56: { base: 'https://api.safe.global/tx-service/bnb', prefix: 'bnb' },
};

export const safeApiSupported = (chainId: number) => !!SERVICE[chainId];

export type SafeTxState = 'awaiting' | 'ready' | 'executed' | 'failed' | 'replaced' | 'unknown';
export interface SafeTxStatus {
  state: SafeTxState;
  confirmations: number;
  required: number;
  txHash: string | null; // the real on-chain tx, once executed
  nonce: number;
}

const getJson = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Safe API ${res.status}`);
  return res.json();
};

const safeNonce = new Map<string, { nonce: number; at: number }>(); // per Safe, cached 10s

/** Status of one queued Safe tx by its safeTxHash; null when unknown / not on this chain / API down. */
export async function getSafeTx(chainId: number, safe: string, safeTxHash: string): Promise<SafeTxStatus | null> {
  const svc = SERVICE[chainId];
  if (!svc || !/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) return null;
  try {
    const tx = await getJson(`${svc.base}/api/v1/multisig-transactions/${safeTxHash}/`);
    if (!tx) return null;
    const confirmations = Array.isArray(tx.confirmations) ? tx.confirmations.length : 0;
    const required = Number(tx.confirmationsRequired ?? 0);
    const nonce = Number(tx.nonce);
    if (tx.isExecuted) {
      return { state: tx.isSuccessful === false ? 'failed' : 'executed', confirmations, required, txHash: tx.transactionHash ?? null, nonce };
    }
    // another tx with the same nonce ran (rejected / replaced in Safe{Wallet}): this one never will
    const key = safe.toLowerCase();
    let cur = safeNonce.get(key);
    if (!cur || Date.now() - cur.at > 10_000) {
      const info = await getJson(`${svc.base}/api/v1/safes/${safe}/`);
      cur = { nonce: Number(info?.nonce ?? -1), at: Date.now() };
      safeNonce.set(key, cur);
    }
    if (cur.nonce > nonce) return { state: 'replaced', confirmations, required, txHash: null, nonce };
    return { state: required > 0 && confirmations >= required ? 'ready' : 'awaiting', confirmations, required, txHash: null, nonce };
  } catch {
    return null;
  }
}

export const safeTxUrl = (chainId: number, safe: string, safeTxHash: string) => {
  const svc = SERVICE[chainId];
  return svc ? `https://app.safe.global/transactions/tx?safe=${svc.prefix}:${safe}&id=multisig_${safe}_${safeTxHash}` : null;
};

export const safeTxLabel = (s: SafeTxStatus) =>
  s.state === 'awaiting' ? `Safe: ${s.confirmations}/${s.required} signatures`
    : s.state === 'ready' ? `Safe: ${s.confirmations}/${s.required} signed — ready to execute`
    : s.state === 'executed' ? 'Safe: executed'
    : s.state === 'failed' ? 'Safe: executed but the tx failed'
    : s.state === 'replaced' ? 'Safe: rejected / replaced — will not run'
    : 'Safe: unknown';

/**
 * Does this account only queue transactions (a Safe / smart-contract wallet) instead of sending them?
 * An EOA upgraded with EIP-7702 (e.g. MetaMask smart account) also has code — 0xef0100 + delegate —
 * but still sends real transactions, so it counts as a normal wallet.
 */
export async function isQueuingWallet(provider: { getCode: (a: string) => Promise<string> }, account: string): Promise<boolean> {
  const code = (await provider.getCode(account).catch(() => '0x')) || '0x';
  if (code === '0x') return false;
  if (code.toLowerCase().startsWith('0xef0100')) return false; // EIP-7702 delegated EOA
  return true;
}
