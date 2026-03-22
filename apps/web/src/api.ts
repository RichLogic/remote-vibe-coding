import type {
  AdminUserRecord,
  BootstrapPayload,
  CloudflareStatus,
  ConversationRecord,
  CreateWorkspaceRequest,
  CreateSessionRequest,
  CreateTurnRequest,
  CreateUserRequest,
  SessionAttachmentSummary,
  ResolveApprovalRequest,
  SessionDetailResponse,
  SessionRecord,
  SessionTranscriptPageResponse,
  UpdateSessionRequest,
  UpdateSessionPreferencesRequest,
  UpdateWorkspaceRequest,
  UpdateUserRequest,
  WorkspaceSummary,
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

export function fetchSessionTranscript(sessionId: string, options?: { limit?: number; before?: string | null }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.before) {
    params.set('before', options.before);
  }
  const suffix = params.toString();
  return requestJson<SessionTranscriptPageResponse>(`/api/sessions/${sessionId}/transcript${suffix ? `?${suffix}` : ''}`);
}

export async function createSession(input: CreateSessionRequest) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function forkSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}/fork`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function createWorkspace(input: CreateWorkspaceRequest) {
  return requestJson<{
    workspace: WorkspaceSummary;
    workspaceRoot: string;
    workspaces: WorkspaceSummary[];
  }>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(workspaceId: string, input: UpdateWorkspaceRequest) {
  return requestJson<{
    workspace: WorkspaceSummary;
    workspaceRoot: string;
    workspaces: WorkspaceSummary[];
  }>(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function restartSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord }>(`/api/sessions/${sessionId}/restart`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function archiveSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}/archive`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function restoreSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}/restore`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function updateSession(sessionId: string, input: UpdateSessionRequest) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function updateSessionPreferences(sessionId: string, input: UpdateSessionPreferencesRequest) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}/preferences`, {
    method: 'PATCH',
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

export async function uploadAttachment(sessionId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/attachments`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(errorBody?.error ?? `attachment upload failed with status ${response.status}`);
  }

  const payload = await response.json() as { attachment: SessionAttachmentSummary };
  return payload.attachment;
}

export async function deleteAttachment(sessionId: string, attachmentId: string) {
  return requestJson<{ ok: true }>(`/api/sessions/${sessionId}/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

export async function stopSession(sessionId: string) {
  const response = await requestJson<{ session: SessionRecord | ConversationRecord }>(`/api/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
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
