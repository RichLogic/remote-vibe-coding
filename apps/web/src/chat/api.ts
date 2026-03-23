import type { SessionAttachmentSummary } from '../types';
import type {
  ChatBootstrapPayload,
  ChatConversation,
  ChatConversationDetailResponse,
  ChatRolePresetListResponse,
  ChatTranscriptPageResponse,
  CreateChatRolePresetRequest,
  CreateChatConversationRequest,
  CreateChatMessageRequest,
  UpdateChatRolePresetRequest,
  UpdateChatConversationPreferencesRequest,
  UpdateChatConversationRequest,
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

export function fetchChatBootstrap() {
  return requestJson<ChatBootstrapPayload>('/api/chat/bootstrap');
}

export function fetchChatConversationDetail(conversationId: string) {
  return requestJson<ChatConversationDetailResponse>(`/api/chat/conversations/${conversationId}`);
}

export function fetchChatConversationTranscript(
  conversationId: string,
  options?: { limit?: number; before?: string | null },
) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.before) {
    params.set('before', options.before);
  }
  const suffix = params.toString();
  return requestJson<ChatTranscriptPageResponse>(
    `/api/chat/conversations/${conversationId}/transcript${suffix ? `?${suffix}` : ''}`,
  );
}

export async function createChatConversation(input: CreateChatConversationRequest = {}) {
  const response = await requestJson<{ conversation: ChatConversation }>('/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.conversation;
}

export async function updateChatConversation(conversationId: string, input: UpdateChatConversationRequest) {
  const response = await requestJson<{ conversation: ChatConversation }>(`/api/chat/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.conversation;
}

export async function updateChatConversationPreferences(
  conversationId: string,
  input: UpdateChatConversationPreferencesRequest,
) {
  const response = await requestJson<{ conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/preferences`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
  return response.conversation;
}

export async function archiveChatConversation(conversationId: string) {
  const response = await requestJson<{ conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/archive`,
    {
      method: 'POST',
      body: '{}',
    },
  );
  return response.conversation;
}

export async function restoreChatConversation(conversationId: string) {
  const response = await requestJson<{ conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/restore`,
    {
      method: 'POST',
      body: '{}',
    },
  );
  return response.conversation;
}

export async function forkChatConversation(conversationId: string) {
  const response = await requestJson<{ conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/fork`,
    {
      method: 'POST',
      body: '{}',
    },
  );
  return response.conversation;
}

export async function deleteChatConversation(conversationId: string) {
  return requestJson<{ ok: true }>(`/api/chat/conversations/${conversationId}`, {
    method: 'DELETE',
  });
}

export async function sendChatMessage(conversationId: string, input: CreateChatMessageRequest) {
  return requestJson<{ turn: unknown; conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export async function stopChatConversation(conversationId: string) {
  const response = await requestJson<{ conversation: ChatConversation }>(
    `/api/chat/conversations/${conversationId}/stop`,
    {
      method: 'POST',
      body: '{}',
    },
  );
  return response.conversation;
}

export async function uploadChatAttachment(conversationId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/api/chat/conversations/${conversationId}/attachments`, {
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

export async function deleteChatAttachment(conversationId: string, attachmentId: string) {
  return requestJson<{ ok: true }>(
    `/api/chat/conversations/${conversationId}/attachments/${attachmentId}`,
    {
      method: 'DELETE',
    },
  );
}

export function fetchChatRolePresets() {
  return requestJson<ChatRolePresetListResponse>('/api/admin/chat/role-presets');
}

export async function createChatRolePreset(input: CreateChatRolePresetRequest) {
  return requestJson<ChatRolePresetListResponse>('/api/admin/chat/role-presets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateChatRolePreset(presetId: string, input: UpdateChatRolePresetRequest) {
  return requestJson<ChatRolePresetListResponse>(`/api/admin/chat/role-presets/${presetId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteChatRolePreset(presetId: string) {
  return requestJson<ChatRolePresetListResponse>(`/api/admin/chat/role-presets/${presetId}`, {
    method: 'DELETE',
  });
}
