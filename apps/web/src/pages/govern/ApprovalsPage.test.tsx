import type { AgentAction, ApprovalRequest } from '@jarvis/core';
import { CAPABILITY_CATALOG } from '@jarvis/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsPage } from '../ApprovalsPage.js';
import { renderWithProviders, stubFetch } from './test-utils.js';

const NOW = new Date().toISOString();
const TOMORROW = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

const approval: ApprovalRequest = {
  id: 'apr_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  agentActionId: 'act_1',
  capability: 'email.send',
  actionType: 'email.send',
  targetProvider: 'gmail',
  targetAccountId: 'acc_1',
  targetRef: { to: 'sam@example.com' },
  riskLevel: 'high',
  reason: 'You asked Jarvis to reply to Sam about the Q3 deck.',
  preview: {
    summary: 'Reply to Sam about the Q3 deck',
    body: 'Hi Sam,\n\nThe updated deck is attached.\n\nBest,\nCuong',
    fields: { To: 'sam@example.com', Subject: 'Re: Q3 deck' },
  },
  status: 'pending',
  requestedAt: NOW,
  decidedAt: null,
  decisionNote: null,
  conversationId: null,
  expiresAt: TOMORROW,
  createdAt: NOW,
  updatedAt: NOW,
};

const executedAction: AgentAction = {
  id: 'act_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  conversationId: null,
  messageId: null,
  capability: 'email.send',
  actionType: 'email.send',
  params: {},
  target: { provider: 'gmail', accountId: 'acc_1' },
  status: 'executed',
  riskLevel: 'high',
  policyId: null,
  approvalRequestId: 'apr_1',
  result: { detail: 'Email sent to sam@example.com', externalRef: 'msg_123' },
  error: null,
  executedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApprovalsPage', () => {
  it('renders pending approvals with plain-language label, risk, reason, and preview', async () => {
    stubFetch([
      { match: '/api/policies/catalog', reply: () => ({ items: CAPABILITY_CATALOG }) },
      { match: '/api/approvals?status=pending', reply: () => ({ items: [approval] }) },
    ]);
    renderWithProviders(<ApprovalsPage />);

    // Plain-language label from the catalog, not the raw capability id.
    expect(await screen.findByText('Send emails')).toBeInTheDocument();
    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByText(/You asked Jarvis to reply to Sam/)).toBeInTheDocument();
    expect(screen.getByText('Reply to Sam about the Q3 deck')).toBeInTheDocument();
    expect(screen.getByText(/The updated deck is attached/)).toBeInTheDocument();
    expect(screen.getByText('Re: Q3 deck')).toBeInTheDocument();
  });

  it('approves with alwaysAllow and shows the executed result inline', async () => {
    let decided = false;
    const { calls } = stubFetch([
      { match: '/api/policies/catalog', reply: () => ({ items: CAPABILITY_CATALOG }) },
      {
        match: '/api/approvals?status=pending',
        reply: () => ({ items: decided ? [] : [approval] }),
      },
      {
        method: 'POST',
        match: '/api/approvals/apr_1/decide',
        reply: () => {
          decided = true;
          return {
            approval: { ...approval, status: 'approved', decidedAt: NOW },
            action: executedAction,
          };
        },
      },
    ]);
    renderWithProviders(<ApprovalsPage />);

    await screen.findByText('Send emails');
    fireEvent.click(screen.getByLabelText('Always allow this'));
    expect(screen.getByText(/will run without asking/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(/Done — Email sent to sam@example\.com/),
    ).toBeInTheDocument();

    const decideCall = calls.find((c) => c.url.includes('/api/approvals/apr_1/decide'));
    expect(decideCall?.method).toBe('POST');
    expect(decideCall?.body).toMatchObject({ decision: 'approve', alwaysAllow: true });
  });

  it('shows the trust-center empty state when nothing is pending', async () => {
    stubFetch([
      { match: '/api/policies/catalog', reply: () => ({ items: CAPABILITY_CATALOG }) },
      { match: '/api/approvals?status=pending', reply: () => ({ items: [] }) },
    ]);
    renderWithProviders(<ApprovalsPage />);

    expect(await screen.findByText('Nothing waiting on you.')).toBeInTheDocument();
    expect(screen.getByText('Jarvis asks before any external action.')).toBeInTheDocument();
  });
});
