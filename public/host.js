const socket = io();

let roomCode = null;
let state = null;

const el = (id) => document.getElementById(id);

function render() {
  if (!state) return;

  el("roomPill").textContent = `Room: ${state.code}`;
  el("playersPill").textContent = `Players: ${state.players.length}`;

  // Invite link
  const base = `${location.origin}/player.html`;
  el("inviteLink").value = base;

  // Mode hint
  el("modeHint").textContent =
    state.mode === "BUZZER"
      ? "Mode: BUZZER — players buzz from phones. Use Unlock Buzzer if needed."
      : `Mode: TURNS — current turn: ${state.teams[state.turn.teamIndex].name}`;

  // Buzzer status
  if (state.mode === "BUZZER") {
    if (state.buzzer?.winner) {
      el("buzzStatus").innerHTML = `<div class="pill">Buzz winner: <strong>${state.buzzer.winner.name}</strong> (${state.teams[state.buzzer.winner.teamIndex].name})</div>`;
    } else {
      el("buzzStatus").innerHTML = `<div class="pill">Buzz: ${state.buzzer.locked ? "Locked" : "Open"}</div>`;
    }
  } else {
    el("buzzStatus").innerHTML = "";
  }

  // Scoreboard
  const sb = el("scoreboard");
  sb.innerHTML = "";
  state.teams.forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "scoreRow";
    row.innerHTML = `
      <input data-team="${idx}" class="teamName" value="${t.name}" />
      <strong>${t.score}</strong>
      <button class="good" data-add="${idx}">+100</button>
      <button class="bad" data-sub="${idx}">-100</button>
    `;
    sb.appendChild(row);
  });

  // Board
  const board = el("board");
  board.innerHTML = "";

  // Category headers
  state.game.categories.forEach((cat) => {
    const div = document.createElement("div");
    div.className = "cat";
    div.textContent = cat.name;
    board.appendChild(div);
  });

  // Rows
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      const clue = state.game.categories[c].clues[r];
      const cell = document.createElement("div");
      cell.className = "cell" + (clue.used ? " used" : "");
      cell.textContent = `$${clue.value}`;
      cell.dataset.c = c;
      cell.dataset.r = r;
      cell.onclick = () => {
        if (clue.used) return;
        socket.emit("host:pickClue", { code: roomCode, catIdx: c, rowIdx: r });
      };
      board.appendChild(cell);
    }
  }

  // Modal
  const modal = el("modal");
  if (state.active) {
    modal.classList.add("show");
    const { catIdx, rowIdx, showing } = state.active;
    const cat = state.game.categories[catIdx];
    const clue = cat.clues[rowIdx];
    el("modalTitle").textContent = `${cat.name} — $${clue.value}${clue.dd ? " (Daily Double)" : ""} — ${showing === "q" ? "Question" : "Answer"}`;
    el("modalText").textContent = showing === "q" ? clue.q : clue.a;
  } else {
    modal.classList.remove("show");
  }

  // Turn button visibility
  el("nextTurn").style.display = state.mode === "TURNS" ? "inline-flex" : "none";
  el("unlockBuzzer").style.display = state.mode === "BUZZER" ? "inline-flex" : "none";
}

el("createRoom").onclick = () => {
  socket.emit("host:createRoom", {
    hostName: el("hostName").value,
    mode: el("mode").value === "TURNS" ? "TURNS" : "BUZZER"
  });
};

el("copyInvite").onclick = async () => {
  try {
    await navigator.clipboard.writeText(el("inviteLink").value);
    el("copyInvite").textContent = "Copied!";
    setTimeout(() => (el("copyInvite").textContent = "Copy"), 900);
  } catch {
    alert("Copy failed — long-press to copy the link.");
  }
};

el("newRound").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:newRound", { code: roomCode, keepScores: el("keepScores").checked });
};

el("unlockBuzzer").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:unlockBuzzer", { code: roomCode });
};

el("nextTurn").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:nextTurn", { code: roomCode });
};

el("showAnswer").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:showAnswer", { code: roomCode });
};

el("closeClue").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:closeClue", { code: roomCode, markUsed: true });
};

el("closeNoUse").onclick = () => {
  if (!roomCode) return;
  socket.emit("host:closeClue", { code: roomCode, markUsed: false });
};

// Delegated scoreboard actions
document.addEventListener("click", (e) => {
  const add = e.target?.dataset?.add;
  const sub = e.target?.dataset?.sub;
  if (add !== undefined && roomCode) socket.emit("host:score", { code: roomCode, teamIndex: Number(add), delta: 100 });
  if (sub !== undefined && roomCode) socket.emit("host:score", { code: roomCode, teamIndex: Number(sub), delta: -100 });
});

document.addEventListener("change", (e) => {
  if (e.target.classList.contains("teamName") && roomCode) {
    const idx = Number(e.target.dataset.team);
    socket.emit("host:renameTeam", { code: roomCode, teamIndex: idx, name: e.target.value });
  }
});

socket.on("room:created", ({ code, state: s }) => {
  roomCode = code;
  state = s;
  render();
  // show code in URL hash for convenience
  location.hash = code;
});

socket.on("room:update", ({ state: s }) => {
  state = s;
  render();
});

socket.on("room:ended", () => {
  alert("Host disconnected. Room ended.");
  roomCode = null;
  state = null;
  render();
});
