// Highscore board: server-side global record of finished rounds.
// Top 5 by winner's score are always served; up to MAX_STORED kept on disk.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { RoundRecord } from "../../shared/protocol.js";

const MAX_STORED = 500;
export const DISPLAY_COUNT = 5;

export class ScoreStore {
  private rounds: RoundRecord[] = [];
  private path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.rounds = parsed as RoundRecord[];
    } catch { /* first run or corrupt file -> start empty */ }
  }

  /** Record a finished round. Returns the updated top-N list. */
  addRound(r: RoundRecord): RoundRecord[] {
    this.rounds.push(r);
    if (this.rounds.length > MAX_STORED) this.rounds = this.rounds.slice(-MAX_STORED);
    const sorted = [...this.rounds].sort((a, b) => maxScore(b) - maxScore(a));
    this.persist(sorted);
    return sorted.slice(0, DISPLAY_COUNT);
  }

  top(): RoundRecord[] {
    return [...this.rounds].sort((a, b) => maxScore(b) - maxScore(a)).slice(0, DISPLAY_COUNT);
  }

  private persist(list: RoundRecord[]): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, this.path); // atomic on POSIX
  }
}

export function maxScore(r: RoundRecord): number {
  return Math.max(r.p0.score, r.p1.score);
}
