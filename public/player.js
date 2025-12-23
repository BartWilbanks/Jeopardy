const socket = io();
let roomCode = null;
let state = null;

const el = (id) => document.getElementById(id);

function render() {
  if (!state) return;

  const myTeam = Number(el("team").value || 0);
  const teamName = state.teams?.[myTeam]?.name || `Team ${myTeam + 1}`;

  el("team").innerHTML = state.teams.map((t, i) => `<option value="${i}">${t.name}</option>`).join("");

  // BUZZ button behavior
  const inBuzzerMode = state.mode === "BUZZER";
  const clueActive = !!state.active;
  const locked = !!state.buzzer?.locked;

  el("buzz").disabled = !inBuzzerMode || !clueActive || locked;

  if (inBuzzerMode) {
    if (!clueActive) el("playerInfo").innerHTML = `<small>Waiting for the host to open a question…</small>`;
    else if (locked && state.buzzer?.winner) el("playerInfo").innerHTML = `<small>Buzzed: <strong>${state.buzzer.winner.name}</strong></small>`;
    else el("playerInfo").innerHTML = `<small>Tap BUZZ when you know it.</small>`;
  } else {
    el("playerInfo").innerHTML = `<small>Mode is TAKE TURNS — buzzing is disabled. Ask the host whose turn it is.</small>`;
  }

  el("statusPill").textContent = `Joined: ${roomCode} • ${teamName}`;
}

el("join").onclick = () => {
  const code = (el("code").value || "").trim().toUpperCase();
  const name = (el("name").value || "").trim();
  const teamIndex = Number(el("team").value || 0);
  if (!code) return alert("Enter a room code.");
  socket.emit("player:join", { code, playerName: name, teamIndex });
};

el("buzz").onclick = () => {
  if (!roomCode) return;
  socket.emit("player:buzz", { code: roomCode });
};

// Auto-fill code from URL hash (? or #)
(function initCode() {
  const h = (location.hash || "").replace("#", "").trim().toUpperCase();
  if (h) el("code").value = h;
})();

socket.on("player:joined", ({ code, state: s }) => {
  roomCode = code;
  state = s;
  render();
});

socket.on("room:update", ({ state: s }) => {
  state = s;
  render();
});

socket.on("room:error", ({ message }) => {
  alert(message || "Room error");
});

socket.on("room:ended", () => {
  alert("Room ended.");
  roomCode = null;
  state = null;
  el("statusPill").textContent = "Not connected";
  el("buzz").disabled = true;
  el("playerInfo").innerHTML = `<small>Room ended. Ask host for a new code.</small>`;
});
