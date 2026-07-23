/**
 * Re-encrypt stored secrets after rotating the encryption keys.
 *
 * Usage:
 *   JARVIS_OLD_KEY=<previous key> pnpm --filter @jarvis/server exec tsx src/scripts/rotate-token-key.ts
 *
 * Re-encrypts:
 *  - oauth_tokens.access_token_encrypted / refresh_token_encrypted
 *    (old key -> current config.tokenEncryptionKey)
 *  - llm_provider_configs.api_key_encrypted
 *    (old key -> current JARVIS_SECRET)
 *
 * Rows whose ciphertext does not decrypt with JARVIS_OLD_KEY are skipped and
 * counted. Output is counts only — secret material is never printed.
 */
import { createDb } from '@jarvis/db';
import { loadConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

const oldKey = process.env.JARVIS_OLD_KEY;
if (!oldKey) {
  console.error('JARVIS_OLD_KEY is required (the key the stored secrets are currently encrypted with).');
  process.exit(1);
}

const config = loadConfig();
const db = createDb({ databaseUrl: config.env.DATABASE_URL, sqlitePath: config.sqlitePath });

interface RotationResult {
  rotated: number;
  skipped: number;
}

/** Re-encrypt one column set; a row is skipped whole when any value fails. */
function reencryptRow(
  values: Array<string | null>,
  newKey: string,
): { ok: true; reencrypted: Array<string | null> } | { ok: false } {
  const reencrypted: Array<string | null> = [];
  for (const value of values) {
    if (value === null) {
      reencrypted.push(null);
      continue;
    }
    const plain = decryptSecret(value, oldKey as string);
    if (plain === null) return { ok: false };
    reencrypted.push(encryptSecret(plain, newKey));
  }
  return { ok: true, reencrypted };
}

async function rotateOauthTokens(): Promise<RotationResult> {
  const result: RotationResult = { rotated: 0, skipped: 0 };
  const rows = await db
    .selectFrom('oauthTokens')
    .select(['id', 'accessTokenEncrypted', 'refreshTokenEncrypted'])
    .execute();
  for (const row of rows) {
    if (row.accessTokenEncrypted === null && row.refreshTokenEncrypted === null) continue;
    const out = reencryptRow(
      [row.accessTokenEncrypted, row.refreshTokenEncrypted],
      config.tokenEncryptionKey,
    );
    if (!out.ok) {
      result.skipped += 1;
      continue;
    }
    await db
      .updateTable('oauthTokens')
      .set({
        accessTokenEncrypted: out.reencrypted[0] ?? null,
        refreshTokenEncrypted: out.reencrypted[1] ?? null,
      })
      .where('id', '=', row.id)
      .execute();
    result.rotated += 1;
  }
  return result;
}

async function rotateLlmApiKeys(): Promise<RotationResult> {
  const result: RotationResult = { rotated: 0, skipped: 0 };
  const rows = await db
    .selectFrom('llmProviderConfigs')
    .select(['id', 'apiKeyEncrypted'])
    .where('apiKeyEncrypted', 'is not', null)
    .execute();
  for (const row of rows) {
    const out = reencryptRow([row.apiKeyEncrypted], config.env.JARVIS_SECRET);
    if (!out.ok) {
      result.skipped += 1;
      continue;
    }
    await db
      .updateTable('llmProviderConfigs')
      .set({ apiKeyEncrypted: out.reencrypted[0] ?? null })
      .where('id', '=', row.id)
      .execute();
    result.rotated += 1;
  }
  return result;
}

try {
  const oauth = await rotateOauthTokens();
  const llm = await rotateLlmApiKeys();
  console.log(`oauth_tokens: re-encrypted ${oauth.rotated} row(s), skipped ${oauth.skipped} undecryptable row(s)`);
  console.log(`llm_provider_configs: re-encrypted ${llm.rotated} row(s), skipped ${llm.skipped} undecryptable row(s)`);
  if (oauth.skipped > 0 || llm.skipped > 0) {
    console.log('Skipped rows were NOT modified — check that JARVIS_OLD_KEY matches the previous key.');
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
