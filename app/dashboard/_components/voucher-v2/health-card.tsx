'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import Card from '@/components/card';
import {
  ARTIFACTS, RewardTiming, VoucherMode, VoucherType, ZERO, loadVoucherTypes, role, sameAddr, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DESTINATION_LISTS } from './destinations-card';
import { Badge, btnSecondaryCls, linkBtnCls } from './ui';
import { ethers } from 'ethers';

interface Issue {
  level: 'bad' | 'warn';
  text: string;
  tab: string;
  typeId?: number;
  type?: string; // "#2 Reward Native" — shown as a chip, not repeated in the text
}

/**
 * One place that answers "is the voucher system configured properly?": checks every voucher type
 * end to end (pool approved + funded, tokens, minters, DAO committee, payout allowlists) and
 * links each problem to the tab that fixes it.
 */
export default function HealthCard({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [typeCount, setTypeCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    if (!c.VoucherNFT || !ctx.reader) return setIssues(null);
    setLoading(true);
    const out: Issue[] = [];
    try {
      const nft = ctx.read('VoucherNFT');
      const linked: string = await nft.sourceRegistry().catch(() => ZERO);
      const reg = !sameAddr(linked, ZERO) ? ctx.read('SourceRegistry', linked) : null;
      if (!reg) out.push({ level: 'warn', text: 'VoucherNFT is not linked to SourceRegistry — funding sources and payout recipients are not checked (Wire step 1).', tab: 'wire' });
      if (c.VoucherDAO && !(await nft.hasRole(role('REVOKE_ROLE'), c.VoucherDAO).catch(() => true))) {
        out.push({ level: 'warn', text: 'VoucherDAO has no REVOKE_ROLE — DAO revoke proposals will fail (Wire step 3).', tab: 'wire' });
      }
      const dao = c.VoucherDAO ? ctx.read('VoucherDAO') : null;
      const types: VoucherType[] = await loadVoucherTypes(nft);
      setTypeCount(types.length);
      if (!types.length) out.push({ level: 'warn', text: 'No voucher types registered yet.', tab: 'types' });

      for (const t of types) {
        const add = (level: Issue['level'], text: string, tab: string) => out.push({ level, text: text.charAt(0).toUpperCase() + text.slice(1), tab, typeId: t.id, type: typeLabel(t) });
        const reward = t.mode === VoucherMode.Reward;
        const noSource = sameAddr(t.fundingSource, ZERO);

        if (reward && noSource) add('bad', 'no funding source — it cannot pay out.', 'types');
        if (reg && !noSource) {
          const ok = reward ? await reg.isRewardSinkApproved(t.tokenStandard, t.fundingSource) : await reg.isPointsSinkApproved(t.fundingSource);
          if (!ok) add('bad', `its pool ${ctx.nameOf(t.fundingSource)} is no longer approved in SourceRegistry.`, 'wire');
        }
        if (reward && t.approvedTokens.length === 0) add('bad', 'no approved payout token — every mint reverts.', 'types');

        // funded? (Immediate rewards check the pool at mint time)
        if (reward && !noSource && t.rewardTiming === RewardTiming.Immediate && t.approvedTokens.length) {
          const sink = new ethers.Contract(t.fundingSource, ARTIFACTS.RewardSink.abi, ctx.reader);
          const bal = await sink.availableBalance(t.id, t.tokenStandard, t.approvedTokens[0], 0).catch(() => null);
          if (bal && bal.isZero()) add('warn', `pool ${ctx.nameOf(t.fundingSource)} is empty for ${sameAddr(t.approvedTokens[0], ZERO) ? 'the native coin' : ctx.nameOf(t.approvedTokens[0])} — mints will revert until funded.`, 'funding');
        }

        const minters: string[] = await nft.getRoleMembers(await nft.typeMinterRole(t.id));
        if (t.mintApprovalsRequired > 1) {
          if (!c.VoucherDAO || !minters.some((m) => sameAddr(m, c.VoucherDAO))) add('bad', `needs ${t.mintApprovalsRequired} approvals but VoucherDAO cannot mint it.`, 'roles');
          if (dao) {
            const [props, apprs] = await Promise.all([dao.getProposersOf(t.id), dao.getApproversOf(t.id)]);
            if (!props.length) add('warn', 'no DAO proposers — nobody can open a mint proposal.', 'roles');
            // proposing counts as approval #1, so quorum - 1 approvers are needed on top
            if (apprs.length < t.mintApprovalsRequired - 1) add('warn', `${apprs.length} DAO approver(s), quorum ${t.mintApprovalsRequired} needs at least ${t.mintApprovalsRequired - 1}.`, 'roles');
          }
          const direct = minters.filter((m) => !sameAddr(m, c.VoucherDAO));
          if (direct.length) add('warn', `${direct.length} direct minter(s) besides VoucherDAO — they can mint without a vote.`, 'roles');
        } else if (!minters.length) {
          add('warn', 'no minters — nobody can mint it.', 'roles');
        } else if (dao && c.VoucherDAO && minters.some((m) => sameAddr(m, c.VoucherDAO))) {
          // 1-approval type the DAO also mints: proposals execute on propose, so only proposers matter
          if (!(await dao.getProposersOf(t.id)).length) add('warn', 'VoucherDAO can mint it but has no proposers for it.', 'roles');
        }

        if (reg && reward && !sameAddr(t.payoutRecipient, ZERO)) {
          const ok = await reg.isDestinationApproved(DESTINATION_LISTS[0].key, t.payoutRecipient).catch(() => true);
          if (!ok) add('warn', `fixed payout recipient ${ctx.nameOf(t.payoutRecipient)} is no longer on the allowlist (existing setting still works).`, 'wire');
        }
        if (t.mintingPaused) add('warn', 'minting is paused.', 'types');
        if (t.redemptionPaused && !(t.mode === VoucherMode.Points && noSource)) add('warn', 'redemption (claim) is paused.', 'types');
      }
    } catch (e: any) {
      out.push({ level: 'bad', text: `Could not finish the check: ${e.message}`, tab: 'overview' });
    } finally {
      setIssues(out);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.VoucherNFT, c.VoucherDAO, ctx.reader, ctx.revision]);

  useEffect(() => { check(); }, [check]);

  const fix = (i: Issue) => {
    if (i.typeId !== undefined) ctx.setTypeId(i.typeId);
    onGo(i.tab);
  };

  const bad = issues?.filter((i) => i.level === 'bad').length ?? 0;
  const warn = issues?.filter((i) => i.level === 'warn').length ?? 0;

  return (
    <Card title="Health check">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {loading ? <Loader2 className="w-4 h-4 animate-spin text-txt-secondary" />
          : !c.VoucherNFT ? <span className="text-sm text-txt-secondary">Deploy VoucherNFT to start.</span>
          : issues && !issues.length ? <span className="flex items-center gap-1.5 text-sm text-green-300"><CheckCircle2 className="w-4 h-4" /> All {typeCount} type(s) look ready</span>
          : issues && <span className="text-sm">{bad > 0 && <Badge tone="bad">{bad} blocking</Badge>} {warn > 0 && <Badge tone="warn">{warn} to check</Badge>}</span>}
        <span className="flex-1" />
        <button className={btnSecondaryCls} disabled={loading} onClick={check}>
          <span className="inline-flex items-center gap-1.5"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Re-check</span>
        </button>
      </div>
      {!!issues?.length && (
        <ul className="space-y-1.5">
          {issues.map((i, n) => (
            <li key={n} className="flex items-start gap-2 text-xs">
              <Badge tone={i.level === 'bad' ? 'bad' : 'warn'}>{i.level === 'bad' ? 'fix' : 'check'}</Badge>
              {i.type && <span className="shrink-0 text-txt-primary font-medium">{i.type}</span>}
              <span className="flex-1 text-txt-secondary">{i.text}</span>
              <button className={linkBtnCls} onClick={() => fix(i)}>Fix →</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
