/**
 * @fileoverview Motion systems for bodies (N-body) and satellites.
 */

import {EventKind} from '../types';
import {newSample} from './gravity';
import {GeodesicModel, type SatModel} from './sat_model';
import type {System, World} from './world';

const MAX_BODY_BETA = 0.82;

/**
 * Mutual N-body gravity with velocity Verlet: one field build and one
 * evaluation per body per step. Leaves `world.field` and `world.hash` built
 * at the new positions for later systems.
 */
export class BodyMotion implements System {
  readonly name = 'body-motion';
  private readonly f = newSample();

  run(world: World, dt: number): void {
    const bodies = world.bodies;
    const half = dt * dt * 0.5;
    for (const b of bodies) {
      if (b.fixed) continue;
      b.x += b.vx * dt + b.ax * half;
      b.y += b.vy * dt + b.ay * half;
      b.z += b.vz * dt + b.az * half;
    }
    world.field.build(bodies);
    world.hash.build(bodies);
    const max = world.cfg.world.c * MAX_BODY_BETA;
    for (const b of bodies) {
      if (b.fixed) continue;
      world.field.sample(b.x, b.y, b.z, this.f);
      let vx = b.vx + (b.ax + this.f.gx) * dt * 0.5;
      let vy = b.vy + (b.ay + this.f.gy) * dt * 0.5;
      let vz = b.vz + (b.az + this.f.gz) * dt * 0.5;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > max) {
        const k = max / speed;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      b.vx = vx;
      b.vy = vy;
      b.vz = vz;
      b.ax = this.f.gx;
      b.ay = this.f.gy;
      b.az = this.f.gz;
    }
  }
}

/**
 * Moves satellites with a pluggable `SatModel`. A satellite that hits a body
 * is absorbed by it (its mass is negligible); walls keep the rest inside.
 */
export class SatMotion implements System {
  readonly name = 'sat-motion';

  constructor(private readonly model: SatModel = new GeodesicModel()) {}

  run(world: World, dt: number): void {
    const c = world.cfg.world.c;
    const sats = world.sats;
    let w = 0;
    for (let i = 0; i < sats.length; i++) {
      const s = sats[i];
      this.model.step(s, world.field, dt, c);
      let hit = false;
      world.hash.query(s.x, s.y, s.z, 0, k => {
        const b = world.hash.get(k);
        const dx = s.x - b.x;
        const dy = s.y - b.y;
        const dz = s.z - b.z;
        if (dx * dx + dy * dy + dz * dz <= b.radius * b.radius) {
          hit = true;
          return true;
        }
        return false;
      });
      if (hit) {
        world.emit(EventKind.CRASH, s.x, s.y, s.z, 0, s.owner);
        continue;
      }
      sats[w++] = s;
    }
    sats.length = w;
  }
}
