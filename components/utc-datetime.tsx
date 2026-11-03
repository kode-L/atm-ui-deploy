'use client';
import React from 'react';
import { utcInputToUnix, fmtUtc, fmtLocal, fmtUtcTime, fmtLocalTime } from '@/lib/utc-time';

// datetime-local input whose value is UTC, with the matching local time shown underneath
export function UtcDateTimeInput({ value, onChange, disabled, className }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const ts = utcInputToUnix(value);
  return (
    <>
      <input value={value} onChange={e => onChange(e.target.value)} type="datetime-local" disabled={disabled} className={className} />
      <p className="text-[10px] text-txt-secondary/70 mt-1">
        {ts && !disabled ? `Your local time: ${fmtLocal(ts)}` : 'Entered in UTC'}
      </p>
    </>
  );
}

// Unix timestamp shown in UTC with the local time underneath (`inline`: after it, for use inside a
// sentence; `time`: clock time only); 0 shows `empty`
export function UtcTime({ ts, empty = '—', inline, time }: { ts: number; empty?: string; inline?: boolean; time?: boolean }) {
  if (!ts) return <>{empty}</>;
  const utc = time ? fmtUtcTime(ts) : fmtUtc(ts);
  const local = time ? fmtLocalTime(ts) : fmtLocal(ts);
  if (inline) return <>{utc} <span className="text-txt-secondary/70">({local})</span></>;
  return (
    <span className="inline-flex flex-col">
      <span>{utc}</span>
      <span className="text-[10px] text-txt-secondary/70">{local}</span>
    </span>
  );
}
