import { ethers } from 'ethers';

// ATM "Link" system (atm-smart-contract/contracts/factory.sol + link.sol). A link is a
// two-party lock: userA creates it through Factory.createLink (= connect), userB accepts it
// with Link.agree (= approve), and either side ends it with Link.close (= disconnect).
// Every call is msg.sender-bound to userA/userB, so bulk actions are one wallet tx per link —
// there is no on-chain batch entry point.

export interface LinkNetwork {
  file: string;
  factory: string;
  trader: string; // ERC20 spender: Trader.payment() does transferFrom(user, …)
  luca: string;
  linkTemplate: string;
}

// Checked on-chain 2026-11-04 (File.factory()/trader()/luca()/linkTemp(), Factory.file()).
// BSC testnet's Factory isn't in TestnetAddress.md — it was read from File.factory().
// The page re-reads these from File at load and warns if they no longer match.
export const LINK_ADDRESSES: Record<number, LinkNetwork> = {
  97: {
    file: '0x500884dEb536aD4b1b0f0d70671f39f42564593A',
    factory: '0x50249e6dB2d98b314e2A843D5b642F162DA2099F',
    trader: '0x7386F0d65C3690C67b9852eE7DFFBB2B7F7F5Fd0',
    luca: '0xD7a1cA21D73ff98Cc64A81153eD8eF89C2a1EfEF',
    linkTemplate: '0x4Bd4327a769322567644Fe6399d67A9654E0cf51',
  },
  56: {
    file: '0x141d8DC76F6c689FABF75ea064a113E76255630F',
    factory: '0x8f827eCe944A0d54cfcD94D8775b23A980F37cdA',
    trader: '0x7b749e4d4C23556a772Aca4E00E283BEFd575b9B',
    luca: '0x51E6Ac1533032E72e92094867fD5921e3ea1bfa0',
    linkTemplate: '0x0E0293820d9bA914488E7662d1432475b28e147E',
  },
};

// Symbols checked against Factory.tokenMap(symbol). The native coin is registered under the
// network name passed to Factory.initialize ("BNB" on both BSC deployments) with address(0).
export const KNOWN_SYMBOLS = ['LUCA', 'BNB', 'ETH', 'BUSD', 'USDT', 'USDC'];

export const FILE_ABI = [
  'function factory() view returns (address)',
  'function trader() view returns (address)',
  'function luca() view returns (address)',
  'function linkTemp() view returns (address)',
  'function active() view returns (bool)',
  'function minLockDay() view returns (uint256)',
  'function maxLockDay() view returns (uint256)',
];

export const FACTORY_ABI = [
  'function file() view returns (address)',
  'function totalLink() view returns (uint256)',
  'function isLink(address) view returns (bool)',
  'function tokenMap(string) view returns (address addr, uint256 minAmount, bool isActive)',
  'function createLink(address _userB, string _symbol, uint256 _totalPlan, uint256 _percentA, uint256 _lockDays) payable returns (address)',
  'event LinkCreated(address indexed _creater, string indexed _symbol, address _link)',
  'event LinkActive(address _link, address _user, uint256 _methodId)',
];

export const LINK_ABI = [
  'function getLinkInfo() view returns (string symbol_, address token_, address userA_, address userB_, uint256 amountA_, uint256 amountB_, uint256 percentA_, uint256 totalPlan_, uint256 lockDays_, uint256 startTime_, uint256 status_, bool isAward_)',
  'function getCloseInfo() view returns (address closer_, uint256 startTime_, uint256 expiredTime_, uint256 closeTime_, bool closeReqA_, bool closeReqB_)',
  'function isExpire() view returns (bool)',
  'function agree() payable',
  'function reject()',
  'function close()',
];

export const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// Link.Enum.Status order
export const LinkStatus = { INITED: 0, AGREED: 1, CLOSED: 2, PLEDGED: 3 } as const;
export const LINK_STATUS_LABELS: Record<number, string> = { 0: 'Pending', 1: 'Connected', 2: 'Closed', 3: 'Pledged' };

export const ZERO = ethers.constants.AddressZero;
export const isNative = (token: string) => token.toLowerCase() === ZERO;

export interface LinkState {
  address: string;
  isLink: boolean;
  symbol: string;
  token: string;
  userA: string;
  userB: string;
  amountA: ethers.BigNumber;
  amountB: ethers.BigNumber;
  percentA: number;
  totalPlan: ethers.BigNumber;
  lockDays: number;
  status: number;
  expiredTime: number;
  closeReqA: boolean;
  closeReqB: boolean;
  expired: boolean;
}

export async function readLink(provider: ethers.providers.Provider, factory: ethers.Contract, address: string): Promise<LinkState> {
  const addr = ethers.utils.getAddress(address);
  const isLink: boolean = await factory.isLink(addr);
  if (!isLink) throw new Error('not a Link created by this Factory');
  const c = new ethers.Contract(addr, LINK_ABI, provider);
  const [info, close, expired] = await Promise.all([c.getLinkInfo(), c.getCloseInfo(), c.isExpire()]);
  return {
    address: addr,
    isLink,
    symbol: info.symbol_,
    token: info.token_,
    userA: info.userA_,
    userB: info.userB_,
    amountA: info.amountA_,
    amountB: info.amountB_,
    percentA: info.percentA_.toNumber(),
    totalPlan: info.totalPlan_,
    lockDays: info.lockDays_.toNumber(),
    status: info.status_.toNumber(),
    expiredTime: close.expiredTime_.toNumber(),
    closeReqA: close.closeReqA_,
    closeReqB: close.closeReqB_,
    expired,
  };
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Mirrors Link.agree(): onlyUserB + onlyINITED.
export function approveCheck(l: LinkState, me: string): { ok: boolean; why: string } {
  if (l.status !== LinkStatus.INITED) return { ok: false, why: `already ${LINK_STATUS_LABELS[l.status]?.toLowerCase()}` };
  if (!same(l.userB, me)) return { ok: false, why: l.userB === ZERO ? 'open link — userA must set userB' : 'you are not userB' };
  return { ok: true, why: '' };
}

// Mirrors Link.close(): unCLOSED + unPLEDGED + onlyLinkUser, then the INITED/AGREED branches.
// `effect` says whether this one call ends the link or only records a close request.
export function disconnectCheck(l: LinkState, me: string): { ok: boolean; why: string; effect: string } {
  const isA = same(l.userA, me), isB = same(l.userB, me);
  if (l.status === LinkStatus.CLOSED) return { ok: false, why: 'already closed', effect: '' };
  if (l.status === LinkStatus.PLEDGED) return { ok: false, why: 'pledged — depledge first', effect: '' };
  if (!isA && !isB) return { ok: false, why: 'you are not userA or userB', effect: '' };
  if (l.expired) return { ok: true, why: '', effect: 'closes now (expired)' };
  if (l.status === LinkStatus.INITED) {
    return isA ? { ok: true, why: '', effect: 'closes now (refund userA)' } : { ok: false, why: 'only userA can cancel a pending link', effect: '' };
  }
  const mine = isA ? l.closeReqA : l.closeReqB;
  const theirs = isA ? l.closeReqB : l.closeReqA;
  if (mine) return { ok: false, why: 'close already requested — waiting for the other side', effect: '' };
  return { ok: true, why: '', effect: theirs ? 'closes now (both requested)' : 'sends close request — other side must also close' };
}

/** "Link: only userA" style revert strings come back as e.reason / nested error messages. */
export function decodeLinkError(e: any): string {
  const msg: string = e?.reason || e?.error?.reason || e?.data?.message || e?.error?.message || e?.message || String(e);
  if (/user rejected|ACTION_REJECTED/i.test(msg)) return 'rejected in wallet';
  const m = msg.match(/(Link|Factory|Trader|ERC20)[^"\\]*?:[^"\\]+/);
  return (m ? m[0] : msg).slice(0, 200);
}

export function parseAddressList(text: string): { addresses: string[]; bad: string[] } {
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const seen = new Set<string>();
  const addresses: string[] = [];
  const bad: string[] = [];
  for (const t of tokens) {
    if (!/^0x/i.test(t)) continue; // header words etc.
    if (!ethers.utils.isAddress(t)) { bad.push(t); continue; }
    const a = ethers.utils.getAddress(t);
    if (!seen.has(a)) { seen.add(a); addresses.push(a); }
  }
  return { addresses, bad };
}

export function downloadCsv(name: string, rows: (string | number)[][]) {
  const body = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
