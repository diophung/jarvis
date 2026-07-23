import type { LlmTask, User, Workspace } from '@jarvis/core';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export interface MeResponse {
  user: User;
  workspace: Workspace;
  authMode: 'local' | 'password';
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/api/me'),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export interface LlmTaskStatus {
  providerConfigId: string | null;
  providerName: string;
  model: string;
  kind: string;
  isLocal: boolean;
}

export interface LlmStatusResponse {
  demoMode: boolean;
  tasks: Record<LlmTask, LlmTaskStatus | null>;
}

export function useLlmStatus() {
  return useQuery({
    queryKey: ['llm-status'],
    queryFn: () => api.get<LlmStatusResponse>('/api/llm/status'),
    staleTime: 60 * 1000,
  });
}

export function usePendingApprovalsCount() {
  return useQuery({
    queryKey: ['approvals', 'pending-count'],
    queryFn: async () => {
      const res = await api.get<{ items: unknown[] }>('/api/approvals?status=pending');
      return res.items.length;
    },
    refetchInterval: 30_000,
  });
}
