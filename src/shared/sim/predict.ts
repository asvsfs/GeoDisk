/**
 * @fileoverview Trajectory preview using the same systems as the server, so
 * the aiming line matches what the authoritative world will do (until other
 * players change it).
 */

import type {GameConfig} from '../config';
import type {Body} from '../types';
import {BodyMotion, SatMotion} from './motion';
import {World} from './world';

/** A point on a predicted path. */
export interface PathPoint {
  x: number;
  y: number;
  /** Gravitational lapse sqrt(1 + 2 phi / c^2) at the point (time dilation). */
  lapse: number;
}

/** Launch parameters for a preview. */
export interface Shot {
  /** Id of the body launched from. */
  home: number;
  angle: number;
  pitch: number;
  speed: number;
}

/** How far ahead to look. */
export interface PredictOptions {
  /** Seconds of satellite flight to simulate. */
  seconds?: number;
  /**
   * Seconds to advance the bodies before launching, so the preview starts
   * where the server will actually launch (snapshot age plus latency).
   */
  lead?: number;
}

/**
 * Simulates one satellite through a private copy of `bodies`. Stops early on
 * a crash. Returns an empty path if the home body is gone.
 */
export function predictPath(
  cfg: GameConfig,
  bodies: readonly Body[],
  shot: Shot,
  opts: PredictOptions = {},
): PathPoint[] {
  // A coarser step keeps previews cheap; accuracy loss over seconds is small.
  const coarse = {...cfg, world: {...cfg.world, dt: cfg.world.dt * 2}};
  const dt = coarse.world.dt;
  const world = new World(coarse, [new BodyMotion(), new SatMotion()], 1);
  world.bodies = bodies.map(b => ({...b}));
  const leadSteps = Math.round(Math.max(0, opts.lead ?? 0) / dt);
  for (let i = 0; i < leadSteps; i++) world.step();
  const home = world.body(shot.home);
  if (!home) return [];

  const {angle, pitch, speed} = shot;
  const dx = Math.cos(angle) * Math.cos(pitch);
  const dy = Math.sin(angle) * Math.cos(pitch);
  const dz = Math.sin(pitch);
  const r = home.radius + 3;
  world.sats.push({
    id: 1,
    owner: 0,
    x: home.x + dx * r,
    y: home.y + dy * r,
    z: home.z + dz * r,
    vx: home.vx + dx * speed,
    vy: home.vy + dy * speed,
    vz: home.vz + dz * speed,
    age: 0,
  });
  const out: PathPoint[] = [];
  const steps = Math.round((opts.seconds ?? 5) / dt);
  const invC2 = 1 / (cfg.world.c * cfg.world.c);
  const f = {phi: 0, gx: 0, gy: 0, gz: 0, bx: 0, by: 0, bz: 0};
  for (let i = 0; i < steps; i++) {
    world.step();
    const s = world.sats[0];
    if (!s) break;
    world.field.sample(s.x, s.y, s.z, f);
    out.push({
      x: s.x,
      y: s.y,
      lapse: Math.sqrt(Math.max(0.0625, 1 + 2 * f.phi * invC2)),
    });
  }
  return out;
}
