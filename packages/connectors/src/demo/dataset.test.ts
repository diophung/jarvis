import { describe, expect, it } from 'vitest';
import type { RawSourceItem } from '@jarvis/core';
import { createDemoDataset, DEMO_PEOPLE, DEMO_PROJECTS, DEMO_SELF } from './dataset.js';

const NOW = new Date('2026-06-09T10:30:00.000Z');

function allItems(dataset: ReturnType<typeof createDemoDataset>): RawSourceItem[] {
  return [
    ...dataset.emails,
    ...dataset.chatMessages,
    ...dataset.calendarEvents,
    ...dataset.storageFiles,
    ...dataset.incremental.email,
    ...dataset.incremental.chat,
    ...dataset.incremental.calendar,
    ...dataset.incremental.storage,
  ];
}

describe('createDemoDataset', () => {
  const dataset = createDemoDataset(NOW);

  it('has the expected volume of content', () => {
    expect(dataset.emails.length).toBeGreaterThanOrEqual(18);
    expect(dataset.chatMessages.length).toBeGreaterThanOrEqual(12);
    expect(dataset.calendarEvents.length).toBeGreaterThanOrEqual(9);
    expect(dataset.storageFiles.length).toBeGreaterThanOrEqual(8);
  });

  it('spreads chat messages across 3 channels', () => {
    const channels = new Set(dataset.chatMessages.map((m) => m.threadExternalId));
    expect(channels.size).toBe(3);
  });

  it('spans calendar events from yesterday to +7 days', () => {
    const starts = dataset.calendarEvents
      .map((e) => e.startsAt)
      .filter((s): s is string => typeof s === 'string')
      .map((s) => new Date(s).getTime());
    const min = Math.min(...starts);
    const max = Math.max(...starts);
    expect(min).toBeLessThan(NOW.getTime());
    expect(min).toBeGreaterThan(NOW.getTime() - 2 * 86_400_000);
    expect(max).toBeGreaterThan(NOW.getTime() + 6 * 86_400_000);
    expect(max).toBeLessThan(NOW.getTime() + 8 * 86_400_000);
  });

  describe('demo beats', () => {
    it('urgent contract from Jin Park due ~tomorrow with an attachment', () => {
      const email = dataset.emails.find((e) => e.externalId === 'demo-email-001');
      expect(email).toBeDefined();
      expect(email?.sender?.email).toBe('jin.park@meridianlabs.com');
      expect(email?.attachments?.length).toBeGreaterThanOrEqual(1);
      expect(email?.isRead).toBe(false);
      const dueMs = new Date(email?.dueAt ?? 0).getTime();
      const hoursFromNow = (dueMs - NOW.getTime()) / 3_600_000;
      expect(hoursFromNow).toBeGreaterThan(0);
      // "Tomorrow 17:00 local" is at most ~41h away (when now is just past local midnight).
      expect(hoursFromNow).toBeLessThan(42);
    });

    it('CEO email asking for a budget decision by Friday', () => {
      const email = dataset.emails.find(
        (e) =>
          e.sender?.email === 'sarah.okafor@meridianlabs.com' &&
          /budget/i.test(e.title) &&
          e.dueAt !== undefined,
      );
      expect(email).toBeDefined();
      expect(email?.bodyText).toMatch(/Friday/);
      const dueMs = new Date(email?.dueAt ?? 0).getTime();
      const daysFromNow = (dueMs - NOW.getTime()) / 86_400_000;
      expect(daysFromNow).toBeGreaterThan(2);
      expect(daysFromNow).toBeLessThan(6);
    });

    it("has the 'Atlas Launch Readiness Review' today at 14:00 local with prep + deck", () => {
      const event = dataset.calendarEvents.find(
        (e) => e.title === 'Atlas Launch Readiness Review',
      );
      expect(event).toBeDefined();
      const start = new Date(event?.startsAt ?? 0);
      expect(start.getDate()).toBe(NOW.getDate());
      expect(start.getMonth()).toBe(NOW.getMonth());
      expect(start.getHours()).toBe(14);
      expect(start.getMinutes()).toBe(0);
      expect(event?.labels).toContain('needs-prep');
      // The deck attachment points into the demo storage source.
      const deckRef = event?.attachments?.[0]?.externalRef;
      expect(deckRef).toBe('demo-file-001');
      const deck = dataset.storageFiles.find((f) => f.externalId === 'demo-file-001');
      expect(deck).toBeDefined();
      expect(deck?.title).toMatch(/Readiness-Review/);
    });

    it('stale follow-up: Alex asked Priya ~5 days ago, and nobody replied in the thread', () => {
      const ask = dataset.emails.find((e) => e.externalId === 'demo-email-004');
      expect(ask).toBeDefined();
      expect(ask?.sender?.email).toBe(DEMO_SELF.emails[0]);
      const ageDays = (NOW.getTime() - new Date(ask?.timestamp ?? 0).getTime()) / 86_400_000;
      expect(ageDays).toBeGreaterThan(4.5);
      expect(ageDays).toBeLessThan(6);
      const repliesInThread = allItems(dataset).filter(
        (i) =>
          i.threadExternalId === ask?.threadExternalId && i.externalId !== ask?.externalId,
      );
      expect(repliesInThread).toHaveLength(0);
    });

    it('blocked vendor migration: Tom says he is blocked on the security review', () => {
      const blocked = dataset.chatMessages.find(
        (m) =>
          m.sender?.email === 'tom.muller@meridianlabs.com' &&
          /blocked/i.test(m.bodyText ?? '') &&
          /security review/i.test(m.bodyText ?? ''),
      );
      expect(blocked).toBeDefined();
      expect(blocked?.threadExternalId).toBe('demo-channel-vendor-migration');
    });

    it('buried important unread email from Daniel Reyes ~3 days ago', () => {
      const email = dataset.emails.find((e) => e.externalId === 'demo-email-003');
      expect(email).toBeDefined();
      expect(email?.sender?.email).toBe('daniel.reyes@northwind.io');
      expect(email?.isRead).toBe(false);
      const ageDays = (NOW.getTime() - new Date(email?.timestamp ?? 0).getTime()) / 86_400_000;
      expect(ageDays).toBeGreaterThan(2.5);
      expect(ageDays).toBeLessThan(4);
    });

    it('long strategy doc worth reading, with no deadline', () => {
      const doc = dataset.storageFiles.find((f) => /Strategy/i.test(f.title));
      expect(doc).toBeDefined();
      expect(doc?.bodyText?.length ?? 0).toBeGreaterThan(1500);
      expect(doc?.dueAt).toBeUndefined();
    });

    it('has 4-5 newsletters/notifications from low/ignore senders', () => {
      const noiseEmails = dataset.emails.filter((e) => {
        const sender = DEMO_PEOPLE.find((p) => p.emails.includes(e.sender?.email ?? ''));
        return sender !== undefined && (sender.importance === 'low' || sender.importance === 'ignore');
      });
      expect(noiseEmails.length).toBeGreaterThanOrEqual(4);
      expect(noiseEmails.length).toBeLessThanOrEqual(6);
    });

    it("has a chat escalation with 'ASAP' language", () => {
      const escalation = dataset.chatMessages.find((m) => /ASAP/.test(m.bodyText ?? ''));
      expect(escalation).toBeDefined();
      expect(escalation?.isRead).toBe(false);
    });
  });

  describe('coherence', () => {
    it('every sender resolves to a DEMO_PEOPLE email', () => {
      const knownEmails = new Set(DEMO_PEOPLE.flatMap((p) => p.emails));
      for (const item of allItems(dataset)) {
        if (item.sender?.email !== undefined) {
          expect(knownEmails, `unknown sender ${item.sender.email} on ${item.externalId}`).toContain(
            item.sender.email,
          );
        }
      }
    });

    it('every email/chat item has a sender and multi-paragraph-ish body text', () => {
      for (const item of [...dataset.emails, ...dataset.chatMessages]) {
        expect(item.sender, `missing sender on ${item.externalId}`).toBeDefined();
        expect(item.bodyText, `missing bodyText on ${item.externalId}`).toBeDefined();
        expect((item.bodyText ?? '').length).toBeGreaterThan(100);
      }
    });

    it('externalIds are unique across the whole dataset', () => {
      const ids = allItems(dataset).map((i) => i.externalId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('is stable: two calls with the same now produce identical data', () => {
      const again = createDemoDataset(new Date(NOW));
      expect(again).toEqual(dataset);
    });

    it('timestamps shift with now (always fresh demos)', () => {
      const later = createDemoDataset(new Date(NOW.getTime() + 86_400_000));
      const emailNow = dataset.emails.find((e) => e.externalId === 'demo-email-001');
      const emailLater = later.emails.find((e) => e.externalId === 'demo-email-001');
      expect(new Date(emailLater?.timestamp ?? 0).getTime()).toBe(
        new Date(emailNow?.timestamp ?? 0).getTime() + 86_400_000,
      );
    });

    it('incremental items land at/around now', () => {
      for (const item of [
        ...dataset.incremental.email,
        ...dataset.incremental.chat,
        ...dataset.incremental.storage,
      ]) {
        const ageMinutes = (NOW.getTime() - new Date(item.timestamp).getTime()) / 60_000;
        expect(ageMinutes).toBeGreaterThanOrEqual(0);
        expect(ageMinutes).toBeLessThan(15);
      }
    });
  });

  describe('seed exports', () => {
    it('DEMO_PEOPLE covers the cast with the right importance', () => {
      const byName = new Map(DEMO_PEOPLE.map((p) => [p.name, p]));
      expect(byName.get('Sarah Okafor')?.importance).toBe('vip');
      expect(byName.get('Daniel Reyes')?.importance).toBe('vip');
      expect(byName.get('Priya Sharma')?.importance).toBe('high');
      expect(byName.get('Tom Müller')?.importance).toBe('high');
      expect(byName.get('Jin Park')?.importance).toBe('high');
      expect(DEMO_SELF.isSelf).toBe(true);
      expect(DEMO_PEOPLE).toContain(DEMO_SELF);
      const noise = DEMO_PEOPLE.filter(
        (p) => p.importance === 'low' || p.importance === 'ignore',
      );
      expect(noise.length).toBeGreaterThanOrEqual(3);
    });

    it('DEMO_PROJECTS covers the three storylines', () => {
      const names = DEMO_PROJECTS.map((p) => p.name);
      expect(names).toContain('Atlas Launch');
      expect(names).toContain('Q3 Budget');
      expect(names).toContain('Vendor Migration');
      const atlas = DEMO_PROJECTS.find((p) => p.name === 'Atlas Launch');
      expect(atlas?.priority).toBe('high');
      expect(atlas?.dueAtOffsetDays).toBe(6);
      for (const project of DEMO_PROJECTS) {
        expect(project.keywords.length).toBeGreaterThan(0);
      }
    });
  });
});
