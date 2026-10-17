// Tests run against JSON files by default. Set TEST_DATABASE_URL to run the
// same tests against Postgres (the tables are dropped first).
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';

export async function testStorageEnv(prefix) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), DATABASE_URL: '', POSTGRES_URL: '' };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP TABLE IF EXISTS nv_kv, nv_questions, nv_attempts, nv_login_failures; DROP SEQUENCE IF EXISTS nv_question_seq;`);
  await client.end();
  return { DATABASE_URL: url };
}
