/**
 * @fileoverview Player actions as pure rules over a `World`.
 *
 * Each action validates its input against the configured limits and either
 * mutates the world or returns a `Reject` code. Networking lives elsewhere.
 */

import type {PhysicsConfig} from '../config';
import type {Body, Player, Sat, SpawnKind} from '../types';
import {EventKind, SPAWN_KINDS} from '../types';
import {MAX_RADIUS, maxSpin, radiusFor} from '../sim/bodies';
import {Reject} from '../net/protocol';
import type {World} from '../sim/world';

/** What a player may choose when placing a body of one kind. */
export interface SpawnRange {
  muMin: number;
  muMax: number;
  /** Default mass offered by the UI. */
  mu: number;
  /** Radius bounds; equal when physics fixes the size (degenerate kinds). */
  rMin: number;
  rMax: number;
  /** Multiplier on the spawn cooldown. */
  cooldown: number;
}

/** Allowed mass and radius for each spawnable kind, from the thresholds. */
export function spawnRange(kind: SpawnKind, cfg: PhysicsConfig): SpawnRange {
  const below = (v: number) => v * 0.999;
  switch (kind) {
    case 'rock':
      return {
        muMin: 1e3,
        muMax: below(cfg.planetMu),
        mu: 1e4,
        rMin: 2,
        rMax: 20,
        cooldown: 0.5,
      };
    case 'planet':
      return {
        muMin: cfg.planetMu,
        muMax: below(cfg.starMu),
        mu: 1.2e5,
        rMin: 3,
        rMax: 48,
        cooldown: 1,
      };
    case 'star':
      return {
        muMin: cfg.starMu,
        muMax: below(cfg.novaMu),
        mu: 5e6,
        rMin: 10,
        rMax: MAX_RADIUS,
        cooldown: 2.5,
      };
    case 'white':
      return fixedSize('white', 5e5, below(cfg.chandraMu), 2.4e6, 3);
    case 'compact':
      return fixedSize(
        'compact',
        cfg.chandraMu * 0.8,
        below(cfg.tovMu),
        4e6,
        3,
      );
    case 'hole':
      return fixedSize('hole', cfg.tovMu, 2e8, 1e7, 5);
  }
}

function fixedSize(
  kind: SpawnKind,
  muMin: number,
  muMax: number,
  mu: number,
  cooldown: number,
): SpawnRange {
  const r = radiusFor(kind, mu);
  return {muMin, muMax, mu, rMin: r, rMax: r, cooldown};
}

/** A player's request to place a body. */
export interface SpawnSpec {
  kind: SpawnKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mu: number;
  radius: number;
  /** Signed fraction of the body's spin limit, -1..1. */
  spin: number;
}

/** Bodies a player may launch from. */
export function isLaunchPad(b: Body): boolean {
  return b.kind === 'planet' || b.kind === 'rock';
}

function finite(...v: number[]): boolean {
  return v.every(Number.isFinite);
}

/** Launches a satellite from the player's home planet. */
export function launch(
  world: World,
  player: Player,
  angle: number,
  pitch: number,
  speed: number,
): Sat | Reject {
  if (!finite(angle, pitch, speed)) return Reject.BAD_INPUT;
  const lim = world.cfg.limits;
  if (world.time < player.launchAt) return Reject.COOLDOWN;
  const home = world.body(player.home);
  if (!home || !isLaunchPad(home)) return Reject.NO_HOME;

  let mine = 0;
  let oldest = -1;
  for (let i = 0; i < world.sats.length; i++) {
    if (world.sats[i].owner !== player.id) continue;
    mine++;
    if (oldest < 0 || world.sats[i].age > world.sats[oldest].age) oldest = i;
  }
  if (mine >= lim.maxSatsPerPlayer && oldest >= 0) {
    // Recycle the player's oldest satellite; the global count is unchanged.
    world.sats.splice(oldest, 1);
  } else if (world.sats.length >= world.satCap) {
    return Reject.SAT_CAP;
  }

  const v = Math.min(lim.maxLaunchSpeed, Math.max(lim.minLaunchSpeed, speed));
  const p = Math.max(-1.2, Math.min(1.2, pitch));
  const dx = Math.cos(angle) * Math.cos(p);
  const dy = Math.sin(angle) * Math.cos(p);
  const dz = Math.sin(p);
  const r = home.radius + 3;
  const sat: Sat = {
    id: world.newId(),
    owner: player.id,
    x: home.x + dx * r,
    y: home.y + dy * r,
    z: home.z + dz * r,
    vx: home.vx + dx * v,
    vy: home.vy + dy * v,
    vz: home.vz + dz * v,
    age: 0,
  };
  world.sats.push(sat);
  player.launchAt = world.time + lim.launchCooldown;
  world.emit(EventKind.LAUNCH, sat.x, sat.y, sat.z, v, player.id);
  return sat;
}

/**
 * Places a body with the requested mass, radius and spin, clamped to the
 * kind's range, at a clear spot and with a capped velocity.
 */
export function spawn(
  world: World,
  player: Player,
  spec: SpawnSpec,
): Body | Reject {
  const {kind, x, y} = spec;
  let {vx, vy} = spec;
  if (!finite(x, y, vx, vy, spec.mu, spec.radius, spec.spin)) {
    return Reject.BAD_INPUT;
  }
  if (!SPAWN_KINDS.includes(kind)) return Reject.BAD_INPUT;
  const cfg = world.cfg;
  const range = spawnRange(kind, cfg.physics);
  if (world.time < player.spawnAt) return Reject.COOLDOWN;
  if (world.freeBodies() <= 0) return Reject.BODY_CAP;
  const {width, height} = cfg.world;
  if (Math.abs(x) > width * 0.45 || Math.abs(y) > height * 0.45) {
    return Reject.BAD_SPOT;
  }
  const speed = Math.hypot(vx, vy);
  const maxSpeed = cfg.limits.maxLaunchSpeed * 0.6;
  if (speed > maxSpeed) {
    vx *= maxSpeed / speed;
    vy *= maxSpeed / speed;
  }
  const mu = Math.min(range.muMax, Math.max(range.muMin, spec.mu));
  const radius = Math.min(range.rMax, Math.max(range.rMin, spec.radius));
  const body = world.addBody({kind, x, y, vx, vy, mu, radius});
  if (!body) return Reject.BODY_CAP;
  for (const o of world.bodies) {
    if (o === body) continue;
    if (Math.hypot(o.x - x, o.y - y, o.z) < o.radius + body.radius + 30) {
      world.bodies.pop();
      return Reject.BAD_SPOT;
    }
  }
  const frac = Math.max(-1, Math.min(1, spec.spin));
  body.spin = frac * maxSpin(body, cfg.world.c);
  player.spawnAt = world.time + cfg.limits.spawnCooldown * range.cooldown;
  world.emit(EventKind.SPAWN, x, y, 0, mu, player.id);
  return body;
}

/**
 * Picks a home for `player`: the planet with the fewest residents (heavier
 * first), else the heaviest asteroid. Never creates a body; returns 0 when
 * there is nothing to launch from.
 */
export function pickHome(
  world: World,
  players: Iterable<Player>,
  player: Player,
): number {
  const residents = new Map<number, number>();
  for (const p of players) {
    if (p !== player && p.home) {
      residents.set(p.home, (residents.get(p.home) ?? 0) + 1);
    }
  }
  let best: Body | null = null;
  let bestScore = Infinity;
  for (const b of world.bodies) {
    if (!isLaunchPad(b)) continue;
    const tier = b.kind === 'planet' ? 0 : 1e12;
    const score = tier + (residents.get(b.id) ?? 0) * 1e9 - b.mu;
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best ? best.id : 0;
}
