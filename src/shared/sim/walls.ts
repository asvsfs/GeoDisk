/**
 * @fileoverview The universe is closed: nothing leaves it and nothing is
 * deleted. Bodies and satellites bounce off its walls, losing a little
 * energy (`wallBounce`) but never mass.
 */

import type {System, World} from './world';

interface Moving {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Reflects anything that crosses the universe bounds back inside. */
export class Walls implements System {
  readonly name = 'walls';

  run(world: World, _dt: number): void {
    const {width, height, depth} = world.cfg.world;
    const k = Math.sqrt(world.cfg.physics.wallBounce);
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    for (const b of world.bodies) {
      if (!b.fixed) bounce(b, hw - b.radius, hh - b.radius, hd - b.radius, k);
    }
    for (const s of world.sats) bounce(s, hw, hh, hd, k);
  }
}

function bounce(
  o: Moving,
  hw: number,
  hh: number,
  hd: number,
  k: number,
): void {
  if (o.x > hw || o.x < -hw) {
    o.x = Math.sign(o.x) * hw;
    if (o.vx * o.x > 0) o.vx = -o.vx * k;
  }
  if (o.y > hh || o.y < -hh) {
    o.y = Math.sign(o.y) * hh;
    if (o.vy * o.y > 0) o.vy = -o.vy * k;
  }
  if (o.z > hd || o.z < -hd) {
    o.z = Math.sign(o.z) * hd;
    if (o.vz * o.z > 0) o.vz = -o.vz * k;
  }
}
