// Postgres storage, used whenever DATABASE_URL (or POSTGRES_URL) is set:
// on Vercel, connect a Neon/Postgres database from the Storage tab.
//
// Serverless functions run as many short-lived copies, so everything shared
// lives here: settings, the admin account, questions, attempts and login
// lockouts. Operations that must not interleave (starting an attempt, saving
// an answer) take a Postgres advisory lock for their key.
import { AsyncLocalStorage } from 'async_hooks';
import pg from 'pg';
import { summaryOf } from './match.js';

export function createPgStore({ connectionString, seed }) {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  // Inside withLock, queries run on the locked connection, so a busy pool can
  // never deadlock waiting for a second connection.
  const current = new AsyncLocalStorage();
  const query = (text, params) => (current.getStore() || pool).query(text, params);

  const toAttemptRow = (r) => r.summary;

  async function withLock(key, fn) {
    if (current.getStore()) return fn();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const result = await current.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'postgres',
    withLock,

    async init() {
      await withLock('nv:schema', async () => {
        await query(`
          CREATE TABLE IF NOT EXISTS nv_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL);
          CREATE SEQUENCE IF NOT EXISTS nv_question_seq;
          CREATE TABLE IF NOT EXISTS nv_questions (
            id TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS nv_attempts (
            id UUID PRIMARY KEY,
            ip TEXT NOT NULL,
            device_id TEXT,
            fingerprint TEXT,
            status TEXT NOT NULL,
            started_at TIMESTAMPTZ NOT NULL,
            summary JSONB NOT NULL,
            detail JSONB NOT NULL
          );
          CREATE INDEX IF NOT EXISTS nv_attempts_device ON nv_attempts (device_id);
          CREATE INDEX IF NOT EXISTS nv_attempts_ip_fp ON nv_attempts (ip, fingerprint);
          CREATE INDEX IF NOT EXISTS nv_attempts_status ON nv_attempts (status);
          CREATE TABLE IF NOT EXISTS nv_login_failures (ip TEXT PRIMARY KEY, record JSONB NOT NULL);
        `);
        // Load the starting question bank once. Deleting every question later
        // does not bring them back.
        const { rowCount } = await query(`INSERT INTO nv_kv (key, value) VALUES ('seeded', 'true') ON CONFLICT DO NOTHING`);
        if (rowCount) {
          const questions = seed();
          for (const { id, ...q } of questions) {
            await query('INSERT INTO nv_questions (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, q]);
          }
          await query(`SELECT setval('nv_question_seq', $1)`, [questions.length]);
        }
      });
    },

    async getKv(key) {
      const { rows } = await query('SELECT value FROM nv_kv WHERE key = $1', [key]);
      return rows.length ? rows[0].value : null;
    },
    async setKv(key, value) {
      await query(
        'INSERT INTO nv_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, JSON.stringify(value)],
      );
    },
    async addKvIfMissing(key, value) {
      const { rowCount } = await query('INSERT INTO nv_kv (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        key,
        JSON.stringify(value),
      ]);
      return rowCount === 1;
    },

    async listQuestions() {
      const { rows } = await query('SELECT id, data FROM nv_questions ORDER BY id');
      return rows.map((r) => ({ id: r.id, ...r.data }));
    },
    async countQuestions() {
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM nv_questions');
      return rows[0].n;
    },
    async createQuestion(q) {
      const { rows } = await query(
        `INSERT INTO nv_questions (id, data)
         VALUES ('q' || lpad(nextval('nv_question_seq')::text, 3, '0'), $1) RETURNING id`,
        [q],
      );
      return { id: rows[0].id, ...q };
    },
    async updateQuestion(id, q) {
      const { rows } = await query('UPDATE nv_questions SET data = data || $2 WHERE id = $1 RETURNING id, data', [id, q]);
      return rows.length ? { id: rows[0].id, ...rows[0].data } : null;
    },
    async deleteQuestion(id) {
      const { rowCount } = await query('DELETE FROM nv_questions WHERE id = $1', [id]);
      return rowCount === 1;
    },

    async listAttempts() {
      const { rows } = await query('SELECT summary FROM nv_attempts ORDER BY started_at DESC');
      return rows.map(toAttemptRow);
    },
    // Same rule as matchesStudent in lib/match.js.
    async findAttempts({ ip, deviceId, fingerprint }) {
      const { rows } = await query(
        `SELECT summary FROM nv_attempts
         WHERE device_id = $2 OR ($3::text IS NOT NULL AND fingerprint = $3 AND ip = $1)
         ORDER BY started_at`,
        [ip, deviceId, fingerprint],
      );
      return rows.map(toAttemptRow);
    },
    async listInProgress() {
      const { rows } = await query(`SELECT summary FROM nv_attempts WHERE status = 'in_progress'`);
      return rows.map(toAttemptRow);
    },
    async getAttempt(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) return null;
      const { rows } = await query('SELECT detail FROM nv_attempts WHERE id = $1', [id]);
      return rows.length ? rows[0].detail : null;
    },
    async saveAttempt(a) {
      await query(
        `INSERT INTO nv_attempts (id, ip, device_id, fingerprint, status, started_at, summary, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, summary = EXCLUDED.summary, detail = EXCLUDED.detail`,
        [a.id, a.ip, a.deviceId, a.fingerprint, a.status, a.startedAt, summaryOf(a), a],
      );
    },
    async deleteAttempt(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) return 0;
      return (await query('DELETE FROM nv_attempts WHERE id = $1', [id])).rowCount;
    },
    async deleteAttemptsByIp(ip) {
      return (await query('DELETE FROM nv_attempts WHERE ip = $1', [ip])).rowCount;
    },
    async deleteAttemptsByDevice(deviceId) {
      return (await query('DELETE FROM nv_attempts WHERE device_id = $1', [deviceId])).rowCount;
    },

    async getFailure(ip) {
      const { rows } = await query('SELECT record FROM nv_login_failures WHERE ip = $1', [ip]);
      return rows.length ? rows[0].record : null;
    },
    async setFailure(ip, record) {
      if (!record) {
        await query('DELETE FROM nv_login_failures WHERE ip = $1', [ip]);
        return;
      }
      await query(
        `INSERT INTO nv_login_failures (ip, record) VALUES ($1, $2)
         ON CONFLICT (ip) DO UPDATE SET record = EXCLUDED.record`,
        [ip, record],
      );
    },
  };
}
