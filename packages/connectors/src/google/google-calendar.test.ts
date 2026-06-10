import { describe, expect, it } from 'vitest';
import { mapGoogleCalendarEvent } from './google-calendar.js';

describe('mapGoogleCalendarEvent', () => {
  it('gives expanded occurrences of one recurring series distinct dedupeHints', () => {
    const first = mapGoogleCalendarEvent({
      id: 'evt-series_20260608T090000Z',
      summary: 'Daily standup',
      iCalUID: 'series-uid@google.com',
      start: { dateTime: '2026-06-08T09:00:00Z' },
      end: { dateTime: '2026-06-08T09:15:00Z' },
      originalStartTime: { dateTime: '2026-06-08T09:00:00Z' },
    });
    const second = mapGoogleCalendarEvent({
      id: 'evt-series_20260609T090000Z',
      summary: 'Daily standup',
      iCalUID: 'series-uid@google.com',
      start: { dateTime: '2026-06-09T09:00:00Z' },
      end: { dateTime: '2026-06-09T09:15:00Z' },
      originalStartTime: { dateTime: '2026-06-09T09:00:00Z' },
    });

    expect(first?.dedupeHint).toBe('series-uid@google.com:2026-06-08T09:00:00Z');
    expect(second?.dedupeHint).toBe('series-uid@google.com:2026-06-09T09:00:00Z');
    expect(first?.dedupeHint).not.toBe(second?.dedupeHint);
  });

  it('falls back to the start time when originalStartTime is absent (all-day too)', () => {
    const timed = mapGoogleCalendarEvent({
      id: 'evt-1',
      summary: 'One-off',
      iCalUID: 'one-off@google.com',
      start: { dateTime: '2026-06-10T13:00:00Z' },
    });
    expect(timed?.dedupeHint).toBe('one-off@google.com:2026-06-10T13:00:00Z');

    const allDay = mapGoogleCalendarEvent({
      id: 'evt-2',
      summary: 'Offsite',
      iCalUID: 'offsite@google.com',
      start: { date: '2026-06-12' },
    });
    expect(allDay?.dedupeHint).toBe('offsite@google.com:2026-06-12');
  });

  it('leaves dedupeHint undefined when the event has no iCalUID', () => {
    const item = mapGoogleCalendarEvent({
      id: 'evt-3',
      summary: 'No UID',
      start: { dateTime: '2026-06-10T13:00:00Z' },
    });
    expect(item).not.toBeNull();
    expect(item?.dedupeHint).toBeUndefined();
  });
});
