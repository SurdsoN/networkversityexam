import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import * as exam from './lib/exam.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

store.load();
auth.ensureAdmin();

const app = express();

// Attempts are limited per IP address, so the app must see the student's real
// IP. Behind a hosting proxy (Render, Railway, Heroku, Nginx...) the default of
// trusting one proxy hop is right; set TRUST_PROXY=false when Node faces the
// internet directly, or a higher number for more proxy hops.
const trustProxy = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

function clientIp(req) {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

const badRequest = (res, error, status = 400) => res.status(status).json({ error });

// ---------------------------------------------------------------- student API

function publicSettings() {
  const { settings } = store.data();
  return {
    questionsPerExam: exam.effectiveQuestionCount(),
    timeLimitMinutes: settings.timeLimitMinutes,
    maxAttempts: settings.maxAttempts,
    passMark: settings.passMark,
    navigationMode: settings.navigationMode,
  };
}

// Identifies the student's device. The device ID lives in two places (an
// HttpOnly cookie and the page's localStorage, sent as X-Device-Id) so that
// clearing just one of them does not reset it. The fingerprint (a hash of
// browser/screen/hardware traits, sent as X-Device-Fp) catches a student who
// clears both but stays on the same network. See exam.matchesStudent.
const DEVICE_COOKIE = 'nv_device';
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers allow
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function identify(req, res) {
  const fromCookie = readCookie(req, DEVICE_COOKIE);
  const fromHeader = req.get('X-Device-Id');
  const deviceId = [fromCookie, fromHeader].find((v) => v && UUID.test(v)) || crypto.randomUUID();
  if (fromCookie !== deviceId) {
    res.append('Set-Cookie', `${DEVICE_COOKIE}=${deviceId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVICE_MAX_AGE}${req.secure ? '; Secure' : ''}`);
  }
  const fp = req.get('X-Device-Fp');
  return { ip: clientIp(req), deviceId, fingerprint: fp && /^[a-f0-9]{16,64}$/.test(fp) ? fp : null };
}

function inProgressFor(who, attemptId) {
  const attempts = store.data().attempts;
  return (
    attempts.find((a) => a.status === 'in_progress' && attemptId && a.id === attemptId) ||
    attempts.find((a) => a.status === 'in_progress' && exam.matchesStudent(a, who))
  );
}

// The browser keeps its attempt id, which lets a student resume after a
// refresh even if their mobile IP changed mid-exam.
app.get('/api/exam/status', (req, res) => {
  const who = identify(req, res);
  const attemptId = typeof req.query.attemptId === 'string' ? req.query.attemptId : null;
  exam.finalizeExpired((a) => exam.matchesStudent(a, who) || a.id === attemptId);
  const used = exam.attemptsForStudent(who);
  const settings = publicSettings();
  const current = inProgressFor(who, attemptId);
  res.json({
    deviceId: who.deviceId,
    settings,
    attemptsUsed: used.length,
    attemptsLeft: Math.max(0, settings.maxAttempts - used.length),
    inProgress: current ? { id: current.id, name: current.name } : null,
    history: used
      .filter((a) => a.status === 'submitted')
      .map((a) => ({
        id: a.id,
        name: a.name,
        submittedAt: a.submittedAt,
        score: a.score,
        total: a.total,
        percent: a.percent,
        band: a.band,
        passed: a.passed,
      })),
  });
});

app.post('/api/exam/start', (req, res) => {
  const who = identify(req, res);
  const attemptId = typeof req.body.attemptId === 'string' ? req.body.attemptId : null;
  exam.finalizeExpired((a) => exam.matchesStudent(a, who) || a.id === attemptId);

  const current = inProgressFor(who, attemptId);
  if (current) return res.json(exam.examPayload(store.readAttempt(current.id)));

  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 80) return badRequest(res, 'Please enter your full name (3–80 characters).');
  if (!/\p{L}/u.test(name)) return badRequest(res, 'Please enter a valid name.');

  const { maxAttempts } = store.data().settings;
  if (exam.attemptsForStudent(who).length >= maxAttempts) {
    return badRequest(res, `You have used all ${maxAttempts} attempt(s) allowed for this exam on this device.`, 403);
  }
  if (exam.effectiveQuestionCount() === 0) return badRequest(res, 'The exam is not available yet.', 503);
  res.json(exam.examPayload(exam.startAttempt(who, name)));
});

function loadAttempt(req, res) {
  const attempt = /^[a-f0-9-]{36}$/.test(req.params.id) ? store.readAttempt(req.params.id) : null;
  if (!attempt) badRequest(res, 'Exam attempt not found.', 404);
  return attempt;
}

app.get('/api/exam/attempt/:id', (req, res) => {
  const attempt = loadAttempt(req, res);
  if (!attempt) return;
  if (attempt.status === 'in_progress' && exam.isPastGrace(attempt)) exam.submitAttempt(attempt, null, { auto: true });
  if (attempt.status === 'in_progress') return res.json(exam.examPayload(attempt));
  res.json({ status: attempt.status });
});

app.post('/api/exam/attempt/:id/answer', (req, res) => {
  const attempt = loadAttempt(req, res);
  if (!attempt) return;
  const error = exam.saveAnswer(attempt, req.body.index, req.body.answer ?? null);
  if (error) return badRequest(res, error, 409);
  res.json({ ok: true, currentIndex: attempt.currentIndex });
});

app.post('/api/exam/attempt/:id/submit', (req, res) => {
  const attempt = loadAttempt(req, res);
  if (!attempt) return;
  exam.submitAttempt(attempt, req.body.answers, { auto: req.body.auto === true });
  res.json(exam.resultPayload(attempt, { includeReview: store.data().settings.showCorrectAnswers }));
});

app.get('/api/exam/attempt/:id/result', (req, res) => {
  const attempt = loadAttempt(req, res);
  if (!attempt) return;
  if (attempt.status === 'in_progress' && exam.isPastGrace(attempt)) exam.submitAttempt(attempt, null, { auto: true });
  if (attempt.status !== 'submitted') return badRequest(res, 'This exam has not been submitted yet.', 409);
  res.json(exam.resultPayload(attempt, { includeReview: store.data().settings.showCorrectAnswers }));
});

// ------------------------------------------------------------------ admin API

app.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  if (auth.isLockedOut(ip)) return badRequest(res, 'Too many failed attempts. Try again in 15 minutes.', 429);
  const token = auth.login(ip, req.body.username, req.body.password);
  if (!token) return badRequest(res, 'Incorrect username or password.', 401);
  res.set('Set-Cookie', auth.sessionCookie(token, req.secure));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  auth.logout(req);
  res.set('Set-Cookie', auth.clearCookie());
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: auth.isAdmin(req), username: auth.isAdmin(req) ? store.data().admin.username : null });
});

const admin = express.Router();
admin.use(auth.requireAdmin);

function validateQuestion(body) {
  const type = body.type;
  if (type !== 'tf' && type !== 'mc') return { error: 'Type must be True/False or Multiple Choice.' };
  const text = String(body.text || '').trim();
  if (!text || text.length > 1000) return { error: 'Question text is required (max 1000 characters).' };
  let options;
  if (type === 'tf') {
    options = ['True', 'False'];
  } else {
    if (!Array.isArray(body.options)) return { error: 'Options are required.' };
    options = body.options.map((o) => String(o ?? '').trim());
    if (options.length < 2 || options.length > 6) return { error: 'Multiple choice needs 2 to 6 options.' };
    if (options.some((o) => !o || o.length > 300)) return { error: 'Options cannot be empty (max 300 characters).' };
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'Options must be different from each other.' };
  }
  const answer = Number(body.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return { error: 'Mark the correct answer.' };
  return { question: { type, text, options, answer } };
}

admin.get('/questions', (req, res) => res.json(store.data().questions));

admin.post('/questions', (req, res) => {
  const { question, error } = validateQuestion(req.body);
  if (error) return badRequest(res, error);
  const created = { id: store.newQuestionId(), ...question, source: 'admin' };
  store.data().questions.push(created);
  store.save();
  res.status(201).json(created);
});

admin.put('/questions/:id', (req, res) => {
  const existing = store.data().questions.find((q) => q.id === req.params.id);
  if (!existing) return badRequest(res, 'Question not found.', 404);
  const { question, error } = validateQuestion(req.body);
  if (error) return badRequest(res, error);
  Object.assign(existing, question, { source: existing.source === 'derived' ? 'reviewed' : existing.source });
  store.save();
  res.json(existing);
});

admin.delete('/questions/:id', (req, res) => {
  const db = store.data();
  const before = db.questions.length;
  db.questions = db.questions.filter((q) => q.id !== req.params.id);
  if (db.questions.length === before) return badRequest(res, 'Question not found.', 404);
  store.save();
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json({ ...store.data().settings, bankSize: store.data().questions.length }));

admin.put('/settings', (req, res) => {
  const b = req.body;
  const int = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  if (!int(b.questionsPerExam, 1, 500)) return badRequest(res, 'Questions per exam must be 1–500.');
  if (!int(b.timeLimitMinutes, 1, 600)) return badRequest(res, 'Time limit must be 1–600 minutes.');
  if (!int(b.maxAttempts, 1, 20)) return badRequest(res, 'Maximum attempts must be 1–20.');
  if (!int(b.passMark, 1, 100)) return badRequest(res, 'Pass mark must be 1–100.');
  if (!['linear', 'free'].includes(b.navigationMode)) return badRequest(res, 'Invalid navigation mode.');
  const db = store.data();
  db.settings = {
    questionsPerExam: Number(b.questionsPerExam),
    timeLimitMinutes: Number(b.timeLimitMinutes),
    maxAttempts: Number(b.maxAttempts),
    passMark: Number(b.passMark),
    navigationMode: b.navigationMode,
    showCorrectAnswers: Boolean(b.showCorrectAnswers),
  };
  store.save();
  res.json(db.settings);
});

admin.get('/attempts', (req, res) => {
  exam.finalizeExpired();
  const all = store.data().attempts;
  // Flag devices used under more than one student name: a sign that one
  // person is taking the exam for others, or retrying under a new name.
  const attempts = all
    .map((a) => {
      const names = new Set(all.filter((b) => exam.matchesStudent(b, a)).map((b) => b.name.toLowerCase()));
      return { ...a, sharedDeviceNames: names.size > 1 ? names.size : 0 };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json(attempts);
});

admin.get('/attempts.csv', (req, res) => {
  exam.finalizeExpired();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'IP', 'Device ID', 'Started', 'Submitted', 'Status', 'Score', 'Total', 'Percent', 'Grade', 'Passed', 'Certificate ID', 'Auto-submitted']];
  for (const a of store.data().attempts) {
    rows.push([a.name, a.ip, a.deviceId, a.startedAt, a.submittedAt, a.status, a.score, a.total, a.percent, a.band, a.passed ? 'Yes' : a.status === 'submitted' ? 'No' : '', a.certificateId, a.autoSubmitted ? 'Yes' : '']);
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="networkversity-results.csv"');
  res.send('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'));
});

admin.get('/attempts/:id', (req, res) => {
  const attempt = loadAttempt(req, res);
  if (!attempt) return;
  if (attempt.status !== 'submitted') return res.json({ ...exam.resultPayload(attempt, { includeReview: false }), ip: attempt.ip, deviceId: attempt.deviceId });
  res.json({ ...exam.resultPayload(attempt, { includeReview: true }), ip: attempt.ip, deviceId: attempt.deviceId });
});

// Deleting an attempt gives that IP the attempt back.
admin.delete('/attempts/:id', (req, res) => {
  const db = store.data();
  const before = db.attempts.length;
  db.attempts = db.attempts.filter((a) => a.id !== req.params.id);
  if (db.attempts.length === before) return badRequest(res, 'Attempt not found.', 404);
  store.save();
  store.deleteAttempt(req.params.id);
  res.json({ ok: true });
});

admin.post('/reset-ip', (req, res) => {
  const ip = String(req.body.ip || '').trim();
  if (!ip) return badRequest(res, 'IP address is required.');
  const db = store.data();
  const removed = db.attempts.filter((a) => a.ip === ip);
  db.attempts = db.attempts.filter((a) => a.ip !== ip);
  store.save();
  removed.forEach((a) => store.deleteAttempt(a.id));
  res.json({ ok: true, removed: removed.length });
});

admin.post('/reset-device', (req, res) => {
  const deviceId = String(req.body.deviceId || '');
  if (!deviceId) return badRequest(res, 'Device ID is required.');
  const db = store.data();
  const removed = db.attempts.filter((a) => a.deviceId === deviceId);
  db.attempts = db.attempts.filter((a) => a.deviceId !== deviceId);
  store.save();
  removed.forEach((a) => store.deleteAttempt(a.id));
  res.json({ ok: true, removed: removed.length });
});

admin.put('/password', (req, res) => {
  const { current, next } = req.body;
  if (typeof next !== 'string' || next.length < 8) return badRequest(res, 'New password must be at least 8 characters.');
  if (typeof current !== 'string' || !auth.changePassword(current, next)) return badRequest(res, 'Current password is incorrect.', 403);
  res.json({ ok: true });
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => badRequest(res, 'Not found', 404));

// -------------------------------------------------------------------- pages

app.get('/vendor/jspdf.umd.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Networkversity exam running on http://localhost:${PORT}  (admin: /admin)`);
});
