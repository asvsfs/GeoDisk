/**
 * @fileoverview Stellar evolution: how stars live and die.
 *
 *  - Light stars (below `collapseMu`) end by shedding their envelope as a
 *    planetary nebula, leaving a white dwarf.
 *  - Heavy stars end in a core-collapse supernova: the core becomes a neutron
 *    star (or a black hole past the TOV limit), the envelope flies out and a
 *    shockwave kicks everything nearby. Angular momentum is conserved, so a
 *    spinning star leaves a fast-spinning neutron star: a pulsar.
 *  - Stars pushed past `novaMu` by mergers collapse at once.
 *  - White dwarfs pushed past the Chandrasekhar limit explode completely
 *    (type Ia); with no room for debris they collapse to a neutron star.
 *  - Pulsars spin down over time and fade into ordinary neutron stars.
 *
 * Mass is conserved throughout: ejecta that cannot get a body slot falls
 * back onto the remnant.
 */

import {EventKind, type Body} from '../types';
import {isAnchored, radiusFor, refreshBody, softFor} from './bodies';
import {limitSpin} from './collide';
import {eject} from './debris';
import type {System, World} from './world';

/** Typical neutron-star birth kick, world units per second. */
const NATAL_KICK = 160;
/** Ejecta are this many times less dense than the star they came from. */
const GAS_EXPANSION = 3;

/** Burns star fuel and resolves stellar deaths. */
export class StellarEvolution implements System {
  readonly name = 'stellar-evolution';

  run(world: World, dt: number): void {
    const cfg = world.cfg.physics;
    const decay = Math.pow(0.5, dt / cfg.spinDownHalfLife);
    const dying: Body[] = [];
    for (const b of world.bodies) {
      if (b.kind === 'star') {
        b.life -= dt;
        if (b.life <= 0 || b.mu >= cfg.novaMu) dying.push(b);
      } else if (b.kind === 'white') {
        if (b.mu >= cfg.chandraMu) dying.push(b);
      } else if (b.kind === 'compact') {
        b.spin *= decay;
      }
    }
    if (dying.length === 0) return;
    const gone = new Set<Body>();
    for (const b of dying) {
      if (b.kind === 'white') {
        if (typeIa(world, b)) gone.add(b);
      } else if (b.mu < cfg.collapseMu && b.mu < cfg.novaMu) {
        nebula(world, b);
      } else {
        supernova(world, b);
      }
    }
    world.pendingFree = 0;
    if (gone.size > 0) world.bodies = world.bodies.filter(b => !gone.has(b));
  }
}

/** A light star sheds its envelope gently and leaves a white dwarf. */
export function nebula(world: World, star: Body): void {
  const cfg = world.cfg.physics;
  const {x, y, z, vx, vy, vz} = star;
  const startMu = star.mu;
  const startR = star.radius;
  const coreMu = startMu * cfg.dwarfFrac;
  collapse(star, 'white', coreMu);
  const envelope = startMu - coreMu;
  const vEsc = Math.sqrt((2 * startMu) / Math.max(startR, 1));
  const thrown = eject(world, {
    x,
    y,
    z,
    vx,
    vy,
    vz,
    mu: envelope,
    count: cfg.maxFragments,
    clearance: startR + 20,
    minSpeed: vEsc * 0.45,
    maxSpeed: vEsc * 0.7,
    kind: 'rock',
    flatten: 0.2,
    volPerMu: (startR ** 3 / startMu) * GAS_EXPANSION,
  });
  fallBack(world, star, envelope - thrown);
  world.emit(EventKind.NEBULA, x, y, z, startR * 8, Math.round(startMu / 1000));
}

/** Collapses a heavy star's core and blows off its envelope. */
export function supernova(world: World, star: Body): void {
  const cfg = world.cfg.physics;
  const {x, y, z, vx, vy, vz} = star;
  const startMu = star.mu;
  const startR = star.radius;
  const coreMu = startMu * cfg.remnantFrac;
  const envelope = startMu - coreMu;
  collapse(star, coreMu >= cfg.tovMu ? 'hole' : 'compact', coreMu);

  // Asymmetric ejection kicks the remnant; the ejecta recoil the other way,
  // so total momentum is unchanged.
  const a = world.rng.range(0, Math.PI * 2);
  const kick =
    star.kind === 'hole'
      ? NATAL_KICK * 0.2
      : NATAL_KICK * world.rng.range(0.4, 1.6);
  const recoil = (kick * coreMu) / envelope;
  const vEsc = Math.sqrt((2 * startMu) / Math.max(startR, 1));
  const thrown = eject(world, {
    x,
    y,
    z,
    vx: vx - Math.cos(a) * recoil,
    vy: vy - Math.sin(a) * recoil,
    vz,
    mu: envelope,
    count: cfg.maxFragments + 2,
    clearance: startR + 18,
    minSpeed: Math.max(vEsc * 0.6, 260),
    maxSpeed: Math.max(vEsc * 1.2, 560),
    kind: 'rock',
    flatten: 0.3,
    volPerMu: (startR ** 3 / startMu) * GAS_EXPANSION,
  });
  if (thrown > 0) {
    // The kick is balanced by the recoil of the mass actually thrown.
    const k = kick * (thrown / envelope);
    star.vx += Math.cos(a) * k;
    star.vy += Math.sin(a) * k;
  }
  fallBack(world, star, envelope - thrown);
  blast(world, star, x, y, z);
  world.emit(
    EventKind.NOVA,
    x,
    y,
    z,
    cfg.novaRadius,
    Math.round(startMu / 1000),
  );
}

/**
 * A white dwarf past the Chandrasekhar limit detonates completely. Returns
 * true when the dwarf was consumed (the caller removes it), or false when no
 * slots were free and it collapsed into a neutron star instead.
 */
export function typeIa(world: World, dwarf: Body): boolean {
  const cfg = world.cfg.physics;
  // The dwarf's own slot is available to its debris.
  world.pendingFree++;
  const vEsc = Math.sqrt((2 * dwarf.mu) / Math.max(dwarf.radius, 1));
  const thrown = eject(world, {
    x: dwarf.x,
    y: dwarf.y,
    z: dwarf.z,
    vx: dwarf.vx,
    vy: dwarf.vy,
    vz: dwarf.vz,
    mu: dwarf.mu,
    count: cfg.maxFragments + 2,
    clearance: dwarf.radius + 14,
    minSpeed: Math.min(vEsc * 0.35, 520),
    maxSpeed: Math.min(vEsc * 0.6, 760),
    kind: 'rock',
    flatten: 0.35,
    volPerMu: 0.004,
  });
  if (thrown === 0) {
    world.pendingFree--;
    collapse(dwarf, 'compact', dwarf.mu);
    limitSpin(world, dwarf);
    world.emit(EventKind.COLLAPSE, dwarf.x, dwarf.y, dwarf.z, dwarf.mu);
    return false;
  }
  blast(world, dwarf, dwarf.x, dwarf.y, dwarf.z);
  world.emit(
    EventKind.TYPE_IA,
    dwarf.x,
    dwarf.y,
    dwarf.z,
    cfg.novaRadius,
    Math.round(dwarf.mu / 1000),
  );
  return true;
}

/** Turns `b` into a degenerate remnant of mass `mu`, keeping id and spin. */
function collapse(b: Body, kind: Body['kind'], mu: number): void {
  b.mu = mu;
  b.kind = kind;
  b.life = Infinity;
  b.radius = radiusFor(kind, mu);
  b.soft = softFor(kind, b.radius);
}

/** Ejecta with no free slot falls back onto the remnant. */
function fallBack(world: World, remnant: Body, mu: number): void {
  if (mu > 0) {
    remnant.mu += mu;
    const before = refreshBody(remnant, world.cfg.physics);
    if (before !== 'hole' && remnant.kind === 'hole') {
      world.emit(
        EventKind.COLLAPSE,
        remnant.x,
        remnant.y,
        remnant.z,
        remnant.mu,
      );
    }
  }
  limitSpin(world, remnant);
}

/** Pushes bodies and satellites away from (x, y, z). */
function blast(
  world: World,
  source: Body,
  x: number,
  y: number,
  z: number,
): void {
  const cfg = world.cfg.physics;
  const radius = cfg.novaRadius;
  const kick = cfg.novaKick;
  const refMu = cfg.planetMu * 12;
  const push = (
    o: {x: number; y: number; z: number; vx: number; vy: number; vz: number},
    scale: number,
  ) => {
    const dx = o.x - x;
    const dy = o.y - y;
    const dz = o.z - z;
    const d = Math.hypot(dx, dy, dz);
    if (d >= radius || d < 1e-6) return;
    const fall = 1 - d / radius;
    const dv = (kick * fall * fall * scale) / d;
    o.vx += dx * dv;
    o.vy += dy * dv;
    o.vz += dz * dv * 0.5;
  };
  for (const b of world.bodies) {
    if (b === source || isAnchored(b)) continue;
    push(b, Math.min(1, refMu / Math.max(b.mu, 1)));
  }
  for (const s of world.sats) push(s, 1);
}
