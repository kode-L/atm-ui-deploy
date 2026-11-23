# ACL v1.1.0: deploy, test and troubleshoot (atm-UI-deploy)

Deploy ATMAccessControl v1.1.0, the new ATMAccessControlDAO, the Factory and Trader v1.0.5 upgrades from
the **ATM Upgrader** tab, then test everything by hand. Do **BSC testnet first**, then mainnet.
(The same actions also exist in **ACL & Management**; the Upgrader shows only the upgrade, as one checklist.)

Contracts: atm-smart-contract working tree with the revised v1.1.0 (`selfFreeze` allowed for an active
safe wallet) and `contracts/traderV6.sol` (Trader v1.0.5). Versions follow mainnet + 1: ACL v1.0.0 → v1.1.0,
Trader v1.0.4 → v1.0.5 (testnet's Trader reports "v5.0.0", the same file before its version was renamed).
The UI bundles exactly that build (`lib/contracts/acl/`, `node scripts/sync-acl-contracts.js`).

---

## 1. Prerequisites

### 1.1 Wallets

| Role | Testnet (97) | Mainnet (56) | Needs |
|---|---|---|---|
| ACL proxy admin + ACL owner | `0x3356ec280f80B2D15aFB0CF09A69cC7ef33d854f` | `0x585EBA5655270D41abE9E76651B17dEd4Cd35bCF` | gas; signs steps 1, 3, 4 |
| Factory proxy admin | `0x0dCC8b2240c7406100B9544Bd4e2a7Db5E0219A6` (wallet) | `0x2E9382A37bf3e77A54BA71C7419c928518703A1E` (**Management**, 5 of 8 nodes) | gas; signs step 5 |
| Trader proxy admin | `0x2f431a31EFC466502822abbB7f5EF068FA280Ecb` (wallet) | `0x2E9382A37bf3e77A54BA71C7419c928518703A1E` (**Management**, 5 of 8 nodes) | gas; signs step 6 |
| Deployer of the DAO proxy | your choice | your choice (ideally the team multisig's signer) | gas; **becomes the DAO upgrade admin** |
| DAO owner (typed into step 2) | e.g. `0x3356…854f` | a multisig | unpauses the DAO, sets the verifier threshold |
| Test wallets (testing only) | 8–10 fresh wallets | not needed | a little tBNB each, some test LUCA for LUCA tests |

**Testnet is all wallets**: connect the wallet each step names and send it. **Mainnet is mixed**: the ACL
steps (1, 3, 4) are signed by the wallet `0x585E…5bCF` (an EOA with an EIP-7702 delegation); the
Factory and Trader (5, 6) are admin'd by the **Management multisig**, so a node presses
**Create Management proposal** in that step and 4 more nodes press **Vote** in the same step within
**24 hours**; the 5th vote runs the upgrade. The Upgrader's **Who signs on this network** card says which
flow applies, and won't let a second proposal for the same upgrade be created while one is open.

### 1.2 Before you start

- [ ] Run the UI from your local atm-UI-deploy checkout (`yarn dev`), which has the ACL changes.
- [ ] Pick the network in the UI; MetaMask shows the same network.
- [ ] **ATM Upgrader → Who signs on this network** shows the admins as in 1.1 (wallet / Management).
- [ ] **1. ACL** shows the current version **v1.0.0** (testnet shows "no version()": that's the older
      testnet build and is fine).
- [ ] **Write down the current implementation addresses** (each step shows "Implementation now"; the
      Upgrader's **Rollback** card also remembers them in this browser). Testnet today: ACL
      `0x2F7ce6281E6c6782F7d3c274aFe1AE658DFA2961`, Factory `0x4f33E152a445c1AAE961C3C0cc8900f3a4F21bAb`,
      Trader `0x551BfeE57811CB997b67416ACc5C4f00b8529222`. Mainnet: ACL `0x9CC4C195cB5aC34c845bEC3B29a602603ECf51F7`,
      Factory `0x11aA4F8686484779Fd8a87F68E725C131931bC86`, Trader `0x240b060fD1c5E8231A454441693678eE42Bf420A`.
- [ ] Don't press **Verify** buttons (no explorer verification).

---

## 2. Deploy (in this order)

All in **ATM Upgrader**; each step turns **done** when the chain shows it.

| Step | Upgrader step | Action | Sign with | Check after |
|---|---|---|---|---|
| 1 | **1. ACL** | Deploy new ATMAccessControl implementation → **Upgrade ACL** | deploy: any · upgrade: ACL admin | version **v1.1.0**; the ACL's live data looks unchanged |
| 2 | **2. ACL DAO** | Deploy DAO implementation → Deploy DAO proxy (owner = DAO owner) | the wallet that should be DAO admin | DAO version **v1.0.0**, owner as typed, `acl` = ACL proxy; **DAO requests** shows verifier vote **off** (leave it off until the verifier flow is settled) |
| 3 | **3. Link** | **Set DAO** | ACL owner | step shows **DAO ✓** (the Factory needs no setup: it finds the ACL through `File.accessControl()`) |
| 4 | **4. Production rules** | press the 3 buttons | ACL owner | **3 of 3 set** |
| 5 | **5. Factory** | Deploy Factory implementation → **Upgrade Factory** (mainnet: proposal + votes) | deploy: any · upgrade: Factory admin | step shows "asks the ACL on createLink" |
| 6 | **6. Trader** | Deploy Trader v1.0.5 implementation → **Upgrade Trader** (mainnet: proposal + votes) | deploy: any · upgrade: Trader admin | version **v1.0.5** |

Step 5 needs step 1: the new Factory asks `acl.checkConnection` on every `createLink`, which only the
v1.1.0 ACL has (the Upgrader keeps the button disabled until then). Set the production rules (step 4) first. Step 6 (Trader)
can run any time after step 1; it stops `setUserB` on an open 100% LUCA connection from accepting a
blacklisted wallet or a frozen one without a safe wallet. Production rules (step 4) can be set any time, but without them
frozen and blacklisted wallets are **not** blocked from creating connections.

---

## 3. Test plan (testnet, real wallets)

Setup for the tests:
- **Add two test operators.** The ACL owner calls `setOperator(op, true)`. There's no UI button
  for this, so use Remix: ATMAccessControl, *At Address* = ACL proxy, with the ABI from
  `atm-smart-contract/flattened/acl-v1.1.0`.
- **Operator actions are in ACL & Management → ACL proposals:**
  - freeze and blacklist run immediately
  - unfreeze, unblacklist and set safe wallet are proposals that need 2 operator approvals
- **The pause switches (G) aren't in the UI either.** Call them from Remix the same way:
  - DAO `pause` / `unpause`, at the DAO proxy
  - ACL `pauseDao` / `unpauseDao`, at the ACL proxy

Mark each row ✅ / ❌. On ❌, see section 4.

### A. Nothing changed for normal wallets

| # | Do | Expected |
|---|---|---|
| A1 | Normal wallet creates a small BNB connection in the app | works as before |
| A2 | Normal wallet creates a LUCA connection | works as before |
| A3 | Accept a 50-50 connection as userB, then withdraw later | works; payouts to the wallet itself |
| A4 | **Types & rules → Wallets → Look up** a normal wallet | status **NORMAL**, payouts to itself |
| A5 | **Check a connection** with two normal wallets | **✓ allowed** |

### B. Blacklisted and frozen rules

Set up with operators: blacklist wallet **B**, freeze wallet **F**.

| # | Do | Expected |
|---|---|---|
| B1 | Check a connection: creator **B**, any token | ✗ creator blocked by a rule |
| B2 | Check: creator normal, userB **B**, 100% LUCA | ✗ userB blocked |
| B3 | Check: creator **F**, BNB 50% / BNB 100% / LUCA 100% / LUCA 37% | ✗ creator blocked (all four) |
| B4 | Check: creator normal, userB **F**, **100% LUCA** | ✓ allowed |
| B5 | Check: userB **F**, 100% BNB | ✗ userB blocked |
| B6 | Check: userB **F**, 50% LUCA | ✗ userB blocked |
| B7 | Real `createLink` in the app from **F** | reverts `Factory: connection not allowed` |
| B8 | Real `createLink` normal → userB **F**, 100% LUCA | works |

### C. Custom type (e.g. PARTNER: LUCA only, 100% only, date range)

| # | Do | Expected |
|---|---|---|
| C1 | **Create a type** `PARTNER` | new row, id 5 |
| C2 | Edit PARTNER: Create connection → **block**; token rule LUCA → **allow** | table shows block; editor shows LUCA allow |
| C3 | Limits, one token = LUCA: min creator % 100, amount 10–1000, from now to +7 days | on-chain line shows these limits |
| C4 | **Wallets**: assign PARTNER to wallet **P** | look-up shows PARTNER |
| C5 | Check: **P** BNB | ✗ creator blocked |
| C6 | Check: **P** LUCA 50% | ✗ percentA outside the limit |
| C7 | Check: **P** LUCA 100%, 100 LUCA | ✓ allowed |
| C8 | Check: **P** LUCA 100%, 5000 LUCA | ✗ amount outside the limit |
| C9 | Disable PARTNER, check C5 again | ✓ allowed; re-enable → blocked again |
| C10 | Remove PARTNER from **P** | look-up shows no types |

### D. Frozen → protected (DAO)

Wallets: **W** and **S**.

| # | Do | Expected |
|---|---|---|
| D1 | Operators: freeze **W**; set safe wallet **W → S** (2 approvals) | W status **FROZEN**, payouts to S |
| D2 | Connect **S**, then **DAO requests → Start a request → Ask protection** | fails: `ACLDAO: not frozen` (only the frozen wallet asks) |
| D3 | Connect **W** → **Ask protection from my safe wallet** | request appears; approver = S |
| D4 | Connect another wallet → Approve | button disabled / `ACLDAO: only safe wallet approves` |
| D5 | Connect **S** → **Waiting for your approval** → Approve | W status **PROTECTED**, payouts to S |
| D6 | W withdraws from a connection | funds arrive at **S** |

### E. Safe wallet frozen → linked wallet frozen

Continues from D.

| # | Do | Expected |
|---|---|---|
| E1 | Operators: freeze **S** | W status **FROZEN · safe wallet S is frozen · payouts blocked** |
| E2 | W tries to withdraw | reverts `Trader: recipient restricted`; **nothing** goes to S |
| E3 | W's VERIFIER / custom types (if it had any) | gone from the look-up |
| E4 | Operators: unfreeze **S** (2 approvals) | W **PROTECTED** again, payouts to S; custom types still gone |
| E5 | Repeat E1–E4 with **blacklist / unblacklist S** | same results |

### F. Move-up (safe wallet compromised)

Wallets: **F1** frozen with safe **S1**. Freeze **S1**, then operators set safe wallet **S1 → S2**.

| # | Do | Expected |
|---|---|---|
| F1 | Connect **F1** → **Move to S2 (S2 approves)** | request; approver = S2 |
| F2 | Connect **S2** → Approve | F1 still **FROZEN**, safe wallet **S2**, payouts to S2 |
| F3 | Reset (new wallets). Connect **S2** → **Request move to me** with F1's address | request; approver = **F1** |
| F4 | Connect **F1** → Approve | same result as F2 |
| F5 | Same with a **protected** wallet P1 (S1 frozen, S1 → S2) | P1 stays **PROTECTED** under S2 |
| F6 | Stranger tries **Request move to me** for F1 | button disabled / `only the safe wallet of its safe wallet` |
| F7 | Request, then operators change S1's safe wallet before approval | approve fails: `ACLDAO: links changed` |

### G. Pause switches

| # | Do | Expected |
|---|---|---|
| G1 | An operator pauses the DAO (`pause()` on the DAO) | approvals fail `ACLDAO: paused`; reject and cancel still work |
| G2 | Operator tries to unpause | fails `ACLDAO: not owner` |
| G3 | DAO owner unpauses | approvals work again |
| G4 | **DAO requests → verifier section** shows **off**; a protected wallet's `proposeSafeWallet` reverts `verifier vote disabled` | expected at launch; only the DAO owner can switch it on |
| G5 | Operator calls `pauseDao()` on the ACL | DAO approvals fail `DaoPaused`; freeze and normal `createLink` still work; ACL owner `unpauseDao()` |

---

## 4. If something doesn't work: check these conditions

Copy the full message from the toast (**Copy all**) and find it below.

### 4.1 Deploy and upgrade

| Message / symptom | Cause | Fix |
|---|---|---|
| `LucaPorxy: Caller not admin` | upgrade sent from a wallet that isn't the proxy admin | connect the admin shown under "Signed by" |
| `Ownable: caller is not the owner` | ACL setting from a non-owner | connect the ACL owner |
| Card says **not you** | wrong wallet connected | switch wallet, or "Copy request for admin" |
| "Your wallet is on chain X" | MetaMask on the other network | switch network |
| **3. Link** says "needs ACL v1.1.0" | step 1 not done or not confirmed | finish **Upgrade ACL**, reload |
| `ACLDAO: already initialized` | initialising the DAO implementation directly | deploy the **proxy** (step 2); never call `initialize` |
| Management proposal never executes | not enough node votes within 24h | new proposal; get majority votes in time |
| Version still old after upgrade | the tx didn't confirm, or the old implementation address was used | check the toast hash; upgrade to the **new** implementation |

### 4.2 Connections (`createLink`)

| Message | Cause | Fix |
|---|---|---|
| `Factory: accessControl not set` | File has no ACL address | File owner sets `accessControl` to the ACL proxy |
| `Factory: connection not allowed` | an ACL rule or limit says no | **Types & rules → Check a connection** with the same values; it gives the reason (below) |
| `Factory: lockDays out of set` / `totalPlan too small` / `token not exist` / `userB is self` | old Factory checks, unrelated to the ACL | fix the inputs |
| `Trader: userA/userB is blacklisted or frozen without safe wallet` | Trader payout check (unchanged) | expected for blocked wallets |

Reasons shown by **Check a connection**:

| Reason | Meaning | Look at |
|---|---|---|
| creator blocked by a rule | one of the creator's types blocks *Create connection* for this token | creator's types (look-up) → each type's rules and token rules |
| userB blocked by a rule | userB's types block *Join connection* (< 100%) or *Join fully paid* (100%) | userB's types and rules |
| lock days / amount / percentA outside the limit | a limit of one of the creator's types | that type's limits (general, or for this token) |
| outside the date range | the type's start/end time | limits → allowed from / until |
| ✓ allowed but `createLink` still fails | not an ACL rule | see the Factory messages above |

Remember: **any block in any type wins**, a token rule overrides the general rule for that token,
a **disabled** type is ignored, and a type with *default: block* blocks every action without a rule.

### 4.3 Types & rules

| Message | Cause | Fix |
|---|---|---|
| `ReservedName` / `TypeExists` / `EmptyName` | built-in, duplicate or empty name | another name |
| `UnknownType` | type id doesn't exist | reload; use an id from the table |
| `NotAssignable` | tried to assign BLACKLISTED / FROZEN | use the operators' blacklist / freeze |
| `TooManyTypes` | wallet already holds 8 types | remove one first |
| `AccountRestricted` | PROTECTED / VERIFIER for a frozen or blacklisted wallet | not allowed while restricted |
| `AccountIsSafeWallet` | PROTECTED for a wallet that is someone's safe wallet | not allowed (no chains) |
| `BadLimits` | min > max, percent > 100, or start ≥ end | fix the form |
| `BadRule` / `LengthMismatch` / `ZeroAction` | malformed call (shouldn't happen from the UI) | reload and retry |

### 4.4 DAO requests

| Message | Cause | Fix |
|---|---|---|
| `ACLDAO: not frozen` | protection asked by a wallet that isn't frozen (or is protected / blacklisted) | operators freeze it first; the **frozen wallet** asks |
| `ACLDAO: wallet is a safe wallet` | the frozen wallet protects others | not allowed (no chains) |
| `ACLDAO: no safe wallet` | no safe wallet set | operators set one (2 approvals) |
| `ACLDAO: safe wallet restricted` | the safe wallet is frozen / blacklisted / revoked | unfreeze it, or move-up (F) |
| `ACLDAO: safe wallet is protected` | the chosen safe wallet is itself protected | pick another safe wallet |
| `ACLDAO: only safe wallet approves` / `rejects` | wrong wallet approving | connect the approver shown on the request |
| `ACLDAO: only the wallet approves` / `rejects` | S2 started it, so the **wallet** must approve | connect the wallet |
| `ACLDAO: safe wallet changed` / `links changed` | operators changed links after the request | request again |
| `ACLDAO: safe wallet not restricted` | move-up while S1 is fine | move-up is only for a compromised (restricted) S1 |
| `ACLDAO: safe wallet has no safe wallet` | S1 has no safe wallet S2 | operators set S1 → S2 |
| `ACLDAO: not frozen or protected` | move-up by a normal or blacklisted wallet | not allowed |
| `ACLDAO: only the safe wallet of its safe wallet` | "Request move to me" from a wallet that isn't S2 | connect S2 |
| `ACLDAO: proposal not pending` | already approved, rejected, cancelled or replaced | reload; check the status |
| `ACLDAO: not allowed` | cancel from someone other than the requester / DAO owner | requester cancels; the approver rejects |
| `ACLDAO: paused` | DAO paused | DAO owner unpauses |
| `DaoPaused` | ACL DAO hooks paused | ACL owner `unpauseDao()` |
| `NotDao` | DAO not linked in the ACL | **3. Link → Set DAO** |
| `ACLDAO: verifier vote disabled` | the verifier vote is switched off (default at deployment) | DAO owner: **DAO requests → Switch verifier vote on**, only when the flow is settled |
| `ACLDAO: not verifier` / `verifier is a party` / `already approved` | verifier vote rules | active VERIFIER, not a party, one vote |

### 4.5 Payouts

| Symptom | Cause | Fix |
|---|---|---|
| `Trader: recipient restricted` | wallet blacklisted, or frozen with no usable safe wallet, or protected with a restricted safe wallet | look up the wallet: the status line says why; clear the safe wallet or move up |
| Payout went to another address | wallet is frozen / protected | expected: payouts go to its safe wallet (status line shows where) |

---

## 5. Rollback (only if needed)

Upgrade back to the implementation addresses written down in 1.2, **Factory first, then ACL**.
The v1.0.0 ACL has no `checkConnection`, so an upgraded Factory with an old ACL would fail every
`createLink`.

1. **4. Factory:** "use one already deployed" → old Factory implementation → **Upgrade Factory**.
2. **1. ACL:** old ACL implementation → **Upgrade ACL**.

Storage is append-only, so v1.0.0 keeps working with all blacklist / frozen / safe-wallet data. The
v1.1.0-only data (types, rules, limits, protected marks, DAO link) is ignored until you upgrade again.
