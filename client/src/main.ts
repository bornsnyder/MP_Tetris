// MP Tetris client entry: lobby -> countdown -> lockstep match -> end screen.
import { Connection } from "./net/connection";
import { TouchControls } from "./net/touch";
import { sfx } from "./audio/sfx";
import { Scene3D } from "./render/scene3d";
import {
  TICKS_PER_SEC, TICK_MS, COLS, VISIBLE_ROWS,
  IN_LEFT, IN_RIGHT, IN_DOWN, IN_ROT_CW, IN_ROT_CCW, IN_HARD_DROP, IN_HOLD,
  type ServerMsg, type RoundRecord, type MatchSnapshot,
} from "../../shared/protocol";
import { createMatch, stepMatch, hashState, snapshot, restoreMatch } from "../../shared/game/engine";
import type { MatchSim } from "../../shared/game/engine";
import { InputTimeline } from "../../shared/game/inputs";

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = {
  lobby: $("screen-lobby"), hud: $("hud"), end: $("screen-end"), connLost: $("conn-lost"),
  nameInput: $("name-input") as HTMLInputElement, codeInput: $("code-input") as HTMLInputElement,
  btnCreate: $("btn-create"), btnJoin: $("btn-join"), lobbyJoin: $("lobby-join"), lobbyRoom: $("lobby-room"),
  roomCode: $("lobby-roomcode"), slot0: $("slot-0"), slot1: $("slot-1"),
  btnReady: $("btn-ready"), btnLeaveRoom: $("btn-leave-room"), btnCopyLink: $("btn-copy-link"),
  hsTable: $("hs-table") as HTMLTableElement, hsTableEnd: $("hs-table-end") as HTMLTableElement,
  youName: $("you-name"), oppName: $("opp-name"), youScore: $("you-score"), oppScore: $("opp-score"),
  youLines: $("you-lines"), oppLines: $("opp-lines"), banner: $("banner"),
  countdown: $("countdown"), countNum: document.querySelector("#countdown .num") as HTMLElement,
  endTitle: $("end-title"), endDetail: $("end-detail"),
  fsName0: $("fs-name-0"), fsName1: $("fs-name-1"), fsVal0: $("fs-val-0"), fsVal1: $("fs-val-1"),
  fs0: $("fs-0"), fs1: $("fs-1"), btnRematch: $("btn-rematch"), btnExit: $("btn-exit"),
  btnReconnect: $("btn-reconnect"), btnGotoLobby: $("btn-goto-lobby"),
  muteBtn: $("mute-btn"), toast: $("toast"), canvas: $("scene") as HTMLCanvasElement,
};

// ---------- Game state ----------
type Phase = "lobby" | "countdown" | "playing" | "ended";
const G = {
  phase: "lobby" as Phase,
  conn: new Connection(),
  scene: null as Scene3D | null,
  sim: null as MatchSim | null,
  youAre: 0 as 0 | 1,
  matchId: 0,
  seed: 0,
  startAt: 0,
  roomCode: "",
  myName: localStorage.getItem("mp-tetris-name") ?? "",
  oppName: "Opponent",
  myReady: false,
  oppReady: false,
  inTimelines: [new InputTimeline(), new InputTimeline()] as [InputTimeline, InputTimeline],
  lastSentBits: 0,
  hashWindow: new Map<number, number>(), // tick -> own hash (recent)
  resyncPending: false,
  keysDown: new Set<string>(),
  touch: null as TouchControls | null,
  lastCountShown: -1,
  prevCleared: [0, 0] as [number, number],
};

/** Rows that were full before the most recent step, per player (for clear fx). */
let fullRowsBefore: [Set<number>, Set<number>] = [new Set(), new Set()];

// ---------- UI helpers ----------
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

function showScreen(which: "lobby" | "hud" | "end"): void {
  el.lobby.classList.toggle("hidden", which !== "lobby");
  el.hud.classList.toggle("hidden", which !== "hud");
  el.end.classList.toggle("hidden", which !== "end");
}

function renderHighscores(table: HTMLTableElement, rounds: RoundRecord[]): void {
  if (rounds.length === 0) {
    table.innerHTML = `<tr class="empty"><td colspan="5">No rounds played yet — be the first!</td></tr>`;
    return;
  }
  const rows = rounds.map((r, i) => {
    const t = r.durSec >= 60 ? `${Math.floor(r.durSec / 60)}:${String(Math.round(r.durSec % 60)).padStart(2, "0")}` : `${r.durSec.toFixed(1)}s`;
    return `<tr>
      <td style="color:var(--dim)">${i + 1}</td>
      <td>${esc(r.p0.name)} <span class="score">${fmt(r.p0.score)}</span></td>
      <td>${esc(r.p1.name)} <span class="score">${fmt(r.p1.score)}</span></td>
      <td class="time">${t}</td>
    </tr>`;
  }).join("");
  table.innerHTML = `<tr><th>#</th><th>Player 1</th><th>Player 2</th><th>Time</th></tr>${rows}`;
}

function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function fmt(n: number): string { return n.toLocaleString("en-US"); }

let slotNames: [string?, string?] = [undefined, undefined];

function updateLobbySlots(): void {
  const slots = [el.slot0, el.slot1];
  for (const i of [0, 1] as const) {
    const isMe = i === G.youAre;
    const name = slotNames[i] ?? "—";
    slots[i].querySelector(".pname")!.textContent = isMe ? `${name} (you)` : name;
    const ready = isMe ? G.myReady : G.oppReady;
    slots[i].classList.toggle("ready", !!ready);
    slots[i].querySelector(".status")!.textContent = !slotNames[i] ? "waiting…" : ready ? "ready ✓" : "not ready";
  }
}

function banner(text: string, ms = 1400): void {
  el.banner.textContent = text;
  el.banner.classList.add("show");
  setTimeout(() => el.banner.classList.remove("show"), ms);
}

// ---------- Input sampling ----------
const KEY_MAP: Record<string, number> = {
  ArrowLeft: IN_LEFT, KeyA: IN_LEFT,
  ArrowRight: IN_RIGHT, KeyD: IN_RIGHT,
  ArrowDown: IN_DOWN, KeyS: IN_DOWN,
  ArrowUp: IN_ROT_CW, KeyW: IN_ROT_CW, KeyX: IN_ROT_CW,
  KeyZ: IN_ROT_CCW, ShiftLeft: IN_HOLD, ShiftRight: IN_HOLD, KeyC: IN_HOLD,
  Space: IN_HARD_DROP,
};

function sampleBits(): number {
  let b = 0;
  for (const code of G.keysDown) {
    const bit = KEY_MAP[code];
    if (bit) b |= bit;
  }
  return b;
}

// ---------- Match loop ----------
let rafId = 0;
function computeFullRows(sim: MatchSim): [Set<number>, Set<number>] {
  const out: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const pi of [0, 1] as const) {
    const p = sim.players[pi];
    for (let y = 0; y < VISIBLE_ROWS; y++) {
      let full = true;
      for (let x = 0; x < COLS; x++) if (p.grid[y * COLS + x] === 0) { full = false; break; }
      if (full) out[pi].add(y);
    }
  }
  return out;
}

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);
  if (!G.scene || !G.sim) return;
  const sim = G.sim;

  if (G.phase === "countdown") {
    const remainMs = G.startAt - Date.now();
    const n = Math.ceil(remainMs / 1000);
    if (n !== G.lastCountShown && n >= 0) {
      G.lastCountShown = n;
      el.countNum.textContent = n > 3 ? "…" : String(Math.max(1, n));
      sfx.countBeep(n <= 1);
    }
    if (remainMs <= 0) {
      G.phase = "playing";
      el.countdown.classList.add("hidden");
      banner("GO!");
    }
    // render empty boards during countdown
    G.scene.render(sim, 1 / 60);
    return;
  }

  if (G.phase !== "playing") { G.scene.render(sim, 1 / 60); return; }

  const targetTick = Math.floor((Date.now() - G.startAt) / TICK_MS);
  while (sim.tick < targetTick && !sim.over) {
    fullRowsBefore = computeFullRows(sim);
    const t = sim.tick + 1; // entering tick t
    const b0 = G.inTimelines[0].effectiveAt(t) | (G.youAre === 0 ? tapBits : 0);
    const b1 = G.inTimelines[1].effectiveAt(t) | (G.youAre === 1 ? tapBits : 0);
    stepMatch(sim, [b0, b1]);
    sim.tick = t;
    if (tapBits !== 0) { // consume the one-tick touch taps
      const me = G.youAre;
      G.inTimelines[me].setChange(t, tapBits);
      G.conn.send({ t: "in", s: t, b: tapBits });
      tapBits = 0;
    }

    // send my input change if it differs from what I last sent for this tick
    const me = G.youAre;
    const myBits = me === 0 ? b0 : b1;
    if (myBits !== G.lastSentBits) {
      G.inTimelines[me].setChange(t, myBits);
      G.conn.send({ t: "in", s: t, b: myBits });
      G.lastSentBits = myBits;
    }

    // periodic lockstep hash (every 30 ticks)
    if (t % 30 === 0) {
      const h = hashState(sim);
      G.hashWindow.set(t, h);
      if (G.hashWindow.size > 40) {
        const first = G.hashWindow.keys().next().value as number;
        G.hashWindow.delete(first);
      }
      G.conn.send({ t: "hash", tick: t, h });
    }

    // fx hooks (visual only): rows that were full before this step and are now gone
    for (const pi of [0, 1] as const) {
      if (sim.players[pi].clearedThisTick > 0) {
        const clearedRows = [...fullRowsBefore[pi]].sort((a, b2) => a - b2);
        G.scene.addClearFx(pi === 0 ? "own" : "opp", clearedRows, sim.players[pi].clearedThisTick);
        if (pi === me) {
          sfx.clear(sim.players[pi].clearedThisTick);
          const n = sim.players[pi].clearedThisTick;
          banner(n >= 4 ? "TETRIS!" : ["", "", "DOUBLE!", "TRIPLE!"][n] ?? "");
        }
      }
    }

    // detect match end locally (deterministic on both sides)
    if (sim.over) {
      const p0 = sim.players[0], p1 = sim.players[1];
      G.conn.send({
        t: "result", matchId: G.matchId, winner: sim.winner,
        scores: [p0.score, p1.score], lines: [p0.lines, p1.lines], durTicks: t,
      });
      endMatchLocal();
      break;
    }
  }

  // update HUD
  const me = G.youAre, them = (1 - G.youAre) as 0 | 1;
  el.youScore.textContent = fmt(sim.players[me].score);
  el.oppScore.textContent = fmt(sim.players[them].score);
  el.youLines.textContent = `Lines ${sim.players[me].lines} · Lvl ${sim.players[me].level}`;
  el.oppLines.textContent = `Lines ${sim.players[them].lines} · Lvl ${sim.players[them].level}`;

  G.scene.render(sim, 1 / 60);
}

function endMatchLocal(): void {
  if (G.phase === "ended") return;
  G.phase = "ended";
  const sim = G.sim!;
  const me = G.youAre;
  if (sim.winner === -1) { el.endTitle.textContent = "Draw!"; sfx.topOut(); }
  else if (sim.winner === me) { el.endTitle.textContent = `${G.myName || "You"} win!`; sfx.win(); }
  else { el.endTitle.textContent = `${G.oppName} wins — you topped out`; sfx.topOut(); }
  const durSec = sim.tick / TICKS_PER_SEC;
  el.endDetail.textContent = `Round lasted ${durSec >= 60 ? `${Math.floor(durSec / 60)}m ${Math.round(durSec % 60)}s` : `${durSec.toFixed(1)}s`} · ${sim.players[me].lines} vs ${sim.players[(1 - me) as 0 | 1].lines} lines`;
  el.fsName0.textContent = slotNames[0] ?? "Player 1";
  el.fsName1.textContent = slotNames[1] ?? "Player 2";
  el.fsVal0.textContent = fmt(sim.players[0].score);
  el.fsVal1.textContent = fmt(sim.players[1].score);
  el.fs0.classList.toggle("winner", sim.winner === 0);
  el.fs1.classList.toggle("winner", sim.winner === 1);
  showScreen("end");
}

// ---------- Server message handling ----------
function onServerMsg(msg: ServerMsg): void {
  switch (msg.t) {
    case "joined": {
      G.roomCode = msg.code;
      G.youAre = msg.youAre;
      slotNames = [undefined, undefined];
      if (msg.players[0]) slotNames[0] = msg.players[0].name;
      if (msg.players[1]) slotNames[1] = msg.players[1].name;
      G.myReady = false; G.oppReady = false;
      el.lobbyJoin.classList.add("hidden");
      el.lobbyRoom.classList.remove("hidden");
      el.roomCode.textContent = msg.code;
      updateLobbySlots();
      showScreen("lobby");
      break;
    }

    case "lobby": {
      slotNames = [msg.players[0]?.name, msg.players[1]?.name];
      G.oppReady = !!(msg.players[(G.youAre === 0 ? 1 : 0) as 0 | 1])?.ready;
      updateLobbySlots();
      if (msg.state === "postmatch") { /* stay on end screen until user acts */ }
      break;
    }

    case "start": {
      G.matchId = msg.matchId;
      G.seed = msg.seed;
      G.startAt = msg.startAt;
      G.youAre = msg.youAre;
      G.sim = createMatch(msg.seed);
      G.inTimelines[0].reset();
      G.inTimelines[1].reset();
      G.lastSentBits = 0;
      G.hashWindow.clear();
      G.prevCleared = [0, 0];
      G.phase = "countdown";
      G.lastCountShown = -1;
      el.countdown.classList.remove("hidden");
      showScreen("hud");
      el.youName.textContent = `${G.myName || "You"} (you)`;
      el.oppName.textContent = slotNames[(1 - G.youAre) as 0 | 1] ?? "Opponent";
      break;
    }

    case "in": {
      // opponent's input change, stamped at their tick s
      if (!G.sim) return;
      const them = (1 - G.youAre) as 0 | 1;
      G.inTimelines[them].setChange(msg.s, msg.b);
      break;
    }

    case "hash": {
      if (!G.sim) return;
      const mine = G.hashWindow.get(msg.tick);
      if (mine !== undefined && mine !== msg.h && !G.resyncPending) {
        G.resyncPending = true;
        G.conn.send({ t: "resync", state: JSON.stringify(snapshot(G.sim)) });
        toast("Resyncing…");
      }
      break;
    }

    case "resyncReq": {
      if (!G.sim || G.phase !== "playing") return;
      G.resyncPending = true;
      G.conn.send({ t: "resync", state: JSON.stringify(snapshot(G.sim)) });
      break;
    }

    case "adopt": {
      const snap = JSON.parse(msg.state) as MatchSnapshot;
      G.sim = restoreMatch(snap, G.seed);
      // rebase clock so both clients resume aligned at newStartAt
      G.startAt = msg.newStartAt - G.sim.tick * TICK_MS;
      if (G.phase === "playing" || G.phase === "countdown") {
        G.phase = "playing";
        el.countdown.classList.add("hidden");
      }
      G.resyncPending = false;
      toast("Resynced");
      break;
    }

    case "matchEnd": {
      // server-confirmed end (also updates highscores)
      if (G.phase !== "ended") endMatchLocal();
      renderHighscores(el.hsTableEnd, []); // will be refreshed by scores msg
      break;
    }

    case "peerLeft": {
      if (G.phase === "playing" || G.phase === "countdown") {
        G.phase = "ended";
        el.endTitle.textContent = `${G.oppName} disconnected`;
        el.endDetail.textContent = "Match ended.";
        const sim = G.sim;
        if (sim) {
          el.fsVal0.textContent = fmt(sim.players[0].score);
          el.fsVal1.textContent = fmt(sim.players[1].score);
          el.fsName0.textContent = slotNames[0] ?? "Player 1";
          el.fsName1.textContent = slotNames[1] ?? "Player 2";
        }
        showScreen("end");
      } else {
        toast(`${G.oppName} left the room`);
        G.oppReady = false;
        updateLobbySlots();
      }
      break;
    }

    case "scores": {
      renderHighscores(el.hsTable, msg.rounds);
      renderHighscores(el.hsTableEnd, msg.rounds);
      break;
    }

    case "error": {
      toast(msg.msg);
      if (msg.msg.includes("expired") || msg.msg.includes("not found")) leaveRoomToLobby();
      break;
    }
  }
}

// ---------- Lobby actions ----------
function joinRoom(code?: string): void {
  const name = G.myName.trim() || "Player";
  localStorage.setItem("mp-tetris-name", name);
  G.conn.send({ t: "join", name, code });
}

function leaveRoomToLobby(): void {
  G.phase = "lobby";
  G.sim = null;
  G.roomCode = "";
  slotNames = [undefined, undefined];
  el.lobbyJoin.classList.remove("hidden");
  el.lobbyRoom.classList.add("hidden");
  showScreen("lobby");
}

function setupLobby(): void {
  el.nameInput.value = G.myName;
  el.nameInput.addEventListener("input", () => { G.myName = el.nameInput.value; });
  el.btnCreate.addEventListener("click", () => joinRoom());
  el.btnJoin.addEventListener("click", () => joinRoom(el.codeInput.value.trim().toUpperCase() || undefined));
  el.codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(el.codeInput.value.trim().toUpperCase() || undefined); });

  el.btnReady.addEventListener("click", () => {
    G.myReady = !G.myReady;
    G.conn.send({ t: "ready", v: G.myReady });
    updateLobbySlots();
  });
  el.btnLeaveRoom.addEventListener("click", () => { G.conn.send({ t: "leave" }); leaveRoomToLobby(); });
  el.btnCopyLink.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#room=${G.roomCode}`;
    try { await navigator.clipboard.writeText(url); toast("Invite link copied!"); }
    catch { toast(url); }
  });

  el.btnRematch.addEventListener("click", () => {
    G.myReady = true;
    G.conn.send({ t: "ready", v: true });
    showScreen("lobby");
    updateLobbySlots();
    toast("Waiting for opponent to ready up…");
  });
  el.btnExit.addEventListener("click", () => { G.conn.send({ t: "leave" }); leaveRoomToLobby(); });

  el.btnReconnect.addEventListener("click", () => {
    el.connLost.classList.add("hidden");
    connectAndJoin();
  });
  el.btnGotoLobby.addEventListener("click", () => {
    el.connLost.classList.add("hidden");
    leaveRoomToLobby();
  });

  el.muteBtn.addEventListener("click", () => {
    sfx.muted = !sfx.muted;
    el.muteBtn.textContent = sfx.muted ? "🔇 Muted" : "🔊 Sound on";
  });

  // deep link: #room=CODE auto-joins after name is set
  const m = location.hash.match(/#room=([A-Z0-9]{4})/i);
  if (m) el.codeInput.value = m[1].toUpperCase();
}

// ---------- Touch tap actions (rotate / hard drop) ----------
// A discrete tap must last exactly one tick so rotation registers once and a hard
// drop fires. We set the pending bits, sample them into the timeline this frame,
// then clear them.
let tapBits = 0;
function handleTouchTap(bit: number): void {
  if (G.phase !== "playing") return;
  tapBits |= bit;
}

// ---------- Keyboard ----------
window.addEventListener("keydown", (e) => {
  sfx.unlock();
  const tag = (document.activeElement?.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea") return; // typing in a field
  if (G.phase !== "playing") return;
  if (e.code === "KeyP" || e.code === "Escape") { togglePause(); return; }
  const bit = KEY_MAP[e.code];
  if (!bit) return;
  e.preventDefault();
  G.keysDown.add(e.code);
});
window.addEventListener("keyup", (e) => { G.keysDown.delete(e.code); });
window.addEventListener("blur", () => G.keysDown.clear());

let paused = false;
function togglePause(): void {
  if (!G.sim || G.phase !== "playing") return;
  paused = !paused;
  banner(paused ? "Paused — opponent keeps playing" : "", 900);
}

// ---------- Boot ----------
function connectAndJoin(): void {
  G.conn.connect();
  G.conn.on((msg) => onServerMsg(msg));
}

function boot(): void {
  G.scene = new Scene3D(el.canvas);
  G.touch = new TouchControls({ keysDown: G.keysDown, onTap: handleTouchTap });
  G.touch.mount();
  setupLobby();
  connectAndJoin();
  G.conn.onOpen = () => {
    // (re)join: if we had a room, re-join it; else wait for user action.
    if (G.roomCode && G.myName) G.conn.send({ t: "join", name: G.myName, code: G.roomCode });
  };
  G.conn.onClose = () => {
    if (G.phase === "playing" || G.phase === "countdown") el.connLost.classList.remove("hidden");
    else toast("Connection lost — reconnecting…");
    // auto-retry after 2s
    setTimeout(() => { if (!G.conn.open) connectAndJoin(); }, 2000);
  };

  renderHighscores(el.hsTable, []);
  showScreen("lobby");
  rafId = requestAnimationFrame(frame);
}

boot();
