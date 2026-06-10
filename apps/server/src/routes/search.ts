/**
 * Unified search route (contract: docs/api-contract.md "Search").
 * Deliberately not audited per-search to avoid log noise.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext, SearchResult } from '../context.js';
import { badRequest } from '../lib/http-errors.js';

const SOURCE_TYPES: readonly SearchResult['sourceType'][] = [
  'source_item',
  'uploaded_file',
  'message',
  'memory',
  'digest',
];

const QuerySchema = z.object({
  q: z.string().optional(),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parseTypes(csv: string | undefined): SearchResult['sourceType'][] | undefined {
  if (csv === undefined) return undefined;
  const valid = csv
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is SearchResult['sourceType'] =>
      (SOURCE_TYPES as readonly string[]).includes(t),
    );
  return valid.length > 0 ? valid : undefined;
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/search', async (request) => {
    const query = QuerySchema.parse(request.query);
    const q = query.q?.trim() ?? '';
    if (q === '') throw badRequest('query parameter "q" is required');
    return ctx.services.retrieval.search(request.workspaceId, q, {
      limit: query.limit,
      sourceTypes: parseTypes(query.types),
    });
  });
}
