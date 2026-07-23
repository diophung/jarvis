/**
 * Mock cloud-storage connector. Serves Meridian Labs' demo shared drive
 * (decks, contracts, runbooks, the long strategy doc). Read-only — file
 * uploads/sharing are not part of the demo surface.
 */
import type { RawSourceItem } from '@jarvis/core';
import type {
  AttachmentContent,
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { createDemoDataset } from '../demo/dataset.js';
import { findMockItem, mockAttachmentContent, resolveDemoNow, serveMockPage } from './base.js';

export class MockStorageConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'mock-storage',
    category: 'storage',
    label: 'Demo Drive',
    description:
      "Meridian Labs' demo shared drive: launch decks, contracts, runbooks, strategy docs. Local mock data.",
    capabilities: ['read', 'list', 'search', 'download'],
    scopes: [],
    requiredEnv: [],
    local: true,
  };

  async healthCheck(_ctx: ConnectorContext): Promise<ConnectorHealth> {
    return { ok: true, message: 'Mock storage connector ready (local demo data).' };
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return serveMockPage(dataset.storageFiles, dataset.incremental.storage, req);
  }

  async fetchItem(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null> {
    const dataset = createDemoDataset(resolveDemoNow(ctx));
    return findMockItem(dataset.storageFiles, dataset.incremental.storage, externalId);
  }

  async fetchAttachment(
    ctx: ConnectorContext,
    externalRef: string,
  ): Promise<AttachmentContent | null> {
    const item = await this.fetchItem(ctx, externalRef);
    if (!item) return null;
    return {
      filename: item.title,
      mimeType: 'text/plain',
      data: mockAttachmentContent(externalRef),
    };
  }
}
