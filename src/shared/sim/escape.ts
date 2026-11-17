/**
 * @fileoverview The universe is open. Anything past its bounds that gravity
 * can no longer bring back is gone.
 *
 * An object outside the bounds escapes when its energy per unit mass,
 * E = v^2 / 2 + phi (phi from every other body), is not negative: nothing
 * left in the universe can stop it. A bound object may swing out and fall
 * back in, but past `escapeLimit` times the half-size it is removed anyway,
 * so nothing wanders off for minutes. Anchored bodies never escape.
 */

import {EventKind} from '../types';
import {isAnchored} from './bodies';
import {newSample} from './gravity';
import type {System, World} from './world';

interface Moving {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Removes bodies and satellites that left the universe for good. */
export class Escape implements System {
  readonly name = 'escape';
  private readonly f = newSample();

  run(world: World, _dt: number): void {
    const {width, height, depth} = world.cfg.world;
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    const limit = world.cfg.physics.escapeLimit;

    const bodies = world.bodies;
    let w = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const out = outside(b, hw, hh, hd);
      if (
        out > 1 &&
        !isAnchored(b) &&
        (out > limit || this.unbound(world, b, b.mu / Math.max(b.soft, 1e-6)))
      ) {
        world.lostMu += b.mu;
        world.emit(EventKind.ESCAPE, b.x, b.y, b.z, b.mu, b.id);
        continue;
      }
      bodies[w++] = b;
    }
    bodies.length = w;

    const sats = world.sats;
    w = 0;
    for (let i = 0; i < sats.length; i++) {
      const s = sats[i];
      const out = outside(s, hw, hh, hd);
      if (out > 1 && (out > limit || this.unbound(world, s, 0))) {
        world.emit(EventKind.ESCAPE, s.x, s.y, s.z, 0, s.owner);
        continue;
      }
      sats[w++] = s;
    }
    sats.length = w;
  }

  /**
   * True when `o` has non-negative energy in the field of the other bodies.
   * `self` is the object's own potential at its centre (mu / soft), which the
   * field includes for a body and must be taken out again.
   */
  private unbound(world: World, o: Moving, self: number): boolean {
    const phi = world.field.sample(o.x, o.y, o.z, this.f).phi + self;
    const v2 = o.vx * o.vx + o.vy * o.vy + o.vz * o.vz;
    return 0.5 * v2 + phi >= 0;
  }
}

/** How far outside the bounds `o` is, as a multiple of the half-size (<= 1 inside). */
function outside(o: Moving, hw: number, hh: number, hd: number): number {
  return Math.max(Math.abs(o.x) / hw, Math.abs(o.y) / hh, Math.abs(o.z) / hd);
}
