// Room management: lobby, ready-up, match start, relay of lockstep traffic.
import type { WebSocket } from "ws";
import {
  makeRoomCode, sanitizeName, TICKS_PER_SEC,
  type ClientMsg, type ServerMsg, type PlayerInfo, type RoundRecord,
} from "../../shared/protocol.js";

const COUNTDOWN_MS = 5000; // countdown before the first tick
const ROOM_TTL_MS = 10 * 60 * 1000;
const RESEED_AFTER_MS = 800; // adopt with whatever state we have after this

interface RoomPlayer { name: string; ws: WebSocket; ready: boolean }
export interface Room {
  code: string;
  players: [RoomPlayer?, RoomPlayer?];
  state: "lobby" | "match" | "postmatch";
  matchId?: number;
  seed?: number;
  startAt?: number;
  lastActivity: number;
  // resync bookkeeping (per active match)
  pendingStates: [string?, string?];
  reseedTimer?: NodeJS.Timeout;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private nextMatchId = 1;
  private recorder: ((round: RoundRecord) => void) | null = null;

  constructor(private rng: () => number = Math.random) {
    const t = setInterval(() => this.sweep(), 30_000);
    if (typeof t.unref === "function") t.unref();
  }

  setRecorder(fn: (round: RoundRecord) => void): void { this.recorder = fn; }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private info(r: Room): [PlayerInfo?, PlayerInfo?] {
    return [
      r.players[0] ? { name: r.players[0].name, ready: r.players[0].ready } : undefined,
      r.players[1] ? { name: r.players[1].name, ready: r.players[1].ready } : undefined,
    ];
  }

  private broadcastLobby(r: Room): void {
    const msg: ServerMsg = { t: "lobby", players: this.info(r), state: r.state === "match" ? "lobby" : r.state };
    for (const p of r.players) if (p) this.send(p.ws, msg);
  }

  join(ws: WebSocket, nameRaw: string, code?: string): void {
    const name = sanitizeName(nameRaw);
    let room: Room | undefined;
    if (code) {
      room = this.rooms.get(code.toUpperCase());
      if (!room || (room.players[0] && room.players[1])) {
        this.send(ws, { t: "error", msg: "Room not found or full." });
        return;
      }
    } else {
      room = this.createRoom();
    }
    const slot: 0 | 1 = !room.players[0] ? 0 : 1;
    if (room.players[slot]) {
      this.send(ws, { t: "error", msg: "Room is full." });
      return;
    }
    room.players[slot] = { name, ws, ready: false };
    room.lastActivity = Date.now();

    const joined: ServerMsg = {
      t: "joined", code: room.code, youAre: slot, players: this.info(room), state: room.state === "match" ? "lobby" : room.state,
    };
    this.send(ws, joined);
    this.broadcastLobby(room);
  }

  private createRoom(): Room {
    let code = makeRoomCode(this.rng);
    while (this.rooms.has(code)) code = makeRoomCode(this.rng);
    const room: Room = { code, players: [undefined, undefined], state: "lobby", lastActivity: Date.now(), pendingStates: [undefined, undefined] };
    this.rooms.set(code, room);
    return room;
  }

  private findPlayer(ws: WebSocket): { room: Room; slot: 0 | 1 } | undefined {
    for (const room of this.rooms.values()) {
      if (room.players[0]?.ws === ws) return { room, slot: 0 };
      if (room.players[1]?.ws === ws) return { room, slot: 1 };
    }
    return undefined;
  }

  handle(ws: WebSocket, msg: ClientMsg): void {
    switch (msg.t) {
      case "join": this.join(ws, msg.name, msg.code); return;
      default: break;
    }
    const found = this.findPlayer(ws);
    if (!found) return;
    const { room, slot } = found;
    room.lastActivity = Date.now();

    switch (msg.t) {
      case "ready": {
        if (room.state === "match") return;
        room.players[slot]!.ready = !!msg.v;
        if (room.players[0]?.ready && room.players[1]?.ready) {
          this.startMatch(room);
        } else {
          this.broadcastLobby(room);
        }
        break;
      }

      case "in":
      case "hash": {
        if (room.state !== "match") return;
        const other = slot === 0 ? room.players[1] : room.players[0];
        if (!other) return;
        this.send(other.ws, msg as ServerMsg); // relay verbatim
        break;
      }

      case "resync": {
        if (room.state !== "match") return;
        room.pendingStates[slot] = msg.state;
        const other = slot === 0 ? room.players[1] : room.players[0];
        if (other) this.send(other.ws, { t: "resyncReq" });
        if (!room.reseedTimer) {
          room.reseedTimer = setTimeout(() => this.doReseed(room), RESEED_AFTER_MS);
        }
        if (room.pendingStates[0] && room.pendingStates[1]) this.doReseed(room);
        break;
      }

      case "result": {
        if (room.state !== "match" || msg.matchId !== room.matchId) return;
        // First result wins; record the round globally.
        const p0 = room.players[0]!, p1 = room.players[1]!;
        const durSec = Math.round((msg.durTicks / TICKS_PER_SEC) * 10) / 10;
        this.recorder?.({
          p0: { name: p0.name, score: msg.scores[0] },
          p1: { name: p1.name, score: msg.scores[1] },
          durSec,
          at: Date.now(),
        });
        const end: ServerMsg = { t: "matchEnd", matchId: msg.matchId, winner: msg.winner, scores: msg.scores, lines: msg.lines, durSec };
        for (const pl of room.players) if (pl) this.send(pl.ws, end);
        room.state = "postmatch";
        room.players[0]!.ready = false;
        room.players[1]!.ready = false;
        break;
      }

      case "leave": {
        this.removePlayer(ws, false);
        break;
      }
    }
  }

  private startMatch(room: Room): void {
    room.state = "match";
    room.matchId = this.nextMatchId++;
    room.seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    room.startAt = Date.now() + COUNTDOWN_MS;
    room.pendingStates = [undefined, undefined];
    for (const slot of [0, 1] as const) {
      const p = room.players[slot];
      if (!p) continue;
      this.send(p.ws, { t: "start", matchId: room.matchId!, seed: room.seed!, startAt: room.startAt!, youAre: slot });
    }
  }

  private doReseed(room: Room): void {
    if (room.state !== "match" || !room.reseedTimer) return;
    clearTimeout(room.reseedTimer);
    room.reseedTimer = undefined;
    // Prefer player 0's state, else whichever we have.
    const state = room.pendingStates[0] ?? room.pendingStates[1];
    if (!state) return;
    const newStartAt = Date.now() + 1200;
    for (const p of room.players) {
      if (p) this.send(p.ws, { t: "adopt", state, newStartAt });
    }
    room.pendingStates = [undefined, undefined];
  }

  removePlayer(ws: WebSocket, notifyPeerLeft: boolean): void {
    const found = this.findPlayer(ws);
    if (!found) return;
    const { room, slot } = found;
    room.players[slot] = undefined;
    const other = slot === 0 ? room.players[1] : room.players[0];
    if (other) {
      if (notifyPeerLeft && room.state === "match") this.send(other.ws, { t: "peerLeft" });
      else this.broadcastLobby(room);
    }
    if (!room.players[0] && !room.players[1]) this.rooms.delete(room.code);
  }

  sweep(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > ROOM_TTL_MS) {
        for (const p of room.players) if (p) this.send(p.ws, { t: "error", msg: "Room expired." });
        this.rooms.delete(code);
      }
    }
  }


}
