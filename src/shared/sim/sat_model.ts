/**
 * @fileoverview Replaceable satellite flight models.
 *
 * A model advances one satellite through a `FieldSolver` for one step. New
 * models (thrust, drag, higher-order GR) plug in by implementing `SatModel`
 * and registering in `SAT_MODELS`; nothing else depends on the formulas.
 */

import type {Sat} from '../types';
import {newSample, type FieldSample, type FieldSolver} from './gravity';

/** Advances a satellite in place. */
export interface SatModel {
  readonly id: string;
  readonly name: string;
  step(s: Sat, field: FieldSolver, dt: number, c: number): void;
}

const MAX_BETA = 0.95;

/** Scratch acceleration result to keep the inner loop allocation-free. */
interface Accel {
  ax: number;
  ay: number;
  az: number;
}

/**
 * Weak-field (1PN) relativistic geodesic in isotropic coordinates:
 *
 *   a = (alpha^4 + beta^2) g - (4 / c^2)(v . g) v + v x B
 *
 * with alpha^2 = max(0.08, 1 + 2 phi / c^2), integrated with RK2 midpoint.
 */
export class GeodesicModel implements SatModel {
  readonly id = 'geodesic';
  readonly name = '1PN relativistic geodesic';
  private readonly s1: FieldSample = newSample();
  private readonly s2: FieldSample = newSample();
  private readonly k1: Accel = {ax: 0, ay: 0, az: 0};
  private readonly k2: Accel = {ax: 0, ay: 0, az: 0};

  step(s: Sat, field: FieldSolver, dt: number, c: number): void {
    const invC2 = 1 / (c * c);
    accel(
      field.sample(s.x, s.y, s.z, this.s1),
      s.vx,
      s.vy,
      s.vz,
      invC2,
      this.k1,
    );
    const h = dt / 2;
    const mvx = s.vx + this.k1.ax * h;
    const mvy = s.vy + this.k1.ay * h;
    const mvz = s.vz + this.k1.az * h;
    field.sample(s.x + s.vx * h, s.y + s.vy * h, s.z + s.vz * h, this.s2);
    accel(this.s2, mvx, mvy, mvz, invC2, this.k2);
    integrate(s, this.k2, dt, c);
  }
}

function accel(
  f: FieldSample,
  vx: number,
  vy: number,
  vz: number,
  invC2: number,
  out: Accel,
): void {
  const beta2 = Math.min(0.88, (vx * vx + vy * vy + vz * vz) * invC2);
  const alpha2 = Math.max(0.08, 1 + 2 * f.phi * invC2);
  const scale = alpha2 * alpha2 + beta2;
  const drag = 4 * (vx * f.gx + vy * f.gy + vz * f.gz) * invC2;
  out.ax = f.gx * scale - vx * drag + (vy * f.bz - vz * f.by);
  out.ay = f.gy * scale - vy * drag + (vz * f.bx - vx * f.bz);
  out.az = f.gz * scale - vz * drag + (vx * f.by - vy * f.bx);
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
