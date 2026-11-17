/**
 * @fileoverview World state and the step pipeline.
 *
 * The world owns bodies, satellites and the per-step event list. Behaviour
 * lives in `System`s that run in order every step, so rules can be added,
 * removed or swapped without touching the world itself.
 */

import type {GameConfig} from '../config';
import {EventKind, type Body, type Sat, type WorldEvent} from '../types';
import {makeBody, type BodyInit} from './bodies';
import {AutoSolver, type FieldSolver} from './gravity';
import {Rng} from './rng';
import {SpatialHash} from './spatial_hash';

/** One stage of the step pipeline. */
export interface System {
  readonly name: string;
  run(world: World, dt: number): void;
}

/** The simulated universe of one room. */
export class World {
  bodies: Body[] = [];
  sats: Sat[] = [];
  /** Simulated seconds since creation. */
  time = 0;
  /** Steps since creation. */
  tick = 0;
  /** Events raised during steps; the owner drains them. */
  readonly events: WorldEvent[] = [];
  /** Gravity field of the bodies at their current positions. */
  readonly field: FieldSolver;
  /** Broad-phase index of the bodies at their current positions. */
  readonly hash = new SpatialHash();
  readonly rng: Rng;
  /** Effective caps; a budget may lower them below the configured limits. */
  bodyCap: number;
  satCap: number;
  /**
   * Slots held by bodies already doomed this step but not yet removed, so
   * replacements (remnants, fragments) may be created before compaction.
   */
  pendingFree = 0;
  /**
   * Mass that has left the universe: bodies that escaped and bodies absorbed
   * by permanent ones. Bodies plus this always equal what was ever added.
   */
  lostMu = 0;
  private nextId = 1;

  constructor(
    readonly cfg: GameConfig,
    private readonly systems: readonly System[],
    seed = 1,
  ) {
    this.field = new AutoSolver(
      cfg.world.c,
      cfg.physics.theta,
      cfg.physics.treeThreshold,
    );
    this.rng = new Rng(seed);
    this.bodyCap = cfg.limits.maxBodies;
    this.satCap = cfg.limits.maxSats;
  }

  /** Advances the world by one fixed step. */
  step(): void {
    const dt = this.cfg.world.dt;
    for (const s of this.systems) s.run(this, dt);
    this.time += dt;
    this.tick++;
  }

  /** Allocates a unique entity id. */
  newId(): number {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0 || 1;
    return id;
  }

  /** Free body slots under the effective cap. */
  freeBodies(): number {
    return Math.max(0, this.bodyCap - this.bodies.length + this.pendingFree);
  }

  /** Adds a body if a slot is free; returns it, or null at the cap. */
  addBody(init: BodyInit): Body | null {
    if (this.freeBodies() <= 0) return null;
    const b = makeBody(this.newId(), init, this.cfg.physics);
    this.bodies.push(b);
    return b;
  }

  /** Finds a body by id. */
  body(id: number): Body | undefined {
    for (const b of this.bodies) if (b.id === id) return b;
    return undefined;
  }

  /** Records an event for this step. */
  emit(
    kind: EventKind,
    x: number,
    y: number,
    z: number,
    size: number,
    ref = 0,
  ): void {
    this.events.push({kind, x, y, z, size, ref});
  }
}
