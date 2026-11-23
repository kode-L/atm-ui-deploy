'use client';
/**
 * In-app replacement for window.confirm / window.prompt / alert.
 *
 *   if (!(await confirmDialog({ title: 'Deploy X?', details: [...], danger: true }))) return;
 *   const name = await promptDialog({ title: 'Name this set', defaultValue: 'My set' });
 *
 * One <DialogHost/> (mounted in app/providers.tsx) shows the requests one at a time.
 * Never use the browser's own dialogs: they can't show structured details, copy buttons or
 * full addresses, and some wallets' in-app browsers block them.
 */
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { CopyButton, refreshLastClick } from '@/components/tx-status';

export interface DialogDetail {
  label: string;
  value: ReactNode;
  /** Shows a copy button for this text (e.g. a full address). */
  copy?: string;
  mono?: boolean;
}

interface BaseOpts {
  title: string;
  /** Intro text. A string keeps its line breaks. */
  message?: ReactNode;
  /** Label / value rows (contract, signer, network, amounts…). */
  details?: DialogDetail[];
  /** Numbered list — e.g. the transactions that will be sent, in order. */
  steps?: ReactNode[];
  /** Bullet list. */
  items?: ReactNode[];
  /** Highlighted callout for what can go wrong / can't be undone. */
  warning?: ReactNode;
  /** Red styling and confirm button (irreversible or mainnet actions). */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptOpts extends BaseOpts {
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Disallow an empty answer. */
  required?: boolean;
  mono?: boolean;
}

type Req = { id: number } & (
  | { kind: 'confirm'; opts: BaseOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'copy'; opts: BaseOpts & { text: string }; resolve: (v: boolean) => void });
type NewReq = Req extends infer R ? R extends Req ? Omit<R, 'id'> : never : never;

let queue: Req[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function push(r: NewReq) { queue = [...queue, { ...r, id: nextId++ } as Req]; emit(); }
function pop() { queue = queue.slice(1); emit(); }

/** Ask the user to confirm. Resolves true on Confirm, false on Cancel / Esc / backdrop. */
export function confirmDialog(opts: BaseOpts): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', opts, resolve }));
}

/** Ask the user for a text value. Resolves the text, or null when cancelled. */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'prompt', opts, resolve }));
}

/** Show text to copy by hand (clipboard blocked). */
export function copyDialog(text: string, title = 'Copy this'): Promise<boolean> {
  return new Promise((resolve) => push({
    kind: 'copy',
    opts: { title, message: 'Your browser blocked the clipboard. Select the text and copy it.', text },
    resolve,
  }));
}

// Same look as the Voucher V2 review modal (voucher-v2/confirm-dialog.tsx): title, intro,
// a grid of UPPERCASE field labels with values, a yellow warning box, Cancel / Confirm.
const btnBase = 'px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed';
const btnCancel = `${btnBase} bg-surface-tertiary hover:bg-surface-tertiary/70 border border-accent/30 text-accent font-medium`;
const btnOk = `${btnBase} bg-accent hover:bg-accent-dark text-black font-semibold`;
const btnDanger = `${btnBase} bg-red-600 hover:bg-red-500 text-white font-semibold`;
const fieldCls = 'w-full bg-surface-tertiary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent';
const wide = (d: DialogDetail) => d.mono || (typeof d.value === 'string' && d.value.length > 40);

function Body({ o }: { o: BaseOpts }) {
  return (
    <>
      {o.message && (typeof o.message === 'string'
        ? <p className="text-xs text-txt-secondary mt-1 whitespace-pre-wrap break-words">{o.message}</p>
        : <div className="text-xs text-txt-secondary mt-1">{o.message}</div>)}
      {o.details && o.details.length > 0 && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {o.details.map((d, i) => (
            <div key={i} className={`flex flex-col min-w-0 ${wide(d) ? 'sm:col-span-2' : ''}`}>
              <span className="text-[11px] uppercase tracking-wide text-txt-secondary">{d.label}</span>
              <span className={`flex items-start gap-2 ${d.mono ? 'font-mono text-xs' : ''}`}>
                <span className="flex-1 min-w-0 break-all whitespace-pre-wrap">{d.value}</span>
                {d.copy && <CopyButton text={d.copy} title={`Copy ${d.label.toLowerCase()}`} />}
              </span>
            </div>
          ))}
        </div>
      )}
      {o.steps && o.steps.length > 0 && (
        <div className="mt-4 text-sm">
          <span className="text-[11px] uppercase tracking-wide text-txt-secondary">Transactions, in order</span>
          <ol className="mt-1 list-decimal pl-5 space-y-1 break-words">
            {o.steps.map((x, i) => <li key={i}>{x}</li>)}
          </ol>
        </div>
      )}
      {o.items && o.items.length > 0 && (
        <ul className="mt-4 list-disc pl-5 space-y-1 text-sm break-words">
          {o.items.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      )}
      {o.warning && (
        <div className={`mt-4 rounded-lg border p-3 text-xs whitespace-pre-wrap break-words ${o.danger ? 'border-red-400/40 bg-red-900/20 text-red-200' : 'border-yellow-400/40 bg-yellow-900/20'}`}>
          ⚠ {o.warning}
        </div>
      )}
    </>
  );
}

function Dialog({ req }: { req: Req }) {
  const o = req.opts;
  const [value, setValue] = useState(req.kind === 'prompt' ? req.opts.defaultValue ?? '' : '');
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const close = (ok: boolean) => {
    if (req.kind === 'prompt') req.resolve(ok ? value : null);
    else req.resolve(ok);
    // The tx this confirms should still spin on the button that opened the dialog
    if (ok) refreshLastClick();
    pop();
  };
  const blocked = req.kind === 'prompt' && req.opts.required && !value.trim();

  useEffect(() => {
    if (req.kind === 'prompt' || req.kind === 'copy') { fieldRef.current?.focus(); fieldRef.current?.select(); }
    else (o.danger ? cancelRef : okRef).current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  return (
    <div
      data-tx-ignore-click
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
    >
      <form
        role="dialog" aria-modal="true" aria-labelledby="app-dialog-title"
        onSubmit={(e) => { e.preventDefault(); if (!blocked) close(true); }}
        className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border bg-surface-secondary p-5 shadow-2xl ${o.danger ? 'border-red-400/40' : 'border-white/10'}`}
      >
        <div className="flex items-start gap-3">
          <h3 id="app-dialog-title" className={`flex-1 min-w-0 text-lg font-semibold break-words ${o.danger ? 'text-red-200' : ''}`}>{o.title}</h3>
          <button type="button" onClick={() => close(false)} title="Close" className="shrink-0 text-txt-secondary hover:text-txt-primary mt-1">
            <X className="w-4 h-4" />
          </button>
        </div>
        <Body o={o} />
        {req.kind === 'prompt' && (
          <label className="block mt-4">
            {req.opts.label && <span className="block text-[11px] uppercase tracking-wide text-txt-secondary mb-1">{req.opts.label}</span>}
            {req.opts.multiline
              ? <textarea ref={fieldRef} rows={3} value={value} placeholder={req.opts.placeholder} onChange={(e) => setValue(e.target.value)}
                  className={`${fieldCls} ${req.opts.mono ? 'font-mono' : ''}`} />
              : <input ref={fieldRef} value={value} placeholder={req.opts.placeholder} onChange={(e) => setValue(e.target.value)}
                  className={`${fieldCls} ${req.opts.mono ? 'font-mono' : ''}`} />}
          </label>
        )}
        {req.kind === 'copy' && (
          <div className="mt-4 flex items-start gap-2">
            <textarea ref={fieldRef} readOnly rows={5} value={req.opts.text} className={`${fieldCls} font-mono text-xs`} />
            <CopyButton text={req.opts.text} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {req.kind === 'copy'
            ? <button ref={okRef} type="submit" className={btnOk}>Done</button>
            : <>
                <button ref={cancelRef} type="button" className={btnCancel} onClick={() => close(false)}>{o.cancelLabel || 'Cancel'}</button>
                <button ref={okRef} type="submit" disabled={blocked} className={o.danger ? btnDanger : btnOk}>{o.confirmLabel || (req.kind === 'prompt' ? 'Save' : 'Confirm')}</button>
              </>}
        </div>
      </form>
    </div>
  );
}

/** Mount once (app/providers.tsx). Shows queued confirm / prompt dialogs one at a time. */
export function DialogHost() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const req = queue[0];
  if (!req || typeof document === 'undefined') return null;
  // react-dom ships its own copy of @types/react, so cast its portal to this app's React types
  return createPortal(<Dialog key={req.id} req={req} /> as any, document.body) as unknown as React.ReactElement;
}
