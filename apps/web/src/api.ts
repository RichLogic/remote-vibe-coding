import type {
  AdminUserRecord,
  BootstrapPayload,
  CloudflareStatus,
  CreateSessionRequest,
  CreateTurnRequest,
  CreateUserRequest,
  RenameSessionRequest,
  ResolveApprovalRequest,
  SessionDetailResponse,
  SessionRecord,
  UpdateUserRequest,
} from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers,
    ...init,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(errorBody?.error ?? `${path} failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchBootstrap() {
  return requestJson<BootstrapPayload>('/api/bootstrap');
}

export async function connectCloudflareTunnel() {
  const response = await requestJson<{ cloudflare: CloudflareStatus }>('/api/cloudflare/connect', {
    method: 'POST',
  });
  return response.cloudflare;
}

export async function disconnectCloudflareTunnel() {
  const response = await requestJson<{ cloudflare: CloudflareStatus }>('/api/cloudflare/disconnect', {
    method: 'POST',
  });
  return response.cloudflare;
}

export async function logout() {
  return requestJson<{ ok: true }>('/api/auth/logout', {
    method: 'POST',
  });
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

export async function restartSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord }>(`/api/sessions/${sessionId}/restart`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function archiveSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord }>(`/api/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
  return response.session;
}

export async function restoreSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord }>(`/api/sessions/${sessionId}/restore`, {
    method: 'POST',
  });
  return response.session;
}

export async function renameSession(sessionId: string, input: RenameSessionRequest) {
  const response = await requestJson<{ session: SessionRecord }>(`/api/sessions/${sessionId}/rename`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function deleteSession(sessionId: string) {
  return requestJson<{ ok: true }>(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  });
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

export async function fetchAdminUsers() {
  const response = await requestJson<{ users: AdminUserRecord[] }>('/api/admin/users');
  return response.users;
}

export async function createAdminUser(input: CreateUserRequest) {
  const response = await requestJson<{ user: AdminUserRecord; users: AdminUserRecord[] }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response;
}

export async function updateAdminUser(userId: string, input: UpdateUserRequest) {
  const response = await requestJson<{ user: AdminUserRecord; users: AdminUserRecord[] }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response;
}

export async function deleteAdminUser(userId: string) {
  const response = await requestJson<{ users: AdminUserRecord[] }>(`/api/admin/users/${userId}`, {
    method: 'DELETE',
  });
  return response.users;
}
