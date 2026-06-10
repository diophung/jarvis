import { describe, expect, it } from 'vitest';
import type { SourceCategory } from '@donna/core';
import { ConnectorRegistry, createDefaultRegistry } from './registry.js';
import { MockEmailConnector } from './mock/mock-email.js';

/** Connector-served categories ('upload' is handled by the server, not a connector). */
const CONNECTOR_CATEGORIES: SourceCategory[] = ['email', 'chat', 'calendar', 'storage'];

describe('ConnectorRegistry', () => {
  it('registers and looks up connectors by provider', () => {
    const registry = new ConnectorRegistry();
    const connector = new MockEmailConnector();
    registry.register(connector);
    expect(registry.get('mock-email')).toBe(connector);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list()).toEqual([connector]);
  });

  it('rejects duplicate provider registration', () => {
    const registry = new ConnectorRegistry();
    registry.register(new MockEmailConnector());
    expect(() => registry.register(new MockEmailConnector())).toThrow(/already registered/);
  });

  it('filters by category', () => {
    const registry = createDefaultRegistry();
    const emailProviders = registry.listByCategory('email').map((c) => c.descriptor.provider);
    expect(emailProviders).toContain('mock-email');
    expect(emailProviders).toContain('gmail');
    expect(emailProviders).toContain('outlook');
    expect(emailProviders).not.toContain('slack');
  });
});

describe('createDefaultRegistry', () => {
  const registry = createDefaultRegistry();

  it('registers every expected provider', () => {
    const providers = registry.list().map((c) => c.descriptor.provider);
    expect(providers.sort()).toEqual(
      [
        'gmail',
        'google-calendar',
        'google-drive',
        'mock-calendar',
        'mock-chat',
        'mock-email',
        'mock-storage',
        'onedrive',
        'outlook',
        's3',
        'slack',
        'teams',
      ].sort(),
    );
  });

  it('has one local mock connector per connector category', () => {
    for (const category of CONNECTOR_CATEGORIES) {
      const locals = registry.listByCategory(category).filter((c) => c.descriptor.local);
      expect(locals.length, `no local connector for ${category}`).toBeGreaterThanOrEqual(1);
      for (const local of locals) {
        expect(local.descriptor.requiredEnv).toEqual([]);
      }
    }
  });

  it('real connectors declare accurate env requirements and scopes', () => {
    const real = registry.list().filter((c) => !c.descriptor.local);
    expect(real.length).toBe(8);
    for (const connector of real) {
      expect(connector.descriptor.requiredEnv.length).toBeGreaterThan(0);
      expect(connector.descriptor.scopes.length).toBeGreaterThan(0);
    }
    expect(registry.get('gmail')?.descriptor.requiredEnv).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
    ]);
    expect(registry.get('slack')?.descriptor.requiredEnv).toEqual(['SLACK_BOT_TOKEN']);
    expect(registry.get('s3')?.descriptor.requiredEnv).toEqual([
      'DONNA_SOURCE_S3_BUCKET',
      'DONNA_SOURCE_S3_REGION',
    ]);
    expect(registry.get('outlook')?.descriptor.requiredEnv).toEqual([
      'MS_CLIENT_ID',
      'MS_CLIENT_SECRET',
      'MS_TENANT_ID',
      'MS_REFRESH_TOKEN',
    ]);
  });

  it('connectors with execute declare a write capability', () => {
    for (const connector of registry.list()) {
      if (connector.execute) {
        expect(
          connector.descriptor.capabilities.some((c) =>
            ['send', 'create', 'update', 'delete', 'upload', 'share', 'invite'].includes(c),
          ),
          `${connector.descriptor.provider} has execute() but no write capability`,
        ).toBe(true);
      }
    }
  });
});
