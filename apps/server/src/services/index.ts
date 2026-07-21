import type { ConnectorRegistry } from '@donna/connectors';
import type { Db } from '@donna/db';
import type { AppConfig } from '../config.js';
import type { Services } from '../context.js';
import { createActionsService } from './actions.js';
import { createAssistantService } from './assistant.js';
import { createAuditService } from './audit.js';
import { createCacheService } from './cache.js';
import { createTokensService } from './tokens.js';
import { createDigestService } from './digest.js';
import { createFeedbackService } from './feedback.js';
import { createIdempotencyService } from './idempotency.js';
import { createIndexingService } from './indexing.js';
import { createIngestionService } from './ingestion.js';
import { createLearningService } from './learning.js';
import { createLlmRouterService } from './llm-router.js';
import { createMemoryService } from './memory.js';
import { createPersonalizationService } from './personalization.js';
import { createPrivacyService } from './privacy.js';
import { createRetrievalService } from './retrieval.js';
import { createScoringService } from './scoring.js';
import { createSecretsService } from './secrets.js';
import { createSettingsService } from './settings.js';
import { createStorageService } from './storage.js';
import { createUploadsService } from './uploads.js';
import { createVectorStore } from './vector-store.js';

/**
 * Wire the full service container in dependency order. Async because the
 * vector store feature-detects its backend (pgvector vs SQL scan) at boot.
 */
export async function buildServices(deps: {
  db: Db;
  config: AppConfig;
  connectors: ConnectorRegistry;
}): Promise<Services> {
  const { db, config, connectors } = deps;

  const audit = createAuditService({ db });
  const tokens = createTokensService({ db, config, audit });
  const cacheOpts: Parameters<typeof createCacheService>[0] = {};
  if (config.env.DONNA_REDIS_URL !== undefined) cacheOpts.redisUrl = config.env.DONNA_REDIS_URL;
  const cache = createCacheService(cacheOpts);
  const settings = createSettingsService({ db, cache });
  const secrets = createSecretsService({ appSecret: config.env.DONNA_SECRET });
  const idempotency = createIdempotencyService({ db });
  const vectors = await createVectorStore({ db });
  const llm = createLlmRouterService({ db, secrets, audit, config });
  const indexing = createIndexingService({ db, llm, vectors });
  const retrieval = createRetrievalService({ db, llm, vectors });
  const storage = createStorageService({ config });
  const privacy = createPrivacyService({ db, audit, storage, vectors });
  const ingestion = createIngestionService({ db, connectors, secrets, audit, settings, indexing, tokens });
  const uploads = createUploadsService({ db, storage, indexing, audit });
  const scoring = createScoringService({ db, llm, audit });
  const learning = createLearningService({ db, settings, audit, cache });
  const personalization = createPersonalizationService({ db, learning });
  const digest = createDigestService({ db, llm, scoring, audit, settings, personalization });
  const feedback = createFeedbackService({ db, audit, learning });
  const memory = createMemoryService({ db, settings, audit });
  const actions = createActionsService({ db, connectors, secrets, audit, memory, tokens });
  const assistant = createAssistantService({
    db,
    llm,
    retrieval,
    memory,
    actions,
    settings,
    audit,
    learning,
    personalization,
  });

  return {
    tokens,
    audit,
    settings,
    secrets,
    cache,
    idempotency,
    vectors,
    privacy,
    llm,
    ingestion,
    indexing,
    retrieval,
    scoring,
    digest,
    actions,
    memory,
    feedback,
    learning,
    personalization,
    assistant,
    storage,
    uploads,
  };
}
