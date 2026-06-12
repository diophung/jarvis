/**
 * Translate between the server's 5-field cron string and a friendly,
 * Outlook-recurrence-style schedule (frequency + time + weekdays).
 *
 * The digest schedule API stores a raw cron expression; the Settings UI lets
 * people compose one without ever seeing cron. Anything the simple editor
 * can't represent (step values, day-of-month, named ranges, …) falls back to
 * a raw "custom cron" field instead — `parseCron` returns `null` for those.
 *
 * Times are interpreted on the local clock for the preview; the server runs
 * the cron in its own timezone (see docs/auth.md / context.ts), so the
 * "next debrief" line is a best-effort hint, not a contract.
 */

export type Frequency = 'daily' | 'weekdays' | 'weekly';

export interface Recurrence {
  frequency: Frequency;
  /** Hour on a 24h clock, 0–23. */
  hour: number;
  /** Minute, 0–59. */
  minute: number;
  /** Selected weekdays for `weekly` (0=Sun … 6=Sat); ignored for daily/weekdays. */
  days: number[];
}

export const WEEKDAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LABELS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Monday–Friday as cron weekday numbers. */
const WEEKDAYS = [1, 2, 3, 4, 5];

/** A plain non-negative integer within [min, max], or null. */
function parsePlainInt(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/**
 * Parse a cron day-of-week field into a sorted set of 0–6 days, `'all'` for
 * `*`, or null for anything we don't model. Accepts comma lists and `a-b`
 * ranges over 0–7 (both 0 and 7 mean Sunday).
 */
function parseDayOfWeek(field: string): number[] | 'all' | null {
  if (field === '*') return 'all';
  const days = new Set<number>();
  for (const token of field.split(',')) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > 7 || end > 7 || start > end) return null;
      for (let d = start; d <= end; d++) days.add(d % 7);
    } else if (/^\d+$/.test(token)) {
      const d = Number(token);
      if (d > 7) return null;
      days.add(d % 7);
    } else {
      return null;
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** Parse a cron string into a Recurrence, or null if the simple editor can't model it. */
export function parseCron(cron: string): Recurrence | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = fields;
  if (
    min === undefined ||
    hour === undefined ||
    dom === undefined ||
    mon === undefined ||
    dow === undefined
  ) {
    return null;
  }
  // Day-of-month / month restrictions aren't expressible in the simple editor.
  if (dom !== '*' || mon !== '*') return null;
  const minute = parsePlainInt(min, 0, 59);
  const hourNum = parsePlainInt(hour, 0, 23);
  if (minute === null || hourNum === null) return null;
  const days = parseDayOfWeek(dow);
  if (days === null) return null;
  if (days === 'all') return { frequency: 'daily', hour: hourNum, minute, days: [] };
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) {
    return { frequency: 'weekdays', hour: hourNum, minute, days: [] };
  }
  return { frequency: 'weekly', hour: hourNum, minute, days };
}

/** Render a Recurrence back into a 5-field cron string. */
export function toCron(r: Recurrence): string {
  const time = `${r.minute} ${r.hour}`;
  if (r.frequency === 'daily') return `${time} * * *`;
  if (r.frequency === 'weekdays') return `${time} * * 1-5`;
  const days = [...new Set(r.days)].sort((a, b) => a - b);
  return `${time} * * ${days.join(',')}`;
}

/** The weekdays (0–6) a recurrence fires on. */
function activeDays(r: Recurrence): number[] {
  if (r.frequency === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (r.frequency === 'weekdays') return WEEKDAYS;
  return [...new Set(r.days)].sort((a, b) => a - b);
}

/** A weekly recurrence needs at least one selected day to be valid. */
export function isValidRecurrence(r: Recurrence): boolean {
  return r.frequency !== 'weekly' || r.days.length > 0;
}

/** "7:30 AM", "12:00 PM", "12:00 AM". */
export function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

/** "07:30" — the value shape a native <input type="time"> expects. */
export function toTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Parse an "HH:MM" time-input value, or null if malformed/out of range. */
export function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** "A", "A and B", or "A, B and C". */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A plain-English sentence, e.g. "Every weekday at 7:30 AM". */
export function describeRecurrence(r: Recurrence): string {
  const at = `at ${formatTime(r.hour, r.minute)}`;
  if (r.frequency === 'daily') return `Every day ${at}`;
  if (r.frequency === 'weekdays') return `Every weekday ${at}`;
  if (r.days.length === 0) return 'Pick at least one day';
  if (r.days.length === 7) return `Every day ${at}`;
  const names = activeDays(r).map((d) => WEEKDAY_LABELS_LONG[d] ?? '');
  return `Every ${joinWithAnd(names)} ${at}`;
}

/** The next fire time strictly after `from`, or null if none within a week. */
export function nextRun(r: Recurrence, from: Date): Date | null {
  if (!isValidRecurrence(r)) return null;
  const days = new Set(activeDays(r));
  for (let i = 0; i <= 7; i++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + i);
    candidate.setHours(r.hour, r.minute, 0, 0);
    if (candidate.getTime() > from.getTime() && days.has(candidate.getDay())) {
      return candidate;
    }
  }
  return null;
}

/** "Thursday, Jun 11 at 7:30 AM". */
export function formatNextRun(date: Date): string {
  const weekday = WEEKDAY_LABELS_LONG[date.getDay()];
  const month = MONTHS_SHORT[date.getMonth()];
  return `${weekday}, ${month} ${date.getDate()} at ${formatTime(date.getHours(), date.getMinutes())}`;
}
