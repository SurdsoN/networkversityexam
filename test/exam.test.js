// Unit tests for the exam rules (lib/exam.js) against a throwaway data dir.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-unit-'));
const store = await import('../lib/store.js');
const exam = await import('../lib/exam.js');

before(() => store.load());

test('grade bands follow the published scale', () => {
  const cases = [[100, 'Excellent'], [81, 'Excellent'], [80, 'Very Good'], [71, 'Very Good'], [70, 'Good'], [61, 'Good'],
    [60, 'Pass'], [51, 'Pass'], [50, 'Fair'], [41, 'Fair'], [40, 'Fail'], [0, 'Fail']];
  for (const [p, label] of cases) assert.equal(exam.gradeBand(p), label, `${p}%`);
});

test('seed bank has at least 100 valid questions', () => {
  const qs = store.data().questions;
  assert.ok(qs.length >= 100);
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  for (const q of qs) {
    assert.ok(['tf', 'mc'].includes(q.type));
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, q.id);
    if (q.type === 'tf') assert.deepEqual(q.options, ['True', 'False']);
  }
});

test('an attempt draws 100 distinct questions and never exposes answers', () => {
  const a = exam.startAttempt('1.1.1.1', 'Unit Tester');
  assert.equal(a.questions.length, 100);
  assert.equal(new Set(a.questions.map((q) => q.id)).size, 100);
  const payload = exam.examPayload(a);
  assert.ok(!JSON.stringify(payload.questions).includes('"answer"'));
});

test('linear mode forbids going back or skipping ahead', () => {
  const a = exam.startAttempt('1.1.1.2', 'Linear Tester');
  assert.match(exam.saveAnswer(a, 1, 0), /cannot go back/);
  assert.equal(exam.saveAnswer(a, 0, 0), null);
  assert.match(exam.saveAnswer(a, 0, 1), /cannot go back/);
  assert.equal(a.currentIndex, 1);
});

test('all-correct submission scores 100 and earns a certificate', () => {
  const a = exam.startAttempt('1.1.1.3', 'Perfect Student');
  exam.submitAttempt(a, a.questions.map((q) => q.answer));
  assert.equal(a.score, 100);
  assert.equal(a.band, 'Excellent');
  assert.equal(a.passed, true);
  assert.match(a.certificateId, /^NV-\d{4}-[0-9A-F]{8}$/);
});

test('scores below the pass mark get no certificate', () => {
  const a = exam.startAttempt('1.1.1.4', 'Weak Student');
  const answers = a.questions.map((q, i) => (i < 45 ? q.answer : (q.answer + 1) % q.options.length));
  exam.submitAttempt(a, answers);
  assert.equal(a.score, 45);
  assert.equal(a.band, 'Fair');
  assert.equal(a.passed, false);
  assert.equal(a.certificateId, undefined);
});

test('expired attempts are graded automatically on saved answers only', () => {
  const a = exam.startAttempt('1.1.1.5', 'Late Student');
  exam.saveAnswer(a, 0, a.questions[0].answer);
  const past = new Date(Date.now() - exam.GRACE_MS - 5000).toISOString();
  a.deadline = past;
  store.writeAttempt(a);
  store.data().attempts.find((x) => x.id === a.id).deadline = past;
  exam.finalizeExpired();
  const done = store.readAttempt(a.id);
  assert.equal(done.status, 'submitted');
  assert.equal(done.autoSubmitted, true);
  assert.equal(done.score, 1);
  // late answers are ignored
  assert.match(exam.saveAnswer(done, 1, 0), /already been submitted/);
});
