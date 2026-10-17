// File-based storage. Small, dependency-free and good enough for a few
// thousand exam attempts.
//
//   DATA_DIR/db.json            admin account, settings, question bank and a
//                               one-line summary of every attempt
//   DATA_DIR/attempts/<id>.json the full attempt: question snapshot, answers,
//                               progress. Kept separate so saving one answer
//                               rewrites a few KB, not the whole database.
//
// All reads/writes are synchronous, which (with Node's single thread) makes
// every request handler atomic: no two requests can interleave a
// check-then-write such as "has this IP used its attempts?".
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ATTEMPTS_DIR = path.join(DATA_DIR, 'attempts');
const SEED_FILE = path.join(ROOT, 'data', 'questions.seed.json');

export const DEFAULT_SETTINGS = {
  questionsPerExam: 100,
  timeLimitMinutes: 45,
  maxAttempts: 2,
  passMark: 51,
  // 'linear': one question at a time, no going back.
  // 'free': move freely between questions, with a question navigator.
  navigationMode: 'linear',
  showCorrectAnswers: true,
};

let db;

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function load() {
  fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    const questions = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    db = { admin: null, settings: {}, questions, attempts: [], nextQuestionNumber: questions.length + 1 };
  }
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
  save();
  return db;
}

export function data() {
  return db;
}

export function save() {
  writeJson(DB_FILE, db);
}

function attemptFile(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attempt id');
  return path.join(ATTEMPTS_DIR, `${id}.json`);
}

export function readAttempt(id) {
  try {
    return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeAttempt(attempt) {
  writeJson(attemptFile(attempt.id), attempt);
}

export function deleteAttempt(id) {
  try {
    fs.unlinkSync(attemptFile(id));
  } catch {
    // already gone
  }
}

export function newQuestionId() {
  const id = `q${String(db.nextQuestionNumber++).padStart(3, '0')}`;
  return id;
}
