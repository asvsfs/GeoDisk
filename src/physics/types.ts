/**
 * Core interfaces and data contracts for the decoupled Gravity Field
 * and Rocket Physics modules.
 */

export type MassKind = 'star' | 'compact' | 'singularity' | 'asteroid';

export interface MassBody {
  id: string;
  label?: string;
  x: number;
  y: number;
  /** Velocity in world units / s when N-body dynamics are active */
  vx?: number;
  vy?: number;
  /** If true, this body exerts gravity but does not move */
  pinned?: boolean;
  /** Gravitational strength G2 * M in world^2 / s^2 units */
  mu: number;
  /** Core softening radius in world units */
  softening: number;
  /** Physical / event-horizon collision radius */
  radius: number;
  /** 2+1D spin parameter J (creates gravitomagnetic frame-dragging Bz) */
  spin: number;
  kind: MassKind;
  /** Optional kinematic orbital motion around anchor */
  orbit?: {
    centerX: number;
    centerY: number;
    orbitRadius: number;
    angularSpeed: number;
    phase: number;
  };
}

export interface UniformGridConfig {
  cols: number;
  rows: number;
  worldWidth: number;
  worldHeight: number;
  /** Reference outer radius for 2D logarithmic potential normalization */
  potentialRefRadius: number;
  /** Effective speed of light c in world units / s */
  speedOfLight: number;
}

export interface UniverseConfig {
  universeWidth: number;
  universeHeight: number;
  /** Field strength |g| below which an offscreen outward object is considered escaped */
  escapeFieldThreshold: number;
  /** Minimum distance from barycenter (outside screen) before field-escape destruction applies */
  minEscapeRadius: number;
}

/**
 * Sampled gravity field values at a continuous (x, y) world point,
 * bilinearly interpolated from the uniform grid.
 */
export interface GravityFieldSample {
  /** Summed 2D gravitational potential Phi(x, y) <= 0 */
  phi: number;
  /** Summed 2D gravitational field x-component (-dPhi/dx) */
  gx: number;
  /** Summed 2D gravitational field y-component (-dPhi/dy) */
  gy: number;
  /** Summed 2+1D gravitomagnetic frame-dragging curl Bz(x, y) */
  bz: number;
  /** Gravitational time dilation lapse alpha = sqrt(max(alphaMin^2, 1 + 2*phi/c^2)) */
  lapse: number;
}

/**
 * Interface that any Gravity Field solver (WebGPU compute or CPU grid)
 * exposes to the Rocket Physics module.
 */
export interface GravityFieldSampler {
  readonly config: UniformGridConfig;
  /** Sample the uniform grid at world position (x, y) */
  sampleAt(x: number, y: number): GravityFieldSample;
}

export interface GravityGridSolver extends GravityFieldSampler {
  /** Raw packed Float32Array [phi, gx, gy, bz] per cell (length = cols * rows * 4) */
  readonly buffer: Float32Array;
  /** Recompute every cell of the uniform grid as the sum over all masses */
  computeGrid(masses: readonly MassBody[]): void;
}

export interface RocketState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Orientation angle in radians */
  angle: number;
  /** Remaining propellant mass in kg-equivalent units */
  fuel: number;
  maxFuel: number;
  /** Dry hull mass */
  dryMass: number;
  /** Coordinate elapsed time t (seconds) */
  coordTime: number;
  /** Rocket proper elapsed time tau (seconds, dilated by gravity & speed) */
  properTime: number;
  /** Last sampled gravitational lapse factor (0..1) */
  lastLapse: number;
  /** Peak coordinate speed reached during flight */
  peakSpeed: number;
  /** Minimum gravitational lapse encountered */
  minLapse: number;
  /** Currently firing main thruster */
  thrusting: boolean;
}

export interface RocketInput {
  /** Forward main thruster [-1..1], negative = retro brake */
  throttle: number;
  /** Attitude turn [-1..1], -1 = counter-clockwise, +1 = clockwise */
  turn: number;
}

export interface RocketConfig {
  /** Maximum thrust force in world-mass * world / s^2 */
  thrustPower: number;
  /** Angular rotation rate in rad / s */
  turnRate: number;
  /** Propellant burn rate per second at full throttle */
  fuelBurnRate: number;
  /** Hull collision radius */
  hullRadius: number;
}

/**
 * Replaceable Rocket Physics module contract.
 * Completely independent of how the gravity grid is computed or rendered.
 */
export interface RocketPhysicsModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  step(
    state: RocketState,
    input: RocketInput,
    field: GravityFieldSampler,
    dt: number,
    config: RocketConfig
  ): RocketState;
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  lapse: number;
  speed: number;
}

export type GameState = 'title' | 'playing' | 'paused' | 'gameover';
export type FlightPhase = 'aiming' | 'flying' | 'victory' | 'crashed';
export type FieldViewMode = 'spacetime' | 'contours' | 'vectors';

export interface TargetBeacon {
  x: number;
  y: number;
  radius: number;
  /** Optional max capture speed (0 = any speed on contact) */
  maxCaptureSpeed: number;
}

export interface WaypointBeacon {
  id: string;
  x: number;
  y: number;
  radius: number;
  collected: boolean;
}

export interface MissionConfig {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  isSandbox?: boolean;
  nBodyDefault?: boolean;
  speedOfLight: number;
  launchPos: { x: number; y: number };
  defaultAimAngle: number;
  defaultLaunchSpeed: number;
  maxLaunchSpeed: number;
  rocketFuel: number;
  target: TargetBeacon;
  waypoints: Array<{ id: string; x: number; y: number; radius: number }>;
  masses: MassBody[];
}

export interface RunSnapshot {
  outcome: 'victory' | 'defeat';
  reason: string;
  missionTitle: string;
  coordTime: number;
  properTime: number;
  timeDilationSaved: number;
  peakSpeed: number;
  minLapse: number;
  fuelRemainingPct: number;
  waypointsCollected: number;
  waypointsTotal: number;
  physicsModelName: string;
}
