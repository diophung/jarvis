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
 * Jarvis boots with zero env vars (demo mode). See .env.example.
 */
const EnvSchema = z.object({
  JARVIS_PORT: z.coerce.number().int().positive().default(3001),
  JARVIS_HOST: z.string().default('0.0.0.0'),
  JARVIS_SECRET: z.string().min(1).default('jarvis-dev-secret-do-not-use-in-production'),
  JARVIS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().optional(),
  /** Max Postgres pool connections per process (replicas × size must stay under the server's max_connections). */
  JARVIS_DB_POOL_SIZE: z.coerce.number().int().positive().max(200).default(10),
  /** Fail a connection attempt after this long (ms). */
  JARVIS_DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** Recycle idle pooled connections after this long (ms). */
  JARVIS_DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Server-side statement timeout — no query may run longer (ms). */
  JARVIS_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Queries at/above this duration are logged as slow (ms). */
  JARVIS_DB_SLOW_QUERY_MS: z.coerce.number().int().positive().default(250),
  /** redis:// URL enables the shared cache; unset = per-process in-memory cache. */
  JARVIS_REDIS_URL: z.string().optional(),
  /** Default cache TTL for hot reads (seconds). Cache is disposable — never truth. */
  JARVIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  JARVIS_DATA_DIR: z.string().default('./data'),
  JARVIS_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  JARVIS_S3_BUCKET: z.string().optional(),
  JARVIS_S3_REGION: z.string().optional(),
  JARVIS_S3_ENDPOINT: z.string().optional(),
  JARVIS_AUTH_MODE: z.enum(['local', 'password']).default('local'),
  JARVIS_OWNER_EMAIL: z.string().email().default('you@example.com'),
  JARVIS_OWNER_NAME: z.string().default('Jarvis User'),
  JARVIS_OWNER_PASSWORD: z.string().optional(),
  JARVIS_DEMO_SEED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Set the Secure attribute on session cookies (enable when serving over HTTPS). */
  JARVIS_COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Trust X-Forwarded-* headers — set true behind a reverse proxy so
   * request.ip (and thus login rate limiting) sees real client IPs. */
  JARVIS_TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Run the background worker in-process (docker-compose sets this to false on the API service). */
  JARVIS_INLINE_WORKER: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  JARVIS_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  JARVIS_PUBLIC_DIR: z.string().optional(),
  /** Public base URL of the API (OAuth redirect URIs are built from this). */
  JARVIS_PUBLIC_URL: z.string().optional(),
  /** Allow self-service registration in password mode. */
  JARVIS_ALLOW_SIGNUP: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Dedicated key for OAuth-token encryption at rest (falls back to JARVIS_SECRET). */
  JARVIS_TOKEN_ENCRYPTION_KEY: z.string().optional(),
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
  JARVIS_LOCAL_LLM_BASE_URL: z.string().optional(),
  JARVIS_LOCAL_LLM_MODEL: z.string().optional(),
  JARVIS_LOCAL_LLM_API_KEY_ENV: z.string().optional(),
  JARVIS_LOCAL_EMBEDDING_MODEL: z.string().optional(),
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
    isProdSecret: env.JARVIS_SECRET !== 'jarvis-dev-secret-do-not-use-in-production',
    uploadsDir: `${env.JARVIS_DATA_DIR}/uploads`,
    sqlitePath: `${env.JARVIS_DATA_DIR}/jarvis.db`,
    publicUrl: (env.JARVIS_PUBLIC_URL ?? `http://localhost:${env.JARVIS_PORT}`).replace(/\/$/, ''),
    tokenEncryptionKey: env.JARVIS_TOKEN_ENCRYPTION_KEY ?? env.JARVIS_SECRET,
  };
}
