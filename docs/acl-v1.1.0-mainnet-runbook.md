# ACL v1.1.0: BSC mainnet go-live runbook

The production release of ATMAccessControl v1.1.0, the new ATMAccessControlDAO v1.0.0, the Factory
upgrade and Trader v1.0.5, done from this UI (**ATM Upgrader** tab). It uses exactly the code that is
live and tested on BSC testnet. Details for each step and the troubleshooting tables are in
[acl-v1.1.0-deploy-and-test.md](acl-v1.1.0-deploy-and-test.md).

Don't press **Verify** anywhere (no explorer verification). Versions stay as built: ACL **v1.1.0**,
DAO **v1.0.0**, Trader **v1.0.5**.

---

## 1. Mainnet today (read from the chain 2026-11-27, block 136,023,935)

| Contract | Proxy | Implementation now (write down for rollback) | Version | Proxy admin | Owner |
|---|---|---|---|---|---|
| File | `0x141d8DC76F6c689FABF75ea064a113E76255630F` | `0xb3838D992393DcA493a8CC798a0d5aaCE4EeE2a4` | v1.0.4 | Management | Management |
| ATMAccessControl (ACL) | `0x1ABC53CEEE1D502E2E534582A97dd6603f33A4A5` | `0x9CC4C195cB5aC34c845bEC3B29a602603ECf51F7` | v1.0.0 | `0x585E…5bCF` | `0x585E…5bCF` |
| Factory | `0x8f827eCe944A0d54cfcD94D8775b23A980F37cdA` | `0x11aA4F8686484779Fd8a87F68E725C131931bC86` | none | Management | — |
| Trader | `0x7b749e4d4C23556a772Aca4E00E283BEFd575b9B` | `0x240b060fD1c5E8231A454441693678eE42Bf420A` | v1.0.4 | Management | — |
| ATMAccessControlDAO | not deployed | — | — | — | — |

- `File.accessControl()` already points at the ACL proxy; `File.factory()` / `File.trader()` at the
  proxies above. File is **not** changed by this release.
- `0x585EBA5655270D41abE9E76651B17dEd4Cd35bCF`: a wallet (EOA with an EIP-7702 delegation), signs like
  any wallet. Balance 0.29 BNB: enough for its steps.
- **Management** `0x2E9382A37bf3e77A54BA71C7419c928518703A1E`: 8 nodes, a proposal executes on the
  **5th** vote and expires after **24 hours**.
- ACL today: 27 operator proposals, threshold 2. These stay as they are.

---

## 2. Decide before go-live

| # | Decision | Recommended | Decided |
|---|---|---|---|
| D1 | **DAO proxy admin** (who can upgrade the DAO). It's whoever deploys the DAO proxy in step 2. | Deploy from `0x585E…5bCF`, then hand it to **Management** with *Change proxy admin* (upgrades then need 5 of 8, like Factory / Trader) | ☐ |
| D2 | **DAO owner** (unpause, verifier type, type flows). Typed in step 2. | `0x585E…5bCF` (same as the ACL owner: one signature for settings). Management is safer but every setting change needs a proposal + 5 votes | ☐ |
| D3 | **ACL operators** (freeze / blacklist immediately; unfreeze, safe wallets by 2 approvals) | Confirm the current list. Operators seen in the 27 past proposals and still operators (2026-11-27): `0x585EBA5655270D41abE9E76651B17dEd4Cd35bCF`, `0xcFC94Ca494033aAC5899034B2761C2cAEC5d0f74` (an operator that never proposed wouldn't show here). Check each with `operators(addr)`; add / remove with `setOperator` (ACL owner) **before** go-live | ☐ |
| D4 | **Verifiers** | **Not at launch**: `verifierTypeId` stays 0, verifier vote stays off, no type flows | ✅ decided |

---

## 3. Before you start

- [ ] Run this UI from a checkout whose `lib/contracts/acl/` is the tested build (commit it first). The
      **ATM Upgrader** must show the bundled build as the target.
- [ ] Contracts team confirms the mainnet fork test passed on a recent block with this exact build
      (section 7).
- [ ] Pick **BNB Smart Chain** in the UI and in the wallet.
- [ ] **ATM Upgrader → Who signs on this network** shows: ACL = wallet `0x585E…5bCF`; Factory and
      Trader = **Management**.
- [ ] Write down the three implementations from section 1 (the **Rollback** card also keeps them).
- [ ] At least 5 Management nodes are reachable for two votes (Factory, Trader) within 24 hours each.
- [ ] Decisions D1–D3 are made.
- [ ] Announce a short window: connections keep working throughout, but do steps 1 → 5 together.

---

## 4. Go-live steps (ATM Upgrader, in this order)

| Step | Upgrader step | Action | Signed by | Check after (step turns DONE) |
|---|---|---|---|---|
| 1 | **1. ACL** | Deploy new ATMAccessControl implementation → **Upgrade ACL** | deploy: any wallet · upgrade: `0x585E…5bCF` | version **v1.1.0 · bundled build**; operators, frozen / blacklisted wallets and safe wallets unchanged |
| 2 | **2. ACL DAO** | Deploy DAO implementation → **Deploy DAO proxy** with owner = D2 | the wallet that should be DAO proxy admin (D1) | DAO **v1.0.0**, owner = D2, `file()` = File, `acl()` = ACL proxy, verifier vote **off**, not paused |
| 3 | **3. Link** | **Set DAO** | `0x585E…5bCF` | `ACL.dao()` = the DAO proxy |
| 4 | **4. Production rules** | Press the 3 buttons | `0x585E…5bCF` | **3 of 3 set**: blacklisted blocked from everything; frozen can't create or join; frozen may be user B of a 100% LUCA connection (only with a safe wallet) |
| 5 | **5. Factory** | Deploy Factory implementation → **Create Management proposal** → 4 more nodes **Vote** | deploy: any · upgrade: Management (5 of 8) | "bundled build: asks the ACL on createLink" |
| 6 | **6. Trader** | Deploy Trader v1.0.5 implementation → **Create Management proposal** → 4 more nodes **Vote** | deploy: any · upgrade: Management (5 of 8) | version **v1.0.5 · bundled build** |
| 7 | (D1) | ACL & Management → 2. ACL DAO → **Change proxy admin** to Management, if decided | current DAO proxy admin | "Proxy admin (upgrades)" = Management |

**Order rules:**
- **Step 5 only after steps 1 and 4.** The new Factory asks the ACL on every `createLink`: with the old
  ACL every connection would fail; without the rules, frozen and blacklisted wallets aren't blocked.
  The Upgrader keeps step 5 disabled until step 1 is done.
- Step 6 can run any time after step 1 (its proposal can be voted in parallel with step 5).
- Steps 2–3 can run any time after step 1; the DAO only matters for users once it's linked.

---

## 5. Right after go-live

- [ ] **ATM Upgrader checklist**: every on-chain item ticked (the 3 manual items: rollback noted, DAO
      admin, test plan).
- [ ] **Mainnet = testnet check** (read-only, from `atm-smart-contract`): `node integration/acl/compare-chains.js`.
      Every **CODE** row must say **same** (ACL, DAO, Factory, Trader run the identical build on both chains).
      Every **SETTINGS** row must say **same**, except the ones marked *differs (by decision)* (verifier
      type and custom types: testnet has 5 VERIFIED, mainnet none at launch). **WHO CONTROLS IT** differs by
      network on purpose.
- [ ] Smoke test with small amounts and fresh wallets:
  - [ ] a normal wallet creates a small BNB connection and a LUCA connection: works as before
  - [ ] **Types & rules → Check a connection**: normal → normal allowed; blacklisted creator blocked;
        frozen creator blocked; normal → frozen user B (no safe wallet) at 100% LUCA blocked
  - [ ] **Wallets → Look up** a few known frozen / blacklisted wallets: status and payouts as before
- [ ] Update the addresses: `atm-smart-contract/integration/acl/addresses.json` → `"56"`
      (`ATMAccessControlDAO`, versions) and anything else that lists mainnet ACL addresses.
- [ ] Tell the app / backend teams: the new DAO address (`ACL.dao()`), and that `canCreateConnection`
      now decides connections on mainnet.

---

## 6. Rollback (only if needed)

Upgrade back to the implementations in section 1, **Factory first, then ACL** (the old ACL has no
`checkConnection`, so the new Factory with the old ACL would fail every `createLink`).

1. **5. Factory**: "use one already deployed" → `0x11aA4F8686484779Fd8a87F68E725C131931bC86` →
   Management proposal + votes.
2. **1. ACL**: `0x9CC4C195cB5aC34c845bEC3B29a602603ECf51F7` → **Upgrade ACL** (`0x585E…5bCF`).
3. **6. Trader** (only if the Trader is the problem): `0x240b060fD1c5E8231A454441693678eE42Bf420A`.

Storage is append-only: v1.0.0 keeps all blacklist / frozen / safe-wallet data; the v1.1.0-only data
(types, rules, protected marks, DAO link) is ignored until you upgrade again. The DAO can stay
deployed (unlinked it does nothing).

---

## 7. What has been tested

| Where | Result |
|---|---|
| BSC **mainnet fork**, full release from live v1.0.0 (steps 1–6 with the live admins impersonated), all conditions | 55/55 (block 134,337,700); 54/55 at block 136,023,935, the 1 being a timeout of the RPC-heavy check 1.1, which the rehearsal below passed |
| BSC **mainnet fork, runbook dress rehearsal** (block 136,026,165): this UI's exact bytecode, `0x585E…` for steps 1–4, real Management proposals with 5 of 8 node votes for steps 5–7, then smoke tests and rollback | **9/9**: all 27 proposals and 363 wallets unchanged after step 1 and after go-live; DAO admin hand-over to Management works; rollback restores v1.0.0 with all data |
| BSC **testnet**, live contracts = this exact build | 78/78 fork tests; manual sheet 57 ✅, 4 UI-only not run |

Storage layout: the 15 v1.0.0 slots are unchanged (one renamed, same type); 14 new variables are appended. All 32 v1.0.0 functions are kept with the same inputs and outputs.

**Known gap, not fixed by this release:** BNB / BUSD connections don't ask the ACL when someone
joins or withdraws (only LUCA goes through the Trader's check). A wallet frozen after it joined a BNB
connection can still withdraw it. Fixing it needs a Link change (on hold).
