import type { FastifyReply } from 'fastify';

/**
 * Server-Sent Events helper. Usage:
 *   const sse = startSse(reply);
 *   sse.send('delta', { text: '...' });
 *   sse.close();
 */
export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  closed: boolean;
}

export function startSse(reply: FastifyReply): SseStream {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();
  let closed = false;
  reply.raw.on('close', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    send(event: string, data: unknown) {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      reply.raw.end();
    },
  };
}
