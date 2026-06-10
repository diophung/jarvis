import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/**
 * Load .env files into process.env (real environment variables always win).
 * Checked locations: cwd (apps/server when run via pnpm --filter) and the
 * repo root two levels up.
 */
function loadDotEnv(): void {
  for (const candidate of [resolve('.env'), resolve('../../.env')]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = parseEnv(readFileSync(candidate, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined && typeof value === 'string') {
          process.env[key] = value;
        }
      }
    } catch {
      // Malformed .env files are ignored; explicit env still works.
    }
  }
}

/**
 * Environment-driven configuration. Every value has a safe local default so
 * Donna boots with zero env vars (demo mode). See .env.example.
 */
const EnvSchema = z.object({
  DONNA_PORT: z.coerce.number().int().positive().default(3001),
  DONNA_HOST: z.string().default('0.0.0.0'),
  DONNA_SECRET: z.string().min(1).default('donna-dev-secret-do-not-use-in-production'),
  DONNA_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().optional(),
  DONNA_DATA_DIR: z.string().default('./data'),
  DONNA_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  DONNA_S3_BUCKET: z.string().optional(),
  DONNA_S3_REGION: z.string().optional(),
  DONNA_S3_ENDPOINT: z.string().optional(),
  DONNA_AUTH_MODE: z.enum(['local', 'password']).default('local'),
  DONNA_OWNER_EMAIL: z.string().email().default('you@example.com'),
  DONNA_OWNER_NAME: z.string().default('Donna User'),
  DONNA_OWNER_PASSWORD: z.string().optional(),
  DONNA_DEMO_SEED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Set the Secure attribute on session cookies (enable when serving over HTTPS). */
  DONNA_COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Run the background worker in-process (docker-compose sets this to false on the API service). */
  DONNA_INLINE_WORKER: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  DONNA_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DONNA_PUBLIC_DIR: z.string().optional(),
  /** Public base URL of the API (OAuth redirect URIs are built from this). */
  DONNA_PUBLIC_URL: z.string().optional(),
  /** Allow self-service registration in password mode. */
  DONNA_ALLOW_SIGNUP: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Dedicated key for OAuth-token encryption at rest (falls back to DONNA_SECRET). */
  DONNA_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  // OAuth login + Google data-source authorization (all optional; features
  // light up in the UI only when the corresponding provider is configured)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_CLIENT_ID: z.string().optional(),
  FACEBOOK_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  /** PEM-encoded ES256 private key; \n-escaped newlines are unescaped at load. */
  APPLE_PRIVATE_KEY: z.string().optional(),
  // Optional LLM bootstrap (creates provider configs on first boot)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DONNA_LOCAL_LLM_BASE_URL: z.string().optional(),
  DONNA_LOCAL_LLM_MODEL: z.string().optional(),
  DONNA_LOCAL_LLM_API_KEY_ENV: z.string().optional(),
  DONNA_LOCAL_EMBEDDING_MODEL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env;
  isProdSecret: boolean;
  uploadsDir: string;
  sqlitePath: string;
  /** Public base URL of the API, no trailing slash (redirect URIs, links). */
  publicUrl: string;
  /** Key used to encrypt OAuth tokens at rest. */
  tokenEncryptionKey: string;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  loadDotEnv();
  const merged = { ...process.env, ...overrides };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.APPLE_PRIVATE_KEY) {
    env.APPLE_PRIVATE_KEY = env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  return {
    env,
    isProdSecret: env.DONNA_SECRET !== 'donna-dev-secret-do-not-use-in-production',
    uploadsDir: `${env.DONNA_DATA_DIR}/uploads`,
    sqlitePath: `${env.DONNA_DATA_DIR}/donna.db`,
    publicUrl: (env.DONNA_PUBLIC_URL ?? `http://localhost:${env.DONNA_PORT}`).replace(/\/$/, ''),
    tokenEncryptionKey: env.DONNA_TOKEN_ENCRYPTION_KEY ?? env.DONNA_SECRET,
  };
}
