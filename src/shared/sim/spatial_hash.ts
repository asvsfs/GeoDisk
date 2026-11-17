/**
 * @fileoverview Allocation-free spatial hash for broad-phase overlap queries.
 *
 * Bodies are binned into a hashed uniform grid using a counting sort, so a
 * rebuild is O(N) and a neighbourhood query touches only nearby cells.
 */

import type {Body} from '../types';

const TABLE_BITS = 10;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;

function hashCell(ix: number, iy: number, iz: number): number {
  return (
    (Math.imul(ix, 0x8da6b343) ^
      Math.imul(iy, 0xd8163841) ^
      Math.imul(iz, 0xcb1ab31f)) &
    TABLE_MASK
  );
}

/** Hashed grid of body indices. */
export class SpatialHash {
  private readonly start = new Int32Array(TABLE_SIZE + 1);
  private items = new Int32Array(64);
  private cellOf = new Int32Array(64);
  private bodies: readonly Body[] = [];
  private cell = 1;
  /** Largest body radius in the current build. */
  maxRadius = 0;

  /** Rebuilds the grid for `bodies`. */
  build(bodies: readonly Body[]): void {
    this.bodies = bodies;
    const n = bodies.length;
    if (this.items.length < n) {
      this.items = new Int32Array(n * 2);
      this.cellOf = new Int32Array(n * 2);
    }
    let maxR = 1;
    for (const b of bodies) if (b.radius > maxR) maxR = b.radius;
    this.maxRadius = maxR;
    this.cell = maxR * 2;
    const start = this.start;
    start.fill(0);
    const inv = 1 / this.cell;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      const h = hashCell(
        Math.floor(b.x * inv),
        Math.floor(b.y * inv),
        Math.floor(b.z * inv),
      );
      this.cellOf[i] = h;
      start[h]++;
    }
    let sum = 0;
    for (let h = 0; h < TABLE_SIZE; h++) {
      sum += start[h];
      start[h] = sum;
    }
    start[TABLE_SIZE] = sum;
    for (let i = 0; i < n; i++) {
      this.items[--start[this.cellOf[i]]] = i;
    }
  }

  /**
   * Calls `visit(index)` for every body that may overlap a sphere of radius
   * `r` at (x, y, z). Candidates may include false positives; callers do the
   * exact test. Return `true` from `visit` to stop early.
   */
  query(
    x: number,
    y: number,
    z: number,
    r: number,
    visit: (index: number) => boolean | void,
  ): void {
    const inv = 1 / this.cell;
    const reach = r + this.maxRadius;
    const x0 = Math.floor((x - reach) * inv);
    const x1 = Math.floor((x + reach) * inv);
    const y0 = Math.floor((y - reach) * inv);
    const y1 = Math.floor((y + reach) * inv);
    const z0 = Math.floor((z - reach) * inv);
    const z1 = Math.floor((z + reach) * inv);
    // Distinct cells can collide in the table; dedupe visited buckets.
    let seen0 = -1;
    let seen1 = -1;
    let seen2 = -1;
    let seenMany: Set<number> | null = null;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const h = hashCell(ix, iy, iz);
          if (h === seen0 || h === seen1 || h === seen2) continue;
          if (seenMany) {
            if (seenMany.has(h)) continue;
            seenMany.add(h);
          } else if (seen0 < 0) {
            seen0 = h;
          } else if (seen1 < 0) {
            seen1 = h;
          } else if (seen2 < 0) {
            seen2 = h;
          } else {
            seenMany = new Set([seen0, seen1, seen2, h]);
          }
          for (let k = this.start[h]; k < this.start[h + 1]; k++) {
            if (visit(this.items[k])) return;
          }
        }
      }
    }
  }

  /** Body at `index` in the last build. */
  get(index: number): Body {
    return this.bodies[index];
  }
}
