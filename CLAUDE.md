# atm-UI-deploy — UI rules

## 1. Every section shows the on-chain version of its contracts
- Each dashboard tab starts with the **Overview** (`components/contract-overview.tsx`): every contract
  the tab uses, with its `version()` / `VERSION()` and implementation **read live from the chain** —
  never a hard-coded version string.
- A new tab or a new contract in a tab must be added to `lib/contracts/section-contracts.ts`, resolving
  the address exactly the way the tab itself does.
- Voucher V2 has its own Overview sub-tab; its **On-chain set** card reads the live set from VoucherNFT.
- ACL & Management renders its own Overview, because its addresses are resolved from the chain
  (File → `accessControl()` → ACL → `dao()`, proxy admin slots → Management).

## 2. Addresses come from `lib/contracts/chain.json`
- `chain.json` (per chain id: "97" testnet, "56" mainnet) is the source of truth for production
  addresses. A `.env` value is only a fallback for an empty field and must be a real address
  (placeholders are ignored). Saved browser overrides that aren't real addresses are ignored too.
- New contracts (e.g. a freshly deployed VoucherAdapter) come from local storage until their address is
  committed to `chain.json`.
- When the UI reports a difference between `chain.json` and the chain (e.g. Voucher V2 → Overview →
  On-chain set), update `chain.json` in the next commit — the card offers the updated JSON to paste.

## 3. Show on-chain truth, not stored flags
- Status shown to the user must follow the contract's own rules evaluated against the chain's current
  block time (e.g. a contribution pool past its `endTime` is "Ended" even if `contributionsOpen` is true).
- Configured values (e.g. registry type caps) are read from the contract; local presets only pre-fill
  forms and must show the on-chain value next to them.

## 4. Deploy tab
- Deploy/upgrade cards are collapsible and closed by default (rarely used once deployed).
- Order follows the upgrade runbook: Upgrade GameHub → Upgrade DSM (DailySessionManager) → Deploy VoucherAdapter, then
  link it in Hub → Linked Contracts → Voucher Adapter.
- Contract JSONs in `lib/contracts/` are built from the tested AGF sources — don't hand-edit bytecode.
- Naming: say **DSM**, never "fleet", for the operators' DailySessionManagers — render it as
  `<abbr title="DailySessionManager">DSM</abbr>` so hovering shows the full name.

## 5. Transaction feedback stays with the action
- While a tx is pending, the **button that sent it** shows a spinner and can't be clicked again.
  `components/tx-status.tsx` does this for any button: render `<TxStatus>` (or call `useBusyButton(pending)`).
- Status, tx hash and error appear as a **toast in the bottom-right stack** (`TxStatus` / `ToastPortal`),
  never as a block at the end of a long section or somewhere else on the page. Each toast has
  copy buttons (hash, error, "Copy all") and a close (×). It stays open until the user closes it
  or the next tx replaces it.
- Multi-step actions (Voucher V2 `FlowPanel`) use the same stack, so toasts never overlap.
- Don't add new inline status blocks, `alert()`s or separate toast libraries for tx results.
- Never use the browser's `window.confirm` / `prompt` / `alert`. Ask with `confirmDialog` / `promptDialog`
  from `components/confirm-dialog.tsx` (same look as the Voucher V2 review modal) and give it the details:
  network, contract + address, call, signer, the transactions in order, and what can't be undone.

## 5b. ATM Upgrader tab
- `atm-upgrader-section.tsx` is the ACL v1.1.0 upgrade only (ACL → DAO → link → production rules →
  Factory → Trader v1.0.5), one checklist whose step states are read from the chain. It shares
  `management/use-acl-ctx.ts` (data, run, deploy, toast) with ACL & Management — don't duplicate it.
- Versions follow mainnet + 1 (ACL v1.1.0, Trader v1.0.5); never bump them for testnet builds.
- Management-admin'd upgrades show the open proposal with votes / Vote, and a second proposal for the
  same upgrade is blocked while one is open (`findMgmtProposals`, batched reads).

## 6. Admin actions show who signs them
- Every admin action (upgrade, change admin, owner-only call) names the contract it changes and the
  address that must sign, read live (proxy admin slot / `owner()`), tagged wallet / Management multisig /
  contract (`ControlledAction` in `app/dashboard/_components/management/shared.tsx`).
- Connected wallet is the signer → send it. Management multisig and you're a node → create the
  proposal. Anyone else → say which wallet to connect and offer a copyable request for that admin.
- Anything that needs someone's approval (ACL operator proposals, ACL DAO requests, Management
  proposals) is listed from the contract's own enumerable views (counter + getter, `pendingProposals`,
  `canApprove`), never from browser storage or public-RPC log scans (they silently drop logs on BSC),
  so any approver can open the page, connect and approve.
- Contracts deployed from the UI get a **Verify** button (`components/verify-button.tsx`). Bundled ACL
  JSONs come from `scripts/sync-acl-contracts.js` (with minimal verification inputs) — re-run it, don't hand-edit.
- Proxy deploy/upgrade cards use the Deploy tab's layout (`UpgradeCard` in
  `app/dashboard/_components/management/upgrade-card.tsx`): collapsible, current version on top,
  **1. Deploy new implementation** and **2. Upgrade** side by side, and **Who controls it** (proxy admin
  = upgrades, owner = settings, change admin) at the bottom.

## Tooling
- Yarn PnP or `node_modules` depending on the last install. Typecheck: `./node_modules/.bin/tsc --noEmit -p .`
  (or `yarn tsc --noEmit -p .` under PnP), then `git checkout -- tsconfig.tsbuildinfo`.
