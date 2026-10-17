// File storage, for running on your own computer or a server with a disk.
//
//   DATA_DIR/db.json            settings, admin account, question bank, login
//                               lockouts and a summary of every attempt
//   DATA_DIR/attempts/<id>.json the full attempt: question snapshot, answers,
//                               progress. Kept separate so saving one answer
//                               rewrites a few KB, not the whole database.
import fs from 'fs';
import path from 'path';
import { matchesStudent, summaryOf } from './match.js';

export function createFileStore({ dataDir, seed }) {
  const DB_FILE = path.join(dataDir, 'db.json');
  const ATTEMPTS_DIR = path.join(dataDir, 'attempts');
  let db;

  function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }
  const save = () => writeJson(DB_FILE, db);

  function attemptFile(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attempt id');
    return path.join(ATTEMPTS_DIR, `${id}.json`);
  }

  // Per-key promise chains: one operation at a time for the same key.
  const locks = new Map();

  return {
    kind: 'file',

    async init() {
      fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
      if (fs.existsSync(DB_FILE)) {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      } else {
        db = { kv: {}, questions: seed(), attempts: [], failures: {} };
        db.nextQuestionNumber = db.questions.length + 1;
      }
      db.kv ||= {};
      db.failures ||= {};
      save();
    },

    async withLock(key, fn) {
      const prev = locks.get(key) || Promise.resolve();
      const run = prev.then(fn, fn);
      const tail = run.catch(() => {});
      locks.set(key, tail);
      tail.then(() => locks.get(key) === tail && locks.delete(key));
      return run;
    },

    async getKv(key) {
      return db.kv[key] ?? null;
    },
    async setKv(key, value) {
      db.kv[key] = value;
      save();
    },
    async addKvIfMissing(key, value) {
      if (key in db.kv) return false;
      db.kv[key] = value;
      save();
      return true;
    },

    async listQuestions() {
      return db.questions;
    },
    async countQuestions() {
      return db.questions.length;
    },
    async createQuestion(q) {
      const created = { id: `q${String(db.nextQuestionNumber++).padStart(3, '0')}`, ...q };
      db.questions.push(created);
      save();
      return created;
    },
    async updateQuestion(id, q) {
      const existing = db.questions.find((x) => x.id === id);
      if (!existing) return null;
      Object.assign(existing, q);
      save();
      return existing;
    },
    async deleteQuestion(id) {
      const before = db.questions.length;
      db.questions = db.questions.filter((q) => q.id !== id);
      save();
      return db.questions.length !== before;
    },

    async listAttempts() {
      return db.attempts;
    },
    async findAttempts(who) {
      return db.attempts.filter((a) => matchesStudent(a, who));
    },
    async listInProgress() {
      return db.attempts.filter((a) => a.status === 'in_progress');
    },
    async getAttempt(id) {
      try {
        return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8'));
      } catch {
        return null;
      }
    },
    async saveAttempt(attempt) {
      writeJson(attemptFile(attempt.id), attempt);
      const i = db.attempts.findIndex((a) => a.id === attempt.id);
      if (i === -1) db.attempts.push(summaryOf(attempt));
      else db.attempts[i] = summaryOf(attempt);
      save();
    },
    async deleteAttempts(filter) {
      const removed = db.attempts.filter(filter);
      db.attempts = db.attempts.filter((a) => !filter(a));
      save();
      for (const a of removed) {
        try {
          fs.unlinkSync(attemptFile(a.id));
        } catch {
          // already gone
        }
      }
      return removed.length;
    },
    deleteAttempt(id) {
      return this.deleteAttempts((a) => a.id === id);
    },
    deleteAttemptsByIp(ip) {
      return this.deleteAttempts((a) => a.ip === ip);
    },
    deleteAttemptsByDevice(deviceId) {
      return this.deleteAttempts((a) => a.deviceId === deviceId);
    },

    async getFailure(ip) {
      return db.failures[ip] || null;
    },
    async setFailure(ip, record) {
      if (record) db.failures[ip] = record;
      else delete db.failures[ip];
      save();
    },
  };
}
