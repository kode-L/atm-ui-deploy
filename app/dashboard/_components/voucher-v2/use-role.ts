'use client';
import { useEffect, useState } from 'react';
import { ContractKey, DEFAULT_ADMIN_ROLE, role } from '@/lib/contracts/voucher-v2';
import { useVoucherV2 } from './context';

/**
 * Whether the connected wallet holds `roleName` on a contract (the book's address for `key`,
 * or `address`). null while unknown. Used to hide actions the wallet would only see revert.
 */
export function useHasRole(key: ContractKey, roleName: 'OPERATOR_ROLE' | 'DEFAULT_ADMIN_ROLE', address?: string): boolean | null {
  const ctx = useVoucherV2();
  const at = address || ctx.book.contracts[key];
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!at || !ctx.reader || !ctx.account) { setHas(null); return; }
    const id = roleName === 'DEFAULT_ADMIN_ROLE' ? DEFAULT_ADMIN_ROLE : role(roleName);
    ctx.read(key, at).hasRole(id, ctx.account)
      .then((v: boolean) => !cancelled && setHas(v))
      .catch(() => !cancelled && setHas(null));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, at, roleName, ctx.reader, ctx.account, ctx.revision]);
  return has;
}

/** Same check for several addresses of one contract kind (e.g. every pool) — address → admin? */
export function useAdminOf(key: ContractKey, addresses: string[]): Record<string, boolean> {
  const ctx = useVoucherV2();
  const [out, setOut] = useState<Record<string, boolean>>({});
  const sig = addresses.join(',');
  useEffect(() => {
    let cancelled = false;
    if (!ctx.reader || !ctx.account || !addresses.length) { setOut({}); return; }
    Promise.all(addresses.map((a) => ctx.read(key, a).hasRole(DEFAULT_ADMIN_ROLE, ctx.account).catch(() => false)))
      .then((r: boolean[]) => !cancelled && setOut(Object.fromEntries(addresses.map((a, i) => [a.toLowerCase(), r[i]]))));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sig, ctx.reader, ctx.account, ctx.revision]);
  return out;
}
