// Input timeline: reconstructs the per-tick input bit stream from change events.
// Both clients apply a change stamped at tick s starting at tick s + BUFFER_TICKS,
// which is what keeps local and remote inputs symmetric (fixed delay netcode).
import { BUFFER_TICKS } from "../protocol.js";

interface Change { tick: number; bits: number }

export class InputTimeline {
  private changes: Change[] = [];

  /** Record that the input state became `bits` at sim tick `tick`. */
  setChange(tick: number, bits: number): void {
    const last = this.changes[this.changes.length - 1];
    if (last && last.bits === bits) return; // no-op change
    this.changes.push({ tick, bits });
    if (this.changes.length > 2000) this.changes.splice(0, 1000);
  }

  /** Bits in effect when entering sim tick `t`. */
  effectiveAt(t: number): number {
    let b = 0;
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i];
      if (c.tick + BUFFER_TICKS <= t) { b = c.bits; break; }
      if (c.tick < t - BUFFER_TICKS - 300) break; // too old to matter, stop scanning
    }
    return b;
  }

  reset(): void { this.changes = []; }
}
