/* ============ FlagQuest frontend ============ */
'use strict';

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => n.toLocaleString('en-US');
const fmtPop = (millions) => {
  if (millions >= 1000) return `${(millions / 1000).toFixed(1)} billion`;
  if (millions >= 1) return `${Math.round(millions)} million`;
  return `${Math.max(1, Math.round(millions * 1000))} thousand`;
};
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- sound (WebAudio, no external files) ----------
const SFX = {
  ctx: null, muted: store.get('fq_muted', false),
  ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } return this.ctx; },
  tone(freq, dur, type = 'sine', gain = 0.12, delay = 0) {
    if (this.muted) return;
    const ctx = this.ensure(); if (!ctx || ctx.state === 'suspended') { if (ctx) ctx.resume(); }
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.05);
  },
  click() { this.tone(620, 0.06, 'triangle', 0.05); },
  tick() { this.tone(880, 0.05, 'sine', 0.035); },
  correct() { this.tone(523, 0.13, 'triangle', 0.1); this.tone(659, 0.13, 'triangle', 0.1, 0.09); this.tone(784, 0.2, 'triangle', 0.12, 0.18); },
  wrong() { this.tone(196, 0.28, 'sawtooth', 0.06); this.tone(150, 0.3, 'sawtooth', 0.05, 0.06); },
  streak(n) { this.tone(700 + n * 90, 0.1, 'sine', 0.08); },
  finish(win) {
    if (win) { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.1, i * 0.11)); }
    else { [392, 330, 262].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.08, i * 0.14)); }
  },
};

// ---------- toast ----------
function toast(msg, type = 'info', ms = 3200) {
  const t = el('div', `toast ${type}`, msg);
  $('#toast-wrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

// ---------- state ----------
const CONFIG = { data: null };
const settings = {
  region: store.get('fq_region', 'all'),
  difficulty: store.get('fq_difficulty', 'easy'),
  mode: store.get('fq_mode', 'flag2name'),
  style: store.get('fq_style', 'classic'),
  count: store.get('fq_count', 10),
  name: store.get('fq_name', ''),
};
const game = {
  id: null, questions: [], idx: 0, timeLimit: 0, maxHints: 3, hintsLeft: 0,
  score: 0, streak: 0, bestStreak: 0, maxScore: 0, difficulty: '', region: '', mode: '', style: 'classic',
  results: [], answering: false, revealed: false,
  bank: null, lives: null, daily: false, autoAdvance: false,
  bankEnd: 0, partyWait: false,
};
const time = { end: 0, raf: 0, running: false, pausedRemaining: null, lastSecond: -1 };
const party = {
  active: false, code: null, playerId: null, token: null, room: null,
  es: null, questions: null, answered: 0, results: [], ended: false,
  settings: null, theoreticalMax: null, resultsShown: false, resultTimer: null, starting: false, isHost: false,
};
let lastSummary = null;

// ---------- API ----------
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      method: opts.method || 'GET',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    toast('Cannot reach the server — is it still running?', 'error', 4200);
    throw new Error('network');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    toast(msg, 'error');
    throw new Error(msg);
  }
  return data;
}

// ---------- screens ----------
const SCREENS = ['home', 'game', 'result', 'party', 'lobby'];
function show(name) {
  for (const s of SCREENS) {
    const node = $(`#screen-${s}`);
    if (node) node.hidden = s !== name;
  }
  window.scrollTo({ top: 0 });
}
function stopPartyStream() {
  if (party.es) { try { party.es.close(); } catch {} party.es = null; }
  clearResultTimer();
}
function clearResultTimer() {
  if (party.resultTimer) { clearTimeout(party.resultTimer); party.resultTimer = null; }
}

// ---------- home ----------
function buildHome() {
  const cfg = CONFIG.data;
  const dGrid = $('#difficulty-grid');
  dGrid.innerHTML = '';
  for (const d of cfg.difficulties) {
    const best = store.get(`fq_best_${d.id}`, 0);
    const card = el('button', 'dcard', '');
    card.type = 'button';
    card.setAttribute('role', 'radio');
    const head = el('div', 'dc-head'); head.append(el('span', '', d.icon), el('span', '', d.name));
    card.append(head, el('div', 'dc-desc', d.desc));
    if (best > 0) card.append(el('div', 'dc-best', `Best: ${fmt(best)}`));
    card.dataset.id = d.id;
    card.onclick = () => { SFX.click(); if (d.typed) settings.mode = 'flag2name'; settings.difficulty = d.id; buildHome(); };
    dGrid.appendChild(card);
  }

  const rGrid = $('#region-grid');
  rGrid.innerHTML = '';
  for (const r of cfg.regions) {
    const chip = el('button', 'chip', '');
    chip.type = 'button';
    chip.append(el('span', '', r.icon), el('span', '', r.name), el('span', 'c-count', `${r.countries}`));
    chip.title = `${r.name} · ${r.countries} flags`;
    chip.dataset.id = r.id;
    chip.onclick = () => { SFX.click(); settings.region = r.id; buildHome(); };
    rGrid.appendChild(chip);
  }

  const mGrid = $('#mode-grid');
  mGrid.innerHTML = '';
  const expertOn = settings.difficulty === 'expert';
  for (const m of cfg.modes) {
    const card = el('button', `dcard ${expertOn ? 'disabled' : ''}`, '');
    card.type = 'button';
    card.style.minHeight = '64px';
    const head = el('div', 'dc-head'); head.append(el('span', '', m.icon), el('span', '', m.name));
    card.append(head, el('div', 'dc-desc', m.desc));
    card.dataset.id = m.id;
    card.onclick = () => { SFX.click(); settings.mode = m.id; buildHome(); };
    card.setAttribute('aria-disabled', String(expertOn));
    mGrid.appendChild(card);
  }
  if (expertOn) {
    const hint = $('#field-region .field-hint');
    if (hint) hint.textContent = 'Expert is flag → typing only';
  } else {
    const hint = $('#field-region .field-hint');
    if (hint) hint.textContent = 'who do you know best?';
  }

  const lGrid = $('#length-grid');
  lGrid.innerHTML = '';
  const endless = settings.style === 'blitz' || settings.style === 'survival';
  for (const n of cfg.lengths) {
    const b = el('button', 'seg-btn', String(n));
    b.type = 'button';
    b.disabled = endless;
    b.title = endless ? `Round count is automatic in ${settings.style} mode` : '';
    b.onclick = () => { SFX.click(); settings.count = n; buildHome(); };
    b.dataset.val = String(n);
    lGrid.appendChild(b);
  }

  const sGrid = $('#style-grid');
  sGrid.innerHTML = '';
  for (const s of cfg.styles) {
    const card = el('button', 'dcard', '');
    card.type = 'button';
    card.style.minHeight = '70px';
    const head = el('div', 'dc-head'); head.append(el('span', '', s.icon), el('span', '', s.name));
    card.append(head, el('div', 'dc-desc', s.desc));
    card.dataset.id = s.id;
    card.onclick = () => { SFX.click(); settings.style = s.id; buildHome(); };
    sGrid.appendChild(card);
  }

  // reflect state
  dGrid.querySelectorAll('.dcard').forEach((c) => {
    c.classList.toggle('selected', c.dataset.id === settings.difficulty);
    c.setAttribute('aria-checked', String(c.dataset.id === settings.difficulty));
  });
  rGrid.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', c.dataset.id === settings.region));
  mGrid.querySelectorAll('.dcard').forEach((c) => {
    c.classList.toggle('selected', c.dataset.id === settings.mode && !expertOn);
    c.setAttribute('aria-checked', String(c.dataset.id === settings.mode && !expertOn));
  });
  sGrid.querySelectorAll('.dcard').forEach((c) => c.classList.toggle('selected', c.dataset.id === settings.style));
  lGrid.querySelectorAll('.seg-btn').forEach((c) => c.classList.toggle('selected', Number(c.dataset.val) === settings.count));
  $('#player-name').value = settings.name;
  const note = $('#daily-note');
  if (note) {
    const done = store.get(`fq_daily_${dailyKey()}`, false);
    note.innerHTML = done
      ? '<span class="done">✓ completed today — new set at midnight</span>'
      : '10 questions · same set for everyone today';
  }
}

function dailyKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadHomeStats() {
  try {
    const s = await api('/stats');
    const wrap = $('#home-stats');
    wrap.innerHTML = '';
    const add = (label, value) => {
      const d = el('div');
      d.append(el('span', '', `${label} `), Object.assign(el('b'), { textContent: value }));
      wrap.appendChild(d);
    };
    add('🌍 flags in the pool:', String(s.countries));
    add('🎮 games played globally:', fmt(s.gamesPlayed));
    add('❓ questions answered:', fmt(s.questionsAnswered));
    add('🎯 global accuracy:', `${s.accuracy}%`);
    const myBest = store.get(`fq_best_${settings.difficulty}`, 0);
    if (myBest > 0) add('🥇 your best:', `${fmt(myBest)} (${settings.difficulty})`);
  } catch { /* stats are decorative */ }
}

// ---------- start game ----------
async function startGame(opts = {}) {
  const daily = !!opts.daily;
  if (!daily) {
    settings.name = $('#player-name').value.trim().slice(0, 20);
    store.set('fq_name', settings.name);
    store.set('fq_region', settings.region);
    store.set('fq_difficulty', settings.difficulty);
    store.set('fq_mode', settings.difficulty === 'expert' ? 'flag2name' : settings.mode);
    store.set('fq_style', settings.style);
    store.set('fq_count', settings.count);
  }
  SFX.click();
  try {
    const data = await api('/game', {
      method: 'POST',
      body: daily
        ? { region: settings.region, difficulty: settings.difficulty, mode: 'flag2name', daily: true, name: settings.name }
        : {
            region: settings.region, difficulty: settings.difficulty, mode: settings.mode,
            style: settings.style, count: settings.count, name: settings.name,
          },
    });
    startGameSession(data);
  } catch (e) {
    if (e.message !== 'network') toast('Could not start the game.', 'error');
  }
}

function startGameSession(data) {
  stopPartyStream();
  party.active = false;
  party.questions = null;
  party.room = null;
  $('#party-strip').hidden = true;
  Object.assign(game, {
    partyWait: false,
    id: data.gameId, questions: data.questions, idx: 0, timeLimit: data.timeLimit,
    maxHints: data.maxHints, hintsLeft: data.maxHints, score: 0, streak: 0, bestStreak: 0,
    maxScore: data.theoreticalMax, difficulty: data.difficulty, region: data.region, mode: data.mode,
    style: data.style || 'classic', daily: !!data.daily, bank: data.bank || null,
    lives: data.lives || null, results: [], answering: false, revealed: false,
    autoAdvance: data.style === 'blitz' || data.style === 'survival',
    bankEnd: data.bank ? performance.now() + data.bank * 1000 : 0,
    _lastAdvance: 0,
  });
  renderHUD(); show('game'); renderQuestion();
}

// ---------- HUD ----------
function renderHUD() {
  const diff = CONFIG.data.difficulties.find((d) => d.id === game.difficulty);
  const reg = CONFIG.data.regions.find((r) => r.id === game.region);
  const styleObj = CONFIG.data.styles.find((s) => s.id === game.style);
  $('#hud-diff').innerHTML = `${diff.icon} ${diff.name}${styleObj && game.style !== 'classic' ? ` · ${styleObj.icon}` : ''}`;
  $('#hud-region').innerHTML = `${reg.icon} ${reg.name}`;
  const endLabel = game.autoAdvance ? 'Questions left' : '';
  $('#hud-question').textContent = game.autoAdvance ? 'Endless — go go go!' : `Question 1 of ${game.questions.length}`;
  $('#hud-question').dataset.mode = game.autoAdvance ? 'endless' : 'classic';
  const bank = $('#hud-bank');
  bank.hidden = !game.bank;
  if (game.bank) bank.textContent = `⏱️ ${game.bank}s`;
  const lives = $('#hud-lives');
  lives.hidden = !game.lives;
  if (game.lives) lives.textContent = '❤️'.repeat(game.lives);
  updateScoreUI(0, false); updateStreakUI(0);
  $('#progress-bar').style.width = '0%';
  $('#bank-label')?.remove();
}

function updateScoreUI(score, bump = true) {
  const pill = $('#hud-score');
  pill.textContent = fmt(score);
  if (bump) { pill.classList.remove('bump'); void pill.offsetWidth; pill.classList.add('bump'); }
}
function updateStreakUI(streak) {
  const pill = $('#hud-streak');
  pill.textContent = streak >= 2 ? `🔥 ${streak}` : '–';
  pill.classList.toggle('hot', streak >= 3);
}

// ---------- timer ----------
function startTimer() {
  stopTimer();
  stopBank();
  time.running = true;
  time.end = performance.now() + game.timeLimit * 1000;
  time.lastSecond = -1;
  const fill = $('#timer-fill');
  fill.classList.remove('warn', 'danger');
  if (game.bank) startBankLoop();
  const loop = () => {
    if (!time.running) return;
    const leftMs = Math.max(0, time.end - performance.now());
    const totalMs = game.timeLimit * 1000;
    const pct = (leftMs / totalMs) * 100;
    fill.style.width = `${pct}%`;
    const secs = Math.ceil(leftMs / 1000);
    if (secs !== time.lastSecond) {
      time.lastSecond = secs;
      if (secs <= 5 && secs > 0) SFX.tick();
      fill.classList.toggle('warn', pct <= 40 && pct > 18);
      fill.classList.toggle('danger', pct <= 18);
    }
    if (leftMs <= 0) { onTimeout(); return; }
    time.raf = requestAnimationFrame(loop);
  };
  time.raf = requestAnimationFrame(loop);
}
function stopTimer() { time.running = false; if (time.raf) cancelAnimationFrame(time.raf); }

// Blitz time-bank loop (client-side clock; server score stays authoritative)
let bankRaf = 0;
function startBankLoop() {
  cancelAnimationFrame(bankRaf);
  const pill = $('#hud-bank');
  const loop = () => {
    if (!game.bank || !time.running) return;
    const leftMs = Math.max(0, game.bankEnd - performance.now());
    const secs = (leftMs / 1000).toFixed(1);
    pill.textContent = `⏱️ ${secs}s`;
    pill.classList.toggle('low', leftMs < 10000);
    if (leftMs <= 0) {
      finishGame(true);
      return;
    }
    bankRaf = requestAnimationFrame(loop);
  };
  bankRaf = requestAnimationFrame(loop);
}
function stopBank() {
  if (bankRaf) cancelAnimationFrame(bankRaf);
  bankRaf = 0;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && time.running) {
    time.pausedRemaining = time.end - performance.now();
    if (time.raf) cancelAnimationFrame(time.raf);
  } else if (!document.hidden && time.pausedRemaining !== null && time.running) {
    time.end = performance.now() + time.pausedRemaining;
    time.pausedRemaining = null;
    const loop = () => {
      if (!time.running) return;
      const leftMs = Math.max(0, time.end - performance.now());
      $('#timer-fill').style.width = `${(leftMs / (game.timeLimit * 1000)) * 100}%`;
      if (leftMs <= 0) { onTimeout(); return; }
      time.raf = requestAnimationFrame(loop);
    };
    time.raf = requestAnimationFrame(loop);
  }
});

// ---------- render question ----------
function renderQuestion() {
  const q = game.questions[game.idx];
  if (!q) return;
  game.revealed = false;
  game.answering = false;
  game.partyWait = false;

  $('#progress-bar').style.width = `${(game.idx / game.questions.length) * 100}%`;
  if (game.autoAdvance) {
    $('#hud-question').textContent = `${game.idx + 1} answered of ${game.questions.length} max · ${game.style === 'survival' ? 'survive!' : 'beat the clock!'}`;
  } else {
    $('#hud-question').textContent = `Question ${game.idx + 1} of ${game.questions.length}`;
  }
  const livesEl = $('#hud-lives');
  if (game.lives !== null) livesEl.textContent = '❤️'.repeat(Math.max(0, game.lives)) + '🖤'.repeat(Math.max(0, 3 - Math.max(0, game.lives)));
  $('#reveal-card').hidden = true;
  $('#hint-count').textContent = ` (${game.hintsLeft})`;
  $('#btn-hint').disabled = game.hintsLeft === 0;
  $('#btn-hint').title = game.hintsLeft === 0 ? 'No hints left' : `${game.hintsLeft} hint(s) left — costs 50 points when points are earned`;
  $('#hint-label').textContent = q.type === 'typed' ? 'Letter' : '50/50';
  $('#btn-skip').disabled = false;

  const stage = $('#flag-stage');
  const options = $('#options');
  const typeArea = $('#type-area');
  options.innerHTML = '';
  options.hidden = false;
  typeArea.hidden = true;
  stage.innerHTML = '';

  if (q.type === 'text') {
    insertFlag(q.imageUrl);
    stage.append(el('div', 'prompt-sub', 'Which country does this flag belong to?'));
    const big = game.difficulty === 'easy';
    options.classList.toggle('single-col', big);
    q.options.forEach((name, i) => {
      const b = el('button', 'opt-btn', '');
      b.type = 'button';
      b.append(el('span', 'opt-num', String(i + 1)), el('span', '', name));
      b.onclick = () => submitOption(i, b);
      options.appendChild(b);
    });
  } else if (q.type === 'flags') {
    stage.append(el('div', 'prompt-name', q.prompt), el('div', 'prompt-sub', 'Pick the matching flag'));
    options.classList.remove('single-col');
    q.options.forEach((o, i) => {
      const b = el('button', 'opt-btn');
      b.type = 'button';
      b.append(el('span', 'opt-num', String(i + 1)));
      const img = el('img'); img.src = o.url; img.alt = 'Flag option'; img.draggable = false;
      if (q.options.length === 2) img.classList.add('bigger');
      b.appendChild(img);
      b.onclick = () => submitOption(i, b);
      options.appendChild(b);
    });
  } else if (q.type === 'typed') {
    insertFlag(q.imageUrl);
    stage.append(el('div', 'prompt-sub', 'Type the name of this country'));
    typeArea.hidden = false;
    $('#type-input').value = '';
    setTimeout(() => $('#type-input').focus(), 60);
  }

  startTimer();
  // preload next flag
  const nxt = game.questions[game.idx + 1];
  if (nxt && (nxt.type === 'typed' || nxt.type === 'text') && nxt.imageUrl) {
    new Image().src = nxt.imageUrl;
  }
}

function insertFlag(src) {
  const stage = $('#flag-stage');
  const skeleton = el('div', 'flag-skeleton');
  const img = el('img', 'flag-img');
  img.src = src; img.alt = 'Which country is this?'; img.draggable = false;
  img.style.display = 'none';
  img.onload = () => { skeleton.remove(); img.style.display = ''; };
  img.onerror = () => { skeleton.remove(); img.style.display = ''; img.alt = 'Flag image unavailable'; };
  stage.append(skeleton, img);
  return img;
}

// ---------- answering ----------
async function submit(type, payload, clickedBtn) {
  if (game.answering || game.revealed) return;
  game.answering = true;
  stopTimer();
  const timeLeft = Math.max(0, Math.round((time.end - performance.now()) / 1000));

  let res;
  try {
    res = party.active
      ? await api(`/room/${party.code}/answer`, {
          method: 'POST',
          body: { playerId: party.playerId, token: party.token, questionIndex: game.idx, ...payload, timeLeft },
        })
      : await api(`/game/${game.id}/answer`, {
          method: 'POST',
          body: { questionIndex: game.idx, ...payload, timeLeft },
        });
  } catch {
    game.answering = false; // allow retry
    return;
  }
  handleAnswerResult(res, type, clickedBtn);
}

function submitOption(i, btn) {
  SFX.click();
  submit('option', { answerIndex: i }, btn);
}
function submitTyped() {
  const input = $('#type-input');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  SFX.click();
  submit('typed', { answerText: text }, null);
}
function onTimeout() {
  if (game.answering || game.revealed) return;
  toast("⏰ Time's up!", 'error', 1800);
  submit('timeout', { answerIndex: null }, null);
}

function handleAnswerResult(res, type, clickedBtn) {
  game.revealed = true;
  game.results.push({
    name: res.correctText,
    flagUrl: res.flagUrl,
    country: res.country,
    correct: res.correct,
    points: res.points,
    given: res.given,
  });
  game.score = res.score;
  game.streak = res.streak;
  game.bestStreak = Math.max(game.bestStreak, res.bestStreak);
  if (game.lives !== null && typeof res.lives === 'number') game.lives = res.lives;

  // blitz bank adjustments
  if (game.bank) {
    game.bankEnd += res.correct ? 2000 : -3000;
    const pill = $('#hud-bank');
    pill.classList.remove('bonus'); void pill.offsetWidth; pill.classList.add('bonus');
    floatPoints(res.correct ? '+2s' : '−3s', pill);
    startBankLoop();
  }

  // mark buttons
  const buttons = [...$('#options').children];
  buttons.forEach((b, i) => {
    if (res.correctIndex === i) b.classList.add('correct');
    else b.classList.add('dim');
  });
  if (clickedBtn && !res.correct && type === 'option') {
    clickedBtn.classList.remove('dim');
    clickedBtn.classList.add('wrong');
  }

  // sound + streak + score UI
  updateScoreUI(res.score);
  updateStreakUI(res.streak);
  if (res.correct) {
    if (res.points > 300) SFX.correct(); else SFX.correct();
    if (res.streak >= 2) SFX.streak(Math.min(res.streak, 6));
    floatPoints(`+${res.points}`, $('#hud-score'));
  } else {
    SFX.wrong();
  }

  showReveal(type, res);

  // Flow control: auto-advance in endless styles, party waiting rules, finishing.
  if (game.autoAdvance) {
    if (res.eliminated) { toast('💀 Out of lives!', 'error', 2600); setTimeout(() => finishGame(), 1600); return; }
    if (res.done) { setTimeout(() => finishGame(), 1600); return; }
    setTimeout(() => nextQuestion(), 1600);
  } else if (party.active) {
    if (res.done) {
      game.partyWait = true;
      $('#btn-next').hidden = true;
      $('#waiting-note').textContent = '🏁 You finished! Waiting for the others…';
      $('#waiting-note').hidden = false;
    }
  }
}

function floatPoints(text, nearEl) {
  const f = el('span', 'float-points', text);
  const r = nearEl.getBoundingClientRect();
  f.style.left = `${r.left + r.width / 2 - 20}px`;
  f.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1000);
}

function showReveal(type, res) {
  const card = $('#reveal-card');
  const banner = $('#reveal-banner');
  const facts = $('#facts');
  card.hidden = false;
  banner.className = `reveal-banner ${res.correct ? 'good' : 'bad'}`;
  banner.innerHTML = '';

  const miniImg = el('img', 'mini-flag');
  miniImg.src = res.flagUrl; miniImg.alt = '';
  const nameSpan = el('span', 'big-name', res.correctText);

  if (res.correct) {
    const prefix = type === 'typed' ? el('span', '', '✅ Spot on!') : el('span', '', '✅ Correct!');
    banner.append(prefix, miniImg, nameSpan);
    if (res.streak >= 2) banner.append(el('span', '', `🔥 ${res.streak}× streak`));
    if (type === 'typed') {
      const note = el('div', 'typed-note', `You typed: “${res.given || res.correctText}”`);
      banner.appendChild(note);
      note.style.flexBasis = '100%';
    }
  } else if (type === 'timeout') {
    banner.append(el('span', '', '⏰ Time’s up — the flag is'), miniImg, nameSpan);
  } else if (type === 'typed') {
    const g = el('span', '', `❌ You typed “${res.given || '—'}” — it’s`);
    banner.append(g, miniImg, nameSpan);
  } else {
    banner.append(el('span', '', '❌ It’s'), miniImg, nameSpan);
  }

  const c = res.country;
  facts.innerHTML = '';
  const addFact = (label, value) => {
    const f = el('div', 'fact-chip');
    f.append(el('div', 'f-label', label), el('div', 'f-value', value));
    facts.appendChild(f);
  };
  addFact('Capital', c.capital);
  addFact('Region', c.region);
  addFact('Population', fmtPop(c.population));
  addFact('Fame', `${['⭐ famous', '✅ well-known', '💎 rare', '🌌 deep cut'][c.tier - 1]}`);

  const btn = $('#btn-next');
  $('#waiting-note').hidden = true;
  btn.hidden = game.autoAdvance; // endless modes advance on their own
  btn.textContent = game.idx + 1 >= game.questions.length ? 'Results 🏁' : 'Next ➜ ';
  btn.insertAdjacentHTML('beforeend', '<span class="key-hint">Enter</span>');
  if (!btn.hidden) btn.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- hints & skip ----------
async function useHint() {
  if (game.answering || game.revealed || game.hintsLeft === 0) return;
  const q = game.questions[game.idx];
  const type = q.type === 'typed' ? 'letter' : 'fifty';
  try {
    const res = party.active
      ? await api(`/room/${party.code}/hint`, { method: 'POST', body: { playerId: party.playerId, token: party.token, type } })
      : await api(`/game/${game.id}/hint`, { method: 'POST', body: { type } });
    game.hintsLeft = res.remaining;
    $('#btn-hint').disabled = game.hintsLeft === 0;
    $('#hint-count').textContent = ` (${game.hintsLeft})`;
    if (type === 'letter') {
      toast(`💡 First letter: ${res.letter}`, 'success', 2600);
      $('#type-input').focus();
    } else {
      SFX.click();
      q._removed = res.removed;
      res.removed.forEach((i) => $('#options').children[i]?.classList.add('dim'));
    }
  } catch { /* toast handled in api() */ }
}

async function skipQuestion() {
  if (game.answering || game.revealed) return;
  SFX.click();
  game.answering = true;
  stopTimer();
  let res;
  try {
    res = party.active
      ? await api(`/room/${party.code}/skip`, { method: 'POST', body: { playerId: party.playerId, token: party.token } })
      : await api(`/game/${game.id}/skip`, { method: 'POST', body: {} });
  } catch { game.answering = false; return; }
  game.revealed = true;
  game.score = res.score;
  game.streak = 0;
  updateScoreUI(res.score, false);
  updateStreakUI(0);
  game.results.push({
    name: res.correctText, flagUrl: res.flagUrl, country: res.country,
    correct: false, points: 0, given: '⏭ skipped',
  });
  showReveal('skip', { ...res, correct: false });
}

// ---------- next / finish ----------
function nextQuestion() {
  if (game.partyWait) return; // waiting for friends to finish (party mode)
  // guard against double-advance (e.g. Enter firing both keyboard + button activation)
  const now = performance.now();
  if (game._lastAdvance && now - game._lastAdvance < 250) return;
  game._lastAdvance = now;
  game.idx += 1;
  if (game.idx < game.questions.length) {
    renderQuestion();
  } else {
    finishGame();
  }
}

async function finishGame(early = false) {
  stopTimer(); stopBank();
  const prevBest = store.get(`fq_best_${game.difficulty}`, 0);
  if (game.daily && !store.get(`fq_daily_${dailyKey()}`, false)) {
    store.set(`fq_daily_${dailyKey()}`, true);
  }
  try {
    const res = await api(`/game/${game.id}/finish`, { method: 'POST', body: { name: settings.name } });
    renderResult(res.summary, res.rank, prevBest);
  } catch {
    if (early) { show('home'); loadHomeStats(); return; }
    // fallback: local summary if server hiccuped at the very end
    renderResult({
      score: game.score, total: game.questions.length, correctCount: game.results.filter((r) => r.correct).length,
      accuracy: Math.round((game.results.filter((r) => r.correct).length / Math.max(1, game.questions.length)) * 100),
      bestStreak: game.bestStreak, hintsUsed: 0, skippedCount: game.results.filter((r) => r.given === '⏭ skipped').length,
      maxScore: game.maxScore, difficulty: game.difficulty, region: game.region, mode: game.mode, style: game.style, daily: game.daily,
    }, null, prevBest);
  }
}

function renderResult(s, rank, prevBest) {
  lastSummary = s;
  show('result');
  $('#podium').hidden = true;
  $('#btn-again').textContent = '↻ Play again';
  $('#btn-again').disabled = false;
  $('#btn-change').textContent = '⚙ Change settings';
  $('#btn-change').disabled = false;
  const newBest = s.score > prevBest && s.score > 0;
  if (newBest) store.set(`fq_best_${game.difficulty}`, s.score);

  $('#result-emoji').textContent = s.daily ? '🗓️' : s.eliminated ? '💀' : s.accuracy >= 90 ? '🏆' : s.accuracy >= 60 ? '🏅' : s.accuracy >= 30 ? '🙂' : '🌍';
  $('#result-title').textContent =
    s.daily ? 'Daily Challenge done!' :
    s.eliminated ? 'Survival over!' :
    s.style === 'blitz' ? '⏱️ Time’s up!' :
    s.accuracy >= 90 ? 'Flag master!' : s.accuracy >= 60 ? 'Solid run!' : s.accuracy >= 30 ? 'Halfway there!' : 'Good practice!';

  $('#rank-note').textContent = newBest ? `🥇 New personal best on ${s.difficulty}!` : '';
  if (rank) $('#rank-note').textContent += `${newBest ? ' ' : ''}🏆 #${rank} on the ${s.difficulty} leaderboard!`;

  // score count-up
  const numEl = $('#result-score');
  $('#result-max').textContent = `/ max ${fmt(s.maxScore)}`;
  const start = performance.now(); const dur = 900;
  const tick = (t) => {
    const p = Math.min(1, (t - start) / dur);
    numEl.textContent = fmt(Math.round(s.score * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  $('#result-grid').innerHTML = '';
  const addStat = (value, label) => {
    const d = el('div', 'rstat');
    d.append(el('div', 'rs-value', value), el('div', 'rs-label', label));
    $('#result-grid').appendChild(d);
  };
  addStat(`${s.correctCount}/${s.total}`, 'Correct');
  addStat(`${s.accuracy}%`, 'Accuracy');
  addStat(`🔥 ${s.bestStreak}`, 'Best streak');
  addStat(s.hintsUsed ? `${s.hintsUsed} 💡` : 'None', 'Hints');
  if (s.reached) addStat(String(s.reached), 'Rounds survived');

  // review list
  const review = $('#review');
  review.innerHTML = '';
  game.results.forEach((r, i) => {
    const row = el('div', 'rv-row');
    row.style.animationDelay = `${i * 0.04}s`;
    row.append(el('span', 'rv-n', String(i + 1)));
    const img = el('img'); img.src = r.flagUrl; img.alt = r.name;
    row.appendChild(img);
    row.append(el('span', 'rv-name', r.name));
    const pts = el('span', `rv-pts ${r.correct ? 'good' : 'bad'}`, r.correct ? `+${r.points}` : (r.points || '0'));
    if (!r.correct && r.given === '⏭ skipped') pts.textContent = '⏭';
    row.appendChild(pts);
    review.appendChild(row);
  });

  const celebration = s.accuracy >= 60 || s.score >= s.maxScore * 0.5;
  SFX.finish(celebration);
  if (celebration) setTimeout(() => confettiBurst(), 250);
}

// ---------- leaderboard ----------
let lbFilter = 'all';
async function openLeaderboard(filter) {
  if (filter) lbFilter = filter;
  try {
    const data = await api(`/leaderboard?difficulty=${lbFilter}&limit=10`);
    const overlay = $('#lb-overlay');
    overlay.hidden = false;
    const filters = $('#lb-filters');
    filters.innerHTML = '';
    const tabs = [['all', 'All'], ...CONFIG.data.difficulties.map((d) => [d.id, d.name])];
    tabs.forEach(([id, label]) => {
      const chip = el('button', `chip ${lbFilter === id ? 'selected' : ''}`, label);
      chip.type = 'button';
      chip.onclick = () => { lbFilter = id; openLeaderboard(); };
      filters.appendChild(chip);
    });
    const list = $('#lb-list');
    list.innerHTML = '';
    if (!data.entries.length) {
      list.innerHTML = '<div class="lb-empty">No scores here yet — be the first! 🚩</div>';
      return;
    }
    data.entries.forEach((e, i) => {
      const row = el('div', `lb-row ${i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : ''}`);
      row.append(el('span', 'lb-rank', `${i + 1}.`));
      row.append(el('span', 'lb-name', e.name));
      const meta = el('div', 'lb-meta');
      meta.append(
        el('div', 'lb-score', fmt(e.score)),
        el('div', 'lb-sub', `${e.difficulty} · ${e.accuracy}% · 🔥${e.bestStreak}`),
      );
      row.appendChild(meta);
      list.appendChild(row);
    });
  } catch { /* handled */ }
}

// ---------- confetti ----------
function confettiBurst() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const colors = ['#6366f1', '#22d3ee', '#fbbf24', '#34d399', '#f472b6', '#f87171'];
  const parts = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 6 + Math.random() * 7,
    h: 8 + Math.random() * 8,
    c: colors[(Math.random() * colors.length) | 0],
    vy: 2 + Math.random() * 3.5,
    vx: -1.4 + Math.random() * 2.8,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
  }));
  const t0 = performance.now();
  const loop = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (t - t0 > 2600) return;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - (t - t0) / 2600);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------- share ----------
async function shareResult(s) {
  const text = `🚩 FlagQuest — ${fmt(s.score)} pts · ${s.difficulty}${s.daily ? ' · daily' : ''} · ${s.accuracy}% accuracy · best streak 🔥${s.bestStreak}`;
  try {
    if (navigator.share) { await navigator.share({ text }); toast('Shared!', 'success', 1800); return; }
    await navigator.clipboard.writeText(text);
    toast('Result copied to clipboard!', 'success', 2200);
  } catch {
    try { await navigator.clipboard.writeText(text); toast('Copied!', 'success', 1800); }
    catch { toast(text, 'info', 5000); }
  }
}

// ============================================================ PARTY (multiplayer)
const PARTY_MAX = 8;

async function openPartyMenu(focusJoin = false) {
  $('#party-name').value = settings.name;
  buildPartyConfig();
  show('party');
  setTimeout(() => (focusJoin ? $('#party-code') : $('#party-name')).focus(), 60);
}
function buildPartyConfig() {
  const dSel = $('#party-difficulty');
  if (dSel.options.length === 0) {
    for (const d of CONFIG.data.difficulties) dSel.append(new Option(`${d.icon} ${d.name}`, d.id));
    for (const r of CONFIG.data.regions) $('#party-region').append(new Option(`${r.icon} ${r.name}`, r.id));
    for (const m of CONFIG.data.modes) $('#party-mode').append(new Option(`${m.icon} ${m.name}`, m.id));
  }
  dSel.value = settings.difficulty;
  $('#party-region').value = settings.region;
  $('#party-mode').value = settings.difficulty === 'expert' ? 'flag2name' : settings.mode;
}

async function createRoom() {
  const name = $('#party-name').value.trim().slice(0, 20) || 'Host';
  settings.name = name;
  const body = {
    name,
    difficulty: $('#party-difficulty').value,
    region: $('#party-region').value,
    mode: $('#party-mode').value,
    count: Number($('#party-length').value),
  };
  try {
    const data = await api('/room', { method: 'POST', body });
    enterRoom({ code: data.code, playerId: data.playerId, token: data.token, room: data.room, isHost: true });
  } catch { /* toast shown */ }
}

async function joinRoom(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(clean)) { toast('Invite codes are 6 letters/digits.', 'error'); return; }
  const name = ($('#party-name').value.trim() || settings.name || 'Player').slice(0, 20);
  try {
    const data = await api(`/room/${clean}/join`, { method: 'POST', body: { name } });
    enterRoom({ code: data.code, playerId: data.playerId, token: data.token, room: data.room, isHost: false });
  } catch { /* toast shown */ }
}

function enterRoom(sess) {
  party.active = true;
  party.code = sess.code;
  party.playerId = sess.playerId;
  party.token = sess.token;
  party.isHost = sess.isHost;
  party.room = sess.room;
  party.questions = null;
  party.results = [];
  party.answered = 0;
  party.resultsShown = false;
  clearResultTimer();
  game.partyWait = false;
  try { sessionStorage.setItem('fq_party', JSON.stringify({ code: sess.code, playerId: sess.playerId, token: sess.token, name: settings.name })); } catch {}
  attachRoomStream();
  renderLobby(sess.room);
  show('lobby');
  SFX.correct();
}

function attachRoomStream() {
  stopPartyStream();
  const url = `/api/room/${party.code}/stream?playerId=${encodeURIComponent(party.playerId)}`;
  const es = new EventSource(url);
  party.es = es;
  es.onmessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.code !== party.code) return;
    party.room = msg;
    onRoomState(msg);
  };
  es.onerror = () => { /* browser auto-reconnects; transient errors ignored */ };
}

function onRoomState(room) {
  const state = room.state;
  const players = room.players || [];

  if (state === 'playing') {
    if (!party.questions && !party.starting) {
      party.starting = true;
      startPartyMatch(players).finally(() => { party.starting = false; });
    } else if (party.questions) {
      renderPartyStrip(players);
    }
    return;
  }
  if (state === 'finished') {
    if (party.questions && !party.resultsShown && !party.resultTimer) {
      // If the player is mid-answer (or reading a reveal), give the local UI a
      // beat before the podium takes over — SSE often beats the answer response.
      const busy = game.answering ||
        (!$('#screen-game').hidden && (!$('#reveal-card').hidden || !$('#options').children.length));
      const delay = busy ? 2600 : 0;
      party.resultTimer = setTimeout(() => {
        party.resultTimer = null;
        showPartyResults(players, room);
      }, delay);
    }
    return;
  }
  if (state === 'lobby') {
    clearResultTimer();
    party.questions = null;
    party.resultsShown = false;
    game.partyWait = false;
    $('#party-strip').hidden = true;
    renderLobby(room);
    show('lobby');
  }
}

function renderLobby(room) {
  $('#btn-copy-code').textContent = room.code.split('').join(' ');
  $('#lobby-count').textContent = `${room.players.length}/${PARTY_MAX} players`;
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of room.players) {
    const row = el('div', 'lp-row');
    row.append(
      el('span', 'lp-crown', p.isHost ? '👑' : '🙂'),
      el('span', 'lp-name', p.name),
      el('span', `lp-status ${p.connected ? 'on' : ''}`, p.connected ? 'ready' : 'away…'),
    );
    list.appendChild(row);
  }
  const s = room.settings;
  const diffObj = CONFIG.data.difficulties.find((d) => d.id === s.difficulty);
  const regObj = CONFIG.data.regions.find((r) => r.id === s.region);
  const modeObj = CONFIG.data.modes.find((m) => m.id === s.mode);
  $('#lobby-diff').innerHTML = `${diffObj.icon} ${diffObj.name}`;
  $('#lobby-region').innerHTML = `${regObj.icon} ${regObj.name}`;
  $('#lobby-mode').innerHTML = `${modeObj.icon} ${modeObj.name}`;
  $('#lobby-length').textContent = `${s.count} rounds`;
  const iAmHostNow = room.hostId === party.playerId;
  party.isHost = iAmHostNow;
  const startBtn = $('#btn-lobby-start');
  startBtn.disabled = !iAmHostNow;
  startBtn.textContent = iAmHostNow ? '▶ Start match' : 'Waiting for host to start…';
  $('#lobby-note').textContent = iAmHostNow ? `Up to ${PARTY_MAX} players — share the code!` : '';
}

async function startPartyMatch(players) {
  try {
    const deck = await api(`/room/${party.code}/questions`);
    stopPartyStreamEnhance();
    party.questions = deck.questions;
    party.theoreticalMax = deck.theoreticalMax;
    party.settings = { mode: deck.mode, difficulty: deck.difficulty, region: party.room.settings.region };
    party.answered = 0;
    party.ended = false;
    const me = (players || []).find((p) => p.id === party.playerId) ||
      ((await api(`/room/${party.code}`).data.room.players) || []).find((p) => p.id === party.playerId) || null;
    // resume support: if we already answered some questions on the server, jump ahead
    const resumeIdx = me && typeof me.answered === 'number' ? me.answered : 0;
    Object.assign(game, {
      id: party.code, questions: party.questions, idx: resumeIdx, timeLimit: deck.timeLimit,
      maxHints: deck.maxHints, hintsLeft: deck.maxHints, score: me ? me.score : 0, streak: 0,
      bestStreak: me ? me.bestStreak : 0, maxScore: deck.theoreticalMax,
      difficulty: deck.difficulty, region: party.settings.region, mode: deck.mode, style: 'party',
      results: [], answering: false, revealed: false, autoAdvance: false, bank: null, lives: null, daily: false,
      _lastAdvance: 0,
    });
    renderHUD();
    // party strip visible
    $('#party-strip').hidden = false;
    renderPartyStrip(players || []);
    show('game');
    renderQuestion();
  } catch { /* toast from api() */ }
}
function stopPartyStreamEnhance() { /* stream stays open for scoreboard + rematch */ }

function renderPartyStrip(players) {
  const strip = $('#party-strip');
  if (!party.active || !party.questions) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = '';
  const sorted = [...players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    const off = p.connected === false ? ' off' : '';
    const d = el(`div`, `party-player${p.id === party.playerId ? ' me' : ''}${i === 0 && p.score > 0 ? ' lead' : ''}${p.finished ? ' done' : ''}${off}`);
    d.append(
      el('span', 'pp-rank', `${i + 1}`),
      el('span', '', p.name + (p.isHost ? ' 👑' : '')),
      el('span', 'pp-score', fmt(p.score)),
      el('span', 'pp-flag', p.finished ? '🏁' : p.connected === false ? '💤' : `· ${p.answered}/${party.questions.length}`),
    );
    strip.appendChild(d);
  });
}

function showPartyResults(players, room) {
  if (party.resultsShown) return;
  party.resultsShown = true;
  const me = players.find((p) => p.id === party.playerId);
  if (!me) return;
  const total = room.totalQuestions || party.questions.length;
  const summary = {
    score: me.score,
    total,
    correctCount: me.correct,
    accuracy: total ? Math.round((me.correct / total) * 100) : 0,
    bestStreak: me.bestStreak,
    hintsUsed: null,
    skippedCount: null,
    maxScore: party.theoreticalMax,
    difficulty: party.settings.difficulty,
    region: party.settings.region,
    mode: party.settings.mode,
    style: 'party',
  };
  renderResult(summary, null, store.get(`fq_best_${summary.difficulty}`, 0));
  // podium
  const podium = $('#podium');
  podium.hidden = false;
  podium.innerHTML = '';
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  const heights = ['p1', 'p2', 'p3'];
  sorted.slice(0, 3).forEach((p, i) => {
    const pod = el('div', `pod ${heights[i]}`);
    pod.append(
      el('div', 'pod-emoji', medals[i]),
      el('div', 'pod-name', p.name + (p.id === party.playerId ? ' (you)' : '')),
      el('div', 'pod-score', fmt(p.score)),
    );
    const bar = el('div', 'pod-bar');
    pod.appendChild(bar);
    podium.appendChild(pod);
  });
  if (sorted.length > 3) {
    const rest = el('div', 'pod');
    rest.append(
      el('div', 'pod-emoji', `+${sorted.length - 3}`),
      el('div', 'pod-name', 'players'),
      el('div', 'pod-bar short'),
    );
    podium.appendChild(rest);
  }
  // party-specific buttons
  const again = $('#btn-again');
  $('#btn-change').textContent = '↩ Leave room';
  if (party.isHost) {
    again.textContent = '↻ Rematch — back to the lobby';
  } else {
    again.textContent = '⏳ Waiting for host to rematch…';
    again.disabled = true;
  }
}

async function rematch() {
  try {
    await api(`/room/${party.code}/rematch`, { method: 'POST', body: { playerId: party.playerId, token: party.token } });
    toast('Back to the lobby!', 'success');
  } catch { /* handled */ }
}

async function leaveRoom(toHome = false) {
  try {
    if (party.active && party.playerId) {
      await api(`/room/${party.code}/leave`, { method: 'POST', body: { playerId: party.playerId, token: party.token } });
    }
  } catch { /* whatever */ }
  stopPartyStream();
  party.active = false; party.code = null; party.questions = null; party.answered = 0;
  try { sessionStorage.removeItem('fq_party'); } catch {}
  if (toHome) { show('home'); loadHomeStats(); }
}

// deep link ?room=CODE
function checkRoomDeepLink() {
  const code = new URLSearchParams(location.search).get('room');
  if (code) {
    openPartyMenu().then(() => {
      $('#party-code').value = code.toUpperCase();
      $('#party-name').focus();
      toast('Invite detected — enter your name or hit Join!', 'success', 3600);
    });
    history.replaceState(null, '', location.pathname);
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const inGame = !$('#screen-game').hidden;
  const onHome = !$('#screen-home').hidden;
  const onPartyScreens = !$('#screen-party').hidden || !$('#screen-lobby').hidden;
  const overlayOpen = !$('#lb-overlay').hidden;
  const t = e.target || {};
  const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;

  if (overlayOpen) {
    if (e.key === 'Escape') { $('#lb-overlay').hidden = true; return; }
    return; // no game shortcuts while the leaderboard is open
  }

  if (onPartyScreens) return; // party screens handle their own inputs

  if (onHome) {
    if (['1', '2', '3', '4'].includes(e.key) && document.activeElement !== $('#player-name')) {
      const d = CONFIG.data.difficulties[Number(e.key) - 1];
      if (d) { settings.difficulty = d.id; if (d.typed) settings.mode = 'flag2name'; buildHome(); }
    }
    if (e.key === 'Enter' && document.activeElement === $('#player-name')) startGame();
    return;
  }

  if (inGame) {
    if (game.revealed) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextQuestion(); }
      return;
    }
    if (game.answering) return;
    if (typing) {
      // Typing the answer (Expert mode) — only Enter submits; letters like S/H/digits are just text.
      if (e.key === 'Enter') { e.preventDefault(); submitTyped(); }
      return;
    }
    if (['1', '2', '3', '4'].includes(e.key)) {
      const q = game.questions[game.idx];
      const n = Number(e.key) - 1;
      if (q && q.options && q.options[n] !== undefined) {
        const btn = $('#options').children[n];
        if (btn && !btn.classList.contains('dim')) submitOption(n, btn);
      }
    }
    if (e.key.toLowerCase() === 's') skipQuestion();
    if (e.key.toLowerCase() === 'h') useHint();
  }
});

// ---------- wiring ----------
function wire() {
  $('#btn-start').onclick = startGame;
  $('#btn-daily').onclick = () => startGame({ daily: true });
  $('#btn-next').onclick = nextQuestion;
  $('#btn-hint').onclick = useHint;
  $('#btn-skip').onclick = skipQuestion;
  $('#type-submit').onclick = submitTyped;
  $('#btn-again').onclick = () => {
    SFX.click();
    if (party.active && game.style === 'party') { rematch(); return; }
    startGame();
  };
  $('#btn-change').onclick = () => {
    SFX.click();
    if (party.active && game.style === 'party') { leaveRoom(true); return; }
    show('home'); loadHomeStats();
  };
  $('#btn-share').onclick = () => lastSummary && shareResult(lastSummary);
  $('#btn-home').onclick = () => {
    SFX.click();
    const inGame = !game.revealed && !$('#screen-game').hidden;
    if (inGame) {
      if (party.active) {
        if (!window.confirm('Leave the party? Your progress will be lost.')) return;
      } else if (!window.confirm('Abandon this game? Progress will be lost.')) {
        return;
      }
    }
    if (party.active) { leaveRoom(true); return; }
    stopTimer(); stopBank(); show('home'); loadHomeStats();
  };
  $('#btn-leaderboard').onclick = () => openLeaderboard(lbFilter);
  $('#lb-close').onclick = () => { $('#lb-overlay').hidden = true; };
  $('#lb-overlay').onclick = (e) => { if (e.target === $('#lb-overlay')) $('#lb-overlay').hidden = true; };
  const soundBtn = $('#btn-sound');
  soundBtn.textContent = SFX.muted ? '🔇' : '🔊';
  soundBtn.onclick = () => {
    SFX.muted = !SFX.muted;
    store.set('fq_muted', SFX.muted);
    soundBtn.textContent = SFX.muted ? '🔇' : '🔊';
    if (!SFX.muted) SFX.click();
  };

  // ---- party ----
  $('#btn-create-room').onclick = () => { SFX.click(); openPartyMenu(false); };
  $('#btn-join-room').onclick = () => { SFX.click(); openPartyMenu(true); };
  $('#btn-party-back').onclick = () => { SFX.click(); show('home'); loadHomeStats(); };
  $('#btn-party-create').onclick = createRoom;
  $('#btn-party-join').onclick = () => joinRoom($('#party-code').value);
  $('#party-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); joinRoom($('#party-code').value); }
  });
  $('#party-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if ($('#party-code').value.trim()) joinRoom($('#party-code').value); else createRoom();
    }
  });
  $('#btn-copy-code').onclick = async () => {
    SFX.click();
    if (!party.code) return;
    const link = `${location.origin}/?room=${party.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied — send it to your friends!', 'success', 2600);
    } catch {
      toast(link, 'info', 6000);
    }
  };
  $('#btn-lobby-start').onclick = async () => {
    SFX.click();
    try {
      await api(`/room/${party.code}/start`, { method: 'POST', body: { playerId: party.playerId, token: party.token } });
    } catch { /* toast from api() */ }
  };
  $('#btn-lobby-leave').onclick = () => { SFX.click(); leaveRoom(true); };
}

// ---------- boot ----------
async function boot() {
  wire();
  try {
    CONFIG.data = await api('/config');
  } catch {
    const fb = $('#screen-fallback');
    fb.hidden = false;
    fb.innerHTML = '<main class="screen"><div class="setup-card" style="text-align:center"><h2>🚩 FlagQuest can’t reach the server</h2><p style="color:#9aa3bf;margin-top:8px">Start it with <b>npm start</b> then refresh this page.</p></div></main>';
    $('#screen-home').hidden = true;
    return;
  }
  buildHome();
  show('home');
  loadHomeStats();
  checkRoomDeepLink(); // ?room=CODE invite deep link
  resumeParty(); // refresh/open again while a party round is live
}

// session restore: user refreshed (or re-opened) while in a party room
async function resumeParty() {
  let sess = null;
  try { sess = JSON.parse(sessionStorage.getItem('fq_party') || 'null'); } catch {}
  if (!sess || !sess.code || !sess.playerId || !sess.token) return;
  let room;
  try {
    room = (await api(`/room/${sess.code}`)).data.room;
  } catch {
    try { sessionStorage.removeItem('fq_party'); } catch {}
    return; // room is gone
  }
  if (!room) return;
  if (room.state === 'finished') {
    try { sessionStorage.removeItem('fq_party'); } catch {}
    toast('Your party round already finished — ask the host for a rematch!', 'info', 4200);
    return;
  }
  party.active = true;
  party.code = sess.code;
  party.playerId = sess.playerId;
  party.token = sess.token;
  party.room = room;
  party.questions = null;
  party.results = [];
  party.answered = 0;
  party.resultsShown = false;
  game.partyWait = false;
  attachRoomStream();
  if (room.state === 'playing') {
    party.starting = true;
    await startPartyMatch(room.players).finally(() => { party.starting = false; });
  } else {
    renderLobby(room);
    show('lobby');
  }
}
boot();
