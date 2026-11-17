/**
 * Procedural Web Audio synthesizer for rocket ignition, thrust rumble,
 * waypoint chimes, victory fanfare, and event horizon impacts.
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private thrustGain: GainNode | null = null;
  private thrustOsc: OscillatorNode | null = null;

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
    if (mute && this.thrustGain && this.ctx) {
      this.thrustGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public playLaunchIgnition(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.28);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.31);
  }

  public setThrustActive(active: boolean): void {
    if (this.muted) active = false;
    if (!active) {
      if (this.thrustGain && this.ctx) {
        this.thrustGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
      }
      return;
    }

    const ctx = this.ensureContext();
    if (!ctx) return;

    if (!this.thrustOsc || !this.thrustGain) {
      this.thrustOsc = ctx.createOscillator();
      this.thrustGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;

      this.thrustOsc.type = 'triangle';
      this.thrustOsc.frequency.value = 58;
      this.thrustGain.gain.value = 0;

      this.thrustOsc.connect(filter);
      filter.connect(this.thrustGain);
      this.thrustGain.connect(ctx.destination);
      this.thrustOsc.start();
    }

    this.thrustGain.gain.setTargetAtTime(0.08, ctx.currentTime, 0.04);
  }

  public playWaypointChime(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    [523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.06);
      gain.gain.setValueAtTime(0.08, now + i * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.23);
    });
  }

  public playVictory(): void {
    this.setThrustActive(false);
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    [440, 554.37, 659.25, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.075);
      gain.gain.setValueAtTime(0.09, now + i * 0.075);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.075 + 0.36);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.075);
      osc.stop(now + i * 0.075 + 0.38);
    });
  }

  public playCrash(): void {
    this.setThrustActive(false);
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.38);

    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.42);
  }
}

export const soundEngine = new SoundEngine();
