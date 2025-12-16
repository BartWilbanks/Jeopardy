const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * In-memory rooms. Great for starting; production can use Redis for persistence.
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

/**
 * Minimal default board (placeholder).
 * You can later replace with your offline random-bank board or Google Sheet feed.
 */
function defaultGame() {
  const values = [100, 200, 300, 400, 500];
  const cats = ["Math", "Science", "Sports", "Pop Culture", "Family Trivia", "Geography"];

  const categories = cats.map((name) => ({
    name,
    clues: values.map((v, i) => ({
      value: v,
      q: `${name} Q${i + 1} ($${v})`,
      a: `${name} A${i + 1}`,
      used: false,
      dd: false
    }))
  }));

  // Two random Daily Doubles, not in the first row
  const ddPositions = [];
  while (ddPositions.length < 2) {
    const p = Math.floor(Math.random() * 30);
    const row = Math.floor(p / 6);
    if (row === 0) continue;
    if (!ddPositions.includes(p)) ddPositions.push(p);
  }
  for (const p of ddPositions) {
    const c = p % 6;
    const r = Math.floor(p / 6);
    categories[c].clues[r].dd = true;
  }

  return {
    title: "Jeopardy Live",
    categories,
    final: { category: "Final Jeopardy", q: "Final question goes here", a: "Final answer" }
  };
}

function publicState(room) {
  return {
    code: room.code,
    hostName: room.hostName,
    mode: room.mode,                // "BUZZER" or "TURNS"
    teams: room.teams,
    players: Array.from(room.players.values()),
    game: room.game,
    active: room.active,            // {catIdx,rowIdx,showing:"q"|"a"}
    turn: room.turn,                // {teamIndex}
    buzzer: room.buzzer             // {locked, winner:{name, teamIndex} | null}
  };
}

io.on("connection", (socket) => {
  /**
   * Host creates a room (mode is chosen per room: BUZZER or TURNS)
   */
  socket.on("host:createRoom", ({ hostName, mode }) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const room = {
      code,
      hostSocketId: socket.id,
      hostName: (hostName || "Host").slice(0, 30),
      mode: (mode === "TURNS") ? "TURNS" : "BUZZER",
      players: new Map(), // socket.id -> {name, teamIndex}
      teams: [
        { name: "Team 1", score: 0 },
        { name: "Team 2", score: 0 },
        { name: "Team 3", score: 0 }
      ],
      game: defaultGame(),
      active: null,
      turn: { teamIndex: 0 },
      buzzer: { locked: false, winner: null }
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit("room:created", { code, state: publicState(room) });
  });

  /**
   * Player joins a room
   */
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

  /**
   * Host selects a clue
   */
  socket.on("host:pickClue", ({ code, catIdx, rowIdx }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    const clue = room.game.categories?.[catIdx]?.clues?.[rowIdx];
    if (!clue || clue.used) return;

    room.active = { catIdx, rowIdx, showing: "q" };
    // reset buzzer for this clue
    room.buzzer = { locked: false, winner: null };

    io.to(code).emit("room:update", { state: publicState(room) });
  });

  /**
   * Host shows answer
   */
  socket.on("host:showAnswer", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    if (!room.active) return;

    room.active.showing = "a";
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  /**
   * Host closes clue (optionally marking used)
   */
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

  /**
   * Host scores a team
   */
  socket.on("host:score", ({ code, teamIndex, delta }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    const idx = clampTeam(teamIndex);
    room.teams[idx].score += Number(delta) || 0;
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  /**
   * Host renames a team
   */
  socket.on("host:renameTeam", ({ code, teamIndex, name }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    const idx = clampTeam(teamIndex);
    room.teams[idx].name = (name || `Team ${idx + 1}`).slice(0, 20);
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  /**
   * TURNS mode: host sets active team turn
   */
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

  /**
   * BUZZER mode: players buzz in (first buzz locks)
   */
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

  /**
   * Host can unlock buzzer (e.g., after incorrect answer)
   */
  socket.on("host:unlockBuzzer", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    room.buzzer = { locked: false, winner: null };
    io.to(code).emit("room:update", { state: publicState(room) });
  });

  /**
   * Host creates a brand-new board (new round)
   * - keepScores: if false, reset scores to 0
   */
  socket.on("host:newRound", ({ code, keepScores }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.game = defaultGame();
    room.active = null;
    room.buzzer = { locked: false, winner: null };

    if (!keepScores) {
      room.teams.forEach(t => t.score = 0);
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
