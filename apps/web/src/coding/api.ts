import type { SessionAttachmentSummary } from '../types';
import { resolveApiBaseUrl } from '../api-base-url';
import type {
  CodingBootstrapPayload,
  CodingWorkspaceDirectoryResponse,
  CodingWorkspaceFileResponse,
  CodingSessionDetailResponse,
  CodingSessionRecord,
  CodingSessionTranscriptPageResponse,
  CodingWorkspaceSummary,
  CreateCodingTurnResponse,
  CreateCodingWorkspaceRequest,
  CreateCodingWorkspaceSessionRequest,
  CreateCodingTurnRequest,
  ReorderCodingWorkspacesRequest,
  ResolveCodingApprovalRequest,
  UpdateCodingWorkspaceRequest,
  UpdateCodingSessionPreferencesRequest,
  UpdateCodingSessionRequest,
} from './types';

const API_BASE_URL = resolveApiBaseUrl();

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

export function fetchCodingSessionDetail(sessionId: string) {
  return requestJson<CodingSessionDetailResponse>(`/api/coding/sessions/${sessionId}`);
}

export function fetchCodingSessionTranscript(sessionId: string, options?: { limit?: number; before?: string | null }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.before) {
    params.set('before', options.before);
  }
  const suffix = params.toString();
  return requestJson<CodingSessionTranscriptPageResponse>(
    `/api/coding/sessions/${sessionId}/transcript${suffix ? `?${suffix}` : ''}`,
  );
}

export function fetchCodingBootstrap() {
  return requestJson<CodingBootstrapPayload>('/api/coding/bootstrap');
}

export function fetchCodingWorkspaceTree(workspaceId: string, path = '') {
  const params = new URLSearchParams();
  if (path) {
    params.set('path', path);
  }
  const suffix = params.toString();
  return requestJson<CodingWorkspaceDirectoryResponse>(
    `/api/coding/workspaces/${workspaceId}/tree${suffix ? `?${suffix}` : ''}`,
  );
}

export function fetchCodingWorkspaceFile(workspaceId: string, path: string) {
  const params = new URLSearchParams();
  params.set('path', path);
  return requestJson<CodingWorkspaceFileResponse>(`/api/coding/workspaces/${workspaceId}/file?${params.toString()}`);
}

export function codingWorkspaceFileContentHref(workspaceId: string, path: string, download = true) {
  const params = new URLSearchParams();
  params.set('path', path);
  if (download) {
    params.set('download', '1');
  }
  return `${API_BASE_URL}/api/coding/workspaces/${workspaceId}/file/content?${params.toString()}`;
}

export async function createCodingWorkspace(input: CreateCodingWorkspaceRequest) {
  return requestJson<{
    workspace: CodingWorkspaceSummary;
    workspaceRoot: string;
    workspaces: CodingWorkspaceSummary[];
  }>('/api/coding/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateCodingWorkspace(workspaceId: string, input: UpdateCodingWorkspaceRequest) {
  return requestJson<{
    workspace: CodingWorkspaceSummary;
    workspaceRoot: string;
    workspaces: CodingWorkspaceSummary[];
  }>(`/api/coding/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function reorderCodingWorkspaces(input: ReorderCodingWorkspacesRequest) {
  return requestJson<{
    workspaceRoot: string;
    workspaces: CodingWorkspaceSummary[];
  }>('/api/coding/workspaces/reorder', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createCodingWorkspaceSession(workspaceId: string, input: CreateCodingWorkspaceSessionRequest) {
  const response = await requestJson<{ session: CodingSessionRecord }>(`/api/coding/workspaces/${workspaceId}/sessions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function forkCodingSession(sessionId: string) {
  const response = await requestJson<{ session: CodingSessionRecord }>(`/api/coding/sessions/${sessionId}/fork`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function updateCodingSession(sessionId: string, input: UpdateCodingSessionRequest) {
  const response = await requestJson<{ session: CodingSessionRecord }>(`/api/coding/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function updateCodingSessionPreferences(
  sessionId: string,
  input: UpdateCodingSessionPreferencesRequest,
) {
  const response = await requestJson<{ session: CodingSessionRecord }>(`/api/coding/sessions/${sessionId}/preferences`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.session;
}

export async function deleteCodingSession(sessionId: string) {
  return requestJson<{ ok: true }>(`/api/coding/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

export async function startCodingTurn(sessionId: string, input: CreateCodingTurnRequest) {
  return requestJson<CreateCodingTurnResponse>(`/api/coding/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function uploadCodingAttachment(sessionId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/api/coding/sessions/${sessionId}/attachments`, {
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

export async function deleteCodingAttachment(sessionId: string, attachmentId: string) {
  return requestJson<{ ok: true }>(`/api/coding/sessions/${sessionId}/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

export async function deleteQueuedCodingTurn(sessionId: string, queuedTurnId: string) {
  return requestJson<{ ok: true }>(`/api/coding/sessions/${sessionId}/queued-turns/${queuedTurnId}`, {
    method: 'DELETE',
  });
}

export async function stopCodingSession(sessionId: string) {
  const response = await requestJson<{ session: CodingSessionRecord }>(`/api/coding/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: '{}',
  });
  return response.session;
}

export async function resolveCodingApproval(
  sessionId: string,
  approvalId: string,
  input: ResolveCodingApprovalRequest,
) {
  return requestJson(`/api/coding/sessions/${sessionId}/approvals/${approvalId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
