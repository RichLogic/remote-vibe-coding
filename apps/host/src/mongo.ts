import { MongoClient, type Db } from 'mongodb';

import { MONGODB_DB_NAME, MONGODB_URL } from './config.js';

let clientPromise: Promise<MongoClient> | null = null;
let dbPromise: Promise<Db> | null = null;

async function connectClient() {
  const client = new MongoClient(MONGODB_URL);
  await client.connect();
  return client;
}

export async function getMongoClient() {
  if (!clientPromise) {
    clientPromise = connectClient();
  }
  return clientPromise;
}

export async function getMongoDb() {
  if (!dbPromise) {
    dbPromise = getMongoClient().then(async (client) => {
      const db = client.db(MONGODB_DB_NAME);
      await db.command({ ping: 1 });
      return db;
    });
  }
  return dbPromise;
}

