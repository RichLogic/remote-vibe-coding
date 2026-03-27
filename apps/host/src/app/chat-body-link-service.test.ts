import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChatBodyLinkServiceError,
  createChatBodyLinkService,
} from './chat-body-link-service.js';
import type { ConversationRecord, SessionAttachmentRecord } from '../types.js';

function buildConversation(workspace: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    ownerUserId: 'user-1',
    ownerUsername: 'owner',
    sessionType: 'chat',
    executor: 'codex',
    threadId: 'thread-1',
    activeTurnId: null,
    title: 'Chat',
    autoTitle: false,
    workspace,
    archivedAt: null,
    securityProfile: 'repo-write',
    approvalMode: 'detailed',
    networkEnabled: true,
    fullHostEnabled: false,
    status: 'idle',
    lastIssue: null,
    hasTranscript: true,
    model: 'gpt-5',
    reasoningEffort: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rolePresetId: null,
    recoveryState: 'ready',
    retryable: false,
    ...overrides,
  };
}

function createServiceHarness() {
  const attachments = new Map<string, SessionAttachmentRecord>();
  const service = createChatBodyLinkService({
    getAttachment: (_conversationId, attachmentId) => attachments.get(attachmentId) ?? null,
    addAttachment: async (attachment) => {
      attachments.set(attachment.id, attachment);
    },
    attachmentKindFromUpload: (filename, mimeType) => {
      if (mimeType.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
        return 'pdf';
      }
      if (mimeType.startsWith('image/')) {
        return 'image';
      }
      return 'file';
    },
    sanitizeAttachmentFilename: (filename, fallbackBase) => filename.trim() || fallbackBase,
    extractAttachmentText: async (kind, _filename, mimeType, buffer) => {
      if (kind === 'image' || kind === 'pdf') {
        return null;
      }
      return mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('markdown')
        ? buffer.toString('utf8')
        : null;
    },
  });
  return {
    attachments,
    service,
  };
}

test('chat body link service reuses existing chat attachment links', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rvc-chat-link-'));
  const { attachments, service } = createServiceHarness();
  const conversation = buildConversation(workspace);

  const storagePath = join(workspace, '.rvc-chat', 'attachments', 'existing.txt');
  await mkdir(join(workspace, '.rvc-chat', 'attachments'), { recursive: true });
  await writeFile(storagePath, 'hello');
  const attachment: SessionAttachmentRecord = {
    id: 'attachment-1',
    ownerKind: 'conversation',
    ownerId: conversation.id,
    sessionId: conversation.id,
    ownerUserId: conversation.ownerUserId,
    ownerUsername: conversation.ownerUsername,
    kind: 'file',
    filename: 'existing.txt',
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: 5,
    storagePath,
    extractedText: 'hello',
    consumedAt: conversation.createdAt,
    createdAt: conversation.createdAt,
  };
  attachments.set(attachment.id, attachment);

  const result = await service.resolveLink(
    conversation,
    `/api/chat/conversations/${conversation.id}/attachments/${attachment.id}/content`,
  );

  assert.equal(result.kind, 'attachment');
  if (result.kind !== 'attachment') return;
  assert.equal(result.attachment.id, attachment.id);
});

test('chat body link service materializes local files into conversation attachments', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rvc-chat-link-'));
  const { service } = createServiceHarness();
  const conversation = buildConversation(workspace);
  const localFile = join(workspace, 'notes', 'report.md');
  await mkdir(join(workspace, 'notes'), { recursive: true });
  await writeFile(localFile, '# report\n');

  const result = await service.resolveLink(conversation, './notes/report.md');

  assert.equal(result.kind, 'attachment');
  if (result.kind !== 'attachment') return;
  assert.equal(result.attachment.filename, 'report.md');
  assert.equal(await readFile(result.attachment.storagePath, 'utf8'), '# report\n');
});

test('chat body link service opens remote html pages externally', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rvc-chat-link-'));
  const attachments = new Map<string, SessionAttachmentRecord>();
  const service = createChatBodyLinkService({
    getAttachment: (_conversationId, attachmentId) => attachments.get(attachmentId) ?? null,
    addAttachment: async (attachment) => {
      attachments.set(attachment.id, attachment);
    },
    attachmentKindFromUpload: () => 'file',
    sanitizeAttachmentFilename: (filename, fallbackBase) => filename.trim() || fallbackBase,
    extractAttachmentText: async () => null,
    fetchImpl: async () => new Response('<html></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    }),
  });
  const conversation = buildConversation(workspace);

  const result = await service.resolveLink(conversation, 'https://example.com/docs');

  assert.deepEqual(result, {
    kind: 'external',
    href: 'https://example.com/docs',
  });
});

test('chat body link service rejects remote fetches when chat network is disabled', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rvc-chat-link-'));
  const { service } = createServiceHarness();
  const conversation = buildConversation(workspace, {
    networkEnabled: false,
  });

  await assert.rejects(
    service.resolveLink(conversation, 'https://example.com/report.csv'),
    (error: unknown) => (
      error instanceof ChatBodyLinkServiceError
      && error.statusCode === 409
      && error.message === 'Enable network access for this chat before fetching remote files.'
    ),
  );
});
