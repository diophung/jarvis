/**
 * Mock chat connector. Serves the demo Slack-style channels (#atlas-launch,
 * #leadership, #vendor-migration) and demonstrates the approval flow:
 * `post_message` "succeeds" with a fake external reference.
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

export class MockChatConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'mock-chat',
    category: 'chat',
    label: 'Demo Chat',
    description:
      "Meridian Labs' demo chat workspace (#atlas-launch, #leadership, #vendor-migration). Local mock data.",
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: [],
    requiredEnv: [],
    local: true,
  };

  private postCounter = 0;

  async healthCheck(_ctx: ConnectorContext): Promise<ConnectorHealth> {
    return { ok: true, message: 'Mock chat connector ready (local demo data).' };
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return serveMockPage(dataset.chatMessages, dataset.incremental.chat, req);
  }

  async fetchItem(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return findMockItem(dataset.chatMessages, dataset.incremental.chat, externalId);
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type === 'post_message') {
      const channel = typeof action.params['channel'] === 'string' ? action.params['channel'] : '';
      const text = typeof action.params['text'] === 'string' ? action.params['text'] : '';
      if (!channel || !text) {
        return { ok: false, detail: "post_message requires 'channel' and 'text' params" };
      }
      this.postCounter += 1;
      const externalRef = `mock-chat-msg-${String(this.postCounter).padStart(4, '0')}`;
      ctx.logger.info(`mock-chat: pretended to post message to ${channel}`);
      return { ok: true, externalRef, detail: `Mock message posted to ${channel}` };
    }
    return { ok: false, detail: `mock-chat does not support action '${action.type}'` };
  }
}
