import { randomUUID } from 'node:crypto';

import {
  MongoServerError,
  type Collection,
  type Db,
} from 'mongodb';

import type {
  ConversationRecord,
  SessionAttachmentKind,
} from './types.js';

export interface PersistedChatAttachmentRef {
  attachmentId: string;
  kind: SessionAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  ownerUserId: string;
  seq: number;
  threadGeneration: number;
  role: 'user' | 'assistant';
  body: string;
  attachments: PersistedChatAttachmentRef[];
  sourceThreadId: string | null;
  sourceTurnId: string | null;
  sourceItemId: string | null;
  dedupeKey: string | null;
  createdAt: string;
}

export interface ChatConversationSummaryRecord {
  text: string;
  summarizedUntilSeq: number;
  model: string | null;
  updatedAt: string;
}

export interface ChatConversationState {
  id: string;
  ownerUserId: string;
  currentThreadId: string;
  threadGeneration: number;
  recoveryAppliedGeneration: number;
  nextMessageSeq: number;
  summary: ChatConversationSummaryRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppendChatMessageInput {
  role: 'user' | 'assistant';
  body: string;
  attachments?: PersistedChatAttachmentRef[];
  sourceThreadId?: string | null;
  sourceTurnId?: string | null;
  sourceItemId?: string | null;
  dedupeKey?: string | null;
  threadGeneration?: number;
  createdAt?: string;
}

interface ChatConversationDocument {
  _id: string;
  ownerUserId: string;
  currentThreadId: string;
  threadGeneration: number;
  recoveryAppliedGeneration: number;
  nextMessageSeq: number;
  summary: ChatConversationSummaryRecord | null;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessageDocument {
  _id: string;
  conversationId: string;
  ownerUserId: string;
  seq: number;
  threadGeneration: number;
  role: 'user' | 'assistant';
  body: string;
  attachments: PersistedChatAttachmentRef[];
  sourceThreadId?: string;
  sourceTurnId?: string;
  sourceItemId?: string;
  dedupeKey?: string;
  createdAt: string;
}

function asConversationState(document: ChatConversationDocument): ChatConversationState {
  return {
    id: document._id,
    ownerUserId: document.ownerUserId,
    currentThreadId: document.currentThreadId,
    threadGeneration: document.threadGeneration,
    recoveryAppliedGeneration: document.recoveryAppliedGeneration,
    nextMessageSeq: document.nextMessageSeq,
    summary: document.summary,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function asMessageRecord(document: ChatMessageDocument): ChatMessageRecord {
  return {
    id: document._id,
    conversationId: document.conversationId,
    ownerUserId: document.ownerUserId,
    seq: document.seq,
    threadGeneration: document.threadGeneration,
    role: document.role,
    body: document.body,
    attachments: document.attachments,
    sourceThreadId: document.sourceThreadId ?? null,
    sourceTurnId: document.sourceTurnId ?? null,
    sourceItemId: document.sourceItemId ?? null,
    dedupeKey: document.dedupeKey ?? null,
    createdAt: document.createdAt,
  };
}

function isDuplicateKeyError(error: unknown) {
  return error instanceof MongoServerError && (error as MongoServerError).code === 11000;
}

export class ChatHistoryRepository {
  private readonly conversations: Collection<ChatConversationDocument>;
  private readonly messages: Collection<ChatMessageDocument>;

  constructor(db: Db) {
    this.conversations = db.collection<ChatConversationDocument>('chat_conversations');
    this.messages = db.collection<ChatMessageDocument>('chat_messages');
  }

  async ensureIndexes() {
    await this.conversations.createIndex({ ownerUserId: 1, updatedAt: -1 });
    await this.messages.createIndex({ conversationId: 1, seq: 1 }, { unique: true });
    await this.messages.createIndex(
      { conversationId: 1, dedupeKey: 1 },
      { unique: true, sparse: true },
    );
    await this.messages.createIndex({ conversationId: 1, createdAt: 1 });
  }

  async ensureConversation(record: ConversationRecord) {
    const now = new Date().toISOString();
    await this.conversations.updateOne(
      { _id: record.id },
      {
        $setOnInsert: {
          _id: record.id,
          currentThreadId: record.threadId,
          threadGeneration: 1,
          recoveryAppliedGeneration: 1,
          nextMessageSeq: 0,
          summary: null,
          createdAt: now,
        },
        $set: {
          ownerUserId: record.ownerUserId,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return this.getConversationOrThrow(record.id);
  }

  async getConversation(conversationId: string) {
    const document = await this.conversations.findOne({ _id: conversationId });
    return document ? asConversationState(document) : null;
  }

  async getConversationOrThrow(conversationId: string) {
    const document = await this.conversations.findOne({ _id: conversationId });
    if (!document) {
      throw new Error(`Chat history not initialized for conversation ${conversationId}`);
    }
    return asConversationState(document);
  }

  async rotateConversationThread(record: ConversationRecord, nextThreadId: string) {
    const current = await this.ensureConversation(record);
    if (current.currentThreadId === nextThreadId) {
      return current;
    }

    const now = new Date().toISOString();
    const result = await this.conversations.findOneAndUpdate(
      { _id: record.id },
      {
        $set: {
          ownerUserId: record.ownerUserId,
          currentThreadId: nextThreadId,
          updatedAt: now,
        },
        $inc: {
          threadGeneration: 1,
        },
      },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Chat history thread rotation failed for ${record.id}`);
    }
    return asConversationState(result);
  }

  async markRecoveryApplied(conversationId: string, generation: number) {
    const now = new Date().toISOString();
    await this.conversations.updateOne(
      { _id: conversationId },
      {
        $max: {
          recoveryAppliedGeneration: generation,
        },
        $set: {
          updatedAt: now,
        },
      },
    );
  }

  async deleteConversation(conversationId: string) {
    await this.messages.deleteMany({ conversationId });
    await this.conversations.deleteOne({ _id: conversationId });
  }

  async updateSummary(
    conversationId: string,
    summary: {
      text: string;
      summarizedUntilSeq: number;
      model: string | null;
    },
  ) {
    const now = new Date().toISOString();
    await this.conversations.updateOne(
      { _id: conversationId },
      {
        $set: {
          summary: {
            text: summary.text,
            summarizedUntilSeq: summary.summarizedUntilSeq,
            model: summary.model,
            updatedAt: now,
          },
          updatedAt: now,
        },
      },
    );
  }

  async countMessages(conversationId: string) {
    return this.messages.countDocuments({ conversationId });
  }

  async listRecentMessages(conversationId: string, limit: number) {
    const documents = await this.messages
      .find({ conversationId })
      .sort({ seq: -1 })
      .limit(limit)
      .toArray();
    return documents.reverse().map(asMessageRecord);
  }

  async listMessagesBySeq(
    conversationId: string,
    options?: {
      afterSeq?: number;
      maxSeq?: number;
      limit?: number;
    },
  ) {
    const filter: {
      conversationId: string;
      seq?: {
        $gt?: number;
        $lte?: number;
      };
    } = { conversationId };

    if (options?.afterSeq !== undefined || options?.maxSeq !== undefined) {
      filter.seq = {};
      if (options?.afterSeq !== undefined) {
        filter.seq.$gt = options.afterSeq;
      }
      if (options?.maxSeq !== undefined) {
        filter.seq.$lte = options.maxSeq;
      }
    }

    const cursor = this.messages.find(filter).sort({ seq: 1 });
    if (options?.limit !== undefined) {
      cursor.limit(options.limit);
    }
    return (await cursor.toArray()).map(asMessageRecord);
  }

  async pageMessages(conversationId: string, options: { before?: string | null; limit: number }) {
    const total = await this.countMessages(conversationId);
    const parsedBefore = typeof options.before === 'string'
      ? Number.parseInt(options.before, 10)
      : Number.NaN;
    const end = Number.isNaN(parsedBefore) ? total : Math.min(Math.max(parsedBefore, 0), total);
    const start = Math.max(0, end - options.limit);
    const documents = await this.messages
      .find({ conversationId })
      .sort({ seq: 1 })
      .skip(start)
      .limit(Math.max(0, end - start))
      .toArray();

    return {
      items: documents.map(asMessageRecord),
      nextCursor: start > 0 ? String(start) : null,
      total,
    };
  }

  async appendMessages(record: ConversationRecord, inputs: AppendChatMessageInput[]) {
    if (inputs.length === 0) {
      return [];
    }

    const state = await this.ensureConversation(record);
    const dedupeKeys = [...new Set(inputs
      .map((entry) => entry.dedupeKey ?? null)
      .filter((value): value is string => Boolean(value)))];

    const existingKeys = dedupeKeys.length === 0
      ? new Set<string>()
      : new Set(
        (await this.messages.find(
          {
            conversationId: record.id,
            dedupeKey: { $in: dedupeKeys },
          },
          {
            projection: {
              dedupeKey: 1,
            },
          },
        ).toArray())
          .map((entry: Pick<ChatMessageDocument, 'dedupeKey'>) => entry.dedupeKey)
          .filter((value: string | undefined): value is string => typeof value === 'string'),
      );

    const pending = inputs.filter((entry) => (
      entry.dedupeKey ? !existingKeys.has(entry.dedupeKey) : true
    ));
    if (pending.length === 0) {
      return [];
    }

    const startSeq = await this.reserveSequences(record.id, pending.length);
    const documents = pending.map((entry, index): ChatMessageDocument => ({
      _id: randomUUID(),
      conversationId: record.id,
      ownerUserId: record.ownerUserId,
      seq: startSeq + index,
      threadGeneration: entry.threadGeneration ?? state.threadGeneration,
      role: entry.role,
      body: entry.body,
      attachments: entry.attachments ?? [],
      ...(entry.sourceThreadId ? { sourceThreadId: entry.sourceThreadId } : {}),
      ...(entry.sourceTurnId ? { sourceTurnId: entry.sourceTurnId } : {}),
      ...(entry.sourceItemId ? { sourceItemId: entry.sourceItemId } : {}),
      ...(entry.dedupeKey ? { dedupeKey: entry.dedupeKey } : {}),
      createdAt: entry.createdAt ?? new Date().toISOString(),
    }));

    try {
      await this.messages.insertMany(documents, { ordered: false });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    return documents.map(asMessageRecord);
  }

  private async reserveSequences(conversationId: string, count: number) {
    const now = new Date().toISOString();
    const current = await this.conversations.findOneAndUpdate(
      { _id: conversationId },
      {
        $inc: {
          nextMessageSeq: count,
        },
        $set: {
          updatedAt: now,
        },
      },
      { returnDocument: 'before' },
    );

    if (!current) {
      throw new Error(`Chat history sequence allocation failed for ${conversationId}`);
    }

    return current.nextMessageSeq;
  }
}
