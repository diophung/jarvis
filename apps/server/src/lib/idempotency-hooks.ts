/**
 * Fastify integration for idempotent writes. Routes opt in with
 * `config: { idempotent: true }`; clients activate protection by sending an
 * `Idempotency-Key` header (without it, behavior is unchanged).
 *
 * preHandler: classify the key — replay a stored response, 409 conflicting
 * reuse, or record in_progress and let the handler run.
 * onSend: persist successful/deterministic responses (<500) for replay;
 * release the key on 5xx so the client can safely retry.
 */
import type { FastifyInstance } from 'fastify';
import type { IdempotencyService } from '../context.js';
import { hashRequestBody } from '../services/idempotency.js';

const MAX_KEY_LENGTH = 200;

interface PendingIdempotency {
  complete(responseStatus: number, responseBody: unknown): Promise<void>;
  abandon(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyPending?: PendingIdempotency;
  }
}

export function registerIdempotencyHooks(
  app: FastifyInstance,
  idempotency: IdempotencyService,
): void {
  app.addHook('preHandler', async (request, reply) => {
    const config = request.routeOptions.config as { idempotent?: boolean } | undefined;
    if (config?.idempotent !== true) return;
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key === undefined || key === '') return;
    if (key.length > MAX_KEY_LENGTH) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Idempotency-Key is too long' } });
    }
    if (request.workspaceId === '' || request.userId === '') return; // unauthenticated: auth hook rejects

    const endpoint = `${request.method} ${request.routeOptions.url ?? request.url}`;
    const begin = await idempotency.begin(
      request.workspaceId,
      request.userId,
      endpoint,
      key,
      hashRequestBody(request.body),
    );
    switch (begin.kind) {
      case 'replay':
        return reply
          .header('idempotency-replayed', 'true')
          .code(begin.responseStatus)
          .type('application/json')
          .send(begin.responseBody ?? 'null');
      case 'key_reuse_conflict':
        return reply.code(409).send({
          error: {
            code: 'idempotency_key_reuse',
            message: 'This Idempotency-Key was already used with a different request body',
          },
        });
      case 'in_flight_conflict':
        return reply.code(409).send({
          error: {
            code: 'idempotency_in_flight',
            message: 'A request with this Idempotency-Key is still being processed — retry shortly',
          },
        });
      case 'proceed':
        request.idempotencyPending = begin;
        return;
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const pending = request.idempotencyPending;
    if (pending === undefined) return payload;
    delete request.idempotencyPending;
    try {
      if (reply.statusCode >= 500) {
        // Server-side failure: free the key so the client's retry executes.
        await pending.abandon();
      } else {
        await pending.complete(reply.statusCode, typeof payload === 'string' ? payload : null);
      }
    } catch (err) {
      // Bookkeeping must never break the response itself.
      request.log.error({ err }, 'idempotency bookkeeping failed');
    }
    return payload;
  });
}
