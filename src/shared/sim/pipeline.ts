/**
 * @fileoverview Default step pipeline and world factory.
 *
 * Order matters: bodies move first (building the field and hash), satellites
 * fly through that field, then contacts, stellar evolution and the walls run.
 * Nothing is ever spawned or deleted automatically: bodies only merge,
 * shatter, collapse or explode into pieces.
 * Swap, add or reorder systems here to change the game's rules.
 */

import type {GameConfig} from '../config';
import {Collisions} from './collide';
import {BodyMotion, SatMotion} from './motion';
import {GeodesicModel, type SatModel} from './sat_model';
import {seedWorld} from './scenario';
import {StellarEvolution} from './stars';
import {Walls} from './walls';
import {World, type System} from './world';

/** Builds the standard system list. */
export function defaultSystems(
  model: SatModel = new GeodesicModel(),
): System[] {
  return [
    new BodyMotion(),
    new SatMotion(model),
    new Collisions(),
    new StellarEvolution(),
    new Walls(),
  ];
}

/** Creates a seeded world with the default rules. */
export function createWorld(cfg: GameConfig, seed: number): World {
  const world = new World(cfg, defaultSystems(), seed);
  seedWorld(world);
  return world;
}
