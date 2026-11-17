import type {
  GravityFieldSample,
  GravityGridSolver,
  MassBody,
  MassKind,
  UniformGridConfig,
  UniverseConfig,
} from './types';

export const DEFAULT_GRID_CONFIG: UniformGridConfig = {
  cols: 80,
  rows: 50,
  layers: 13,
  worldWidth: 1600,
  worldHeight: 1000,
  worldDepth: 600,
  speedOfLight: 900,
};

export const UNIVERSE_CONFIG: UniverseConfig = {
  universeWidth: 4800,
  universeHeight: 3000,
  universeDepth: 1800,
  escapeFieldThreshold: 3.2,
  minEscapeRadius: 1250,
};

export const LENSE_THIRRING_COUPLE = 450000.0;

/**
 * Computes the analytical 3D (3+1D) General Relativity weak-field contribution
 * of a single mass at 3D point (px, py, pz):
 *
 *   R_i        = sqrt((x - x_i)^2 + (y - y_i)^2 + (z - z_i)^2 + eps_i^2)
 *   Phi_i      = -mu_i / R_i
 *   g_i        = -grad(Phi_i) = -mu_i * (r - r_i) / R_i^3
 *   B_g,i      = (kappa_B / c^2) * (R_i^2 * J_i - 3 * (J_i . dr_i) * dr_i) / R_i^5
 */
export function evaluateSingleMass3D(
  px: number,
  py: number,
  pz: number,
  mass: MassBody,
  speedOfLight: number
): { phi: number; gx: number; gy: number; gz: number; bx: number; by: number; bz: number } {
  const dx = px - mass.x;
  const dy = py - mass.y;
  const dz = pz - (mass.z ?? 0);
  const eps2 = mass.softening * mass.softening;
  const r2 = dx * dx + dy * dy + dz * dz + eps2;
  const r = Math.sqrt(r2);
  const invR = 1.0 / r;
  const invR3 = invR / r2;
  const invR5 = invR3 / r2;

  const phi = -mass.mu * invR;
  const gx = -mass.mu * dx * invR3;
  const gy = -mass.mu * dy * invR3;
  const gz = -mass.mu * dz * invR3;

  const c2 = speedOfLight * speedOfLight;
  const spinFactor = (mass.spin / c2) * LENSE_THIRRING_COUPLE;
  const bx = spinFactor * (-3.0 * dz * dx) * invR5;
  const by = spinFactor * (-3.0 * dz * dy) * invR5;
  const bz = spinFactor * (r2 - 3.0 * dz * dz) * invR5;

  return { phi, gx, gy, gz, bx, by, bz };
}

/**
 * Uniform-grid 3D Gravity Field Solver (CPU implementation matching the WebGPU WGSL shader 1:1).
 * Stores [phi, gx, gy, gz, bx, by, bz, 0] (stride = 8 floats) per 3D grid cell
 * as the exact linear superposition over all MassBody objects.
 */
export class CpuGravityGridSolver implements GravityGridSolver {
  public readonly config: UniformGridConfig;
  public readonly buffer: Float32Array;

  private readonly halfW: number;
  private readonly halfH: number;
  private readonly halfD: number;
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly cellD: number;
  private readonly invC2: number;
  private lastMasses: readonly MassBody[] = [];

  constructor(config: Partial<UniformGridConfig> = {}) {
    this.config = { ...DEFAULT_GRID_CONFIG, ...config };
    this.buffer = new Float32Array(
      this.config.cols * this.config.rows * this.config.layers * 8
    );
    this.halfW = this.config.worldWidth * 0.5;
    this.halfH = this.config.worldHeight * 0.5;
    this.halfD = this.config.worldDepth * 0.5;
    this.cellW = this.config.worldWidth / Math.max(1, this.config.cols - 1);
    this.cellH = this.config.worldHeight / Math.max(1, this.config.rows - 1);
    this.cellD = this.config.worldDepth / Math.max(1, this.config.layers - 1);
    this.invC2 = 1.0 / (this.config.speedOfLight * this.config.speedOfLight);
  }

  public updateSpeedOfLight(speedOfLight: number): void {
    (this.config as { speedOfLight: number }).speedOfLight = speedOfLight;
    (this as unknown as { invC2: number }).invC2 = 1.0 / (speedOfLight * speedOfLight);
  }

  /**
   * Computes every 3D uniform grid cell as the exact linear sum of gravities from all masses.
   */
  public computeGrid(masses: readonly MassBody[]): void {
    this.lastMasses = masses;
    const { cols, rows, layers } = this.config;
    const buf = this.buffer;
    const massCount = masses.length;

    const mx = new Float64Array(massCount);
    const my = new Float64Array(massCount);
    const mz = new Float64Array(massCount);
    const mMu = new Float64Array(massCount);
    const mEps2 = new Float64Array(massCount);
    const mSpinFactor = new Float64Array(massCount);

    for (let m = 0; m < massCount; m++) {
      const body = masses[m];
      mx[m] = body.x;
      my[m] = body.y;
      mz[m] = body.z ?? 0;
      mMu[m] = body.mu;
      mEps2[m] = body.softening * body.softening;
      mSpinFactor[m] = body.spin * this.invC2 * LENSE_THIRRING_COUPLE;
    }

    const sliceSize = cols * rows;
    for (let layer = 0; layer < layers; layer++) {
      const pz = layers > 1 ? -this.halfD + layer * this.cellD : 0;
      const layerOffset = layer * sliceSize;

      for (let row = 0; row < rows; row++) {
        const py = -this.halfH + row * this.cellH;
        const rowOffset = layerOffset + row * cols;

        for (let col = 0; col < cols; col++) {
          const px = -this.halfW + col * this.cellW;

          let sumPhi = 0;
          let sumGx = 0;
          let sumGy = 0;
          let sumGz = 0;
          let sumBx = 0;
          let sumBy = 0;
          let sumBz = 0;

          for (let m = 0; m < massCount; m++) {
            const dx = px - mx[m];
            const dy = py - my[m];
            const dz = pz - mz[m];
            const r2 = dx * dx + dy * dy + dz * dz + mEps2[m];
            const r = Math.sqrt(r2);
            const invR = 1.0 / r;
            const invR2 = 1.0 / r2;
            const invR3 = invR * invR2;
            const mu = mMu[m];

            sumPhi -= mu * invR;
            const gFac = mu * invR3;
            sumGx -= dx * gFac;
            sumGy -= dy * gFac;
            sumGz -= dz * gFac;

            const sf = mSpinFactor[m];
            if (sf !== 0) {
              const invR5 = invR3 * invR2;
              sumBx += sf * (-3.0 * dz * dx) * invR5;
              sumBy += sf * (-3.0 * dz * dy) * invR5;
              sumBz += sf * (r2 - 3.0 * dz * dz) * invR5;
            }
          }

          const idx = (rowOffset + col) * 8;
          buf[idx] = sumPhi;
          buf[idx + 1] = sumGx;
          buf[idx + 2] = sumGy;
          buf[idx + 3] = sumGz;
          buf[idx + 4] = sumBx;
          buf[idx + 5] = sumBy;
          buf[idx + 6] = sumBz;
          buf[idx + 7] = 0;
        }
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
   * Trilinearly interpolates the 3D uniform gravity grid inside the core volume,
   * and seamlessly evaluates summed 3D far-field gravity when objects fly offscreen.
   */
  public sampleAt(x: number, y: number, z = 0): GravityFieldSample {
    const { cols, rows, layers, speedOfLight } = this.config;

    if (
      this.lastMasses.length > 0 &&
      (Math.abs(x) > this.halfW || Math.abs(y) > this.halfH || Math.abs(z) > this.halfD)
    ) {
      let phi = 0;
      let gx = 0;
      let gy = 0;
      let gz = 0;
      let bx = 0;
      let by = 0;
      let bz = 0;
      const masses = this.lastMasses;
      for (let m = 0; m < masses.length; m++) {
        const body = masses[m];
        const dx = x - body.x;
        const dy = y - body.y;
        const dz = z - (body.z ?? 0);
        const eps2 = body.softening * body.softening;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const r = Math.sqrt(r2);
        const invR = 1.0 / r;
        const invR2 = 1.0 / r2;
        const invR3 = invR * invR2;

        phi -= body.mu * invR;
        const gFac = body.mu * invR3;
        gx -= dx * gFac;
        gy -= dy * gFac;
        gz -= dz * gFac;

        if (body.spin !== 0) {
          const sf = body.spin * this.invC2 * LENSE_THIRRING_COUPLE;
          const invR5 = invR3 * invR2;
          bx += sf * (-3.0 * dz * dx) * invR5;
          by += sf * (-3.0 * dz * dy) * invR5;
          bz += sf * (r2 - 3.0 * dz * dz) * invR5;
        }
      }
      const lapseSq = Math.max(0.0625, 1.0 + 2.0 * phi * this.invC2);
      return { phi, gx, gy, gz, bx, by, bz, lapse: Math.sqrt(lapseSq) };
    }

    const buf = this.buffer;
    const sliceSize = cols * rows;

    const u = Math.max(0, Math.min(cols - 1.0001, (x + this.halfW) / this.cellW));
    const v = Math.max(0, Math.min(rows - 1.0001, (y + this.halfH) / this.cellH));
    const w =
      layers > 1
        ? Math.max(0, Math.min(layers - 1.0001, (z + this.halfD) / this.cellD))
        : 0;

    const c0 = Math.floor(u);
    const r0 = Math.floor(v);
    const l0 = Math.floor(w);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const l1 = Math.min(layers - 1, l0 + 1);

    const tx = u - c0;
    const ty = v - r0;
    const tz = w - l0;
    const itx = 1 - tx;
    const ity = 1 - ty;
    const itz = 1 - tz;

    const i000 = (l0 * sliceSize + r0 * cols + c0) * 8;
    const i100 = (l0 * sliceSize + r0 * cols + c1) * 8;
    const i010 = (l0 * sliceSize + r1 * cols + c0) * 8;
    const i110 = (l0 * sliceSize + r1 * cols + c1) * 8;

    const i001 = (l1 * sliceSize + r0 * cols + c0) * 8;
    const i101 = (l1 * sliceSize + r0 * cols + c1) * 8;
    const i011 = (l1 * sliceSize + r1 * cols + c0) * 8;
    const i111 = (l1 * sliceSize + r1 * cols + c1) * 8;

    const w000 = itx * ity * itz;
    const w100 = tx * ity * itz;
    const w010 = itx * ty * itz;
    const w110 = tx * ty * itz;
    const w001 = itx * ity * tz;
    const w101 = tx * ity * tz;
    const w011 = itx * ty * tz;
    const w111 = tx * ty * tz;

    const phi =
      buf[i000] * w000 +
      buf[i100] * w100 +
      buf[i010] * w010 +
      buf[i110] * w110 +
      buf[i001] * w001 +
      buf[i101] * w101 +
      buf[i011] * w011 +
      buf[i111] * w111;

    const gx =
      buf[i000 + 1] * w000 +
      buf[i100 + 1] * w100 +
      buf[i010 + 1] * w010 +
      buf[i110 + 1] * w110 +
      buf[i001 + 1] * w001 +
      buf[i101 + 1] * w101 +
      buf[i011 + 1] * w011 +
      buf[i111 + 1] * w111;

    const gy =
      buf[i000 + 2] * w000 +
      buf[i100 + 2] * w100 +
      buf[i010 + 2] * w010 +
      buf[i110 + 2] * w110 +
      buf[i001 + 2] * w001 +
      buf[i101 + 2] * w101 +
      buf[i011 + 2] * w011 +
      buf[i111 + 2] * w111;

    const gz =
      buf[i000 + 3] * w000 +
      buf[i100 + 3] * w100 +
      buf[i010 + 3] * w010 +
      buf[i110 + 3] * w110 +
      buf[i001 + 3] * w001 +
      buf[i101 + 3] * w101 +
      buf[i011 + 3] * w011 +
      buf[i111 + 3] * w111;

    const bx =
      buf[i000 + 4] * w000 +
      buf[i100 + 4] * w100 +
      buf[i010 + 4] * w010 +
      buf[i110 + 4] * w110 +
      buf[i001 + 4] * w001 +
      buf[i101 + 4] * w101 +
      buf[i011 + 4] * w011 +
      buf[i111 + 4] * w111;

    const by =
      buf[i000 + 5] * w000 +
      buf[i100 + 5] * w100 +
      buf[i010 + 5] * w010 +
      buf[i110 + 5] * w110 +
      buf[i001 + 5] * w001 +
      buf[i101 + 5] * w101 +
      buf[i011 + 5] * w011 +
      buf[i111 + 5] * w111;

    const bz =
      buf[i000 + 6] * w000 +
      buf[i100 + 6] * w100 +
      buf[i010 + 6] * w010 +
      buf[i110 + 6] * w110 +
      buf[i001 + 6] * w001 +
      buf[i101 + 6] * w101 +
      buf[i011 + 6] * w011 +
      buf[i111 + 6] * w111;

    const c2 = speedOfLight * speedOfLight;
    const lapseSq = Math.max(0.0625, 1.0 + (2.0 * phi) / c2);
    const lapse = Math.sqrt(lapseSq);

    return { phi, gx, gy, gz, bx, by, bz, lapse };
  }
}

/**
 * Advances any orbiting masses in 3D time t (used for kinematic orbits when N-body is off).
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
    const zAmp = m.orbit.zAmplitude ?? 0;
    const cz = m.orbit.centerZ ?? 0;
    return {
      ...m,
      x: m.orbit.centerX + Math.cos(theta) * m.orbit.orbitRadius,
      y: m.orbit.centerY + Math.sin(theta) * m.orbit.orbitRadius,
      z: cz + Math.sin(theta) * zAmp,
    };
  });
}

export interface NBodyStepOptions {
  worldWidth?: number;
  worldHeight?: number;
  worldDepth?: number;
  universeWidth?: number;
  universeHeight?: number;
  universeDepth?: number;
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
  z: number;
  kind: MassKind;
}

export interface NBodyStepResult {
  masses: MassBody[];
  mergers: Array<{ x: number; y: number; z: number; mu: number }>;
  escaped: EscapedMassEvent[];
}

/**
 * Integrates mutual 3D (1/r^2 + 1PN velocity-coupled) gravitational attraction
 * between all MassBody objects in 3D (x, y, z) using symplectic Velocity-Verlet
 * so binary stars and clusters orbit in 3D, project 2D shadow motion, merge, and
 * are destroyed when escaping the gravitational field.
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
  const worldD = options.worldDepth ?? DEFAULT_GRID_CONFIG.worldDepth;
  const halfW = worldW * 0.5 - 24;
  const halfH = worldH * 0.5 - 24;
  const halfD = worldD * 0.5 - 24;
  const universeHalfW = (options.universeWidth ?? UNIVERSE_CONFIG.universeWidth) * 0.5;
  const universeHalfH = (options.universeHeight ?? UNIVERSE_CONFIG.universeHeight) * 0.5;
  const universeHalfD = (options.universeDepth ?? UNIVERSE_CONFIG.universeDepth) * 0.5;
  const contain = options.containInArena ?? false;
  const mergeOnCollision = options.mergeOnCollision ?? true;
  const destroyOnEscape = options.destroyOnEscape ?? !contain;
  const escapeThreshold = options.escapeFieldThreshold ?? UNIVERSE_CONFIG.escapeFieldThreshold;
  const minEscapeR = options.minEscapeRadius ?? UNIVERSE_CONFIG.minEscapeRadius;
  const invC2 = 1.0 / (speedOfLight * speedOfLight);
  const maxBodySpeed = speedOfLight * 0.82;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  const vxs = new Float64Array(n);
  const vys = new Float64Array(n);
  const vzs = new Float64Array(n);
  const ax0 = new Float64Array(n);
  const ay0 = new Float64Array(n);
  const az0 = new Float64Array(n);
  const ax1 = new Float64Array(n);
  const ay1 = new Float64Array(n);
  const az1 = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    xs[i] = masses[i].x;
    ys[i] = masses[i].y;
    zs[i] = masses[i].z ?? 0;
    vxs[i] = masses[i].vx ?? 0;
    vys[i] = masses[i].vy ?? 0;
    vzs[i] = masses[i].vz ?? 0;
  }

  const computePairwiseAcc = (
    outAx: Float64Array,
    outAy: Float64Array,
    outAz: Float64Array
  ) => {
    outAx.fill(0);
    outAy.fill(0);
    outAz.fill(0);
    for (let i = 0; i < n; i++) {
      const mi = masses[i];
      for (let j = i + 1; j < n; j++) {
        const mj = masses[j];
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const dz = zs[j] - zs[i];
        const eps = mi.softening > mj.softening ? mi.softening : mj.softening;
        const r2 = dx * dx + dy * dy + dz * dz + eps * eps;
        const r = Math.sqrt(r2);
        const invR3 = 1.0 / (r2 * r);

        const rvx = vxs[j] - vxs[i];
        const rvy = vys[j] - vys[i];
        const rvz = vzs[j] - vzs[i];
        const relV2 = rvx * rvx + rvy * rvy + rvz * rvz;
        const relScale = 1.0 + Math.min(0.55, relV2 * invC2);

        const factor = invR3 * relScale;
        if (!mi.pinned) {
          outAx[i] += mj.mu * dx * factor;
          outAy[i] += mj.mu * dy * factor;
          outAz[i] += mj.mu * dz * factor;
        }
        if (!mj.pinned) {
          outAx[j] -= mi.mu * dx * factor;
          outAy[j] -= mi.mu * dy * factor;
          outAz[j] -= mi.mu * dz * factor;
        }
      }
    }
  };

  computePairwiseAcc(ax0, ay0, az0);

  const halfDt = 0.5 * clampedDt;
  const halfDt2 = 0.5 * clampedDt * clampedDt;
  for (let i = 0; i < n; i++) {
    if (masses[i].pinned) continue;
    xs[i] += vxs[i] * clampedDt + ax0[i] * halfDt2;
    ys[i] += vys[i] * clampedDt + ay0[i] * halfDt2;
    zs[i] += vzs[i] * clampedDt + az0[i] * halfDt2;

    if (contain) {
      const margin = masses[i].radius;
      const limX = halfW - margin;
      const limY = halfH - margin;
      const limZ = halfD - margin;
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
      if (zs[i] < -limZ) {
        zs[i] = -limZ;
        if (vzs[i] < 0) vzs[i] = -vzs[i] * 0.85;
      } else if (zs[i] > limZ) {
        zs[i] = limZ;
        if (vzs[i] > 0) vzs[i] = -vzs[i] * 0.85;
      }
    }
  }

  computePairwiseAcc(ax1, ay1, az1);

  for (let i = 0; i < n; i++) {
    if (masses[i].pinned) continue;
    let nvx = vxs[i] + (ax0[i] + ax1[i]) * halfDt;
    let nvy = vys[i] + (ay0[i] + ay1[i]) * halfDt;
    let nvz = vzs[i] + (az0[i] + az1[i]) * halfDt;
    const spd = Math.hypot(nvx, nvy, nvz);
    if (spd > maxBodySpeed) {
      const s = maxBodySpeed / spd;
      nvx *= s;
      nvy *= s;
      nvz *= s;
    }
    vxs[i] = nvx;
    vys[i] = nvy;
    vzs[i] = nvz;
  }

  // Momentum-conserving 3D mergers
  const absorbed = new Uint8Array(n);
  const mergers: Array<{ x: number; y: number; z: number; mu: number }> = [];
  const nextMasses: MassBody[] = [];

  for (let i = 0; i < n; i++) {
    if (absorbed[i]) continue;
    let cur: MassBody = {
      ...masses[i],
      x: xs[i],
      y: ys[i],
      z: zs[i],
      vx: vxs[i],
      vy: vys[i],
      vz: vzs[i],
    };

    if (mergeOnCollision) {
      for (let j = i + 1; j < n; j++) {
        if (absorbed[j]) continue;
        const mj = masses[j];
        if (cur.pinned && mj.pinned) continue;

        const dx = xs[j] - cur.x;
        const dy = ys[j] - cur.y;
        const dz = zs[j] - (cur.z ?? 0);
        const dist = Math.hypot(dx, dy, dz);
        const touchDist = (cur.radius + mj.radius) * 0.78;
        if (dist <= touchDist) {
          const rvx = vxs[j] - (cur.vx ?? 0);
          const rvy = vys[j] - (cur.vy ?? 0);
          const rvz = vzs[j] - (cur.vz ?? 0);
          if (dx * rvx + dy * rvy + dz * rvz < 0) {
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
            const newZ = curPinned
              ? cur.z ?? 0
              : jPinned
                ? zs[j]
                : ((cur.z ?? 0) * cur.mu + zs[j] * mj.mu) / totalMu;
            const newVx =
              curPinned || jPinned
                ? 0
                : ((cur.vx ?? 0) * cur.mu + vxs[j] * mj.mu) / totalMu;
            const newVy =
              curPinned || jPinned
                ? 0
                : ((cur.vy ?? 0) * cur.mu + vys[j] * mj.mu) / totalMu;
            const newVz =
              curPinned || jPinned
                ? 0
                : ((cur.vz ?? 0) * cur.mu + vzs[j] * mj.mu) / totalMu;
            const newRadius = Math.min(54, Math.hypot(cur.radius, mj.radius));
            const newKind =
              totalMu >= 1.55e7 || cur.kind === 'singularity' || mj.kind === 'singularity'
                ? 'singularity'
                : totalMu >= 6.5e6 || cur.kind === 'star' || mj.kind === 'star'
                  ? 'star'
                  : cur.mu >= mj.mu
                    ? cur.kind
                    : mj.kind;

            cur = {
              ...cur,
              x: newX,
              y: newY,
              z: newZ,
              vx: newVx,
              vy: newVy,
              vz: newVz,
              pinned: curPinned || jPinned,
              mu: totalMu,
              radius: newRadius,
              softening: Math.max(cur.softening, mj.softening, newRadius + 8),
              spin: cur.spin + mj.spin,
              kind: newKind,
            };
            mergers.push({ x: newX, y: newY, z: newZ, mu: totalMu });
          }
        }
      }
    }

    nextMasses.push(cur);
  }

  // Destroy any moving star/object that escapes the 3D gravitational field
  const escaped: EscapedMassEvent[] = [];
  if (destroyOnEscape && nextMasses.length > 0) {
    const surviving: MassBody[] = [];
    for (let i = 0; i < nextMasses.length; i++) {
      const m = nextMasses[i];
      const mz = m.z ?? 0;
      if (m.pinned) {
        surviving.push(m);
        continue;
      }

      if (
        Math.abs(m.x) > universeHalfW ||
        Math.abs(m.y) > universeHalfH ||
        Math.abs(mz) > universeHalfD
      ) {
        escaped.push({ id: m.id, label: m.label, x: m.x, y: m.y, z: mz, kind: m.kind });
        continue;
      }

      if (nextMasses.length > 1) {
        let otherMu = 0;
        let baryX = 0;
        let baryY = 0;
        let baryZ = 0;
        let gx = 0;
        let gy = 0;
        let gz = 0;
        for (let j = 0; j < nextMasses.length; j++) {
          if (i === j) continue;
          const o = nextMasses[j];
          const oz = o.z ?? 0;
          otherMu += o.mu;
          baryX += o.x * o.mu;
          baryY += o.y * o.mu;
          baryZ += oz * o.mu;

          const dx = m.x - o.x;
          const dy = m.y - o.y;
          const dz = mz - oz;
          const eps = Math.max(m.softening, o.softening);
          const r2 = dx * dx + dy * dy + dz * dz + eps * eps;
          const r = Math.sqrt(r2);
          const gFac = o.mu / (r2 * r);
          gx -= dx * gFac;
          gy -= dy * gFac;
          gz -= dz * gFac;
        }

        if (otherMu > 0) {
          baryX /= otherMu;
          baryY /= otherMu;
          baryZ /= otherMu;
          const relX = m.x - baryX;
          const relY = m.y - baryY;
          const relZ = mz - baryZ;
          const distFromBary = Math.hypot(relX, relY, relZ);
          const mvx = m.vx ?? 0;
          const mvy = m.vy ?? 0;
          const mvz = m.vz ?? 0;
          const outwardDot = relX * mvx + relY * mvy + relZ * mvz;
          const pullMag = Math.hypot(gx, gy, gz);

          if (distFromBary > minEscapeR && outwardDot > 0 && pullMag < escapeThreshold) {
            escaped.push({ id: m.id, label: m.label, x: m.x, y: m.y, z: mz, kind: m.kind });
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
 * Lightweight analytical 3D point sampler implementing GravityGridSolver directly
 * over a dynamic MassBody list (used for dynamic 3D N-body trajectory shadow preview).
 */
export class Direct3DFieldSampler implements GravityGridSolver {
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

  public sampleAt(x: number, y: number, z = 0): GravityFieldSample {
    const { speedOfLight } = this.config;
    const invC2 = 1.0 / (speedOfLight * speedOfLight);

    let phi = 0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;

    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i];
      const dx = x - m.x;
      const dy = y - m.y;
      const dz = z - (m.z ?? 0);
      const eps2 = m.softening * m.softening;
      const r2 = dx * dx + dy * dy + dz * dz + eps2;
      const r = Math.sqrt(r2);
      const invR = 1.0 / r;
      const invR2 = 1.0 / r2;
      const invR3 = invR * invR2;

      phi -= m.mu * invR;
      const gFac = m.mu * invR3;
      gx -= dx * gFac;
      gy -= dy * gFac;
      gz -= dz * gFac;

      if (m.spin !== 0) {
        const sf = m.spin * invC2 * LENSE_THIRRING_COUPLE;
        const invR5 = invR3 * invR2;
        bx += sf * (-3.0 * dz * dx) * invR5;
        by += sf * (-3.0 * dz * dy) * invR5;
        bz += sf * (r2 - 3.0 * dz * dz) * invR5;
      }
    }

    const lapseSq = Math.max(0.0625, 1.0 + 2.0 * phi * invC2);
    return { phi, gx, gy, gz, bx, by, bz, lapse: Math.sqrt(lapseSq) };
  }
}
