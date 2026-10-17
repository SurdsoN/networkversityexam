// Picks the storage backend: Postgres when a database URL is configured
// (always the case on Vercel), otherwise JSON files under DATA_DIR.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFileStore } from './store-file.js';
import { createPgStore } from './store-pg.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const seed = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.seed.json'), 'utf8'));

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

// Vercel's Neon integration sets DATABASE_URL / POSTGRES_URL, or
// <PREFIX>_URL / <PREFIX>_DATABASE_URL when a custom prefix such as STORAGE
// is chosen while connecting it.
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  Object.entries(process.env).find(([k, v]) => /_(DATABASE_)?URL$/.test(k) && /^postgres(ql)?:\/\//.test(v || ''))?.[1];

export const missingDatabase = Boolean(process.env.VERCEL && !connectionString);

const store = connectionString
  ? createPgStore({ connectionString, seed })
  : createFileStore({ dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')), seed });

export default store;

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await store.getKv('settings')) };
}
