'use client';
import React, { ReactNode, useId, useState } from 'react';
import { CheckCircle2, ChevronRight, Loader2 } from 'lucide-react';

export const inputCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';
export const btnCls = 'bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap';
export const btnSecondaryCls = 'bg-surface-tertiary hover:bg-surface-tertiary/70 disabled:opacity-40 disabled:cursor-not-allowed border border-accent/30 text-accent font-medium px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap';
export const btnDangerCls = 'bg-red-900/40 hover:bg-red-900/60 disabled:opacity-40 disabled:cursor-not-allowed border border-red-400/30 text-red-300 font-medium px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap';
export const linkBtnCls = 'text-accent hover:underline text-xs disabled:opacity-40';

export type StepStatus = 'done' | 'todo' | 'blocked' | 'checking';

export function StepCard({ index, title, why, status, detail, warn, optional, children }: {
  index: number;
  title: string;
  why?: string;
  status: StepStatus;
  detail?: string;
  warn?: string;
  optional?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`flex gap-4 rounded-xl p-4 border ${
      status === 'done' ? 'border-green-500/30 bg-green-900/10' : 'border-white/10 bg-surface-secondary'
    } ${status === 'blocked' ? 'opacity-60' : ''}`}>
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
        status === 'done' ? 'bg-green-500 text-black' : 'bg-surface-tertiary text-txt-secondary'
      }`}>
        {status === 'done' ? <CheckCircle2 className="w-4 h-4" /> : index}
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="font-semibold text-sm">{title}</h4>
          {optional && <Badge tone="muted">Optional</Badge>}
          {status === 'done' && <Badge tone="good">Done</Badge>}
          {status === 'todo' && <Badge tone="warn">To do</Badge>}
          {status === 'blocked' && <Badge tone="muted">Blocked</Badge>}
          {status === 'checking' && <Loader2 className="w-3.5 h-3.5 animate-spin text-txt-secondary" />}
        </div>
        {why && <p className="text-xs text-txt-secondary">{why}</p>}
        {detail && <p className="text-xs text-txt-primary/80">{detail}</p>}
        {warn && <p className="text-xs text-yellow-300">⚠ {warn}</p>}
        {children}
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  const cls = {
    good: 'bg-green-900/40 text-green-300',
    warn: 'bg-yellow-900/40 text-yellow-300',
    bad: 'bg-red-900/40 text-red-300',
    muted: 'bg-surface-tertiary text-txt-secondary',
  }[tone];
  return <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded ${cls}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-txt-secondary font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-txt-secondary/80 leading-snug">{hint}</span>}
    </label>
  );
}

export type AddressOption = { label: string; value: string };

/** Free-text address input with the known addresses offered as suggestions. */
export function AddressInput({ value, onChange, options = [], placeholder = '0x…' }: {
  value: string;
  onChange: (v: string) => void;
  options?: AddressOption[];
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <>
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} list={listId} />
      <datalist id={listId}>
        {options.map((o) => <option key={o.value + o.label} value={o.value}>{o.label}</option>)}
      </datalist>
    </>
  );
}

export function Select<T extends string | number>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
}) {
  return (
    <select
      className={inputCls}
      value={String(value)}
      onChange={(e) => {
        const found = options.find((o) => String(o.value) === e.target.value);
        if (found) onChange(found.value);
      }}
    >
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

export function NavButtons({ back, next, onGo }: { back?: [string, string]; next?: [string, string]; onGo: (tab: string) => void }) {
  return (
    <div className="flex justify-between pt-2">
      {back ? <button className={btnSecondaryCls} onClick={() => onGo(back[0])}>← {back[1]}</button> : <span />}
      {next && <button className={btnCls} onClick={() => onGo(next[0])}>{next[1]} →</button>}
    </div>
  );
}

/** A section that starts collapsed — for optional / advanced settings that shouldn't crowd the main steps. */
export function Collapsible({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-white/10">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-tertiary/40 rounded-xl">
        <ChevronRight className={`w-4 h-4 text-txt-secondary transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-sm font-semibold">{title}</span>
        {summary && <span className="text-xs text-txt-secondary truncate">{summary}</span>}
      </button>
      {open && <div className="px-3 pb-3 space-y-4">{children}</div>}
    </div>
  );
}

// one colour per contract, so the same contract always looks the same across tabs
const CONTRACT_TONE: Record<string, string> = {
  VoucherNFT: 'bg-sky-900/40 text-sky-300 border-sky-500/30',
  VoucherDAO: 'bg-violet-900/40 text-violet-300 border-violet-500/30',
  SourceRegistry: 'bg-amber-900/30 text-amber-300 border-amber-500/30',
  RewardVault: 'bg-emerald-900/40 text-emerald-300 border-emerald-500/30',
  VoucherSettlement: 'bg-teal-900/40 text-teal-300 border-teal-500/30',
  RevocationVault: 'bg-rose-900/30 text-rose-300 border-rose-500/30',
  AllowlistTransferGate: 'bg-orange-900/30 text-orange-300 border-orange-500/30',
  Token: 'bg-surface-tertiary text-txt-secondary border-white/10',
};

/** "Calls VoucherNFT · grantTypeMinterWithCap() · revokeRole()" — which contract a card sends to. */
export function ContractTag({ contract, methods = [], label = 'Calls' }: { contract: string; methods?: string[]; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] mb-3">
      <span className="text-txt-secondary">{label}</span>
      <span className={`px-2 py-0.5 rounded border font-semibold ${CONTRACT_TONE[contract] || CONTRACT_TONE.Token}`}>{contract}</span>
      {methods.map((m) => <code key={m} className="text-txt-secondary">· {m}()</code>)}
    </div>
  );
}

/** Heading that groups the steps/cards belonging to one contract. */
export function ContractGroup({ contract, note, hideHeading, children }: { contract: string; note?: string; hideHeading?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-3">
      {!hideHeading && <div className="flex items-center gap-2 pt-2">
        <span className={`px-2.5 py-1 rounded border text-xs font-semibold ${CONTRACT_TONE[contract] || CONTRACT_TONE.Token}`}>{contract}</span>
        {note && <span className="text-xs text-txt-secondary">{note}</span>}
      </div>}
      {children}
    </section>
  );
}
