// All on-chain times are Unix seconds (UTC). Date/time inputs are entered and shown in UTC so every
// operator sets the same moment regardless of their browser's time zone; local time is only a hint.

// <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm[:ss]") read as UTC -> Unix seconds (blank -> 0)
export const utcInputToUnix = (value: string) => {
  if (!value) return 0;
  const ms = Date.parse(`${value}Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
};

// Unix seconds -> <input type="datetime-local"> value in UTC (0 -> blank)
export const unixToUtcInput = (ts: number) => ts ? new Date(ts * 1000).toISOString().slice(0, 16) : '';

// Unix seconds -> "2026-11-05 23:59 UTC"
export const fmtUtc = (ts: number) => `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// Unix seconds -> browser-local date and time with zone, e.g. "6 Nov 2026, 05:29 GMT+5:30"
export const fmtLocal = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

// Unix seconds -> "23:59 UTC" / browser-local "05:29 AM GMT+5:30"
export const fmtUtcTime = (ts: number) => `${new Date(ts * 1000).toISOString().slice(11, 16)} UTC`;
export const fmtLocalTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

// ISO string (e.g. a stored "2026-11-03T15:23:51.000Z") -> Unix seconds (invalid -> 0)
export const isoToUnix = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
};

// Seconds since 00:00 UTC <-> <input type="time"> value ("HH:mm", UTC)
export const secondsToUtcTime = (secs: number) => {
  const s = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};
export const utcTimeToSeconds = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return String((h || 0) * 3600 + (m || 0) * 60);
};

// Seconds since 00:00 UTC -> the same clock time in the browser's zone, e.g. "23:30 GMT+5:30"
export const fmtLocalTimeOfDay = (secs: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + (((secs % 86400) + 86400) % 86400) * 1000)
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
};
