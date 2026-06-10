import type { AuditLog } from '@donna/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from '../AuditPage.js';
import { renderWithProviders, stubFetch } from './test-utils.js';

const NOW = new Date().toISOString();

const approvalLog: AuditLog = {
  id: 'aud_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  eventType: 'approval.approved',
  actor: 'user',
  capability: 'email.send',
  targetType: 'approval_request',
  targetId: 'apr_1',
  summary: 'Approved: send email to Sam',
  metadata: { note: 'looks good' },
  createdAt: NOW,
};

const llmLog: AuditLog = {
  id: 'aud_2',
  workspaceId: 'ws_1',
  userId: null,
  eventType: 'llm.call',
  actor: 'agent',
  capability: null,
  targetType: null,
  targetId: null,
  summary: 'Chat completion (demo model)',
  metadata: { model: 'demo-small', latencyMs: 412 },
  createdAt: NOW,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuditPage', () => {
  it('renders audit rows with event type, summary, and actor', async () => {
    stubFetch([{ match: '/api/audit', reply: () => ({ items: [approvalLog, llmLog] }) }]);
    renderWithProviders(<AuditPage />);

    expect(await screen.findByText('Approved: send email to Sam')).toBeInTheDocument();
    expect(screen.getByText('Chat completion (demo model)')).toBeInTheDocument();
    // Event type appears in the row (and also as a filter option).
    expect(screen.getAllByText('approval.approved').length).toBeGreaterThan(0);
    expect(screen.getAllByText('agent').length).toBeGreaterThan(0);
    expect(screen.getByText('email.send')).toBeInTheDocument();
  });

  it('refetches with the actor filter in the query string', async () => {
    const { calls } = stubFetch([
      { match: '/api/audit', reply: () => ({ items: [approvalLog, llmLog] }) },
    ]);
    renderWithProviders(<AuditPage />);
    await screen.findByText('Approved: send email to Sam');

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1]!, { target: { value: 'agent' } });

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('actor=agent'))).toBe(true);
    });
  });

  it('expands a row to show pretty-printed metadata', async () => {
    stubFetch([{ match: '/api/audit', reply: () => ({ items: [approvalLog, llmLog] }) }]);
    renderWithProviders(<AuditPage />);

    fireEvent.click(await screen.findByText('Approved: send email to Sam'));
    expect(await screen.findByText(/"note": "looks good"/)).toBeInTheDocument();
  });
});
