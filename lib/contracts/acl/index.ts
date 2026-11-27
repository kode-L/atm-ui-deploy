// ACL contract set (ATMAccessControl, ATMAccessControlDAO, Factory, Trader v1.0.5) and the Management
// multisig that owns the older proxies (File, Factory, Trader… on BSC mainnet). Used by the ACL &
// Management tab and the ATM Upgrader tab.
//
// Addresses are read from the chain wherever possible:
//   File        → LINK_ADDRESSES (same as the Link tab)
//   Factory     → File.factory(), else LINK_ADDRESSES
//   ACL         → File.accessControl()           (a saved override wins, e.g. a freshly deployed proxy)
//   ACL DAO     → ACL.dao() (v1.1.0)             (else chain.json aclDaoAddress, else the proxy saved in this browser)
//   Management  → any proxy admin / owner above that answers queryNodes()
import { ethers } from 'ethers';
import ACLArtifact from './ATMAccessControl.json';
import ACLProxyArtifact from './ATMAccessControlProxy.json';
import DAOArtifact from './ATMAccessControlDAO.json';
import DAOProxyArtifact from './ATMAccessControlDAOProxy.json';
import FactoryArtifact from './Factory.json';
import TraderArtifact from './Trader.json';
import { chainAddress, networkStorageKey, validAddr } from '@/lib/contracts/config';
import { LINK_ADDRESSES } from '@/lib/contracts/link';

export type AclContractName = 'ATMAccessControl' | 'ATMAccessControlProxy' | 'ATMAccessControlDAO' | 'ATMAccessControlDAOProxy' | 'Factory' | 'Trader';

export const ARTIFACTS: Record<AclContractName, { contractName: string; abi: any[]; bytecode: string }> = {
  ATMAccessControl: ACLArtifact,
  ATMAccessControlProxy: ACLProxyArtifact,
  ATMAccessControlDAO: DAOArtifact,
  ATMAccessControlDAOProxy: DAOProxyArtifact,
  Factory: FactoryArtifact,
  Trader: TraderArtifact,
};

/**
 * What the bundled ATMAccessControlDAOProxy(impl, ?, owner) takes as its 2nd argument, read from its ABI:
 * 'file' = the File proxy (the DAO reads the ACL live from File.accessControl(), like Factory/Trader);
 * 'acl' = an older build that stored the ACL address. The UI holds the DAO deploy on an 'acl' build.
 */
export const DAO_PROXY_TARGET: 'file' | 'acl' = (() => {
  const ctor = (DAOProxyArtifact.abi as any[]).find((x) => x.type === 'constructor');
  return /file/i.test(ctor?.inputs?.[1]?.name || '') ? 'file' : 'acl';
})();

export interface VerifyBundle { compilerVersion: string; contractName: string; input: unknown }
// loaded on demand: the standard-JSON inputs are only needed when someone presses Verify
export const loadVerifyBundle = async (name: AclContractName): Promise<VerifyBundle> => {
  switch (name) {
    case 'ATMAccessControl': return (await import('./ATMAccessControl.verify.json')).default as VerifyBundle;
    case 'ATMAccessControlProxy': return (await import('./ATMAccessControlProxy.verify.json')).default as VerifyBundle;
    case 'ATMAccessControlDAO': return (await import('./ATMAccessControlDAO.verify.json')).default as VerifyBundle;
    case 'ATMAccessControlDAOProxy': return (await import('./ATMAccessControlDAOProxy.verify.json')).default as VerifyBundle;
    case 'Factory': return (await import('./Factory.verify.json')).default as VerifyBundle;
    case 'Trader': return (await import('./Trader.verify.json')).default as VerifyBundle;
  }
};

// basePorxy (contracts/proxy/proxy.sol): admin-only upgrad / changeAdmin
export const PROXY_ABI = [
  'function admin() view returns (address)',
  'function logic() view returns (address)',
  'function upgrad(address newLogic) returns (bool)',
  'function changeAdmin(address newAdmin) returns (bool)',
];

// contracts/Management.sol — node multisig: a proposal executes on the vote that passes nodeNum / 2
export const MANAGEMENT_ABI = [
  'function proposalCount() view returns (uint256)',
  'function nodeNum() view returns (uint256)',
  'function nodeAddrSta(address) view returns (bool)',
  'function queryNodes() view returns (address[])',
  'function queryVotes(uint256 id) view returns (address[] voters, bool executed, address target, address addr, bytes data, uint256 expire, string label)',
  'function addNodePropose(address addr)',
  'function deleteNodePropose(address addr)',
  'function updateProxyAdminPropose(address target, address newAdmin)',
  'function updateProxyUpgradPropose(address target, address newLogic)',
  'function excContractPropose(address target, bytes data)',
  'function vote(uint256 id)',
  'event Propose(address indexed proposer, uint256 proposalId, string label)',
];
export const PROPOSAL_TTL_SECONDS = 86400;

export const FILE_ADMIN_ABI = [
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'function accessControl() view returns (address)',
];

const ACL_IFACE = new ethers.utils.Interface(ACLArtifact.abi);
const DAO_IFACE = new ethers.utils.Interface(DAOArtifact.abi);
const FACTORY_IFACE = new ethers.utils.Interface(FactoryArtifact.abi);
const PROXY_IFACE = new ethers.utils.Interface(PROXY_ABI);
const MANAGEMENT_IFACE = new ethers.utils.Interface(MANAGEMENT_ABI);
const FILE_IFACE = new ethers.utils.Interface(['function setAccessControl(address)', 'function transferOwnership(address)']);
export const aclIface = ACL_IFACE;

export const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const isAddr = (a?: string) => !!a && ethers.utils.isAddress(a.trim()) && !/^0x0{40}$/i.test(a.trim());
export const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

// ── Saved addresses (only until they can be read from the chain / committed) ──
const KEYS = {
  acl: 'dg_aclAddress',
  dao: 'dg_aclDaoAddress',
  management: 'dg_managementAddress',
  newImpl: (name: string) => `dg_aclNewImpl_${name}`,
};
export const savedAddr = (key: keyof typeof KEYS | string, chainId: number): string => {
  const base = typeof (KEYS as any)[key] === 'string' ? (KEYS as any)[key] : key;
  try { return validAddr(localStorage.getItem(networkStorageKey(base, chainId))); } catch { return ''; }
};
export const saveAddr = (key: keyof typeof KEYS | string, chainId: number, value: string) => {
  const base = typeof (KEYS as any)[key] === 'string' ? (KEYS as any)[key] : key;
  try {
    if (value) localStorage.setItem(networkStorageKey(base, chainId), value);
    else localStorage.removeItem(networkStorageKey(base, chainId));
  } catch { /* storage blocked: the address just isn't remembered */ }
};
export const newImplKey = KEYS.newImpl;

// ── Who controls an address ──
export type ControllerKind = 'wallet' | 'management' | 'contract' | 'none';
export interface Controller {
  address: string;
  kind: ControllerKind;
  nodes?: string[];   // management only
  needed?: number;    // votes that execute a proposal (management only)
  delegated?: boolean; // wallet only: EOA with an EIP-7702 delegation (signs like any wallet)
}

export async function readController(provider: ethers.providers.Provider, address: string): Promise<Controller> {
  if (!isAddr(address)) return { address: address || '', kind: 'none' };
  const code = await provider.getCode(address).catch(() => '0x');
  // no code, or an EIP-7702 delegation (0xef0100 + address, e.g. a MetaMask smart account): still a key you connect
  if (!code || code === '0x') return { address, kind: 'wallet' };
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return { address, kind: 'wallet', delegated: true };
  try {
    const nodes: string[] = await new ethers.Contract(address, MANAGEMENT_ABI, provider).queryNodes();
    if (nodes.length) return { address, kind: 'management', nodes, needed: Math.floor(nodes.length / 2) + 1 };
  } catch { /* not a Management contract */ }
  return { address, kind: 'contract' };
}

// ── Live state of the whole set ──
export interface ProxyInfo {
  address: string;
  code: boolean;
  version: string;
  implementation: string;
  admin: string;   // basePorxy admin(): who can upgrade / change admin
  owner: string;   // owner(): who can call onlyOwner functions
}

export interface AclSystem {
  chainId: number;
  file: ProxyInfo | null;
  factory: ProxyInfo | null;
  trader: ProxyInfo | null;
  acl: ProxyInfo | null;
  aclSource: 'file' | 'saved' | '';
  dao: ProxyInfo | null;
  daoSource: 'acl' | 'chain' | 'saved' | ''; // chain = chain.json, not linked by setDao yet
  aclDao: string;              // ACL.dao() ('' = not readable: ACL below v1.1.0)
  aclV11: boolean;             // ACL has dao() (v1.1.0+)
  management: string;
  controllers: Record<string, Controller>;
  blockTime: number;
}

const str = async (p: Promise<any>) => { try { const v = await p; return typeof v === 'string' ? v : String(v ?? ''); } catch { return ''; } };
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const slotAddr = (v: string) => (v && v.length === 66 && !/^0x0+$/.test(v) ? ethers.utils.getAddress('0x' + v.slice(26)) : '');

export async function readProxyInfo(provider: ethers.providers.Provider, address: string): Promise<ProxyInfo | null> {
  if (!isAddr(address)) return null;
  const code = await provider.getCode(address).catch(() => '0x');
  if (!code || code === '0x') return { address, code: false, version: '', implementation: '', admin: '', owner: '' };
  const c = new ethers.Contract(address, [...PROXY_ABI, 'function owner() view returns (address)', 'function version() view returns (string)', 'function VERSION() view returns (string)'], provider);
  const [version, VERSION, impl, admin, owner] = await Promise.all([
    str(c.version()), str(c.VERSION()),
    provider.getStorageAt(address, IMPL_SLOT).then(slotAddr).catch(() => ''),
    provider.getStorageAt(address, ADMIN_SLOT).then(slotAddr).catch(() => ''),
    str(c.owner()),
  ]);
  return { address, code: true, version: version || VERSION, implementation: impl, admin, owner: isAddr(owner) ? owner : '' };
}

export async function readAclSystem(provider: ethers.providers.Provider, chainId: number): Promise<AclSystem> {
  const link = LINK_ADDRESSES[chainId];
  const fileAddr = link?.file || '';
  const fileC = isAddr(fileAddr) ? new ethers.Contract(fileAddr, FILE_ADMIN_ABI, provider) : null;
  const [fileFactory, fileAcl, block] = await Promise.all([
    fileC ? str(fileC.factory()) : Promise.resolve(''),
    fileC ? str(fileC.accessControl()) : Promise.resolve(''),
    provider.getBlock('latest').catch(() => null),
  ]);
  const savedAcl = savedAddr('acl', chainId);
  const aclAddr = savedAcl || (isAddr(fileAcl) ? fileAcl : '');
  const aclC = aclAddr ? new ethers.Contract(aclAddr, ['function dao() view returns (address)'], provider) : null;
  const aclDaoRaw = aclC ? await str(aclC.dao()) : '';
  const aclV11 = !!aclDaoRaw;
  const savedDao = savedAddr('dao', chainId);
  const chainDao = chainAddress(chainId, 'aclDaoAddress');
  const daoAddr = isAddr(aclDaoRaw) ? aclDaoRaw : chainDao || savedDao;
  const factoryAddr = isAddr(fileFactory) ? fileFactory : link?.factory || '';

  const [file, factory, trader, acl, dao] = await Promise.all([
    readProxyInfo(provider, fileAddr),
    readProxyInfo(provider, factoryAddr),
    readProxyInfo(provider, link?.trader || ''),
    readProxyInfo(provider, aclAddr),
    readProxyInfo(provider, daoAddr),
  ]);
  // the DAO keeps owner as a public variable, readProxyInfo's owner() covers it

  const who = new Set<string>();
  for (const p of [file, factory, trader, acl, dao]) {
    if (p?.admin) who.add(p.admin);
    if (p?.owner) who.add(p.owner);
  }
  const savedMgmt = savedAddr('management', chainId);
  if (savedMgmt) who.add(savedMgmt);
  const list = await Promise.all(Array.from(who).map((a) => readController(provider, a)));
  const controllers = Object.fromEntries(list.map((c) => [c.address.toLowerCase(), c]));
  const management = list.find((c) => c.kind === 'management' && sameAddr(c.address, savedMgmt))?.address
    || list.find((c) => c.kind === 'management')?.address || '';

  return {
    chainId, file, factory, trader, acl, dao,
    aclSource: savedAcl ? 'saved' : aclAddr ? 'file' : '',
    daoSource: isAddr(aclDaoRaw) ? 'acl' : chainDao ? 'chain' : savedDao ? 'saved' : '',
    aclDao: aclDaoRaw, aclV11,
    management, controllers, blockTime: block?.timestamp || 0,
  };
}

// Address book: fixed addresses per network (atm-smart-contract integration/acl/addresses.json and
// docs/ContractOwners.md, checked on chain 2026-11-27). Shown in "Who signs what → Address book" and
// used to name addresses everywhere in this section. Live contracts (ACL, DAO, Factory, Trader, File and
// their implementations) are added from the chain on top of these.
export const KNOWN_NAMES: Record<number, Record<string, string>> = {
  56: {
    // signers
    '0x2E9382A37bf3e77A54BA71C7419c928518703A1E': 'Management multisig (8 nodes, executes on the 5th vote, 24h)',
    '0x585EBA5655270D41abE9E76651B17dEd4Cd35bCF': 'Wallet 0x585E (EIP-7702 EOA): ACL owner + proxy admin, ACL operator',
    '0xcFC94Ca494033aAC5899034B2761C2cAEC5d0f74': 'ACL operator 0xcFC9',
    // Management voters (nodes); rename to the person / team that holds each key
    '0x66FE6cB3979fCEf6F7D009d51fa900D47eF89502': 'Management node 1 (0x66FE)',
    '0xC82bE99C4Cba83C30C2236D561f0741B264529C6': 'Management node 2 (0xC82b)',
    '0x0D4F5CEBcEcD89901e9f1e81491509c6E108577A': 'Management node 3 (0x0D4F)',
    '0x7F7Ba6605C94443fec5733198DB9cabA68bCB53A': 'Management node 4 (0x7F7B)',
    '0x7f1a0B063238E8097a35a96a2784fa7e7261A78e': 'Management node 5 (0x7f1a)',
    '0x4eeDAB5d0aB5788cAFFe8e21a698fBCB44c59D32': 'Management node 6 (0x4eeD)',
    '0x934d7414A07F4077de65615fF1006C57c3AB62FC': 'Management node 7 (0x934d)',
    '0xa2f6F44029a883553Ba7113345996c283e701aD8': 'Management node 8 (0xa2f6)',
    // ACL v1.1.0 release (deployed 2026-11, read on chain 2026-11-27)
    '0xE15F97A9C96FA10A3f2e2386B5C5D0690E454993': 'ATMAccessControl implementation v1.1.0',
    '0xB51BD6861Dd307f657480D27F5b1BD51DC8e5c44': 'ATMAccessControlDAO implementation v1.0.0',
    // implementations live before the ACL v1.1.0 release (rollback targets)
    '0x9CC4C195cB5aC34c845bEC3B29a602603ECf51F7': 'ATMAccessControl implementation v1.0.0 (rollback target)',
    '0x11aA4F8686484779Fd8a87F68E725C131931bC86': 'Factory implementation, before ACL check (rollback target)',
    '0x240b060fD1c5E8231A454441693678eE42Bf420A': 'Trader implementation v1.0.4 (rollback target)',
    '0xb3838D992393DcA493a8CC798a0d5aaCE4EeE2a4': 'File implementation v1.0.4',
    // other contracts
    '0x0E0293820d9bA914488E7662d1432475b28e147E': 'Link template (cloned for each connection)',
    '0xF9e3cfC3d030Fcf4926959f7AA4a434FB50CB157': 'Minter proxy',
    '0x607194DB759dE0a4D9918Ab89a85716C995c28e8': 'Crosschain proxy',
    '0x63367192D0626362CFF469C83b2B1d69946f9CCD': 'Incentive proxy',
    '0xEC56a45abFf41DF1746fDf4dedc45E909601aa02': 'Pledge proxy',
    // tokens
    '0x51E6Ac1533032E72e92094867fD5921e3ea1bfa0': 'LUCA token (proxy)',
    '0x23B186438651e442B06E905F38FbAd5ee87f9C48': 'wLuca',
    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56': 'BUSD',
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8': 'ETH (BEP-20)',
    '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c': 'BTCB',
  },
  97: {
    '0x3356ec280f80B2D15aFB0CF09A69cC7ef33d854f': 'Wallet 0x3356 (testnet admin)',
    '0x2f431a31EFC466502822abbB7f5EF068FA280Ecb': 'Wallet 0x2f43 (testnet admin)',
    '0x73983E498EE341810f634E6768F3CdccD6981Ac7': 'Verifier wallet (type VERIFIED)',
    '0xA2C568fe0dcCA15DCcc8ec7ce411fF866E0ff810': 'Verifier wallet (type VERIFIED)',
    '0xD7a1cA21D73ff98Cc64A81153eD8eF89C2a1EfEF': 'LUCA token (test)',
    '0x4Bd4327a769322567644Fe6399d67A9654E0cf51': 'Link template (cloned for each connection)',
  },
};

/** Every named address of this network: live contracts first, then the fixed book above. */
export interface BookEntry { address: string; name: string; group: string }
const groupOf = (n: string) => /implementation/i.test(n) ? 'Implementation' : /token|wluca|busd|btcb|\bETH\b/i.test(n) ? 'Token' : /wallet|operator|multisig|admin|verifier|node/i.test(n) ? 'Signer' : 'Contract';
export function addressBook(s: AclSystem | null, extra: Record<string, string> = {}): BookEntry[] {
  const m = new Map<string, BookEntry>();
  const put = (a: string | undefined, n: string) => { if (a && isAddr(a) && !m.has(a.toLowerCase())) m.set(a.toLowerCase(), { address: a, name: n, group: groupOf(n) }); };
  if (s) {
    put(s.acl?.address, 'ATMAccessControl (ACL) proxy');
    put(s.dao?.address, 'ATMAccessControlDAO proxy');
    put(s.file?.address, 'File proxy');
    put(s.factory?.address, 'Factory proxy');
    put(s.trader?.address, 'Trader proxy');
    put(s.management, 'Management multisig');
    const known = KNOWN_NAMES[s.chainId] || {};
    const knownOf = (a?: string) => Object.entries(known).find(([k]) => sameAddr(k, a))?.[1];
    const live = (a: string | undefined, n: string) => put(a, knownOf(a) ? `${n} (live) · ${knownOf(a)}` : `${n} (live)`);
    live(s.acl?.implementation, 'ATMAccessControl implementation');
    live(s.dao?.implementation, 'ATMAccessControlDAO implementation');
    live(s.factory?.implementation, 'Factory implementation');
    live(s.trader?.implementation, 'Trader implementation');
    Object.entries(known).forEach(([a, n]) => put(a, n));
  }
  Object.entries(extra).forEach(([a, n]) => put(a, n));
  const order = ['Contract', 'Signer', 'Implementation', 'Token'];
  return [...m.values()].sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group));
}

// ── Names for addresses and decoded calldata ──
export function nameBook(s: AclSystem | null, extra: Record<string, string> = {}): (a?: string) => string {
  const m = new Map(addressBook(s, extra).map((e) => [e.address.toLowerCase(), e.name]));
  return (a?: string) => (a ? m.get(a.toLowerCase()) || '' : '');
}

/** "setDao(0x…)" style text for calldata sent to one of the known contracts. */
export function describeCall(data: string): string {
  if (!data || data === '0x') return '';
  for (const iface of [ACL_IFACE, DAO_IFACE, FACTORY_IFACE, PROXY_IFACE, MANAGEMENT_IFACE, FILE_IFACE]) {
    try {
      const tx = iface.parseTransaction({ data });
      return `${tx.name}(${tx.args.map((a: any) => (Array.isArray(a) ? `[${a.join(', ')}]` : String(a))).join(', ')})`;
    } catch { /* not this contract */ }
  }
  return `${data.slice(0, 10)}… (${(data.length - 2) / 2} bytes)`;
}

/** Readable reason for a failed ACL / DAO / Factory / Management / proxy call. */
export function decodeAclError(e: any): string {
  const data = e?.error?.data?.data || e?.error?.data || e?.data?.data || e?.data;
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    for (const iface of [ACL_IFACE, DAO_IFACE, FACTORY_IFACE]) {
      try {
        const err = iface.parseError(data);
        return `${err.name}(${err.args.map(String).join(', ')})`;
      } catch { /* try next */ }
    }
    try { return ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10))[0]; } catch { /* not Error(string) */ }
  }
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return 'Rejected in the wallet';
  return e?.reason || e?.error?.message || e?.data?.message || e?.message || String(e);
}

// ── Effective status of a wallet (what payouts and connection rules actually see) ──
// A PROTECTED wallet whose safe wallet is frozen / blacklisted / revoked IS frozen: isFrozen() is
// true, payouts are blocked (redirectTarget = 0) and FROZEN rules apply. The PROTECTED marker only
// remembers the link so it recovers by itself when the safe wallet is cleared — never show it as
// "protected" in that state.
export type WalletStatusKind = 'normal' | 'protected' | 'frozen' | 'blacklisted';
export type SafeState = 'ok' | 'frozen' | 'blacklisted' | 'revoked';
export interface WalletStatus {
  address: string;
  status: WalletStatusKind;
  /** frozen only: 'safe' = frozen because its safe wallet is restricted; 'self' = frozen itself */
  frozenBy: 'self' | 'safe' | '';
  safeWallet: string;
  safeState: SafeState | '';
  payoutsTo: string;   // redirectTarget ('' = blocked)
  types: number[];     // typesOf (active types)
  linked: boolean;     // holds the PROTECTED link (recovers when the safe wallet is cleared)
}
const STATUS_ABI = [
  'function isBlacklisted(address) view returns (bool)',
  'function isFrozen(address) view returns (bool)',
  'function isProtected(address) view returns (bool)',
  'function safeWalletOf(address) view returns (address)',
  'function isSafeWalletRevoked(address) view returns (bool)',
  'function redirectTarget(address) view returns (address)',
  'function typesOf(address) view returns (uint256[])',
];
export async function readWalletStatus(provider: ethers.providers.Provider, aclAddr: string, wallet: string): Promise<WalletStatus> {
  const c = new ethers.Contract(aclAddr, STATUS_ABI, provider);
  const [black, frozen, prot, safe, redirect, types] = await Promise.all([
    c.isBlacklisted(wallet), c.isFrozen(wallet), c.isProtected(wallet), c.safeWalletOf(wallet), c.redirectTarget(wallet),
    c.typesOf(wallet).catch(() => []),
  ]);
  let safeState: SafeState | '' = '';
  if (isAddr(safe)) {
    const [sb, sf, sr] = await Promise.all([c.isBlacklisted(safe), c.isFrozen(safe), c.isSafeWalletRevoked(safe)]);
    safeState = sb ? 'blacklisted' : sf ? 'frozen' : sr ? 'revoked' : 'ok';
  }
  const status: WalletStatusKind = black ? 'blacklisted' : frozen ? 'frozen' : prot ? 'protected' : 'normal';
  const frozenBy = status !== 'frozen' ? '' : prot && safeState && safeState !== 'ok' ? 'safe' : 'self';
  return {
    address: wallet, status, frozenBy, safeWallet: isAddr(safe) ? safe : '', safeState,
    payoutsTo: isAddr(redirect) ? redirect : '', types: (types as ethers.BigNumber[]).map((x) => x.toNumber()), linked: prot,
  };
}

// ── Upgrade checks used by the ATM Upgrader tab (all read live) ──
/**
 * True when a live implementation is exactly the bundled build of `name`: the bundled creation code
 * contains the deployed runtime code (incl. its metadata hash). Two builds with the same version()
 * string (e.g. an earlier v1.1.0 on testnet) are told apart this way.
 */
export async function implIsBundled(provider: ethers.providers.Provider, implementation: string, name: AclContractName): Promise<boolean> {
  if (!isAddr(implementation)) return false;
  const code = (await provider.getCode(implementation).catch(() => '0x')).toLowerCase();
  if (code.length < 100) return false;
  return ARTIFACTS[name].bytecode.toLowerCase().includes(code.slice(2));
}
/** Selector of IATMAccessControl.checkConnection: only the new Factory's code calls it. */
const CHECK_CONNECTION_SELECTOR = ethers.utils.id('checkConnection(address,address,address,uint256,uint256,uint256)').slice(2, 10);
/** True when a Factory implementation asks the ACL on createLink (the v1.1.0 Factory). */
export async function factoryChecksAcl(provider: ethers.providers.Provider, implementation: string): Promise<boolean> {
  if (!isAddr(implementation)) return false;
  const code = await provider.getCode(implementation).catch(() => '0x');
  return code.toLowerCase().includes(CHECK_CONNECTION_SELECTOR);
}

/** The three production rules (BLACKLISTED blocks everything: deny by default AND an explicit block on
 *  create / join / join fully paid; FROZEN blocks create / join, may only be userB of 100% LUCA). */
export const CONNECTION_ACTIONS = ['CREATE_CONNECTION', 'JOIN_CONNECTION', 'JOIN_FULLY_PAID'].map((k) => ethers.utils.id(k));
export interface ProductionRuleState { blacklisted: boolean; frozen: boolean; frozenLuca: boolean }
export async function readProductionRules(provider: ethers.providers.Provider, aclAddr: string, luca: string): Promise<ProductionRuleState> {
  const c = new ethers.Contract(aclAddr, ACLArtifact.abi, provider);
  const ZERO = ethers.constants.AddressZero;
  const [info, ...rules] = await Promise.all([
    c.typeInfo(1),
    ...CONNECTION_ACTIONS.map((a) => c.typeRule(1, a, ZERO, false)),
    ...CONNECTION_ACTIONS.map((a) => c.typeRule(2, a, ZERO, false)),
  ]);
  const n = CONNECTION_ACTIONS.length;
  const blocked = (rs: unknown[]) => rs.every((r) => Number(r) === 2);
  const lucaRule = isAddr(luca) ? Number(await c.typeRule(2, CONNECTION_ACTIONS[2], luca, true)) : 0;
  return { blacklisted: !!info.defaultBlocked && blocked(rules.slice(0, n)), frozen: blocked(rules.slice(n)), frozenLuca: lucaRule === 1 };
}
export const productionRuleCalls = (luca: string) => ({
  blacklisted: ACL_IFACE.encodeFunctionData('setTypeDefaultBlocked', [1, true]),
  blacklistedRules: ACL_IFACE.encodeFunctionData('setTypeRules', [1, CONNECTION_ACTIONS, [2, 2, 2]]),
  frozen: ACL_IFACE.encodeFunctionData('setTypeRules', [2, CONNECTION_ACTIONS, [2, 2, 2]]),
  frozenLuca: isAddr(luca) ? ACL_IFACE.encodeFunctionData('setTypeTokenRules', [2, CONNECTION_ACTIONS[2], [luca], [1]]) : '',
});

/** Open (not executed, not expired) Management proposals that would make this exact change. */
export interface MgmtProposal { id: number; voters: string[]; executed: boolean; target: string; addr: string; data: string; expire: number; label: string }
export async function findMgmtProposals(provider: ethers.providers.Provider, management: string, match: { target: string; addr?: string; data?: string }, scan = 30): Promise<{ open: MgmtProposal[]; executed: MgmtProposal[]; nodes: string[]; now: number }> {
  const m = new ethers.Contract(management, MANAGEMENT_ABI, provider);
  const [count, nodes, block] = await Promise.all([m.proposalCount(), m.queryNodes(), provider.getBlock('latest')]);
  const total = count.toNumber();
  const ids = Array.from({ length: Math.min(scan, total) }, (_, i) => total - i);
  // newest first, a few at a time with one retry: public BSC RPCs drop bursts of eth_calls, and one
  // unreadable old proposal must not hide the open one
  const read = async (id: number): Promise<MgmtProposal | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await m.queryVotes(id);
        return { id, voters: r.voters, executed: r.executed, target: r.target, addr: r.addr, data: r.data, expire: r.expire.toNumber(), label: r.label };
      } catch { /* retry once, then skip */ }
    }
    return null;
  };
  const all: MgmtProposal[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map(read));
    batch.forEach((p) => { if (p) all.push(p); });
  }
  const hit = all.filter((p) => sameAddr(p.target, match.target)
    && (match.addr ? sameAddr(p.addr, match.addr) : true)
    && (match.data ? (p.data || '').toLowerCase() === match.data.toLowerCase() : true));
  return {
    open: hit.filter((p) => !p.executed && p.expire > block.timestamp),
    executed: hit.filter((p) => p.executed),
    nodes, now: block.timestamp,
  };
}
