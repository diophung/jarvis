import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets the user enters via the UI (e.g. LLM API
 * keys), encrypted at rest with a key derived from JARVIS_SECRET.
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`jarvis-keywrap:${secret}`).digest();
}

export function encryptSecret(plaintext: string, appSecret: string): string {
  const key = deriveKey(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(encrypted: string, appSecret: string): string | null {
  try {
    const [version, ivB64, tagB64, dataB64] = encrypted.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const key = deriveKey(appSecret);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

/** Mask a secret for display: keep first 3 + last 2 chars. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}
