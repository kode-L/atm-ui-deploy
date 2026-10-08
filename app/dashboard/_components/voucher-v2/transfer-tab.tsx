'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '@/components/card';
import {
  MAX_UINT, PayoutMode, PointsDirection, RewardTiming, TokenStandard, VoucherMode, VoucherType, ZERO,
  eventArg, isAddr, loadVoucherTypes, role, sameAddr, settledRead, typeLabel,
} from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import type { StepResult } from './steps';
import { AddressInput, Field, NavButtons, Select, StepCard, StepStatus, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

interface PairStep {
  id: string;
  title: string;
  why?: string;
  check: () => Promise<StepResult>;
  run?: () => Promise<unknown>;
}

export default function TransferTab({ onGo }: { onGo: (t: string) => void }) {
  const ctx = useVoucherV2();
  // stable pieces only — the full ctx object changes on every tx-log update
  const { read, write, send: ctxSend, nameOf, account } = ctx;
  const xferAddr = ctx.book.contracts.VoucherTransfer;
  const [types, setTypes] = useState<VoucherType[]>([]);
  const [creditId, setCreditId] = useState(-1);
  const [debitId, setDebitId] = useState(-1);
  const [legacy, setLegacy] = useState(false);
  const [checks, setChecks] = useState<Record<string, StepResult | 'checking'>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');

  const creditTypes = types.filter((t) => t.mode === VoucherMode.Points && t.pointsDirection === PointsDirection.Credit);
  const debitTypes = types.filter((t) => t.mode === VoucherMode.Points && t.pointsDirection === PointsDirection.Debit);
  const credit = types.find((t) => t.id === creditId);
  const debit = types.find((t) => t.id === debitId);

  const isUnlimitedMinter = useCallback(async (typeId: number) => {
    const nft = read('VoucherNFT');
    if (!(await nft.hasRole(await nft.typeMinterRole(typeId), xferAddr))) return false;
    return (await nft.getMinterDailyCap(typeId, xferAddr)).limit.toString() === MAX_UINT;
  }, [read, xferAddr]);

  const steps = useMemo<PairStep[]>(() => {
    if (!credit || !debit || !xferAddr) return [];
    const c = credit;
    const d = debit;
    const send = (label: string, key: 'VoucherNFT' | 'VoucherTransfer', method: string, args: any[], at?: string) =>
      ctxSend(label, write(key, at), method, args);
    return [
      {
        id: 'creditShape',
        title: `Credit type #${c.id} is backed by a points ledger`,
        why: 'Its fundingSource is the ledger VoucherTransfer debits the sender on — it must be a real points sink.',
        check: async () => sameAddr(c.fundingSource, ZERO)
          ? { done: false, detail: 'fundingSource is 0x0 — pick a credit type backed by VoucherIncentive' }
          : { done: true, detail: `Ledger: ${nameOf(c.fundingSource)}` },
      },
      {
        id: 'debitShape',
        title: `Debit type #${d.id} is a pure record (fundingSource 0x0, redemption paused)`,
        why: "Guarantees claiming the sender's record voucher can never move value. approveDebitType() checks this.",
        check: async () => !sameAddr(d.fundingSource, ZERO)
          ? { done: false, detail: "fundingSource isn't 0x0 — register a fresh debit-record type instead" }
          : d.redemptionPaused ? { done: true } : { done: false, detail: "Redemption isn't paused yet" },
        run: sameAddr(d.fundingSource, ZERO) ? () => send(`Type ${d.id}: pause redemption`, 'VoucherNFT', 'setVoucherTypeRedemptionPaused', [d.id, true]) : undefined,
      },
      {
        id: 'approveCredit',
        title: `Approve credit type #${c.id} on VoucherTransfer`,
        check: async () => ({ done: await read('VoucherTransfer').approvedCreditTypes(c.id) }),
        run: () => send(`VoucherTransfer: approve credit type ${c.id}`, 'VoucherTransfer', 'approveCreditType', [c.id]),
      },
      {
        id: 'approveDebit',
        title: `Approve debit type #${d.id} on VoucherTransfer`,
        check: async () => ({ done: await read('VoucherTransfer').approvedDebitTypes(d.id) }),
        run: () => send(`VoucherTransfer: approve debit type ${d.id}`, 'VoucherTransfer', 'approveDebitType', [d.id]),
      },
      {
        id: 'combo',
        title: `Allow the pair debit #${d.id} → credit #${c.id}`,
        why: "Individual approval isn't enough — each pairing is an explicit admin decision.",
        check: async () => ({ done: await read('VoucherTransfer').combinationAllowed(d.id, c.id) }),
        run: () => send(`VoucherTransfer: allow ${d.id} → ${c.id}`, 'VoucherTransfer', 'allowCombination', [d.id, c.id, true]),
      },
      {
        id: 'minterCredit',
        title: `VoucherTransfer can mint credit type #${c.id} (unlimited cap)`,
        why: "Every user's transfer mints through this one contract, so the default 100/day minter cap would throttle it.",
        check: async () => ({ done: await isUnlimitedMinter(c.id) }),
        run: () => send(`Type ${c.id}: minter → VoucherTransfer`, 'VoucherNFT', 'grantTypeMinterWithCap', [c.id, xferAddr, MAX_UINT, 0]),
      },
      {
        id: 'minterDebit',
        title: `VoucherTransfer can mint debit type #${d.id} (unlimited cap)`,
        check: async () => ({ done: await isUnlimitedMinter(d.id) }),
        run: () => send(`Type ${d.id}: minter → VoucherTransfer`, 'VoucherNFT', 'grantTypeMinterWithCap', [d.id, xferAddr, MAX_UINT, 0]),
      },
      {
        id: 'settler',
        title: `VoucherTransfer holds SETTLER_ROLE on ${nameOf(c.fundingSource)}`,
        why: 'Required for the synchronous applyPoints() debit of the sender.',
        check: async () => sameAddr(c.fundingSource, ZERO)
          ? { done: false, detail: 'No ledger' }
          : { done: await read('VoucherIncentive', c.fundingSource).hasRole(role('SETTLER_ROLE'), xferAddr) },
        run: () => ctxSend('Grant SETTLER_ROLE to VoucherTransfer', write('VoucherIncentive', c.fundingSource), 'grantRole', [role('SETTLER_ROLE'), xferAddr]),
      },
    ];
  }, [credit, debit, xferAddr, read, write, ctxSend, nameOf, isUnlimitedMinter]);

  const checkOne = (s: PairStep) => s.check().catch((e): StepResult => ({ done: false, detail: `Check failed: ${e.message}` }));

  const checkAll = useCallback(async () => {
    if (!steps.length) return;
    setChecks(Object.fromEntries(steps.map((s) => [s.id, 'checking'])));
    const out: Record<string, StepResult> = {};
    for (const s of steps) out[s.id] = await checkOne(s);
    setChecks(out);
  }, [steps]);

  const loadBalance = useCallback(async () => {
    setBalance(null);
    if (!credit || sameAddr(credit.fundingSource, ZERO)) return;
    try {
      setBalance((await read('VoucherIncentive', credit.fundingSource).globalPoints(account)).toString());
    } catch {
      setBalance(null);
    }
  }, [credit, read, account]);

  const reload = useCallback(async () => {
    if (!xferAddr || !ctx.getBook().contracts.VoucherNFT) return;
    try {
      await ctx.read('VoucherTransfer').approvedCreditTypes(0);
      setLegacy(false);
    } catch {
      setLegacy(true);
    }
    try {
      const ts = await loadVoucherTypes(ctx.read('VoucherNFT'));
      setTypes(ts);
      setCreditId((prev) => (prev >= 0 ? prev : ts.find((t) => t.mode === VoucherMode.Points && t.pointsDirection === PointsDirection.Credit)?.id ?? -1));
      setDebitId((prev) => (prev >= 0 ? prev : ts.find((t) => t.mode === VoucherMode.Points && t.pointsDirection === PointsDirection.Debit && sameAddr(t.fundingSource, ZERO))?.id ?? -1));
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xferAddr, ctx.reader]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { checkAll(); loadBalance(); }, [checkAll, loadBalance]);

  const statusOf = (s: PairStep): StepStatus => {
    const c = checks[s.id];
    if (!c || c === 'checking') return 'checking';
    if (c.done) return 'done';
    return s.run ? 'todo' : 'blocked';
  };
  const pending = steps.filter((s) => s.run && statusOf(s) === 'todo');

  const runStep = async (s: PairStep) => {
    if (!s.run) return false;
    setBusy(true);
    setMsg(null);
    try {
      await s.run();
      if (s.id === 'debitShape') {
        // type config changed — reload so the step list re-derives from fresh data
        const fresh = await settledRead(() => loadVoucherTypes(ctx.read('VoucherNFT')), (ts) => !!ts.find((t) => t.id === debitId)?.redemptionPaused);
        if (fresh) setTypes(fresh);
        return true;
      }
      const r = await settledRead(() => checkOne(s), (x) => x.done);
      setChecks((prev) => ({ ...prev, [s.id]: r || { done: false } }));
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runAll = async () => {
    for (const s of pending) if (!(await runStep(s))) break;
    await checkAll();
  };

  const createDebitRecord = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const nft = ctx.write('VoucherNFT');
      const receipt = await ctx.send('Register debit-record type', nft, 'registerVoucherType', [
        'Transfer Debit Record', 0, false, 1, VoucherMode.Points, TokenStandard.Native, ZERO, ZERO,
        RewardTiming.Immediate, PointsDirection.Debit, ZERO, ZERO, PayoutMode.Direct, ZERO,
      ]);
      const typeId = Number(eventArg(receipt, nft, 'VoucherTypeRegistered', 'typeId'));
      await ctx.send(`Type ${typeId}: pause redemption`, nft, 'setVoucherTypeRedemptionPaused', [typeId, true]);
      const fresh = await settledRead(() => loadVoucherTypes(ctx.read('VoucherNFT')), (ts) => ts.length > typeId);
      if (fresh) setTypes(fresh);
      setDebitId(typeId);
      setMsg({ ok: true, text: `Registered debit-record type #${typeId}` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const tryTransfer = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(`Transfer ${amount} points → ${ctx.nameOf(to)}`, ctx.write('VoucherTransfer'), 'transfer', [creditId, debitId, to, String(parseInt(amount, 10))]);
      setMsg({ ok: true, text: 'Transfer sent — the recipient now claims their Credit voucher to receive the points.' });
      setTimeout(loadBalance, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const disallow = async () => {
    setBusy(true);
    try {
      await ctx.send(`Disallow ${debitId} → ${creditId}`, ctx.write('VoucherTransfer'), 'allowCombination', [debitId, creditId, false]);
      await checkAll();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!xferAddr || !ctx.book.contracts.VoucherNFT) {
    return <Card><p className="text-sm text-txt-secondary text-center py-6">Deploy (or set) VoucherNFT and VoucherTransfer first — both are on the Deploy tab.</p></Card>;
  }

  const combo = checks.combo;
  return (
    <div className="space-y-4">
      {legacy && (
        <Card>
          <p className="text-sm text-yellow-300">
            ⚠ The VoucherTransfer at <span className="font-mono">{xferAddr}</span> is an older version (before curated credit/debit combinations).
            It can&apos;t be configured here — redeploy VoucherTransfer from the Deploy tab, then come back.
          </p>
        </Card>
      )}

      <Card title="Choose the transfer pair">
        <p className="text-xs text-txt-secondary mb-4">
          A transfer debits the sender synchronously on the credit type&apos;s points ledger, then mints a Debit-record voucher to the sender and a
          Credit voucher to the recipient. Every (debit, credit) pair must be explicitly allowed.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Credit type (recipient claims it)" hint={creditTypes.length ? undefined : 'No Points · Credit type yet — register one on the Voucher types tab.'}>
            <Select value={creditId} onChange={setCreditId} options={[{ label: 'Select…', value: -1 }, ...creditTypes.map((t) => ({ label: typeLabel(t), value: t.id }))]} />
          </Field>
          <Field label="Debit record type (sender's record)" hint={<button className={linkBtnCls} disabled={busy} onClick={createDebitRecord}>+ Register a new debit-record type (fundingSource 0x0, redemption paused)</button>}>
            <Select value={debitId} onChange={setDebitId} options={[{ label: 'Select…', value: -1 }, ...debitTypes.map((t) => ({ label: typeLabel(t), value: t.id }))]} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button className={btnCls} disabled={busy || legacy || pending.length === 0} onClick={runAll}>Run remaining steps ({pending.length})</button>
          <button className={btnSecondaryCls} disabled={busy} onClick={() => { reload(); checkAll(); }}>Re-check</button>
        </div>
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>

      {steps.map((s, i) => {
        const c = checks[s.id];
        return (
          <StepCard key={s.id} index={i + 1} title={s.title} why={s.why} status={statusOf(s)} detail={c && c !== 'checking' ? c.detail : undefined}>
            {s.run && <div><button className={btnCls} disabled={busy || legacy || statusOf(s) !== 'todo'} onClick={() => runStep(s)}>Run</button></div>}
          </StepCard>
        );
      })}

      {credit && debit && (
        <Card title="Try a transfer">
          <p className="text-xs text-txt-secondary mb-3">Sends points from the connected wallet. Your balance on this ledger: <b className="text-txt-primary">{balance ?? '—'}</b> points.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Recipient"><AddressInput value={to} onChange={setTo} /></Field>
            <Field label="Amount (points)"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <button className={btnCls} disabled={busy || !isAddr(to) || !(Number(amount) > 0)} onClick={tryTransfer}>Transfer</button>
            <button className={btnDangerCls} disabled={busy || !(combo && combo !== 'checking' && combo.done)} onClick={disallow}>Disallow this pair</button>
          </div>
        </Card>
      )}

      <NavButtons back={['roles', 'Roles']} next={['funding', 'Next: fund pools']} onGo={onGo} />
    </div>
  );
}
