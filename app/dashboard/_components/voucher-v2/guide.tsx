'use client';
import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, XCircle } from 'lucide-react';
import Card from '@/components/card';
import { BNB_TESTNET, BSC_MAINNET, NETWORKS } from '@/lib/contracts/config';
import { ARTIFACT_MANIFEST, DEFAULT_ADMIN_ROLE } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DEPLOY_STEPS, WIRE_GAS } from './steps';
import { btnSecondaryCls } from './ui';

type Level = 'ok' | 'warn' | 'bad' | 'info';
interface Check { level: Level; title: string; text: React.ReactNode }

const ICON: Record<Level, React.ReactNode> = {
  ok: <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />,
  warn: <AlertTriangle className="w-4 h-4 text-yellow-300 shrink-0 mt-0.5" />,
  bad: <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />,
  info: <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />,
};

// How much headroom over the measured gas to ask for: covers the 25% gas-limit buffer, wallet
// gas-price bumps, and a few retries/voucher types on top.
const GAS_SAFETY = 3;
const fmtDate = (iso: string) => new Date(iso).toLocaleString();

/** Live pre-flight checks — the things that most often turn into a failed or wrong deployment. */
export function PreflightCard({ onExport, onGo }: { onExport: () => void; onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Check[] = [];
      const { chainId, account, reader, book } = ctx;
      const net = NETWORKS[chainId];

      // 1. Network
      if (chainId === BSC_MAINNET.chainId) {
        out.push({ level: 'warn', title: 'You are on BSC MAINNET', text: 'Every deploy and config step spends real BNB and creates the production contracts. Rehearse the whole flow on BNB Testnet first.' });
      } else if (chainId === BNB_TESTNET.chainId) {
        out.push({ level: 'ok', title: 'Network: BNB Smart Chain Testnet', text: 'Addresses saved here are kept separately from mainnet.' });
      } else {
        out.push({ level: 'warn', title: `Unrecognised network (chain ${chainId})`, text: 'Fine for a local Hardhat node; for anything real, switch to BNB Testnet or BSC Mainnet from the wallet menu.' });
      }

      // 2. Continuing an existing deployment?
      const hasAny = Object.keys(book.contracts).length > 0;
      if (!hasAny) {
        out.push({
          level: 'info',
          title: 'No Voucher V2 addresses saved for this network',
          text: chainId === BNB_TESTNET.chainId
            ? <>A testnet deployment already exists and an external backend reads it. To keep working with it, <b>import</b> the voucher repo&apos;s <code className="text-accent">deployments/bscTestnet.json</code> on this tab instead of deploying again.</>
            : 'Fresh start: deploy everything from the Deploy tab. If contracts already exist on this network, import their addresses first.',
        });
      }

      // 3. Admin wallet
      if (book.contracts.VoucherNFT && reader) {
        try {
          const isAdmin = await new ethers.Contract(book.contracts.VoucherNFT, ['function hasRole(bytes32,address) view returns (bool)'], reader).hasRole(DEFAULT_ADMIN_ROLE, account);
          out.push(isAdmin
            ? { level: 'ok', title: 'Connected wallet is the VoucherNFT admin', text: 'Wiring and configuration transactions can be sent from here.' }
            : { level: 'bad', title: 'Connected wallet is NOT the VoucherNFT admin', text: 'Switch to the admin wallet used at deploy time — otherwise every wiring/config transaction reverts.' });
        } catch {
          out.push({ level: 'warn', title: 'Could not read VoucherNFT', text: 'The saved VoucherNFT address may be wrong for this network — check it in the address book below.' });
        }
      } else {
        out.push({ level: 'info', title: 'Deploy from the wallet that should own the system', text: 'The wallet that deploys becomes admin of every contract. Ownership can be handed over later with grantRole/revokeRole, but it is easiest to deploy from the right wallet.' });
      }

      // 4. Gas balance
      if (reader && account) {
        try {
          const remaining = DEPLOY_STEPS.filter((s) => !book.contracts[s.key]).reduce((sum, s) => sum + s.gas, 0) + WIRE_GAS;
          const [balance, gasPrice] = await Promise.all([reader.getBalance(account), reader.getGasPrice()]);
          const need = gasPrice.mul(remaining).mul(GAS_SAFETY);
          const sym = net?.nativeCurrency.symbol || 'native';
          const f = (v: ethers.BigNumber) => Number(ethers.utils.formatEther(v)).toFixed(5);
          out.push(balance.gte(need)
            ? { level: 'ok', title: `Gas balance OK: ${f(balance)} ${sym}`, text: `Remaining deploy + wiring is about ${(remaining / 1e6).toFixed(1)}M gas ≈ ${f(gasPrice.mul(remaining))} ${sym} at the current gas price (${GAS_SAFETY}× buffer recommended).` }
            : { level: 'bad', title: `Low gas balance: ${f(balance)} ${sym}`, text: `Remaining deploy + wiring needs about ${f(gasPrice.mul(remaining))} ${sym}; keep at least ${f(need)} ${sym} so a run doesn't stop halfway.` });
        } catch {
          // balance/gas price unreadable — skip this check rather than show a wrong number
        }
      }

      // 5. Contract files
      const m = ARTIFACT_MANIFEST;
      out.push({
        level: m.gitDirty ? 'warn' : 'info',
        title: `Contract files: voucher repo commit ${m.gitCommit || 'unknown'}${m.gitDirty ? ' + uncommitted changes' : ''}`,
        text: <>Exported {fmtDate(m.exportedAt)}. If the voucher contracts changed since then, rerun <code className="text-accent">npx hardhat run scripts/exportWebappArtifacts.ts</code> in the voucher repo before deploying — otherwise this page deploys the old code.{m.gitDirty && ' These files include contract changes that were never committed — commit them first so the deployed code can be traced.'}</>,
      });

      // 6. Backup
      if (hasAny) {
        const unsaved = !book.lastExportAt || (book.lastChangeAt && book.lastChangeAt > book.lastExportAt);
        out.push(unsaved
          ? { level: 'bad', title: 'Addresses are only saved in this browser', text: 'Export the address book now and commit/share it. Clearing site data or switching browser/computer loses it — and the deployed contracts would be hard to find again.' }
          : { level: 'ok', title: 'Address book exported', text: `Last export ${fmtDate(book.lastExportAt as string)}.` });
      }

      if (!cancelled) setChecks(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.chainId, ctx.account, ctx.reader, ctx.book, ctx.revision]);

  const needsBackup = checks.some((c) => c.title.startsWith('Addresses are only saved'));
  return (
    <Card title="Before you start">
      <div className="space-y-3">
        {checks.map((c) => (
          <div key={c.title} className="flex gap-2.5">
            {ICON[c.level]}
            <div className="min-w-0">
              <p className="text-sm font-medium">{c.title}</p>
              <p className="text-xs text-txt-secondary mt-0.5">{c.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        {needsBackup && <button className={btnSecondaryCls} onClick={onExport}>Export address book now</button>}
        <button className={btnSecondaryCls} onClick={() => onGo('deploy')}>Go to Deploy →</button>
      </div>
    </Card>
  );
}

const RULES: { phase: string; items: React.ReactNode[] }[] = [
  {
    phase: 'Deploy',
    items: [
      <>Deploy in the order shown (VoucherNFT first). Contracts that need VoucherNFT stay blocked until it exists.</>,
      <>Never press <b>Redeploy</b> on a contract that is already in use: it gets a new address, old roles/types/balances don&apos;t move over, and anything pointing at the old one (other contracts, the PageRank backend) keeps using the old address.</>,
      <>If a deploy stops after the implementation tx, just press Deploy again — the saved implementation is reused and only the proxy tx is sent.</>,
      <>Export the address book after every session (Overview tab). It lives only in this browser until you do.</>,
    ],
  },
  {
    phase: 'Wire',
    items: [
      <>Finish all required wiring <b>before</b> registering voucher types — a type whose funding source isn&apos;t approved in the registry reverts with <code>FundingSourceNotApproved</code>.</>,
      <>Wiring must be sent by the admin wallet. <code>AccessControlUnauthorizedAccount</code> means the wrong wallet is connected.</>,
      <>If a step says &quot;sent, but the chain doesn&apos;t show it yet&quot;, wait a few seconds and press Re-check. Don&apos;t send it again — public BSC RPCs often lag behind a fresh write.</>,
    ],
  },
  {
    phase: 'Voucher types',
    items: [
      <>Type ids are permanent and numbered in registration order. The PageRank backend maps type ids to coins (<code>voucher_config.py</code>), so register types in a planned order and update that mapping afterwards.</>,
      <>Reward types need at least one approved token, and the pool must already hold enough of it — otherwise mint reverts with <code>FundingSourceInsufficient</code>. Fund on the Fund pools tab first.</>,
      <>ERC20 / native <b>faceValue is always in 18 decimals</b>, whatever the token&apos;s own decimals (12.5 USDC = 12.5 × 10¹⁸). The pool converts it on payout. Pool withdrawals use the same convention.</>,
      <>Types with mint approvals &gt; 1 mint through VoucherDAO: VoucherDAO needs that type&apos;s minter role, and you need at least as many operators as the quorum.</>,
    ],
  },
  {
    phase: 'Roles',
    items: [
      <>Every minter has a default cap of 100 vouchers per day. Contracts minting for everyone (e.g. VoucherDAO) need <b>unlimited</b> caps, or they stop working after 100 mints a day.</>,
    ],
  },
  {
    phase: 'After deploying',
    items: [
      <>Export the address book, then copy the addresses into the voucher repo&apos;s <code>deployments/&lt;network&gt;.json</code> so scripts and teammates use the same contracts.</>,
      <>If VoucherIncentive is new, update the PageRank backend: <code>settings.cfg</code> → <code>voucher_data.ADDRESS</code> and <code>FIRST_BLOCK</code>, plus the type ids in <code>voucher_config.py</code>.</>,
      <>To upgrade a contract later from the voucher repo, run <code>upgrades.forceImport()</code> on its proxy address first — these proxies weren&apos;t created by Hardhat.</>,
    ],
  },
];

export function RulesCard() {
  const [open, setOpen] = useState(true);
  return (
    <Card>
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <h3 className="text-lg font-semibold">Rules that prevent deployment errors</h3>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          {RULES.map((r) => (
            <div key={r.phase}>
              <h4 className="text-sm font-semibold text-accent mb-1.5">{r.phase}</h4>
              <ul className="list-disc pl-5 space-y-1.5 text-xs text-txt-secondary [&_code]:text-accent [&_b]:text-txt-primary">
                {r.items.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </div>
          ))}
          <p className="text-xs text-txt-secondary">The full written runbook is in <code className="text-accent">docs/voucher-v2-deploy-guide.md</code> in this repo.</p>
        </div>
      )}
    </Card>
  );
}
