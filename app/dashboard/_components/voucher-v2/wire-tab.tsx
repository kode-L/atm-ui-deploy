'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { settledRead } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import DestinationsCard from './destinations-card';
import PoolsCard from './pools-card';
import { OPEN_ADVANCED_KEY } from './extra-sinks-card';
import { WIRE_STEPS, WireStep, StepResult, checkWireStep, wirePrefill } from './steps';
import { Collapsible, ContractGroup, ContractTag, Field, NavButtons, StepCard, StepStatus, btnCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';
import { isAddr, sameAddr } from '@/lib/contracts/voucher-v2';

type Check = StepResult | 'checking';

// Wire steps grouped by the contract they send to
const WIRE_GROUPS: { contract: 'VoucherNFT' | 'SourceRegistry'; note: string }[] = [
  { contract: 'VoucherNFT', note: 'the voucher contract: its registry link and who may manage / revoke' },
  { contract: 'SourceRegistry', note: 'the pool registry: which pools may pay out what' },
];

export default function WireTab({ onGo, target }: { onGo: (t: string) => void; target?: 'VoucherNFT' | 'SourceRegistry' }) {
  const ctx = useVoucherV2();
  // opened expanded when arriving from a pool's "Change access control" link (Fund pools tab)
  const [openAdvanced] = useState(() => {
    try {
      const v = sessionStorage.getItem(OPEN_ADVANCED_KEY) === '1';
      sessionStorage.removeItem(OPEN_ADVANCED_KEY);
      return v;
    } catch {
      return false;
    }
  });
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // operator overrides per step/field; anything not overridden follows the address book
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});

  const valuesOf = useCallback(
    (s: WireStep) => ({ ...wirePrefill(ctx, s), ...edits[s.id] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.book, ctx.account, edits]
  );

  const check = useCallback(
    (s: WireStep) => checkWireStep(ctx, s, valuesOf(s)).catch((e): StepResult => ({ done: false, detail: `Check failed: ${e.message}` })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.book, ctx.reader, ctx.account, valuesOf]
  );

  const recheckOne = async (s: WireStep) => {
    setChecks((prev) => ({ ...prev, [s.id]: 'checking' }));
    const r = await check(s);
    setChecks((prev) => ({ ...prev, [s.id]: r }));
  };

  // a Reset changes the values after the input's blur already re-checked — re-check once more on the next render
  const [recheckId, setRecheckId] = useState<string | null>(null);
  useEffect(() => {
    const s = WIRE_STEPS.find((x) => x.id === recheckId);
    if (s) recheckOne(s);
    setRecheckId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckId]);

  const setField = (s: WireStep, name: string, value: string | undefined) =>
    setEdits((prev) => {
      const forStep = { ...prev[s.id] };
      if (value === undefined) delete forStep[name];
      else forStep[name] = value.trim();
      return { ...prev, [s.id]: forStep };
    });

  const refresh = async () => {
    setChecks(Object.fromEntries(WIRE_STEPS.map((s) => [s.id, 'checking'])));
    const out: Record<string, Check> = {};
    for (const s of WIRE_STEPS) out[s.id] = await check(s);
    setChecks(out);
  };

  // re-check when the chain/book changes; field edits re-check their own step on blur
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [ctx.book, ctx.reader, ctx.account]);

  const statusOf = (s: WireStep): StepStatus => {
    const c = checks[s.id];
    if (!c || c === 'checking') return 'checking';
    if (c.done) return 'done';
    return c.blocked ? 'blocked' : 'todo';
  };

  const runOne = async (s: WireStep) => {
    setBusy(s.id);
    setMsg(null);
    try {
      const v = valuesOf(s);
      const bad = s.fields.filter((f) => !isAddr(v[f.name] || ''));
      if (bad.length) throw new Error(`Fill in a valid address for: ${bad.map((f) => f.label).join(', ')}`);
      await s.run(ctx, v);
      const r = await settledRead(() => check(s), (x) => x.done);
      setChecks((prev) => ({ ...prev, [s.id]: r || { done: false } }));
      setMsg(r?.done ? { ok: true, text: `${s.title}: done` } : { ok: false, text: "Sent, but the chain doesn't show it yet — hit Re-check in a few seconds" });
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
      return false;
    } finally {
      setBusy(null);
    }
  };

  // done steps fold to one line until opened
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const collapsed = (s: WireStep) => statusOf(s) === 'done' && !openSteps[s.id];
  const approvedOf = (s: WireStep) => {
    const c = checks[s.id];
    return c && c !== 'checking' ? c.approvedPicks || [] : [];
  };
  const pickedOf = (s: WireStep) => (s.pick ? (valuesOf(s)[s.pick.name] || '').split(',').filter(Boolean) : []);
  // a step with a selection can't be sent until something is picked
  const readyToSend = (s: WireStep) => statusOf(s) === 'todo' && (!s.pick || pickedOf(s).length > 0);
  const togglePick = (s: WireStep, value: string) => {
    if (!s.pick) return;
    const cur = pickedOf(s);
    const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    setField(s, s.pick.name, next.join(','));
    setRecheckId(s.id);
  };
  const pendingRequired = WIRE_STEPS.filter((s) => (!target || s.target === target) && !s.optional && readyToSend(s));
  const runAll = async () => {
    for (const s of pendingRequired) if (!(await runOne(s))) break;
  };

  return (
    <div className="space-y-4">
      <Card title={target ? `${target} setup` : 'Wire the contracts together'}>
        <p className="text-sm text-txt-secondary">
          Each step checks the chain and only needs sending if it isn&apos;t in place yet. Addresses are prefilled from the address book — open a step to check or change them.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <button className={btnCls} disabled={!!busy || pendingRequired.length === 0} onClick={runAll}>Send all required steps ({pendingRequired.length})</button>
          <button className={btnSecondaryCls} disabled={!!busy} onClick={refresh}>Re-check</button>
        </div>
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>

      {WIRE_GROUPS.filter((g) => !target || g.contract === target).map((group) => (
        <ContractGroup key={group.contract} contract={group.contract} note={group.note} hideHeading={!!target}>
          {WIRE_STEPS.filter((s) => s.target === group.contract).map((s) => {
        // number within what this tab shows, not the global step list
        const i = WIRE_STEPS.filter((x) => !target || x.target === target).indexOf(s);
        const c = checks[s.id];
        const r = c && c !== 'checking' ? c : undefined;
        return (
          <StepCard key={s.id} index={i + 1} title={s.title} why={collapsed(s) ? undefined : s.why} optional={s.optional} status={statusOf(s)} detail={r?.detail || r?.blocked}>
            <ContractTag contract={s.target} methods={[s.method]} label="Sends to" />
            {collapsed(s) ? (
              <button className={linkBtnCls} onClick={() => setOpenSteps((p) => ({ ...p, [s.id]: true }))}>{s.pick ? 'Change / approve more…' : 'Show details…'}</button>
            ) : (<>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {s.fields.map((f) => {
                const prefill = f.prefill(ctx);
                const edited = edits[s.id]?.[f.name];
                const value = edited ?? prefill;
                const changed = edited !== undefined && !sameAddr(edited, prefill);
                return (
                  <Field
                    key={f.name}
                    label={f.label}
                    hint={
                      <>
                        {f.note}
                        {!prefill && ' Not in the address book yet — deploy it first or paste the address.'}
                        {value && !isAddr(value) && <span className="text-red-300"> Not a valid address.</span>}
                        {changed && (
                          <>
                            {' '}<span className="text-yellow-300">Changed from the address book.</span>{' '}
                            <button className={linkBtnCls} onClick={() => { setField(s, f.name, undefined); setRecheckId(s.id); }}>Reset</button>
                          </>
                        )}
                      </>
                    }
                  >
                    <input
                      className={inputCls}
                      value={value}
                      placeholder="0x…"
                      onChange={(e) => setField(s, f.name, e.target.value)}
                      onBlur={() => recheckOne(s)}
                    />
                  </Field>
                );
              })}
            </div>
            {s.pick && (
              <Field label={s.pick.label} hint={s.pick.note}>
                <div className="flex flex-wrap gap-4 py-1">
                  {s.pick.options.map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={approvedOf(s).includes(o.value) || pickedOf(s).includes(o.value)} disabled={approvedOf(s).includes(o.value)} onChange={() => togglePick(s, o.value)} />
                      {o.label}{approvedOf(s).includes(o.value) && <span className="text-green-300 text-xs">approved</span>}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <div className="flex items-center gap-3">
              <button className={btnCls} disabled={!!busy || !readyToSend(s)} onClick={() => runOne(s)}>
                {busy === s.id ? 'Sending…' : statusOf(s) === 'done' ? 'Done ✓' : s.action}
              </button>
              {s.pick && statusOf(s) === 'todo' && pickedOf(s).length === 0 && (
                <span className="text-xs text-txt-secondary">Tick at least one option above.</span>
              )}
            </div>
            </>)}
          </StepCard>
        );
          })}
        </ContractGroup>
      ))}

      {!target && (
      <Collapsible title="Advanced (optional)" summary="payout allowlists · pool names · access control" defaultOpen={openAdvanced}>
        <DestinationsCard />
        <PoolsCard />
      </Collapsible>
      )}

    </div>
  );
}
