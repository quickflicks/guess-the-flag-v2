# 🚩 FlagQuest

A full-stack **"Guess the Flag"** game: pick a difficulty and a continent, choose your game mode and style, build fiery streaks, chase hints, climb the leaderboard — or open a **party room** and play friends live with an invite code.

![Screenshot placeholder](https://img.shields.io/badge/node-%3E%3D18-green) built on Node.js + Express with a zero-build vanilla JS frontend.

## Quick start

```bash
npm install
npm start          # → http://localhost:3000
```

Windows shortcut: double-click **`start.bat`** (launches the server and opens your browser).

Flags are loaded from the free CDN [flagcdn.com](https://flagcdn.com) — an internet connection is required for flag images.

## Features

### Game rules & difficulty
| Level | Question type | Choices | Timer | Pool | Base points |
|---|---|---|---|---|---|
| 🌱 Easy | flag → country | 2 | 20 s | most famous countries | 100 |
| ⚡ Medium | flag → country | 4 | 15 s | famous + familiar | 150 |
| 🔥 Hard | flag → country | 4 | 12 s | tough & obscure flags | 200 |
| 💀 Expert | flag → **typed name** | 0 | 25 s | obscure flags only | 250 |

- **Points** = base + speed bonus (`seconds left × 5`) + streak bonus (up to +100), cut by −50 per hint used on that question.
- **6 regions** (🌍 Worldwide, 🦁 Africa, 🐉 Asia, 🏰 Europe, 🦅 North America, 🦜 South America, 🐨 Oceania). Narrow continents automatically widen their pool tier so games never run dry.
- **2 game modes**: Flag → Country and Country → Flag (Expert is always flag → typing).
- **Round length**: 5 / 10 / 15 / 20 questions (Classic only — blitz/survival run the whole pool).

### Game styles
| Style | Rule |
|---|---|
| 🎯 Classic | A fixed set of questions, manual "Next" between reveals. |
| ⏱️ Blitz | One 60-second time bank for the whole run. Correct: **+2 s**, wrong: **−3 s**. 10 s per question. Runs until the bank runs dry or the pool is exhausted. |
| ❤️ Survival | **3 lives.** Every wrong answer/timeout costs one, skips don't. Auto-advances; run ends when the lives run out. |

### Daily Challenge 🗓️
One button on the home screen: **10 questions, identical for everyone that day** (server-side seeded RNG based on the date + your region/difficulty/mode). Your browser remembers when it's done; the set resets at midnight.

### Party rooms 👥 — play with friends
- **Create room** → you get a 6-character invite code (no lookalike letters: no `0/O/1/I`) plus a **copy invite link** button (`http://<host>:3000/?room=CODE`). Friends can paste the link, or enter the code on the *Join with code* screen.
- Up to **8 players**; everyone gets the **same question set**, answers are held server-side per player, and a **live scoreboard** streams over SSE while you play (rank, streak, answers done, finished 🏁).
- The lobby shows players in real time; **the host starts the match**, and a rematch button returns everyone to the lobby for another round.
- When everybody finishes, everyone sees a podium (🥇🥈🥉) with final standings — first to finish isn't always first: accuracy and speed count.
- Works on localhost and across your local network — anyone who can open the server in a browser can join via the invite link.

### Extras
- 💡 **Hints** — 3 per game: *50/50* (removes wrong choices) or *first letter* in Expert mode. Answers in Expert accept common aliases (USA, UK, Burma, Swaziland, Czech Republic, Côte d'Ivoire …) and ignore accents/punctuation.
- ⏭ Skip (streak resets), ⏰ auto-timeout reveal.
- 🔥 Streaks with fusing pill + milestone sounds.
- 🏆 **Server-persisted leaderboard** with difficulty filters and rank badges; global stats (games played, accuracy) on the home screen.
- 📋 Share/copy your result, 🧧 confetti on strong runs.
- 🔈 WebAudio sound effects with a mute toggle (persisted).
- ⌨️ Keyboard play: `1–4` answer · `Enter` next/submit · `S` skip · `H` hint · `1–4` on home picks difficulty.
- 📱 Fully responsive, dark glassmorphism UI, flag preloading, skeleton loaders, tab-switch pauses the timer.
- After each answer you get **fact chips**: capital, region, population.

### Under the hood (full-stack)
- **Server** (`server.js`, Express): generates question sets and keeps **correct answers server-side** (the browser never receives them until you answer), validates answers/score/streak/hints/skips, TTL-cleans sessions, auto-falls back to port 3001+ if 3000 is busy, persists `data/leaderboard.json` + `data/stats.json`.
- **Party** (`party.js`): 6-char invite codes, room state machine (lobby → playing → finished), per-player server-side scoring, SSE live scoreboard, host crown inheritance, TTL cleanup. Rooms live up to 2 h in memory.
- **Data** (`data/countries.json`): 197 flag sets with ISO code, continent, capital, population, and a fame tier (1 = famous … 4 = deep cut). Validate it any time with `npm run validate`.
- **API**
  | Method | Route | Purpose |
  |---|---|---|
  | GET | `/api/config` | regions, difficulties, modes, styles, lengths |
  | GET | `/api/stats` | aggregate stats |
  | GET | `/api/leaderboard?difficulty=&limit=` | top scores |
  | POST | `/api/game` | start session (`{style, daily, …}`) → `{gameId, questions, bank/lives}` |
  | POST | `/api/game/:id/answer` | submit answer/timeout |
  | POST | `/api/game/:id/skip` | skip question |
  | POST | `/api/game/:id/hint` | 50/50 or letter |
  | POST | `/api/game/:id/finish` | finalize, record leaderboard entry |
  | POST | `/api/room` | create party room (host) → `{code, playerId, token, room}` |
  | POST | `/api/room/:code/join` | join with invite code (blocked mid-round) |
  | GET | `/api/room/:code` | room snapshot (rejoin/refresh) |
  | GET | `/api/room/:code/stream` | live SSE updates (scoreboard, state changes) |
  | POST | `/api/room/:code/start` | host starts the round |
  | GET | `/api/room/:code/questions` | each player pulls the shared deck |
  | POST | `/api/room/:code/answer` | player answer (`playerId` + `token` auth) |
  | POST | `/api/room/:code/skip` / `/hint` | party-mode skip & hint |
  | POST | `/api/room/:code/rematch` | host resets the room to the lobby |
  | POST | `/api/room/:code/leave` | leave (host crown passes on) |

- **Tests / checks**: `npm run validate` (dataset + matching), plus a full API test pass covers scoring, streak reset, timeouts, skips, hint caps, alias matching, small-pool fallbacks, party room lifecycle (create → join → start → answer → finish → rematch) and leaderboard persistence.

## Playing with friends (LAN/localhost)

1. Start the server on any machine (`npm start` or `start.bat`).
2. Player 1 → **👥 Create room** (Party screen) — set difficulty/region/mode/rounds.
3. Copy the invite link and send it to your friends (chat, QR, however) or just tell them the 6-character code.
4. Friends open `http://<server-ip>:3000` (same network) → **🚪 Join with code** → type the code → wait in the lobby.
5. Host hits **▶ Start match** — everyone plays the same questions; live rankings stream while you play; **↻ Rematch** restarts as a group.

Player identity for rejoining after a refresh lives in `sessionStorage`, so a crashed tab just comes back mid-round.

## Project structure
```
flag-quest/
├─ server.js            # Express API + game engine (styles, daily seeding)
├─ party.js             # multiplayer rooms: invites, SSE scoreboard, rematch
├─ data/
│  ├─ countries.json    # 197 countries (name, code, region, capital, pop, tier)
│  ├─ leaderboard.json  # persisted scores (created at runtime)
│  └─ stats.json        # aggregate stats (created at runtime)
├─ utils/
│  ├─ matching.js       # fuzzy typed-answer matching + aliases
│  └─ validate.js       # dataset integrity checks
├─ public/
│  ├─ index.html
│  ├─ css/style.css
│  └─ js/app.js         # screens, timer, sounds, confetti, keyboard
├─ start.bat            # one-click launcher (Windows)
└─ package.json
```
