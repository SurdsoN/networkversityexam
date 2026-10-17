(() => {
  const $ = (id) => document.getElementById(id);
  const KEYS = 'ABCDEF';

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/admin/login') {
      showLogin();
      throw new Error('Your session has expired. Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function alertBox(el, type, msg) {
    el.innerHTML = '';
    if (!msg) return;
    const div = document.createElement('div');
    div.className = `alert ${type}`;
    div.textContent = msg;
    el.appendChild(div);
  }
  const flash = (type, msg) => {
    alertBox($('app-alert'), type, msg);
    if (type === 'success') setTimeout(() => alertBox($('app-alert'), '', ''), 3500);
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  // ------------------------------------------------------------------ auth
  function showLogin() {
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
  }

  async function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    await Promise.all([loadQuestions(), loadSettings()]);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', 'POST', { username: $('username').value.trim(), password: $('password').value });
      $('password').value = '';
      alertBox($('login-alert'), '', '');
      const s = await api('/api/admin/session');
      $('admin-user').textContent = s.username;
      showApp();
    } catch (err) {
      alertBox($('login-alert'), 'error', err.message);
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    await api('/api/admin/logout', 'POST').catch(() => {});
    showLogin();
  });

  // ------------------------------------------------------------------ tabs
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
      alertBox($('app-alert'), '', '');
      if (b.dataset.tab === 'results') loadResults();
      if (b.dataset.tab === 'settings') loadSettings();
    }),
  );

  // ------------------------------------------------------------- questions
  let questions = [];
  let settings = null;

  async function loadQuestions() {
    try {
      questions = await api('/api/admin/questions');
      renderQuestions();
    } catch (err) {
      flash('error', err.message);
    }
  }

  function renderSummary() {
    const tf = questions.filter((q) => q.type === 'tf').length;
    const derived = questions.filter((q) => q.source === 'derived').length;
    const perExam = settings ? settings.questionsPerExam : 100;
    let text = `${questions.length} questions in the bank (${tf} True/False, ${questions.length - tf} multiple choice). Each exam draws ${Math.min(perExam, questions.length)} at random.`;
    if (questions.length < perExam) text += ` ⚠ The bank has fewer than the ${perExam} questions per exam set in Settings.`;
    if (derived) text += ` ${derived} questions marked "derived" were reworded from the course material to reach 100. Please check them; editing and saving one marks it reviewed.`;
    $('bank-summary').textContent = text;
  }

  function renderQuestions() {
    renderSummary();
    const term = $('q-search').value.trim().toLowerCase();
    const filter = $('q-filter').value;
    const list = $('q-list');
    list.innerHTML = '';
    const shown = questions.filter((q) => {
      if (filter === 'tf' || filter === 'mc') { if (q.type !== filter) return false; }
      if (filter === 'derived' && q.source !== 'derived') return false;
      return !term || q.text.toLowerCase().includes(term) || q.options.some((o) => o.toLowerCase().includes(term));
    });
    if (!shown.length) list.appendChild(el('p', 'muted center', 'No questions match.'));
    for (const q of shown) {
      const row = el('div', 'q-row');
      const top = el('div', 'top');
      const left = el('div');
      const tags = el('div');
      tags.style.marginBottom = '4px';
      tags.append(el('span', 'tag', q.id), ' ', el('span', 'tag', q.type === 'tf' ? 'True / False' : 'Multiple choice'));
      if (q.source === 'derived') tags.append(' ', el('span', 'tag derived', 'derived — needs review'));
      if (q.source === 'admin') tags.append(' ', el('span', 'tag admin', 'added by admin'));
      left.append(tags, el('div', 'text', q.text));
      const ol = el('ol');
      ol.type = q.type === 'tf' ? '1' : 'A';
      q.options.forEach((o, i) => {
        const li = el('li', i === q.answer ? 'correct' : '', o + (i === q.answer ? '  ✓' : ''));
        ol.appendChild(li);
      });
      left.appendChild(ol);
      const actions = el('div', 'actions');
      const edit = el('button', 'btn small secondary', 'Edit');
      edit.type = 'button';
      edit.onclick = () => openEditor(q);
      const del = el('button', 'btn small danger', 'Delete');
      del.type = 'button';
      del.onclick = () => deleteQuestion(q);
      actions.append(edit, del);
      top.append(left, actions);
      row.appendChild(top);
      list.appendChild(row);
    }
  }
  $('q-search').addEventListener('input', renderQuestions);
  $('q-filter').addEventListener('change', renderQuestions);

  async function deleteQuestion(q) {
    if (!confirm(`Delete this question?\n\n"${q.text}"\n\nExams already taken keep their copy of it.`)) return;
    try {
      await api(`/api/admin/questions/${q.id}`, 'DELETE');
      questions = questions.filter((x) => x.id !== q.id);
      renderQuestions();
      flash('success', 'Question deleted.');
    } catch (err) {
      flash('error', err.message);
    }
  }

  // question editor
  let editing = null;

  function addOptionRow(text = '', checked = false) {
    const box = $('qf-options');
    if (box.children.length >= 6) return;
    const row = el('div', 'opt-edit');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'qf-correct';
    radio.checked = checked;
    radio.setAttribute('aria-label', 'Correct answer');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = text;
    input.maxLength = 300;
    const rm = el('button', 'btn small secondary', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove option');
    rm.onclick = () => {
      if (box.children.length > 2) row.remove();
      relabel();
    };
    row.append(radio, input, rm);
    box.appendChild(row);
    relabel();
  }

  function relabel() {
    [...$('qf-options').children].forEach((row, i) => {
      row.children[1].placeholder = `Option ${KEYS[i]}`;
    });
    $('qf-add-opt').disabled = $('qf-options').children.length >= 6;
  }

  function syncType() {
    const tf = $('qf-type').value === 'tf';
    $('qf-tf').classList.toggle('hidden', !tf);
    $('qf-mc').classList.toggle('hidden', tf);
  }
  $('qf-type').addEventListener('change', syncType);
  $('qf-add-opt').addEventListener('click', () => addOptionRow());

  function openEditor(q) {
    editing = q || null;
    $('q-modal-title').textContent = q ? `Edit question ${q.id}` : 'Add question';
    alertBox($('q-form-alert'), '', '');
    $('qf-type').value = q ? q.type : 'mc';
    $('qf-text').value = q ? q.text : '';
    document.querySelectorAll('input[name="qf-tf"]').forEach((r) => {
      r.checked = Boolean(q && q.type === 'tf' && Number(r.value) === q.answer);
    });
    $('qf-options').innerHTML = '';
    if (q && q.type === 'mc') q.options.forEach((o, i) => addOptionRow(o, i === q.answer));
    else for (let i = 0; i < 4; i++) addOptionRow();
    syncType();
    $('q-modal').classList.remove('hidden');
    $('qf-text').focus();
  }
  $('add-q-btn').addEventListener('click', () => openEditor(null));
  $('qf-cancel').addEventListener('click', () => $('q-modal').classList.add('hidden'));

  $('q-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = $('qf-type').value;
    const body = { type, text: $('qf-text').value.trim() };
    if (type === 'tf') {
      const picked = document.querySelector('input[name="qf-tf"]:checked');
      body.answer = picked ? Number(picked.value) : -1;
    } else {
      const rows = [...$('qf-options').children];
      body.options = rows.map((r) => r.children[1].value.trim());
      body.answer = rows.findIndex((r) => r.children[0].checked);
    }
    try {
      const saved = editing
        ? await api(`/api/admin/questions/${editing.id}`, 'PUT', body)
        : await api('/api/admin/questions', 'POST', body);
      if (editing) questions = questions.map((q) => (q.id === saved.id ? saved : q));
      else questions.push(saved);
      $('q-modal').classList.add('hidden');
      renderQuestions();
      flash('success', editing ? 'Question updated.' : 'Question added.');
    } catch (err) {
      alertBox($('q-form-alert'), 'error', err.message);
    }
  });

  // --------------------------------------------------------------- results
  let attempts = [];

  async function loadResults() {
    try {
      attempts = await api('/api/admin/attempts');
      renderResults();
    } catch (err) {
      flash('error', err.message);
    }
  }

  function renderResults() {
    const done = attempts.filter((a) => a.status === 'submitted');
    const passed = done.filter((a) => a.passed).length;
    const avg = done.length ? Math.round(done.reduce((n, a) => n + a.percent, 0) / done.length) : 0;
    const stats = $('stats');
    stats.innerHTML = '';
    for (const [label, value] of [
      ['Exams submitted', done.length],
      ['In progress', attempts.length - done.length],
      ['Passed', passed],
      ['Pass rate', done.length ? `${Math.round((passed / done.length) * 100)}%` : '—'],
      ['Average score', done.length ? `${avg}%` : '—'],
    ]) {
      const d = el('div');
      d.append(el('b', '', String(value)), el('span', 'small muted', label));
      stats.appendChild(d);
    }

    const term = $('r-search').value.trim().toLowerCase();
    const body = $('r-body');
    body.innerHTML = '';
    const shown = attempts.filter((a) => !term || a.name.toLowerCase().includes(term) || a.ip.includes(term));
    if (!shown.length) {
      const tr = el('tr');
      const td = el('td', 'muted center', 'No exam attempts yet.');
      td.colSpan = 7;
      tr.appendChild(td);
      body.appendChild(tr);
    }
    for (const a of shown) {
      const tr = el('tr');
      const submitted = a.status === 'submitted';
      tr.append(
        el('td', '', a.name),
        el('td', 'small', a.ip),
        el('td', 'small', fmtDateTime(a.submittedAt || a.startedAt)),
        el('td', '', submitted ? `${a.score}/${a.total}` : '—'),
        el('td', '', submitted ? a.band : '—'),
      );
      const st = el('td');
      st.appendChild(
        el('span', `tag ${submitted ? (a.passed ? 'admin' : 'derived') : ''}`, submitted ? (a.passed ? 'Passed' : 'Not passed') + (a.autoSubmitted ? ' · timed out' : '') : 'In progress'),
      );
      tr.appendChild(st);
      const act = el('td');
      act.style.whiteSpace = 'nowrap';
      const view = el('button', 'btn small secondary', 'View');
      view.type = 'button';
      view.onclick = () => openAttempt(a.id);
      const del = el('button', 'btn small danger', 'Delete');
      del.type = 'button';
      del.style.marginLeft = '6px';
      del.onclick = () => deleteAttempt(a);
      act.append(view, del);
      tr.appendChild(act);
      body.appendChild(tr);
    }
  }
  $('r-search').addEventListener('input', renderResults);

  async function deleteAttempt(a) {
    if (!confirm(`Delete ${a.name}'s attempt from ${fmtDateTime(a.startedAt)}?\n\nThis gives IP ${a.ip} one attempt back. The result and certificate record are removed.`)) return;
    try {
      await api(`/api/admin/attempts/${a.id}`, 'DELETE');
      flash('success', 'Attempt deleted.');
      loadResults();
    } catch (err) {
      flash('error', err.message);
    }
  }

  $('reset-ip-btn').addEventListener('click', async () => {
    const ip = prompt('Reset all attempts for which IP address?\n\nThe student on that IP will be able to take the exam again. Their past results are deleted.');
    if (!ip || !ip.trim()) return;
    try {
      const r = await api('/api/admin/reset-ip', 'POST', { ip: ip.trim() });
      flash('success', `Removed ${r.removed} attempt(s) for ${ip.trim()}.`);
      loadResults();
    } catch (err) {
      flash('error', err.message);
    }
  });

  let viewing = null;
  async function openAttempt(id) {
    try {
      const r = await api(`/api/admin/attempts/${id}`);
      viewing = r;
      $('a-title').textContent = r.name;
      $('a-meta').textContent =
        r.status === 'submitted'
          ? `IP ${r.ip} · started ${fmtDateTime(r.startedAt)} · submitted ${fmtDateTime(r.submittedAt)}${r.autoSubmitted ? ' (time ran out)' : ''} · ${r.score}/${r.total} · ${r.band}${r.certificateId ? ` · Certificate ${r.certificateId}` : ''}`
          : `IP ${r.ip} · started ${fmtDateTime(r.startedAt)} · still in progress`;
      $('a-cert').classList.toggle('hidden', !r.passed);
      if (r.passed) window.Certificate.draw($('a-cert-canvas'), certData(r)).catch(() => {});
      const box = $('a-review');
      box.innerHTML = '';
      (r.review || []).forEach((item, i) => {
        const div = el('div', 'review-item');
        div.appendChild(el('div', 'q', `${i + 1}. ${item.correct ? '✅' : '❌'} ${item.text}`));
        const ul = el('ul');
        for (const opt of item.options) {
          const isCorrect = opt.value === item.correctAnswer;
          const isMine = opt.value === item.yourAnswer;
          ul.appendChild(el('li', isCorrect ? 'correct' : isMine ? 'wrong' : '', `${opt.text}${isCorrect ? '  ← correct' : ''}${isMine && !isCorrect ? '  ← student' : ''}`));
        }
        if (item.yourAnswer === null) ul.appendChild(el('li', 'small muted', 'Not answered'));
        div.appendChild(ul);
        box.appendChild(div);
      });
      $('a-modal').classList.remove('hidden');
    } catch (err) {
      flash('error', err.message);
    }
  }
  const certData = (r) => ({ name: r.name, score: r.score, total: r.total, band: r.band, date: new Date(r.submittedAt), certificateId: r.certificateId });
  $('a-close').addEventListener('click', () => $('a-modal').classList.add('hidden'));
  $('a-cert-dl').addEventListener('click', () => {
    if (viewing) window.Certificate.downloadPdf(certData(viewing), `Networkversity-Certificate-${viewing.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf`);
  });

  // -------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      settings = await api('/api/admin/settings');
      $('s-count').value = settings.questionsPerExam;
      $('s-time').value = settings.timeLimitMinutes;
      $('s-attempts').value = settings.maxAttempts;
      $('s-pass').value = settings.passMark;
      $('s-nav').value = settings.navigationMode;
      $('s-show').checked = settings.showCorrectAnswers;
      $('s-count-note').textContent = `The question bank currently holds ${settings.bankSize} questions. If it holds fewer than this number, every exam uses the whole bank.`;
      renderSummary();
    } catch (err) {
      flash('error', err.message);
    }
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const saved = await api('/api/admin/settings', 'PUT', {
        questionsPerExam: Number($('s-count').value),
        timeLimitMinutes: Number($('s-time').value),
        maxAttempts: Number($('s-attempts').value),
        passMark: Number($('s-pass').value),
        navigationMode: $('s-nav').value,
        showCorrectAnswers: $('s-show').checked,
      });
      settings = { ...settings, ...saved };
      renderSummary();
      flash('success', 'Settings saved.');
    } catch (err) {
      flash('error', err.message);
    }
  });

  // --------------------------------------------------------------- account
  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('pw-new').value !== $('pw-confirm').value) return flash('error', 'The new passwords do not match.');
    try {
      await api('/api/admin/password', 'PUT', { current: $('pw-current').value, next: $('pw-new').value });
      e.target.reset();
      flash('success', 'Password updated.');
    } catch (err) {
      flash('error', err.message);
    }
  });

  // ------------------------------------------------------------------ boot
  api('/api/admin/session')
    .then((s) => {
      if (!s.loggedIn) return showLogin();
      $('admin-user').textContent = s.username;
      showApp();
    })
    .catch(showLogin);
})();
