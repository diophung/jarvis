/**
 * Mock email connector. Serves Alex Chen's demo inbox from the demo dataset
 * and demonstrates the approval flow end-to-end: `send_email` / `reply_email`
 * "succeed" with a fake external reference and never touch the network.
 */
import type { RawSourceItem } from '@jarvis/core';
import type {
  AttachmentContent,
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
import { findMockItem, mockAttachmentContent, resolveDemoNow, serveMockPage } from './base.js';

export class MockEmailConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'mock-email',
    category: 'email',
    label: 'Demo Email',
    description:
      "Alex Chen's demo inbox at Meridian Labs. Local mock data — no credentials, no network.",
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: [],
    requiredEnv: [],
    local: true,
  };

  private sendCounter = 0;

  async healthCheck(_ctx: ConnectorContext): Promise<ConnectorHealth> {
    return { ok: true, message: 'Mock email connector ready (local demo data).' };
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return serveMockPage(dataset.emails, dataset.incremental.email, req);
  }

  async fetchItem(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return findMockItem(dataset.emails, dataset.incremental.email, externalId);
  }

  async fetchAttachment(
    _ctx: ConnectorContext,
    externalRef: string,
  ): Promise<AttachmentContent | null> {
    return {
      filename: `${externalRef}.txt`,
      mimeType: 'text/plain',
      data: mockAttachmentContent(externalRef),
    };
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type === 'send_email') {
      const to = typeof action.params['to'] === 'string' ? action.params['to'] : '';
      const subject = typeof action.params['subject'] === 'string' ? action.params['subject'] : '';
      if (!to || !subject) {
        return { ok: false, detail: "send_email requires 'to' and 'subject' params" };
      }
      this.sendCounter += 1;
      const externalRef = `mock-email-sent-${String(this.sendCounter).padStart(4, '0')}`;
      ctx.logger.info(`mock-email: pretended to send email to ${to}`);
      return { ok: true, externalRef, detail: `Mock email sent to ${to}: "${subject}"` };
    }
    if (action.type === 'reply_email') {
      const threadExternalId =
        typeof action.params['threadExternalId'] === 'string'
          ? action.params['threadExternalId']
          : '';
      const body = typeof action.params['body'] === 'string' ? action.params['body'] : '';
      if (!threadExternalId || !body) {
        return { ok: false, detail: "reply_email requires 'threadExternalId' and 'body' params" };
      }
      this.sendCounter += 1;
      const externalRef = `mock-email-sent-${String(this.sendCounter).padStart(4, '0')}`;
      ctx.logger.info(`mock-email: pretended to reply in thread ${threadExternalId}`);
      return { ok: true, externalRef, detail: `Mock reply sent in thread ${threadExternalId}` };
    }
    return { ok: false, detail: `mock-email does not support action '${action.type}'` };
  }
}
