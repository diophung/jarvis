import type { LearnedPreference, LearningSignal } from '@jarvis/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningPage } from '../LearningPage.js';
import { renderWithProviders, stubFetch } from './test-utils.js';

const NOW = new Date().toISOString();

const inferredPref: LearnedPreference = {
  id: 'lpr_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  category: 'communication_style',
  key: 'style.length',
  value: 'concise',
  statement: 'Tends to prefer concise messages when writing to leadership',
  scope: { audience: 'leadership' },
  origin: 'inferred',
  status: 'active',
  confidence: 0.62,
  evidenceCount: 6,
  evidenceWeight: 3,
  contradictionCount: 1,
  pinned: 0,
  decayHalfLifeDays: 90,
  lastReinforcedAt: NOW,
  explanation: 'Inferred from 6 repeated observations of your behavior.',
  sources: [],
  contradictions: [],
  userNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const explicitPref: LearnedPreference = {
  ...inferredPref,
  id: 'lpr_2',
  category: 'people',
  key: 'person.priority:jane@acme.com',
  value: 'high',
  statement: 'Treats jane@acme.com as a high-priority contact',
  scope: {},
  origin: 'explicit',
  confidence: 0.9,
};

const tentativePref: LearnedPreference = {
  ...inferredPref,
  id: 'lpr_3',
  category: 'topics',
  key: 'topic.priority:atlas',
  statement: 'Prioritizes items related to "atlas"',
  scope: {},
  confidence: 0.3,
};

const signal: LearningSignal = {
  id: 'sig_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  kind: 'writing_style',
  key: 'style.length',
  value: 'concise',
  strength: 0.5,
  scope: { audience: 'leadership' },
  detail: 'Wrote a concise message (42 words) to a leadership contact',
  source: { sourceType: 'source_item', refId: 'itm_1', observedAt: NOW },
  observedAt: NOW,
  processed: 1,
  createdAt: NOW,
};

function stubLearningRoutes() {
  return stubFetch([
    {
      match: '/api/learning/contradictions',
      reply: () => ({ contradictions: [] }),
    },
    {
      match: '/api/learning/preferences/lpr_1/explain',
      reply: () => ({ preference: inferredPref, recentSignals: [signal] }),
    },
    {
      method: 'POST',
      match: '/api/learning/preferences/lpr_1/correct',
      reply: () => ({ preference: { ...inferredPref, origin: 'explicit', confidence: 0.9 } }),
    },
    {
      method: 'POST',
      match: '/api/learning/run',
      reply: () => ({ signals: 3, created: 1, updated: 0 }),
    },
    {
      method: 'PUT',
      match: '/api/learning/settings',
      reply: () => ({ enabled: false }),
    },
    {
      method: 'POST',
      match: /\/api\/learning\/preferences$/,
      reply: () => ({ preference: explicitPref }),
    },
    {
      match: /\/api\/learning(\?.*)?$/,
      reply: () => ({
        preferences: [inferredPref, explicitPref, tentativePref],
        enabled: true,
        actionableConfidence: 0.45,
      }),
    },
  ]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LearningPage', () => {
  it('renders learned preferences with origin, confidence, scope, and tentative badges', async () => {
    stubLearningRoutes();
    renderWithProviders(<LearningPage />);

    expect(
      await screen.findByText('Tends to prefer concise messages when writing to leadership'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('inferred from behavior').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('you told Jarvis')).toBeInTheDocument();
    expect(screen.getByText('tentative — not used yet')).toBeInTheDocument();
    expect(screen.getByText('audience: leadership')).toBeInTheDocument();
    expect(screen.getByTitle('Confidence 62%')).toBeInTheDocument();
  });

  it('expands "why Jarvis thinks this" and shows the evidence trail', async () => {
    stubLearningRoutes();
    renderWithProviders(<LearningPage />);
    await screen.findByText('Tends to prefer concise messages when writing to leadership');

    fireEvent.click(screen.getAllByTitle('Show why Jarvis thinks this')[0]!);
    expect(
      await screen.findByText(/Wrote a concise message \(42 words\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/6 observations, 1 pointing the other way/)).toBeInTheDocument();
  });

  it('confirms an inferred preference via the correction endpoint', async () => {
    const { calls } = stubLearningRoutes();
    renderWithProviders(<LearningPage />);
    await screen.findByText('Tends to prefer concise messages when writing to leadership');

    fireEvent.click(screen.getAllByTitle('Confirm — yes, this is right')[0]!);
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/lpr_1/correct'));
      expect(post?.method).toBe('POST');
      expect(post?.body).toEqual({ action: 'confirm' });
    });
  });

  it('adds an explicit preference from the input form', async () => {
    const { calls } = stubLearningRoutes();
    renderWithProviders(<LearningPage />);
    await screen.findByText('Tends to prefer concise messages when writing to leadership');

    fireEvent.change(screen.getByPlaceholderText(/Tell Jarvis a preference/), {
      target: { value: 'keep summaries short' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) => /\/api\/learning\/preferences$/.test(c.url) && c.method === 'POST',
      );
      expect(post?.body).toEqual({ statement: 'keep summaries short' });
    });
  });

  it('triggers a manual learning run and toggles learning off', async () => {
    const { calls } = stubLearningRoutes();
    renderWithProviders(<LearningPage />);
    await screen.findByText('Tends to prefer concise messages when writing to leadership');

    fireEvent.click(screen.getByRole('button', { name: /Learn now/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/learning/run'))).toBe(true);
    });

    fireEvent.click(screen.getAllByRole('switch')[0]!);
    await waitFor(() => {
      const put = calls.find((c) => c.url.includes('/api/learning/settings'));
      expect(put?.method).toBe('PUT');
      expect(put?.body).toEqual({ enabled: false });
    });
  });
});
