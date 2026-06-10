/**
 * Connector registry: the single lookup point the server uses to resolve a
 * provider id (e.g. 'gmail', 'mock-email') to a Connector instance.
 *
 * Constructing connectors NEVER throws and NEVER touches the network —
 * credentials are resolved lazily at call time via ctx.secrets, so the
 * default registry is safe to build in any environment.
 */
import type { SourceCategory } from '@donna/core';
import type { Connector } from './types.js';
import { MockEmailConnector } from './mock/mock-email.js';
import { MockChatConnector } from './mock/mock-chat.js';
import { MockCalendarConnector } from './mock/mock-calendar.js';
import { MockStorageConnector } from './mock/mock-storage.js';
import { GoogleAuth } from './google/google-auth.js';
import { GmailConnector } from './google/gmail.js';
import { GoogleCalendarConnector } from './google/google-calendar.js';
import { GoogleDriveConnector } from './google/google-drive.js';
import { MicrosoftAuth } from './microsoft/ms-auth.js';
import { OutlookConnector } from './microsoft/outlook.js';
import { TeamsConnector } from './microsoft/teams.js';
import { OneDriveConnector } from './microsoft/onedrive.js';
import { SlackConnector } from './slack/slack.js';
import { S3Connector } from './aws/s3.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    const provider = connector.descriptor.provider;
    if (this.connectors.has(provider)) {
      throw new Error(`Connector already registered for provider '${provider}'`);
    }
    this.connectors.set(provider, connector);
  }

  get(provider: string): Connector | undefined {
    return this.connectors.get(provider);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  listByCategory(category: SourceCategory): Connector[] {
    return this.list().filter((c) => c.descriptor.category === category);
  }
}

/**
 * Build the default registry: one local mock connector per category (works
 * with zero credentials) plus the real provider hooks (env-driven).
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  // Local mock connectors — the zero-credential demo experience.
  registry.register(new MockEmailConnector());
  registry.register(new MockChatConnector());
  registry.register(new MockCalendarConnector());
  registry.register(new MockStorageConnector());

  // Google family shares one token cache.
  const googleAuth = new GoogleAuth();
  registry.register(new GmailConnector(googleAuth));
  registry.register(new GoogleCalendarConnector(googleAuth));
  registry.register(new GoogleDriveConnector(googleAuth));

  // Microsoft family shares one token cache.
  const msAuth = new MicrosoftAuth();
  registry.register(new OutlookConnector(msAuth));
  registry.register(new TeamsConnector(msAuth));
  registry.register(new OneDriveConnector(msAuth));

  registry.register(new SlackConnector());
  registry.register(new S3Connector());

  return registry;
}
