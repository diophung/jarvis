/** Test helpers for the governance pages: provider wrapper + fetch stubbing. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

export function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

export interface FetchRoute {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  match: string | RegExp;
  reply: (url: string, init?: RequestInit) => unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stub global fetch with contract-shaped JSON routes. Unmatched GETs return
 * `{ items: [] }` so incidental queries resolve quietly.
 */
export function stubFetch(routes: FetchRoute[]): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    for (const route of routes) {
      const routeMethod = (route.method ?? 'GET').toUpperCase();
      if (routeMethod !== method) continue;
      const matched =
        typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (matched) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => route.reply(url, init),
        } as unknown as Response;
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [] }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return { calls };
}
