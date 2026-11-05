// Source-code verification through the Etherscan V2 API (one key covers BscScan mainnet and
// testnet via chainid). Called straight from the browser: the API allows any origin. The API
// key is supplied by the admin at runtime and never bundled into the build.
const API = 'https://api.etherscan.io/v2/api';

type ApiResponse = { status: string; message: string; result: any };

async function call(chainId: number, apiKey: string, params: Record<string, string>, post = false): Promise<ApiResponse> {
  const body = new URLSearchParams({ ...params, apikey: apiKey });
  const res = post
    ? await fetch(`${API}?chainid=${chainId}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    : await fetch(`${API}?chainid=${chainId}&${body.toString()}`);
  if (!res.ok) throw new Error(`Etherscan API HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isAlreadyVerified = (s: string) => /already verified/i.test(s);

/** True when the address already has verified source on the explorer. */
export async function isVerified(chainId: number, apiKey: string, address: string): Promise<boolean> {
  const r = await call(chainId, apiKey, { module: 'contract', action: 'getsourcecode', address });
  return r.status === '1' && !!r.result?.[0]?.SourceCode;
}

/** Hash of the transaction that created `address`. */
export async function getCreationTxHash(chainId: number, apiKey: string, address: string): Promise<string> {
  const r = await call(chainId, apiKey, { module: 'contract', action: 'getcontractcreation', contractaddresses: address });
  const hash = r.status === '1' ? r.result?.[0]?.txHash : undefined;
  if (!hash) throw new Error(`Could not find the creation tx for ${address}: ${typeof r.result === 'string' ? r.result : r.message}`);
  return hash;
}

/**
 * Splits a creation tx's input into the compiled bytecode and the ABI-encoded constructor
 * args. Fails if the deployment was not made from this exact build, since the explorer
 * would reject the verification anyway.
 */
export function constructorArgsFromCreation(txData: string, bytecode: string): string {
  const data = txData.toLowerCase(), code = bytecode.toLowerCase();
  if (!data.startsWith(code)) throw new Error('Deployed bytecode does not match the bundled build — it was deployed from a different compile, so it cannot be verified from this UI.');
  return data.slice(code.length);
}

/** Submits standard-JSON verification and polls until it passes or fails. */
export async function verifySource(opts: {
  chainId: number; apiKey: string; address: string; contractName: string; compilerVersion: string;
  input: unknown; constructorArgs?: string; onStatus?: (msg: string) => void;
}): Promise<string> {
  const { chainId, apiKey, address, onStatus } = opts;
  const submit = await call(chainId, apiKey, {
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: JSON.stringify(opts.input),
    codeformat: 'solidity-standard-json-input',
    contractname: opts.contractName,
    compilerversion: opts.compilerVersion,
    // the API's own spelling
    constructorArguements: (opts.constructorArgs ?? '').replace(/^0x/, ''),
  }, true);
  if (submit.status !== '1') {
    if (isAlreadyVerified(String(submit.result))) return 'Already verified';
    throw new Error(String(submit.result || submit.message));
  }
  const guid = String(submit.result);
  // the explorer may take a few seconds to see a freshly deployed contract and compile it
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const r = await call(chainId, apiKey, { module: 'contract', action: 'checkverifystatus', guid });
    const msg = String(r.result);
    if (/pending/i.test(msg)) { onStatus?.(msg); continue; }
    if (r.status === '1' || isAlreadyVerified(msg)) return msg;
    throw new Error(msg);
  }
  throw new Error(`Still pending after 2 minutes (guid ${guid}). Check the explorer later.`);
}

/** Marks `proxy` as a proxy on the explorer so "Read/Write as Proxy" shows the implementation's ABI. */
export async function linkProxy(opts: {
  chainId: number; apiKey: string; proxy: string; implementation: string; onStatus?: (msg: string) => void;
}): Promise<string> {
  const { chainId, apiKey, onStatus } = opts;
  const submit = await call(chainId, apiKey, {
    module: 'contract', action: 'verifyproxycontract', address: opts.proxy, expectedimplementation: opts.implementation,
  }, true);
  if (submit.status !== '1') throw new Error(String(submit.result || submit.message));
  const guid = String(submit.result);
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const r = await call(chainId, apiKey, { module: 'contract', action: 'checkproxyverification', guid });
    const msg = String(r.result);
    if (/pending|in progress/i.test(msg)) { onStatus?.(msg); continue; }
    if (r.status === '1') return msg;
    throw new Error(msg);
  }
  throw new Error(`Proxy link still pending (guid ${guid}). Check the explorer later.`);
}
