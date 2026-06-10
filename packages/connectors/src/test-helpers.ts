/**
 * Shared helpers for connector tests (not exported from the package index).
 */
import type { ConnectorContext, ConnectorLogger, SecretResolver } from './types.js';

export function makeSecretResolver(values: Record<string, string> = {}): SecretResolver {
  return { get: (ref: string) => values[ref] };
}

export const silentLogger: ConnectorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function makeCtx(
  overrides: Partial<ConnectorContext> & { secretValues?: Record<string, string> } = {},
): ConnectorContext {
  const { secretValues, ...rest } = overrides;
  return {
    accountId: 'acct-test',
    workspaceId: 'ws-test',
    settings: {},
    secrets: makeSecretResolver(secretValues ?? {}),
    logger: silentLogger,
    ...rest,
  };
}
