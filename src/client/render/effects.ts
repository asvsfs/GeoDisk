/**
 * @fileoverview Visual effects: a zero-allocation particle pool and expanding
 * shock rings, driven by world events.
 */

import {EventKind, type WorldEvent} from '../../shared/types';
import type {Viewport} from './camera';

const PALETTE = [
  [34, 211, 238],
  [245, 158, 11],
  [254, 243, 199],
  [148, 163, 184],
] as const;

/** Particle colours. */
export enum Tint {
  CYAN = 0,
  AMBER = 1,
  WHITE = 2,
  GREY = 3,
}

interface Ring {
  x: number;
  y: number;
  radius: number;
  age: number;
  life: number;
  tint: Tint;
}

/** Fixed-capacity particles plus shock rings. */
export class Effects {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly tint: Uint8Array;
  private cursor = 0;
  private rings: Ring[] = [];
  /** Screen-shake energy, 0..1. */
  trauma = 0;

  constructor(private readonly capacity = 900) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.tint = new Uint8Array(capacity);
  }

  /** Spawns one particle. */
  spark(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    tint: Tint,
  ): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.tint[i] = tint;
  }

  /** Radial burst of `count` particles. */
  burst(
    x: number,
    y: number,
    count: number,
    speed: number,
    life: number,
    size: number,
    tint: Tint,
  ): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spark(
        x,
        y,
        Math.cos(a) * s,
        Math.sin(a) * s,
        life * (0.6 + Math.random() * 0.4),
        size,
        tint,
      );
    }
  }

  /** Expanding ring reaching `radius` world units over `life` seconds. */
  ring(x: number, y: number, radius: number, life: number, tint: Tint): void {
    this.rings.push({x, y, radius, age: 0, life, tint});
  }

  /** Turns server events into effects. */
  apply(events: readonly WorldEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case EventKind.NOVA:
          this.ring(e.x, e.y, e.size, 2.4, Tint.WHITE);
          this.ring(e.x, e.y, e.size * 0.6, 1.6, Tint.AMBER);
          this.burst(e.x, e.y, 160, 520, 2.2, 5, Tint.AMBER);
          this.burst(e.x, e.y, 60, 260, 1.4, 7, Tint.WHITE);
          this.trauma = Math.min(1, this.trauma + 0.8);
          break;
        case EventKind.TYPE_IA:
          this.ring(e.x, e.y, e.size, 2.0, Tint.WHITE);
          this.burst(e.x, e.y, 180, 600, 2.0, 5, Tint.WHITE);
          this.trauma = Math.min(1, this.trauma + 0.8);
          break;
        case EventKind.NEBULA:
          this.ring(e.x, e.y, e.size, 3.5, Tint.CYAN);
          this.ring(e.x, e.y, e.size * 0.7, 3.0, Tint.AMBER);
          this.burst(e.x, e.y, 80, 120, 3.5, 4, Tint.CYAN);
          break;
        case EventKind.KILONOVA:
          this.ring(e.x, e.y, 420, 1.4, Tint.AMBER);
          this.burst(e.x, e.y, 90, 420, 1.6, 4, Tint.AMBER);
          this.trauma = Math.min(1, this.trauma + 0.5);
          break;
        case EventKind.FISSION:
          this.burst(e.x, e.y, 40, 200, 1.0, 3, Tint.GREY);
          this.ring(e.x, e.y, 140, 0.8, Tint.CYAN);
          break;
        case EventKind.SHATTER:
          this.burst(e.x, e.y, 70, 260, 1.1, 3.5, Tint.AMBER);
          this.burst(e.x, e.y, 30, 140, 1.6, 4, Tint.GREY);
          this.ring(e.x, e.y, 120, 0.6, Tint.AMBER);
          this.trauma = Math.min(1, this.trauma + 0.35);
          break;
        case EventKind.MERGE:
          this.burst(e.x, e.y, 16, 120, 0.6, 3, Tint.CYAN);
          break;
        case EventKind.IGNITE:
          this.ring(e.x, e.y, 220, 1.2, Tint.AMBER);
          break;
        case EventKind.COLLAPSE:
          this.ring(e.x, e.y, 260, 1.0, Tint.CYAN);
          break;
        case EventKind.CRASH:
          this.burst(e.x, e.y, 14, 120, 0.5, 2.5, Tint.WHITE);
          break;
        case EventKind.SPAWN:
          this.ring(e.x, e.y, 90, 0.7, Tint.CYAN);
          break;
        default:
          break;
      }
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.vx[i] *= 0.985;
      this.vy[i] *= 0.985;
    }
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter(r => r.age < r.life);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
  }

  render(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const k = r.age / r.life;
      const [cr, cg, cb] = PALETTE[r.tint];
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(1 - k) * 0.7})`;
      ctx.lineWidth = Math.max(1, 6 * (1 - k));
      ctx.beginPath();
      ctx.arc(
        vp.offsetX + r.x * vp.scale,
        vp.offsetY + r.y * vp.scale,
        r.radius * k * vp.scale,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    for (let i = 0; i < this.capacity; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const a = l / this.maxLife[i];
      const [cr, cg, cb] = PALETTE[this.tint[i]];
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * 0.9})`;
      const r = Math.max(
        1,
        this.size[i] * Math.max(0.35, vp.scale) * (0.4 + 0.6 * a),
      );
      ctx.fillRect(
        vp.offsetX + this.x[i] * vp.scale - r / 2,
        vp.offsetY + this.y[i] * vp.scale - r / 2,
        r,
        r,
      );
    }
    ctx.restore();
  }
}
