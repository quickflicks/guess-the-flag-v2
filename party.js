'use strict';

/* Party rooms — play with friends via invite code.
 * Same engine (shared question set, server-held answers), live scoreboard via SSE.
 */

const crypto = require('crypto');

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PLAYERS = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 lookalikes

function newCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
function rid() { return crypto.randomUUID(); }

/**
 * @param {object} ctx helpers from server.js:
 *   shuffle, flagUrl, getPool, buildQuestions, clientQuestion, reveal, countryInfo,
 *   DIFFICULTIES, REGIONS, MODES, theoreticalMax, readJSON, writeJSON? (not needed)
 */
function makePartyRouter(ctx) {
  const { shuffle, getPool, buildQuestions, clientQuestion, reveal, theoreticalMax, DIFFICULTIES, REGIONS, MODES } = ctx;

  const rooms = new Map(); // code -> room

  function createRoom(settings) {
    let code = newCode();
    while (rooms.has(code)) code = newCode();
    const hostId = rid();
    const host = {
      id: hostId,
      token: rid(),
      name: settings.name || 'Host',
      score: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0,
      hintUsedQ: {}, skipped: 0,
      connected: true, finished: false,
      joinedAt: Date.now(),
    };
    const room = {
      code,
      settings: sanitizeSettings(settings),
      state: 'lobby',
      players: new Map([[hostId, host]]),
      hostId,
      questions: null,
      createdAt: Date.now(),
      listeners: new Map(), // playerId -> {res, heart}
    };
    rooms.set(code, room);
    return { room, host };
  }

  function sanitizeSettings(s) {
    const region = REGIONS[s.region] ? s.region : 'all';
    const difficulty = DIFFICULTIES[s.difficulty] ? s.difficulty : 'easy';
    const diff = DIFFICULTIES[difficulty];
    let mode = MODES[s.mode] ? s.mode : 'flag2name';
    if (diff.typed) mode = 'flag2name';
    let count = Math.floor(Number(s.count) || 10);
    count = Math.max(1, Math.min(count, 20));
    return { region, difficulty, mode, count };
  }

  function broadcast(room, event = {}) {
    const payload = JSON.stringify({
      type: 'room',
      ...publicRoom(room),
      ...event,
    });
    for (const { res } of room.listeners.values()) {
      try { res.write(`data: ${payload}\n\n`); } catch { /* closed */ }
    }
  }

  function publicPlayers(room) {
    return [...room.players.values()]
      .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id, name: p.name, score: p.score, streak: p.streak, bestStreak: p.bestStreak,
        correct: p.correct, answered: p.answered, connected: p.connected,
        finished: p.finished, isHost: p.id === room.hostId,
      }));
  }

  function publicRoom(room) {
    return {
      code: room.code,
      state: room.state,
      settings: room.settings,
      hostId: room.hostId,
      players: publicPlayers(room),
      totalQuestions: room.questions ? room.questions.length : null,
      finishedCount: room.questions ? [...room.players.values()].filter((p) => p.finished).length : 0,
    };
  }

  function findRoom(code, res) {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) { res.status(404).json({ error: 'Room not found — check the invite code.' }); return null; }
    return room;
  }
  function auth(room, playerId, token, res) {
    const p = room.players.get(playerId);
    if (!p || p.token !== token) { res.status(403).json({ error: 'Not a member of this room.' }); return null; }
    return p;
  }

  // ------------------------------------------------------------------ routes

  // GET /api/room/stream/:code (SSE) — mounted below with these sub-paths:
  function wireRoutes(app) {
    // create room
    app.post('/api/room', (req, res) => {
      const body = req.body || ({}); // sanitize name later
      let room, host;
      try {
        ({ room, host } = createRoom(body));
      } catch (e) { return res.status(500).json({ error: 'Could not create room.' }); }
      res.status(201).json({
        code: room.code,
        playerId: host.id,
        token: host.token,
        room: publicRoom(room),
      });
      broadcast(room);
    });

    // join room
    app.post('/api/room/:code/join', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      if (room.state === 'playing') return res.status(409).json({ error: 'Game already in progress — wait for the next round.' });
      if (room.players.size >= MAX_PLAYERS) return res.status(409).json({ error: `Room is full (max ${MAX_PLAYERS}).` });
      const name = String((req.body || {}).name || '').trim().slice(0, 20) || `Player ${room.players.size + 1}`;
      if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: 'Name already taken in this room.' });
      }
      const player = {
        id: rid(), token: rid(), name,
        score: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0,
        hintUsedQ: {}, skipped: 0, connected: true, finished: false, joinedAt: Date.now(),
      };
      room.players.set(player.id, player);
      res.json({ code: room.code, playerId: player.id, token: player.token, room: publicRoom(room) });
      broadcast(room);
    });

    // fetch room snapshot (rejoin / refresh)
    app.get('/api/room/:code', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      res.json({ room: publicRoom(room) });
    });

    // live updates
    app.get('/api/room/:code/stream', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'room', ...publicRoom(room) })}\n\n`);
      const playerId = req.query.playerId && room.players.has(req.query.playerId) ? req.query.playerId : null;

      // If the player already had a stream (refresh), retire it before attaching.
      const old = playerId ? room.listeners.get(playerId) : null;
      if (old) { try { clearInterval(old.heart); old.res.end(); } catch {} }

      const listener = { res, heart: null, playerId };
      if (playerId) {
        const p = room.players.get(playerId);
        if (!p.connected) { p.connected = true; broadcast(room); }
        room.listeners.set(playerId, listener);
      } else {
        room.listeners.set(`spectator-${crypto.randomUUID().slice(0, 6)}`, listener);
      }
      listener.heart = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => {
        clearInterval(listener.heart);
        const cur = playerId ? room.listeners.get(playerId) : null;
        // only flip to disconnected if this is still the player's active stream
        if (cur === listener) {
          room.listeners.delete(playerId);
          const p = room.players.get(playerId);
          if (p) { p.connected = false; broadcast(room); }
        }
      });
    });

    // host starts the round
    app.post('/api/room/:code/start', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const host = auth(room, req.body.playerId, req.body.token, res); if (!host) return;
      if (host.id !== room.hostId) return res.status(403).json({ error: 'Only the host can start.' });
      if (room.state === 'playing') return res.status(409).json({ error: 'Already playing.' });

      // (re)generate round — rebuild resets everyone's progress
      const s = room.settings;
      const pool = getPool(s.region, s.difficulty);
      room.questions = buildQuestions(pool, DIFFICULTIES[s.difficulty], s.mode, s.count);
      room.questions.forEach((q) => {
        q.options.forEach((_, idx) => { if (q.options[idx] === q.answer) q.answerKey = idx; });
      });
      for (const p of room.players.values()) {
        p.score = 0; p.streak = 0; p.bestStreak = 0; p.correct = 0; p.answered = 0;
        p.hintUsedQ = {}; p.skipped = 0; p.finished = false;
      }
      room.state = 'playing';
      room.startedAt = Date.now();
      res.json({ room: publicRoom(room), theoreticalMax: theoreticalMax(room.questions.length, DIFFICULTIES[s.difficulty]) });
      broadcast(room, { type: 'started' });
    });

    // player pulls its question deck
    app.get('/api/room/:code/questions', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      if (room.state !== 'playing') return res.status(409).json({ error: 'Game is not running.' });
      const diff = DIFFICULTIES[room.settings.difficulty];
      const tl = diff.timeLimit;
      res.json({
        code: room.code,
        mode: room.settings.mode,
        difficulty: room.settings.difficulty,
        count: room.questions.length,
        maxHints: 3,
        timeLimit: tl,
        theoreticalMax: theoreticalMax(room.questions.length, diff),
        questions: room.questions.map((q) => clientQuestion(q, diff, room.settings.mode, tl)),
      });
    });

    // player answers
    app.post('/api/room/:code/answer', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const player = auth(room, (req.body || {}).playerId, (req.body || {}).token, res); if (!player) return;
      if (room.state !== 'playing') return res.status(409).json({ error: 'Game is not running.' });
      if (player.finished) return res.status(409).json({ error: 'You already finished.' });

      const qi = player.answered;
      if (qi >= room.questions.length) return res.status(400).json({ error: 'No more questions.' });
      const asked = Number.isInteger(req.body.questionIndex) ? req.body.questionIndex : qi;
      if (asked < qi) return res.status(409).json({ error: 'Question already answered.' });
      if (asked > qi) return res.status(409).json({ error: 'Questions must be answered in order.' });

      const q = room.questions[qi];
      const diff = DIFFICULTIES[room.settings.difficulty];
      const timeLeft = Math.max(0, Math.min(diff.timeLimit, Number(req.body.timeLeft ?? diff.timeLimit) || 0));

      let correct = false;
      let given = '';
      if (diff.typed) {
        given = String(req.body.answerText || '').slice(0, 60);
        correct = ctx.matchTyped(given, q.answer.name);
      } else if (req.body.answerIndex === null || req.body.answerIndex === undefined) {
        correct = false; given = null;
      } else {
        const idx = Number(req.body.answerIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) {
          return res.status(400).json({ error: 'Invalid answer index.' });
        }
        given = room.settings.mode === 'name2flag' ? q.options[idx].code : q.options[idx];
        correct = idx === q.answerKey;
      }

      let points = 0;
      if (correct) {
        player.streak += 1;
        points = diff.base + Math.round(timeLeft * 5) + Math.min(player.streak, 5) * 20;
        if (player.hintUsedQ[qi]) points = Math.max(0, points - 50);
        player.score += points;
        player.correct += 1;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
      } else {
        player.streak = 0;
      }
      player.answered += 1;
      player.finished = player.answered >= room.questions.length;

      const allDone = [...room.players.values()].every((p) => p.finished);
      if (allDone) room.state = 'finished';

      res.json({
        questionIndex: qi,
        points, correct, given,
        ...reveal(q),
        score: player.score,
        streak: player.streak,
        bestStreak: player.bestStreak,
        correctCount: player.correct,
        done: player.finished,
        allDone: room.state === 'finished',
      });
      broadcast(room);
    });

    // player skips
    app.post('/api/room/:code/skip', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const player = auth(room, (req.body || {}).playerId, (req.body || {}).token, res); if (!player) return;
      if (room.state !== 'playing') return res.status(409).json({ error: 'Game is not running.' });
      if (player.finished) return res.status(409).json({ error: 'You already finished.' });
      const qi = player.answered;
      if (qi >= room.questions.length) return res.status(400).json({ error: 'No more questions.' });
      const q = room.questions[qi];
      player.streak = 0;
      player.skipped += 1;
      player.answered += 1;
      player.finished = player.answered >= room.questions.length;
      const allDone = [...room.players.values()].every((p) => p.finished);
      if (allDone) room.state = 'finished';
      res.json({
        questionIndex: qi, skipped: true, points: 0, correct: false, given: null,
        ...reveal(q),
        score: player.score, streak: player.streak, bestStreak: player.bestStreak,
        correctCount: player.correct, done: player.finished, allDone: room.state === 'finished',
      });
      broadcast(room);
    });

    // hint (50/50 or letter — mirrors classic rules)
    app.post('/api/room/:code/hint', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const player = auth(room, (req.body || {}).playerId, (req.body || {}).token, res); if (!player) return;
      if (room.state !== 'playing') return res.status(409).json({ error: 'Game is not running.' });
      const usedCount = Object.keys(player.hintUsedQ).length;
      if (usedCount >= 3) return res.status(400).json({ error: 'No hints left.' });
      const qi = player.answered;
      if (qi >= room.questions.length) return res.status(400).json({ error: 'No more questions.' });
      if (player.hintUsedQ[qi]) return res.status(400).json({ error: 'Hint already used on this question.' });

      const q = room.questions[qi];
      const type = (req.body || {}).type || 'fifty';
      if (type === 'letter') {
        if (!DIFFICULTIES[room.settings.difficulty].typed) return res.status(400).json({ error: 'Letter hint only in Expert mode.' });
        player.hintUsedQ[qi] = 1;
        return res.json({ type, letter: q.answer.name[0].toUpperCase(), remaining: 3 - usedCount - 1 });
      }
      if (!q.options || q.options.length < 3) return res.status(400).json({ error: '50/50 hint is not available here.' });
      const wrongIdx = q.options.map((_, i) => i).filter((i) => i !== q.answerKey);
      const removed = shuffle(wrongIdx).slice(0, q.options.length - 2);
      player.hintUsedQ[qi] = 1;
      res.json({ type: 'fifty', removed, remaining: 3 - usedCount - 1 });
    });

    // host resets back to lobby for a rematch
    app.post('/api/room/:code/rematch', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const host = auth(room, (req.body || {}).playerId, (req.body || {}).token, res); if (!host) return;
      if (host.id !== room.hostId) return res.status(403).json({ error: 'Only the host can rematch.' });
      if (room.state !== 'finished') return res.status(409).json({ error: 'Finish the current round first.' });
      room.state = 'lobby';
      room.questions = null;
      for (const p of room.players.values()) {
        p.score = 0; p.streak = 0; p.bestStreak = 0; p.correct = 0; p.answered = 0;
        p.hintUsedQ = {}; p.skipped = 0; p.finished = false;
      }
      res.json({ room: publicRoom(room) });
      broadcast(room, { type: 'lobby' });
    });

    // leave room (explicit)
    app.post('/api/room/:code/leave', (req, res) => {
      const room = findRoom(req.params.code, res); if (!room) return;
      const player = auth(room, (req.body || {}).playerId, (req.body || {}).token, res); if (!player) return;
      room.players.delete(player.id);
      if (player.id === room.hostId) {
        const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (next) room.hostId = next.id; else rooms.delete(room.code);
      }
      res.json({ ok: true });
      broadcast(room);
    });

    // TTL cleanup
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [code, room] of rooms) {
        if (now - room.createdAt > ROOM_TTL_MS) {
          for (const { heart } of room.listeners.values()) { try { clearInterval(heart); } catch {} }
          rooms.delete(code);
        }
      }
    }, 5 * 60 * 1000);
    if (cleanup.unref) cleanup.unref();
  }

  return { wireRoutes, rooms };
}

module.exports = { makePartyRouter };
