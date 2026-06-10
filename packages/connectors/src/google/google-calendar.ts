/**
 * Google Calendar connector hook.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Calendar API v3 docs
 * (https://developers.google.com/calendar/api/v3/reference/events/list) but
 * have not been exercised against a live account.
 *
 * Sync strategy:
 *  - full: events.list on the primary calendar with a timeMin/timeMax window
 *    (defaults: 7 days back to 30 days ahead; overridable via settings).
 *  - incremental: `updatedMin` derived from the persisted max `updated`
 *    timestamp seen in the previous run.
 *
 * Write side (approval flow only): `create_event` POSTs to events.insert.
 */
import type { PersonRef, RawSourceItem } from '@donna/core';
import type {
  Connector,
  ConnectorAction,
  ConnectorActionResult,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { GoogleAuth, GOOGLE_REQUIRED_ENV, missingGoogleEnv } from './google-auth.js';
import { parseJsonCursor } from '../util/parse.js';

export const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';

const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;

interface GoogleCalendarCursor extends Record<string, unknown> {
  pageToken?: string;
  /** ISO `updated` lower bound for incremental syncs. */
  updatedMin?: string;
  maxUpdated?: string;
}

interface GoogleCalendarAttendee {
  email?: string;
  displayName?: string;
}

interface GoogleCalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  updated?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: GoogleCalendarAttendee;
  attendees?: GoogleCalendarAttendee[];
}

export class GoogleCalendarConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'google-calendar',
    category: 'calendar',
    label: 'Google Calendar',
    description: 'Primary Google Calendar via the Calendar API (OAuth refresh-token flow).',
    capabilities: ['read', 'list', 'search', 'create'],
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    requiredEnv: [...GOOGLE_REQUIRED_ENV],
    local: false,
  };

  constructor(private readonly auth: GoogleAuth = new GoogleAuth()) {}

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const missing = missingGoogleEnv(ctx);
    if (missing.length > 0) {
      return { ok: false, message: `not configured: missing env ${missing.join(', ')}` };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const res = await fetch(`${GOOGLE_CALENDAR_BASE_URL}/calendars/primary`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return { ok: false, message: `Google Calendar check failed: HTTP ${res.status}` };
      }
      const cal = (await res.json()) as { summary?: string };
      return { ok: true, message: `Google Calendar reachable (${cal.summary ?? 'primary'})` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Google Calendar health check failed',
      };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<GoogleCalendarCursor>(req.cursor) ?? {};

    const params = new URLSearchParams({
      maxResults: String(limit),
      singleEvents: 'true',
    });
    const updatedMin = req.mode === 'incremental' ? cursor.updatedMin : undefined;
    if (typeof updatedMin === 'string' && updatedMin) {
      params.set('updatedMin', updatedMin);
      params.set('orderBy', 'updated');
      params.set('showDeleted', 'false');
    } else {
      // Window for the full sync. Defaults are computed from the wall clock —
      // acceptable in an adapter; override via settings for determinism.
      const timeMin = ctx.settings['calendarTimeMin'];
      const timeMax = ctx.settings['calendarTimeMax'];
      params.set(
        'timeMin',
        typeof timeMin === 'string' && timeMin
          ? timeMin
          : new Date(Date.now() - 7 * DAY_MS).toISOString(),
      );
      params.set(
        'timeMax',
        typeof timeMax === 'string' && timeMax
          ? timeMax
          : new Date(Date.now() + 30 * DAY_MS).toISOString(),
      );
      params.set('orderBy', 'startTime');
    }
    if (typeof cursor.pageToken === 'string' && cursor.pageToken) {
      params.set('pageToken', cursor.pageToken);
    }

    const res = await fetch(
      `${GOOGLE_CALENDAR_BASE_URL}/calendars/primary/events?${params.toString()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Google Calendar list failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      items?: GoogleCalendarEvent[];
      nextPageToken?: string;
    };

    const items: RawSourceItem[] = [];
    let maxUpdated = cursor.maxUpdated ?? updatedMin ?? '';
    for (const event of json.items ?? []) {
      if (event.status === 'cancelled') continue;
      const item = mapGoogleCalendarEvent(event);
      if (item) {
        items.push(item);
        if (event.updated && event.updated > maxUpdated) maxUpdated = event.updated;
      }
    }

    const done = !json.nextPageToken;
    const nextCursor: GoogleCalendarCursor = done
      ? { updatedMin: maxUpdated || undefined }
      : { pageToken: json.nextPageToken, updatedMin, maxUpdated };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type !== 'create_event') {
      return { ok: false, detail: `google-calendar does not support action '${action.type}'` };
    }
    const title = typeof action.params['title'] === 'string' ? action.params['title'] : '';
    const startsAt = typeof action.params['startsAt'] === 'string' ? action.params['startsAt'] : '';
    const endsAt = typeof action.params['endsAt'] === 'string' ? action.params['endsAt'] : '';
    const description =
      typeof action.params['description'] === 'string' ? action.params['description'] : undefined;
    const attendees = Array.isArray(action.params['attendees'])
      ? action.params['attendees'].filter((a): a is string => typeof a === 'string')
      : [];
    if (!title || !startsAt || !endsAt) {
      return { ok: false, detail: "create_event requires 'title', 'startsAt', and 'endsAt' params" };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const res = await fetch(`${GOOGLE_CALENDAR_BASE_URL}/calendars/primary/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: title,
          description,
          start: { dateTime: startsAt },
          end: { dateTime: endsAt },
          attendees: attendees.map((email) => ({ email })),
        }),
      });
      if (!res.ok) {
        return { ok: false, detail: `Google Calendar event creation failed: HTTP ${res.status}` };
      }
      const created = (await res.json()) as { id?: string };
      return { ok: true, externalRef: created.id, detail: `Event "${title}" created` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'Google Calendar event creation failed',
      };
    }
  }
}

/** Map a Calendar API event resource to Donna's RawSourceItem. */
export function mapGoogleCalendarEvent(event: GoogleCalendarEvent): RawSourceItem | null {
  if (!event.id) return null;
  const startsAt = event.start?.dateTime ?? event.start?.date;
  const endsAt = event.end?.dateTime ?? event.end?.date;
  if (!startsAt) return null;

  const toRef = (a: GoogleCalendarAttendee): PersonRef => {
    const ref: PersonRef = {};
    if (a.displayName) ref.name = a.displayName;
    if (a.email) ref.email = a.email;
    return ref;
  };

  const item: RawSourceItem = {
    externalId: event.id,
    category: 'calendar',
    title: event.summary ?? '(untitled event)',
    timestamp: new Date(startsAt).toISOString(),
    startsAt: new Date(startsAt).toISOString(),
    raw: { provider: 'google-calendar', updated: event.updated ?? null },
  };
  if (endsAt) item.endsAt = new Date(endsAt).toISOString();
  if (event.description) item.bodyText = event.description;
  if (event.htmlLink) item.url = event.htmlLink;
  if (event.organizer) item.sender = toRef(event.organizer);
  if (event.attendees && event.attendees.length > 0) {
    item.participants = event.attendees.map(toRef);
  }
  if (event.iCalUID) item.dedupeHint = event.iCalUID;
  return item;
}
