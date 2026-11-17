/**
 * @fileoverview Procedural Web Audio effects for world events.
 */

/** Synthesised sound effects; silent until the first user gesture. */
class Sfx {
  private ctx: AudioContext | null = null;
  private muted = false;
  private noise: AudioBuffer | null = null;

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Short rising chirp. */
  launch(): void {
    this.tone('triangle', 220, 660, 0.12, 0.07);
  }

  /** Soft two-note chime. */
  merge(): void {
    this.tone('sine', 523, 523, 0.18, 0.04);
    this.tone('sine', 784, 784, 0.22, 0.03, 0.05);
  }

  /** Crunchy burst. */
  shatter(): void {
    this.burst(0.35, 900, 0.18);
    this.tone('sawtooth', 160, 40, 0.3, 0.08);
  }

  /** Deep boom with a long noise tail; louder when closer. */
  nova(near: number): void {
    const gain = 0.08 + 0.22 * Math.max(0, Math.min(1, near));
    this.tone('sine', 70, 22, 1.8, gain);
    this.burst(2.2, 420, gain);
  }

  /** Low thud. */
  crash(): void {
    this.tone('square', 120, 35, 0.25, 0.05);
  }

  private context(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private tone(
    type: OscillatorType,
    from: number,
    to: number,
    seconds: number,
    gain: number,
    delay = 0,
  ): void {
    const ctx = this.context();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + seconds);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  private burst(seconds: number, cutoff: number, gain: number): void {
    const ctx = this.context();
    if (!ctx) return;
    if (!this.noise) {
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    src.buffer = this.noise;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(60, t + seconds);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start(t);
    src.stop(t + seconds);
  }
}

/** Shared sound effect player. */
export const sfx = new Sfx();
