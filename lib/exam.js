// Exam rules: drawing questions, saving answers, grading and grade bands.
import crypto from 'crypto';
import store, { getSettings } from './store.js';

// Answers that arrive this long after the deadline are ignored (network lag
// allowance for the browser's auto-submit). Past it, the attempt is graded
// on whatever answers were already saved.
export const GRACE_MS = 60 * 1000;

const BANDS = [
  { min: 81, label: 'Excellent' },
  { min: 71, label: 'Very Good' },
  { min: 61, label: 'Good' },
  { min: 51, label: 'Pass' },
  { min: 41, label: 'Fair' },
  { min: 0, label: 'Fail' },
];

export function gradeBand(percent) {
  return BANDS.find((b) => percent >= b.min).label;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function effectiveQuestionCount(settings) {
  return Math.min(settings.questionsPerExam, await store.countQuestions());
}

export async function startAttempt({ ip, deviceId, fingerprint }, name) {
  const settings = await getSettings();
  const picked = shuffle(await store.listQuestions()).slice(0, settings.questionsPerExam);
  const now = Date.now();
  const attempt = {
    id: crypto.randomUUID(),
    ip,
    deviceId,
    fingerprint,
    name,
    status: 'in_progress',
    startedAt: new Date(now).toISOString(),
    deadline: new Date(now + settings.timeLimitMinutes * 60 * 1000).toISOString(),
    navigationMode: settings.navigationMode,
    total: picked.length,
    currentIndex: 0,
    // Snapshot the questions so later edits in the question bank never change
    // a student's exam or its graded review.
    questions: picked.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      options: q.options,
      answer: q.answer,
      order: q.type === 'mc' ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i),
    })),
    answers: picked.map(() => null),
  };
  await store.saveAttempt(attempt);
  return attempt;
}

export function isValidAnswer(question, answer) {
  return Number.isInteger(answer) && answer >= 0 && answer < question.options.length;
}

export function isPastGrace(attempt) {
  return Date.now() > new Date(attempt.deadline).getTime() + GRACE_MS;
}

// Saves one answer. In linear mode only the current question may be
// answered, and answering it moves on to the next one for good.
// Returns an error message, or null on success.
export async function saveAnswer(attempt, index, answer) {
  if (attempt.status !== 'in_progress') return 'This exam has already been submitted.';
  if (isPastGrace(attempt)) return 'Time is up.';
  const question = attempt.questions[index];
  if (!question) return 'Invalid question.';
  if (attempt.navigationMode === 'linear') {
    if (index !== attempt.currentIndex) return 'You cannot go back to a previous question.';
    if (!isValidAnswer(question, answer)) return 'Please choose an answer.';
    attempt.answers[index] = answer;
    attempt.currentIndex = index + 1;
  } else {
    if (answer !== null && !isValidAnswer(question, answer)) return 'Invalid answer.';
    attempt.answers[index] = answer;
    attempt.currentIndex = index;
  }
  await store.saveAttempt(attempt);
  return null;
}

// Grades and closes the attempt. `incoming` (optional) is the browser's full
// answer list; it is ignored after the grace period and, in linear mode, for
// questions the student has already moved past.
export async function submitAttempt(attempt, incoming, { auto = false } = {}) {
  if (attempt.status !== 'in_progress') return attempt;
  const late = isPastGrace(attempt);
  if (Array.isArray(incoming) && !late) {
    const from = attempt.navigationMode === 'linear' ? attempt.currentIndex : 0;
    for (let i = from; i < attempt.questions.length; i++) {
      const a = incoming[i];
      if (a === null || isValidAnswer(attempt.questions[i], a)) attempt.answers[i] = a ?? attempt.answers[i];
    }
  }
  const score = attempt.questions.reduce((n, q, i) => n + (attempt.answers[i] === q.answer ? 1 : 0), 0);
  const percent = attempt.total ? Math.round((score / attempt.total) * 100) : 0;
  const { passMark } = await getSettings();
  Object.assign(attempt, {
    status: 'submitted',
    submittedAt: new Date().toISOString(),
    autoSubmitted: auto || late,
    score,
    percent,
    band: gradeBand(percent),
    passMark,
    passed: percent >= passMark,
  });
  if (attempt.passed) {
    attempt.certificateId = `NV-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }
  await store.saveAttempt(attempt);
  return attempt;
}

// Runs fn(attempt) on a fresh copy of the attempt while holding its lock, so
// two requests for the same attempt (double taps, two tabs) never overwrite
// each other's answers. Expired attempts are graded first.
export function withAttempt(id, fn) {
  return store.withLock(`attempt:${id}`, async () => {
    const attempt = await store.getAttempt(id);
    if (!attempt) return fn(null);
    if (attempt.status === 'in_progress' && isPastGrace(attempt)) await submitAttempt(attempt, null, { auto: true });
    return fn(attempt);
  });
}

// Closes in-progress attempts whose time (plus grace) has run out, so a
// student who closed the browser mid-exam still gets graded. There are no
// background jobs on serverless hosting; this runs whenever results are read.
export async function finalizeExpired(filter = () => true) {
  for (const summary of await store.listInProgress()) {
    if (!filter(summary)) continue;
    if (Date.now() <= new Date(summary.deadline).getTime() + GRACE_MS) continue;
    await withAttempt(summary.id, async () => {});
  }
}

// What the browser needs to run an in-progress exam. Correct answers are
// never included.
export function examPayload(attempt) {
  return {
    id: attempt.id,
    name: attempt.name,
    status: attempt.status,
    navigationMode: attempt.navigationMode,
    deadline: attempt.deadline,
    serverNow: new Date().toISOString(),
    currentIndex: attempt.currentIndex,
    answers: attempt.answers,
    questions: attempt.questions.map((q) => ({
      type: q.type,
      text: q.text,
      options: q.order.map((i) => ({ value: i, text: q.options[i] })),
    })),
  };
}

export function resultPayload(attempt, { includeReview }) {
  const result = {
    id: attempt.id,
    name: attempt.name,
    status: attempt.status,
    score: attempt.score,
    total: attempt.total,
    percent: attempt.percent,
    band: attempt.band,
    passed: attempt.passed,
    passMark: attempt.passMark,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    autoSubmitted: attempt.autoSubmitted,
    certificateId: attempt.certificateId || null,
  };
  if (includeReview) {
    result.review = attempt.questions.map((q, i) => ({
      type: q.type,
      text: q.text,
      options: q.order.map((o) => ({ value: o, text: q.options[o] })),
      yourAnswer: attempt.answers[i],
      correctAnswer: q.answer,
      correct: attempt.answers[i] === q.answer,
    }));
  }
  return result;
}
