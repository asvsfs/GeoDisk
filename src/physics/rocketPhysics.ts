import type {
  GravityFieldSampler,
  MassBody,
  RocketConfig,
  RocketInput,
  RocketPhysicsModel,
  RocketState,
  TrajectoryPoint,
} from './types';

export const DEFAULT_ROCKET_CONFIG: RocketConfig = {
  thrustPower: 420,
  turnRate: 3.4,
  fuelBurnRate: 22,
  hullRadius: 9,
};

export function createInitialRocketState(
  x: number,
  y: number,
  angle: number,
  maxFuel: number,
  initialSpeed = 0,
  z = 0,
  vz = 0
): RocketState {
  return {
    x,
    y,
    z,
    vx: Math.cos(angle) * initialSpeed,
    vy: Math.sin(angle) * initialSpeed,
    vz,
    angle,
    fuel: maxFuel,
    maxFuel,
    dryMass: 1.0,
    coordTime: 0,
    properTime: 0,
    lastLapse: 1.0,
    peakSpeed: Math.hypot(initialSpeed, vz),
    minLapse: 1.0,
    thrusting: false,
  };
}

/**
 * Primary Rocket Physics Module:
 * Full 3D (3+1D) 1PN General Relativity Geodesic in isotropic coordinates:
 *   a_grav = (alpha^4 + beta^2) * g - (4 / c^2) * (v . g) * v + v x B_g
 *   where alpha^2 = max(0.08, 1 + 2*Phi/c^2), alpha^4 ≈ 1 + 4*Phi/c^2,
 *   g = -grad(Phi), B_g = 3D Lense-Thirring gravitomagnetic dipole field.
 *
 * Completely decoupled from mass computation and 2D shadow rendering — can be swapped
 * or replaced with any implementation satisfying `RocketPhysicsModel`.
 */
export class Relativistic3DRocketPhysics implements RocketPhysicsModel {
  public readonly id = 'gr-3d';
  public readonly name = '3D Relativistic Geodesic';
  public readonly description =
    '3+1D 1PN isotropic geodesic curvature, light-deflection coupling, 3D Lense-Thirring frame-dragging, and proper-time dilation.';

  private computeAcceleration(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    thrustAx: number,
    thrustAy: number,
    thrustAz: number,
    field: GravityFieldSampler
  ): { ax: number; ay: number; az: number; lapse: number } {
    const sample = field.sampleAt(x, y, z);
    const c = field.config.speedOfLight;
    const invC2 = 1.0 / (c * c);

    const v2 = vx * vx + vy * vy + vz * vz;
    const beta2 = Math.min(0.88, v2 * invC2);

    // Gravitational lapse alpha^2 = max(0.08, 1 + 2*Phi/c^2)
    // alpha^4 matches exact 1PN (1 + 4*Phi/c^2) in weak field while staying strictly attractive in deep wells.
    const lapseSq = Math.max(0.08, 1.0 + 2.0 * sample.phi * invC2);
    const vDotG = vx * sample.gx + vy * sample.gy + vz * sample.gz;

    // 3D 1PN relativistic geodesic acceleration:
    //   a_grav = (alpha^4 + beta^2) * g - (4 / c^2) * (v . g) * v + v x B_g
    const gravScale = lapseSq * lapseSq + beta2;
    const parallelDrag = 4.0 * vDotG * invC2;

    // 3D gravitomagnetic Lense-Thirring cross product: v x B_g
    const frameDragX = vy * sample.bz - vz * sample.by;
    const frameDragY = vz * sample.bx - vx * sample.bz;
    const frameDragZ = vx * sample.by - vy * sample.bx;

    const gravAx = sample.gx * gravScale - vx * parallelDrag + frameDragX;
    const gravAy = sample.gy * gravScale - vy * parallelDrag + frameDragY;
    const gravAz = sample.gz * gravScale - vz * parallelDrag + frameDragZ;

    // Coordinate thrust scaled by gravitational lapse
    const lapse = Math.sqrt(lapseSq);
    const ax = gravAx + thrustAx * lapse;
    const ay = gravAy + thrustAy * lapse;
    const az = gravAz + thrustAz * lapse;

    return { ax, ay, az, lapse };
  }

  public step(
    state: RocketState,
    input: RocketInput,
    field: GravityFieldSampler,
    dt: number,
    config: RocketConfig
  ): RocketState {
    if (dt <= 0) return state;

    const clampedDt = Math.min(dt, 0.05);
    const angle = state.angle + input.turn * config.turnRate * clampedDt;

    const throttle = Math.max(-0.6, Math.min(1, input.throttle));
    const hasFuel = state.fuel > 0 && Math.abs(throttle) > 0.01;
    const fuelUsed = hasFuel ? Math.min(state.fuel, Math.abs(throttle) * config.fuelBurnRate * clampedDt) : 0;
    const nextFuel = Math.max(0, state.fuel - fuelUsed);
    const totalMass = state.dryMass + nextFuel / Math.max(1, state.maxFuel);
    const thrustMag = hasFuel ? (throttle * config.thrustPower) / totalMass : 0;

    const thrustAx = Math.cos(angle) * thrustMag;
    const thrustAy = Math.sin(angle) * thrustMag;
    const thrustAz = 0;

    // 2nd-order Runge-Kutta (Midpoint) 3D integration
    const k1 = this.computeAcceleration(
      state.x,
      state.y,
      state.z,
      state.vx,
      state.vy,
      state.vz,
      thrustAx,
      thrustAy,
      thrustAz,
      field
    );

    const halfDt = clampedDt * 0.5;
    const midX = state.x + state.vx * halfDt;
    const midY = state.y + state.vy * halfDt;
    const midZ = state.z + state.vz * halfDt;
    const midVx = state.vx + k1.ax * halfDt;
    const midVy = state.vy + k1.ay * halfDt;
    const midVz = state.vz + k1.az * halfDt;

    const k2 = this.computeAcceleration(
      midX,
      midY,
      midZ,
      midVx,
      midVy,
      midVz,
      thrustAx,
      thrustAy,
      thrustAz,
      field
    );

    let nextVx = state.vx + k2.ax * clampedDt;
    let nextVy = state.vy + k2.ay * clampedDt;
    let nextVz = state.vz + k2.az * clampedDt;

    // Relativistic speed limit strictly below c (0.95c)
    const c = field.config.speedOfLight;
    const maxSpeed = c * 0.95;
    const speedSq = nextVx * nextVx + nextVy * nextVy + nextVz * nextVz;
    let speed = Math.sqrt(speedSq);
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      nextVx *= scale;
      nextVy *= scale;
      nextVz *= scale;
      speed = maxSpeed;
    }

    const nextX = state.x + ((state.vx + nextVx) * 0.5) * clampedDt;
    const nextY = state.y + ((state.vy + nextVy) * 0.5) * clampedDt;
    const nextZ = state.z + ((state.vz + nextVz) * 0.5) * clampedDt;

    // Proper time interval dTau = dt * sqrt(max(0.05, 1 + 2*Phi/c^2 - |v|^2/c^2))
    const endSample = field.sampleAt(nextX, nextY, nextZ);
    const invC2 = 1.0 / (c * c);
    const metricInterval = Math.max(0.05, 1.0 + 2.0 * endSample.phi * invC2 - (speed * speed) * invC2);
    const dTau = clampedDt * Math.sqrt(metricInterval);

    return {
      x: nextX,
      y: nextY,
      z: nextZ,
      vx: nextVx,
      vy: nextVy,
      vz: nextVz,
      angle,
      fuel: nextFuel,
      maxFuel: state.maxFuel,
      dryMass: state.dryMass,
      coordTime: state.coordTime + clampedDt,
      properTime: state.properTime + dTau,
      lastLapse: endSample.lapse,
      peakSpeed: Math.max(state.peakSpeed, speed),
      minLapse: Math.min(state.minLapse, endSample.lapse),
      thrusting: hasFuel && throttle > 0.01,
    };
  }
}

/**
 * Alternative Replaceable Rocket Physics Module:
 * Classical 3D Newtonian integration (a = g + thrust) using the exact same 3D GravityFieldSampler.
 */
export class NewtonianRocketPhysics implements RocketPhysicsModel {
  public readonly id = 'newtonian';
  public readonly name = 'Classical Newtonian';
  public readonly description =
    'Pure 3D Newtonian integration (a = g + thrust) without 1PN metric corrections or frame-dragging.';

  public step(
    state: RocketState,
    input: RocketInput,
    field: GravityFieldSampler,
    dt: number,
    config: RocketConfig
  ): RocketState {
    if (dt <= 0) return state;

    const clampedDt = Math.min(dt, 0.05);
    const angle = state.angle + input.turn * config.turnRate * clampedDt;

    const throttle = Math.max(-0.6, Math.min(1, input.throttle));
    const hasFuel = state.fuel > 0 && Math.abs(throttle) > 0.01;
    const fuelUsed = hasFuel ? Math.min(state.fuel, Math.abs(throttle) * config.fuelBurnRate * clampedDt) : 0;
    const nextFuel = Math.max(0, state.fuel - fuelUsed);
    const totalMass = state.dryMass + nextFuel / Math.max(1, state.maxFuel);
    const thrustMag = hasFuel ? (throttle * config.thrustPower) / totalMass : 0;

    const thrustAx = Math.cos(angle) * thrustMag;
    const thrustAy = Math.sin(angle) * thrustMag;

    const s1 = field.sampleAt(state.x, state.y, state.z);
    const midX = state.x + state.vx * (clampedDt * 0.5);
    const midY = state.y + state.vy * (clampedDt * 0.5);
    const midZ = state.z + state.vz * (clampedDt * 0.5);
    const s2 = field.sampleAt(midX, midY, midZ);

    const nextVx = state.vx + (s2.gx + thrustAx) * clampedDt;
    const nextVy = state.vy + (s2.gy + thrustAy) * clampedDt;
    const nextVz = state.vz + s2.gz * clampedDt;
    const nextX = state.x + ((state.vx + nextVx) * 0.5) * clampedDt;
    const nextY = state.y + ((state.vy + nextVy) * 0.5) * clampedDt;
    const nextZ = state.z + ((state.vz + nextVz) * 0.5) * clampedDt;
    const speed = Math.hypot(nextVx, nextVy, nextVz);

    return {
      x: nextX,
      y: nextY,
      z: nextZ,
      vx: nextVx,
      vy: nextVy,
      vz: nextVz,
      angle,
      fuel: nextFuel,
      maxFuel: state.maxFuel,
      dryMass: state.dryMass,
      coordTime: state.coordTime + clampedDt,
      properTime: state.properTime + clampedDt,
      lastLapse: s1.lapse,
      peakSpeed: Math.max(state.peakSpeed, speed),
      minLapse: Math.min(state.minLapse, s1.lapse),
      thrusting: hasFuel && throttle > 0.01,
    };
  }
}

const gr3d = new Relativistic3DRocketPhysics();

export const ROCKET_PHYSICS_REGISTRY: Record<string, RocketPhysicsModel> = {
  'gr-3d': gr3d,
  'gr-2plus1d': gr3d,
  newtonian: new NewtonianRocketPhysics(),
};

/**
 * Predicts a 3D ballistic coast trajectory using any replaceable `RocketPhysicsModel`
 * and 3D `GravityFieldSampler`, returning points whose (x, y) coordinates project
 * directly as the 2D shadow trajectory.
 */
export function predictTrajectory(
  initialState: RocketState,
  physics: RocketPhysicsModel,
  field: GravityFieldSampler,
  masses: readonly MassBody[],
  config: RocketConfig,
  steps = 110,
  stepDt = 0.032,
  beforeStep?: (dt: number) => readonly MassBody[] | void,
  universeWidth = 4800,
  universeHeight = 3000,
  escapeFieldThreshold = 3.2,
  minEscapeRadius = 1250,
  universeDepth = 1800
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  let sim: RocketState = { ...initialState };
  let activeMasses = masses;
  const univHalfW = universeWidth * 0.5;
  const univHalfH = universeHeight * 0.5;
  const univHalfD = universeDepth * 0.5;
  const zeroInput: RocketInput = { throttle: 0, turn: 0 };

  for (let i = 0; i < steps; i++) {
    if (beforeStep) {
      const updated = beforeStep(stepDt);
      if (updated) activeMasses = updated;
    }
    sim = physics.step(sim, zeroInput, field, stepDt, config);
    const speed = Math.hypot(sim.vx, sim.vy, sim.vz);
    points.push({ x: sim.x, y: sim.y, z: sim.z, lapse: sim.lastLapse, speed });

    if (
      Math.abs(sim.x) > univHalfW ||
      Math.abs(sim.y) > univHalfH ||
      Math.abs(sim.z) > univHalfD
    ) {
      break;
    }

    let totalMu = 0;
    let baryX = 0;
    let baryY = 0;
    let baryZ = 0;
    let hitMass = false;
    for (let m = 0; m < activeMasses.length; m++) {
      const body = activeMasses[m];
      const bz = body.z ?? 0;
      totalMu += body.mu;
      baryX += body.x * body.mu;
      baryY += body.y * body.mu;
      baryZ += bz * body.mu;
      const dx = sim.x - body.x;
      const dy = sim.y - body.y;
      const dz = sim.z - bz;
      const hitR = body.radius + config.hullRadius * 0.7;
      if (dx * dx + dy * dy + dz * dz <= hitR * hitR) {
        hitMass = true;
        break;
      }
    }
    if (hitMass) break;

    if (totalMu > 0) {
      baryX /= totalMu;
      baryY /= totalMu;
      baryZ /= totalMu;
    }
    const relX = sim.x - baryX;
    const relY = sim.y - baryY;
    const relZ = sim.z - baryZ;
    if (
      Math.hypot(relX, relY, relZ) > minEscapeRadius &&
      relX * sim.vx + relY * sim.vy + relZ * sim.vz > 0
    ) {
      const s = field.sampleAt(sim.x, sim.y, sim.z);
      if (Math.hypot(s.gx, s.gy, s.gz) < escapeFieldThreshold) {
        break;
      }
    }
  }

  return points;
}
