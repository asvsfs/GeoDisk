/**
 * @fileoverview Adaptive load budget for one room.
 *
 * The room reports, for each pump of its loop, how long physics and
 * networking kept the thread busy and how many bytes it sent. The budget
 * smooths these into a CPU share and an upload rate and, when either is over
 * its limit, degrades in this order:
 *
 *   1. lower the snapshot rate (30 -> 20 -> 15 ... down to `minSnapHz`);
 *   2. shrink the effective body and satellite caps (to at least 25%).
 *
 * Recovery runs in reverse: caps grow back first, then the snapshot rate.
 * Caps only stop new entities from being created; nothing alive is removed.
 */

import type {Limits} from '../config';

/** Snapshot rates the budget steps through, highest first. */
const RATES = [60, 30, 20, 15, 10, 5];
const MIN_SCALE = 0.25;
const SHRINK = 0.9;
const GROW = 1.05;
/** Smoothing time constant for load measurements, milliseconds. */
const SMOOTH_MS = 1000;
/** Minimum time between two adjustments, milliseconds. */
const SETTLE_MS = 500;
/** Load below this fraction of a limit counts as headroom. */
const HEADROOM = 0.6;

/** What one pump of the room loop cost. */
export interface LoadSample {
  /** Wall-clock milliseconds since the previous sample. */
  elapsedMs: number;
  /** Milliseconds spent stepping physics. */
  physicsMs: number;
  /** Milliseconds spent encoding and sending. */
  netMs: number;
  /** Bytes handed to the transport. */
  bytes: number;
  /** Physics steps run. */
  steps: number;
}

/** Tracks load and derives the effective caps and snapshot rate. */
export class Budget {
  /** Smoothed busy share of one core (physics + network), 0..1+. */
  cpu = 0;
  /** Smoothed physics cost per step, milliseconds. */
  stepMs = 0;
  /** Smoothed upload, bytes per second. */
  uploadBps = 0;
  /** Current cap scale in [MIN_SCALE, 1]. */
  scale = 1;
  /** Current snapshot rate. */
  snapHz: number;
  private settleMs = 0;

  constructor(
    private readonly limits: Limits,
    private readonly maxSnapHz: number,
  ) {
    this.snapHz = maxSnapHz;
  }

  /** Records one pump and adjusts the rate or caps if needed. */
  record(s: LoadSample): void {
    if (s.elapsedMs <= 0) return;
    const k = 1 - Math.exp(-s.elapsedMs / SMOOTH_MS);
    const busy = (s.physicsMs + s.netMs) / s.elapsedMs;
    this.cpu += (busy - this.cpu) * k;
    this.uploadBps += ((s.bytes * 1000) / s.elapsedMs - this.uploadBps) * k;
    if (s.steps > 0) {
      const perStep = s.physicsMs / s.steps;
      this.stepMs =
        this.stepMs === 0 ? perStep : this.stepMs + (perStep - this.stepMs) * k;
    }
    this.settleMs -= s.elapsedMs;
    if (this.settleMs > 0) return;

    const cpuLoad = this.cpu / this.limits.cpuShare;
    const upCap = this.limits.maxUploadMbps * 125_000;
    const upLoad = upCap > 0 ? this.uploadBps / upCap : 0;
    const load = Math.max(cpuLoad, upLoad);
    if (load > 1) {
      if (!this.slowDown())
        this.scale = Math.max(MIN_SCALE, this.scale * SHRINK);
      this.settleMs = SETTLE_MS;
    } else if (load < HEADROOM) {
      if (this.scale < 1) this.scale = Math.min(1, this.scale * GROW);
      else this.speedUp();
      this.settleMs = SETTLE_MS;
    }
  }

  /** Effective body cap. */
  bodyCap(): number {
    return Math.max(8, Math.floor(this.limits.maxBodies * this.scale));
  }

  /** Effective satellite cap. */
  satCap(): number {
    return Math.max(8, Math.floor(this.limits.maxSats * this.scale));
  }

  /** Steps one rate lower; false when already at the floor. */
  private slowDown(): boolean {
    const next = RATES.find(r => r < this.snapHz && r >= this.limits.minSnapHz);
    if (next === undefined) return false;
    this.snapHz = next;
    return true;
  }

  /** Steps one rate higher, back up to the configured maximum. */
  private speedUp(): void {
    const higher = [...RATES, this.maxSnapHz].filter(
      r => r > this.snapHz && r <= this.maxSnapHz,
    );
    if (higher.length > 0) this.snapHz = Math.min(...higher);
  }
}
