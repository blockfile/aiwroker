// Persistence for the reward system. Records per-worker contribution metrics
// (jobs, tokens, uptime, speed) keyed by the worker's --key, so rewards survive
// restarts. Entirely OPTIONAL: with no MONGODB_URI it returns a no-op store and
// the orchestrator runs exactly as before (just without recording rewards).
//
// Every method is failure-tolerant — a DB hiccup never breaks job routing.

import { MongoClient } from 'mongodb';

function noopStore(logger) {
  logger?.info?.('[db] no MONGODB_URI — running without persistence (rewards not recorded)');
  return {
    enabled: false,
    workerConnected: async () => {},
    recordJob: async () => {},
    heartbeat: async () => {},
    workerDisconnected: async () => {},
    leaderboard: async () => [],
    close: async () => {},
  };
}

export function createStore({ uri, dbName = 'core', logger = console } = {}) {
  if (!uri) return noopStore(logger);

  const client = new MongoClient(uri);
  let workers = null;

  const ready = client
    .connect()
    .then(async () => {
      workers = client.db(dbName).collection('workers');
      await workers.createIndex({ key: 1 }, { unique: true });
      logger.info?.(`[db] connected to MongoDB (db: ${dbName})`);
    })
    .catch((err) => {
      logger.warn?.(`[db] connection failed: ${err.message} — continuing without persistence`);
      workers = null;
    });

  // Wrap an op so it awaits the connection, no-ops if the DB is unavailable, and
  // never throws into the caller (fire-and-forget safe).
  const op = (fn) => async (...args) => {
    try {
      await ready;
      if (!workers) return undefined;
      return await fn(workers, ...args);
    } catch (err) {
      logger.warn?.(`[db] op failed: ${err.message}`);
      return undefined;
    }
  };

  return {
    enabled: true,

    workerConnected: op(async (c, { key, name, models } = {}) => {
      if (!key) return;
      const now = new Date();
      await c.updateOne(
        { key },
        {
          $setOnInsert: { key, firstSeenAt: now, totalJobs: 0, totalTokens: 0, uptimeSeconds: 0 },
          $set: { name, models, connectedAt: now, lastSeenAt: now },
        },
        { upsert: true },
      );
    }),

    recordJob: op(async (c, { key, tokens, tokensPerSec } = {}) => {
      if (!key) return;
      await c.updateOne(
        { key },
        {
          $inc: { totalJobs: 1, totalTokens: Math.max(0, Math.round(tokens || 0)) },
          $set: { tokensPerSec: tokensPerSec || 0, lastSeenAt: new Date() },
        },
      );
    }),

    // Fold elapsed connected-time into uptimeSeconds and reset the mark. Called
    // periodically and on disconnect so uptime is robust even across crashes.
    heartbeat: op(async (c, { key } = {}) => {
      if (!key) return;
      const now = new Date();
      const doc = await c.findOne({ key }, { projection: { connectedAt: 1 } });
      if (doc?.connectedAt) {
        const delta = Math.max(0, (now - doc.connectedAt) / 1000);
        await c.updateOne({ key }, { $inc: { uptimeSeconds: delta }, $set: { connectedAt: now, lastSeenAt: now } });
      }
    }),

    workerDisconnected: op(async (c, { key } = {}) => {
      if (!key) return;
      const now = new Date();
      const doc = await c.findOne({ key }, { projection: { connectedAt: 1 } });
      if (doc?.connectedAt) {
        const delta = Math.max(0, (now - doc.connectedAt) / 1000);
        await c.updateOne({ key }, { $inc: { uptimeSeconds: delta }, $set: { connectedAt: null, lastSeenAt: now } });
      }
    }),

    leaderboard: op(async (c) => c.find({}, { projection: { _id: 0 } }).toArray()),

    async close() {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}
