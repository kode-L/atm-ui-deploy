# How to: tLUCA vouchers from the Voucher V2 tab

Everything below runs in the **Voucher V2** tab of this app. It reuses the v0.58 contracts already live on BSC testnet; nothing needs redeploying. For deploying a fresh set, see [voucher-v2-deploy-guide.md](voucher-v2-deploy-guide.md).

## Payout types

| Type | On claim, the tLUCA goes to | PR server credits luca? | typeId already on testnet |
| --- | --- | --- | --- |
| Direct | The user's wallet | No | 20 |
| Routed | ATM Incentive `0xA711ae1bdb635ACEC1Dd5E1a5d670dDb2858ae63` | Yes | 23 |
| External | Nowhere (no tokens move) | Yes | 19 |

Routed and External are paid to the user by the PR server, through the normal luca withdrawal from ATM Incentive.

## Before you start

- `corepack yarn dev`, then open the dashboard → **Voucher V2**.
- Connect the wallet that admins the testnet set (`0xaBF9723E1efF69AEe0BE0dfbabd2c1aDc7f05Cce`) on **BSC testnet (97)**. It also holds tLUCA and already has the minter role for types 19, 20 and 23.

## 1. Load the live addresses (once per browser)

**Overview → Address book → Import JSON**, paste, then **Import (replaces current book)**:

```json
{
  "chainId": 97,
  "VoucherNFT": "0xA1010B445db17C3d754B048dd40Cae4471290170",
  "VoucherDAO": "0x93aAbdcab0006164995822e4DaC689363746EF45",
  "VoucherNFTViews": "0x79651BfFc770ebc00C356632c2556A41cC1E0F5B",
  "SourceRegistry": "0x64BE35A20A40e783AB79B0F452577A53dB375644",
  "RevocationVault": "0x2947E7E7bf2CEAf0E777A76001eC9C6C1b936f51",
  "AllowlistTransferGate": "0xF4762e6267eAEDC2b596f01dC458894cE30dBcc7",
  "RewardVault": "0x2A7035cd1dAB7479b4cc8B024AA2266E95fB4a37",
  "VoucherSettlement": "0xec5bad08480e8E2108D0a42a53c24f370c538CDf",
  "VoucherTransfer": "0x3cEe9A72B239Ab8372479A9a460880847cf9f83E",
  "tokens": { "tLUCA": "0xD7a1cA21D73ff98Cc64A81153eD8eF89C2a1EfEF" }
}
```

## 2. Mint vouchers with the existing types (the common case)

1. **Pools → Fund a reward pool → Deposit**: for **Direct (20)** or **Routed (23)**, first send tLUCA to **VoucherSettlement**. It must hold enough for every unclaimed Direct/Routed voucher, or the mint fails with `RewardVaultInsufficient`. External (19) needs no funding.
2. **VoucherNFT → Vouchers → Mint**: pick the type, the recipient, the amount **in tLUCA** (e.g. `15`; the form converts to 18 decimals), start/expiry, and token **tLUCA**.
   **Many recipients:** set *How many recipients* to **Many (list or CSV)**. Add rows with **+ Add recipient**, or click **Upload CSV** (**Download template CSV** gives the `address,amount` format; NFT types add a `tokenId` column). A header row is fine. Rows with mistakes are outlined in red and listed under the table. The summary shows the count, total and how many transactions it takes; lists over 50 are sent as several `mintBatch` transactions in order. If one fails part-way, the table keeps only the recipients not minted yet. Each minter wallet may mint 100 vouchers per type per day by default (raise it under Roles).
   Example files ready to upload are in `public/examples/` (served by the app at `/examples/…`): `voucher-mint-tokens-example.csv` (tLUCA amounts with decimals), `voucher-mint-points-example.csv` (whole points) and `voucher-mint-nft-example.csv` (with a `tokenId` column; the pool must hold those ids for a Reserved NFT type). Their addresses are dummy test addresses, so replace them before minting for real.
3. The holder claims it in their own wallet: **VoucherNFT → Vouchers → My vouchers → Claim** (or from the user webapp).

## 3. Add a new tLUCA type (only if 19/20/23 don't fit)

1. **Routed only, once per destination:** **SourceRegistry → Allowlists → Route targets**, approve the destination (ATM Incentive is already approved).
2. **VoucherNFT → Create a new voucher type**: set Name, Payout token(s) = tLUCA, Funding mode and **Who mints it**, then open **Advanced options** for the rest:

   | Field | Direct | Routed | External |
   | --- | --- | --- | --- |
   | Mode | Reward | Reward | Reward |
   | Payout token standard | ERC20 | ERC20 | ERC20 |
   | Pool | VoucherSettlement | VoucherSettlement | VoucherSettlement |
   | Funding mode | Reserved | Reserved | OnClaim |
   | Payout mode | Direct | Routed | External |
   | Route target | — | ATM Incentive | — |
   | Payout token(s) | tLUCA | tLUCA | tLUCA |

3. If you need more minters later: **VoucherNFT → Manage a type → Minters of type #N**.
4. Note the new typeId under **Registered types**, then mint as in section 2.

## 4. Tell the PR server (Routed / External / Points types)

The PR server only credits typeIds listed in `ATM-PageRank-Node-Decentralized/project/configs/voucher/voucher_config.py` (today: points 0 and 1, External 19, Routed 23). For a new Routed or External tLUCA type:

- add its typeId to a group with `'mode': 1, 'coin': 'luca'`;
- use the **`erc20_no_cap`** algorithm (tLUCA amounts are 18-decimal; plain `no_cap` would credit 10^18 times too much);
- bump `APP_VERSION` and redeploy the PR server.

Never add a Direct type there: it is already paid on claim.

## Timing

The PR server's day runs 21:00 UTC to 21:00 UTC and credits at about 21:15 UTC. A claim before 21:00 UTC shows in the user's earnings that evening; after 21:00 UTC, the next evening.

## More

- Frontend integration (listing, claiming, withdrawing): `TLUCA_FRONTEND_GUIDE.md` in the voucher repo, `docs/bsc-testnet/`.
- Full contract reference: `VOUCHER_INTEGRATION.md` in the same folder.
