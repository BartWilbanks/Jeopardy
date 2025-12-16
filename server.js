// server.js — Jeopardy Live (WordPress-friendly) + Online Random Questions (OpenTDB)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * In-memory rooms (fine for starting; for persistence use Redis/DB)
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
  // Request a token once; it reduces repeats
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
  // Called if OpenTDB says token is empty/invalid
  OPENTDB_TOKEN = null;
  return getToken();
}

// OpenTDB encodes quotes and symbols in question text; decode the common ones.
function decodeHTMLEntities(str = "") {
  return str
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

// Your requested categories mapped to OpenTDB category IDs
const OPENTDB_CATEGORIES = [
  { name: "Math", id: 19 },          // Science: Mathematics
  { name: "Science", id: 17 },       // Science & Nature
  { name: "Sports", id: 21 },        // Sports
  { name: "Pop Culture", id: 11 },   // Entertainment: Film (works well for “pop culture”)
  { name: "Family Trivia", id: 9 },  // General Knowledge
  { name: "Geography", id: 22 }      // Geography
];

const VALUE_ROWS = [100, 200, 300, 400, 500];
// We approximate grade range by ramping difficulty: easy → medium → hard
const DIFF_BY_ROW = ["easy", "easy", "medium", "medium", "hard"];

// Fetch ONE multiple-choice question for a category + difficulty.
// Returns { q, a } or null on failure.
async function fetchOneQuestion({ categoryId, difficulty, token }) {
  const url =
    `https://opentdb.com/api.php?amount=1&category=${categoryId}` +
    `&difficulty=${difficulty}&type=multiple` +
    (token ? `&token=${token}` : "");

  const r = await fetch(url);
  const j = await r.json();

  // OpenTDB response_code meanings:
  // 0 success, 3 token not found, 4 token empty
  if (j?.response_code === 3 || j?.response_code === 4) {
    return { tokenProblem: true };
  }
  const item = j?.results?.[0];
  if (!item) return null;

  return {
    q: decodeHTMLEntities(item.question),
    a: decodeHTMLEntities(item.correct_answer)
  };
}

function fallbackClue(catName, value, diff) {
  // If OpenTDB fails (rare), we still show something rather than blank
  return {
    value,
    q: `[${catName}] (${diff}) — Question unavailable (try New Round)`,
    a: `No answer (API unavailable)`,
    used: false,
    dd: false
  };
}

async function buildGameFromOpenTDB() {
  let token = await getToken();

  // Build 6 categories × 5 clues each = 30 total
  const categories = [];

  for (const cat of OPENTDB_CATEGORIES) {
    // Pull 5 questions (one per row difficulty)
    let clues = [];

    for (let i = 0; i < VALUE_ROWS.length; i++) {
      const value = VALUE_ROWS[i];
      const diff = DIFF_BY_ROW[i];

      try {
        let result = await fetchOneQuestion({
          categoryId: cat.id,
          difficulty: diff,
          token
        });

        // If token is bad/empty, reset once and retry this clue
        if (result && result.tokenProblem) {
          token = await resetToken();
          result = await fetchOneQuestion({
            categoryId: cat.id,
            difficulty: diff,
            token
          });
        }

        if (!result || result.tokenProblem) {
          clues.push(fallbackClue(cat.name, value, diff));
        } else {
          clues.push({
            value,
            q: result.q,
            a: result.a,
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
    const p = Math.floor(Math.random() * 30);
    const row = Math.floor(p / 6);
    if (row === 0) continue;
    ddPositions.add(p);
  }
  for (const p of ddPositions) {
    const col = p % 6;
    const row = Math.floor(p / 6);
    categories[col].clues[row].dd = true;
  }

  // Final Jeopardy: we fetch one “hard” general question
  let finalQ = "Final Jeopardy question unavailable (try New Round)";
  let finalA = "No answer";
  try {
    const token2 = await getToken();
    let res = await fetchOneQuestion({ categoryId: 9, difficulty: "hard", token: token2 }); // General Knowledge
    if (res && res.tokenProblem) {
      await resetToken();
      res = await fetchOneQuestion({ categoryId: 9, difficulty: "hard", token: await getToken() });
    }
    if (res && !res.tokenProblem) {
      finalQ = res.q;
      finalA = res.a;
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
  // Host creates room (mode chosen per room)
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
    room.buzzer = { locked: false, winner: null }; // reset buzz for this clue

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

  // TURNS mode: set / next turn
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

  // BUZZER mode: players buzz in
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

  // Host new round (fresh online questions)
  socket.on("host:newRound", async ({ code, keepScores }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.game = await buildGameFromOpenTDB();
    room.active = null;
    room.buzzer = { locked: false, winner: null };

    if (!keepScores) {
      room.teams.forEach(t => (t.score = 0));
    }

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
