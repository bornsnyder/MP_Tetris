// Deterministic match simulation. Both clients run this identically from a shared
// seed + tick-aligned input streams, so no game state ever crosses the wire —
// only inputs and verification hashes. Pure logic: no DOM, no Math.random.
import {
  COLS, ROWS, VISIBLE_ROWS, BUFFER_TICKS,
  IN_LEFT, IN_RIGHT, IN_DOWN, IN_ROT_CW, IN_ROT_CCW, IN_HARD_DROP, IN_HOLD,
  type PieceId, mulberry32, playerStreamSeed, fnv1a,
  type MatchSnapshot, type PlayerSnap,
} from "../protocol.js";
import { PIECE_CELLS, SPAWN_X, kickTable, gravityFrames, CLEAR_BASE, TSPIN_BASE } from "./pieces.js";

export const DAS_TICKS = 10; // ~170ms
export const LOCK_DELAY_TICKS = 30; // 500ms
export const NEXT_QUEUE_LEN = 5;
export const GARBAGE_VALUE = 8;

/** Deterministic PRNG with readable/writable state (needed for resync). */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let a = this.s | 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this.s = a; // advance state each call
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  get state(): number { return this.s; }
  set state(v: number) { this.s = v >>> 0; }
}

export interface ActivePiece { type: PieceId; rot: number; x: number; y: number }

export interface PlayerSim {
  grid: Uint8Array; // ROWS*COLS, value 0 empty, 1..7 pieceId+1, 8 garbage
  active: ActivePiece | null;
  nextQueue: PieceId[];
  bag: PieceId[];
  hold: PieceId | -1;
  canHold: boolean;
  score: number; lines: number; level: number;
  dead: boolean;
  combo: number;          // consecutive clearing locks minus 1 (>=0)
  prevDifficult: boolean; // last lock was a difficult clear (B2B chain)
  rng: Rng;
  // per-tick input tracking (derived from the bit stream, deterministic)
  prevBits: number;
  dasDir: -1 | 0 | 1;
  dasTimer: number;
  gravAccum: number;
  lockTimer: number;
  grounded: boolean;
  lastMoveWasRotate: boolean;
  clearedThisTick: number; // transient, not serialized
}

export interface MatchSim {
  tick: number;
  players: [PlayerSim, PlayerSim];
  over: boolean;
  winner: -1 | 0 | 1;
}

const idx = (x: number, y: number) => y * COLS + x;

function minCellY(type: PieceId): number {
  let m = Infinity;
  for (const c of PIECE_CELLS[type][0]) if (c[1] < m) m = c[1];
  return m;
}
const SPAWN_Y: Record<number, number> = {};
for (let t = 0 as PieceId; t <= 6; t = (t + 1) as PieceId) {
  SPAWN_Y[t] = VISIBLE_ROWS - minCellY(t); // lowest cell lands on first hidden row
}

function collides(p: PlayerSim, type: PieceId, rot: number, x: number, y: number): boolean {
  for (const [cx, cy] of PIECE_CELLS[type][rot]) {
    const gx = x + cx, gy = y + cy;
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
    if (p.grid[idx(gx, gy)] > 0) return true;
  }
  return false;
}

function refillQueue(p: PlayerSim): void {
  while (p.nextQueue.length < NEXT_QUEUE_LEN + 2) {
    if (p.bag.length === 0) {
      const bag: PieceId[] = [0, 1, 2, 3, 4, 5, 6];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(p.rng.next() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      p.bag = bag;
    }
    p.nextQueue.push(p.bag.pop()!);
  }
}

function placeAtSpawn(p: PlayerSim, type: PieceId): void {
  const x = SPAWN_X[type], y = SPAWN_Y[type];
  p.active = { type, rot: 0, x, y };
  if (collides(p, type, 0, x, y)) p.dead = true; // top-out on spawn
}

function spawnNext(p: PlayerSim): void {
  refillQueue(p);
  placeAtSpawn(p, p.nextQueue.shift()!);
  p.canHold = true;
  p.gravAccum = 0;
  p.lockTimer = 0;
  p.grounded = false;
}

function tryShift(p: PlayerSim, dx: number, dy: number): boolean {
  const a = p.active!;
  if (collides(p, a.type, a.rot, a.x + dx, a.y + dy)) return false;
  a.x += dx; a.y += dy;
  return true;
}

function tryRotate(p: PlayerSim, toRot: number): boolean {
  const a = p.active!;
  for (const [kx, ky] of kickTable(a.type, a.rot, toRot)) {
    if (!collides(p, a.type, toRot, a.x + kx, a.y + ky)) {
      a.rot = toRot; a.x += kx; a.y += ky;
      return true;
    }
  }
  return false;
}

function tSpinCorners(p: PlayerSim, a: ActivePiece): boolean {
  const cx = a.x + 1, cy = a.y + 1; // T center in its 3x3 box
  let filled = 0;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || x >= COLS || y < 0) filled++; // walls/floor count as filled
    else if (y < ROWS && p.grid[idx(x, y)] > 0) filled++;
  }
  return filled >= 3;
}

function removeRow(p: PlayerSim, y: number): void {
  for (let yy = y; yy < ROWS - 1; yy++) {
    for (let x = 0; x < COLS; x++) p.grid[idx(x, yy)] = p.grid[idx(x, yy + 1)];
  }
  for (let x = 0; x < COLS; x++) p.grid[idx(x, ROWS - 1)] = 0;
}

/** Insert n complete solid rows at the bottom of the field, pushing everything up. */
export function addFullRows(p: PlayerSim, n: number): void {
  if (n <= 0) return;
  for (let yy = ROWS - 1; yy >= n; yy--) {
    for (let x = 0; x < COLS; x++) p.grid[idx(x, yy)] = p.grid[idx(x, yy - n)];
  }
  for (let yy = 0; yy < n && yy < ROWS; yy++) {
    for (let x = 0; x < COLS; x++) p.grid[idx(x, yy)] = GARBAGE_VALUE;
  }
  // The active piece rides the rising floor.
  if (p.active) {
    p.active.y += n;
    let pushedOut = false;
    for (const [, cy] of PIECE_CELLS[p.active.type][p.active.rot]) {
      if (p.active.y + cy >= ROWS) pushedOut = true;
    }
    if (pushedOut) p.dead = true;
  }
}

function lockPiece(p: PlayerSim): void {
  const a = p.active!;
  let allHidden = true;
  for (const [cx, cy] of PIECE_CELLS[a.type][a.rot]) {
    const x = a.x + cx, y = a.y + cy;
    if (y >= 0 && y < ROWS) p.grid[idx(x, y)] = a.type + 1;
    if (y < VISIBLE_ROWS) allHidden = false;
  }
  p.active = null;
  if (allHidden) { p.dead = true; return; } // lock-out

  const isTspin = a.type === 2 && p.lastMoveWasRotate && tSpinCorners(p, a);

  let cleared = 0;
  for (let y = VISIBLE_ROWS - 1; y >= 0; y--) {
    let full = true;
    for (let x = 0; x < COLS; x++) if (p.grid[idx(x, y)] === 0) { full = false; break; }
    if (full) { removeRow(p, y); cleared++; }
  }

  if (cleared > 0) {
    const difficult = cleared === 4 || isTspin;
    let base = isTspin ? TSPIN_BASE[cleared] : CLEAR_BASE[cleared];
    if (difficult && p.prevDifficult) base = Math.round(base * 1.5); // back-to-back
    const comboBonus = p.combo > 0 ? 50 * p.combo * p.level : 0;
    p.score += base * p.level + comboBonus;
    p.lines += cleared;
    p.level = Math.floor(p.lines / 10) + 1;
    p.prevDifficult = difficult;
    p.combo++;
  } else {
    if (isTspin) p.score += TSPIN_BASE[0] * p.level; // T-spin, no lines
    p.prevDifficult = false;
    p.combo = 0;
  }

  p.clearedThisTick = cleared;
}

function doHold(p: PlayerSim): void {
  const cur = p.active!;
  if (p.hold === -1) {
    p.hold = cur.type;
    spawnNext(p); // pulls from queue
  } else {
    const t = p.hold;
    p.hold = cur.type;
    placeAtSpawn(p, t);
  }
  p.canHold = false;
}

function stepPlayer(p: PlayerSim, bits: number): void {
  p.clearedThisTick = 0;
  if (p.dead) { p.prevBits = bits; return; }

  const edgeCW = !!(bits & IN_ROT_CW) && !(p.prevBits & IN_ROT_CW);
  const edgeCCW = !!(bits & IN_ROT_CCW) && !(p.prevBits & IN_ROT_CCW);
  const edgeHardDrop = !!(bits & IN_HARD_DROP) && !(p.prevBits & IN_HARD_DROP);
  const edgeHold = !!(bits & IN_HOLD) && !(p.prevBits & IN_HOLD);

  if (!p.active) spawnNext(p);
  p.prevBits = bits;
  if (!p.active || p.dead) return;
  const a = p.active;

  // --- horizontal movement (DAS / ARR=0) ---
  let movedHoriz = false;
  const dir = (((bits & IN_LEFT) ? -1 : 0) + ((bits & IN_RIGHT) ? 1 : 0)) as -1 | 0 | 1;
  if (dir !== p.dasDir) { p.dasDir = dir; p.dasTimer = 0; }
  if (dir !== 0) {
    p.dasTimer++;
    if (p.dasTimer === 1 || p.dasTimer > DAS_TICKS) {
      movedHoriz = tryShift(p, dir, 0);
    }
  } else {
    p.dasTimer = 0;
  }

  // --- rotation (edge-triggered, SRS kicks) ---
  let rotated = false;
  if (edgeCW || edgeCCW) {
    const to = (a.rot + (edgeCW ? 1 : 3)) & 3;
    rotated = tryRotate(p, to);
  }

  // --- hold (edge-triggered) ---
  if (edgeHold && p.canHold && p.active) doHold(p);
  if (!p.active || p.dead) return;

  // --- hard drop (edge-triggered): lock immediately ---
  if (edgeHardDrop && p.active) {
    const b = p.active;
    let dist = 0;
    while (!collides(p, b.type, b.rot, b.x, b.y - 1)) { b.y--; dist++; }
    p.score += dist * 2;
    lockPiece(p);
    return;
  }

  if (movedHoriz) p.lastMoveWasRotate = false;
  if (rotated) p.lastMoveWasRotate = true;

  // --- gravity + lock delay ---
  const canFall = !collides(p, a.type, a.rot, a.x, a.y - 1);
  if (canFall) {
    p.grounded = false;
    p.lockTimer = 0;
    const interval = bits & IN_DOWN ? 1 : gravityFrames(p.level);
    p.gravAccum++;
    if (p.gravAccum >= interval) {
      p.gravAccum = 0;
      a.y--;
      if (bits & IN_DOWN) p.score += 1; // soft drop: +1 per cell
    }
  } else {
    p.grounded = true;
    if (movedHoriz || rotated) p.lockTimer = 0; // move/rotate reset while grounded
    else p.lockTimer++;
    if (p.lockTimer >= LOCK_DELAY_TICKS) lockPiece(p);
  }
}

/** Advance the whole match by one tick. `bits` are the effective input bits per player. */
export function stepMatch(sim: MatchSim, bits: [number, number]): void {
  if (sim.over) return;
  const p0 = sim.players[0], p1 = sim.players[1];
  stepPlayer(p0, bits[0]);
  stepPlayer(p1, bits[1]);

  // Simultaneous garbage exchange: N cleared lines -> N full rows at opponent's bottom.
  if (p0.clearedThisTick > 0 && !p1.dead) addFullRows(p1, p0.clearedThisTick);
  if (p1.clearedThisTick > 0 && !p0.dead) addFullRows(p0, p1.clearedThisTick);

  const d0 = p0.dead, d1 = p1.dead;
  if (d0 || d1) {
    sim.over = true;
    sim.winner = d0 && d1 ? -1 : d0 ? 1 : 0;
  }
}

export function createMatch(seed: number): MatchSim {
  const mkPlayer = (pi: 0 | 1): PlayerSim => {
    const p: PlayerSim = {
      grid: new Uint8Array(ROWS * COLS), active: null, nextQueue: [], bag: [],
      hold: -1, canHold: true, score: 0, lines: 0, level: 1, dead: false,
      combo: 0, prevDifficult: false, rng: new Rng(playerStreamSeed(seed, pi)),
      prevBits: 0, dasDir: 0, dasTimer: 0, gravAccum: 0, lockTimer: 0,
      grounded: false, lastMoveWasRotate: false, clearedThisTick: 0,
    };
    spawnNext(p);
    return p;
  };
  return { tick: 0, players: [mkPlayer(0), mkPlayer(1)], over: false, winner: -1 };
}

// ---------- Snapshot / hash (lockstep verification + resync) ----------

export function snapshot(sim: MatchSim): MatchSnapshot {
  const snapPlayer = (p: PlayerSim): PlayerSnap => {
    let cells = "";
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = p.grid[idx(x, y)];
        if (v > 0) cells += `${x},${y},${v};`;
      }
    }
    return {
      cells,
      active: p.active ? [p.active.type, p.active.rot, p.active.x, p.active.y] : null,
      next: [...p.nextQueue], hold: p.hold, canHold: p.canHold,
      score: p.score, lines: p.lines, level: p.level, dead: p.dead,
      combo: p.combo, prevDifficult: p.prevDifficult,
      rngState: p.rng.state, bag: [...p.bag],
      prevBits: p.prevBits, dasDir: p.dasDir, dasTimer: p.dasTimer,
      gravAccum: p.gravAccum, lockTimer: p.lockTimer, grounded: p.grounded,
      lastMoveWasRotate: p.lastMoveWasRotate,
    };
  };
  return { tick: sim.tick, players: [snapPlayer(sim.players[0]), snapPlayer(sim.players[1])] };
}

export function hashState(sim: MatchSim): number {
  return fnv1a(JSON.stringify(snapshot(sim)));
}

/** Restore a full match from a snapshot (used by the adopt/resync protocol). */
export function restoreMatch(snap: MatchSnapshot, seed: number): MatchSim {
  const restorePlayer = (s: PlayerSnap, pi: 0 | 1): PlayerSim => {
    const p: PlayerSim = {
      grid: new Uint8Array(ROWS * COLS), active: null, nextQueue: [], bag: [],
      hold: -1, canHold: true, score: 0, lines: 0, level: 1, dead: false,
      combo: 0, prevDifficult: false, rng: new Rng(playerStreamSeed(seed, pi)),
      prevBits: 0, dasDir: 0, dasTimer: 0, gravAccum: 0, lockTimer: 0,
      grounded: false, lastMoveWasRotate: false, clearedThisTick: 0,
    };
    for (const part of s.cells.split(";")) {
      if (!part) continue;
      const [x, y, v] = part.split(",").map(Number);
      p.grid[idx(x, y)] = v;
    }
    if (s.active) p.active = { type: s.active[0] as PieceId, rot: s.active[1], x: s.active[2], y: s.active[3] };
    p.nextQueue = [...s.next] as PieceId[];
    p.hold = s.hold < 0 ? -1 : (s.hold as PieceId);
    p.canHold = s.canHold;
    p.score = s.score; p.lines = s.lines; p.level = s.level; p.dead = s.dead;
    p.combo = s.combo; p.prevDifficult = s.prevDifficult;
    p.rng.state = s.rngState;
    p.bag = [...s.bag] as PieceId[];
    p.prevBits = s.prevBits; p.dasDir = s.dasDir as -1 | 0 | 1; p.dasTimer = s.dasTimer;
    p.gravAccum = s.gravAccum; p.lockTimer = s.lockTimer; p.grounded = s.grounded;
    p.lastMoveWasRotate = s.lastMoveWasRotate;
    return p;
  };
  const sim: MatchSim = { tick: snap.tick, players: [restorePlayer(snap.players[0], 0), restorePlayer(snap.players[1], 1)], over: false, winner: -1 };
  if (sim.players[0].dead || sim.players[1].dead) {
    const d0 = sim.players[0].dead, d1 = sim.players[1].dead;
    sim.over = true;
    sim.winner = d0 && d1 ? -1 : d0 ? 1 : 0;
  }
  return sim;
}

export { BUFFER_TICKS };
