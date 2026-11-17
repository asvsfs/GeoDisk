/**
 * @fileoverview Replaceable satellite flight models.
 *
 * A model advances one satellite through a `FieldSolver` for one step. New
 * models (thrust, drag, higher-order GR) plug in by implementing `SatModel`
 * and registering in `SAT_MODELS`; nothing else depends on the formulas.
 */

import type {Sat} from '../types';
import {
  newSample,
  type Accel,
  type FieldSample,
  type FieldSolver,
} from './gravity';

/** Advances a satellite in place. */
export interface SatModel {
  readonly id: string;
  readonly name: string;
  step(s: Sat, field: FieldSolver, dt: number, c: number): void;
}

const MAX_BETA = 0.95;

/**
 * Relativistic geodesic as the satellite experiences it (proper time):
 *
 *   a = g + sum over compact bodies of the Schwarzschild term + v x B
 *
 * `g` is full Newtonian gravity from every body. Near black holes, neutron
 * stars and white dwarfs, `FieldSolver.addStrong` adds the exact
 * Schwarzschild correction in each body's rest frame (orbits precess, there
 * is an innermost stable orbit, close passes plunge in). `B` adds frame
 * dragging from spinning bodies. Integrated with RK2 midpoint.
 *
 * An earlier version scaled g by alpha^4 = (1 + 2 phi / c^2)^2 and added a
 * world-frame (v . g) v drag. That is coordinate-time 1PN, valid only where
 * |phi| << c^2. Around game black holes it shrank gravity to under 1% well
 * outside the collision radius, so satellites hovered and rode along with
 * the hole instead of falling in.
 */
export class GeodesicModel implements SatModel {
  readonly id = 'geodesic';
  readonly name = 'Schwarzschild geodesic (proper time)';
  private readonly s1: FieldSample = newSample();
  private readonly s2: FieldSample = newSample();
  private readonly k1: Accel = {ax: 0, ay: 0, az: 0};
  private readonly k2: Accel = {ax: 0, ay: 0, az: 0};

  step(s: Sat, field: FieldSolver, dt: number, c: number): void {
    accel(field, s.x, s.y, s.z, s.vx, s.vy, s.vz, this.s1, this.k1);
    const h = dt / 2;
    const mvx = s.vx + this.k1.ax * h;
    const mvy = s.vy + this.k1.ay * h;
    const mvz = s.vz + this.k1.az * h;
    accel(
      field,
      s.x + s.vx * h,
      s.y + s.vy * h,
      s.z + s.vz * h,
      mvx,
      mvy,
      mvz,
      this.s2,
      this.k2,
    );
    integrate(s, this.k2, dt, c);
  }
}

function accel(
  field: FieldSolver,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  f: FieldSample,
  out: Accel,
): void {
  field.sample(x, y, z, f);
  out.ax = f.gx + (vy * f.bz - vz * f.by);
  out.ay = f.gy + (vz * f.bx - vx * f.bz);
  out.az = f.gz + (vx * f.by - vy * f.bx);
  field.addStrong(x, y, z, vx, vy, vz, out);
}

/** Classical Newtonian flight (a = g), RK2 midpoint. */
export class NewtonModel implements SatModel {
  readonly id = 'newton';
  readonly name = 'Newtonian';
  private readonly s: FieldSample = newSample();
  private readonly k: Accel = {ax: 0, ay: 0, az: 0};

  step(s: Sat, field: FieldSolver, dt: number, c: number): void {
    const h = dt / 2;
    field.sample(s.x + s.vx * h, s.y + s.vy * h, s.z + s.vz * h, this.s);
    this.k.ax = this.s.gx;
    this.k.ay = this.s.gy;
    this.k.az = this.s.gz;
    integrate(s, this.k, dt, c);
  }
}

function integrate(s: Sat, a: Accel, dt: number, c: number): void {
  let vx = s.vx + a.ax * dt;
  let vy = s.vy + a.ay * dt;
  let vz = s.vz + a.az * dt;
  const max = c * MAX_BETA;
  const speed = Math.hypot(vx, vy, vz);
  if (speed > max) {
    const k = max / speed;
    vx *= k;
    vy *= k;
    vz *= k;
  }
  s.x += (s.vx + vx) * 0.5 * dt;
  s.y += (s.vy + vy) * 0.5 * dt;
  s.z += (s.vz + vz) * 0.5 * dt;
  s.vx = vx;
  s.vy = vy;
  s.vz = vz;
  s.age += dt;
}

/** Registered models by id. */
export const SAT_MODELS: Readonly<Record<string, () => SatModel>> = {
  geodesic: () => new GeodesicModel(),
  newton: () => new NewtonModel(),
};
