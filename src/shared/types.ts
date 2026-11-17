/**
 * @fileoverview Core data shapes shared by the simulation, protocol and UI.
 */

/**
 * Kinds of gravitating body. Order is the wire code; append only.
 * `compact` is a neutron star, `white` a white dwarf. Finer classes (red
 * dwarf, pulsar, gas giant...) are derived from mass, radius and spin; see
 * `sim/classes.ts`.
 */
export const BODY_KINDS = [
  'star',
  'planet',
  'rock',
  'compact',
  'hole',
  'white',
] as const;

/** A kind of gravitating body. */
export type BodyKind = (typeof BODY_KINDS)[number];

/** A gravitating body. Units: world units, seconds, mu = G * M. */
export interface Body {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Acceleration from the last force evaluation (not sent on the wire). */
  ax: number;
  ay: number;
  az: number;
  /** Gravitational parameter G * M. */
  mu: number;
  /** Collision radius. */
  radius: number;
  /** Gravitational softening length. */
  soft: number;
  /**
   * Spin angular momentum Jz in mu units (G * J). Collisions add their
   * orbital angular momentum; it drives frame dragging and pulsar status.
   */
  spin: number;
  /** Seconds of fuel left for stars; Infinity for everything else. */
  life: number;
  /** Anchored bodies pull and absorb but never move (e.g. a galactic core). */
  fixed: boolean;
}

/** A satellite: a massless test particle owned by a player. */
export interface Sat {
  id: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since launch. */
  age: number;
}

/** A connected player as the simulation sees it. */
export interface Player {
  id: number;
  name: string;
  /** Index into `PLAYER_COLORS`. */
  color: number;
  /** Id of the planet the player launches from; 0 when none is available. */
  home: number;
  /** World time when the next launch is allowed. */
  launchAt: number;
  /** World time when the next spawn is allowed. */
  spawnAt: number;
}

/** Kinds of world event. Values are wire codes; append only. */
export enum EventKind {
  MERGE = 0,
  SHATTER = 1,
  NOVA = 2,
  CRASH = 3,
  /** Unused since the universe became closed; kept for wire compatibility. */
  ESCAPE = 4,
  LAUNCH = 5,
  SPAWN = 6,
  IGNITE = 7,
  COLLAPSE = 8,
  /** A light star shed its envelope and left a white dwarf. */
  NEBULA = 9,
  /** A white dwarf passed the Chandrasekhar limit and blew apart. */
  TYPE_IA = 10,
  /** Two neutron stars merged and threw out neutron-rich debris. */
  KILONOVA = 11,
  /** A body spun past breakup and flung off fragments. */
  FISSION = 12,
}

/** Something notable that happened during a step, for effects and sound. */
export interface WorldEvent {
  kind: EventKind;
  x: number;
  y: number;
  z: number;
  /** Magnitude: mass for merges and novas, radius for shockwaves. */
  size: number;
  /** Event-specific id: player id for launches and crashes, else 0. */
  ref: number;
}

/** Bodies players may spawn. Order is the wire code; append only. */
export const SPAWN_KINDS = [
  'planet',
  'star',
  'hole',
  'rock',
  'white',
  'compact',
] as const;

/** A kind of body players may spawn. */
export type SpawnKind = (typeof SPAWN_KINDS)[number];
