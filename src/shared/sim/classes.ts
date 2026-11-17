/**
 * @fileoverview Astronomical classes derived from kind, mass, radius, spin
 * and speed.
 *
 * Classes are never sent on the wire: server and clients derive the same
 * class from the same state, so a merger that adds mass or angular momentum
 * changes what a body *is* (a yellow dwarf becoming a blue giant, a neutron
 * star spun up into a pulsar) without any extra protocol.
 */

import type {PhysicsConfig} from '../config';
import type {Body} from '../types';
import {breakupSpin, kerrSpin} from './bodies';

/** Every class a body can have. */
export type ClassId =
  | 'asteroid'
  | 'rocky-planet'
  | 'gas-giant'
  | 'brown-dwarf'
  | 'red-dwarf'
  | 'yellow-dwarf'
  | 'blue-giant'
  | 'supergiant'
  | 'white-dwarf'
  | 'neutron-star'
  | 'pulsar'
  | 'stellar-black-hole'
  | 'intermediate-black-hole'
  | 'supermassive-black-hole';

/** A body's class plus motion qualifiers. */
export interface BodyClass {
  id: ClassId;
  label: string;
  /** Spin as a fraction of its limit (breakup, or Kerr for black holes). */
  spinFrac: number;
  /** Extra descriptors such as "runaway" or "rapid rotator". */
  tags: string[];
}

const LABELS: Record<ClassId, string> = {
  asteroid: 'Asteroid',
  'rocky-planet': 'Rocky planet',
  'gas-giant': 'Gas giant',
  'brown-dwarf': 'Brown dwarf',
  'red-dwarf': 'Red dwarf',
  'yellow-dwarf': 'Yellow dwarf',
  'blue-giant': 'Blue giant',
  supergiant: 'Supergiant',
  'white-dwarf': 'White dwarf',
  'neutron-star': 'Neutron star',
  pulsar: 'Pulsar',
  'stellar-black-hole': 'Stellar black hole',
  'intermediate-black-hole': 'Intermediate black hole',
  'supermassive-black-hole': 'Supermassive black hole',
};

/** Classifies a body. `c` is the speed of light (for the Kerr limit). */
export function classify(
  b: Pick<
    Body,
    'kind' | 'mu' | 'radius' | 'spin' | 'vx' | 'vy' | 'vz' | 'fixed'
  >,
  cfg: PhysicsConfig,
  c: number,
): BodyClass {
  const limit =
    b.kind === 'hole' ? kerrSpin(b.mu, c) : breakupSpin(b.mu, b.radius);
  const spinFrac = limit > 0 ? Math.min(1, Math.abs(b.spin) / limit) : 0;
  const id = classId(b, cfg, spinFrac);
  const tags: string[] = [];
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  if (!b.fixed && speed > cfg.runawaySpeed && b.kind !== 'rock') {
    tags.push(b.kind === 'star' ? 'runaway star' : 'runaway');
  }
  if (b.kind === 'hole' && spinFrac > 0.1) {
    tags.push(`spin a* = ${spinFrac.toFixed(2)}`);
  } else if (spinFrac > 0.5 && b.kind !== 'compact') {
    tags.push('rapid rotator');
  }
  return {id, label: LABELS[id], spinFrac, tags};
}

function classId(
  b: Pick<Body, 'kind' | 'mu' | 'radius'>,
  cfg: PhysicsConfig,
  spinFrac: number,
): ClassId {
  switch (b.kind) {
    case 'rock':
      return 'asteroid';
    case 'planet': {
      if (b.mu >= cfg.starMu * cfg.brownDwarfFrac) return 'brown-dwarf';
      const density = b.mu / (b.radius * b.radius * b.radius);
      return density < cfg.gasDensity ? 'gas-giant' : 'rocky-planet';
    }
    case 'star':
      if (b.mu >= cfg.superMu) return 'supergiant';
      if (b.mu >= cfg.blueMu) return 'blue-giant';
      if (b.mu >= cfg.yellowMu) return 'yellow-dwarf';
      return 'red-dwarf';
    case 'white':
      return 'white-dwarf';
    case 'compact':
      return spinFrac >= cfg.pulsarSpin ? 'pulsar' : 'neutron-star';
    case 'hole':
      if (b.mu >= cfg.bigHoleMu) return 'supermassive-black-hole';
      if (b.mu >= cfg.midHoleMu) return 'intermediate-black-hole';
      return 'stellar-black-hole';
  }
}
