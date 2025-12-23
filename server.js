// server.js — Jeopardy Live (multiplayer) with 3000-question local bank (no external APIs)
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static site
app.use(express.static(path.join(__dirname, "public")));

// Load question bank (3000)
const BANK_PATH = path.join(__dirname, "public", "questions_3000.json");
let QUESTION_BANK = [];
try {
  QUESTION_BANK = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
  console.log(`Loaded ${QUESTION_BANK.length} questions from ${BANK_PATH}`);
} catch (e) {
  console.error("Failed to load question bank:", e);
}

// Game configuration
const CATEGORIES = ["Math", "Science", "Sports", "Pop Culture", "Family Trivia", "Geography"];
const VALUE_ROWS = [100, 200, 300, 400, 500];
const DIFF_BY_ROW = ["easy", "easy", "medium", "medium", "hard"]; // 5th grade -> adult ramp

// In-memory rooms
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
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPool(category, difficulty) {
  return QUESTION_BANK.filter(q => q.category === category && q.difficulty === difficulty);
}

/**
 * Picks a question from pool that hasn't been used in this room (best-effort).
 * If everything is used, it will reuse.
 */
function pickQuestion(room, category, difficulty) {
  const pool = getPool(category, difficulty);
  if (!pool.length) return null;

  const unused = pool.filter(q => !room.usedQuestionIds.has(q.id));
  const pickFrom = unused.length ? unused : pool;
  const q = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  room.usedQuestionIds.add(q.id);
  return q;
}

function buildGameFromBank(room) {
  const categories = [];

  for (let c = 0; c < CATEGORIES.length; c++) {
    const name = CATEGORIES[c];
    const clues = [];

    for (let r = 0; r < VALUE_ROWS.length; r++) {
      const value = VALUE_ROWS[r];
      const diff = DIFF_BY_ROW[r];
      const q = pickQuestion(room, name, diff);

      clues.push({
        value,
        q: q ? q.question : `[${name}] No question found`,
        a: q ? q.answer : "No answer",
        used: false,
        dd: false
      });
    }

    categories.push({ name, clues });
  }

  // Add 2 Daily Doubles (not in row 0)
  const ddPositions = new Set();
  while (ddPositions.size < 2) {
    const p = Math.floor(Math.random() * 30); // 6x5
    const row = Math.floor(p / 6);
    if (row === 0) continue;
    ddPositions.add(p);
  }
  for (const p of ddPositions) {
    const col = p % 6;
    const row = Math.floor(p / 6);
    categories[col].clues[row].dd = true;
  }

  // Final Jeopardy: hard family trivia
  const fj = pickQuestion(room, "Family Trivia", "hard") || pickQuestion(room, "Pop Culture", "hard") || pickQuestion(room, "Science", "hard");

  return {
    title: "Jeopardy Live",
    categories,
    final: { category: "Final Jeopardy", q: fj ? fj.question : "Final question", a: fj ? fj.answer : "Answer" }
  };
}

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

// Simple health + debug endpoint
app.get("/debug/bank", (req, res) => {
  const counts = {};
  for (const cat of CATEGORIES) {
    counts[cat] = { easy: 0, medium: 0, hard: 0 };
  }
  for (const q of QUESTION_BANK) {
    if (counts[q.category] && counts[q.category][q.difficulty] !== undefined) counts[q.category][q.difficulty]++;
  }
  res.json({ loaded: QUESTION_BANK.length, counts });
});

io.on("connection", (socket) => {
  // Host creates room
  socket.on("host:createRoom", ({ hostName, mode }) => {
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
      usedQuestionIds: new Set(),
      game: null,
      active: null,
      turn: { teamIndex: 0 },
      buzzer: { locked: false, winner: null }
    };

    // Build the board (from local bank)
    room.game = buildGameFromBank(room);

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
      id: socket.id,
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

  // Host new round (fresh random board from bank)
  socket.on("host:newRound", ({ code, keepScores }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.game = buildGameFromBank(room);
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
