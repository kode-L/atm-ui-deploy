'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { loadVoucherTypes } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { DEPLOY_STEPS, WIRE_STEPS, checkDeployStep, checkWireStep } from './steps';
import { btnCls, btnSecondaryCls } from './ui';

interface Step { title: string; detail: string; tab: string; done: boolean }

const ERC20_BAL = ['function balanceOf(address) view returns (uint256)'];

/** The whole setup as six plain steps, each with its status and a button to the place that does it. */
export default function ChecklistCard({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [steps, setSteps] = useState<Step[] | null>(null);

  const check = useCallback(async () => {
    if (!ctx.reader) return;
    const deployed = (await Promise.all(DEPLOY_STEPS.filter((s) => !s.optional).map((s) => checkDeployStep(ctx, s).catch(() => ({ done: false }))))).filter((r) => r.done).length;
    const deployTotal = DEPLOY_STEPS.filter((s) => !s.optional).length;
    const required = WIRE_STEPS.filter((s) => !s.optional);
    const wired = (await Promise.all(required.map((s) => checkWireStep(ctx, s).catch(() => ({ done: false }))))).filter((r) => r.done).length;

    let funded = false;
    let typeCount = 0;
    let withMinter = 0;
    let minted = 0;
    try {
      if (c.RewardSink) {
        funded = (await ctx.reader.getBalance(c.RewardSink)).gt(0);
        for (const t of Object.values(ctx.book.tokens)) {
          if (funded) break;
          funded = (await new ethers.Contract(t, ERC20_BAL, ctx.reader).balanceOf(c.RewardSink).catch(() => ethers.BigNumber.from(0))).gt(0);
        }
      }
      if (c.VoucherNFT) {
        const nft = ctx.read('VoucherNFT');
        const types = await loadVoucherTypes(nft);
        typeCount = types.length;
        for (const t of types) if ((await nft.getRoleMembers(await nft.typeMinterRole(t.id))).length) withMinter++;
        minted = (await nft.totalSupply()).toNumber();
      }
    } catch {
      // partial setup — the steps simply stay open
    }

    setSteps([
      { title: 'Deploy the contracts', detail: `${deployed} of ${deployTotal} deployed`, tab: 'deploy', done: deployed === deployTotal },
      { title: 'Connect them together', detail: `${wired} of ${required.length} connections done`, tab: 'wire', done: wired === required.length },
      { title: 'Put rewards in a pool', detail: funded ? 'the main pool holds rewards' : 'top up the main pool (or deploy more pools)', tab: 'funding', done: funded },
      { title: 'Create a voucher type', detail: typeCount ? `${typeCount} type(s)` : 'pick what claiming gives, name it', tab: 'types', done: typeCount > 0 },
      { title: 'Choose who can mint', detail: typeCount ? `${withMinter} of ${typeCount} types have a minter` : 'after creating a type', tab: 'roles', done: typeCount > 0 && withMinter === typeCount },
      { title: 'Mint a test voucher', detail: minted ? `${minted} voucher(s) minted` : 'VoucherNFT tab → Vouchers → Mint', tab: 'types', done: minted > 0 },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.reader, ctx.book, ctx.revision]);

  useEffect(() => { check(); }, [check]);

  const next = steps?.findIndex((s) => !s.done) ?? -1;

  return (
    <Card title="Getting started">
      {!steps ? (
        <Loader2 className="w-4 h-4 animate-spin text-txt-secondary" />
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.title} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${i === next ? 'bg-accent/10 ring-1 ring-accent/40' : ''}`}>
              {s.done ? <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" /> : <Circle className="w-5 h-5 text-txt-secondary shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${s.done ? 'text-txt-secondary' : ''}`}>{i + 1}. {s.title}</div>
                <div className="text-xs text-txt-secondary">{s.detail}</div>
              </div>
              <button className={i === next ? btnCls : btnSecondaryCls} onClick={() => onGo(s.tab)}>{s.done ? 'Open' : i === next ? 'Do this next →' : 'Go'}</button>
            </li>
          ))}
          {next === -1 && <p className="text-xs text-green-300 pt-1">All set — use the Health check below to keep an eye on it.</p>}
        </ol>
      )}
    </Card>
  );
}
