import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import store, { getSettings, missingDatabase } from './lib/store.js';
import * as auth from './lib/auth.js';
import * as exam from './lib/exam.js';
import { matchesStudent } from './lib/match.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Attempts are limited per device + IP, so the app must see the student's real
// IP. Behind a hosting proxy (Vercel, Render, Railway, Nginx...) the default
// of trusting one proxy hop is right; set TRUST_PROXY=false when Node faces
// the internet directly, or a higher number for more proxy hops.
const trustProxy = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  req.body ??= {};
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// Storage is set up on the first API request of each server instance.
let ready;
app.use('/api', async (req, res, next) => {
  if (missingDatabase) {
    return res.status(503).json({
      error: 'No database connected. In your Vercel project open Storage, connect a Postgres (Neon) database, then redeploy.',
    });
  }
  ready ||= (async () => {
    await store.init();
    await auth.ensureAdmin();
  })().catch((err) => {
    ready = null;
    throw err;
  });
  await ready;
  next();
});

function clientIp(req) {
  const ip = (process.env.VERCEL && req.get('x-real-ip')) || req.ip || req.socket.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

const badRequest = (res, error, status = 400) => res.status(status).json({ error });

// ---------------------------------------------------------------- student API

// Identifies the student's device. The device ID lives in two places (an
// HttpOnly cookie and the page's localStorage, sent as X-Device-Id) so that
// clearing just one of them does not reset it. The fingerprint (a hash of
// browser/screen/hardware traits, sent as X-Device-Fp) catches a student who
// clears both but stays on the same network. See lib/match.js.
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

async function publicSettings() {
  const settings = await getSettings();
  return {
    questionsPerExam: await exam.effectiveQuestionCount(settings),
    timeLimitMinutes: settings.timeLimitMinutes,
    maxAttempts: settings.maxAttempts,
    passMark: settings.passMark,
    navigationMode: settings.navigationMode,
  };
}

async function inProgressFor(who, attemptId) {
  if (attemptId && UUID.test(attemptId)) {
    const byId = await store.getAttempt(attemptId);
    if (byId && byId.status === 'in_progress') return byId;
  }
  return (await store.findAttempts(who)).find((a) => a.status === 'in_progress') || null;
}

// The browser keeps its attempt id, which lets a student resume after a
// refresh even if their mobile IP changed mid-exam.
app.get('/api/exam/status', async (req, res) => {
  const who = identify(req, res);
  const attemptId = typeof req.query.attemptId === 'string' ? req.query.attemptId : null;
  await exam.finalizeExpired((a) => matchesStudent(a, who) || a.id === attemptId);
  const used = await store.findAttempts(who);
  const settings = await publicSettings();
  const current = await inProgressFor(who, attemptId);
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

app.post('/api/exam/start', async (req, res) => {
  const who = identify(req, res);
  const attemptId = typeof req.body.attemptId === 'string' ? req.body.attemptId : null;
  await exam.finalizeExpired((a) => matchesStudent(a, who) || a.id === attemptId);

  // One start at a time per device, so a double tap cannot create two attempts.
  await store.withLock(`device:${who.deviceId}`, async () => {
    const current = await inProgressFor(who, attemptId);
    if (current) return res.json(exam.examPayload(await store.getAttempt(current.id)));

    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > 80) return badRequest(res, 'Please enter your full name (3–80 characters).');
    if (!/\p{L}/u.test(name)) return badRequest(res, 'Please enter a valid name.');

    const settings = await getSettings();
    if ((await store.findAttempts(who)).length >= settings.maxAttempts) {
      return badRequest(res, `You have used all ${settings.maxAttempts} attempt(s) allowed for this exam on this device.`, 403);
    }
    if ((await exam.effectiveQuestionCount(settings)) === 0) return badRequest(res, 'The exam is not available yet.', 503);
    res.json(exam.examPayload(await exam.startAttempt(who, name)));
  });
});

const validAttemptId = (req, res) => UUID.test(req.params.id) || (badRequest(res, 'Exam attempt not found.', 404), false);

app.get('/api/exam/attempt/:id', async (req, res) => {
  if (!validAttemptId(req, res)) return;
  await exam.withAttempt(req.params.id, async (attempt) => {
    if (!attempt) return badRequest(res, 'Exam attempt not found.', 404);
    if (attempt.status === 'in_progress') return res.json(exam.examPayload(attempt));
    res.json({ status: attempt.status });
  });
});

app.post('/api/exam/attempt/:id/answer', async (req, res) => {
  if (!validAttemptId(req, res)) return;
  await exam.withAttempt(req.params.id, async (attempt) => {
    if (!attempt) return badRequest(res, 'Exam attempt not found.', 404);
    const error = await exam.saveAnswer(attempt, req.body.index, req.body.answer ?? null);
    if (error) return badRequest(res, error, 409);
    res.json({ ok: true, currentIndex: attempt.currentIndex });
  });
});

app.post('/api/exam/attempt/:id/submit', async (req, res) => {
  if (!validAttemptId(req, res)) return;
  await exam.withAttempt(req.params.id, async (attempt) => {
    if (!attempt) return badRequest(res, 'Exam attempt not found.', 404);
    await exam.submitAttempt(attempt, req.body.answers, { auto: req.body.auto === true });
    res.json(exam.resultPayload(attempt, { includeReview: (await getSettings()).showCorrectAnswers }));
  });
});

app.get('/api/exam/attempt/:id/result', async (req, res) => {
  if (!validAttemptId(req, res)) return;
  await exam.withAttempt(req.params.id, async (attempt) => {
    if (!attempt) return badRequest(res, 'Exam attempt not found.', 404);
    if (attempt.status !== 'submitted') return badRequest(res, 'This exam has not been submitted yet.', 409);
    res.json(exam.resultPayload(attempt, { includeReview: (await getSettings()).showCorrectAnswers }));
  });
});

// ------------------------------------------------------------------ admin API

app.post('/api/admin/login', async (req, res) => {
  const ip = clientIp(req);
  if (await auth.isLockedOut(ip)) return badRequest(res, 'Too many failed attempts. Try again in 15 minutes.', 429);
  const { token, error } = await auth.login(ip, req.body.username, req.body.password);
  if (error) return badRequest(res, error, 401);
  res.set('Set-Cookie', auth.sessionCookie(token, req.secure));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', auth.clearCookie());
  res.json({ ok: true });
});

app.get('/api/admin/session', async (req, res) => {
  const username = await auth.sessionUser(req);
  res.json({ loggedIn: Boolean(username), username });
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

admin.get('/questions', async (req, res) => res.json(await store.listQuestions()));

admin.post('/questions', async (req, res) => {
  const { question, error } = validateQuestion(req.body);
  if (error) return badRequest(res, error);
  res.status(201).json(await store.createQuestion({ ...question, source: 'admin' }));
});

admin.put('/questions/:id', async (req, res) => {
  const { question, error } = validateQuestion(req.body);
  if (error) return badRequest(res, error);
  const existing = (await store.listQuestions()).find((q) => q.id === req.params.id);
  if (!existing) return badRequest(res, 'Question not found.', 404);
  const source = existing.source === 'derived' ? 'reviewed' : existing.source;
  res.json(await store.updateQuestion(req.params.id, { ...question, source }));
});

admin.delete('/questions/:id', async (req, res) => {
  if (!(await store.deleteQuestion(req.params.id))) return badRequest(res, 'Question not found.', 404);
  res.json({ ok: true });
});

admin.get('/settings', async (req, res) => res.json({ ...(await getSettings()), bankSize: await store.countQuestions() }));

admin.put('/settings', async (req, res) => {
  const b = req.body;
  const int = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  if (!int(b.questionsPerExam, 1, 500)) return badRequest(res, 'Questions per exam must be 1–500.');
  if (!int(b.timeLimitMinutes, 1, 600)) return badRequest(res, 'Time limit must be 1–600 minutes.');
  if (!int(b.maxAttempts, 1, 20)) return badRequest(res, 'Maximum attempts must be 1–20.');
  if (!int(b.passMark, 1, 100)) return badRequest(res, 'Pass mark must be 1–100.');
  if (!['linear', 'free'].includes(b.navigationMode)) return badRequest(res, 'Invalid navigation mode.');
  const settings = {
    questionsPerExam: Number(b.questionsPerExam),
    timeLimitMinutes: Number(b.timeLimitMinutes),
    maxAttempts: Number(b.maxAttempts),
    passMark: Number(b.passMark),
    navigationMode: b.navigationMode,
    showCorrectAnswers: Boolean(b.showCorrectAnswers),
  };
  await store.setKv('settings', settings);
  res.json(settings);
});

admin.get('/attempts', async (req, res) => {
  await exam.finalizeExpired();
  const all = await store.listAttempts();
  // Flag devices used under more than one student name: a sign that one
  // person is taking the exam for others, or retrying under a new name.
  const attempts = all
    .map((a) => {
      const names = new Set(all.filter((b) => matchesStudent(b, a)).map((b) => b.name.toLowerCase()));
      return { ...a, sharedDeviceNames: names.size > 1 ? names.size : 0 };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json(attempts);
});

admin.get('/attempts.csv', async (req, res) => {
  await exam.finalizeExpired();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'IP', 'Device ID', 'Started', 'Submitted', 'Status', 'Score', 'Total', 'Percent', 'Grade', 'Passed', 'Certificate ID', 'Auto-submitted']];
  for (const a of await store.listAttempts()) {
    rows.push([a.name, a.ip, a.deviceId, a.startedAt, a.submittedAt, a.status, a.score, a.total, a.percent, a.band, a.passed ? 'Yes' : a.status === 'submitted' ? 'No' : '', a.certificateId, a.autoSubmitted ? 'Yes' : '']);
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="networkversity-results.csv"');
  res.send('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'));
});

admin.get('/attempts/:id', async (req, res) => {
  if (!validAttemptId(req, res)) return;
  await exam.withAttempt(req.params.id, async (attempt) => {
    if (!attempt) return badRequest(res, 'Exam attempt not found.', 404);
    const includeReview = attempt.status === 'submitted';
    res.json({ ...exam.resultPayload(attempt, { includeReview }), ip: attempt.ip, deviceId: attempt.deviceId });
  });
});

// Deleting an attempt gives the student that attempt back.
admin.delete('/attempts/:id', async (req, res) => {
  if (!(await store.deleteAttempt(req.params.id))) return badRequest(res, 'Attempt not found.', 404);
  res.json({ ok: true });
});

admin.post('/reset-ip', async (req, res) => {
  const ip = String(req.body.ip || '').trim();
  if (!ip) return badRequest(res, 'IP address is required.');
  res.json({ ok: true, removed: await store.deleteAttemptsByIp(ip) });
});

admin.post('/reset-device', async (req, res) => {
  const deviceId = String(req.body.deviceId || '');
  if (!deviceId) return badRequest(res, 'Device ID is required.');
  res.json({ ok: true, removed: await store.deleteAttemptsByDevice(deviceId) });
});

admin.put('/password', async (req, res) => {
  const { current, next } = req.body;
  if (typeof next !== 'string' || next.length < 8) return badRequest(res, 'New password must be at least 8 characters.');
  if (typeof current !== 'string' || !(await auth.changePassword(current, next))) {
    return badRequest(res, 'Current password is incorrect.', 403);
  }
  res.json({ ok: true });
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => badRequest(res, 'Not found', 404));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// -------------------------------------------------------------------- pages
// (On Vercel the public/ folder is served directly and only /api reaches
// this app; see vercel.json.)

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin', 'index.html')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

export default app;

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`Networkversity exam running on http://localhost:${PORT}  (admin: /admin)  [storage: ${store.kind}]`);
  });
}
