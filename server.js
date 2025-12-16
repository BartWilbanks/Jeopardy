// server.js — Jeopardy Live + Online Random Questions (OpenTDB) with robust retries/pooling

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * In-memory rooms (fine for family games / small groups).
 * If you ever want persistence or many concurrent rooms, use Redis.
 */
const rooms = new Map();

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clampTeam(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(2, n));
}

/* =========================
   Open Trivia DB integration
   ========================= */

let OPENTDB_TOKEN = null;

async function getToken() {
  if (OPENTDB_TOKEN) return OPENTDB_TOKEN;
  try {
    const r = await fetch("https://opentdb.com/api_token.php?command=request");
    const j = await r.json();
    OPENTDB_TOKEN = j?.token || null;
    return OPENTDB_TOKEN;
  } catch {
    OPENTDB_TOKEN = null;
    return null;
  }
}

async function resetToken() {
  OPENTDB_TOKEN = null;
  return getToken();
}

// OpenTDB returns HTML entities — decode common ones
function decodeHTMLEntities(str = "") {
  return String(str)
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&eacute;", "é")
    .replaceAll("&rsquo;", "’")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Your requested categories mapped to OpenTDB category IDs
const OPENTDB_CATEGORIES = [
  { name: "Math", id: 19 },           // Science: Mathematics
  { name: "Science", id: 17 },        // Science & Nature
  { name: "Sports", id: 21 },         // Sports
  { name: "Pop Culture", id: 11 },    // Entertainment: Film (solid pop-culture bucket)
  { name: "Family Trivia", id: 9 },   // General Knowledge
  { name: "Geography", id: 22 }       // Geography
];

const VALUE_ROWS = [100, 200, 300, 400, 500];
// Approx “5th grade -> adult” by ramping difficulty up the board
const DIFF_BY_ROW = ["easy", "easy", "medium", "medium", "hard"];

/**
 * OpenTDB response_code:
 * 0 = success
 * 1 = no results
 * 2 = invalid parameter
 * 3 = token not found
 * 4 = token empty
 */
function isTokenProblem(code) {
  return code === 3 || code === 4;
}

/**
 * Fetch a pool of questions with a multi-step fallback strategy so it almost never returns empty.
 * We try:
 *  1) category + difficulty + type=multiple
 *  2) category + difficulty + any type
 *  3) category only + type=multiple
 *  4) category only + any type
 */
async function fetchPool({ categoryId, difficulty, token, amount = 10 }) {
  const attempts = [
    { difficulty, type: "multiple" },
    { difficulty, type: null },
    { difficulty: null, type: "multiple" },
    { difficulty: null, type: null }
  ];

  for (const a of attempts) {
    let url = `https://opentdb.com/api.php?amount=${amount}&category=${categoryId}`;
    if (a.difficulty) url += `&difficulty=${a.difficulty}`;
    if (a.type) url += `&type=${a.type}`;
    if (token) url += `&token=${token}`;

    const r = await fetch(url);
    const j = await r.json();

    if (isTokenProblem(j?.response_code)) return { tokenProblem: true };
    if (j?.response_code === 0 && Array.isArray(j.results) && j.results.length) {
      // Normalize Q/A text
      const normalized = j.results
        .map(item => ({
          q: decodeHTMLEntities(item.question),
          a: decodeHTMLEntities(item.correct_answer)
        }))
        .filter(x => x.q && x.a);

      if (normalized.length) return { items: normalized };
    }
  }

  return { items: [] };
}

function fallbackClue(catName, value, diff) {
  return {
    value,
    q: `[${catName}] (${diff}) — Couldn’t fetch an online question. Click “New Round”.`,
    a: `No answer (API unavailable)`,
    used: false,
    dd: false
  };
}

/**
 * Build a full Jeopardy board from OpenTDB.
 * Uses pools + retries + token reset to avoid blanks.
 */
async function buildGameFromOpenTDB() {
  let token = await getToken();

  const categories = [];

  for (const cat of OPENTDB_CATEGORIES) {
    // For each row difficulty, fetch a pool and take 1 from it.
    const clues = [];

    for (let i = 0; i < VALUE_ROWS.length; i++) {
      const value = VALUE_ROWS[i];
      const diff = DIFF_BY_ROW[i];

      try {
        let pool = await fetchPool({ categoryId: cat.id, difficulty: diff, token, amount: 10 });

        // Token exhausted/invalid -> reset once and retry
        if (pool.tokenProblem) {
          token = await resetToken();
          pool = await fetchPool({ categoryId: cat.id, difficulty: diff, token, amount: 10 });
        }

        const items = pool.items || [];
        if (!items.length) {
          clues.push(fallbackClue(cat.name, value, diff));
        } else {
          const pick = items[Math.floor(Math.random() * items.length)];
          clues.push({
            value,
            q: pick.q,
            a: pick.a,
            used: false,
            dd: false
          });
        }
      } catch {
        clues.push(fallbackClue(cat.name, value, diff));
      }
    }

    categories.push({ name: cat.name, clues });
  }

  // Add 2 Daily Doubles (not in the first row)
  const ddPositions = new Set();
  while (ddPositions.size < 2) {
    const p = Math.floor(Math.random() * 30); // 6 cols * 5 rows
    const row = Math.floor(p / 6);
    if (row === 0) continue;
    ddPositions.add(p);
  }
  for (const p of ddPositions) {
    const col = p % 6;
    const row = Math.floor(p / 6);
    if (categories[col]?.clues?.[row]) categories[col].clues[row].dd = true;
  }

  // Final Jeopardy — pull a harder general knowledge pool
  let finalQ = "Final Jeopardy question unavailable (try New Round)";
  let finalA = "No answer";
  try {
    let token2 = await getToken();
    let pool = await fetchPool({ categoryId: 9, difficulty: "hard", token: token2, amount: 10 });
    if (pool.tokenProblem) {
      token2 = await resetToken();
      pool = await fetchPool({ categoryId: 9, difficulty: "hard", token: token2, amount: 10 });
    }
    if (pool.items?.length) {
      const pick = pool.items[Math.floor(Math.random() * pool.items.length)];
      finalQ = pick.q;
      finalA = pick.a;
    }
  } catch {
    // keep fallback
  }

  return {
    title: "Jeopardy Live",
    categories,
    final: { category: "Final Jeopardy", q: finalQ, a: finalA }
  };
}

/* =========================
   Room state + socket logic
   ========================= */

function publicState(room) {
  return {
    code: room.code,
    hostName: room.hostName,
    mode: room.mode, // "BUZZER" or "TURNS"
    teams: room.teams,
    players: Array.from(room.players.values()),
    game: room.game,
    active: room.active,
    turn: room.turn,
    buzzer: room.buzzer
  };
}

io.on("connection", (socket) => {
  // Host creates room
  socket.on("host:createRoom", async ({ hostName, mode }) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const room = {
      code,
      hostSocketId: socket.id,
      hostName: (hostName || "Host").slice(0, 30),
      mode: (mode === "TURNS") ? "TURNS" : "BUZZER",
      players: new Map(),
      teams: [
        { name: "Team 1", score: 0 },
        { name: "Team 2", score: 0 },
        { name: "Team 3", score: 0 }
      ],
      game: await buildGameFromOpenTDB(),
      active: null,
      turn: { teamIndex: 0 },
      buzzer: { locked: false, winner: null }
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit("room:created", { code, state: publicState(room) });
  });

  // Player joins
  socket.on("player:join", ({ code, playerName, teamIndex }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("room:error", { message: "Room not found." });

    socket.join(code);
    room.players.set(socket.id, {
      name: (playerName?.trim() || "Player").slice(0, 25),
      teamIndex: clampTeam(teamIndex)
    });

    io.to(code).emit("room:update", { state: publicState(room) });
    socket.emit("player:joined", { code, state: publicState(room) });
  });

  // Host picks clue
  socket.on("host:pickClue", ({ code, catIdx, rowIdx }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    const clue = room.game.categories?.[catIdx]?.clues?.[rowIdx];
    if (!clue || clue.used) return;

    room.active = { catIdx, rowIdx, showing: "q" };
    room.buzzer = { locked: false, winner: null };
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Host show answer
  socket.on("host:showAnswer", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    if (!room.active) return;

    room.active.showing = "a";
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Host close clue
  socket.on("host:closeClue", ({ code, markUsed }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.active && markUsed) {
      const { catIdx, rowIdx } = room.active;
      const clue = room.game.categories?.[catIdx]?.clues?.[rowIdx];
      if (clue) clue.used = true;
    }
    room.active = null;

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Score team
  socket.on("host:score", ({ code, teamIndex, delta }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    const idx = clampTeam(teamIndex);
    room.teams[idx].score += Number(delta) || 0;

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Rename team
  socket.on("host:renameTeam", ({ code, teamIndex, name }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    const idx = clampTeam(teamIndex);
    room.teams[idx].name = (name || `Team ${idx + 1}`).slice(0, 20);

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // TURNS: set/next turn
  socket.on("host:setTurn", ({ code, teamIndex }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.turn.teamIndex = clampTeam(teamIndex);
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  socket.on("host:nextTurn", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.turn.teamIndex = (room.turn.teamIndex + 1) % 3;
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // BUZZER: players buzz
  socket.on("player:buzz", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.mode !== "BUZZER") return;
    if (!room.active) return;
    if (room.buzzer.locked) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    room.buzzer.locked = true;
    room.buzzer.winner = { name: player.name, teamIndex: player.teamIndex };

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Host unlock buzzer
  socket.on("host:unlockBuzzer", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.buzzer = { locked: false, winner: null };
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  // Host new round (fresh online board)
  socket.on("host:newRound", async ({ code, keepScores }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.game = await buildGameFromOpenTDB();
    room.active = null;
    room.buzzer = { locked: false, winner: null };

    if (!keepScores) room.teams.forEach(t => (t.score = 0));

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("room:ended");
        rooms.delete(code);
        break;
      }
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(code).emit("room:update", { state: publicState(room) });
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeopardy Live running on port ${PORT}`));
