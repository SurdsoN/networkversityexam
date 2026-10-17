// End-to-end API tests: boots the real server on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-api-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function call(method, url, { body, ip = '10.0.0.1', cookie, device, fp } = {}) {
  const headers = { 'X-Forwarded-For': ip };
  if (device) headers['X-Device-Id'] = device;
  if (fp) headers['X-Device-Fp'] = fp;
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret-pass' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/exam/status'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => server.kill());

test('a device ID cookie is issued and echoed back', async () => {
  const r = await call('GET', '/api/exam/status');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /nv_device=[0-9a-f-]{36}; HttpOnly/);
  assert.ok(cookie.includes(r.body.deviceId));
  const again = await call('GET', '/api/exam/status', { cookie: `nv_device=${r.body.deviceId}` });
  assert.equal(again.body.deviceId, r.body.deviceId);
  assert.equal(again.headers.get('set-cookie'), null);
});

test('name is required to start', async () => {
  const r = await call('POST', '/api/exam/start', { body: { name: ' ' } });
  assert.equal(r.status, 400);
});

const DEV_A = '11111111-1111-4111-8111-111111111111';
const DEV_B = '22222222-2222-4222-8222-222222222222';
const DEV_C = '33333333-3333-4333-8333-333333333333';

test('start, resume, answer, submit, attempt limit', async () => {
  const ip = '10.0.0.2';
  const me = { ip, device: DEV_A, fp: 'aaaaaaaaaaaaaaaa' };
  const s = await call('GET', '/api/exam/status', me);
  assert.equal(s.body.attemptsLeft, 2);
  assert.equal(s.body.settings.questionsPerExam, 100);

  const start = await call('POST', '/api/exam/start', { ...me, body: { name: 'Ada Lovelace' } });
  assert.equal(start.status, 200);
  assert.equal(start.body.questions.length, 100);
  const resumed = await call('POST', '/api/exam/start', { ...me, body: { name: 'Someone Else' } });
  assert.equal(resumed.body.id, start.body.id, 'second start resumes the in-progress attempt');

  const id = start.body.id;
  assert.equal((await call('POST', `/api/exam/attempt/${id}/answer`, { body: { index: 0, answer: 0 } })).status, 200);
  assert.equal((await call('POST', `/api/exam/attempt/${id}/answer`, { body: { index: 0, answer: 1 } })).status, 409);

  const sub = await call('POST', `/api/exam/attempt/${id}/submit`, { ...me, body: { answers: [] } });
  assert.equal(sub.body.status, 'submitted');
  assert.equal(sub.body.review.length, 100);
  assert.equal(sub.body.name, 'Ada Lovelace');

  // second attempt allowed, third blocked
  const second = await call('POST', '/api/exam/start', { ...me, body: { name: 'Ada Lovelace' } });
  await call('POST', `/api/exam/attempt/${second.body.id}/submit`, { ...me, body: {} });
  const third = await call('POST', '/api/exam/start', { ...me, body: { name: 'Ada Lovelace' } });
  assert.equal(third.status, 403);
  const after = await call('GET', '/api/exam/status', me);
  assert.equal(after.body.attemptsLeft, 0);
  assert.equal(after.body.history.length, 2);

  // the same device on another network is still blocked
  assert.equal((await call('GET', '/api/exam/status', { ...me, ip: '10.9.9.9' })).body.attemptsLeft, 0);
  // the same phone with its storage cleared, on the same network, is still blocked
  assert.equal((await call('GET', '/api/exam/status', { ...me, device: DEV_C })).body.attemptsLeft, 0);
  // another phone sharing the same public IP is unaffected
  assert.equal((await call('GET', '/api/exam/status', { ip, device: DEV_B, fp: 'bbbbbbbbbbbbbbbb' })).body.attemptsLeft, 2);
});

test('admin endpoints require login and manage the bank', async () => {
  assert.equal((await call('GET', '/api/admin/questions')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'nope' } })).status, 401);
  const login = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'secret-pass' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const before = (await call('GET', '/api/admin/questions', { cookie })).body.length;
  const created = await call('POST', '/api/admin/questions', {
    cookie,
    body: { type: 'mc', text: 'Test question?', options: ['One', 'Two', 'Three'], answer: 2 },
  });
  assert.equal(created.status, 201);
  const bad = await call('POST', '/api/admin/questions', { cookie, body: { type: 'mc', text: 'x', options: ['a', 'a'], answer: 0 } });
  assert.equal(bad.status, 400);
  const updated = await call('PUT', `/api/admin/questions/${created.body.id}`, { cookie, body: { type: 'tf', text: 'Now true/false', answer: 1 } });
  assert.deepEqual(updated.body.options, ['True', 'False']);
  assert.equal((await call('DELETE', `/api/admin/questions/${created.body.id}`, { cookie })).status, 200);
  assert.equal((await call('GET', '/api/admin/questions', { cookie })).body.length, before);

  const settings = await call('PUT', '/api/admin/settings', {
    cookie,
    body: { questionsPerExam: 50, timeLimitMinutes: 30, maxAttempts: 1, passMark: 60, navigationMode: 'free', showCorrectAnswers: true },
  });
  assert.equal(settings.status, 200);
  assert.equal((await call('GET', '/api/exam/status', { ip: '10.0.0.9' })).body.settings.questionsPerExam, 50);

  const attempts = await call('GET', '/api/admin/attempts', { cookie });
  assert.ok(attempts.body.length >= 2);
  const reset = await call('POST', '/api/admin/reset-ip', { cookie, body: { ip: '10.0.0.2' } });
  assert.equal(reset.body.removed, 2);
  assert.equal((await call('POST', '/api/admin/reset-device', { cookie, body: { deviceId: DEV_A } })).status, 200);
  const csv = await call('GET', '/api/admin/attempts.csv', { cookie });
  assert.match(csv.body, /"Name","IP"/);
});
