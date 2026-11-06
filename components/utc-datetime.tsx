'use client';
import React from 'react';
import { utcInputToUnix, fmtUtc, fmtLocal, fmtUtcTime, fmtLocalTime } from '@/lib/utc-time';

// Unix seconds <-> <input type="datetime-local"> value in the browser's local time zone
const pad = (n: number) => String(n).padStart(2, '0');
const unixToLocalInput = (ts: number) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localInputToUnix = (v: string) => {
  if (!v) return 0;
  const ms = new Date(v).getTime(); // no zone suffix: read as local time
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
};
const unixToUtcInputStr = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 16) : '');
// the browser's zone, e.g. "GMT", "GMT+5:30"
const localZone = (ts?: number) =>
  new Date((ts || Date.now() / 1000) * 1000).toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop() || 'local';

// Date + time picked in the admin's LOCAL time; the value it hands back (and receives) stays the UTC
// "YYYY-MM-DDTHH:mm" string every caller already uses (utcInputToUnix), so what goes on-chain is
// unchanged. The line underneath shows the UTC time that will be stored.
export function UtcDateTimeInput({ value, onChange, disabled, className }: {
  value: string; // UTC
  onChange: (value: string) => void; // UTC
  disabled?: boolean;
  className?: string;
}) {
  const ts = utcInputToUnix(value);
  const zone = localZone(ts);
  return (
    <>
      <div className="flex items-center gap-2">
        <input
          value={unixToLocalInput(ts)}
          onChange={e => onChange(unixToUtcInputStr(localInputToUnix(e.target.value)))}
          type="datetime-local"
          disabled={disabled}
          className={`${className ?? ''} min-w-0`}
        />
        <span className="shrink-0 text-xs font-semibold text-accent" title="Enter the time in your local time zone">{zone}</span>
      </div>
      <p className="text-[10px] text-txt-secondary/70 mt-1">
        {ts && !disabled
          ? <>
              <span className="text-txt-secondary">{fmtUtc(ts)}</span>
              {new Date(ts * 1000).getTimezoneOffset() !== 0 ? ` (stored on-chain) · your local time: ${fmtLocal(ts)}` : ' (same as your local time)'}
            </>
          : `Enter in your local time (${zone}); it is stored in UTC`}
      </p>
    </>
  );
}

// Unix timestamp shown in UTC with the local time underneath (`inline`: after it, for use inside a
// sentence; `time`: clock time only; `localFirst`: local time on top, UTC underneath); 0 shows `empty`
export function UtcTime({ ts, empty = '—', inline, time, localFirst }: { ts: number; empty?: string; inline?: boolean; time?: boolean; localFirst?: boolean }) {
  if (!ts) return <>{empty}</>;
  const utc = time ? fmtUtcTime(ts) : fmtUtc(ts);
  const local = time ? fmtLocalTime(ts) : fmtLocal(ts);
  const [main, sub] = localFirst ? [local, utc] : [utc, local];
  if (inline) return <>{main} <span className="text-txt-secondary/70">({sub})</span></>;
  return (
    <span className="inline-flex flex-col">
      <span>{main}</span>
      <span className="text-[10px] text-txt-secondary/70">{sub}</span>
    </span>
  );
}
