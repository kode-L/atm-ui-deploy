'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Card from '@/components/card';
import { MAX_UINT, VoucherType, isAddr, loadVoucherTypes, role, sameAddr, typeLabel } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import PermissionsCard from './permissions-card';
import { ContractTag, AddressInput, AddressOption, Collapsible, Field, NavButtons, Select, btnCls, btnDangerCls, btnSecondaryCls, inputCls, linkBtnCls } from './ui';

interface MinterRow { address: string; limit: string; window: number; used: string }

const REVOKE_ROLE = role('REVOKE_ROLE');

function human(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${seconds}s`;
}

export default function RolesTab({ onGo, part }: { onGo: (t: string) => void; part?: 'nft' | 'dao' }) {
  const showNft = part !== 'dao';
  const showDao = part !== 'nft';
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [types, setTypes] = useState<VoucherType[]>([]);
  // shared with the Types / DAO tabs, so the same type stays selected when switching tabs
  const { typeId, setTypeId } = ctx;
  const [minters, setMinters] = useState<MinterRow[]>([]);
  // VoucherDAO operator group (v0.53: operators both propose and approve), each with a proposal budget
  const [approverCaps, setApproverCaps] = useState<MinterRow[]>([]);
  const [apprCap, setApprCap] = useState({ cap: '', hours: '' });
  const [revokers, setRevokers] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [mint, setMint] = useState({ address: ctx.account, cap: '', unlimited: false, windowHours: '' });
  // what the pasted minter address is: a contract (has code) or a plain wallet
  const [minterKind, setMinterKind] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!isAddr(mint.address) || !ctx.reader) { setMinterKind(''); return; }
    ctx.reader.getCode(mint.address).then((code) => {
      if (!cancelled) setMinterKind(code && code !== '0x' ? 'contract' : 'wallet (no contract code)');
    }).catch(() => !cancelled && setMinterKind(''));
    return () => { cancelled = true; };
  }, [mint.address, ctx.reader]);
  const [daoAddr, setDaoAddr] = useState('');
  const [revokeAddr, setRevokeAddr] = useState('');
  const [gateText, setGateText] = useState('');
  const [gateResults, setGateResults] = useState<Record<string, boolean>>({});

  const selected = types.find((t) => t.id === typeId);
  const quick: AddressOption[] = [
    { label: 'Connected wallet', value: ctx.account },
    ...(['VoucherDAO'] as const).filter((k) => c[k]).map((k) => ({ label: k, value: c[k] as string })),
  ];
  const tag = (a: string) => {
    const n = ctx.nameOf(a);
    return n.startsWith('0x') ? '' : `(${n})`;
  };

  const loadTypeRoles = useCallback(async (id: number) => {
    if (id < 0) return;
    const nft = ctx.read('VoucherNFT');
    const members: string[] = await nft.getRoleMembers(await nft.typeMinterRole(id));
    setMinters(await Promise.all(members.map(async (address) => {
      const cap = await nft.getMinterDailyCap(id, address);
      return { address, limit: cap.limit.toString(), window: cap.windowDuration.toNumber(), used: cap.mintedInWindow.toString() };
    })));
    if (ctx.getBook().contracts.VoucherDAO) {
      const dao = ctx.read('VoucherDAO');
      const apprs: string[] = await dao.getOperatorsOf(id);
      setApproverCaps(await Promise.all(apprs.map(async (address) => {
        const cap = await dao.getOperatorDailyCap(id, address);
        return { address, limit: cap.limit.toString(), window: cap.windowDuration.toNumber(), used: cap.proposedInWindow.toString() };
      })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.read]);

  const reloadAll = useCallback(async () => {
    if (!ctx.getBook().contracts.VoucherNFT) return;
    try {
      const ts = await loadVoucherTypes(ctx.read('VoucherNFT'));
      setTypes(ts);
      const id = typeId >= 0 ? typeId : ts[0]?.id ?? -1;
      setTypeId(id);
      await loadTypeRoles(id);
      setRevokers(await ctx.read('VoucherNFT').getRoleMembers(REVOKE_ROLE));
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.read, typeId, loadTypeRoles]);

  useEffect(() => { reloadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ctx.book.contracts.VoucherNFT, ctx.reader]);
  useEffect(() => { loadTypeRoles(typeId).catch(() => {}); }, [typeId, loadTypeRoles]);

  const tx = async (label: string, key: Parameters<typeof ctx.write>[0], method: string, args: any[]) => {
    setBusy(true);
    setMsg(null);
    try {
      await ctx.send(label, ctx.write(key), method, args);
      setMsg({ ok: true, text: label });
      // give the public RPC a moment before re-reading (replica lag)
      setTimeout(reloadAll, 2500);
      return true;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // extra types to give the same minter (same cap) in one go — a minter contract usually mints several types
  const [alsoTypes, setAlsoTypes] = useState<number[]>([]);
  const grantMinter = async (address: string, forceUnlimited = false) => {
    const unlimited = forceUnlimited || mint.unlimited;
    const cap = unlimited ? MAX_UINT : String(parseInt(mint.cap || '0', 10) || 0);
    const window = unlimited ? 0 : Math.round(Number(mint.windowHours || 0) * 3600);
    const ids = forceUnlimited ? [typeId] : [typeId, ...alsoTypes.filter((t) => t !== typeId)];
    for (const id of ids) {
      // one tx per type (the contract grants per type); stop at the first failure
      if (!(await tx(`Type ${id}: minter ${ctx.nameOf(address)}${unlimited ? ' (unlimited)' : ''}`, 'VoucherNFT', 'grantTypeMinterWithCap', [id, address, cap, window]))) return;
    }
    setAlsoTypes([]);
  };

  const revokeMinter = async (address: string) =>
    tx(`Type ${typeId}: revoke minter ${ctx.nameOf(address)}`, 'VoucherNFT', 'revokeRole', [await ctx.read('VoucherNFT').typeMinterRole(typeId), address]);

  // grant (or re-grant to update the cap): blank cap/window = the default budget (100 per day)
  const grantApprover = () =>
    tx(`Type ${typeId}: operator ${ctx.nameOf(daoAddr)}`, 'VoucherDAO', 'grantTypeOperatorWithCap',
      [typeId, daoAddr, String(parseInt(apprCap.cap || '0', 10) || 0), Math.round(Number(apprCap.hours || 0) * 3600)]);
  const revokeApprover = async (address: string) =>
    tx(`Type ${typeId}: remove operator ${ctx.nameOf(address)}`, 'VoucherDAO', 'revokeRole', [await ctx.read('VoucherDAO').typeOperatorRole(typeId), address]);

  const gateList = () => {
    const list = gateText.split(/[\s,]+/).filter(Boolean);
    const bad = list.find((a) => !isAddr(a));
    if (bad) throw new Error(`Invalid address: ${bad}`);
    return list;
  };
  const gateCheck = async () => {
    try {
      const gate = ctx.read('AllowlistTransferGate');
      const out: Record<string, boolean> = {};
      for (const a of gateList()) out[a] = await gate.allowed(a);
      setGateResults(out);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };
  const gateSet = async (allowed: boolean) => {
    try {
      const list = gateList();
      if (!list.length) return;
      const ok = list.length === 1
        ? await tx(`Gate: ${allowed ? 'allow' : 'disallow'} ${list[0]}`, 'AllowlistTransferGate', 'setAllowed', [list[0], allowed])
        : await tx(`Gate: ${allowed ? 'allow' : 'disallow'} ${list.length} addresses`, 'AllowlistTransferGate', 'setAllowedBatch', [list, allowed]);
      if (ok) setTimeout(gateCheck, 2500);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  if (!c.VoucherNFT) {
    return <Card><p className="text-sm text-txt-secondary text-center py-6">Deploy (or set) VoucherNFT first.</p></Card>;
  }

  const daoIsMinter = minters.some((mm) => sameAddr(mm.address, c.VoucherDAO));
  const AddrList = ({ list, onRevoke }: { list: string[]; onRevoke?: (a: string) => void }) => (
    <div className="space-y-1">
      {list.length === 0 && <span className="text-xs text-txt-secondary">none</span>}
      {list.map((a) => (
        <div key={a} className="text-xs flex flex-wrap items-center gap-2">
          <span className="font-mono break-all">{a}</span> <span className="text-txt-secondary">{tag(a)}</span>
          {onRevoke && <button className={linkBtnCls} disabled={busy} onClick={() => onRevoke(a)}>Revoke</button>}
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {!part && <PermissionsCard />}
      {part !== 'dao' && (
      <Card title="Manage a type">
        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-[260px]">
            <Select value={typeId} onChange={setTypeId} options={[{ label: types.length ? 'Select a type' : 'No types registered yet', value: -1 }, ...types.map((t) => ({ label: typeLabel(t), value: t.id }))]} />
          </div>
          <button className={btnSecondaryCls} onClick={reloadAll}>Reload</button>
        </div>
        {selected && selected.mintApprovalsRequired > 1 && c.VoucherDAO && !daoIsMinter && (
          <p className="text-xs text-yellow-300 mt-3">
            ⚠ This type needs {selected.mintApprovalsRequired} approvals, but VoucherDAO can&apos;t mint it yet.{' '}
            <button className={linkBtnCls} disabled={busy} onClick={() => grantMinter(c.VoucherDAO as string, true)}>Grant VoucherDAO the minter role (unlimited)</button>
          </p>
        )}
        {selected && selected.mintApprovalsRequired <= 1 && c.VoucherDAO && !daoIsMinter && (
          <p className="text-xs text-txt-secondary mt-3">
            Optional: let VoucherDAO mint this type too, so its operators can mint through it (with 1 approval a proposal executes at once).{' '}
            <button className={linkBtnCls} disabled={busy} onClick={() => grantMinter(c.VoucherDAO as string, true)}>Grant VoucherDAO the minter role (unlimited)</button>
          </p>
        )}
        {msg && <p className={`text-xs mt-3 break-all ${msg.ok ? 'text-green-300' : 'text-red-300'}`}>{msg.text}</p>}
      </Card>
      )}

      {showNft && selected && (
        <Card title={`Minters of type #${selected.id}`}>
        <ContractTag contract="VoucherNFT" methods={['grantTypeMinterWithCap', 'revokeRole']} />
          <p className="text-xs text-txt-secondary mb-3">
            Wallets or contracts allowed to mint this type. Each has a budget per time window (default 100 per day) — make contracts that mint for many users unlimited.
          </p>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-txt-secondary border-b border-white/10"><th className="py-2 pr-3">Minter</th><th className="py-2 pr-3">Cap</th><th className="py-2 pr-3">Window</th><th className="py-2 pr-3">Used</th><th /></tr></thead>
              <tbody>
                {minters.map((mm) => (
                  <tr key={mm.address} className="border-b border-white/5">
                    <td className="py-2 pr-3"><span className="font-mono">{mm.address}</span> <span className="text-txt-secondary">{tag(mm.address)}</span></td>
                    <td className="py-2 pr-3">{mm.limit === MAX_UINT ? 'unlimited' : mm.limit}</td>
                    <td className="py-2 pr-3">{human(mm.window)}</td>
                    <td className="py-2 pr-3">{mm.used}</td>
                    <td className="py-2 text-right"><button className={linkBtnCls} disabled={busy} onClick={() => revokeMinter(mm.address)}>Revoke</button></td>
                  </tr>
                ))}
                {minters.length === 0 && <tr><td colSpan={5} className="py-3 text-txt-secondary">No minters yet</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field
              label="Minter address"
              hint={
                !mint.address ? 'Paste any wallet or contract address, or pick a suggestion.'
                  : !isAddr(mint.address) ? <span className="text-red-300">Not a valid address</span>
                  : <>Paste any wallet or contract address. This one is a <b>{minterKind || '…'}</b>{ctx.nameOf(mint.address).startsWith('0x') ? '' : ` (${ctx.nameOf(mint.address)})`}.</>
              }
            >
              <div className="flex gap-2">
                <AddressInput value={mint.address} onChange={(v) => setMint({ ...mint, address: v })} options={quick} placeholder="0x… minter wallet or contract" />
                {mint.address && <button className={linkBtnCls} onClick={() => setMint({ ...mint, address: '' })}>Clear</button>}
              </div>
            </Field>
            <Field label="Cap per window" hint={<label className="flex items-center gap-1.5"><input type="checkbox" checked={mint.unlimited} onChange={(e) => setMint({ ...mint, unlimited: e.target.checked })} /> Unlimited</label>}>
              <input className={inputCls} disabled={mint.unlimited} value={mint.cap} onChange={(e) => setMint({ ...mint, cap: e.target.value })} placeholder="blank = default (100)" />
            </Field>
            <Field label="Window (hours)"><input className={inputCls} disabled={mint.unlimited} value={mint.windowHours} onChange={(e) => setMint({ ...mint, windowHours: e.target.value })} placeholder="blank = default (24)" /></Field>
          </div>
          {types.length > 1 && (
            <Field label="Also grant to these types (same cap)" hint="Optional. One transaction per type.">
              <div className="flex flex-wrap gap-x-4 gap-y-1 py-1">
                {types.filter((t) => t.id !== typeId).map((t) => (
                  <label key={t.id} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={alsoTypes.includes(t.id)} onChange={(e) => setAlsoTypes((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))} />
                    #{t.id} {t.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <button className={`${btnCls} mt-4`} disabled={busy || !isAddr(mint.address)} onClick={() => grantMinter(mint.address)}>
            Grant / update minter{alsoTypes.length ? ` on ${alsoTypes.length + 1} types` : ''}
          </button>
        </Card>
      )}

      {showDao && selected && c.VoucherDAO && (selected.mintApprovalsRequired > 1 || daoIsMinter) && (
        <Card title={`VoucherDAO operators for type #${selected.id}`}>
        <ContractTag contract="VoucherDAO" methods={['grantTypeOperatorWithCap', 'revokeRole']} />
          <p className="text-xs text-txt-secondary mb-3">
            Operators both <b>propose</b> and <b>approve</b> — a proposal counts as its proposer&apos;s approval. With {selected.mintApprovalsRequired} approval{selected.mintApprovalsRequired === 1 ? '' : 's'} needed
            {selected.mintApprovalsRequired === 1 ? ', a proposal executes as soon as it is proposed' : `, you need at least ${selected.mintApprovalsRequired} operators`}.
            Each operator has a budget of vouchers they can propose per time window.
          </p>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-txt-secondary border-b border-white/10"><th className="py-2 pr-3">Operator</th><th className="py-2 pr-3">Proposal cap</th><th className="py-2 pr-3">Window</th><th className="py-2 pr-3">Used</th><th /></tr></thead>
              <tbody>
                {approverCaps.map((a) => (
                  <tr key={a.address} className="border-b border-white/5">
                    <td className="py-2 pr-3"><span className="font-mono">{a.address}</span> <span className="text-txt-secondary">{tag(a.address)}</span></td>
                    <td className="py-2 pr-3">{a.limit === MAX_UINT ? 'unlimited' : a.limit}</td>
                    <td className="py-2 pr-3">{human(a.window)}</td>
                    <td className="py-2 pr-3">{a.used}</td>
                    <td className="py-2 text-right"><button className={linkBtnCls} disabled={busy} onClick={() => revokeApprover(a.address)}>Remove</button></td>
                  </tr>
                ))}
                {approverCaps.length === 0 && <tr><td colSpan={5} className="py-3 text-txt-secondary">No operators yet — nobody can propose or approve for this type.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Operator address"><AddressInput value={daoAddr} onChange={setDaoAddr} options={quick} /></Field>
            <Field label="Proposal cap per window"><input className={inputCls} value={apprCap.cap} onChange={(e) => setApprCap({ ...apprCap, cap: e.target.value })} placeholder="blank = default (100)" /></Field>
            <Field label="Window (hours)"><input className={inputCls} value={apprCap.hours} onChange={(e) => setApprCap({ ...apprCap, hours: e.target.value })} placeholder="blank = default (24)" /></Field>
          </div>
          <button className={`${btnCls} mt-3`} disabled={busy || !isAddr(daoAddr)} onClick={grantApprover}>Add / update operator</button>
        </Card>
      )}

      {showNft && <Collapsible title="Advanced: direct revoke rights" summary="who may revoke vouchers without a DAO vote">
      <Card title="REVOKE_ROLE on VoucherNFT">
        <ContractTag contract="VoucherNFT" methods={['grantRole(REVOKE_ROLE)', 'revokeRole']} />
        <p className="text-xs text-txt-secondary mb-3">Holders can revoke any voucher directly. VoucherDAO holding it enables revokes by vote.</p>
        <AddrList list={revokers} onRevoke={(a) => tx(`Revoke REVOKE_ROLE from ${ctx.nameOf(a)}`, 'VoucherNFT', 'revokeRole', [REVOKE_ROLE, a])} />
        <div className="flex flex-wrap gap-2 mt-3">
          <div className="flex-1 min-w-[260px]"><AddressInput value={revokeAddr} onChange={setRevokeAddr} options={quick} /></div>
          <button className={btnSecondaryCls} disabled={busy || !isAddr(revokeAddr)} onClick={() => tx(`Grant REVOKE_ROLE to ${ctx.nameOf(revokeAddr)}`, 'VoucherNFT', 'grantRole', [REVOKE_ROLE, revokeAddr])}>Grant REVOKE_ROLE</button>
        </div>
      </Card>
      </Collapsible>}

      {showNft && c.AllowlistTransferGate && (
        <Card title="Transfer gate allowlist">
        <ContractTag contract="AllowlistTransferGate" methods={['setAllowed', 'setAllowedBatch']} />
          <p className="text-xs text-txt-secondary mb-3">Only matters for types whose transfer gate is AllowlistTransferGate. Paste one or many addresses (comma / newline separated).</p>
          <textarea className={`${inputCls} min-h-[70px]`} value={gateText} onChange={(e) => setGateText(e.target.value)} placeholder="0x…, 0x…" />
          <div className="flex flex-wrap gap-2 mt-3">
            <button className={btnSecondaryCls} onClick={gateCheck}>Check</button>
            <button className={btnCls} disabled={busy} onClick={() => gateSet(true)}>Allow</button>
            <button className={btnDangerCls} disabled={busy} onClick={() => gateSet(false)}>Disallow</button>
          </div>
          {Object.entries(gateResults).map(([a, v]) => (
            <p key={a} className="text-xs mt-1"><span className="font-mono">{a}</span> → {v ? 'allowed' : 'not allowed'}</p>
          ))}
        </Card>
      )}


    </div>
  );
}
