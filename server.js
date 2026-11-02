'use strict';

/* FlagQuest — Express backend
 * - Serves the static frontend from /public
 * - Generates quiz sessions server-side (correct answers never leak to the client)
 * - Validates answers, computes scores/streaks, runs hints, persists leaderboard + global stats
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { matchTyped } = require('./utils/matching');
const { makePartyRouter } = require('./party');

const COUNTRIES = require('./data/countries.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REGIONS = {
  all:          { id: 'all',          name: 'Worldwide',     icon: '🌐' },
  africa:       { id: 'africa',       name: 'Africa',        icon: '🦁' },
  asia:         { id: 'asia',         name: 'Asia',          icon: '🐉' },
  europe:       { id: 'europe',       name: 'Europe',        icon: '🏰' },
  northamerica: { id: 'northamerica', name: 'North America', icon: '🦅' },
  southamerica: { id: 'southamerica', name: 'South America', icon: '🦜' },
  oceania:      { id: 'oceania',      name: 'Oceania',       icon: '🐨' },
};

const DIFFICULTIES = {
  easy:   { id: 'easy',   name: 'Easy',   icon: '🌱', desc: 'Famous countries · 2 choices · 20s',    options: 2, tiers: [1],     timeLimit: 20, base: 100 },
  medium: { id: 'medium', name: 'Medium', icon: '⚡', desc: 'Wide mix of flags · 4 choices · 15s',    options: 4, tiers: [1, 2],  timeLimit: 15, base: 150 },
  hard:   { id: 'hard',   name: 'Hard',   icon: '🔥', desc: 'Tough & obscure flags · 4 choices · 12s', options: 4, tiers: [2, 3, 4], timeLimit: 12, base: 200 },
  expert: { id: 'expert', name: 'Expert', icon: '💀', desc: 'No choices — type the country name · 25s', options: 0, tiers: [2, 3, 4], timeLimit: 25, base: 250, typed: true },
};

const MODES = {
  flag2name: { id: 'flag2name', name: 'Flag → Country', icon: '🚩', desc: 'See the flag, pick the country' },
  name2flag: { id: 'name2flag', name: 'Country → Flag', icon: '🏷️', desc: 'See the country, pick the flag' },
};

const STYLES = {
  classic:  { id: 'classic',  name: 'Classic',   icon: '🎯', desc: 'The standard quiz' },
  blitz:    { id: 'blitz',    name: 'Blitz',     icon: '⏱️', desc: '60s bank · correct: +2s, wrong: −3s', bank: 60, perQuestion: 10 },
  survival: { id: 'survival', name: 'Survival',  icon: '❤️', desc: '3 lives — how deep can you go?', lives: 3 },
};

const LENGTHS = [5, 10, 15, 20];
const MAX_HINTS_PER_GAME = 3;
const GAME_TTL_MS = 60 * 60 * 1000;
const POOL_ROUND_CAP = 50; // max questions served for endless styles (blitz/survival)

// ---------------------------------------------------------------------------
// Persistence (simple JSON files under /data)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // tolerate a UTF-8 BOM
    return JSON.parse(raw);
  } catch { return fallback; }
}
function writeJSON(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

writeJSON(LEADERBOARD_FILE, readJSON(LEADERBOARD_FILE, []));
const STATS_DEFAULT = { gamesPlayed: 0, questionsAnswered: 0, correctAnswers: 0, totalScore: 0, bestScore: 0 };
writeJSON(STATS_FILE, { ...STATS_DEFAULT, ...readJSON(STATS_FILE, {}) });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shuffle(arr) {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Deterministic RNG so the Daily Challenge is identical for everyone that day.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 2654435761) >>> 0;
  return h >>> 0;
}
function seededShuffle(arr, rand) {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const flagUrl = (code, w = 320) => `https://flagcdn.com/w${w}/${code}.png`;

// Build the question pool for region+difficulty, widening tiers when a
// specific continent has too few countries at that level.
function getPool(regionId, difficulty) {
  const inRegion = (c) => regionId === 'all' || c.region === regionId;
  const allowed = new Set(DIFFICULTIES[difficulty].tiers);

  let pool = COUNTRIES.filter((c) => inRegion(c) && allowed.has(c.tier));
  if (pool.length >= 8) return pool;

  for (const t of [1, 2, 3, 4]) {
    if (allowed.has(t)) continue;
    allowed.add(t);
    pool = COUNTRIES.filter((c) => inRegion(c) && allowed.has(c.tier));
    if (pool.length >= 8) return pool;
  }
  if (pool.length >= 4) return pool;
  const regional = COUNTRIES.filter(inRegion);
  return regional.length >= 4 ? regional : COUNTRIES.filter(inRegion);
}

function buildQuestions(pool, diff, mode, count, rand) {
  const rng = rand || Math.random;
  const shuff = (a) => (rand ? seededShuffle(a, rand) : shuffle(a));
  const working = shuff(pool);
  const n = Math.max(1, Math.min(count, working.length));
  const questions = [];

  for (let i = 0; i < n; i++) {
    const answer = working.pop();
    let options = [];
    if (diff.options > 0) {
      const distractors = shuff(working.filter((c) => c !== answer)).slice(0, diff.options - 1);
      options = shuff([answer, ...distractors]);
    }
    questions.push({ i, answer, options });
  }
  return questions;
}

function clientQuestion(q, diff, finalMode, timeLimit) {
  const tl = timeLimit || diff.timeLimit;
  const base = { i: q.i, mode: finalMode, timeLimit: tl };
  if (finalMode === 'name2flag') {
    return {
      ...base,
      type: 'flags',
      prompt: q.answer.name,
      options: q.options.map((o) => ({ code: o.code, url: flagUrl(o.code, 160) })),
    };
  }
  if (diff.typed) {
    return { ...base, type: 'typed', prompt: null, imageUrl: flagUrl(q.answer.code, 320) };
  }
  return {
    ...base,
    type: 'text',
    prompt: null,
    imageUrl: flagUrl(q.answer.code, 320),
    options: q.options.map((o) => o.name),
  };
}

function countryInfo(c) {
  const r = REGIONS[c.region];
  return {
    name: c.name,
    code: c.code,
    capital: c.capital,
    regionId: c.region,
    region: r ? r.name : c.region,
    population: c.population,
    tier: c.tier,
  };
}

function reveal(q) {
  return {
    correctText: q.answer.name,
    correctIndex: q.answerKey ?? null,
    country: countryInfo(q.answer),
    flagUrl: flagUrl(q.answer.code, 320),
  };
}

function theoreticalMax(count, diff) {
  const perQuestion = diff.base + diff.timeLimit * 5 + 100; // base + max speed bonus + max streak bonus
  return count * perQuestion;
}

function appendLeaderboard(entry) {
  const board = readJSON(LEADERBOARD_FILE, []);
  const added = { ...entry, at: Date.now(), id: crypto.randomUUID().slice(0, 8) };
  board.push(added);
  board.sort((a, b) => b.score - a.score);
  writeJSON(LEADERBOARD_FILE, board.slice(0, 200));
  return { added, board };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Config ----------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'FlagQuest API' }));

app.get('/api/config', (req, res) => {
  const regionCounts = {};
  for (const id of Object.keys(REGIONS)) {
    regionCounts[id] = id === 'all' ? COUNTRIES.length : COUNTRIES.filter((c) => c.region === id).length;
  }
  res.json({
    regions: Object.values(REGIONS).map((r) => ({ ...r, countries: regionCounts[r.id] })),
    difficulties: Object.values(DIFFICULTIES),
    modes: Object.values(MODES),
    styles: Object.values(STYLES),
    lengths: LENGTHS,
    maxHints: MAX_HINTS_PER_GAME,
  });
});

// ---- Game lifecycle ---------------------------------------------------------

const games = new Map();

app.post('/api/game', (req, res) => {
  let { region = 'all', difficulty = 'easy', mode = 'flag2name', count = 10, name = '', style = 'classic', daily = false } = req.body || {};
  if (!REGIONS[region]) region = 'all';
  if (!DIFFICULTIES[difficulty]) difficulty = 'easy';
  const diff = DIFFICULTIES[difficulty];
  if (!MODES[mode] || diff.typed) mode = 'flag2name'; // Expert is always flag → typed name
  if (!STYLES[style] || daily) style = daily ? 'classic' : style;
  if (!STYLES[style]) style = 'classic';
  const styleCfg = STYLES[style];

  const pool = getPool(region, difficulty);

  // Round count per style: endless styles use (almost) the whole pool.
  let n;
  if (daily) {
    n = 10;
  } else if (style === 'blitz' || style === 'survival') {
    n = Math.min(POOL_ROUND_CAP, pool.length);
  } else {
    count = Math.floor(Number(count) || 10);
    n = Math.max(1, Math.min(count, 50));
  }

  // Daily challenge: deterministic shuffle so everyone with the same
  // date + settings sees the exact same questions.
  let rand;
  if (daily) {
    const today = new Date();
    const tag = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    rand = mulberry32(hashSeed(`flagquest:${tag}:${region}:${difficulty}:${mode}`));
  }

  const questions = buildQuestions(pool, diff, mode, n, rand);
  // Internal per-question data the client must never see.
  questions.forEach((q) => {
    q.options.forEach((_, idx) => { if (q.options[idx] === q.answer) q.answerKey = idx; });
    q.hintUsed = false;
  });

  const perQuestionTime = style === 'blitz' ? styleCfg.perQuestion : diff.timeLimit;

  const gameId = crypto.randomUUID();
  const game = {
    id: gameId,
    region,
    difficulty,
    mode,
    style,
    daily: !!daily,
    questions,
    index: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    correctCount: 0,
    hintsUsed: 0,
    results: [],
    lives: styleCfg.lives || null,
    player: typeof name === 'string' ? name.trim().slice(0, 20) : '',
    createdAt: Date.now(),
  };
  games.set(gameId, game);

  res.json({
    gameId,
    region,
    difficulty,
    mode,
    style,
    daily: !!daily,
    count: questions.length,
    timeLimit: perQuestionTime,
    bank: styleCfg.bank || null,
    lives: styleCfg.lives || null,
    maxHints: MAX_HINTS_PER_GAME,
    theoreticalMax: theoreticalMax(questions.length, diff),
    questions: questions.map((q) => clientQuestion(q, diff, mode, perQuestionTime)),
  });
});

// Periodic cleanup of abandoned sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.createdAt > GAME_TTL_MS) games.delete(id);
}, 5 * 60 * 1000).unref();

function requireGame(req, res) {
  const game = games.get(req.params.id);
  if (!game) {
    res.status(404).json({ error: 'Game not found — it may have expired. Start a new game.' });
    return null;
  }
  return game;
}

function advancePayload(game, qi, extra) {
  return {
    ...extra,
    score: game.score,
    streak: game.streak,
    bestStreak: game.bestStreak,
    correctCount: game.correctCount,
    questionIndex: qi,
    done: game.index >= game.questions.length,
  };
}

app.post('/api/game/:id/answer', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const qi = game.index;
  if (qi >= game.questions.length) return res.status(400).json({ error: 'Game is already finished.' });

  const body = req.body || {};
  const asked = Number.isInteger(body.questionIndex) ? body.questionIndex : qi;
  if (asked < qi) return res.status(409).json({ error: 'Question already answered.' });
  if (asked > qi) return res.status(409).json({ error: 'Questions must be answered in order.' });

  const q = game.questions[qi];
  const diff = DIFFICULTIES[game.difficulty];
  const timeLimit = diff.timeLimit;
  const timeLeft = Math.max(0, Math.min(timeLimit, Number(body.timeLeft ?? timeLimit) || 0));

  // Determine correctness
  let correct = false;
  let given = '';
  if (diff.typed) {
    given = String(body.answerText || '').slice(0, 60);
    correct = matchTyped(given, q.answer.name);
  } else if (body.answerIndex === null || body.answerIndex === undefined) {
    correct = false; // timeout
    given = null;
  } else {
    const idx = Number(body.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) {
      return res.status(400).json({ error: 'Invalid answer index.' });
    }
    given = game.mode === 'name2flag' ? q.options[idx].code : q.options[idx];
    correct = idx === q.answerKey;
  }

  // Score
  let points = 0;
  if (correct) {
    game.streak += 1;
    const speedBonus = Math.round(timeLeft * 5);
    const streakBonus = Math.min(game.streak, 5) * 20;
    points = diff.base + speedBonus + streakBonus;
    if (q.hintUsed) points = Math.max(0, points - 50);
    game.score += points;
    game.correctCount += 1;
    game.bestStreak = Math.max(game.bestStreak, game.streak);
  } else {
    game.streak = 0;
    if (game.style === 'survival' && game.lives > 0) game.lives -= 1;
  }

  const result = {
    questionIndex: qi,
    type: correct ? 'answer' : (given === null ? 'timeout' : 'wrong'),
    correct,
    given,
    points,
  };
  game.results.push(result);
  game.index += 1;

  res.json({
    ...advancePayload(game, qi, { points, correct, given }),
    ...reveal(q),
    lives: game.lives,
    eliminated: game.style === 'survival' && game.lives === 0,
  });
});

app.post('/api/game/:id/skip', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const qi = game.index;
  if (qi >= game.questions.length) return res.status(400).json({ error: 'Game is already finished.' });

  game.streak = 0;
  game.results.push({ questionIndex: qi, type: 'skip', correct: false, given: null, points: 0 });
  game.index += 1;

  const q = game.questions[qi];
  res.json(advancePayload(game, qi, { skipped: true, points: 0, correct: false, given: null, ...reveal(q), lives: game.lives }));
});

app.post('/api/game/:id/hint', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const qi = game.index;
  if (qi >= game.questions.length) return res.status(400).json({ error: 'Game is already finished.' });

  if (game.hintsUsed >= MAX_HINTS_PER_GAME) return res.status(400).json({ error: 'No hints left for this game.' });
  const q = game.questions[qi];
  if (q.hintUsed) return res.status(400).json({ error: 'Hint already used on this question.' });

  const type = (req.body || {}).type || 'fifty';
  const diff = DIFFICULTIES[game.difficulty];

  if (type === 'letter') {
    if (!diff.typed) return res.status(400).json({ error: 'Letter hint only applies in Expert mode.' });
    q.hintUsed = true;
    game.hintsUsed += 1;
    return res.json({ type, letter: q.answer.name[0].toUpperCase(), remaining: MAX_HINTS_PER_GAME - game.hintsUsed });
  }

  if (!q.options || q.options.length < 3) return res.status(400).json({ error: '50/50 hint is not available here.' });

  const wrongIdx = q.options.map((_, i) => i).filter((i) => i !== q.answerKey);
  const removed = shuffle(wrongIdx).slice(0, q.options.length - 2);
  q.hintUsed = true;
  game.hintsUsed += 1;
  res.json({ type: 'fifty', removed, remaining: MAX_HINTS_PER_GAME - game.hintsUsed });
});

app.post('/api/game/:id/finish', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;

  const diff = DIFFICULTIES[game.difficulty];
  const answered = game.results.length;
  const isEndless = game.style === 'blitz' || game.style === 'survival';
  const total = isEndless ? Math.max(1, answered) : game.questions.length;
  const correctCount = game.correctCount;
  const accuracy = total ? Math.round((correctCount / total) * 100) : 0;
  const maxScore = theoreticalMax(total, diff);

  const player = ((req.body || {}).name || game.player || 'Anonymous').toString().trim().slice(0, 20) || 'Anonymous';
  const entry = {
    name: player,
    score: game.score,
    difficulty: game.difficulty,
    region: game.region,
    mode: game.mode,
    style: game.style,
    daily: game.daily,
    accuracy,
    bestStreak: game.bestStreak,
    correctCount,
    total,
  };

  const { added, board } = entry.score > 0
    ? appendLeaderboard(entry)
    : { added: null, board: readJSON(LEADERBOARD_FILE, []) };
  const rank = added
    ? board.filter((e) => e.difficulty === game.difficulty).indexOf(added) + 1
    : null;

  const stats = readJSON(STATS_FILE, STATS_DEFAULT);
  stats.gamesPlayed += 1;
  stats.questionsAnswered += game.results.length;
  stats.correctAnswers += correctCount;
  stats.totalScore += game.score;
  stats.bestScore = Math.max(stats.bestScore, game.score);
  writeJSON(STATS_FILE, stats);

  const summary = {
    score: game.score,
    total,
    correctCount,
    accuracy,
    bestStreak: game.bestStreak,
    hintsUsed: game.hintsUsed,
    skippedCount: game.results.filter((r) => r.type === 'skip').length,
    maxScore,
    difficulty: game.difficulty,
    region: game.region,
    mode: game.mode,
    style: game.style,
    daily: game.daily,
    lives: game.lives,
    eliminated: game.style === 'survival' && game.lives === 0,
    reached: isEndless ? answered + 1 : undefined,
  };

  games.delete(game.id);
  res.json({ summary, rank: rank !== null && rank >= 1 && rank <= 10 ? rank : null, stats });
});

// ---- Leaderboard & stats ------------------------------------------------------

app.get('/api/leaderboard', (req, res) => {
  const { difficulty = 'all' } = req.query;
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
  let board = readJSON(LEADERBOARD_FILE, []);
  if (difficulty !== 'all' && DIFFICULTIES[difficulty]) {
    board = board.filter((e) => e.difficulty === difficulty);
  }
  board.sort((a, b) => b.score - a.score);
  res.json({ entries: board.slice(0, limit) });
});

app.get('/api/stats', (req, res) => {
  const s = readJSON(STATS_FILE, STATS_DEFAULT);
  const accuracy = s.questionsAnswered ? Math.round((s.correctAnswers / s.questionsAnswered) * 100) : 0;
  res.json({ ...s, accuracy, countries: COUNTRIES.length });
});

// Party (multiplayer) routes — must be registered before the /api catch-all.
makePartyRouter({
  shuffle,
  getPool,
  buildQuestions,
  clientQuestion,
  reveal,
  theoreticalMax,
  DIFFICULTIES,
  REGIONS,
  MODES,
  matchTyped,
}).wireRoutes(app);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// JSON errors (bad bodies, etc.)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// ---------------------------------------------------------------------------
// Start (with port fallback)
// ---------------------------------------------------------------------------

const BASE_PORT = Number(process.env.PORT) || 3000;

function listen(port, attemptsLeft) {
  const server = app.listen(port, () => {
    console.log(`\n🚩 FlagQuest running →  http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} busy, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      throw err;
    }
  });
}

listen(BASE_PORT, 10);
