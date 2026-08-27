// Synthesized WebAudio sound effects — no asset files.
class Sfx {
  private ctx: AudioContext | null = null;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      try { this.ctx = new AudioContext(); } catch { return null; }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Call on first user gesture to unlock audio. */
  unlock(): void { this.ensure(); }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number } = {}): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.slideTo), t0 + dur);
    g.gain.setValueAtTime(opts.gain ?? 0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, gain = 0.15): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  }

  lock(): void { this.tone(140, 0.08, { type: "triangle", gain: 0.1 }); }
  hardDrop(): void { this.noise(0.09, 0.2); this.tone(90, 0.07, { type: "square", gain: 0.05 }); }
  rotate(): void { this.tone(340, 0.04, { type: "triangle", gain: 0.05 }); }
  hold(): void { this.tone(520, 0.06, { type: "sine", gain: 0.07 }); }

  clear(lines: number): void {
    const base = [0, 440, 554, 659, 880][Math.min(4, lines)];
    for (let i = 0; i < Math.min(4, lines); i++) this.tone(base * (1 + i * 0.26), 0.12, { type: "square", gain: 0.07, delay: i * 0.05 });
    if (lines >= 4) this.tone(1320, 0.3, { type: "sawtooth", gain: 0.06, delay: 0.2 });
  }

  garbage(): void { this.tone(70, 0.25, { type: "sine", slideTo: 45, gain: 0.16 }); this.noise(0.18, 0.1); }
  topOut(): void {
    this.tone(392, 0.25, { type: "sawtooth", gain: 0.09 });
    this.tone(311, 0.3, { type: "sawtooth", gain: 0.09, delay: 0.22 });
    this.tone(233, 0.6, { type: "sawtooth", gain: 0.1, delay: 0.45 });
  }
  countBeep(final = false): void { this.tone(final ? 880 : 440, final ? 0.25 : 0.1, { type: "square", gain: 0.07 }); }
  win(): void { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, { type: "triangle", gain: 0.08, delay: i * 0.09 })); }
}

export const sfx = new Sfx();
