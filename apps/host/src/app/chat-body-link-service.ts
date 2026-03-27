import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ConversationRecord,
  SessionAttachmentKind,
  SessionAttachmentRecord,
} from '../types.js';

const MAX_CHAT_BODY_LINK_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_URL_PATTERN = /^\/api\/chat\/conversations\/([^/]+)\/attachments\/([^/]+)\/content$/;
const HTML_FILE_EXTENSIONS = new Set(['.htm', '.html']);

export class ChatBodyLinkServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ChatBodyLinkServiceError';
    this.statusCode = statusCode;
  }
}

export type ChatBodyLinkResolution =
  | { kind: 'attachment'; attachment: SessionAttachmentRecord }
  | { kind: 'external'; href: string };

interface CreateChatBodyLinkServiceOptions {
  getAttachment: (conversationId: string, attachmentId: string) => SessionAttachmentRecord | null;
  addAttachment: (attachment: SessionAttachmentRecord) => Promise<void>;
  attachmentKindFromUpload: (filename: string, mimeType: string) => SessionAttachmentKind;
  sanitizeAttachmentFilename: (filename: string, fallbackBase: string) => string;
  extractAttachmentText: (
    kind: SessionAttachmentKind,
    filename: string,
    mimeType: string,
    buffer: Buffer,
  ) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

function isPathInsideRoot(rootPath: string, targetPath: string) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);
}

async function maybeRealpath(path: string) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function splitHrefPath(href: string) {
  return href.split(/[?#]/, 1)[0] ?? href;
}

function decodeHrefPath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function attachmentRouteMatch(href: string) {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  const rawPath = (() => {
    if (trimmed.startsWith('/')) {
      return splitHrefPath(trimmed);
    }
    try {
      return new URL(trimmed).pathname;
    } catch {
      return null;
    }
  })();

  if (!rawPath) {
    return null;
  }
  const match = rawPath.match(ATTACHMENT_URL_PATTERN);
  if (!match) {
    return null;
  }
  return {
    conversationId: match[1] ?? '',
    attachmentId: match[2] ?? '',
  };
}

function fallbackExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('markdown')) return '.md';
  if (normalized.includes('json')) return '.json';
  if (normalized.includes('csv')) return '.csv';
  if (normalized.includes('html')) return '.html';
  if (normalized.includes('xml')) return '.xml';
  if (normalized.includes('yaml')) return '.yaml';
  if (normalized.includes('pdf')) return '.pdf';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.startsWith('text/')) return '.txt';
  return '.bin';
}

function fallbackFilenameForMimeType(mimeType: string) {
  return `linked-file${fallbackExtensionFromMimeType(mimeType)}`;
}

function inferMimeTypeFromFilename(filename: string) {
  switch (extname(filename).toLowerCase()) {
    case '.c':
    case '.cc':
    case '.cpp':
    case '.css':
    case '.go':
    case '.graphql':
    case '.h':
    case '.html':
    case '.java':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.py':
    case '.rb':
    case '.rs':
    case '.sh':
    case '.sql':
    case '.ts':
    case '.tsx':
    case '.txt':
    case '.vue':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.yaml':
    case '.yml':
      return 'application/yaml; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.toml':
      return 'application/toml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function parseContentDispositionFilename(contentDisposition: string | null) {
  if (!contentDisposition) {
    return null;
  }

  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch?.[1]) {
    const rawValue = encodedMatch[1].trim().replace(/^UTF-8''/i, '').replace(/^"(.*)"$/, '$1');
    return decodeHrefPath(rawValue);
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (!plainMatch?.[1]) {
    return null;
  }
  return plainMatch[1].trim().replace(/^"(.*)"$/, '$1');
}

function stableAttachmentId(source: string) {
  return `chat-link-${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

async function ensureExistingAttachmentReadable(attachment: SessionAttachmentRecord | null) {
  if (!attachment) {
    return null;
  }

  try {
    const info = await stat(attachment.storagePath);
    return info.isFile() ? attachment : null;
  } catch {
    return null;
  }
}

function normalizeRelativeConversationPath(rawHref: string) {
  const normalized = decodeHrefPath(splitHrefPath(rawHref.trim()).replace(/\\/g, '/'));
  if (!normalized || normalized.startsWith('/')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return null;
  }
  if (normalized.startsWith('#')) {
    return null;
  }
  return normalized;
}

async function resolveLocalFileCandidate(conversation: ConversationRecord, href: string) {
  const trimmed = href.trim();
  if (!trimmed) {
    throw new ChatBodyLinkServiceError('Link is empty.', 400);
  }

  if (/^file:/i.test(trimmed)) {
    const filePath = fileURLToPath(trimmed);
    return {
      source: `file:${filePath}`,
      targetPath: await realpath(filePath).catch(() => {
        throw new ChatBodyLinkServiceError('Linked file was not found.', 404);
      }),
    };
  }

  const rawPath = decodeHrefPath(splitHrefPath(trimmed));
  if (rawPath && isAbsolute(rawPath) && !rawPath.startsWith('/api/')) {
    return {
      source: `local:${rawPath}`,
      targetPath: await realpath(rawPath).catch(() => {
        throw new ChatBodyLinkServiceError('Linked file was not found.', 404);
      }),
    };
  }

  const relativePath = normalizeRelativeConversationPath(trimmed);
  if (!relativePath) {
    return null;
  }
  if (relativePath.split('/').some((segment) => segment === '..')) {
    throw new ChatBodyLinkServiceError('Relative chat file links must stay inside the chat workspace.', 400);
  }

  const targetPath = await realpath(resolve(conversation.workspace, relativePath)).catch(() => {
    throw new ChatBodyLinkServiceError('Linked file was not found.', 404);
  });
  return {
    source: `workspace:${relativePath}`,
    targetPath,
  };
}

async function assertAllowedLocalFilePath(conversation: ConversationRecord, targetPath: string) {
  const resolvedWorkspace = await maybeRealpath(conversation.workspace);
  const allowedRoots = [
    await maybeRealpath(homedir()),
    await maybeRealpath(tmpdir()),
    resolvedWorkspace,
  ].filter((entry): entry is string => Boolean(entry));

  if (!allowedRoots.some((rootPath) => isPathInsideRoot(rootPath, targetPath))) {
    throw new ChatBodyLinkServiceError('Linked local file must stay inside your home, temp, or chat workspace folders.', 400);
  }

  const info = await stat(targetPath).catch(() => {
    throw new ChatBodyLinkServiceError('Linked file was not found.', 404);
  });
  if (!info.isFile()) {
    throw new ChatBodyLinkServiceError('Linked path is not a file.', 400);
  }
  if (info.size > MAX_CHAT_BODY_LINK_BYTES) {
    throw new ChatBodyLinkServiceError('Linked files larger than 20 MB are not supported.', 413);
  }
  return info;
}

async function readResponseBuffer(response: Response) {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_CHAT_BODY_LINK_BYTES) {
    throw new ChatBodyLinkServiceError('Linked files larger than 20 MB are not supported.', 413);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_CHAT_BODY_LINK_BYTES) {
      await reader.cancel();
      throw new ChatBodyLinkServiceError('Linked files larger than 20 MB are not supported.', 413);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalBytes);
}

function shouldOpenRemoteLinkExternally(options: {
  filename: string;
  mimeType: string;
  contentDisposition: string | null;
}) {
  if (options.contentDisposition?.toLowerCase().includes('attachment')) {
    return false;
  }

  if (!options.mimeType.toLowerCase().startsWith('text/html')) {
    return false;
  }

  return !HTML_FILE_EXTENSIONS.has(extname(options.filename).toLowerCase());
}

export function createChatBodyLinkService(options: CreateChatBodyLinkServiceOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());

  async function persistMaterializedAttachment(
    conversation: ConversationRecord,
    input: {
      attachmentId: string;
      sourceFilename: string;
      mimeType: string;
      buffer: Buffer;
    },
  ) {
    const existingAttachment = await ensureExistingAttachmentReadable(
      options.getAttachment(conversation.id, input.attachmentId),
    );
    if (existingAttachment) {
      return existingAttachment;
    }

    const attachmentKind = options.attachmentKindFromUpload(input.sourceFilename, input.mimeType);
    const fallbackBase = attachmentKind === 'pdf'
      ? 'linked-file.pdf'
      : fallbackFilenameForMimeType(input.mimeType);
    const storedFilename = options.sanitizeAttachmentFilename(input.sourceFilename, fallbackBase);
    const createdAt = now();
    const attachmentsDir = join(conversation.workspace, '.rvc-chat', 'attachments');
    await mkdir(attachmentsDir, { recursive: true });
    const storagePath = join(attachmentsDir, `${input.attachmentId}-${storedFilename}`);
    await writeFile(storagePath, input.buffer);

    const attachment: SessionAttachmentRecord = {
      id: input.attachmentId,
      ownerKind: 'conversation',
      ownerId: conversation.id,
      sessionId: conversation.id,
      ownerUserId: conversation.ownerUserId,
      ownerUsername: conversation.ownerUsername,
      kind: attachmentKind,
      filename: storedFilename,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
      storagePath,
      extractedText: await options.extractAttachmentText(
        attachmentKind,
        storedFilename,
        input.mimeType,
        input.buffer,
      ),
      consumedAt: createdAt,
      createdAt,
    };
    await options.addAttachment(attachment);
    return attachment;
  }

  async function resolveLocalAttachment(conversation: ConversationRecord, href: string): Promise<ChatBodyLinkResolution | null> {
    const candidate = await resolveLocalFileCandidate(conversation, href);
    if (!candidate) {
      return null;
    }

    const fileInfo = await assertAllowedLocalFilePath(conversation, candidate.targetPath);
    const sourceFilename = basename(candidate.targetPath) || 'linked-file';
    const attachmentId = stableAttachmentId(
      `${candidate.source}:${candidate.targetPath}:${fileInfo.size}:${fileInfo.mtimeMs}`,
    );
    const buffer = await readFile(candidate.targetPath);
    return {
      kind: 'attachment',
      attachment: await persistMaterializedAttachment(conversation, {
        attachmentId,
        sourceFilename,
        mimeType: inferMimeTypeFromFilename(sourceFilename),
        buffer,
      }),
    };
  }

  async function resolveRemoteAttachment(conversation: ConversationRecord, href: string): Promise<ChatBodyLinkResolution | null> {
    let targetUrl: URL;
    try {
      targetUrl = new URL(href);
    } catch {
      return null;
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      throw new ChatBodyLinkServiceError('Unsupported link protocol.', 400);
    }
    if (!conversation.networkEnabled) {
      throw new ChatBodyLinkServiceError('Enable network access for this chat before fetching remote files.', 409);
    }

    const response = await fetchImpl(targetUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new ChatBodyLinkServiceError(`Failed to fetch linked file: ${response.status}`, 502);
    }

    const finalUrl = new URL(response.url || targetUrl.toString());
    const contentDisposition = response.headers.get('content-disposition');
    const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').trim() || 'application/octet-stream';
    const filename = parseContentDispositionFilename(contentDisposition)
      ?? basename(finalUrl.pathname)
      ?? fallbackFilenameForMimeType(mimeType);
    const sanitizedFilename = filename.trim() || fallbackFilenameForMimeType(mimeType);

    if (shouldOpenRemoteLinkExternally({
      filename: sanitizedFilename,
      mimeType,
      contentDisposition,
    })) {
      return {
        kind: 'external',
        href: finalUrl.toString(),
      };
    }

    const buffer = await readResponseBuffer(response);
    const attachmentId = stableAttachmentId(`remote:${finalUrl.toString()}`);
    return {
      kind: 'attachment',
      attachment: await persistMaterializedAttachment(conversation, {
        attachmentId,
        sourceFilename: sanitizedFilename,
        mimeType,
        buffer,
      }),
    };
  }

  return {
    async resolveLink(conversation: ConversationRecord, href: string): Promise<ChatBodyLinkResolution> {
      const trimmedHref = href.trim();
      if (!trimmedHref) {
        throw new ChatBodyLinkServiceError('Link is empty.', 400);
      }

      const directAttachment = attachmentRouteMatch(trimmedHref);
      if (directAttachment) {
        if (directAttachment.conversationId !== conversation.id) {
          throw new ChatBodyLinkServiceError('Chat link points at another conversation.', 404);
        }
        const attachment = options.getAttachment(conversation.id, directAttachment.attachmentId);
        if (!attachment) {
          throw new ChatBodyLinkServiceError('Attachment not found.', 404);
        }
        return { kind: 'attachment', attachment };
      }

      const localResolution = await resolveLocalAttachment(conversation, trimmedHref);
      if (localResolution) {
        return localResolution;
      }

      const remoteResolution = await resolveRemoteAttachment(conversation, trimmedHref);
      if (remoteResolution) {
        return remoteResolution;
      }

      return {
        kind: 'external',
        href: trimmedHref,
      };
    },
  };
}
