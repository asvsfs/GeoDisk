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
  initialSpeed = 0
): RocketState {
  return {
    x,
    y,
    vx: Math.cos(angle) * initialSpeed,
    vy: Math.sin(angle) * initialSpeed,
    angle,
    fuel: maxFuel,
    maxFuel,
    dryMass: 1.0,
    coordTime: 0,
    properTime: 0,
    lastLapse: 1.0,
    peakSpeed: initialSpeed,
    minLapse: 1.0,
    thrusting: false,
  };
}

/**
 * Primary Rocket Physics Module:
 * 2+1D General Relativity (1PN geodesic + gravitomagnetic frame-dragging + proper time dilation)
 * integrated via Velocity-Verlet / Symplectic RK2 over the uniform GravityFieldSampler.
 *
 * Completely decoupled from mass computation and rendering — can be swapped or replaced
 * with any implementation satisfying `RocketPhysicsModel`.
 */
export class Relativistic2Plus1DRocketPhysics implements RocketPhysicsModel {
  public readonly id = 'gr-2plus1d';
  public readonly name = '2+1D Relativistic Geodesic';
  public readonly description =
    '1PN spacetime curvature, velocity-coupled lensing, gravitomagnetic frame-dragging, and proper-time dilation.';

  private computeAcceleration(
    x: number,
    y: number,
    vx: number,
    vy: number,
    thrustAx: number,
    thrustAy: number,
    field: GravityFieldSampler
  ): { ax: number; ay: number; lapse: number } {
    const sample = field.sampleAt(x, y);
    const c = field.config.speedOfLight;
    const invC2 = 1.0 / (c * c);

    const v2 = vx * vx + vy * vy;
    const beta2 = Math.min(0.88, v2 * invC2);

    // Gravitational lapse factor alpha^2 = max(0.08, 1 + 2*Phi/c^2)
    // Using alpha^2 for spatial metric factor prevents unphysical inversion inside strong wells
    // while preserving 1PN perihelion precession and velocity-coupled light-like deflection (+beta2).
    const lapseSq = Math.max(0.08, 1.0 + 2.0 * sample.phi * invC2);
    const vDotG = vx * sample.gx + vy * sample.gy;

    // 1PN relativistic geodesic acceleration in 2+1D isotropic coordinates:
    //   a_grav = g * (lapseSq + beta^2) - (3 / c^2) * (v . g) * v + v x (0, 0, Bz)
    const gravScale = lapseSq + beta2;
    const parallelDrag = 3.0 * vDotG * invC2;

    const frameDragX = vy * sample.bz;
    const frameDragY = -vx * sample.bz;

    const gravAx = sample.gx * gravScale - vx * parallelDrag + frameDragX;
    const gravAy = sample.gy * gravScale - vy * parallelDrag + frameDragY;

    // Coordinate thrust scaled by relativistic lapse (clock slows near massive wells)
    const lapse = Math.sqrt(lapseSq);
    const ax = gravAx + thrustAx * lapse;
    const ay = gravAy + thrustAy * lapse;

    return { ax, ay, lapse };
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

    // Compute rocket thrust acceleration from remaining propellant
    const throttle = Math.max(-0.6, Math.min(1, input.throttle));
    const hasFuel = state.fuel > 0 && Math.abs(throttle) > 0.01;
    const fuelUsed = hasFuel ? Math.min(state.fuel, Math.abs(throttle) * config.fuelBurnRate * clampedDt) : 0;
    const nextFuel = Math.max(0, state.fuel - fuelUsed);
    const totalMass = state.dryMass + nextFuel / Math.max(1, state.maxFuel);
    const thrustMag = hasFuel ? (throttle * config.thrustPower) / totalMass : 0;

    const thrustAx = Math.cos(angle) * thrustMag;
    const thrustAy = Math.sin(angle) * thrustMag;

    // 2nd-order Runge-Kutta (Midpoint / Heun) integration for smooth orbital energy conservation
    const k1 = this.computeAcceleration(state.x, state.y, state.vx, state.vy, thrustAx, thrustAy, field);

    const midX = state.x + state.vx * (clampedDt * 0.5);
    const midY = state.y + state.vy * (clampedDt * 0.5);
    const midVx = state.vx + k1.ax * (clampedDt * 0.5);
    const midVy = state.vy + k1.ay * (clampedDt * 0.5);

    const k2 = this.computeAcceleration(midX, midY, midVx, midVy, thrustAx, thrustAy, field);

    let nextVx = state.vx + k2.ax * clampedDt;
    let nextVy = state.vy + k2.ay * clampedDt;

    // Relativistic speed limit strictly below c (0.95c)
    const c = field.config.speedOfLight;
    const maxSpeed = c * 0.95;
    const speedSq = nextVx * nextVx + nextVy * nextVy;
    let speed = Math.sqrt(speedSq);
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      nextVx *= scale;
      nextVy *= scale;
      speed = maxSpeed;
    }

    const nextX = state.x + ((state.vx + nextVx) * 0.5) * clampedDt;
    const nextY = state.y + ((state.vy + nextVy) * 0.5) * clampedDt;

    // Proper time interval dTau = dt * sqrt(max(0.05, 1 + 2*Phi/c^2 - v^2/c^2))
    const endSample = field.sampleAt(nextX, nextY);
    const invC2 = 1.0 / (c * c);
    const metricInterval = Math.max(0.05, 1.0 + 2.0 * endSample.phi * invC2 - (speed * speed) * invC2);
    const dTau = clampedDt * Math.sqrt(metricInterval);

    return {
      x: nextX,
      y: nextY,
      vx: nextVx,
      vy: nextVy,
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
 * Classical Newtonian integration (a = g + thrust) using the exact same GravityFieldSampler.
 * Demonstrates that rocket physics is an independent, hot-swappable module.
 */
export class NewtonianRocketPhysics implements RocketPhysicsModel {
  public readonly id = 'newtonian';
  public readonly name = 'Classical Newtonian';
  public readonly description =
    'Pure 2D Newtonian integration (a = g + thrust) without relativistic metric corrections or frame-dragging.';

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

    const s1 = field.sampleAt(state.x, state.y);
    const midX = state.x + state.vx * (clampedDt * 0.5);
    const midY = state.y + state.vy * (clampedDt * 0.5);
    const s2 = field.sampleAt(midX, midY);

    const nextVx = state.vx + (s2.gx + thrustAx) * clampedDt;
    const nextVy = state.vy + (s2.gy + thrustAy) * clampedDt;
    const nextX = state.x + ((state.vx + nextVx) * 0.5) * clampedDt;
    const nextY = state.y + ((state.vy + nextVy) * 0.5) * clampedDt;
    const speed = Math.hypot(nextVx, nextVy);

    return {
      x: nextX,
      y: nextY,
      vx: nextVx,
      vy: nextVy,
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

export const ROCKET_PHYSICS_REGISTRY: Record<string, RocketPhysicsModel> = {
  'gr-2plus1d': new Relativistic2Plus1DRocketPhysics(),
  newtonian: new NewtonianRocketPhysics(),
};

/**
 * Predicts a ballistic coast trajectory using any replaceable `RocketPhysicsModel`
 * and `GravityFieldSampler`, continuing offscreen across the universe and terminating
 * early only if colliding with a mass or escaping the gravitational field.
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
  escapeFieldThreshold = 14,
  minEscapeRadius = 1250
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  let sim: RocketState = { ...initialState };
  let activeMasses = masses;
  const univHalfW = universeWidth * 0.5;
  const univHalfH = universeHeight * 0.5;
  const zeroInput: RocketInput = { throttle: 0, turn: 0 };

  for (let i = 0; i < steps; i++) {
    if (beforeStep) {
      const updated = beforeStep(stepDt);
      if (updated) activeMasses = updated;
    }
    sim = physics.step(sim, zeroInput, field, stepDt, config);
    const speed = Math.hypot(sim.vx, sim.vy);
    points.push({ x: sim.x, y: sim.y, lapse: sim.lastLapse, speed });

    if (Math.abs(sim.x) > univHalfW || Math.abs(sim.y) > univHalfH) {
      break;
    }

    // Check weak-field escape far offscreen
    let totalMu = 0;
    let baryX = 0;
    let baryY = 0;
    let hitMass = false;
    for (let m = 0; m < activeMasses.length; m++) {
      const body = activeMasses[m];
      totalMu += body.mu;
      baryX += body.x * body.mu;
      baryY += body.y * body.mu;
      const dx = sim.x - body.x;
      const dy = sim.y - body.y;
      const hitR = body.radius + config.hullRadius * 0.7;
      if (dx * dx + dy * dy <= hitR * hitR) {
        hitMass = true;
        break;
      }
    }
    if (hitMass) break;

    if (totalMu > 0) {
      baryX /= totalMu;
      baryY /= totalMu;
    }
    const relX = sim.x - baryX;
    const relY = sim.y - baryY;
    if (
      Math.hypot(relX, relY) > minEscapeRadius &&
      relX * sim.vx + relY * sim.vy > 0
    ) {
      const s = field.sampleAt(sim.x, sim.y);
      if (Math.hypot(s.gx, s.gy) < escapeFieldThreshold) {
        break;
      }
    }
  }

  return points;
}
