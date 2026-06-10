import { z } from 'zod';

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
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const merged = { ...process.env, ...overrides };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  return {
    env,
    isProdSecret: env.DONNA_SECRET !== 'donna-dev-secret-do-not-use-in-production',
    uploadsDir: `${env.DONNA_DATA_DIR}/uploads`,
    sqlitePath: `${env.DONNA_DATA_DIR}/donna.db`,
  };
}
