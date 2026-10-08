'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Card from '@/components/card';
import { MAX_UINT, VoucherType, loadVoucherTypes, sameAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';
import { btnSecondaryCls } from './ui';

// address → typeId → what it may do on that type
type Cell = { mint?: string; propose?: boolean; approve?: boolean };

/**
 * "Who can do what": every address that may mint (VoucherNFT per-type minter role) or vote
 * (VoucherDAO per-type proposer / approver roles), against every voucher type.
 */
export default function PermissionsCard() {
  const ctx = useVoucherV2();
  const c = ctx.book.contracts;
  const [types, setTypes] = useState<VoucherType[]>([]);
  const [rows, setRows] = useState<{ address: string; cells: Record<number, Cell> }[]>([]);
  const [loading, setLoading] = useState(false);
  const daoGoverned = useRef<Record<number, boolean>>({});

  const load = useCallback(async () => {
    if (!c.VoucherNFT || !ctx.reader) return;
    setLoading(true);
    try {
      const nft = ctx.read('VoucherNFT');
      const dao = c.VoucherDAO ? ctx.read('VoucherDAO') : null;
      const ts = await loadVoucherTypes(nft);
      const map = new Map<string, Record<number, Cell>>();
      const cell = (a: string, id: number) => {
        const k = a.toLowerCase();
        if (!map.has(k)) map.set(k, {});
        const m = map.get(k)!;
        return (m[id] = m[id] || {});
      };
      for (const t of ts) {
        const minters: string[] = await nft.getRoleMembers(await nft.typeMinterRole(t.id));
        for (const a of minters) {
          const cap = await nft.getMinterDailyCap(t.id, a);
          const hours = Math.round(cap.windowDuration.toNumber() / 3600);
          cell(a, t.id).mint = cap.limit.toString() === MAX_UINT ? 'unlimited' : `${cap.limit}/${hours === 24 ? 'day' : `${hours}h`}`;
        }
        // the DAO governs a type when it needs 2+ approvals or VoucherDAO is one of its minters
        const daoGoverns = t.mintApprovalsRequired > 1 || minters.some((m) => sameAddr(m, c.VoucherDAO));
        if (daoGoverned.current) daoGoverned.current[t.id] = daoGoverns;
        if (dao && daoGoverns) {
          const [props, apprs] = await Promise.all([dao.getProposersOf(t.id), dao.getApproversOf(t.id)]);
          for (const a of props) cell(a, t.id).propose = true;
          for (const a of apprs) cell(a, t.id).approve = true;
        }
      }
      setTypes(ts);
      // the connected wallet and VoucherDAO first, then the rest by name
      const order = (a: string) => (sameAddr(a, ctx.account) ? 0 : sameAddr(a, c.VoucherDAO) ? 1 : 2);
      setRows(Array.from(map.entries())
        .map(([address, cells]) => ({ address, cells }))
        .sort((x, y) => order(x.address) - order(y.address) || ctx.nameOf(x.address).localeCompare(ctx.nameOf(y.address))));
    } catch {
      // partial / older deployment — leave the table as it was
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.VoucherNFT, c.VoucherDAO, ctx.reader, ctx.account, ctx.revision]);

  useEffect(() => { load(); }, [load]);

  if (!c.VoucherNFT) return null;

  return (
    <Card title="Who can do what">
      <div className="flex flex-wrap items-center gap-3 -mt-2 mb-3">
        <p className="text-xs text-txt-secondary flex-1">
          <b className="text-txt-primary">Mint</b> = may mint that type directly (with its cap). <b className="text-txt-primary">Propose</b> / <b className="text-txt-primary">Approve</b> = VoucherDAO committee, on types the DAO mints (&quot;DAO n&quot; = approvals needed).
          Click a type to manage it below.
        </p>
        <button className={btnSecondaryCls} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Reload'}</button>
      </div>
      {!types.length ? (
        <p className="text-xs text-txt-secondary">No voucher types yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-txt-secondary border-b border-white/10">
                <th className="py-2 pr-3">Address</th>
                {types.map((t) => (
                  <th key={t.id} className="py-2 pr-3 font-medium">
                    <button
                      onClick={() => ctx.setTypeId(t.id)}
                      className={`text-left hover:text-accent ${ctx.typeId === t.id ? 'text-accent' : ''}`}
                      title={daoGoverned.current[t.id] ? `VoucherDAO, ${t.mintApprovalsRequired} approval(s)` : 'direct minting'}
                    >
                      #{t.id} {t.name}{daoGoverned.current[t.id] && <span className="text-txt-secondary"> · DAO {t.mintApprovalsRequired}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const name = ctx.nameOf(r.address);
                return (
                  <tr key={r.address} className="border-b border-white/5">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <div className="font-medium">{name.startsWith('0x') ? <span className="font-mono">{name}</span> : name}</div>
                      {!name.startsWith('0x') && <div className="font-mono text-txt-secondary text-[10px]">{r.address.slice(0, 10)}…{r.address.slice(-6)}</div>}
                    </td>
                    {types.map((t) => {
                      const cl = r.cells[t.id];
                      return (
                        <td key={t.id} className="py-2 pr-3">
                          {!cl ? <span className="text-txt-secondary/40">—</span> : (
                            <div className="flex flex-wrap gap-1">
                              {cl.mint && <span className="px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">Mint {cl.mint}</span>}
                              {cl.propose && <span className="px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300">Propose</span>}
                              {cl.approve && <span className="px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300">Approve</span>}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={types.length + 1} className="py-3 text-txt-secondary">Nobody can mint or vote yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
