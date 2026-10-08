# Voucher V2 — deployment & configuration guide

How to deploy and configure the voucher contracts (from the `voucher` repo) using the
**Voucher V2** tab of this dashboard, without the mistakes that cost time or break the
deployment. The tab's own "Before you start" checks (Overview sub-tab) run most of these
checks live. This document is the complete list.

> The older **ATM Vouchers** tab is a different, standalone contract (`ATMVoucher`) and is
> not covered here.

---

## 1. What gets deployed

| # | Contract | Kind | Needs | Purpose |
|---|---|---|---|---|
| 1 | VoucherNFT | UUPS proxy | — | Core ERC721: voucher types, mint, claim, revoke |
| 2 | SourceRegistry | UUPS proxy | — | Allowlist of payout pools (sinks) |
| 3 | VoucherDAO | UUPS proxy | VoucherNFT | Propose/approve quorum for mints & revokes |
| 4 | RevocationVault | UUPS proxy | — | Holds revoked vouchers |
| 5 | AllowlistTransferGate | UUPS proxy | — | *Optional.* Restricts who can send/receive gated types |
| 6 | RewardSink | UUPS proxy | VoucherNFT | Custodial pool paying Native/ERC20/ERC721/ERC1155 |
| 7 | VoucherIncentive | UUPS proxy | VoucherNFT | Points ledger (`globalPoints`) + deferred ERC20 entitlements |
| 8 | VoucherTransfer | UUPS proxy | VoucherNFT | *Optional.* Peer-to-peer points transfer |
| 9 | VoucherNFTViews | plain | VoucherNFT | Read-only helper views |

Each proxy is 2 transactions (implementation, then `ERC1967Proxy` + `initialize`). Same layout
as `hardhat-upgrades`.

**Gas budget** (measured): full deploy ≈ 18.3M gas, wiring ≈ 1.1M, each voucher type ≈ 0.22M.
At 0.1 gwei that's ≈ 0.002 BNB. Keep **≥ 0.02 BNB** in the admin wallet so a run never stops
halfway.

---

## 2. Before you start

- [ ] **Right network.** BNB Testnet (97) for rehearsals, BSC Mainnet (56) only for the real
      thing. Addresses are saved separately per network.
- [ ] **Right wallet.** The wallet that deploys becomes `DEFAULT_ADMIN_ROLE` on every contract
      and must send all wiring/config transactions. Use the wallet that should own the system.
- [ ] **Continuing an existing deployment?** Don't deploy again. Go to Overview → *Import JSON*
      and paste the voucher repo's `deployments/<network>.json`. The BSC testnet deployment is
      already used by the PageRank backend; redeploying it breaks that integration.
- [ ] **Contract files are current.** The JSON files in `lib/contracts/voucher-v2/` are
      generated from the voucher repo. Overview shows the commit they came from. If the
      contracts changed since then, in the voucher repo run:
      ```bash
      npx hardhat run scripts/exportWebappArtifacts.ts
      # different checkout location:  UI_DIR=/path/to/atm-UI-deploy npx hardhat run scripts/exportWebappArtifacts.ts
      ```
      Commit any contract changes first, so the deployed bytecode can be traced to a commit.
      Never edit those JSON files by hand.
- [ ] **Enough gas** (see budget above).

---

## 3. Step by step (sub-tabs, left to right)

### 2. Deploy
1. Leave **Admin address** = the connected wallet.
2. Press **Deploy all remaining** (or deploy one by one, in the order shown). Confirm each
   transaction in the wallet. Expect 17 transactions for everything.
3. If it stops midway (rejected tx, out of gas, RPC error), press Deploy again. A saved
   implementation is reused, so only the missing proxy tx is sent.
4. **Export the address book** (Overview → Export JSON) as soon as the run finishes.

⚠ **Redeploy** on a contract that already has an address creates a *new* contract. Roles,
types and balances stay on the old one, and anything that points at the old address (other
contracts, backends) is not updated. Only redeploy deliberately.

### 3. Wire contracts
Press **Run all required**. The steps, all sent by the admin wallet:

| Step | Why |
|---|---|
| VoucherNFT → SourceRegistry | Turns on funding-source validation |
| TYPE_ADMIN_ROLE → admin wallet | Needed to register types / grant minters |
| REVOKE_ROLE → VoucherDAO | Enables governed revokes |
| Approve RewardSink ×4 standards | Reward types can use RewardSink |
| Approve VoucherIncentive (points) | Points types can use VoucherIncentive |
| *Optional:* VoucherIncentive as ERC20 reward sink | Only for Deferred ERC20 reward types |
| *Optional:* SETTLER_ROLE → VoucherTransfer | Required if you use points transfer |
| *Optional:* REVOKE_ROLE → admin wallet | Direct revoke without a DAO vote |

If a step says *"sent, but the chain doesn't show it yet"*, wait a few seconds and press
**Re-check**. Public BSC RPCs lag behind fresh writes. **Don't resend.**

### 4. Voucher types
- Finish wiring **first**, otherwise registration reverts with `FundingSourceNotApproved`.
- **Plan the order.** Type ids are permanent and assigned 0, 1, 2… in registration order. The
  PageRank backend maps type ids to coins (`voucher_config.py`), so write down the planned list
  before registering.
- Start from a preset; they match the configurations used by the voucher repo's scripts.
- Reward types: add approved payout tokens (Native = `0x0`), and **fund the pool before
  minting** (tab 7).
- **faceValue for ERC20/Native is always 18-decimal**, whatever the token's decimals: 12.5 USDC
  is `12.5 × 10¹⁸`, and the pool converts it on payout. Points/ERC1155 faceValue is a plain
  integer; ERC721 is usually 0 plus a tokenId.
- Use **Test mint** to prove each type end-to-end before handing it over.

### 5. Roles & minters
- Every minter has a default cap of **100 vouchers per day** per type. Contracts that mint on
  behalf of everyone (VoucherDAO, VoucherTransfer) need **Unlimited**.
- Types with *mint approvals > 1* mint through VoucherDAO. Grant VoucherDAO that type's minter
  role, and add at least as many approvers as the quorum.
- Settler voting on VoucherIncentive defaults to a quorum of 2.

### 6. Points transfer
Pick a credit type (Points/Credit backed by VoucherIncentive) and a debit-record type. Then
**Run remaining steps**:
1. Debit-record type has funding source `0x0` **and** redemption paused (the tab can register
   one for you).
2. `approveCreditType`, `approveDebitType`, `allowCombination(debit, credit)`.
3. VoucherTransfer gets an **unlimited** minter role on both types.
4. VoucherTransfer gets `SETTLER_ROLE` on the credit type's ledger.

Then **Try a transfer**. The recipient must `claim` the Credit voucher to receive the points.

### 7. Fund pools
Deposit what Reward types pay out into RewardSink (native, ERC20, ERC721, ERC1155). Admin
withdrawals take the amount in token units; the pool converts it from 18-decimal internally.

---

## 4. After deploying

- [ ] Export the address book and store it somewhere shared.
- [ ] Copy the addresses into the voucher repo's `deployments/<network>.json`.
- [ ] If **VoucherIncentive** is new, update the PageRank backend
      (`ATM-PageRank-Node-Decentralized-release`):
      - `project/settings.cfg` → `EVENTS['voucher_data']`: `ADDRESS`, `FIRST_BLOCK` (current
        chain head), `LAUNCH_DATE`.
      - `project/configs/voucher/voucher_config.py` → type ids in `VOUCHER_REWARD_GROUPS`
        (they are only valid for the order types were registered in).
- [ ] Mainnet only: hand admin roles to the long-term owner (e.g. a multisig) with
      `grantRole`, then `revokeRole` from the deployer.

**Upgrading later** from the voucher repo: these proxies weren't created by Hardhat, so run
`upgrades.forceImport(proxyAddress, Factory)` once before `upgrades.upgradeProxy(...)`.

---

## 5. Common errors

The tab estimates every transaction first, so most of these appear *before* anything is sent.

| Error shown | Cause | Fix |
|---|---|---|
| `Access denied: … missing role …` | Wrong wallet connected, or the role was never granted | Connect the admin wallet; grant the role on Wire / Roles |
| `FundingSourceNotApproved` | Sink not approved in the registry for that mode/standard | Run the Wire steps, then register again |
| `FundingSourceInsufficient` | Pool doesn't hold enough for this mint | Deposit on Fund pools |
| `TokenNotApprovedForType` | Mint used a token not approved for the type | Add it under Voucher types → Manage |
| `RouteTargetRequired` / `RouteTargetNotAllowed` | Payout mode Routed without a target, or a target on a non-Routed type | Fix the payout mode/target |
| `BadApprovals` | Mint approvals required = 0 | Use ≥ 1 |
| `MintingPaused` / `RedemptionPaused` | Type is paused | Toggle on the Voucher types table |
| `daily mint cap exceeded` | Minter used up its window | Raise the cap / set Unlimited on Roles |
| `InvalidCreditType` / `InvalidDebitType` | Type has the wrong shape, or isn't approved on VoucherTransfer yet | Follow the Points transfer steps in order |
| `CombinationNotAllowed` | That debit→credit pair wasn't allowed | Run *Allow the pair* |
| `VoucherIncentive: insufficient balance` | Sender doesn't have the points | Expected. Only spend what you hold |
| Empty revert / "function does not exist" | Address points at a different or older contract | Check the address book; old VoucherTransfer versions must be redeployed |
