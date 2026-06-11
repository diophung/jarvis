import { describe, expect, it } from 'vitest';
import {
  type Recurrence,
  describeRecurrence,
  formatNextRun,
  formatTime,
  isValidRecurrence,
  nextRun,
  parseCron,
  parseTimeInput,
  toCron,
  toTimeInput,
} from './digest-schedule.js';

describe('parseCron', () => {
  it('maps a plain daily cron', () => {
    expect(parseCron('0 7 * * *')).toEqual({
      frequency: 'daily',
      hour: 7,
      minute: 0,
      days: [],
    });
  });

  it('recognises Mon–Fri (range form) as weekdays', () => {
    expect(parseCron('30 7 * * 1-5')).toEqual({
      frequency: 'weekdays',
      hour: 7,
      minute: 30,
      days: [],
    });
  });

  it('recognises Mon–Fri (list form) as weekdays', () => {
    expect(parseCron('0 8 * * 1,2,3,4,5')?.frequency).toBe('weekdays');
  });

  it('maps a specific-days cron to weekly with sorted days', () => {
    expect(parseCron('0 8 * * 5,1,3')).toEqual({
      frequency: 'weekly',
      hour: 8,
      minute: 0,
      days: [1, 3, 5],
    });
  });

  it('treats both 0 and 7 as Sunday', () => {
    expect(parseCron('0 9 * * 7')).toEqual({
      frequency: 'weekly',
      hour: 9,
      minute: 0,
      days: [0],
    });
  });

  it('returns null for schedules the simple editor cannot model', () => {
    expect(parseCron('*/5 * * * *')).toBeNull(); // step minute
    expect(parseCron('0 7 1 * *')).toBeNull(); // day-of-month
    expect(parseCron('0 7 * 6 *')).toBeNull(); // month
    expect(parseCron('0 7 * * 9')).toBeNull(); // out-of-range weekday
    expect(parseCron('0 25 * * *')).toBeNull(); // out-of-range hour
    expect(parseCron('not a cron')).toBeNull();
    expect(parseCron('0 7 * *')).toBeNull(); // too few fields
  });
});

describe('toCron', () => {
  it('renders each frequency', () => {
    expect(toCron({ frequency: 'daily', hour: 7, minute: 0, days: [] })).toBe('0 7 * * *');
    expect(toCron({ frequency: 'weekdays', hour: 7, minute: 30, days: [] })).toBe('30 7 * * 1-5');
    expect(toCron({ frequency: 'weekly', hour: 7, minute: 0, days: [5, 1] })).toBe('0 7 * * 1,5');
  });

  it('round-trips through parseCron', () => {
    // cron → Recurrence → cron is stable for shapes the editor models.
    for (const cron of ['0 7 * * *', '30 7 * * 1-5', '15 6 * * 1,3,5', '0 22 * * 0']) {
      expect(toCron(parseCron(cron) as Recurrence)).toBe(cron);
      expect(parseCron(toCron(parseCron(cron) as Recurrence))).toEqual(parseCron(cron));
    }
  });
});

describe('formatTime', () => {
  it('formats 12-hour clock with AM/PM', () => {
    expect(formatTime(7, 30)).toBe('7:30 AM');
    expect(formatTime(0, 0)).toBe('12:00 AM');
    expect(formatTime(12, 0)).toBe('12:00 PM');
    expect(formatTime(13, 5)).toBe('1:05 PM');
    expect(formatTime(23, 59)).toBe('11:59 PM');
  });
});

describe('time-input helpers', () => {
  it('formats and parses HH:MM', () => {
    expect(toTimeInput(7, 5)).toBe('07:05');
    expect(parseTimeInput('07:05')).toEqual({ hour: 7, minute: 5 });
    expect(parseTimeInput('8:00')).toEqual({ hour: 8, minute: 0 });
  });

  it('rejects malformed or out-of-range values', () => {
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('25:00')).toBeNull();
    expect(parseTimeInput('07:75')).toBeNull();
    expect(parseTimeInput('7:5')).toBeNull();
  });
});

describe('describeRecurrence', () => {
  it('describes each shape in plain English', () => {
    expect(describeRecurrence({ frequency: 'daily', hour: 7, minute: 0, days: [] })).toBe(
      'Every day at 7:00 AM',
    );
    expect(describeRecurrence({ frequency: 'weekdays', hour: 7, minute: 30, days: [] })).toBe(
      'Every weekday at 7:30 AM',
    );
    expect(describeRecurrence({ frequency: 'weekly', hour: 8, minute: 0, days: [1, 3, 5] })).toBe(
      'Every Monday, Wednesday and Friday at 8:00 AM',
    );
    expect(describeRecurrence({ frequency: 'weekly', hour: 8, minute: 0, days: [1, 5] })).toBe(
      'Every Monday and Friday at 8:00 AM',
    );
    expect(describeRecurrence({ frequency: 'weekly', hour: 8, minute: 0, days: [] })).toBe(
      'Pick at least one day',
    );
  });
});

describe('isValidRecurrence', () => {
  it('requires at least one day only for weekly', () => {
    expect(isValidRecurrence({ frequency: 'daily', hour: 7, minute: 0, days: [] })).toBe(true);
    expect(isValidRecurrence({ frequency: 'weekly', hour: 7, minute: 0, days: [] })).toBe(false);
    expect(isValidRecurrence({ frequency: 'weekly', hour: 7, minute: 0, days: [3] })).toBe(true);
  });
});

describe('nextRun', () => {
  // 2026-06-10 is a Wednesday (local time).
  it('fires later the same day when the time is still ahead', () => {
    const from = new Date(2026, 5, 10, 6, 0, 0, 0);
    const got = nextRun({ frequency: 'daily', hour: 7, minute: 0, days: [] }, from);
    expect(got).toEqual(new Date(2026, 5, 10, 7, 0, 0, 0));
  });

  it('rolls to tomorrow once today’s time has passed', () => {
    const from = new Date(2026, 5, 10, 9, 0, 0, 0);
    const got = nextRun({ frequency: 'daily', hour: 7, minute: 0, days: [] }, from);
    expect(got).toEqual(new Date(2026, 5, 11, 7, 0, 0, 0));
  });

  it('skips the weekend for a weekdays schedule', () => {
    // 2026-06-12 is a Friday; next weekday run is Monday the 15th.
    const from = new Date(2026, 5, 12, 9, 0, 0, 0);
    const got = nextRun({ frequency: 'weekdays', hour: 7, minute: 0, days: [] }, from);
    expect(got).toEqual(new Date(2026, 5, 15, 7, 0, 0, 0));
  });

  it('returns null for a weekly recurrence with no days', () => {
    const from = new Date(2026, 5, 10, 9, 0, 0, 0);
    expect(nextRun({ frequency: 'weekly', hour: 7, minute: 0, days: [] }, from)).toBeNull();
  });
});

describe('formatNextRun', () => {
  it('formats a friendly date + time', () => {
    expect(formatNextRun(new Date(2026, 5, 11, 7, 30, 0, 0))).toBe('Thursday, Jun 11 at 7:30 AM');
  });
});
