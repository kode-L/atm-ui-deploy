'use client';
import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { ContractKey, VoucherMode, ZERO, poolKind, sameAddr, shortAddr } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';

export interface SourceOption {
  value: string;
  label: string;
  // approved in the linked SourceRegistry for the asked mode/standard (null = no registry linked)
  approved: boolean | null;
}

const NAME_ABI = ['function name() view returns (string)'];
const BOOK_POOLS: ContractKey[] = ['RewardVault', 'VoucherSettlement'];

/**
 * Funding sources for a voucher type, labelled by who they are: the contract's on-chain
 * name(), the registry's labelOf(), and which contract it is in the address book — e.g.
 * "Main pool (Native + USDT) · RewardVault · 0x8A79…C318". Lists every pool the linked
 * SourceRegistry approved for this mode/standard (so extra pools show up without being in the
 * address book), plus the book's own pools.
 */
export function useSourceOptions(mode: number | null, tokenStandard: number) {
  const ctx = useVoucherV2();
  const [options, setOptions] = useState<SourceOption[]>([]);
  const c = ctx.book.contracts;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ctx.reader) return;
      let reg: ethers.Contract | null = null;
      let approved: string[] = [];
      let isLinked = false;
      try {
        const linked: string = c.VoucherNFT ? await ctx.read('VoucherNFT').sourceRegistry() : ZERO;
        isLinked = !sameAddr(linked, ZERO);
        // not linked yet: still read the book's registry, for its labels and approvals
        const regAddr = isLinked ? linked : c.SourceRegistry;
        if (regAddr) {
          reg = ctx.read('SourceRegistry', regAddr);
          if (mode !== null) {
            approved = mode === VoucherMode.Reward ? await reg.getApprovedRewardVaults(tokenStandard) : await reg.getApprovedPointsLedgers();
          } else {
            // any mode: everything the registry has approved anywhere
            const lists = await Promise.all([reg.getApprovedPointsLedgers(), ...[0, 1, 2, 3].map((s) => reg!.getApprovedRewardVaults(s))]);
            approved = lists.flat();
          }
        }
      } catch {
        // registry unreadable (older deployment) — fall back to the address book only
      }
      // approval only matters (and is only shown) once VoucherNFT enforces the registry
      const showApproval = isLinked && mode !== null;
      const all: string[] = [];
      const extraList = ctx.book.extraPools || [];
      const extras = extraList.map((x) => x.address);
      for (const a of [...approved, ...BOOK_POOLS.map((k) => c[k]).filter(Boolean) as string[], ...extras]) {
        if (!all.some((x) => sameAddr(x, a))) all.push(a);
      }
      const out = await Promise.all(all.map(async (a) => {
        const [onChain, label] = await Promise.all([
          new ethers.Contract(a, NAME_ABI, ctx.reader!).name().catch(() => ''),
          reg ? reg.labelOf(a).catch(() => '') : Promise.resolve(''),
        ]);
        const bookKey = BOOK_POOLS.find((k) => sameAddr(c[k], a)) || (() => { const x = extraList.find((e) => sameAddr(e.address, a)); return x ? `${poolKind(x)} (extra)` : undefined; })();
        const name = label || onChain;
        // skip the contract name when the pool's own name already is it ("VoucherSettlement")
        const parts = [name, bookKey && bookKey !== name ? bookKey : '', shortAddr(a)].filter(Boolean);
        const isApproved = showApproval ? approved.some((x) => sameAddr(x, a)) : null;
        return { value: a, label: parts.join(' · '), approved: isApproved };
      }));
      if (!cancelled) setOptions(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tokenStandard, c.VoucherNFT, c.SourceRegistry, c.RewardVault, c.VoucherSettlement, ctx.book.extraPools, ctx.reader, ctx.revision]);

  return options;
}
