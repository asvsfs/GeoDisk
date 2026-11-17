/**
 * @fileoverview Tunable game configuration shared by server and client.
 *
 * Every limit that bounds computation lives here so a host can size the
 * world to its hardware. The server sends the active limits to each client in
 * the welcome message, so clients never hard-code them.
 */

/** Hard caps that bound per-tick simulation cost. */
export interface Limits {
  /** Maximum gravitating bodies alive at once (planets, stars, debris...). */
  maxBodies: number;
  /** Maximum satellites alive at once across all players. */
  maxSats: number;
  /** Satellites one player may own; launching past this recycles the oldest. */
  maxSatsPerPlayer: number;
  /** Maximum connected players per room. */
  maxPlayers: number;
  /** Seconds between launches for one player. */
  launchCooldown: number;
  /** Seconds between body spawns for one player. */
  spawnCooldown: number;
  /** Launch speed bounds in world units per second. */
  minLaunchSpeed: number;
  maxLaunchSpeed: number;
  /**
   * Share of one CPU core (0..1) the room may keep busy with physics plus
   * networking. Above it the room first lowers the snapshot rate, then
   * shrinks the effective body and satellite caps.
   */
  cpuShare: number;
  /** Lowest snapshot rate the room may fall back to under load. */
  minSnapHz: number;
  /** Upstream bandwidth budget in megabits per second; 0 means unlimited. */
  maxUploadMbps: number;
}

/** World geometry and physical constants. */
export interface WorldConfig {
  /**
   * Universe bounds. Anything past them that gravity cannot bring back
   * (see `escapeLimit`) leaves the universe.
   */
  width: number;
  height: number;
  depth: number;
  /** Effective speed of light in world units per second. */
  c: number;
  /** Fixed simulation step in seconds. */
  dt: number;
  /** Snapshots per second sent to clients (the maximum; load may lower it). */
  snapHz: number;
}

/** Thresholds that drive collisions, stellar evolution and debris. */
export interface PhysicsConfig {
  /** Collisions below this impact/escape speed ratio merge. */
  mergeRatio: number;
  /** Collisions at or above this ratio eject the maximum fraction. */
  shatterRatio: number;
  /** Most fragments a single shatter may create (also bounded by free slots). */
  maxFragments: number;
  /**
   * Mass thresholds, in world units of mu = G * M. They keep the ordering of
   * the astrophysical limits they are named after, scaled to game masses.
   */
  /** Below this a body is an asteroid; above, a planet. */
  planetMu: number;
  /** Hydrogen-burning limit: planets this heavy ignite into stars. */
  starMu: number;
  /** Planets above this fraction of `starMu` are brown dwarfs. */
  brownDwarfFrac: number;
  /** Star class boundaries: red dwarf | yellow dwarf | blue giant | supergiant. */
  yellowMu: number;
  blueMu: number;
  superMu: number;
  /** Stars at least this heavy die in core collapse; lighter ones shed a nebula. */
  collapseMu: number;
  /** Stars this heavy are unstable and collapse at once. */
  novaMu: number;
  /** Chandrasekhar limit: white dwarfs above it explode (type Ia). */
  chandraMu: number;
  /** Tolman-Oppenheimer-Volkoff limit: neutron stars above it become black holes. */
  tovMu: number;
  /** Black hole class boundaries: stellar | intermediate | supermassive. */
  midHoleMu: number;
  bigHoleMu: number;
  /** Fraction of a light star's mass kept by its white dwarf. */
  dwarfFrac: number;
  /** Fraction of a massive star's mass kept by its collapsed core. */
  remnantFrac: number;
  /** Fraction of the merged mass a neutron star merger throws out (kilonova). */
  kilonovaFrac: number;
  /** Supernova shockwave radius in world units. */
  novaRadius: number;
  /** Peak velocity kick at the centre of a supernova shockwave. */
  novaKick: number;
  /** Lifetime in seconds of a reference-mass (6e6) star. */
  starLife: number;
  /** Seconds for a pulsar's spin to halve (magnetic braking). */
  spinDownHalfLife: number;
  /** Spin above this fraction of breakup makes a neutron star a pulsar. */
  pulsarSpin: number;
  /** Bodies spun past breakup by this factor fling off fragments. */
  fissionSpin: number;
  /** Planets with mu / r^3 below this are gas giants; above, rocky. */
  gasDensity: number;
  /** Bodies faster than this (world units / s) are tagged runaway. */
  runawaySpeed: number;
  /**
   * Bound objects may swing past the bounds and fall back; past this
   * multiple of the half-size they are removed anyway.
   */
  escapeLimit: number;
  /** Barnes-Hut opening angle; lower is more accurate, higher is faster. */
  theta: number;
  /** Body count above which the tree solver replaces direct summation. */
  treeThreshold: number;
}

/** Complete configuration of one room. */
export interface GameConfig {
  limits: Limits;
  world: WorldConfig;
  physics: PhysicsConfig;
}

/** Default configuration tuned for a laptop-class host. */
export const DEFAULT_CONFIG: GameConfig = {
  limits: {
    maxBodies: 96,
    maxSats: 384,
    maxSatsPerPlayer: 24,
    maxPlayers: 16,
    launchCooldown: 0.35,
    spawnCooldown: 4,
    minLaunchSpeed: 40,
    maxLaunchSpeed: 360,
    cpuShare: 0.5,
    minSnapHz: 15,
    maxUploadMbps: 0,
  },
  world: {
    width: 12000,
    height: 9000,
    depth: 3000,
    c: 900,
    dt: 1 / 60,
    snapHz: 30,
  },
  physics: {
    mergeRatio: 1.2,
    shatterRatio: 3.2,
    maxFragments: 8,
    planetMu: 4e4,
    starMu: 3.2e6,
    brownDwarfFrac: 0.45,
    yellowMu: 4.5e6,
    blueMu: 7.5e6,
    superMu: 1.3e7,
    collapseMu: 7.5e6,
    novaMu: 2.2e7,
    chandraMu: 3.2e6,
    tovMu: 5.5e6,
    midHoleMu: 2e7,
    bigHoleMu: 1e8,
    dwarfFrac: 0.45,
    remnantFrac: 0.38,
    kilonovaFrac: 0.03,
    novaRadius: 950,
    novaKick: 420,
    starLife: 420,
    spinDownHalfLife: 240,
    pulsarSpin: 0.05,
    fissionSpin: 1.5,
    gasDensity: 150,
    runawaySpeed: 480,
    escapeLimit: 1.6,
    theta: 0.6,
    treeThreshold: 64,
  },
};

/** Field-grid geometry used by the spacetime renderer (client only). */
export const RENDER_GRID = {
  cols: 80,
  rows: 50,
  layers: 13,
  worldWidth: 1600,
  worldHeight: 1000,
  worldDepth: 600,
} as const;

/** Player colour palette; a player's `color` indexes into it. */
export const PLAYER_COLORS: readonly string[] = [
  '#22D3EE',
  '#F472B6',
  '#A3E635',
  '#FBBF24',
  '#A78BFA',
  '#FB7185',
  '#34D399',
  '#60A5FA',
  '#F97316',
  '#E879F9',
  '#2DD4BF',
  '#FACC15',
  '#C084FC',
  '#4ADE80',
  '#F87171',
  '#38BDF8',
];

/**
 * Returns a copy of `base` with any provided overrides applied per section.
 */
export function mergeConfig(
  base: GameConfig,
  patch: {[K in keyof GameConfig]?: Partial<GameConfig[K]>},
): GameConfig {
  return {
    limits: {...base.limits, ...patch.limits},
    world: {...base.world, ...patch.world},
    physics: {...base.physics, ...patch.physics},
  };
}
