// Headless verification harness: spins up the real server, connects two scripted
// clients over WebSocket, plays full matches, and checks lockstep integrity,
// garbage exchange, top-out termination, and highscore recording.
import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { createMatch, stepMatch, hashState, snapshot } from "../shared/game/engine.js";
import type { MatchSim } from "../shared/game/engine.js";
import { InputTimeline } from "../shared/game/inputs.js";
import { TICK_MS, IN_LEFT, IN_RIGHT, IN_DOWN, IN_ROT_CW, IN_HARD_DROP, COLS, VISIBLE_ROWS, type ServerMsg, type RoundRecord } from "../shared/protocol.js";

const PORT = 6100; // avoid clashing with a real deployment
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ FAIL: ${label}`); }
}

// Use node:http instead of global fetch for health checks: on Windows, Node's
// undici-based fetch leaves pooled handles open at process.exit(), which trips a
// libuv assertion that masks the harness exit code.
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
  });
}

// ---------- scripted bot ----------
class Bot {
  ws!: WebSocket;
  name: string;
  youAre = 0 as 0 | 1;
  sim: MatchSim | null = null;
  timelines: [InputTimeline, InputTimeline] = [new InputTimeline(), new InputTimeline()];
  lastSent = 0;
  startAt = 0;
  matchId = 0;
  seed = 0;
  hashWindow = new Map<number, number>();
  desyncs = 0;
  result: { winner: -1 | 0 | 1; scores: [number, number]; durTicks: number } | null = null;
  private msgs: ServerMsg[] = [];

  joinedCode = "";
  private handlers: ((m: ServerMsg) => void)[] = [];

  constructor(name: string) { this.name = name; }

  onMessage(fn: (m: ServerMsg) => void): void { this.handlers.push(fn); }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (d) => {
        const msg = JSON.parse(String(d)) as ServerMsg;
        if (msg.t === "joined") this.joinedCode = msg.code;
        if (msg.t === "start") {
          this.matchId = msg.matchId; this.seed = msg.seed; this.startAt = msg.startAt;
          this.youAre = msg.youAre;
          this.sim = createMatch(msg.seed);
          this.timelines[0].reset(); this.timelines[1].reset();
          this.lastSent = 0; this.hashWindow.clear();
        } else if (msg.t === "in" && this.sim) {
          const them = (1 - this.youAre) as 0 | 1;
          this.timelines[them].setChange(msg.s, msg.b);
        } else if (msg.t === "hash" && this.sim) {
          const mine = this.hashWindow.get(msg.tick);
          if (mine !== undefined && mine !== msg.h) this.desyncs++;
        }
        for (const h of this.handlers) h(msg);
      });
    });
  }

  sendJoin(code?: string): void {
    this.ws.send(JSON.stringify({ t: "join", name: this.name, code }));
  }
  sendReady(): void { this.ws.send(JSON.stringify({ t: "ready", v: true })); }

  /** Advance simulation to wall-clock now (like the browser client does). */
  tick(): void {
    if (!this.sim || Date.now() < this.startAt) return;
    const now = Date.now();

    // Sample scripted input ONCE per frame, exactly like main.ts samples keys:
    // record + relay immediately, stamped at max(sim.tick, wallTick) so the change
    // takes effect BUFFER_TICKS after "now" on both clients.
    const me = this.youAre;
    let bits = 0;
    const a = this.sim.players[me].active;
    if (a && !this.sim.over) {
      const t = this.sim.tick + 1;
      const targetX = COLS / 2 - 1 + Math.floor(Math.sin(t / 40) * 3);
      if (a.x < targetX) bits |= IN_LEFT;
      else if (a.x > targetX) bits |= IN_RIGHT;
      if (t % 97 === 0) bits |= IN_ROT_CW;
      // hard drop every ~2.5s to force line pressure eventually
      const grounded = this.sim.players[me].grounded;
      if (grounded || t % 150 < 3) bits |= IN_HARD_DROP;
    }
    if (bits !== this.lastSent) {
      const wallTick = Math.floor((now - this.startAt) / TICK_MS);
      const stamp = Math.max(this.sim.tick, wallTick);
      this.timelines[me].setChange(stamp, bits);
      this.ws.send(JSON.stringify({ t: "in", s: stamp, b: bits }));
      this.lastSent = bits;
    }

    const target = Math.floor((now - this.startAt) / TICK_MS);
    while (this.sim.tick < target && !this.sim.over) {
      const t = this.sim.tick + 1;
      const b0 = this.timelines[0].effectiveAt(t);
      const b1 = this.timelines[1].effectiveAt(t);
      stepMatch(this.sim, [b0, b1]);
      this.sim.tick = t;

      if (t % 30 === 0) {
        const h = hashState(this.sim);
        this.hashWindow.set(t, h);
        this.ws.send(JSON.stringify({ t: "hash", tick: t, h }));
      }

      if (this.sim.over) {
        this.result = { winner: this.sim.winner, scores: [this.sim.players[0].score, this.sim.players[1].score], durTicks: t };
        this.ws.send(JSON.stringify({
          t: "result", matchId: this.matchId, winner: this.sim.winner,
          scores: [this.sim.players[0].score, this.sim.players[1].score],
          lines: [this.sim.players[0].lines, this.sim.players[1].lines], durTicks: t,
        }));
        break;
      }
    }
  }

  get scores(): [number, number] { return this.sim ? [this.sim.players[0].score, this.sim.players[1].score] : [0, 0]; }
}

// ---------- run ----------
async function main() {
  console.log("Starting server on :" + PORT);
  const srv = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: "/tmp/mp-tetris-test-data" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout?.on("data", (d) => { srvOut += String(d); });
  srv.stderr?.on("data", (d) => { srvOut += String(d); });

  // wait for readiness
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(200);
    try {
      up = (await httpGet(`${BASE}/healthz`)) === 200;
    } catch { /* not yet */ }
  }
  if (!up) { console.error("Server failed to start:\n" + srvOut); process.exit(1); }
  console.log("Server is up.\n");

  try {
    // --- Test 1: lobby flow ---
    console.log("[Test 1] Lobby join + ready-up");
    const a = new Bot("Alice"), b = new Bot("Bob");
    await a.connect();
    a.sendJoin();
    await sleep(250);
    check(a.joinedCode.length === 4, `room created with 4-char code (${a.joinedCode})`);

    await b.connect();
    b.sendJoin(a.joinedCode);
    await sleep(250);
    a.sendReady(); b.sendReady();
    await sleep(300);
    // both should have received 'start'
    check(a.sim !== null && b.sim !== null, "both clients received match start");

    // --- Test 2: play until top-out (with aggressive hard drops) ---
    console.log("[Test 2] Full match to completion");
    const t0 = Date.now();
    while (!a.result && !b.result && Date.now() - t0 < 180_000) {
      a.tick(); b.tick();
      await sleep(33); // ~30Hz drive
    }
    check(a.result !== null, "match A ended (top-out detected)");
    check(b.result !== null, "match B ended (top-out detected)");
    if (a.result && b.result) {
      check(a.result.winner === b.result.winner, `both sides agree on winner (${a.result.winner})`);
      check(JSON.stringify(a.result.scores) === JSON.stringify(b.result.scores), "both sides agree on final scores");
      const durSec = a.result.durTicks / 60;
      console.log(`    match lasted ${durSec.toFixed(1)}s, winner=${a.result.winner}, scores=[${a.result.scores}]`);
    }

    // --- Test 3: lockstep integrity (no desyncs) ---
    console.log("[Test 3] Lockstep integrity");
    check(a.desyncs === 0 && b.desyncs === 0, `zero hash mismatches (a=${a.desyncs}, b=${b.desyncs})`);

    // --- Test 4: highscore recorded server-side ---
    console.log("[Test 4] Highscore board");
    await sleep(300);
    check((await httpGet(`${BASE}/healthz`)) === 200, "server still healthy after match");

    // verify scores.json on disk (DATA_DIR is /tmp/mp-tetris-test-data)
    const { readFileSync } = await import("node:fs");
    let rounds: RoundRecord[] = [];
    try { rounds = JSON.parse(readFileSync("/tmp/mp-tetris-test-data/scores.json", "utf8")); } catch { /* none */ }
    check(rounds.length >= 1, `round recorded on server (${rounds.length} stored)`);
    if (rounds.length > 0) {
      const last = rounds[rounds.length - 1];
      check(last.p0.name === "Alice" && last.p1.name === "Bob", "names recorded correctly");
      check(Math.max(last.p0.score, last.p1.score) > 0, "winner's score is positive");
    }

    // --- Test 5: determinism — same seed + inputs => identical state ---
    console.log("[Test 5] Determinism (same seed, same input stream)");
    const s1 = createMatch(12345), s2 = createMatch(12345);
    for (let t = 0; t < 600; t++) {
      const bits: [number, number] = [t % 7 === 0 ? IN_LEFT | IN_ROT_CW : 0, t % 11 === 0 ? IN_RIGHT | IN_DOWN : 0];
      stepMatch(s1, bits); s1.tick++;
      stepMatch(s2, bits); s2.tick++;
    }
    check(hashState(s1) === hashState(s2), "identical seeds + inputs produce identical states");

    // --- Test 6: garbage exchange sanity (clearing adds full rows to opponent) ---
    console.log("[Test 6] Garbage mechanics");
    const g = createMatch(99);
    const p0 = g.players[0];
    // manually fill bottom row of p0 except where the active piece will land, then clear via lock
    for (let x = 0; x < COLS; x++) p0.grid[x] = 1; // full bottom row (value 1)
    const before = g.players[1].grid.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    // force a lock that clears: place active piece so it completes the row... simpler: call stepMatch with hard drop
    p0.active!.x = 3; p0.active!.y = 20;
    const bits: [number, number] = [IN_HARD_DROP, 0];
    // need edge trigger: prevBits must not have IN_HARD_DROP
    p0.prevBits = 0;
    stepMatch(g, bits);
    const after = g.players[1].grid.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    check(after > before, `garbage rows added to opponent (${before} -> ${after} filled cells)`);
    // verify the new bottom row is fully solid garbage
    let fullBottom = true;
    for (let x = 0; x < COLS; x++) if (g.players[1].grid[x] === 0) fullBottom = false;
    check(fullBottom, "opponent's bottom row is a complete solid garbage row");

    console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));

    // Clean shutdown: close the client sockets and wait for the server child to
    // exit so no handles are left open. Exiting with dangling handles trips a libuv
    // assertion on Windows that masks the real exit code.
    a.ws.close(); b.ws.close();
    srv.kill("SIGTERM");
    await new Promise<void>((resolve) => { srv.once("exit", () => resolve()); });
  } finally {
    if (!srv.killed) srv.kill("SIGTERM"); // safety net on early failure
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
