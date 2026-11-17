/**
 * @fileoverview Ejecta generation shared by shatters and supernovae.
 */

import type {Body, BodyKind} from '../types';
import {clampRadius, isDegenerate, softFor} from './bodies';
import type {World} from './world';

/** Parameters for one burst of ejecta. */
export interface Burst {
  /** Centre of mass and its velocity. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Total mass to eject, split evenly across fragments. */
  mu: number;
  /** Requested fragment count; trimmed to free body slots. */
  count: number;
  /** Fragments start just outside this radius. */
  clearance: number;
  /** Ejection speed range relative to the centre of mass. */
  minSpeed: number;
  maxSpeed: number;
  /** Fragment kind before mass thresholds are applied. */
  kind: BodyKind;
  /** Vertical flattening of directions (0 = in-plane, 1 = isotropic). */
  flatten: number;
  /**
   * Volume per unit mass of the parent (r^3 / mu). Fragments inherit this
   * density; omit to use the default size for their mass.
   */
  volPerMu?: number;
}

/**
 * Throws out fragments in opposing pairs so the burst carries no net momentum
 * relative to its centre of mass. Returns the mass actually ejected, which is
 * less than `burst.mu` when the body cap leaves too few free slots.
 */
export function eject(world: World, burst: Burst): number {
  const slots = world.freeBodies();
  let count = Math.min(burst.count, slots);
  if (count >= 2) count -= count % 2;
  if (count < 2) return 0;
  const rng = world.rng;
  const each = burst.mu / count;
  const pairs = count / 2;
  const turn = rng.range(0, Math.PI * 2);
  for (let p = 0; p < pairs; p++) {
    const a = turn + (p / pairs) * Math.PI + rng.range(-0.25, 0.25);
    const el = rng.range(-0.5, 0.5) * burst.flatten;
    const dx = Math.cos(a) * Math.cos(el);
    const dy = Math.sin(a) * Math.cos(el);
    const dz = Math.sin(el);
    const speed = rng.range(burst.minSpeed, burst.maxSpeed);
    for (const sign of [1, -1]) {
      const b = world.addBody({kind: burst.kind, x: 0, y: 0, mu: each});
      if (!b) return each * (p * 2 + (sign < 0 ? 1 : 0));
      if (burst.volPerMu !== undefined && !isDegenerate(b.kind)) {
        b.radius = clampRadius(Math.cbrt(each * burst.volPerMu));
        b.soft = softFor(b.kind, b.radius);
      }
      place(b, burst, sign * dx, sign * dy, sign * dz, speed);
    }
  }
  return each * count;
}

function place(
  b: Body,
  burst: Burst,
  dx: number,
  dy: number,
  dz: number,
  speed: number,
): void {
  const r = burst.clearance + b.radius * 1.6 + 2;
  b.x = burst.x + dx * r;
  b.y = burst.y + dy * r;
  b.z = burst.z + dz * r;
  b.vx = burst.vx + dx * speed;
  b.vy = burst.vy + dy * speed;
  b.vz = burst.vz + dz * speed;
}
