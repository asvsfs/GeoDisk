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
  /** 3D spatial z-coordinate in world units (0 = equatorial shadow plane) */
  z?: number;
  /** Velocity in world units / s when N-body dynamics are active */
  vx?: number;
  vy?: number;
  vz?: number;
  /** If true, this body exerts gravity but does not move */
  pinned?: boolean;
  /** 3D gravitational parameter G * M in world^3 / s^2 units */
  mu: number;
  /** Core softening radius in world units */
  softening: number;
  /** Physical / event-horizon collision radius */
  radius: number;
  /** 3D axial spin parameter Jz (creates 3D Lense-Thirring gravitomagnetic dipole B) */
  spin: number;
  kind: MassKind;
  /** Optional kinematic orbital motion around anchor */
  orbit?: {
    centerX: number;
    centerY: number;
    centerZ?: number;
    orbitRadius: number;
    angularSpeed: number;
    phase: number;
    zAmplitude?: number;
  };
}

export interface UniformGridConfig {
  cols: number;
  rows: number;
  layers: number;
  worldWidth: number;
  worldHeight: number;
  worldDepth: number;
  /** Effective speed of light c in world units / s */
  speedOfLight: number;
}

export interface UniverseConfig {
  universeWidth: number;
  universeHeight: number;
  universeDepth: number;
  /** Field strength |g| below which an offscreen outward object is considered escaped */
  escapeFieldThreshold: number;
  /** Minimum distance from barycenter (outside screen) before field-escape destruction applies */
  minEscapeRadius: number;
}

/**
 * Sampled 3D gravity field values at a continuous (x, y, z) world point,
 * trilinearly interpolated from the 3D uniform grid.
 */
export interface GravityFieldSample {
  /** Summed 3D gravitational potential Phi(x, y, z) <= 0 */
  phi: number;
  /** Summed 3D gravitational field components (-grad Phi) */
  gx: number;
  gy: number;
  gz: number;
  /** Summed 3D gravitomagnetic Lense-Thirring frame-dragging field B(x, y, z) */
  bx: number;
  by: number;
  bz: number;
  /** Gravitational time dilation lapse alpha = sqrt(max(alphaMin^2, 1 + 2*phi/c^2)) */
  lapse: number;
}

/**
 * Interface that any 3D Gravity Field solver (WebGPU compute or CPU grid)
 * exposes to the Rocket Physics module.
 */
export interface GravityFieldSampler {
  readonly config: UniformGridConfig;
  /** Sample the 3D uniform grid at world position (x, y, z) */
  sampleAt(x: number, y: number, z?: number): GravityFieldSample;
}

export interface GravityGridSolver extends GravityFieldSampler {
  /** Raw packed Float32Array [phi, gx, gy, gz, bx, by, bz, 0] per 3D cell */
  readonly buffer: Float32Array;
  /** Recompute every cell of the 3D uniform grid as the sum over all masses */
  computeGrid(masses: readonly MassBody[]): void;
}

export interface RocketState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Orientation angle in radians (projected steering plane) */
  angle: number;
  /** Remaining propellant mass in kg-equivalent units */
  fuel: number;
  maxFuel: number;
  /** Dry hull mass */
  dryMass: number;
  /** Coordinate elapsed time t (seconds) */
  coordTime: number;
  /** Rocket proper elapsed time tau (seconds, dilated by gravity & 3D speed) */
  properTime: number;
  /** Last sampled gravitational lapse factor (0..1) */
  lastLapse: number;
  /** Peak 3D coordinate speed reached during flight */
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
 * Completely independent of how the 3D gravity grid is computed or shadow-rendered.
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
  z: number;
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
