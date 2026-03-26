import {
  type Collection,
  type Db,
} from 'mongodb';

import type {
  SessionCommandEvent,
  SessionFileChangeEvent,
  SessionTranscriptEntry,
} from '../types.js';

export interface CodingTurnProjection {
  turnId: string;
  threadId: string;
  status: string;
  transcriptEntries: SessionTranscriptEntry[];
  commands: SessionCommandEvent[];
  changes: SessionFileChangeEvent[];
}

interface CodingTurnDocument extends CodingTurnProjection {
  _id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedCodingTurnRecord extends CodingTurnProjection {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

function asPersistedCodingTurnRecord(document: CodingTurnDocument): PersistedCodingTurnRecord {
  return {
    id: document._id,
    sessionId: document.sessionId,
    turnId: document.turnId,
    threadId: document.threadId,
    seq: document.seq,
    status: document.status,
    transcriptEntries: document.transcriptEntries,
    commands: document.commands,
    changes: document.changes,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function buildPersistedCodingHistory(turns: Array<Pick<PersistedCodingTurnRecord, 'transcriptEntries' | 'commands' | 'changes'>>) {
  const transcriptEntries: SessionTranscriptEntry[] = [];
  const commands: SessionCommandEvent[] = [];
  const changes: SessionFileChangeEvent[] = [];

  for (const turn of turns) {
    for (const entry of turn.transcriptEntries) {
      transcriptEntries.push({
        ...entry,
        index: transcriptEntries.length,
      });
    }
    for (const command of turn.commands) {
      commands.push({
        ...command,
        index: commands.length,
      });
    }
    for (const change of turn.changes) {
      changes.push({
        ...change,
        index: changes.length,
      });
    }
  }

  return {
    transcriptEntries,
    commands,
    changes,
  };
}

export class CodingHistoryRepository {
  private readonly turns: Collection<CodingTurnDocument>;

  constructor(db: Db) {
    this.turns = db.collection<CodingTurnDocument>('coding_turns');
  }

  async ensureIndexes() {
    await this.turns.createIndex({ sessionId: 1, seq: 1 }, { unique: true });
    await this.turns.createIndex({ sessionId: 1, turnId: 1 }, { unique: true });
  }

  async listTurns(sessionId: string) {
    const documents = await this.turns
      .find({ sessionId })
      .sort({ seq: 1 })
      .toArray();
    return documents.map(asPersistedCodingTurnRecord);
  }

  async mergeTurnProjections(sessionId: string, projections: CodingTurnProjection[]) {
    if (projections.length === 0) {
      return this.listTurns(sessionId);
    }

    const highestSeqDocument = await this.turns
      .find({ sessionId })
      .sort({ seq: -1 })
      .limit(1)
      .next();

    let nextSeq = (highestSeqDocument?.seq ?? -1) + 1;
    const now = new Date().toISOString();
    const operations: Array<
      {
        updateOne: {
          filter: { _id: string };
          update: {
            $set: Omit<CodingTurnDocument, '_id' | 'sessionId' | 'turnId' | 'seq' | 'createdAt'>;
            $setOnInsert: Pick<CodingTurnDocument, '_id' | 'sessionId' | 'turnId' | 'seq' | 'createdAt'>;
          };
          upsert: true;
        };
      }
    > = [];

    for (const projection of projections) {
      const documentId = `${sessionId}:${projection.turnId}`;
      operations.push({
        updateOne: {
          filter: { _id: documentId },
          update: {
            $set: {
              threadId: projection.threadId,
              status: projection.status,
              transcriptEntries: projection.transcriptEntries,
              commands: projection.commands,
              changes: projection.changes,
              updatedAt: now,
            },
            $setOnInsert: {
              _id: documentId,
              sessionId,
              turnId: projection.turnId,
              seq: nextSeq++,
              createdAt: now,
            },
          },
          upsert: true,
        },
      });
    }

    if (operations.length > 0) {
      await this.turns.bulkWrite(operations, { ordered: true });
    }
    return this.listTurns(sessionId);
  }

  async deleteSession(sessionId: string) {
    await this.turns.deleteMany({ sessionId });
  }
}
