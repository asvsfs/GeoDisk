/**
 * @fileoverview Body construction, kinds and size rules.
 *
 * Radius is state. Ordinary matter (asteroids, planets, stars) keeps the
 * radius it was given; merging conserves volume and fragments inherit their
 * parent's density. Degenerate objects are sized by physics alone: white
 * dwarfs shrink as they gain mass, neutron stars are tiny, and a black
 * hole's horizon grows linearly with mass.
 */

import type {PhysicsConfig} from '../config';
import type {Body, BodyKind, Orbit} from '../types';

/** Rank used when two bodies merge: the denser kind wins. */
const KIND_RANK: Record<BodyKind, number> = {
  rock: 0,
  planet: 1,
  star: 2,
  white: 3,
  compact: 4,
  hole: 5,
};

/** Default size for ordinary matter: radius = k * cbrt(mu). */
const RADIUS_K: Record<'rock' | 'planet' | 'star', number> = {
  rock: 0.11,
  planet: 0.13,
  star: 0.17,
};

export const MIN_RADIUS = 2;
export const MAX_RADIUS = 96;
/** Largest black hole horizon (holes past about 1e8 mu stop growing). */
export const MAX_HOLE_RADIUS = 240;
/** White dwarf radius at mu = 2e6; scales as mu^(-1/3). */
const DWARF_R = 6;
/** Neutron star radius (roughly constant with mass). */
const NEUTRON_R = 3.5;
/**
 * Horizon radius per unit mu: the Schwarzschild radius 2 mu / c^2 at c = 900.
 * (It used to be a tenth of that. Holes that dense flung anything passing
 * close out at several times c.)
 */
const HOLE_K = 2 / (900 * 900);

/** True for objects whose size is fixed by degeneracy or the horizon. */
export function isDegenerate(kind: BodyKind): boolean {
  return kind === 'white' || kind === 'compact' || kind === 'hole';
}

/** Default (or, for degenerate kinds, the only) radius for `kind` at `mu`. */
export function radiusFor(kind: BodyKind, mu: number): number {
  const m = Math.max(mu, 1);
  let r: number;
  switch (kind) {
    case 'white':
      r = DWARF_R * Math.cbrt(2e6 / m);
      break;
    case 'compact':
      r = NEUTRON_R;
      break;
    case 'hole':
      return Math.min(MAX_HOLE_RADIUS, Math.max(MIN_RADIUS, HOLE_K * m));
    default:
      r = RADIUS_K[kind] * Math.cbrt(m);
  }
  return clampRadius(r);
}

/** Clamps a radius to the renderable range. */
export function clampRadius(r: number): number {
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r));
}

/** True for bodies that never move freely or disappear (anchored or permanent). */
export function isAnchored(b: Pick<Body, 'fixed' | 'permanent'>): boolean {
  return b.fixed || b.permanent;
}

/** Gravitational softening for a body of `kind` with collision radius `r`. */
export function softFor(kind: BodyKind, r: number): number {
  return isDegenerate(kind) ? r + 3 : r * 0.7 + 2;
}

/** Star burn time in seconds: heavier stars burn out faster (t ~ M^-2.5). */
export function starLifeFor(mu: number, cfg: PhysicsConfig): number {
  const life = cfg.starLife * Math.pow(6e6 / Math.max(mu, 1), 2.5);
  return Math.min(1800, Math.max(20, life));
}

/**
 * Spin at which the equator orbits at Keplerian speed (uniform sphere):
 * J = 0.4 mu r^2 * sqrt(mu / r^3) = 0.4 mu sqrt(mu r).
 */
export function breakupSpin(mu: number, r: number): number {
  return 0.4 * mu * Math.sqrt(Math.max(mu, 1) * Math.max(r, 1));
}

/** Kerr limit for a black hole: J = G M^2 / c, i.e. mu^2 / c in mu units. */
export function kerrSpin(mu: number, c: number): number {
  return (mu * mu) / c;
}

/** Largest spin a body of this kind can hold. */
export function maxSpin(
  b: Pick<Body, 'kind' | 'mu' | 'radius'>,
  c: number,
): number {
  return b.kind === 'hole' ? kerrSpin(b.mu, c) : breakupSpin(b.mu, b.radius);
}

/**
 * Applies mass thresholds to ordinary matter: asteroids grow into planets
 * and planets ignite into stars. Stars and white dwarfs keep their kind here;
 * their deaths are handled by stellar evolution. Neutron stars collapse into
 * black holes past the TOV limit.
 */
export function kindFor(
  kind: BodyKind,
  mu: number,
  cfg: PhysicsConfig,
): BodyKind {
  switch (kind) {
    case 'hole':
    case 'white':
    case 'star':
      return kind;
    case 'compact':
      return mu >= cfg.tovMu ? 'hole' : 'compact';
    default:
      if (mu >= cfg.starMu) return 'star';
      if (mu >= cfg.planetMu) return 'planet';
      return 'rock';
  }
}

/**
 * The kind that results when a lighter body of kind `small` merges into a
 * heavier one of kind `big`:
 *  - anything falling into a black hole becomes part of the hole;
 *  - a star engulfs a lighter white dwarf or neutron star;
 *  - a dead star heavier than its partner accretes it (neutron stars win
 *    over white dwarfs);
 *  - otherwise ordinary matter ranks star > planet > asteroid.
 */
export function mergedKind(big: BodyKind, small: BodyKind): BodyKind {
  if (big === 'hole' || small === 'hole') return 'hole';
  if (isDegenerate(big)) return small === 'compact' ? 'compact' : big;
  if (isDegenerate(small)) return big === 'star' ? 'star' : small;
  return KIND_RANK[big] >= KIND_RANK[small] ? big : small;
}

/** True for kinds that swallow anything they touch without shattering. */
export function isDense(kind: BodyKind): boolean {
  return kind === 'star' || isDegenerate(kind);
}

/** Fields needed to create a body; the rest are derived. */
export interface BodyInit {
  kind: BodyKind;
  x: number;
  y: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  mu: number;
  /** Ignored for degenerate kinds. */
  radius?: number;
  spin?: number;
  life?: number;
  fixed?: boolean;
  permanent?: boolean;
  orbit?: Orbit;
}

/** Builds a body with derived kind, softening and life. */
export function makeBody(id: number, init: BodyInit, cfg: PhysicsConfig): Body {
  const kind = kindFor(init.kind, init.mu, cfg);
  const ignited = kind === 'star' && init.kind !== 'star';
  const radius =
    isDegenerate(kind) || ignited || init.radius === undefined
      ? radiusFor(kind, init.mu)
      : clampRadius(init.radius);
  return {
    id,
    kind,
    x: init.x,
    y: init.y,
    z: init.z ?? 0,
    vx: init.vx ?? 0,
    vy: init.vy ?? 0,
    vz: init.vz ?? 0,
    ax: 0,
    ay: 0,
    az: 0,
    mu: init.mu,
    radius,
    soft: softFor(kind, radius),
    spin: init.spin ?? 0,
    life: init.life ?? (kind === 'star' ? starLifeFor(init.mu, cfg) : Infinity),
    fixed: init.fixed ?? false,
    permanent: init.permanent ?? false,
    ...(init.orbit ? {orbit: init.orbit} : {}),
  };
}

/**
 * Re-applies kind thresholds after `b.mu` changed and resizes the body when
 * its kind demands it. Returns the previous kind so callers can raise
 * ignition or collapse events.
 */
export function refreshBody(b: Body, cfg: PhysicsConfig): BodyKind {
  const before = b.kind;
  if (b.permanent) return before;
  b.kind = kindFor(b.kind, b.mu, cfg);
  if (isDegenerate(b.kind) || (b.kind === 'star' && before !== 'star')) {
    b.radius = radiusFor(b.kind, b.mu);
  }
  b.soft = softFor(b.kind, b.radius);
  if (b.kind === 'star' && before !== 'star') b.life = starLifeFor(b.mu, cfg);
  else if (b.kind !== 'star') b.life = Infinity;
  return before;
}
