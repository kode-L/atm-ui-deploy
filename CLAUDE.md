# atm-UI-deploy — UI rules

## 1. Every section shows the on-chain version of its contracts
- Each dashboard tab starts with the **Overview** (`components/contract-overview.tsx`): every contract
  the tab uses, with its `version()` / `VERSION()` and implementation **read live from the chain** —
  never a hard-coded version string.
- A new tab or a new contract in a tab must be added to `lib/contracts/section-contracts.ts`, resolving
  the address exactly the way the tab itself does.
- Voucher V2 has its own Overview sub-tab; its **On-chain set** card reads the live set from VoucherNFT.

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

## Tooling
- Yarn PnP or `node_modules` depending on the last install. Typecheck: `./node_modules/.bin/tsc --noEmit -p .`
  (or `yarn tsc --noEmit -p .` under PnP), then `git checkout -- tsconfig.tsbuildinfo`.
