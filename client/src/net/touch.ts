// On-screen touch controls for mobile playability. Injects input bits into the same
// keysDown set the keyboard path uses, so DAS/ARR and hard-drop behave identically.
import { IN_LEFT, IN_RIGHT, IN_DOWN, IN_ROT_CW, IN_ROT_CCW, IN_HARD_DROP } from "../../../shared/protocol";

export interface TouchControlsOptions {
  /** Set of key-codes that sampleBits() reads; we add/remove pseudo-codes here. */
  keysDown: Set<string>;
  /** Called on a discrete tap (rotate / hard drop). */
  onTap?: (bit: number) => void;
}

const P = { left: "T_LEFT", right: "T_RIGHT", down: "T_DOWN" }; // held pseudo-codes

export class TouchControls {
  private root: HTMLDivElement | null = null;
  private opts: TouchControlsOptions;
  private enabled = false;

  constructor(opts: TouchControlsOptions) {
    this.opts = opts;
  }

  /** Build the overlay (idempotent). Call once. */
  mount(): void {
    if (this.root || typeof document === "undefined") return;
    const root = document.createElement("div");
    root.id = "touch-controls";
    root.innerHTML = `
      <div class="tc-left">
        <button data-act="left" aria-label="Move left">&#9664;</button>
        <button data-act="right" aria-label="Move right">&#9654;</button>
      </div>
      <div class="tc-right">
        <button data-act="down" aria-label="Soft drop">&#9660;</button>
        <button data-act="ccw" aria-label="Rotate counter-clockwise">&#8634;</button>
        <button data-act="cw" aria-label="Rotate clockwise">&#8635;</button>
        <button data-act="drop" class="tc-drop" aria-label="Hard drop">DROP</button>
      </div>`;
    document.body.appendChild(root);
    this.root = root;

    const holdActs: Record<string, string> = { left: P.left, right: P.right, down: P.down };
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
      const act = btn.dataset.act!;
      // pointer events give us press/release + multi-touch without mouse emulation quirks
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { (btn as any).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
        if (act in holdActs) this.opts.keysDown.add(holdActs[act]);
        else this.opts.onTap?.(this.tapBit(act));
      });
      const release = () => {
        for (const code of Object.values(P)) this.opts.keysDown.delete(code);
      };
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("lostpointercapture", release);
    }

    // Only show on coarse pointers / small screens.
    const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
    const narrow = window.innerWidth < 900;
    this.enabled = isTouch && narrow;
    root.classList.toggle("hidden", !this.enabled);

    window.addEventListener("resize", () => {
      const on = (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window) && window.innerWidth < 900;
      this.enabled = on;
      root.classList.toggle("hidden", !on);
    });
  }

  private tapBit(act: string): number {
    switch (act) {
      case "cw": return IN_ROT_CW;
      case "ccw": return IN_ROT_CCW;
      case "drop": return IN_HARD_DROP;
      default: return 0;
    }
  }

  /** Clear any held touch inputs (e.g. on pause / screen change). */
  clear(): void {
    for (const code of Object.values(P)) this.opts.keysDown.delete(code);
  }

  get active(): boolean { return this.enabled; }
}