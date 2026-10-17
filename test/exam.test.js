// Unit tests for the exam rules (lib/exam.js) against throwaway storage.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { testStorageEnv } from './helpers.js';

Object.assign(process.env, await testStorageEnv('nv-unit-'));
const { default: store } = await import('../lib/store.js');
const exam = await import('../lib/exam.js');
const { matchesStudent } = await import('../lib/match.js');

before(() => store.init());

const student = (ip) => ({ ip, deviceId: crypto.randomUUID(), fingerprint: null });

test('grade bands follow the published scale', () => {
  const cases = [[100, 'Excellent'], [81, 'Excellent'], [80, 'Very Good'], [71, 'Very Good'], [70, 'Good'], [61, 'Good'],
    [60, 'Pass'], [51, 'Pass'], [50, 'Fair'], [41, 'Fair'], [40, 'Fail'], [0, 'Fail']];
  for (const [p, label] of cases) assert.equal(exam.gradeBand(p), label, `${p}%`);
});

test('seed bank has at least 100 valid questions', async () => {
  const qs = await store.listQuestions();
  assert.ok(qs.length >= 100);
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  for (const q of qs) {
    assert.ok(['tf', 'mc'].includes(q.type));
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, q.id);
    if (q.type === 'tf') assert.deepEqual(q.options, ['True', 'False']);
  }
});

test('an attempt draws 100 distinct questions and never exposes answers', async () => {
  const a = await exam.startAttempt(student('1.1.1.1'), 'Unit Tester');
  assert.equal(a.questions.length, 100);
  assert.equal(new Set(a.questions.map((q) => q.id)).size, 100);
  const payload = exam.examPayload(a);
  assert.ok(!JSON.stringify(payload.questions).includes('"answer"'));
  assert.deepEqual(await store.getAttempt(a.id), a);
});

test('linear mode forbids going back or skipping ahead', async () => {
  const a = await exam.startAttempt(student('1.1.1.2'), 'Linear Tester');
  assert.match(await exam.saveAnswer(a, 1, 0), /cannot go back/);
  assert.equal(await exam.saveAnswer(a, 0, 0), null);
  assert.match(await exam.saveAnswer(a, 0, 1), /cannot go back/);
  assert.equal((await store.getAttempt(a.id)).currentIndex, 1);
});

test('all-correct submission scores 100 and earns a certificate', async () => {
  const a = await exam.startAttempt(student('1.1.1.3'), 'Perfect Student');
  await exam.submitAttempt(a, a.questions.map((q) => q.answer));
  assert.equal(a.score, 100);
  assert.equal(a.band, 'Excellent');
  assert.equal(a.passed, true);
  assert.match(a.certificateId, /^NV-\d{4}-[0-9A-F]{8}$/);
});

test('scores below the pass mark get no certificate', async () => {
  const a = await exam.startAttempt(student('1.1.1.4'), 'Weak Student');
  const answers = a.questions.map((q, i) => (i < 45 ? q.answer : (q.answer + 1) % q.options.length));
  await exam.submitAttempt(a, answers);
  assert.equal(a.score, 45);
  assert.equal(a.band, 'Fair');
  assert.equal(a.passed, false);
  assert.equal(a.certificateId, undefined);
});

test('expired attempts are graded automatically on saved answers only', async () => {
  const a = await exam.startAttempt(student('1.1.1.5'), 'Late Student');
  await exam.saveAnswer(a, 0, a.questions[0].answer);
  a.deadline = new Date(Date.now() - exam.GRACE_MS - 5000).toISOString();
  await store.saveAttempt(a);
  await exam.finalizeExpired();
  const done = await store.getAttempt(a.id);
  assert.equal(done.status, 'submitted');
  assert.equal(done.autoSubmitted, true);
  assert.equal(done.score, 1);
  assert.match(await exam.saveAnswer(done, 1, 0), /already been submitted/);
});

test('a student is matched by device ID, or by IP + fingerprint, never by IP alone', async () => {
  const a = { ip: '5.5.5.5', deviceId: crypto.randomUUID(), fingerprint: 'f1f1f1f1f1f1f1f1' };
  const cases = [
    [{ ip: '9.9.9.9', deviceId: a.deviceId, fingerprint: 'other' }, true, 'same device, new network'],
    [{ ip: '5.5.5.5', deviceId: crypto.randomUUID(), fingerprint: a.fingerprint }, true, 'storage cleared, same network'],
    [{ ip: '5.5.5.5', deviceId: crypto.randomUUID(), fingerprint: 'f9f9f9f9f9f9f9f9' }, false, 'other phone on the same IP'],
    [{ ip: '5.5.5.5', deviceId: crypto.randomUUID(), fingerprint: null }, false, 'no fingerprint'],
  ];
  // the JS rule and the storage query (SQL on Postgres) must agree
  const saved = await exam.startAttempt(a, 'Match Tester');
  for (const [who, expected, label] of cases) {
    assert.equal(matchesStudent(a, who), expected, label);
    assert.equal((await store.findAttempts(who)).some((x) => x.id === saved.id), expected, `store: ${label}`);
  }
});

test('locks serialise work on the same key', async () => {
  const order = [];
  const slow = store.withLock('k', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 50)); order.push('a2'); });
  const fast = store.withLock('k', async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});
