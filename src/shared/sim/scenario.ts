/**
 * @fileoverview The initial universe. It is seeded once; afterwards nothing
 * is added except by players.
 */

import {breakupSpin, kerrSpin, radiusFor} from './bodies';
import {onRails} from './motion';
import type {World} from './world';

/** Mass of the cluster's central black hole. */
const CORE_MU = 2.5e7;
/** Distance of the six outer systems from the centre. */
const RING = 2600;
/** Fraction of circular speed the outer systems start with. */
const SWIRL = 0.9;
/**
 * Permanent planets on rails around the core: orbit radius, mass and whether
 * it is a gas giant. The innermost stable orbit is 6 mu / c^2 (about 185).
 */
const PERMANENT_PLANETS: ReadonlyArray<{
  r: number;
  mu: number;
  giant: boolean;
}> = [
  {r: 520, mu: 1.2e5, giant: false},
  {r: 820, mu: 2e5, giant: true},
  {r: 1150, mu: 9e4, giant: false},
  {r: 1550, mu: 2.6e5, giant: true},
];
/** Gas giants are this many times larger than a rocky planet of equal mass. */
const GIANT_SCALE = 2.3;

/** One star system to seed. */
interface SystemSpec {
  starMu: number;
  planets: number;
}

/**
 * A loose star cluster around a spinning intermediate-mass black hole,
 * anchored at the centre. Four permanent planets circle it on rails: they
 * are the default homes, and anything that hits one is absorbed. Further
 * out, star systems of every class plus a white dwarf and a pulsar start on
 * slightly sub-circular orbits, so encounters build over minutes; the
 * supergiant burns out first.
 */
export function seedWorld(world: World): void {
  const c = world.cfg.world.c;
  world.addBody({
    kind: 'hole',
    x: 0,
    y: 0,
    mu: CORE_MU,
    spin: 0.5 * kerrSpin(CORE_MU, c),
    fixed: true,
  });
  addPermanentPlanets(world, CORE_MU, c);
  const turn = world.rng.range(0, Math.PI * 2);
  const at = (k: number) => {
    const a = turn + (k * Math.PI) / 3 + world.rng.range(-0.15, 0.15);
    const r = RING * world.rng.range(0.9, 1.1);
    return {x: Math.cos(a) * r, y: Math.sin(a) * r * 0.85};
  };
  const systems: SystemSpec[] = [
    {starMu: 1.4e7, planets: 0}, // Supergiant.
    {starMu: 3.7e6, planets: 2}, // Red dwarf.
    {starMu: 9e6, planets: 2}, // Blue giant.
    {starMu: 5.6e6, planets: 2}, // Yellow dwarf.
  ];
  systems.forEach((s, k) => {
    const p = at(k);
    addStarSystem(world, p.x, p.y, s.starMu, s.planets);
  });
  const dwarf = at(4);
  orbiter(world, 'white', 2.4e6, dwarf.x, dwarf.y, 0.1);
  const pulsar = at(5);
  orbiter(world, 'compact', 4e6, pulsar.x, pulsar.y, 0.6);
}

/**
 * Puts the permanent planets on circular orbits around a core of `mu` at the
 * origin, prograde with its spin and at evenly spread starting angles. The
 * speed is the circular speed of the satellite model (Newton plus the
 * Schwarzschild term), v^2 = (mu / r) / (1 - 3 mu / (r c^2)), so a satellite
 * dropped from one moves with it.
 */
function addPermanentPlanets(world: World, mu: number, c: number): void {
  const turn = world.rng.range(0, Math.PI * 2);
  PERMANENT_PLANETS.forEach((p, k) => {
    const v2 = mu / p.r / (1 - (3 * mu) / (p.r * c * c));
    const phase = turn + (k * 2 * Math.PI) / PERMANENT_PLANETS.length;
    const planet = world.addBody({
      kind: 'planet',
      x: Math.cos(phase) * p.r,
      y: Math.sin(phase) * p.r,
      mu: p.mu,
      radius: radiusFor('planet', p.mu) * (p.giant ? GIANT_SCALE : 1),
      permanent: true,
      orbit: {cx: 0, cy: 0, cz: 0, r: p.r, w: Math.sqrt(v2) / p.r, phase},
    });
    if (planet) onRails(planet, world.time);
  });
}

/**
 * Adds a star at (x, y) orbiting the heavy bodies, with planets on
 * near-circular orbits: the inner one rocky, the outer ones gas giants.
 */
export function addStarSystem(
  world: World,
  x: number,
  y: number,
  starMu: number,
  planets: number,
): number {
  const rng = world.rng;
  const star = orbiter(world, 'star', starMu, x, y, rng.range(0.05, 0.2));
  if (!star) return 0;
  let made = 1;
  let orbit = star.radius + rng.range(45, 60);
  for (let i = 0; i < planets; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const speed = Math.sqrt(starMu / orbit);
    const mu = rng.range(7e4, 1.6e5);
    const p = world.addBody({
      kind: 'planet',
      x: star.x + Math.cos(ang) * orbit,
      y: star.y + Math.sin(ang) * orbit,
      z: rng.range(-12, 12),
      vx: star.vx - Math.sin(ang) * speed,
      vy: star.vy + Math.cos(ang) * speed,
      mu,
      radius: radiusFor('planet', mu) * (i > 0 ? GIANT_SCALE : 1),
    });
    if (!p) break;
    made++;
    orbit *= rng.range(1.8, 2.1);
  }
  return made;
}

/**
 * Adds a body at (x, y) on a slow orbit around the heavy bodies placed so
 * far, spinning at `spinFrac` of breakup.
 */
function orbiter(
  world: World,
  kind: 'star' | 'white' | 'compact',
  mu: number,
  x: number,
  y: number,
  spinFrac: number,
) {
  // Orbit the centre of mass of everything heavy placed so far.
  let m = 0;
  let cx = 0;
  let cy = 0;
  for (const b of world.bodies) {
    if (b.kind === 'planet' || b.kind === 'rock') continue;
    m += b.mu;
    cx += b.x * b.mu;
    cy += b.y * b.mu;
  }
  let vx = 0;
  let vy = 0;
  if (m > 0) {
    const dx = x - cx / m;
    const dy = y - cy / m;
    const r = Math.max(1, Math.hypot(dx, dy));
    const v = Math.sqrt(m / r) * SWIRL;
    vx = (-dy / r) * v;
    vy = (dx / r) * v;
  }
  const radius = radiusFor(kind, mu);
  return world.addBody({
    kind,
    x,
    y,
    vx,
    vy,
    mu,
    radius,
    spin: spinFrac * breakupSpin(mu, radius),
  });
}
