/**
 * @fileoverview Body-body collisions: merge or shatter.
 *
 * The outcome depends on the impact speed relative to the pair's mutual
 * escape speed, q = |v_rel| / v_esc:
 *
 *  - Dense bodies (stars, white dwarfs, neutron stars, black holes) accrete
 *    whatever they touch. Two neutron stars merging throw out a little
 *    neutron-rich debris (a kilonova).
 *  - Planets and asteroids merge when q < mergeRatio (gravity wins).
 *  - Above that they shatter: the ejected fraction grows with q, the remnant
 *    keeps the rest, and fragments fly apart in momentum-neutral pairs. Slow
 *    fragments fall back and merge again.
 *
 * Every outcome conserves mass and linear momentum. Angular momentum is
 * conserved too: the pair's orbital angular momentum becomes spin, so an
 * off-centre impact spins the product up. A body spun past breakup flings
 * off fragments (fission); a black hole's spin is capped at the Kerr limit.
 * Ordinary matter conserves volume, so density survives mergers and is
 * inherited by fragments. With no free body slots, a shatter becomes a merge.
 */

import {EventKind, type Body} from '../types';
import {
  clampRadius,
  isDegenerate,
  isDense,
  maxSpin,
  mergedKind,
  refreshBody,
  softFor,
  starLifeFor,
} from './bodies';
import {eject} from './debris';
import type {System, World} from './world';

/** Contact distance as a fraction of the summed radii. */
const TOUCH = 0.92;
/** Smallest ejected fraction at the shatter threshold. */
const MIN_EJECT = 0.2;
/** Largest ejected fraction at or above `shatterRatio`. */
const MAX_EJECT = 0.8;

/** Detects overlapping bodies and resolves each contact once per step. */
export class Collisions implements System {
  readonly name = 'collisions';
  private dead = new Uint8Array(64);
  private readonly gone = new Set<Body>();

  run(world: World, _dt: number): void {
    const bodies = world.bodies;
    const n = bodies.length;
    if (n < 2) return;
    if (this.dead.length < n) this.dead = new Uint8Array(n * 2);
    const dead = this.dead;
    dead.fill(0, 0, n);
    // Snapshot the original list: shatters append fragments to world.bodies,
    // and those are excluded from this step's contacts.
    const list = bodies.slice(0, n);
    world.hash.build(list);
    for (let i = 0; i < n; i++) {
      if (dead[i]) continue;
      const a = list[i];
      world.hash.query(a.x, a.y, a.z, a.radius, j => {
        if (j <= i || dead[j] || dead[i]) return false;
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const reach = (a.radius + b.radius) * TOUCH;
        if (dx * dx + dy * dy + dz * dz > reach * reach) return false;
        const gone = resolve(world, a, b);
        if (gone === a || gone === BOTH) {
          dead[i] = 1;
          this.gone.add(a);
        }
        if (gone === b || gone === BOTH) {
          dead[j] = 1;
          this.gone.add(b);
        }
        return dead[i] === 1;
      });
    }
    world.pendingFree = 0;
    if (this.gone.size === 0) return;
    const gone = this.gone;
    let w = 0;
    for (let k = 0; k < bodies.length; k++) {
      if (!gone.has(bodies[k])) bodies[w++] = bodies[k];
    }
    bodies.length = w;
    gone.clear();
  }
}

/** Sentinel meaning both bodies were consumed (shatter). */
const BOTH = {} as Body;

/**
 * Resolves one contact. Returns the body to delete (or `BOTH`), or null when
 * the bodies are separating and nothing happens.
 */
function resolve(world: World, a: Body, b: Body): Body | null {
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rvz = b.vz - a.vz;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const closing = dx * rvx + dy * rvy + dz * rvz < 0;
  const deep = Math.hypot(dx, dy, dz) < (a.radius + b.radius) * 0.5;
  if (!closing && !deep) return null;

  // An anchored body always survives a contact, whatever its mass.
  const big = a.fixed || (!b.fixed && a.mu >= b.mu) ? a : b;
  const small = big === a ? b : a;
  const total = a.mu + b.mu;
  const vEsc = Math.sqrt((2 * total) / (a.radius + b.radius));
  const q = Math.hypot(rvx, rvy, rvz) / vEsc;
  const cfg = world.cfg.physics;

  if (
    big.fixed ||
    isDense(big.kind) ||
    isDense(small.kind) ||
    q < cfg.mergeRatio
  ) {
    merge(world, big, small);
    world.pendingFree++;
    return small;
  }

  const t = Math.min(
    1,
    (q - cfg.mergeRatio) / (cfg.shatterRatio - cfg.mergeRatio),
  );
  const frac = MIN_EJECT + (MAX_EJECT - MIN_EJECT) * t;
  // Both colliders are replaced, freeing their slots for the remnant and
  // fragments. With fewer than two further slots, there is no room to shatter.
  world.pendingFree += 2;
  if (world.freeBodies() < 3) {
    world.pendingFree -= 1;
    merge(world, big, small);
    return small;
  }
  shatter(world, big, small, frac, q);
  return BOTH;
}

/** Orbital angular momentum (z) of `b` about `a`, with reduced mass. */
function orbitalSpin(a: Body, b: Body): number {
  const reduced = (a.mu * b.mu) / (a.mu + b.mu);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return reduced * (dx * (b.vy - a.vy) - dy * (b.vx - a.vx));
}

/** Folds `small` into `big`, conserving mass, momentum and angular momentum. */
function merge(world: World, big: Body, small: Body): void {
  const cfg = world.cfg.physics;
  const total = big.mu + small.mu;
  const spin = big.spin + small.spin + orbitalSpin(big, small);
  const neutronPair = big.kind === 'compact' && small.kind === 'compact';
  const wa = big.fixed ? 1 : big.mu / total;
  const wb = 1 - wa;
  big.x = big.x * wa + small.x * wb;
  big.y = big.y * wa + small.y * wb;
  big.z = big.z * wa + small.z * wb;
  big.vx = big.vx * wa + small.vx * wb;
  big.vy = big.vy * wa + small.vy * wb;
  big.vz = big.vz * wa + small.vz * wb;
  big.ax = big.ax * wa + small.ax * wb;
  big.ay = big.ay * wa + small.ay * wb;
  big.az = big.az * wa + small.az * wb;
  const starLives = big.kind === 'star' && small.kind === 'star';
  const lifeA = big.life;
  const lifeB = small.life;
  if (!isDegenerate(big.kind) && !isDegenerate(small.kind)) {
    // Ordinary matter: volumes add, so density is preserved.
    big.radius = clampRadius(Math.cbrt(big.radius ** 3 + small.radius ** 3));
  }
  big.mu = total;
  big.spin = spin;
  big.kind = mergedKind(big.kind, small.kind);
  const before = refreshBody(big, cfg);
  if (starLives) {
    // Merged stars share remaining fuel, then burn at the new mass's rate.
    big.life = Math.min(lifeA * wa + lifeB * wb, starLifeFor(total, cfg));
  }
  world.emit(EventKind.MERGE, big.x, big.y, big.z, total);
  if (before !== 'star' && big.kind === 'star') {
    world.emit(EventKind.IGNITE, big.x, big.y, big.z, total);
  } else if (before !== 'hole' && big.kind === 'hole') {
    world.emit(EventKind.COLLAPSE, big.x, big.y, big.z, total);
  }
  if (neutronPair) kilonova(world, big);
  limitSpin(world, big);
}

/** Two neutron stars merged: a small fraction of the mass is flung out. */
function kilonova(world: World, b: Body): void {
  const mass = b.mu * world.cfg.physics.kilonovaFrac;
  const vEsc = Math.sqrt((2 * b.mu) / Math.max(b.radius, 1));
  const thrown = eject(world, {
    x: b.x,
    y: b.y,
    z: b.z,
    vx: b.vx,
    vy: b.vy,
    vz: b.vz,
    mu: mass,
    count: 6,
    clearance: b.radius + 10,
    minSpeed: Math.min(vEsc * 0.3, 500),
    maxSpeed: Math.min(vEsc * 0.5, 700),
    kind: 'rock',
    flatten: 0.3,
  });
  b.mu -= thrown;
  refreshBody(b, world.cfg.physics);
  world.emit(EventKind.KILONOVA, b.x, b.y, b.z, thrown);
}

/**
 * Keeps spin within physical limits. Black holes cap at the Kerr limit.
 * Other bodies spun well past breakup fling equatorial fragments outward;
 * otherwise the excess is shed in a disk too small to resolve.
 */
export function limitSpin(world: World, b: Body): void {
  const c = world.cfg.world.c;
  const limit = maxSpin(b, c);
  const excess = Math.abs(b.spin) / Math.max(limit, 1);
  if (excess <= 1) return;
  if (
    b.kind !== 'hole' &&
    !b.fixed &&
    excess >= world.cfg.physics.fissionSpin &&
    fission(world, b)
  ) {
    return;
  }
  b.spin = Math.sign(b.spin) * limit;
}

/** Sheds equatorial fragments from an over-spun body; false if no slots. */
function fission(world: World, b: Body): boolean {
  const pairs = Math.min(2, Math.floor(world.freeBodies() / 2));
  if (pairs < 1) return false;
  const shed = b.mu * 0.12;
  const each = shed / (pairs * 2);
  const dir = Math.sign(b.spin);
  const vEq = Math.sqrt(b.mu / Math.max(b.radius, 1)) * 1.15;
  const volPerMu = b.radius ** 3 / b.mu;
  const turn = world.rng.range(0, Math.PI * 2);
  for (let k = 0; k < pairs * 2; k++) {
    const a = turn + (k * Math.PI) / pairs;
    const f = world.addBody({kind: 'rock', x: 0, y: 0, mu: each, spin: 0});
    if (!f) break;
    if (!isDegenerate(f.kind)) {
      f.radius = clampRadius(Math.cbrt(each * volPerMu));
      f.soft = softFor(f.kind, f.radius);
    }
    const r = b.radius + f.radius * 1.6 + 2;
    f.x = b.x + Math.cos(a) * r;
    f.y = b.y + Math.sin(a) * r;
    f.z = b.z;
    // Opposite positions get opposite tangential velocities: no net momentum.
    f.vx = b.vx - Math.sin(a) * vEq * dir;
    f.vy = b.vy + Math.cos(a) * vEq * dir;
    f.vz = b.vz;
  }
  b.mu -= shed;
  if (!isDegenerate(b.kind)) {
    // Same density, less mass.
    b.radius = clampRadius(b.radius * Math.cbrt(b.mu / (b.mu + shed)));
  }
  refreshBody(b, world.cfg.physics);
  b.spin = dir * maxSpin(b, world.cfg.world.c);
  world.emit(EventKind.FISSION, b.x, b.y, b.z, shed);
  return true;
}

/** Breaks the pair into a remnant plus ejecta; both originals are removed. */
function shatter(
  world: World,
  a: Body,
  b: Body,
  frac: number,
  q: number,
): void {
  const total = a.mu + b.mu;
  const wa = a.mu / total;
  const wb = b.mu / total;
  const cx = a.x * wa + b.x * wb;
  const cy = a.y * wa + b.y * wb;
  const cz = a.z * wa + b.z * wb;
  const cvx = a.vx * wa + b.vx * wb;
  const cvy = a.vy * wa + b.vy * wb;
  const cvz = a.vz * wa + b.vz * wb;
  const big = a.mu >= b.mu ? a : b;
  // Fragments and remnant share the pair's density.
  const volPerMu = (a.radius ** 3 + b.radius ** 3) / total;
  const spin = a.spin + b.spin + orbitalSpin(a, b);
  const remMu = total * (1 - frac);

  const rem = world.addBody({
    kind: big.kind,
    x: cx,
    y: cy,
    z: cz,
    vx: cvx,
    vy: cvy,
    vz: cvz,
    mu: remMu,
    radius: Math.cbrt(remMu * volPerMu),
    spin: spin * (1 - frac),
  });
  // The remnant inherits the larger body's id so player homes survive.
  if (rem) rem.id = big.id;
  const remR = rem ? rem.radius : 0;
  const vEscRem = Math.sqrt((2 * Math.max(remMu, 1)) / Math.max(remR, 1));
  const ejectMu = total - (rem ? rem.mu : 0);
  const count = Math.round(
    2 + Math.min(1, (q - 1) / 4) * (world.cfg.physics.maxFragments - 2),
  );
  const thrown = eject(world, {
    x: cx,
    y: cy,
    z: cz,
    vx: cvx,
    vy: cvy,
    vz: cvz,
    mu: ejectMu,
    count,
    clearance: remR,
    minSpeed: vEscRem * 0.55,
    maxSpeed: vEscRem * (1.1 + 0.25 * q),
    kind: 'rock',
    flatten: 0.4,
    volPerMu,
  });
  if (rem && thrown < ejectMu) {
    // Mass that found no free slot stays in the remnant.
    const extra = ejectMu - thrown;
    rem.radius = clampRadius(Math.cbrt(rem.radius ** 3 + extra * volPerMu));
    rem.mu += extra;
    refreshBody(rem, world.cfg.physics);
  }
  if (rem) limitSpin(world, rem);
  world.emit(
    EventKind.SHATTER,
    cx,
    cy,
    cz,
    total,
    Math.round((thrown / Math.max(1, total)) * 100),
  );
}
