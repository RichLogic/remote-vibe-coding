import type {
  BootstrapPayload,
  CreateSessionRequest,
  ResolveApprovalRequest,
  SessionDetailResponse,
  SessionRecord,
  CreateTurnRequest,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`${path} failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchBootstrap() {
  return requestJson<BootstrapPayload>('/api/bootstrap');
}

export function fetchSessionDetail(sessionId: string) {
  return requestJson<SessionDetailResponse>(`/api/sessions/${sessionId}`);
}

export async function createSession(input: CreateSessionRequest) {
  const response = await requestJson<{ session: SessionRecord }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function startTurn(sessionId: string, input: CreateTurnRequest) {
  return requestJson(`/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function resolveApproval(
  sessionId: string,
  approvalId: string,
  input: ResolveApprovalRequest,
) {
  return requestJson(`/api/sessions/${sessionId}/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
