(() => {
  const $ = (id) => document.getElementById(id);
  const ATTEMPT_KEY = 'nv_attempt_id';
  const KEYS = 'ABCDEF';

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function show(view) {
    for (const v of ['start', 'exam', 'result', 'loading']) $(`view-${v}`).classList.toggle('hidden', v !== view);
    window.scrollTo(0, 0);
  }

  function alertBox(el, type, msg) {
    el.innerHTML = '';
    if (!msg) return;
    const div = document.createElement('div');
    div.className = `alert ${type}`;
    div.textContent = msg;
    el.appendChild(div);
  }

  const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // ------------------------------------------------------------ start screen
  let status = null;

  async function loadStart() {
    show('loading');
    const stored = storage.get(ATTEMPT_KEY);
    try {
      status = await api(`/api/exam/status${stored ? `?attemptId=${encodeURIComponent(stored)}` : ''}`);
    } catch (e) {
      show('start');
      alertBox($('start-alert'), 'error', `Could not load the exam: ${e.message}`);
      return;
    }
    const s = status.settings;
    const rules = [
      `${s.questionsPerExam} questions — True/False and multiple choice, 1 point each`,
      `${s.timeLimitMinutes} minutes overall. The exam submits itself when time runs out`,
      s.navigationMode === 'linear'
        ? 'One question at a time. You cannot go back to a previous question'
        : 'Move freely between questions until you submit',
      `Pass mark: ${s.passMark} points. Passing earns a downloadable certificate`,
      `Attempts allowed: ${s.maxAttempts} (you have ${status.attemptsLeft} left)`,
    ];
    $('rules').innerHTML = '';
    for (const r of rules) {
      const li = document.createElement('li');
      li.textContent = r;
      $('rules').appendChild(li);
    }

    alertBox($('start-alert'), '', '');
    if (status.inProgress) {
      storage.set(ATTEMPT_KEY, status.inProgress.id);
      $('start-form').classList.add('hidden');
      $('resume-box').classList.remove('hidden');
      $('resume-name').textContent = status.inProgress.name ? ` for ${status.inProgress.name}` : '';
    } else {
      storage.del(ATTEMPT_KEY);
      $('resume-box').classList.add('hidden');
      $('start-form').classList.toggle('hidden', status.attemptsLeft === 0);
      if (status.attemptsLeft === 0) {
        alertBox($('start-alert'), 'warn', `You have used all ${s.maxAttempts} attempt(s) allowed for this exam. Your results are below.`);
      }
    }

    const body = $('history-body');
    body.innerHTML = '';
    for (const h of status.history) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td><td></td>';
      tr.children[0].textContent = fmtDate(h.submittedAt);
      tr.children[1].textContent = `${h.score}/${h.total}`;
      tr.children[2].textContent = h.band;
      const btn = document.createElement('button');
      btn.className = 'btn small secondary';
      btn.type = 'button';
      btn.textContent = h.passed ? 'Certificate' : 'View';
      btn.onclick = () => openResult(h.id);
      tr.children[3].appendChild(btn);
      body.appendChild(tr);
    }
    $('history-card').classList.toggle('hidden', status.history.length === 0);
    show('start');
  }

  $('start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('student-name').value.replace(/\s+/g, ' ').trim();
    if (name.length < 3) {
      alertBox($('start-alert'), 'error', 'Please enter your full name (at least 3 characters).');
      return;
    }
    $('start-btn').disabled = true;
    try {
      const exam = await api('/api/exam/start', { name });
      runExam(exam);
    } catch (err) {
      alertBox($('start-alert'), 'error', err.message);
    } finally {
      $('start-btn').disabled = false;
    }
  });

  $('resume-btn').addEventListener('click', async () => {
    $('resume-btn').disabled = true;
    try {
      const exam = await api('/api/exam/start', { attemptId: storage.get(ATTEMPT_KEY) });
      runExam(exam);
    } catch (err) {
      alertBox($('start-alert'), 'error', err.message);
    } finally {
      $('resume-btn').disabled = false;
    }
  });

  // -------------------------------------------------------------------- exam
  let exam = null;
  let index = 0;
  let clockOffset = 0;
  let timerHandle = null;
  let submitting = false;

  function runExam(payload) {
    exam = payload;
    storage.set(ATTEMPT_KEY, exam.id);
    clockOffset = new Date(exam.serverNow).getTime() - Date.now();
    submitting = false;
    const linear = exam.navigationMode === 'linear';
    index = Math.min(exam.currentIndex, exam.questions.length - 1);
    $('linear-controls').classList.toggle('hidden', !linear);
    $('linear-note').classList.toggle('hidden', !linear);
    $('free-controls').classList.toggle('hidden', linear);
    alertBox($('exam-alert'), '', '');
    if (!linear) buildNavGrid();
    renderQuestion();
    show('exam');
    clearInterval(timerHandle);
    tick();
    timerHandle = setInterval(tick, 500);
  }

  function remainingMs() {
    return new Date(exam.deadline).getTime() - (Date.now() + clockOffset);
  }

  function tick() {
    const ms = Math.max(0, remainingMs());
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const t = $('timer');
    t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    t.classList.toggle('warn', ms <= 5 * 60 * 1000 && ms > 60 * 1000);
    t.classList.toggle('danger', ms <= 60 * 1000);
    if (ms <= 0) {
      clearInterval(timerHandle);
      submit(true);
    }
  }

  function answeredCount() {
    return exam.answers.filter((a) => a !== null && a !== undefined).length;
  }

  function renderQuestion() {
    const q = exam.questions[index];
    const n = exam.questions.length;
    const linear = exam.navigationMode === 'linear';
    $('q-counter').textContent = `Question ${index + 1} of ${n}`;
    $('answered-count').textContent = `${answeredCount()} answered`;
    $('progress-fill').style.width = `${((linear ? index : answeredCount()) / n) * 100}%`;
    $('q-number').textContent = `Question ${index + 1}`;
    $('q-type').textContent = q.type === 'tf' ? 'True / False' : 'Multiple choice';
    $('q-text').textContent = q.text;

    const box = $('q-options');
    box.innerHTML = '';
    box.classList.toggle('tf', q.type === 'tf');
    q.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'option';
      b.setAttribute('role', 'radio');
      const selected = exam.answers[index] === opt.value;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-checked', String(selected));
      b.innerHTML = '<span class="key"></span><span></span>';
      b.children[0].textContent = q.type === 'tf' ? (opt.value === 0 ? '✓' : '✗') : KEYS[i];
      b.children[1].textContent = opt.text;
      b.onclick = () => choose(opt.value);
      box.appendChild(b);
    });

    if (linear) {
      const last = index === n - 1;
      $('next-btn').textContent = last ? 'Submit exam' : 'Next question →';
      $('next-btn').classList.toggle('green', last);
      $('next-btn').disabled = exam.answers[index] === null || exam.answers[index] === undefined;
    } else {
      $('prev-btn').disabled = index === 0;
      $('free-next-btn').disabled = index === n - 1;
      updateNavGrid();
    }
  }

  function choose(value) {
    if (submitting) return;
    exam.answers[index] = value;
    if (exam.navigationMode === 'free') {
      api(`/api/exam/attempt/${exam.id}/answer`, { index, answer: value }).catch(() => {
        // Not fatal: every answer is sent again on submit.
      });
    }
    renderQuestion();
  }

  $('next-btn').addEventListener('click', async () => {
    if (index === exam.questions.length - 1) return confirmSubmit();
    const btn = $('next-btn');
    btn.disabled = true;
    try {
      await api(`/api/exam/attempt/${exam.id}/answer`, { index, answer: exam.answers[index] });
      index += 1;
      alertBox($('exam-alert'), '', '');
      renderQuestion();
      window.scrollTo(0, 0);
    } catch (err) {
      if (err.status === 409 && /submitted|Time is up/.test(err.message)) return submit(true);
      alertBox($('exam-alert'), 'error', `${err.message} Check your connection and tap Next again.`);
      btn.disabled = false;
    }
  });

  function go(i) {
    index = Math.max(0, Math.min(exam.questions.length - 1, i));
    renderQuestion();
    window.scrollTo(0, 0);
  }
  $('prev-btn').addEventListener('click', () => go(index - 1));
  $('free-next-btn').addEventListener('click', () => go(index + 1));
  $('free-submit-btn').addEventListener('click', confirmSubmit);

  function buildNavGrid() {
    const grid = $('nav-grid');
    grid.innerHTML = '';
    exam.questions.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = i + 1;
      b.onclick = () => go(i);
      grid.appendChild(b);
    });
  }

  function updateNavGrid() {
    [...$('nav-grid').children].forEach((b, i) => {
      b.classList.toggle('answered', exam.answers[i] !== null && exam.answers[i] !== undefined);
      b.classList.toggle('current', i === index);
    });
  }

  function confirmSubmit() {
    const unanswered = exam.questions.length - answeredCount();
    $('confirm-unanswered').textContent = unanswered
      ? `You have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}. Unanswered questions score 0.`
      : `All ${exam.questions.length} questions answered.`;
    $('confirm-modal').classList.remove('hidden');
    $('confirm-ok').focus();
  }
  $('confirm-cancel').addEventListener('click', () => $('confirm-modal').classList.add('hidden'));
  $('confirm-ok').addEventListener('click', () => {
    $('confirm-modal').classList.add('hidden');
    submit(false);
  });

  async function submit(auto) {
    if (submitting) return;
    submitting = true;
    clearInterval(timerHandle);
    $('confirm-modal').classList.add('hidden');
    let attempt = 0;
    for (;;) {
      try {
        const result = await api(`/api/exam/attempt/${exam.id}/submit`, { answers: exam.answers, auto });
        storage.del(ATTEMPT_KEY);
        exam = null;
        showResult(result, auto ? "Time's up! Your exam was submitted automatically." : null);
        return;
      } catch (err) {
        attempt += 1;
        alertBox($('exam-alert'), 'error', `Submitting… could not reach the server (${err.message}). Retrying…`);
        await new Promise((r) => setTimeout(r, Math.min(15000, 2000 * attempt)));
      }
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (exam && !submitting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------ result
  let currentResult = null;

  async function openResult(id) {
    show('loading');
    try {
      showResult(await api(`/api/exam/attempt/${id}/result`));
    } catch (err) {
      show('start');
      alertBox($('start-alert'), 'error', err.message);
    }
  }

  function showResult(r, notice) {
    currentResult = r;
    alertBox($('result-alert'), 'info', notice || '');
    $('result-name').textContent = r.name;
    $('result-score').textContent = r.score;
    $('result-of').textContent = `out of ${r.total} points${r.total !== 100 ? ` (${r.percent}%)` : ''}`;
    const band = $('result-band');
    band.textContent = r.band;
    band.className = `band ${r.passed ? 'pass' : 'fail'}`;
    $('result-message').textContent = r.passed
      ? `Congratulations! You passed the Networkversity exam. Download your certificate below.`
      : `The pass mark is ${r.passMark}. Review the correct answers below to prepare for your next attempt.`;

    $('cert-card').classList.toggle('hidden', !r.passed);
    show('result');
    if (r.passed) {
      window.Certificate.draw($('cert-canvas'), certData(r)).catch(() => {});
    }

    const list = $('review-list');
    list.innerHTML = '';
    $('review-card').classList.toggle('hidden', !r.review);
    (r.review || []).forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'review-item';
      div.dataset.correct = String(item.correct);
      const q = document.createElement('div');
      q.className = 'q';
      q.textContent = `${i + 1}. ${item.correct ? '✅' : '❌'} ${item.text}`;
      div.appendChild(q);
      const ul = document.createElement('ul');
      for (const opt of item.options) {
        const li = document.createElement('li');
        const isCorrect = opt.value === item.correctAnswer;
        const isMine = opt.value === item.yourAnswer;
        if (isCorrect) li.className = 'correct';
        else if (isMine) li.className = 'wrong';
        li.textContent = `${opt.text}${isCorrect ? '  ← correct answer' : ''}${isMine && !isCorrect ? '  ← your answer' : ''}`;
        ul.appendChild(li);
      }
      if (item.yourAnswer === null || item.yourAnswer === undefined) {
        const li = document.createElement('li');
        li.className = 'small muted';
        li.textContent = 'Not answered';
        ul.appendChild(li);
      }
      div.appendChild(ul);
      list.appendChild(div);
    });
  }

  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      const f = b.dataset.filter;
      document.querySelectorAll('.review-item').forEach((el) => {
        el.classList.toggle('hidden', f !== 'all' && el.dataset.correct !== String(f === 'correct'));
      });
    });
  });

  function certData(r) {
    return {
      name: r.name,
      score: r.score,
      total: r.total,
      band: r.band,
      date: new Date(r.submittedAt),
      certificateId: r.certificateId,
    };
  }

  const fileBase = () => `Networkversity-Certificate-${currentResult.name.replace(/[^\p{L}\p{N}]+/gu, '-')}`;
  $('dl-png').addEventListener('click', () => window.Certificate.downloadPng(certData(currentResult), `${fileBase()}.png`));
  $('dl-pdf').addEventListener('click', () => window.Certificate.downloadPdf(certData(currentResult), `${fileBase()}.pdf`));
  $('back-home').addEventListener('click', loadStart);

  loadStart();
})();
