// Shared protocol + deterministic game constants for MP_Tetris.
// Both client and server import from here so the contract never drifts.

export const TICKS_PER_SEC = 60;
export const TICK_MS = 1000 / TICKS_PER_SEC; // ~16.67ms

/** Fixed input delay buffer (fighting-game style). All inputs, local and remote,
 *  take effect BUFFER_TICKS after they are pressed/seen. */
export const BUFFER_TICKS = 9; // 150ms at 60Hz

// Board geometry
export const COLS = 10;
export const VISIBLE_ROWS = 20;
export const HIDDEN_ROWS = 4; // spawn zone above the visible field
export const ROWS = VISIBLE_ROWS + HIDDEN_ROWS; // total grid height (y=0 bottom)

// Input bitmask (per tick, per player)
export const IN_LEFT = 1 << 0;
export const IN_RIGHT = 1 << 1;
export const IN_DOWN = 1 << 2;
export const IN_ROT_CW = 1 << 3;
export const IN_ROT_CCW = 1 << 4;
export const IN_HARD_DROP = 1 << 5;
export const IN_HOLD = 1 << 6;

// Piece ids: 0=I,1=O,2=T,3=S,4=Z,5=J,6=L
export type PieceId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Deterministic PRNG (mulberry32). Both clients derive identical streams. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-player stream seed derived from the shared match seed. */
export function playerStreamSeed(seed: number, player: 0 | 1): number {
  return (seed ^ Math.imul(player + 1, 0x9e3779b9)) >>> 0;
}

/** FNV-1a 32-bit hash over a string. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- Messages: client -> server ----------
export interface MsgJoin { t: "join"; name: string; code?: string }
export interface MsgReady { t: "ready"; v: boolean }
/** Input state change, stamped with the sim tick it was pressed at. */
export interface MsgInput { t: "in"; s: number; b: number }
/** Periodic lockstep verification hash of the full match state. */
export interface MsgHash { t: "hash"; tick: number; h: number }
/** Full state, sent when a desync is detected (or on request). */
export interface MsgResync { t: "resync"; state: string } // JSON-encoded MatchSnapshot
export interface MsgResult {
  t: "result"; matchId: number; winner: -1 | 0 | 1;
  scores: [number, number]; lines: [number, number]; durTicks: number;
}
export interface MsgLeaveRoom { t: "leave" }

export type ClientMsg =
  | MsgJoin | MsgReady | MsgInput | MsgHash | MsgResync | MsgResult | MsgLeaveRoom;

// ---------- Messages: server -> client ----------
export interface PlayerInfo { name: string; ready: boolean }
export interface MsgJoined { t: "joined"; code: string; youAre: 0 | 1; players: [PlayerInfo?, PlayerInfo?]; state: RoomStateName }
export interface MsgLobby { t: "lobby"; players: [PlayerInfo?, PlayerInfo?]; state: RoomStateName }
export type RoomStateName = "lobby" | "postmatch";
export interface MsgStart { t: "start"; matchId: number; seed: number; startAt: number; youAre: 0 | 1 }
export interface MsgInRelay { t: "in"; s: number; b: number }
export interface MsgHashRelay { t: "hash"; tick: number; h: number }
export interface MsgResyncReq { t: "resyncReq" }
export interface MsgAdopt { t: "adopt"; state: string; newStartAt: number }
export interface RoundRecord {
  p0: { name: string; score: number };
  p1: { name: string; score: number };
  durSec: number;
  at: number; // unix ms when the round finished
}
export interface MsgScores { t: "scores"; rounds: RoundRecord[] }
export interface MsgMatchEnd {
  t: "matchEnd"; matchId: number; winner: -1 | 0 | 1;
  scores: [number, number]; lines: [number, number]; durSec: number;
}
export interface MsgPeerLeft { t: "peerLeft" }
export interface MsgError { t: "error"; msg: string }

export type ServerMsg =
  | MsgJoined | MsgLobby | MsgStart | MsgInRelay | MsgHashRelay | MsgResyncReq
  | MsgAdopt | MsgScores | MsgMatchEnd | MsgPeerLeft | MsgError;

/** Full deterministic match state (for resync + hashing). JSON-serializable. */
export interface PlayerSnap {
  /** grid cells as "x,y,v" pairs (v: 1..7 = pieceId+1, 8 = garbage) */
  cells: string;
  active: [number, number, number, number] | null; // type, rot, x, y
  next: number[];
  hold: number; // -1 if empty
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  dead: boolean;
  combo: number;
  prevDifficult: boolean;
  rngState: number;
  bag: number[];
  prevBits: number;
  dasDir: number;
  dasTimer: number;
  gravAccum: number;
  lockTimer: number;
  grounded: boolean;
  lastMoveWasRotate: boolean;
}
export interface MatchSnapshot {
  tick: number;
  players: [PlayerSnap, PlayerSnap];
}

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I,L,O,0,1
export function makeRoomCode(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length)];
  return s;
}

export const MAX_NAME_LEN = 16;
export function sanitizeName(raw: string): string {
  const n = raw.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, MAX_NAME_LEN);
  return n.length > 0 ? n : "Player";
}
