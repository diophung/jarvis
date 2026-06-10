/**
 * Mock calendar connector. Serves Alex Chen's demo calendar (yesterday through
 * +7 days, regenerated relative to now) and demonstrates the approval flow:
 * `create_event` / `update_event` "succeed" with fake external references.
 */
import type { RawSourceItem } from '@donna/core';
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
import { createDemoDataset } from '../demo/dataset.js';
import { findMockItem, resolveDemoNow, serveMockPage } from './base.js';

export class MockCalendarConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'mock-calendar',
    category: 'calendar',
    label: 'Demo Calendar',
    description:
      "Alex Chen's demo calendar, spanning yesterday through next week. Local mock data.",
    capabilities: ['read', 'list', 'search', 'create', 'update'],
    scopes: [],
    requiredEnv: [],
    local: true,
  };

  private eventCounter = 0;

  async healthCheck(_ctx: ConnectorContext): Promise<ConnectorHealth> {
    return { ok: true, message: 'Mock calendar connector ready (local demo data).' };
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return serveMockPage(dataset.calendarEvents, dataset.incremental.calendar, req);
  }

  async fetchItem(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return findMockItem(dataset.calendarEvents, dataset.incremental.calendar, externalId);
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type === 'create_event') {
      const title = typeof action.params['title'] === 'string' ? action.params['title'] : '';
      const startsAt =
        typeof action.params['startsAt'] === 'string' ? action.params['startsAt'] : '';
      if (!title || !startsAt) {
        return { ok: false, detail: "create_event requires 'title' and 'startsAt' params" };
      }
      this.eventCounter += 1;
      const externalRef = `mock-event-${String(this.eventCounter).padStart(4, '0')}`;
      ctx.logger.info(`mock-calendar: pretended to create event "${title}"`);
      return { ok: true, externalRef, detail: `Mock event "${title}" created at ${startsAt}` };
    }
    if (action.type === 'update_event') {
      const externalId =
        typeof action.params['externalId'] === 'string' ? action.params['externalId'] : '';
      if (!externalId) {
        return { ok: false, detail: "update_event requires an 'externalId' param" };
      }
      ctx.logger.info(`mock-calendar: pretended to update event ${externalId}`);
      return { ok: true, externalRef: externalId, detail: `Mock event ${externalId} updated` };
    }
    return { ok: false, detail: `mock-calendar does not support action '${action.type}'` };
  }
}
