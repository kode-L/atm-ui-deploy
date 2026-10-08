'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import Card from '@/components/card';
import { isAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { useHasRole } from './use-role';
import { Collapsible, ContractTag, Field, btnDangerCls, btnSecondaryCls, linkBtnCls } from './ui';

// SourceRegistry keeps one allowlist per key; VoucherNFT checks a type's fixed
// payoutRecipient and a Routed type's routeTarget against their own list.
export const DESTINATION_LISTS = [
  {
    key: ethers.utils.id('PAYOUT_RECIPIENT'),
    title: 'Payout recipients',
    note: "Addresses a voucher type may use as its fixed Payout recipient (every claim pays this address instead of the claimer). E.g. a treasury or partner wallet. Not needed for 'Whoever claims' (0x0).",
  },
  {
    key: ethers.utils.id('ROUTE_TARGET'),
    title: 'Route targets',
    note: 'Pools a Routed type may send its payout to (VoucherIncentive moves the asset there; the user stays on record). E.g. the external Incentive pool. Not needed for Direct / External types.',
  },
] as const;

const parseList = (text: string) => text.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean);

// only: show just one list (by key), without the card wrapper — used inside the Allowlists card
export default function DestinationsCard({ only }: { only?: string } = {}) {
  const ctx = useVoucherV2();
  // approve / remove / label need OPERATOR_ROLE on SourceRegistry — hide them otherwise
  const canEdit = useHasRole('SourceRegistry', 'OPERATOR_ROLE') === true;
  const registry = ctx.book.contracts.SourceRegistry;
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  // SourceRegistry.labelOf(addr) — informational names for listed addresses
  const [labels, setLabels] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!registry || !ctx.reader) return;
    try {
      const reg = ctx.read('SourceRegistry');
      const out: Record<string, string[]> = {};
      for (const l of DESTINATION_LISTS) out[l.key] = await reg.getApprovedDestinations(l.key);
      setMembers(out);
      const all = Array.from(new Set(Object.values(out).flat()));
      const ls = await Promise.all(all.map((a) => reg.labelOf(a).catch(() => '')));
      setLabels(Object.fromEntries(all.map((a, i) => [a, ls[i] as string])));
      setUnsupported(false);
    } catch {
      // an older registry deployment without destination lists
      setUnsupported(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, ctx.reader, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  const update = async (list: (typeof DESTINATION_LISTS)[number], addrs: string[], approved: boolean) => {
    const bad = addrs.filter((a) => !isAddr(a));
    if (!addrs.length) return setMsg({ ok: false, text: 'Paste at least one address' });
    if (bad.length) return setMsg({ ok: false, text: `Not valid addresses: ${bad.join(', ')}` });
    setBusy(true);
    setMsg(null);
    try {
      const reg = ctx.write('SourceRegistry');
      const verb = approved ? 'Approve' : 'Remove';
      if (addrs.length === 1) await ctx.send(`${verb} ${list.title.toLowerCase().slice(0, -1)} ${ctx.nameOf(addrs[0])}`, reg, 'setDestinationApproved', [list.key, addrs[0], approved, '']);
      else await ctx.send(`${verb} ${addrs.length} ${list.title.toLowerCase()}`, reg, 'setDestinationsApproved', [list.key, addrs, approved, []]);
      setMsg({ ok: true, text: `${verb}d ${addrs.length} address(es) on ${list.title}` });
      if (approved) setInput((p) => ({ ...p, [list.key]: '' }));
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const editLabel = async (a: string) => {
    const label = window.prompt(`Label for ${a} (shown next to it in the registry; empty clears it):`, labels[a] || '');
    if (label === null) return;
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(`Label ${ctx.nameOf(a)} "${label.trim()}"`, ctx.write('SourceRegistry'), 'setLabel', [a, label.trim()]);
      setMsg({ ok: true, text: label.trim() ? `Labelled ${a} "${label.trim()}"` : `Cleared label of ${a}` });
      setTimeout(load, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!registry) {
    return (
      <Card title="Payout destination allowlists">
        <p className="text-xs text-txt-secondary">Deploy SourceRegistry first.</p>
      </Card>
    );
  }

  const lists = DESTINATION_LISTS.filter((l) => !only || l.key === only);
  const body = (
    <>
      {unsupported ? (
        <p className="text-xs text-yellow-300">⚠ This SourceRegistry has no destination lists — it was deployed before this feature. Redeploy (or upgrade) it to use them.</p>
      ) : (
        <div className={`grid grid-cols-1 ${only ? '' : 'md:grid-cols-2'} gap-4`}>
          {lists.map((l) => (
            <div key={l.key} className="bg-surface-tertiary rounded-lg p-3 space-y-2">
              <h4 className="text-sm font-semibold">{l.title} <span className="text-txt-secondary font-normal">({members[l.key]?.length ?? '…'})</span></h4>
              <p className="text-[11px] text-txt-secondary">{l.note}</p>
              {canEdit && <><Field label="Add addresses" hint="One or many — separated by commas, spaces or new lines. Many addresses go in one transaction.">
                <textarea
                  className="w-full bg-surface-secondary rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                  rows={2}
                  value={input[l.key] || ''}
                  onChange={(e) => setInput((p) => ({ ...p, [l.key]: e.target.value }))}
                  placeholder="0x…"
                />
              </Field>
              <div className="flex gap-2">
                <button className={btnSecondaryCls} disabled={busy} onClick={() => update(l, parseList(input[l.key] || ''), true)}>Approve</button>
                <button className={btnDangerCls} disabled={busy} onClick={() => update(l, parseList(input[l.key] || ''), false)}>Remove listed</button>
              </div>
              </>}
              <Collapsible title={`Approved (${members[l.key]?.length ?? '…'})`} summary="view, label or remove">
              <div className="space-y-1">
                {(members[l.key] || []).map((a) => (
                  <div key={a} className="flex items-center gap-2 text-xs">
                    <span className="font-mono break-all flex-1">{a}</span>
                    <span className="text-txt-primary">{labels[a] || (ctx.nameOf(a).startsWith('0x') ? '' : ctx.nameOf(a))}</span>
                    {canEdit && <button className={linkBtnCls} disabled={busy} onClick={() => editLabel(a)}>{labels[a] ? 'Rename' : 'Label'}</button>}
                    {canEdit && <button className={linkBtnCls} disabled={busy} onClick={() => update(l, [a], false)}>Remove</button>}
                  </div>
                ))}
                {members[l.key]?.length === 0 && <p className="text-xs text-txt-secondary">None approved yet.</p>}
              </div>
              </Collapsible>
            </div>
          ))}
        </div>
      )}
      {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
    </>
  );
  if (only) return body;

  return (
    <Card title="Payout destination allowlists">
      <ContractTag contract="SourceRegistry" methods={['setDestinationApproved', 'setDestinationsApproved', 'setLabel']} />
      <p className="text-xs text-txt-secondary mb-3">
        Once VoucherNFT is linked to the registry (step 1), a type can only use a fixed payout recipient or a route target that&apos;s approved here.
        Approve before registering or editing such a type. Removing an address later doesn&apos;t change types already using it.
      </p>
      {body}
    </Card>
  );
}
