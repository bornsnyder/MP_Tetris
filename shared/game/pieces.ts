// Tetromino geometry + SRS rotation/kick data. Pure, deterministic, no DOM.
import type { PieceId } from "../protocol.js";

/** Cells of each piece in each rotation state (0=spawn,1=CW,2=180,3=CCW).
 *  Coordinates are within the piece's bounding box; +y is up. */
export const PIECE_CELLS: Record<number, number[][][]> = {
  // I: 4x4 box
  0: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  // O: 2x2 box (rotation-invariant)
  1: [
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
  ],
  // T: 3x3 box
  2: [
    [[1, 1], [0, 0], [1, 0], [2, 0]],
    [[1, 1], [1, 0], [1, 2], [2, 1]],
    [[1, 1], [0, 1], [1, 2], [2, 1]],
    [[1, 1], [0, 1], [1, 0], [1, 2]],
  ],
  // S: 3x3 box
  3: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 1], [1, 2], [2, 1], [2, 0]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 1], [0, 0], [1, 1], [1, 2]],
  ],
  // Z: 3x3 box
  4: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 1], [2, 2], [1, 1], [1, 0]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 1], [1, 0], [0, 1], [0, 2]],
  ],
  // J: 3x3 box
  5: [
    [[0, 1], [0, 0], [1, 0], [2, 0]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 0], [1, 0], [2, 0], [2, 1]],
    [[1, 2], [0, 2], [1, 1], [1, 0]],
  ],
  // L: 3x3 box
  6: [
    [[2, 1], [0, 0], [1, 0], [2, 0]],
    [[1, 0], [1, 1], [1, 2], [0, 2]],
    [[0, 0], [1, 0], [2, 0], [0, 1]],
    [[1, 2], [1, 1], [1, 0], [0, 0]],
  ],
};

/** Bounding box size per piece type. */
export const PIECE_BOX: Record<number, number> = { 0: 4, 1: 2, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3 };

/** Spawn x (box origin column) so pieces appear centered. */
export const SPAWN_X: Record<number, number> = { 0: 3, 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3 };

/** SRS wall-kick offsets. Key "from>to", values [dx, dy] with +y up. */
const KICKS_JLSTZ: Record<string, number[][]> = {
  "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I: Record<string, number[][]> = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

export function kickTable(type: PieceId, from: number, to: number): number[][] {
  const key = `${from}>${to}`;
  if (type === 0) return KICKS_I[key];
  if (type === 1) return [[0, 0]]; // O never kicks
  return KICKS_JLSTZ[key];
}

/** Guideline-ish gravity: frames per row at 60Hz. */
const GRAVITY_TABLE = [48, 43, 38, 33, 28, 23, 18, 13, 8, 6]; // levels 1..10
export function gravityFrames(level: number): number {
  if (level <= 10) return GRAVITY_TABLE[level - 1];
  const l = level - 10;
  return Math.max(1, Math.round(6 * Math.pow(0.78, l)));
}

/** Guideline base scores per lines cleared (index = lines). */
export const CLEAR_BASE = [0, 100, 300, 500, 800];
/** T-spin base scores per lines cleared (index = lines; 0 lines = 400). */
export const TSPIN_BASE = [400, 800, 1200, 1600, 1600];
