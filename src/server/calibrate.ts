/**
 * @fileoverview Host calibration: measures what this machine can simulate
 * and recommends limits that keep a room within its CPU and bandwidth
 * budget.
 *
 * The benchmark runs the real step pipeline on synthetic worlds of growing
 * size (satellites scale with bodies at a fixed ratio), finds the largest
 * size whose physics cost fits the target, and derives the per-player
 * bandwidth of that size and the player count the upload budget allows.
 */

import type {GameConfig, Limits} from '../shared/config';
import {Msg, encode} from '../shared/net/protocol';
import {defaultSystems} from '../shared/sim/pipeline';
import {Rng} from '../shared/sim/rng';
import {World} from '../shared/sim/world';

/** Share of the CPU budget given to physics; the rest is networking and GC. */
const PHYSICS_SHARE = 0.7;
/** UDP/QUIC/WebTransport framing overhead on snapshot bytes. */
const WIRE_OVERHEAD = 1.06;
/** Snapshot header bytes and per-entity bytes (see protocol.ts). */
const SNAP_HEADER = 21;
const BODY_BYTES = 38;
const SAT_BYTES = 24;
/**
 * Smallest world the upload budget may shrink caps to before it cuts the
 * player count instead.
 */
const MIN_UPLOAD_BODIES = 32;
/**
 * Never recommend more bodies than clients can render: the WebGPU field
 * renderer's mass buffer holds 256 (MAX_MASSES_GPU in webgpu_field.ts).
 */
const MAX_BODIES = 256;

/** One benchmark point. */
export interface BenchPoint {
  bodies: number;
  sats: number;
  /** Median physics cost per step, milliseconds. */
  stepMs: number;
  /** Cost to encode one snapshot, milliseconds. */
  encodeMs: number;
}

/** Calibration result and recommended limits. */
export interface Calibration {
  points: BenchPoint[];
  /** Physics milliseconds per step the target allows. */
  stepBudgetMs: number;
  /** Largest world the CPU budget allows. */
  cpuBodies: number;
  /** Recommended caps (the CPU fit, shrunk if the upload budget requires). */
  maxBodies: number;
  maxSats: number;
  /** Which budget set the caps. */
  limitedBy: 'cpu' | 'upload';
  /** Snapshot bandwidth per player at full caps and full rate, bytes/s. */
  bytesPerPlayer: number;
  /** Players the upload budget allows (Infinity when unlimited). */
  playersByUpload: number;
  /** Recommended player cap: configured cap limited by bandwidth. */
  maxPlayers: number;
}

/** Calibration options. */
export interface CalibrateOptions {
  /** Satellites per body in the synthetic worlds. */
  satRatio?: number;
  /** Steps measured per point (after warm-up). */
  steps?: number;
}

/** Bytes of one snapshot with `bodies` bodies and `sats` satellites. */
export function snapshotBytes(bodies: number, sats: number): number {
  return SNAP_HEADER + BODY_BYTES * bodies + SAT_BYTES * sats;
}

/** Median physics cost per step of the real pipeline at this size. */
export function benchPoint(
  cfg: GameConfig,
  bodies: number,
  sats: number,
  steps = 40,
): BenchPoint {
  const limits = {...cfg.limits, maxBodies: bodies, maxSats: sats};
  const world = new World({...cfg, limits}, defaultSystems(), 1234);
  const rng = new Rng(bodies * 7919 + sats);
  const hw = cfg.world.width * 0.45;
  const hh = cfg.world.height * 0.45;
  while (world.bodies.length < bodies) {
    world.addBody({
      kind: 'planet',
      x: rng.range(-hw, hw),
      y: rng.range(-hh, hh),
      vx: rng.range(-30, 30),
      vy: rng.range(-30, 30),
      mu: rng.range(4e4, 2e5),
    });
  }
  for (let i = 0; i < sats; i++) {
    world.sats.push({
      id: world.newId(),
      owner: 1,
      x: rng.range(-hw, hw),
      y: rng.range(-hh, hh),
      z: 0,
      vx: rng.range(-150, 150),
      vy: rng.range(-150, 150),
      vz: 0,
      age: 0,
    });
  }
  for (let i = 0; i < 10; i++) world.step();
  const times: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    world.step();
    times.push(performance.now() - t0);
    world.events.length = 0;
  }
  times.sort((a, b) => a - b);
  const snap = {
    type: Msg.SNAP as const,
    tick: 0,
    time: 0,
    bodyCap: bodies,
    satCap: sats,
    bodies: world.bodies,
    sats: world.sats,
  };
  const e0 = performance.now();
  for (let i = 0; i < 10; i++) encode(snap);
  return {
    bodies,
    sats,
    stepMs: times[Math.floor(times.length / 2)],
    encodeMs: (performance.now() - e0) / 10,
  };
}

/**
 * Finds the largest world that fits `limits.cpuShare` of one core and
 * recommends caps. Doubles the size until over budget, then bisects.
 */
export function calibrate(
  cfg: GameConfig,
  opts: CalibrateOptions = {},
): Calibration {
  const ratio = opts.satRatio ?? cfg.limits.maxSats / cfg.limits.maxBodies;
  const steps = opts.steps ?? 40;
  const stepPeriodMs = cfg.world.dt * 1000;
  const stepBudgetMs = cfg.limits.cpuShare * stepPeriodMs * PHYSICS_SHARE;
  const points: BenchPoint[] = [];
  const fits = (n: number) => {
    const p = benchPoint(cfg, n, Math.round(n * ratio), steps);
    points.push(p);
    return p.stepMs <= stepBudgetMs;
  };

  let lo = 0;
  let hi = 16;
  while (hi <= MAX_BODIES && fits(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi > MAX_BODIES) hi = MAX_BODIES;
  // Bisect between the last size that fit and the first that did not.
  for (let i = 0; i < 4 && hi - lo > 8; i++) {
    const mid = Math.round((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const cpuBodies = Math.max(8, lo);
  let maxBodies = cpuBodies;
  let limitedBy: Calibration['limitedBy'] = 'cpu';

  // Players come first: with an upload budget, shrink the world until the
  // configured player count fits at full caps, down to MIN_UPLOAD_BODIES.
  const upload = cfg.limits.maxUploadMbps * 125_000;
  const perEntity = BODY_BYTES + SAT_BYTES * ratio;
  if (upload > 0) {
    const perSnap =
      upload / (cfg.limits.maxPlayers * cfg.world.snapHz * WIRE_OVERHEAD);
    const fitBodies = Math.floor((perSnap - SNAP_HEADER) / perEntity);
    if (fitBodies < maxBodies) {
      maxBodies = Math.max(Math.min(MIN_UPLOAD_BODIES, cpuBodies), fitBodies);
      limitedBy = 'upload';
    }
  }
  const maxSats = Math.max(8, Math.round(maxBodies * ratio));
  const bytesPerPlayer = Math.ceil(
    snapshotBytes(maxBodies, maxSats) * cfg.world.snapHz * WIRE_OVERHEAD,
  );
  const playersByUpload =
    upload > 0 ? Math.floor(upload / bytesPerPlayer) : Infinity;
  return {
    points: points.sort((a, b) => a.bodies - b.bodies),
    stepBudgetMs,
    cpuBodies,
    maxBodies,
    maxSats,
    limitedBy,
    bytesPerPlayer,
    playersByUpload,
    maxPlayers: Math.max(1, Math.min(cfg.limits.maxPlayers, playersByUpload)),
  };
}

/** Limits from a calibration, keeping any values set explicitly. */
export function calibratedLimits(
  cal: Calibration,
  explicit: Partial<Limits>,
): Partial<Limits> {
  return {
    maxBodies: explicit.maxBodies ?? cal.maxBodies,
    maxSats: explicit.maxSats ?? cal.maxSats,
    maxPlayers: explicit.maxPlayers ?? cal.maxPlayers,
  };
}
