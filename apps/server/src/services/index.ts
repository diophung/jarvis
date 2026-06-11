import type { ConnectorRegistry } from '@donna/connectors';
import type { Db } from '@donna/db';
import type { AppConfig } from '../config.js';
import type { Services } from '../context.js';
import { createActionsService } from './actions.js';
import { createAssistantService } from './assistant.js';
import { createAuditService } from './audit.js';
import { createTokensService } from './tokens.js';
import { createDigestService } from './digest.js';
import { createFeedbackService } from './feedback.js';
import { createIndexingService } from './indexing.js';
import { createIngestionService } from './ingestion.js';
import { createLlmRouterService } from './llm-router.js';
import { createMemoryService } from './memory.js';
import { createRetrievalService } from './retrieval.js';
import { createScoringService } from './scoring.js';
import { createSecretsService } from './secrets.js';
import { createSettingsService } from './settings.js';
import { createStorageService } from './storage.js';
import { createUploadsService } from './uploads.js';

/** Wire the full service container in dependency order. */
export function buildServices(deps: {
  db: Db;
  config: AppConfig;
  connectors: ConnectorRegistry;
}): Services {
  const { db, config, connectors } = deps;

  const audit = createAuditService({ db });
  const tokens = createTokensService({ db, config, audit });
  const settings = createSettingsService({ db });
  const secrets = createSecretsService({ appSecret: config.env.DONNA_SECRET });
  const llm = createLlmRouterService({ db, secrets, audit, config });
  const indexing = createIndexingService({ db, llm });
  const retrieval = createRetrievalService({ db, llm });
  const storage = createStorageService({ config });
  const ingestion = createIngestionService({ db, connectors, secrets, audit, settings, indexing, tokens });
  const uploads = createUploadsService({ db, storage, indexing, audit });
  const scoring = createScoringService({ db, llm, audit });
  const digest = createDigestService({ db, llm, scoring, audit, settings });
  const feedback = createFeedbackService({ db, audit });
  const memory = createMemoryService({ db, settings, audit });
  const actions = createActionsService({ db, connectors, secrets, audit, memory, tokens });
  const assistant = createAssistantService({ db, llm, retrieval, memory, actions, settings, audit });

  return {
    tokens,
    audit,
    settings,
    secrets,
    llm,
    ingestion,
    indexing,
    retrieval,
    scoring,
    digest,
    actions,
    memory,
    feedback,
    assistant,
    storage,
    uploads,
  };
}
