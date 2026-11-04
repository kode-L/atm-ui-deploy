import { ethers } from 'ethers';

// Wallet-level batching (EIP-5792 wallet_sendCalls). The wallet executes every call FROM the
// user's own address — on EIP-7702 smart accounts (e.g. MetaMask) usually as one atomic tx —
// so contracts that check msg.sender (like Link/Factory) still see the user. A multicall
// contract can't do that: it would become msg.sender itself.
//
// Handles both the final spec (version "2.0.0": numeric status, `atomic` capability) and the
// older draft (version "1.0": string status, `atomicBatch` capability) that some wallets still speak.

export interface BatchCall { to: string; data: string; value?: ethers.BigNumber }
export interface BatchSupport { supported: boolean; atomic: boolean; detail: string }
export interface BatchReceipt { status: boolean; transactionHash: string; logs: { address: string; topics: string[]; data: string }[] }
export interface BatchResult { ok: boolean; receipts: BatchReceipt[]; message: string }

const rpcOf = (signer: ethers.Signer) => {
  const p = signer.provider as ethers.providers.Web3Provider | undefined;
  if (!p || typeof p.send !== 'function') throw new Error('wallet provider does not accept raw RPC calls');
  return p;
};
const hex = (n: number) => ethers.utils.hexValue(n);

export async function getBatchSupport(signer: ethers.Signer, address: string, chainId: number): Promise<BatchSupport> {
  let caps: any;
  try {
    const rpc = rpcOf(signer);
    caps = await rpc.send('wallet_getCapabilities', [address, [hex(chainId)]]).catch(() => rpc.send('wallet_getCapabilities', [address]));
  } catch (e: any) {
    return { supported: false, atomic: false, detail: 'wallet does not support EIP-5792 batching' };
  }
  const forChain = caps?.[hex(chainId)] || caps?.[`0x${chainId.toString(16)}`] || caps?.[String(chainId)] || caps?.['0x0'] || {};
  const status = forChain?.atomic?.status;
  const atomic = status === 'supported' || status === 'ready' || forChain?.atomicBatch?.supported === true;
  return {
    supported: true,
    atomic,
    detail: atomic
      ? status === 'ready' ? 'atomic batching (wallet will offer to upgrade to a smart account first)' : 'atomic batching'
      : 'batching (wallet may send the calls as separate txs after one confirmation)',
  };
}

export async function sendBatch(signer: ethers.Signer, from: string, chainId: number, calls: BatchCall[]): Promise<string> {
  const rpc = rpcOf(signer);
  const c = calls.map((x) => ({ to: x.to, data: x.data, value: ethers.utils.hexValue(x.value || 0) }));
  try {
    const r = await rpc.send('wallet_sendCalls', [{ version: '2.0.0', from, chainId: hex(chainId), atomicRequired: false, calls: c }]);
    return typeof r === 'string' ? r : r?.id;
  } catch (e: any) {
    // Rejections are final; anything else may be a v1-only wallet refusing the v2 shape.
    if (e?.code === 4001 || /reject|denied/i.test(e?.message || '')) throw e;
    const r = await rpc.send('wallet_sendCalls', [{ version: '1.0', from, chainId: hex(chainId), calls: c }]);
    return typeof r === 'string' ? r : r?.id;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForBatch(signer: ethers.Signer, id: string, timeoutMs = 10 * 60_000): Promise<BatchResult> {
  const rpc = rpcOf(signer);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let s: any;
    try { s = await rpc.send('wallet_getCallsStatus', [id]); } catch { await sleep(2500); continue; }
    const st = s?.status;
    const pending = st === 100 || st === 'PENDING' || st === 'pending';
    if (!pending && st !== undefined) {
      const receipts: BatchReceipt[] = (s.receipts || []).map((r: any) => ({
        status: r.status === '0x1' || r.status === 1 || r.status === 'success',
        transactionHash: r.transactionHash,
        logs: r.logs || [],
      }));
      const ok = st === 200 || st === 'CONFIRMED' || st === 'confirmed';
      const message = ok ? 'confirmed' : st === 400 ? 'wallet did not submit the batch' : st === 500 ? 'batch reverted on-chain' : st === 600 ? 'batch partially reverted' : `batch status ${st}`;
      return { ok, receipts, message };
    }
    await sleep(2500);
  }
  return { ok: false, receipts: [], message: `timed out waiting for batch ${id} — check your wallet activity` };
}
