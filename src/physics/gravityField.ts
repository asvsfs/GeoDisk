import type {
  GravityFieldSample,
  GravityGridSolver,
  MassBody,
  MassKind,
  UniformGridConfig,
  UniverseConfig,
} from './types';

export const DEFAULT_GRID_CONFIG: UniformGridConfig = {
  cols: 160,
  rows: 100,
  worldWidth: 1600,
  worldHeight: 1000,
  potentialRefRadius: 2000,
  speedOfLight: 900,
};

export const UNIVERSE_CONFIG: UniverseConfig = {
  universeWidth: 4800,
  universeHeight: 3000,
  escapeFieldThreshold: 14,
  minEscapeRadius: 1250,
};

/**
 * Computes the analytical 2+1D (2D space + time) gravitational contribution
 * of a single mass at point (px, py) and accumulates it.
 *
 * In 2+1D spacetime, Gauss's law gives a 1/r radial force and a logarithmic potential:
 *   Phi_i(r) = 0.5 * mu_i * ln((r^2 + eps^2) / (R_ref^2 + eps^2))
 *   g_i(r)   = -grad(Phi_i) = -mu_i / (r^2 + eps^2) * (x - x_i)
 *   Bz_i(r)  = (spin_i / c^2) / (r^2 + eps^2)
 */
export function evaluateSingleMass2Plus1D(
  px: number,
  py: number,
  mass: MassBody,
  potentialRefRadius: number,
  speedOfLight: number
): { phi: number; gx: number; gy: number; bz: number } {
  const dx = px - mass.x;
  const dy = py - mass.y;
  const eps2 = mass.softening * mass.softening;
  const r2 = dx * dx + dy * dy + eps2;
  const ref2 = potentialRefRadius * potentialRefRadius + eps2;

  const phi = 0.5 * mass.mu * Math.log(r2 / ref2);
  const invR2 = 1.0 / r2;
  const gx = -mass.mu * dx * invR2;
  const gy = -mass.mu * dy * invR2;
  const c2 = speedOfLight * speedOfLight;
  const bz = (mass.spin / c2) * invR2 * 2500.0;

  return { phi, gx, gy, bz };
}

/**
 * Uniform-grid 2+1D Gravity Field Solver (CPU implementation matching the WebGPU WGSL shader 1:1).
 * Stores [phi, gx, gy, bz] per grid cell as the linear superposition over all MassBody objects.
 */
export class CpuGravityGridSolver implements GravityGridSolver {
  public readonly config: UniformGridConfig;
  public readonly buffer: Float32Array;

  private readonly halfW: number;
  private readonly halfH: number;
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly ref2Base: number;
  private readonly invC2: number;
  private lastMasses: readonly MassBody[] = [];

  constructor(config: Partial<UniformGridConfig> = {}) {
    this.config = { ...DEFAULT_GRID_CONFIG, ...config };
    this.buffer = new Float32Array(this.config.cols * this.config.rows * 4);
    this.halfW = this.config.worldWidth * 0.5;
    this.halfH = this.config.worldHeight * 0.5;
    this.cellW = this.config.worldWidth / (this.config.cols - 1);
    this.cellH = this.config.worldHeight / (this.config.rows - 1);
    this.ref2Base = this.config.potentialRefRadius * this.config.potentialRefRadius;
    this.invC2 = 1.0 / (this.config.speedOfLight * this.config.speedOfLight);
  }

  public updateSpeedOfLight(speedOfLight: number): void {
    (this.config as { speedOfLight: number }).speedOfLight = speedOfLight;
    (this as unknown as { invC2: number }).invC2 = 1.0 / (speedOfLight * speedOfLight);
  }

  /**
   * Computes every uniform grid cell as the exact sum of gravities from all masses.
   */
  public computeGrid(masses: readonly MassBody[]): void {
    this.lastMasses = masses;
    const { cols, rows } = this.config;
    const buf = this.buffer;
    const massCount = masses.length;

    // Pre-unpack mass arrays into tight locals for fast inner loop
    const mx = new Float64Array(massCount);
    const my = new Float64Array(massCount);
    const mMu = new Float64Array(massCount);
    const mEps2 = new Float64Array(massCount);
    const mInvRef2 = new Float64Array(massCount);
    const mSpinFactor = new Float64Array(massCount);

    for (let m = 0; m < massCount; m++) {
      const body = masses[m];
      mx[m] = body.x;
      my[m] = body.y;
      mMu[m] = body.mu;
      const eps2 = body.softening * body.softening;
      mEps2[m] = eps2;
      mInvRef2[m] = 1.0 / (this.ref2Base + eps2);
      mSpinFactor[m] = body.spin * this.invC2 * 2500.0;
    }

    for (let row = 0; row < rows; row++) {
      const py = -this.halfH + row * this.cellH;
      const rowOffset = row * cols;

      for (let col = 0; col < cols; col++) {
        const px = -this.halfW + col * this.cellW;

        let sumPhi = 0;
        let sumGx = 0;
        let sumGy = 0;
        let sumBz = 0;

        for (let m = 0; m < massCount; m++) {
          const dx = px - mx[m];
          const dy = py - my[m];
          const r2 = dx * dx + dy * dy + mEps2[m];
          const invR2 = 1.0 / r2;
          const mu = mMu[m];

          sumPhi += 0.5 * mu * Math.log(r2 * mInvRef2[m]);
          sumGx -= mu * dx * invR2;
          sumGy -= mu * dy * invR2;
          sumBz += mSpinFactor[m] * invR2;
        }

        const idx = (rowOffset + col) * 4;
        buf[idx] = sumPhi;
        buf[idx + 1] = sumGx;
        buf[idx + 2] = sumGy;
        buf[idx + 3] = sumBz;
      }
    }
  }

  /**
   * Copies externally computed grid data (e.g., from WebGPU readback) into the sampler buffer.
   */
  public loadExternalBuffer(data: Float32Array): void {
    if (data.length === this.buffer.length) {
      this.buffer.set(data);
    }
  }

  /**
   * Bilinearly interpolates the uniform gravity grid inside the screen arena,
   * and seamlessly evaluates summed 2+1D far-field gravity when objects fly offscreen.
   */
  public sampleAt(x: number, y: number): GravityFieldSample {
    const { cols, rows, speedOfLight } = this.config;

    if (
      this.lastMasses.length > 0 &&
      (Math.abs(x) > this.halfW || Math.abs(y) > this.halfH)
    ) {
      let phi = 0;
      let gx = 0;
      let gy = 0;
      let bz = 0;
      const masses = this.lastMasses;
      for (let m = 0; m < masses.length; m++) {
        const body = masses[m];
        const dx = x - body.x;
        const dy = y - body.y;
        const eps2 = body.softening * body.softening;
        const r2 = dx * dx + dy * dy + eps2;
        const invR2 = 1.0 / r2;
        phi += 0.5 * body.mu * Math.log(r2 / (this.ref2Base + eps2));
        gx -= body.mu * dx * invR2;
        gy -= body.mu * dy * invR2;
        bz += body.spin * this.invC2 * 2500.0 * invR2;
      }
      const lapseSq = Math.max(0.0625, 1.0 + 2.0 * phi * this.invC2);
      return { phi, gx, gy, bz, lapse: Math.sqrt(lapseSq) };
    }

    const buf = this.buffer;

    const u = Math.max(0, Math.min(cols - 1.0001, (x + this.halfW) / this.cellW));
    const v = Math.max(0, Math.min(rows - 1.0001, (y + this.halfH) / this.cellH));

    const c0 = Math.floor(u);
    const r0 = Math.floor(v);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);

    const tx = u - c0;
    const ty = v - r0;
    const itx = 1 - tx;
    const ity = 1 - ty;

    const i00 = (r0 * cols + c0) * 4;
    const i10 = (r0 * cols + c1) * 4;
    const i01 = (r1 * cols + c0) * 4;
    const i11 = (r1 * cols + c1) * 4;

    const w00 = itx * ity;
    const w10 = tx * ity;
    const w01 = itx * ty;
    const w11 = tx * ty;

    const phi = buf[i00] * w00 + buf[i10] * w10 + buf[i01] * w01 + buf[i11] * w11;
    const gx = buf[i00 + 1] * w00 + buf[i10 + 1] * w10 + buf[i01 + 1] * w01 + buf[i11 + 1] * w11;
    const gy = buf[i00 + 2] * w00 + buf[i10 + 2] * w10 + buf[i01 + 2] * w01 + buf[i11 + 2] * w11;
    const bz = buf[i00 + 3] * w00 + buf[i10 + 3] * w10 + buf[i01 + 3] * w01 + buf[i11 + 3] * w11;

    const c2 = speedOfLight * speedOfLight;
    const lapseSq = Math.max(0.0625, 1.0 + (2.0 * phi) / c2);
    const lapse = Math.sqrt(lapseSq);

    return { phi, gx, gy, bz, lapse };
  }
}

/**
 * Advances any orbiting masses in time t (used for kinematic orbits when N-body is off).
 */
export function advanceOrbitingMasses(masses: MassBody[], elapsedTime: number): MassBody[] {
  let anyOrbit = false;
  for (let i = 0; i < masses.length; i++) {
    if (masses[i].orbit) {
      anyOrbit = true;
      break;
    }
  }
  if (!anyOrbit) return masses;

  return masses.map((m) => {
    if (!m.orbit) return m;
    const theta = m.orbit.phase + m.orbit.angularSpeed * elapsedTime;
    return {
      ...m,
      x: m.orbit.centerX + Math.cos(theta) * m.orbit.orbitRadius,
      y: m.orbit.centerY + Math.sin(theta) * m.orbit.orbitRadius,
    };
  });
}

export interface NBodyStepOptions {
  worldWidth?: number;
  worldHeight?: number;
  universeWidth?: number;
  universeHeight?: number;
  containInArena?: boolean;
  mergeOnCollision?: boolean;
  destroyOnEscape?: boolean;
  escapeFieldThreshold?: number;
  minEscapeRadius?: number;
}

export interface EscapedMassEvent {
  id: string;
  label?: string;
  x: number;
  y: number;
  kind: MassKind;
}

export interface NBodyStepResult {
  masses: MassBody[];
  mergers: Array<{ x: number; y: number; mu: number }>;
  escaped: EscapedMassEvent[];
}

/**
 * Integrates mutual 2+1D gravitational attraction between all MassBody objects
 * using symplectic Velocity-Verlet so binary stars and clusters orbit, perturb,
 * move offscreen across the universe, merge, and get destroyed if they escape the field.
 */
export function stepMassBodiesNBody(
  masses: readonly MassBody[],
  dt: number,
  speedOfLight: number,
  options: NBodyStepOptions = {}
): NBodyStepResult {
  const n = masses.length;
  if (n === 0 || dt <= 0) {
    return { masses: masses.slice(), mergers: [], escaped: [] };
  }

  const clampedDt = Math.min(dt, 0.04);
  const worldW = options.worldWidth ?? DEFAULT_GRID_CONFIG.worldWidth;
  const worldH = options.worldHeight ?? DEFAULT_GRID_CONFIG.worldHeight;
  const halfW = worldW * 0.5 - 24;
  const halfH = worldH * 0.5 - 24;
  const universeHalfW = (options.universeWidth ?? UNIVERSE_CONFIG.universeWidth) * 0.5;
  const universeHalfH = (options.universeHeight ?? UNIVERSE_CONFIG.universeHeight) * 0.5;
  const contain = options.containInArena ?? false;
  const mergeOnCollision = options.mergeOnCollision ?? true;
  const destroyOnEscape = options.destroyOnEscape ?? !contain;
  const escapeThreshold = options.escapeFieldThreshold ?? UNIVERSE_CONFIG.escapeFieldThreshold;
  const minEscapeR = options.minEscapeRadius ?? UNIVERSE_CONFIG.minEscapeRadius;
  const invC2 = 1.0 / (speedOfLight * speedOfLight);
  const maxBodySpeed = speedOfLight * 0.82;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const vxs = new Float64Array(n);
  const vys = new Float64Array(n);
  const ax0 = new Float64Array(n);
  const ay0 = new Float64Array(n);
  const ax1 = new Float64Array(n);
  const ay1 = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    xs[i] = masses[i].x;
    ys[i] = masses[i].y;
    vxs[i] = masses[i].vx ?? 0;
    vys[i] = masses[i].vy ?? 0;
  }

  const computePairwiseAcc = (outAx: Float64Array, outAy: Float64Array) => {
    outAx.fill(0);
    outAy.fill(0);
    for (let i = 0; i < n; i++) {
      const mi = masses[i];
      for (let j = i + 1; j < n; j++) {
        const mj = masses[j];
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const eps = mi.softening > mj.softening ? mi.softening : mj.softening;
        const r2 = dx * dx + dy * dy + eps * eps;
        const invR2 = 1.0 / r2;

        const rvx = vxs[j] - vxs[i];
        const rvy = vys[j] - vys[i];
        const relV2 = rvx * rvx + rvy * rvy;
        const relScale = 1.0 + Math.min(0.55, relV2 * invC2);

        const factor = invR2 * relScale;
        if (!mi.pinned) {
          outAx[i] += mj.mu * dx * factor;
          outAy[i] += mj.mu * dy * factor;
        }
        if (!mj.pinned) {
          outAx[j] -= mi.mu * dx * factor;
          outAy[j] -= mi.mu * dy * factor;
        }
      }
    }
  };

  // Step 1: initial accelerations
  computePairwiseAcc(ax0, ay0);

  // Step 2: drift positions and half-step velocities
  const halfDt = 0.5 * clampedDt;
  const halfDt2 = 0.5 * clampedDt * clampedDt;
  for (let i = 0; i < n; i++) {
    if (masses[i].pinned) continue;
    xs[i] += vxs[i] * clampedDt + ax0[i] * halfDt2;
    ys[i] += vys[i] * clampedDt + ay0[i] * halfDt2;

    if (contain) {
      const margin = masses[i].radius;
      const limX = halfW - margin;
      const limY = halfH - margin;
      if (xs[i] < -limX) {
        xs[i] = -limX;
        if (vxs[i] < 0) vxs[i] = -vxs[i] * 0.85;
      } else if (xs[i] > limX) {
        xs[i] = limX;
        if (vxs[i] > 0) vxs[i] = -vxs[i] * 0.85;
      }
      if (ys[i] < -limY) {
        ys[i] = -limY;
        if (vys[i] < 0) vys[i] = -vys[i] * 0.85;
      } else if (ys[i] > limY) {
        ys[i] = limY;
        if (vys[i] > 0) vys[i] = -vys[i] * 0.85;
      }
    }
  }

  // Step 3: new accelerations at drifted positions
  computePairwiseAcc(ax1, ay1);

  for (let i = 0; i < n; i++) {
    if (masses[i].pinned) continue;
    let nvx = vxs[i] + (ax0[i] + ax1[i]) * halfDt;
    let nvy = vys[i] + (ay0[i] + ay1[i]) * halfDt;
    const spd = Math.hypot(nvx, nvy);
    if (spd > maxBodySpeed) {
      const s = maxBodySpeed / spd;
      nvx *= s;
      nvy *= s;
    }
    vxs[i] = nvx;
    vys[i] = nvy;
  }

  // Step 4: optional momentum-conserving mergers when colliding bodies approach
  const absorbed = new Uint8Array(n);
  const mergers: Array<{ x: number; y: number; mu: number }> = [];
  const nextMasses: MassBody[] = [];

  for (let i = 0; i < n; i++) {
    if (absorbed[i]) continue;
    let cur: MassBody = {
      ...masses[i],
      x: xs[i],
      y: ys[i],
      vx: vxs[i],
      vy: vys[i],
    };

    if (mergeOnCollision) {
      for (let j = i + 1; j < n; j++) {
        if (absorbed[j]) continue;
        const mj = masses[j];
        if (cur.pinned && mj.pinned) continue;

        const dx = xs[j] - cur.x;
        const dy = ys[j] - cur.y;
        const dist = Math.hypot(dx, dy);
        const touchDist = (cur.radius + mj.radius) * 0.78;
        if (dist <= touchDist) {
          const rvx = vxs[j] - (cur.vx ?? 0);
          const rvy = vys[j] - (cur.vy ?? 0);
          // Only merge if actively approaching inward
          if (dx * rvx + dy * rvy < 0) {
            absorbed[j] = 1;
            const totalMu = cur.mu + mj.mu;
            const curPinned = Boolean(cur.pinned);
            const jPinned = Boolean(mj.pinned);
            const newX = curPinned
              ? cur.x
              : jPinned
                ? xs[j]
                : (cur.x * cur.mu + xs[j] * mj.mu) / totalMu;
            const newY = curPinned
              ? cur.y
              : jPinned
                ? ys[j]
                : (cur.y * cur.mu + ys[j] * mj.mu) / totalMu;
            const newVx =
              curPinned || jPinned
                ? 0
                : ((cur.vx ?? 0) * cur.mu + vxs[j] * mj.mu) / totalMu;
            const newVy =
              curPinned || jPinned
                ? 0
                : ((cur.vy ?? 0) * cur.mu + vys[j] * mj.mu) / totalMu;
            const newRadius = Math.min(54, Math.hypot(cur.radius, mj.radius));
            const newKind =
              totalMu >= 92000 || cur.kind === 'singularity' || mj.kind === 'singularity'
                ? 'singularity'
                : totalMu >= 36000 || cur.kind === 'star' || mj.kind === 'star'
                  ? 'star'
                  : cur.mu >= mj.mu
                    ? cur.kind
                    : mj.kind;

            cur = {
              ...cur,
              x: newX,
              y: newY,
              vx: newVx,
              vy: newVy,
              pinned: curPinned || jPinned,
              mu: totalMu,
              radius: newRadius,
              softening: Math.max(cur.softening, mj.softening, newRadius + 8),
              spin: cur.spin + mj.spin,
              kind: newKind,
            };
            mergers.push({ x: newX, y: newY, mu: totalMu });
          }
        }
      }
    }

    nextMasses.push(cur);
  }

  // Step 5: destroy any moving star/object that has escaped the gravitational field
  const escaped: EscapedMassEvent[] = [];
  if (destroyOnEscape && nextMasses.length > 0) {
    const surviving: MassBody[] = [];
    for (let i = 0; i < nextMasses.length; i++) {
      const m = nextMasses[i];
      if (m.pinned) {
        surviving.push(m);
        continue;
      }

      // Hard universe gravitational boundary check
      if (Math.abs(m.x) > universeHalfW || Math.abs(m.y) > universeHalfH) {
        escaped.push({ id: m.id, label: m.label, x: m.x, y: m.y, kind: m.kind });
        continue;
      }

      // Weak-field outward escape check when multiple bodies interact far offscreen
      if (nextMasses.length > 1) {
        let otherMu = 0;
        let baryX = 0;
        let baryY = 0;
        let gx = 0;
        let gy = 0;
        for (let j = 0; j < nextMasses.length; j++) {
          if (i === j) continue;
          const o = nextMasses[j];
          otherMu += o.mu;
          baryX += o.x * o.mu;
          baryY += o.y * o.mu;

          const dx = m.x - o.x;
          const dy = m.y - o.y;
          const eps = Math.max(m.softening, o.softening);
          const r2 = dx * dx + dy * dy + eps * eps;
          gx -= (o.mu * dx) / r2;
          gy -= (o.mu * dy) / r2;
        }

        if (otherMu > 0) {
          baryX /= otherMu;
          baryY /= otherMu;
          const relX = m.x - baryX;
          const relY = m.y - baryY;
          const distFromBary = Math.hypot(relX, relY);
          const mvx = m.vx ?? 0;
          const mvy = m.vy ?? 0;
          const outwardDot = relX * mvx + relY * mvy;
          const pullMag = Math.hypot(gx, gy);

          if (distFromBary > minEscapeR && outwardDot > 0 && pullMag < escapeThreshold) {
            escaped.push({ id: m.id, label: m.label, x: m.x, y: m.y, kind: m.kind });
            continue;
          }
        }
      }

      surviving.push(m);
    }
    return { masses: surviving, mergers, escaped };
  }

  return { masses: nextMasses, mergers, escaped };
}

/**
 * Lightweight analytical point sampler implementing GravityFieldSampler directly
 * over a dynamic MassBody list (used for ultra-fast dynamic N-body trajectory preview).
 */
export class Direct2Plus1DFieldSampler implements GravityGridSolver {
  public readonly config: UniformGridConfig;
  public readonly buffer = new Float32Array(0);
  private masses: readonly MassBody[];

  constructor(masses: readonly MassBody[], config: UniformGridConfig) {
    this.masses = masses;
    this.config = config;
  }

  public setMasses(masses: readonly MassBody[]): void {
    this.masses = masses;
  }

  public computeGrid(masses: readonly MassBody[]): void {
    this.masses = masses;
  }

  public sampleAt(x: number, y: number): GravityFieldSample {
    const { potentialRefRadius, speedOfLight } = this.config;
    const ref2Base = potentialRefRadius * potentialRefRadius;
    const invC2 = 1.0 / (speedOfLight * speedOfLight);

    let phi = 0;
    let gx = 0;
    let gy = 0;
    let bz = 0;

    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i];
      const dx = x - m.x;
      const dy = y - m.y;
      const eps2 = m.softening * m.softening;
      const r2 = dx * dx + dy * dy + eps2;
      const invR2 = 1.0 / r2;

      phi += 0.5 * m.mu * Math.log(r2 / (ref2Base + eps2));
      gx -= m.mu * dx * invR2;
      gy -= m.mu * dy * invR2;
      bz += m.spin * invC2 * 2500.0 * invR2;
    }

    const lapseSq = Math.max(0.0625, 1.0 + 2.0 * phi * invC2);
    return { phi, gx, gy, bz, lapse: Math.sqrt(lapseSq) };
  }
}
