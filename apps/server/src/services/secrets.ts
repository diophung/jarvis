import type { SecretResolver } from '@jarvis/connectors';
import type { SecretsService } from '../context.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

export function createSecretsService(deps: { appSecret: string }): SecretsService {
  const { appSecret } = deps;
  const resolver: SecretResolver = {
    get(ref: string): string | undefined {
      return process.env[ref];
    },
  };
  return {
    env(ref: string): string | undefined {
      return process.env[ref];
    },
    decrypt(encrypted: string): string | null {
      return decryptSecret(encrypted, appSecret);
    },
    encrypt(plaintext: string): string {
      return encryptSecret(plaintext, appSecret);
    },
    connectorResolver(): SecretResolver {
      return resolver;
    },
  };
}
