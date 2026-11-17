/**
 * @fileoverview Gravity field solvers.
 *
 * A `FieldSolver` is built once per step from the body list and then sampled
 * at arbitrary points (body positions, satellite positions, render probes).
 * Two implementations are provided and chosen automatically by body count:
 *
 *  - `DirectSolver`: exact O(N) per sample; fastest for small N.
 *  - `TreeSolver`: Barnes-Hut octree, O(log N) per sample; fastest for large N.
 *
 * Frame dragging (gravitomagnetic B field) is evaluated directly from the few
 * spinning bodies in both solvers.
 */

import type {Body} from '../types';

/**
 * Gravitomagnetic dipole coupling: B = (2 / c^2) (3 (J . r) r - J r^2) / r^5
 * with J the spin angular momentum in mu units (G * J).
 */
export const LT_COUPLING = 2;

/** Field values at a point. */
export interface FieldSample {
  /** Potential (<= 0). */
  phi: number;
  /** Gravitational acceleration -grad(phi). */
  gx: number;
  gy: number;
  gz: number;
  /** Gravitomagnetic frame-dragging field. */
  bx: number;
  by: number;
  bz: number;
}

/** Creates a zeroed field sample (reuse it to avoid allocation). */
export function newSample(): FieldSample {
  return {phi: 0, gx: 0, gy: 0, gz: 0, bx: 0, by: 0, bz: 0};
}

/** A gravity field built from a set of bodies. */
export interface FieldSolver {
  readonly name: string;
  /** Rebuilds internal structures for `bodies` at their current positions. */
  build(bodies: readonly Body[]): void;
  /** Writes the field at (x, y, z) into `out` and returns it. */
  sample(x: number, y: number, z: number, out: FieldSample): FieldSample;
  /**
   * Adds the strong-field correction of compact bodies (black holes, neutron
   * stars, white dwarfs) for a test particle at (x, y, z) moving at
   * (vx, vy, vz) to `out`. See `CompactSet`.
   */
  addStrong(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    out: Accel,
  ): void;
}

/** An acceleration vector. */
export interface Accel {
  ax: number;
  ay: number;
  az: number;
}

/** True for bodies compact enough that orbits near them feel strong gravity. */
function isCompact(b: Body): boolean {
  return b.kind === 'hole' || b.kind === 'compact' || b.kind === 'white';
}

/**
 * Packs compact bodies for the Schwarzschild correction to a test particle's
 * acceleration, per body, in that body's rest frame:
 *
 *   da = -(mu / r^2) * 3 L^2 / (c^2 r^2) * r_hat,   L = |r x v_rel|
 *
 * This is the exact radial equation of a Schwarzschild geodesic in proper
 * time added to Newtonian gravity. It precesses orbits, gives the innermost
 * stable orbit at 6 mu / c^2 and makes anything that gets close plunge in.
 * Using the body's own velocity keeps it frame-independent, so a moving
 * black hole pulls exactly as a still one does.
 */
class CompactSet {
  private x = new Float64Array(8);
  private y = new Float64Array(8);
  private z = new Float64Array(8);
  private vx = new Float64Array(8);
  private vy = new Float64Array(8);
  private vz = new Float64Array(8);
  private mu = new Float64Array(8);
  private soft2 = new Float64Array(8);
  private n = 0;

  constructor(private readonly invC2: number) {}

  build(bodies: readonly Body[]): void {
    this.n = 0;
    for (const b of bodies) {
      if (!isCompact(b)) continue;
      if (this.n === this.x.length) this.grow();
      const i = this.n++;
      this.x[i] = b.x;
      this.y[i] = b.y;
      this.z[i] = b.z;
      this.vx[i] = b.vx;
      this.vy[i] = b.vy;
      this.vz[i] = b.vz;
      this.mu[i] = b.mu;
      this.soft2[i] = b.soft * b.soft;
    }
  }

  add(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    out: Accel,
  ): void {
    for (let i = 0; i < this.n; i++) {
      const dx = px - this.x[i];
      const dy = py - this.y[i];
      const dz = pz - this.z[i];
      const ux = vx - this.vx[i];
      const uy = vy - this.vy[i];
      const uz = vz - this.vz[i];
      const lx = dy * uz - dz * uy;
      const ly = dz * ux - dx * uz;
      const lz = dx * uy - dy * ux;
      const l2 = lx * lx + ly * ly + lz * lz;
      const r2 = dx * dx + dy * dy + dz * dz + this.soft2[i];
      const invR = 1 / Math.sqrt(r2);
      // mu / r^3 (for the vector form) times 3 L^2 / (c^2 r^2).
      const f = (this.mu[i] * invR * invR * invR * 3 * l2 * this.invC2) / r2;
      out.ax -= dx * f;
      out.ay -= dy * f;
      out.az -= dz * f;
    }
  }

  private grow(): void {
    const size = this.x.length * 2;
    const grow = (a: Float64Array) => {
      const next = new Float64Array(size);
      next.set(a);
      return next;
    };
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.z = grow(this.z);
    this.vx = grow(this.vx);
    this.vy = grow(this.vy);
    this.vz = grow(this.vz);
    this.mu = grow(this.mu);
    this.soft2 = grow(this.soft2);
  }
}

/** Packs spinning bodies so B-field evaluation skips the rest. */
class SpinSet {
  private x = new Float64Array(8);
  private y = new Float64Array(8);
  private z = new Float64Array(8);
  private soft2 = new Float64Array(8);
  private k = new Float64Array(8);
  private n = 0;

  constructor(private readonly invC2: number) {}

  build(bodies: readonly Body[]): void {
    this.n = 0;
    for (const b of bodies) {
      if (b.spin === 0) continue;
      if (this.n === this.x.length) this.grow();
      const i = this.n++;
      this.x[i] = b.x;
      this.y[i] = b.y;
      this.z[i] = b.z;
      this.soft2[i] = b.soft * b.soft;
      this.k[i] = b.spin * this.invC2 * LT_COUPLING;
    }
  }

  addB(px: number, py: number, pz: number, out: FieldSample): void {
    for (let i = 0; i < this.n; i++) {
      const dx = px - this.x[i];
      const dy = py - this.y[i];
      const dz = pz - this.z[i];
      const r2 = dx * dx + dy * dy + dz * dz + this.soft2[i];
      const invR = 1 / Math.sqrt(r2);
      const invR5 = invR * invR * invR * invR * invR;
      const k = this.k[i] * invR5;
      out.bx += k * (-3 * dz * dx);
      out.by += k * (-3 * dz * dy);
      out.bz += k * (r2 - 3 * dz * dz);
    }
  }

  private grow(): void {
    const size = this.x.length * 2;
    const grow = (a: Float64Array) => {
      const next = new Float64Array(size);
      next.set(a);
      return next;
    };
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.z = grow(this.z);
    this.soft2 = grow(this.soft2);
    this.k = grow(this.k);
  }
}

/** Exact direct summation over all bodies. */
export class DirectSolver implements FieldSolver {
  readonly name = 'direct';
  private x = new Float64Array(0);
  private y = new Float64Array(0);
  private z = new Float64Array(0);
  private mu = new Float64Array(0);
  private soft2 = new Float64Array(0);
  private n = 0;
  private readonly spins: SpinSet;
  private readonly compacts: CompactSet;

  constructor(c: number) {
    this.spins = new SpinSet(1 / (c * c));
    this.compacts = new CompactSet(1 / (c * c));
  }

  addStrong(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    out: Accel,
  ): void {
    this.compacts.add(x, y, z, vx, vy, vz, out);
  }

  build(bodies: readonly Body[]): void {
    const n = bodies.length;
    if (this.x.length < n) {
      const size = Math.max(16, n * 2);
      this.x = new Float64Array(size);
      this.y = new Float64Array(size);
      this.z = new Float64Array(size);
      this.mu = new Float64Array(size);
      this.soft2 = new Float64Array(size);
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      this.x[i] = b.x;
      this.y[i] = b.y;
      this.z[i] = b.z;
      this.mu[i] = b.mu;
      this.soft2[i] = b.soft * b.soft;
    }
    this.n = n;
    this.spins.build(bodies);
    this.compacts.build(bodies);
  }

  sample(px: number, py: number, pz: number, out: FieldSample): FieldSample {
    let phi = 0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = px - this.x[i];
      const dy = py - this.y[i];
      const dz = pz - this.z[i];
      const r2 = dx * dx + dy * dy + dz * dz + this.soft2[i];
      const invR = 1 / Math.sqrt(r2);
      const muInvR = this.mu[i] * invR;
      const f = muInvR * invR * invR;
      phi -= muInvR;
      gx -= dx * f;
      gy -= dy * f;
      gz -= dz * f;
    }
    out.phi = phi;
    out.gx = gx;
    out.gy = gy;
    out.gz = gz;
    out.bx = 0;
    out.by = 0;
    out.bz = 0;
    this.spins.addB(px, py, pz, out);
    return out;
  }
}

const MAX_DEPTH = 24;

/**
 * Barnes-Hut octree stored in flat typed arrays. Nodes are allocated in
 * blocks of eight children; leaves hold at most one body except at
 * `MAX_DEPTH`, where coincident bodies share a leaf as an aggregate.
 */
export class TreeSolver implements FieldSolver {
  readonly name = 'tree';
  private cap = 0;
  private count = 0;
  // Geometry.
  private cx = new Float64Array(0);
  private cy = new Float64Array(0);
  private cz = new Float64Array(0);
  private half = new Float64Array(0);
  // Mass moments.
  private mx = new Float64Array(0);
  private my = new Float64Array(0);
  private mz = new Float64Array(0);
  private mu = new Float64Array(0);
  private soft = new Float64Array(0);
  /** Distance from the node's geometric centre to its centre of mass. */
  private off = new Float64Array(0);
  /** First child index, or -1 for a leaf. */
  private child = new Int32Array(0);
  /** Head of the body chain for a leaf, -1 when empty. */
  private body = new Int32Array(0);
  /** Next body in a leaf chain (coincident bodies at max depth), or -1. */
  private next = new Int32Array(0);
  private bodies: readonly Body[] = [];
  private readonly stack = new Int32Array(MAX_DEPTH * 8 + 8);
  private readonly invTheta: number;
  private readonly spins: SpinSet;
  private readonly compacts: CompactSet;

  constructor(c: number, theta: number) {
    this.invTheta = 1 / theta;
    this.spins = new SpinSet(1 / (c * c));
    this.compacts = new CompactSet(1 / (c * c));
  }

  addStrong(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    out: Accel,
  ): void {
    this.compacts.add(x, y, z, vx, vy, vz, out);
  }

  build(bodies: readonly Body[]): void {
    this.bodies = bodies;
    this.spins.build(bodies);
    this.compacts.build(bodies);
    this.ensure(Math.max(64, bodies.length * 16 + 1));
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const b of bodies) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.z < minZ) minZ = b.z;
      if (b.x > maxX) maxX = b.x;
      if (b.y > maxY) maxY = b.y;
      if (b.z > maxZ) maxZ = b.z;
    }
    this.count = 0;
    if (bodies.length === 0) return;
    if (this.next.length < bodies.length) {
      this.next = new Int32Array(bodies.length * 2);
    }
    this.next.fill(-1, 0, bodies.length);
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    this.alloc(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
      size / 2 + 1,
    );
    for (let i = 0; i < bodies.length; i++) this.insert(i);
    this.summarize(0);
  }

  sample(px: number, py: number, pz: number, out: FieldSample): FieldSample {
    out.phi = 0;
    out.gx = 0;
    out.gy = 0;
    out.gz = 0;
    out.bx = 0;
    out.by = 0;
    out.bz = 0;
    if (this.count === 0) return out;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const n = stack[--top];
      const mu = this.mu[n];
      if (mu === 0) continue;
      const dx = px - this.mx[n];
      const dy = py - this.my[n];
      const dz = pz - this.mz[n];
      const d2 = dx * dx + dy * dy + dz * dz;
      const width = this.half[n] * 2;
      const first = this.child[n];
      // Open a node that looks too wide, or whose softened bodies are close
      // enough that their individual softening lengths matter.
      // Salmon-Warren: account for the centre of mass sitting off-centre.
      const open = width * this.invTheta + this.off[n];
      const reach = width + 2 * this.soft[n];
      if (first >= 0 && (d2 < open * open || d2 < reach * reach)) {
        for (let k = 0; k < 8; k++) stack[top++] = first + k;
        continue;
      }
      const s = this.soft[n];
      const r2 = d2 + s * s;
      const invR = 1 / Math.sqrt(r2);
      const muInvR = mu * invR;
      const f = muInvR * invR * invR;
      out.phi -= muInvR;
      out.gx -= dx * f;
      out.gy -= dy * f;
      out.gz -= dz * f;
    }
    this.spins.addB(px, py, pz, out);
    return out;
  }

  private ensure(cap: number): void {
    if (this.cap >= cap) return;
    this.cap = cap;
    this.cx = new Float64Array(cap);
    this.cy = new Float64Array(cap);
    this.cz = new Float64Array(cap);
    this.half = new Float64Array(cap);
    this.mx = new Float64Array(cap);
    this.my = new Float64Array(cap);
    this.mz = new Float64Array(cap);
    this.mu = new Float64Array(cap);
    this.soft = new Float64Array(cap);
    this.off = new Float64Array(cap);
    this.child = new Int32Array(cap);
    this.body = new Int32Array(cap);
  }

  private growTo(cap: number): void {
    const old = {
      cx: this.cx,
      cy: this.cy,
      cz: this.cz,
      half: this.half,
      mx: this.mx,
      my: this.my,
      mz: this.mz,
      mu: this.mu,
      soft: this.soft,
      off: this.off,
      child: this.child,
      body: this.body,
    };
    this.cap = 0;
    this.ensure(cap);
    this.cx.set(old.cx);
    this.cy.set(old.cy);
    this.cz.set(old.cz);
    this.half.set(old.half);
    this.mx.set(old.mx);
    this.my.set(old.my);
    this.mz.set(old.mz);
    this.mu.set(old.mu);
    this.soft.set(old.soft);
    this.off.set(old.off);
    this.child.set(old.child);
    this.body.set(old.body);
  }

  private alloc(x: number, y: number, z: number, half: number): number {
    if (this.count >= this.cap) this.growTo(this.cap * 2);
    const n = this.count++;
    this.cx[n] = x;
    this.cy[n] = y;
    this.cz[n] = z;
    this.half[n] = half;
    this.child[n] = -1;
    this.body[n] = -1;
    this.mu[n] = 0;
    return n;
  }

  private split(n: number): void {
    if (this.count + 8 > this.cap) this.growTo(this.cap * 2);
    const h = this.half[n] / 2;
    const first = this.count;
    for (let k = 0; k < 8; k++) {
      this.alloc(
        this.cx[n] + (k & 1 ? h : -h),
        this.cy[n] + (k & 2 ? h : -h),
        this.cz[n] + (k & 4 ? h : -h),
        h,
      );
    }
    this.child[n] = first;
  }

  private octant(n: number, b: Body): number {
    return (
      (b.x >= this.cx[n] ? 1 : 0) |
      (b.y >= this.cy[n] ? 2 : 0) |
      (b.z >= this.cz[n] ? 4 : 0)
    );
  }

  private insert(i: number): void {
    const b = this.bodies[i];
    let n = 0;
    for (let depth = 0; ; depth++) {
      if (this.child[n] >= 0) {
        n = this.child[n] + this.octant(n, b);
        continue;
      }
      if (this.body[n] < 0) {
        this.body[n] = i;
        return;
      }
      if (depth >= MAX_DEPTH) {
        // Coincident bodies share the leaf as a linked chain.
        this.next[i] = this.body[n];
        this.body[n] = i;
        return;
      }
      const prev = this.body[n];
      this.body[n] = -1;
      this.split(n);
      const pb = this.bodies[prev];
      const pc = this.child[n] + this.octant(n, pb);
      this.body[pc] = prev;
    }
  }

  private summarize(n: number): void {
    const first = this.child[n];
    let mu = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    let soft = 0;
    if (first < 0) {
      for (let i = this.body[n]; i >= 0; i = this.next[i]) {
        const b = this.bodies[i];
        mu += b.mu;
        x += b.x * b.mu;
        y += b.y * b.mu;
        z += b.z * b.mu;
        soft += b.soft * b.soft * b.mu;
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const c = first + k;
        this.summarize(c);
        const cm = this.mu[c];
        if (cm === 0) continue;
        mu += cm;
        x += this.mx[c] * cm;
        y += this.my[c] * cm;
        z += this.mz[c] * cm;
        soft += this.soft[c] * this.soft[c] * cm;
      }
    }
    this.mu[n] = mu;
    if (mu > 0) {
      this.mx[n] = x / mu;
      this.my[n] = y / mu;
      this.mz[n] = z / mu;
      this.off[n] = Math.hypot(
        this.mx[n] - this.cx[n],
        this.my[n] - this.cy[n],
        this.mz[n] - this.cz[n],
      );
    }
    // Mass-weighted RMS softening of the bodies below this node.
    this.soft[n] = mu > 0 ? Math.sqrt(soft / mu) : 0;
  }
}

/**
 * Chooses `DirectSolver` or `TreeSolver` on every build by body count, so the
 * fastest algorithm is used as the world grows and shrinks.
 */
export class AutoSolver implements FieldSolver {
  private readonly direct: DirectSolver;
  private readonly tree: TreeSolver;
  private active: FieldSolver;

  constructor(
    c: number,
    theta: number,
    private readonly threshold: number,
  ) {
    this.direct = new DirectSolver(c);
    this.tree = new TreeSolver(c, theta);
    this.active = this.direct;
  }

  get name(): string {
    return this.active.name;
  }

  build(bodies: readonly Body[]): void {
    this.active = bodies.length > this.threshold ? this.tree : this.direct;
    this.active.build(bodies);
  }

  sample(x: number, y: number, z: number, out: FieldSample): FieldSample {
    return this.active.sample(x, y, z, out);
  }

  addStrong(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    out: Accel,
  ): void {
    this.active.addStrong(x, y, z, vx, vy, vz, out);
  }
}
