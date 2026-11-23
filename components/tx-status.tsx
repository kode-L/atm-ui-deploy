'use client';
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle, Copy, ExternalLink, Loader2, X, XCircle } from 'lucide-react';
import { getExplorerTxUrl } from '@/lib/contracts/config';
import { copyDialog } from '@/components/confirm-dialog';

interface TxStatusProps {
  status?: 'idle' | 'pending' | 'success' | 'error';
  hash?: string;
  error?: string;
  message?: string;
  // Falls back to the testnet explorer (getExplorerTxUrl's own default) if omitted.
  chainId?: number;
}

// ── Toast stack ────────────────────────────────────────────────────────────────
// Every transaction toast (and the Voucher V2 step panel) goes into one fixed stack in the
// bottom-right corner, so several never overlap each other.
const STACK_ID = 'tx-toast-stack';
function stackHost(): HTMLElement {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = STACK_ID;
    el.className = 'fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-32px)]';
    document.body.appendChild(el);
  }
  return el;
}

/** Renders its children as a toast in the shared bottom-right stack. */
export function ToastPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(stackHost()), []);
  if (!host) return null;
  // react-dom ships its own copy of @types/react, so cast its portal to this app's React types
  const box = <div className="pointer-events-auto w-[400px] max-w-full">{children}</div>;
  return createPortal(box as any, host) as unknown as React.ReactElement;
}

/** Small copy-to-clipboard icon button (falls back to a prompt when the clipboard is blocked). */
export function CopyButton({ text, title = 'Copy', label }: { text: string; title?: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      copyDialog(text);
    }
  };
  return (
    <button type="button" onClick={copy} title={title} className="inline-flex items-center gap-1 shrink-0 text-txt-secondary hover:text-txt-primary text-xs">
      {done ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

// ── Busy button ────────────────────────────────────────────────────────────────
// Remember the last button the user clicked; when a tx goes pending right after, that button
// gets a spinner (see `button[data-tx-busy]` in globals.css) and can't be clicked again.
let lastClick: { btn: HTMLButtonElement; at: number } | null = null;
let clickTrackerOn = false;
function trackClicks() {
  if (clickTrackerOn || typeof document === 'undefined') return;
  clickTrackerOn = true;
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest?.('button');
    if (btn && !btn.closest(`#${STACK_ID}, [data-tx-ignore-click]`)) lastClick = { btn: btn as HTMLButtonElement, at: Date.now() };
  }, true);
}
const CLICK_WINDOW_MS = 15_000;

/** Restart the click window — called when the user confirms a dialog the clicked button opened. */
export function refreshLastClick() {
  if (lastClick) lastClick = { ...lastClick, at: Date.now() };
}

/** While `pending`, the button the user last clicked shows a spinner and ignores clicks. */
export function useBusyButton(pending: boolean) {
  const busyBtn = useRef<HTMLButtonElement | null>(null);
  useEffect(trackClicks, []);
  useEffect(() => {
    if (pending) {
      if (!busyBtn.current && lastClick && Date.now() - lastClick.at < CLICK_WINDOW_MS && lastClick.btn.isConnected) {
        busyBtn.current = lastClick.btn;
        busyBtn.current.setAttribute('data-tx-busy', '');
        busyBtn.current.setAttribute('aria-busy', 'true');
      }
    } else if (busyBtn.current) {
      busyBtn.current.removeAttribute('data-tx-busy');
      busyBtn.current.removeAttribute('aria-busy');
      busyBtn.current = null;
    }
  }, [pending]);
  useEffect(() => () => {
    busyBtn.current?.removeAttribute('data-tx-busy');
    busyBtn.current?.removeAttribute('aria-busy');
  }, []);
}

function shortHash(h: string) {
  return h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;
}

/**
 * Status of the last transaction a section sent. Shown as a toast in the bottom-right corner
 * (copy hash / error, close) while the button that sent it shows a spinner.
 */
export default function TxStatus({ status, hash, error, message, chainId }: TxStatusProps) {
  const key = `${status}|${hash}|${message}|${error}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useBusyButton(status === 'pending');

  if (!status || status === 'idle' || dismissed === key) return null;

  const title = message || (
    status === 'pending' ? (hash ? 'Confirming on-chain…' : 'Confirm it in your wallet…')
    : status === 'success' ? 'Transaction successful'
    : 'Transaction failed'
  );
  const explorer = hash ? getExplorerTxUrl(chainId ?? 0, hash) : '';
  const allText = [title, hash && `tx ${hash}`, explorer, error && `error: ${error}`].filter(Boolean).join('\n');

  return (
    <ToastPortal>
      <div role="status" className={`rounded-xl border shadow-2xl p-3 text-sm bg-surface-secondary ${
        status === 'pending' ? 'border-yellow-400/40' : status === 'success' ? 'border-green-400/40' : 'border-red-400/40'
      }`}>
        <div className="flex items-start gap-2">
          {status === 'pending' && <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0 text-yellow-300" />}
          {status === 'success' && <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-green-400" />}
          {status === 'error' && <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />}
          <p className={`flex-1 min-w-0 break-words ${
            status === 'pending' ? 'text-yellow-200' : status === 'success' ? 'text-green-200' : 'text-red-200'
          }`}>{title}</p>
          <button type="button" onClick={() => setDismissed(key)} title="Close" className="shrink-0 text-txt-secondary hover:text-txt-primary">
            <X className="w-4 h-4" />
          </button>
        </div>
        {hash && (
          <div className="mt-2 flex items-center gap-2 text-xs pl-6">
            <span className="text-txt-secondary">tx</span>
            <a href={explorer} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline inline-flex items-center gap-1" title={hash}>
              {shortHash(hash)} <ExternalLink className="w-3 h-3" />
            </a>
            <CopyButton text={hash} title="Copy tx hash" />
          </div>
        )}
        {error && (
          <div className="mt-2 pl-6 flex items-start gap-2">
            <p className="flex-1 min-w-0 text-xs text-red-300/90 break-all max-h-32 overflow-y-auto">{error}</p>
            <CopyButton text={error} title="Copy error" />
          </div>
        )}
        {(hash || error) && (
          <div className="mt-2 pl-6"><CopyButton text={allText} title="Copy status, hash, explorer link and error" label="Copy all" /></div>
        )}
      </div>
    </ToastPortal>
  );
}
