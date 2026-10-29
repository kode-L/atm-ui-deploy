// The ordered deploy + wiring recipe, mirroring the voucher repo's
// scripts/deployFreshKeepTokens.ts (core contracts) and its VoucherTransfer deploy scripts.
// Every step has an on-chain check, so the guide reflects the real state of whatever
// addresses are in the book — including a deployment imported from elsewhere.
import { ContractKey, TokenStandard, ZERO, isAddr, role, sameAddr } from '@/lib/contracts/voucher-v2';
import type { useVoucherV2 } from './context';

type Ctx = ReturnType<typeof useVoucherV2>;
export type StepResult = { done: boolean; detail?: string; warn?: string; blocked?: string; needsPick?: boolean; approvedPicks?: string[] };

export interface DeployStep {
  key: ContractKey;
  proxy: boolean;
  needs: ContractKey[];
  optional?: boolean;
  what: string;
  // gas measured on a local chain (implementation + proxy) — for the balance pre-check
  gas: number;
  args: (ctx: Ctx, admin: string, form: { nftName: string; nftSymbol: string }) => any[];
  // getter that returns the VoucherNFT this contract was initialized with
  linkGetter?: string;
}

const nftAddr = (ctx: Ctx) => ctx.getBook().contracts.VoucherNFT;

export const DEPLOY_STEPS: DeployStep[] = [
  {
    key: 'VoucherNFT', gas: 4971710, proxy: true, needs: [],
    what: 'The core ERC721 voucher contract: voucher types, mint, claim, revoke. Everything else points at it.',
    args: (_c, admin, f) => [admin, f.nftName, f.nftSymbol],
  },
  {
    key: 'SourceRegistry', gas: 1574313, proxy: true, needs: [],
    what: 'Allowlist of payout pools (reward vaults and points ledgers). Once wired, a voucher type can only use an approved pool.',
    args: (_c, admin) => [admin, 'Voucher V2 registry'], // (admin, name) — name is informational, renameable later
  },
  {
    key: 'VoucherDAO', gas: 3176232, proxy: true, needs: ['VoucherNFT'], linkGetter: 'nft',
    what: 'Propose / approve / quorum governance for mints and revokes on types with approvalsRequired > 1.',
    args: (c, admin) => [admin, nftAddr(c)],
  },
  {
    key: 'RevocationVault', gas: 964206, proxy: true, needs: [],
    what: "Holds revoked vouchers (a type's revokeDestination). Admin can release them later.",
    args: (_c, admin) => [admin],
  },
  {
    key: 'RewardVault', gas: 1692730, proxy: true, needs: ['VoucherNFT'], linkGetter: 'voucherNFT',
    what: 'Custodial reward pool: holds Native / ERC20 / ERC721 / ERC1155 and pays them out on claim.',
    args: (c, admin) => [admin, nftAddr(c), 'Main reward pool', ZERO], // (admin, nft, name, accessControl = off)
  },
  {
    key: 'VoucherSettlement', gas: 2963834, proxy: true, needs: ['VoucherNFT'], linkGetter: 'voucherNFT',
    what: 'Points ledger (globalPoints) for Points-mode types, plus non-custodial deferred ERC20 entitlements.',
    args: (c, admin) => [admin, nftAddr(c), 'VoucherSettlement', ZERO], // (admin, nft, name, accessControl = off)
  },
  {
    key: 'VoucherNFTViews', gas: 431780, proxy: false, needs: ['VoucherNFT'], linkGetter: 'nft',
    what: 'Read-only helper (owned voucher ids, minters of a type). Plain contract, no proxy.',
    args: (c) => [nftAddr(c)],
  },
];

export async function checkDeployStep(ctx: Ctx, step: DeployStep): Promise<StepResult> {
  const a = ctx.getBook().contracts[step.key];
  if (!a || !ctx.reader) return { done: false };
  const code = await ctx.reader.getCode(a);
  if (!code || code === '0x') return { done: false, warn: 'No contract code at this address on the current network' };
  if (step.linkGetter) {
    try {
      const linked: string = await ctx.read(step.key)[step.linkGetter]();
      if (!sameAddr(linked, nftAddr(ctx))) return { done: true, warn: `Points at VoucherNFT ${linked}, not the one in this address book` };
    } catch {
      return { done: true, warn: 'Could not read its VoucherNFT link — is this the right contract?' };
    }
  }
  return { done: true };
}

export async function runDeployStep(ctx: Ctx, step: DeployStep, admin: string, form: { nftName: string; nftSymbol: string }, impl?: string) {
  const args = step.args(ctx, admin, form);
  return step.proxy ? ctx.deployProxy(step.key, args, impl) : ctx.deployPlain(step.key, args);
}

// ── Wiring ──

/** One address a wiring step uses — prefilled from the address book, but the operator can change it. */
export interface WireField {
  name: string;
  label: string;
  note: string;
  prefill: (ctx: Ctx) => string;
}

/** A multi-select the operator fills in (e.g. which token standards to approve). Stored as comma-separated values. */
export interface WirePick {
  name: string;
  label: string;
  note: string;
  options: { value: string; label: string }[];
}

export interface WireStep {
  id: string;
  // the contract this step sends to, and the function it calls (shown on the step)
  target: 'VoucherNFT' | 'SourceRegistry';
  method: string;
  title: string;
  why: string;
  // button text — what the tx actually does
  action: string;
  fields: WireField[];
  pick?: WirePick;
  optional?: boolean;
  check: (ctx: Ctx, v: Record<string, string>) => Promise<StepResult>;
  run: (ctx: Ctx, v: Record<string, string>) => Promise<unknown>;
}

const STANDARD_NAMES = ['Native', 'ERC20', 'ERC721', 'ERC1155'];
// what the RewardVault wiring step offers for now — ERC721 / ERC1155 left out to keep setup simple
const VAULT_STANDARDS: number[] = [TokenStandard.Native, TokenStandard.ERC20];
const done = (v: boolean): StepResult => ({ done: v });
const pickedStandards = (v: Record<string, string>) =>
  (v.standards || '').split(',').filter(Boolean).map(Number).filter((n) => VAULT_STANDARDS.includes(n));
const fromBook = (k: ContractKey) => (ctx: Ctx) => ctx.getBook().contracts[k] || '';

const F: { nft: WireField; registryTarget: WireField; wallet: (what: string) => WireField } = {
  nft: { name: 'nft', label: 'VoucherNFT (proxy)', note: 'The VoucherNFT proxy address from the Deploy tab — the contract this tx is sent to.', prefill: fromBook('VoucherNFT') },
  registryTarget: { name: 'registry', label: 'SourceRegistry (proxy)', note: 'The SourceRegistry proxy address from the Deploy tab — the contract this tx is sent to.', prefill: fromBook('SourceRegistry') },
  wallet: (what: string) => ({ name: 'account', label: 'Wallet to grant', note: `Who gets ${what}. Usually your connected (admin) wallet; paste another address to grant it to an operator instead.`, prefill: (c: Ctx) => c.account }),
};

/** Measured on a local chain: all wiring steps together. */
export const WIRE_GAS = 1_101_887;

export const WIRE_STEPS: WireStep[] = [
  {
    id: 'registry',
    target: 'VoucherNFT',
    method: 'setSourceRegistry',
    title: 'Link the voucher contract to the pool registry',
    why: 'After this, a voucher type can only pay from pools the registry has approved.',
    action: 'Link registry',
    fields: [
      F.nft,
      { name: 'value', label: 'SourceRegistry to set', note: 'The SourceRegistry proxy VoucherNFT should validate against (the one deployed with it).', prefill: fromBook('SourceRegistry') },
    ],
    check: async (c, v) => done(sameAddr(await c.read('VoucherNFT', v.nft).sourceRegistry(), v.value)),
    run: (c, v) => c.send('VoucherNFT.setSourceRegistry', c.write('VoucherNFT', v.nft), 'setSourceRegistry', [v.value]),
  },
  {
    id: 'typeAdmin',
    target: 'VoucherNFT',
    method: 'grantRole(OPERATOR_ROLE)',
    title: 'Let your wallet manage voucher types',
    why: 'Gives your wallet the operator role on VoucherNFT: create and edit voucher types and choose who can mint them.',
    action: 'Grant role',
    fields: [F.nft, F.wallet('OPERATOR_ROLE (registers / configures voucher types and grants minters)')],
    check: async (c, v) => done(await c.read('VoucherNFT', v.nft).hasRole(role('OPERATOR_ROLE'), v.account)),
    run: (c, v) => c.send('Grant OPERATOR_ROLE', c.write('VoucherNFT', v.nft), 'grantRole', [role('OPERATOR_ROLE'), v.account]),
  },
  {
    id: 'revokeDao',
    target: 'VoucherNFT',
    method: 'grantRole(REVOKE_ROLE)',
    title: 'Let VoucherDAO revoke vouchers by vote',
    why: 'Needed only if vouchers should be revocable through a VoucherDAO vote.',
    action: 'Grant role',
    fields: [
      F.nft,
      { name: 'dao', label: 'VoucherDAO (proxy)', note: 'The VoucherDAO proxy address from the Deploy tab — it receives REVOKE_ROLE.', prefill: fromBook('VoucherDAO') },
    ],
    check: async (c, v) => done(await c.read('VoucherNFT', v.nft).hasRole(role('REVOKE_ROLE'), v.dao)),
    run: (c, v) => c.send('Grant REVOKE_ROLE to VoucherDAO', c.write('VoucherNFT', v.nft), 'grantRole', [role('REVOKE_ROLE'), v.dao]),
  },
  {
    id: 'rewardVault',
    target: 'SourceRegistry',
    method: 'setRewardVaultApproved',
    title: 'Approve the main pool for the tokens it pays out',
    why: 'Tick what the main pool pays out (Native, ERC20). You can approve more later; one transaction per choice.',
    action: 'Approve selected',
    fields: [
      F.registryTarget,
      { name: 'settlementTarget', label: 'RewardVault (proxy)', note: 'The RewardVault proxy address from the Deploy tab — the pool being approved as a reward vault.', prefill: fromBook('RewardVault') },
    ],
    pick: {
      name: 'standards',
      label: 'Token standards to approve',
      note: 'Native = BNB/ETH rewards, ERC20 = token rewards (USDT, USDC…).',
      options: VAULT_STANDARDS.map((s) => ({ value: String(s), label: STANDARD_NAMES[s] })),
    },
    check: async (c, v) => {
      const reg = c.read('SourceRegistry', v.registry);
      const approved = await Promise.all(VAULT_STANDARDS.map((s) => reg.isRewardVaultApproved(s, v.settlementTarget)));
      const have = VAULT_STANDARDS.filter((_, i) => approved[i]).map((s) => STANDARD_NAMES[s]);
      const picked = pickedStandards(v);
      const missing = picked.filter((s) => !approved[VAULT_STANDARDS.indexOf(s)]).map((s) => STANDARD_NAMES[s]);
      const detail = `Approved on-chain: ${have.length ? have.join(', ') : 'none'}`;
      const approvedPicks = VAULT_STANDARDS.filter((_, i) => approved[i]).map(String);
      if (missing.length) return { done: false, detail: `${detail} · To approve: ${missing.join(', ')}`, approvedPicks };
      if (!have.length) return { done: false, detail: `${detail} · Pick at least one standard`, needsPick: true, approvedPicks };
      return { done: true, detail, approvedPicks };
    },
    run: async (c, v) => {
      const reg = c.read('SourceRegistry', v.registry);
      for (const s of pickedStandards(v)) {
        if (await reg.isRewardVaultApproved(s, v.settlementTarget)) continue;
        await c.send(`Approve RewardVault (${STANDARD_NAMES[s]})`, c.write('SourceRegistry', v.registry), 'setRewardVaultApproved', [s, v.settlementTarget, true, '']);
      }
    },
  },
  {
    id: 'pointsLedger',
    target: 'SourceRegistry',
    method: 'setPointsLedgerApproved',
    title: 'Approve VoucherSettlement for points',
    why: 'Lets Points voucher types keep their points balances on VoucherSettlement.',
    action: 'Approve',
    fields: [
      F.registryTarget,
      { name: 'settlementTarget', label: 'VoucherSettlement (proxy)', note: 'The VoucherSettlement proxy address from the Deploy tab — the points ledger being approved.', prefill: fromBook('VoucherSettlement') },
    ],
    check: async (c, v) => done(await c.read('SourceRegistry', v.registry).isPointsLedgerApproved(v.settlementTarget)),
    run: (c, v) => c.send('Approve VoucherSettlement (points)', c.write('SourceRegistry', v.registry), 'setPointsLedgerApproved', [v.settlementTarget, true, '']),
  },
  {
    id: 'incentiveErc20',
    target: 'SourceRegistry',
    method: 'setRewardVaultApproved',
    title: 'Approve VoucherSettlement for ERC20 rewards',
    why: 'Only needed for deferred / routed ERC20 rewards paid through VoucherSettlement.',
    action: 'Approve',
    optional: true,
    fields: [
      F.registryTarget,
      { name: 'settlementTarget', label: 'VoucherSettlement (proxy)', note: 'The VoucherSettlement proxy address from the Deploy tab — approved for ERC20 rewards only.', prefill: fromBook('VoucherSettlement') },
    ],
    check: async (c, v) => done(await c.read('SourceRegistry', v.registry).isRewardVaultApproved(TokenStandard.ERC20, v.settlementTarget)),
    run: (c, v) => c.send('Approve VoucherSettlement (ERC20 reward)', c.write('SourceRegistry', v.registry), 'setRewardVaultApproved', [TokenStandard.ERC20, v.settlementTarget, true, '']),
  },
  {
    id: 'revokeAdmin',
    target: 'VoucherNFT',
    method: 'grantRole(REVOKE_ROLE)',
    title: 'Let your wallet revoke vouchers directly',
    why: 'Lets this wallet revoke a voucher immediately, without a VoucherDAO vote.',
    action: 'Grant role',
    optional: true,
    fields: [F.nft, F.wallet('REVOKE_ROLE (can revoke vouchers directly)')],
    check: async (c, v) => done(await c.read('VoucherNFT', v.nft).hasRole(role('REVOKE_ROLE'), v.account)),
    run: (c, v) => c.send('Grant REVOKE_ROLE to wallet', c.write('VoucherNFT', v.nft), 'grantRole', [role('REVOKE_ROLE'), v.account]),
  },
];

export const wirePrefill = (ctx: Ctx, step: WireStep): Record<string, string> => ({
  ...Object.fromEntries(step.fields.map((f) => [f.name, f.prefill(ctx)])),
  ...(step.pick ? { [step.pick.name]: '' } : {}),
});

/** values defaults to the address-book prefill (what the Overview tab uses). */
export async function checkWireStep(ctx: Ctx, step: WireStep, values = wirePrefill(ctx, step)): Promise<StepResult> {
  const missing = step.fields.filter((f) => !isAddr(values[f.name] || ''));
  if (missing.length) return { done: false, blocked: `Fill in a valid address for: ${missing.map((f) => f.label).join(', ')}` };
  return step.check(ctx, values);
}
