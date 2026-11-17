/**
 * @fileoverview Server configuration from environment variables.
 *
 *   MAX_BODIES, MAX_SATS, MAX_SATS_PER_PLAYER, MAX_PLAYERS  hard caps
 *   CPU_SHARE        share of one core the room may use (0..1, default 0.5)
 *   MIN_SNAP_HZ      lowest snapshot rate under load (default 15)
 *   SNAP_HZ          highest snapshot rate (default 30)
 *   MAX_UPLOAD_MBPS  upstream budget in Mbit/s (default 0 = unlimited)
 *   AUTO_LIMITS=1    calibrate this host at startup and derive the caps
 */

import {
  DEFAULT_CONFIG,
  mergeConfig,
  type GameConfig,
  type Limits,
} from '../shared/config';

/** Parsed configuration plus which limits were set explicitly. */
export interface EnvConfig {
  cfg: GameConfig;
  /** Caps the operator set by hand; calibration never overrides these. */
  explicit: Partial<Limits>;
  autoLimits: boolean;
}

/** Reads a positive number, or undefined when unset or invalid. */
export function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Builds the room configuration from the environment. */
export function readEnv(): EnvConfig {
  const explicit: Partial<Limits> = {};
  const set = <K extends keyof Limits>(key: K, env: string, int = true) => {
    const v = envNum(env);
    if (v !== undefined) explicit[key] = (int ? Math.floor(v) : v) as Limits[K];
  };
  set('maxBodies', 'MAX_BODIES');
  set('maxSats', 'MAX_SATS');
  set('maxSatsPerPlayer', 'MAX_SATS_PER_PLAYER');
  set('maxPlayers', 'MAX_PLAYERS');
  set('minSnapHz', 'MIN_SNAP_HZ');
  set('cpuShare', 'CPU_SHARE', false);
  set('maxUploadMbps', 'MAX_UPLOAD_MBPS', false);
  if (explicit.cpuShare !== undefined) {
    explicit.cpuShare = Math.min(1, Math.max(0.05, explicit.cpuShare));
  }
  const snapHz = envNum('SNAP_HZ');
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    limits: explicit,
    world: snapHz ? {snapHz: Math.min(60, Math.max(5, snapHz))} : {},
  });
  return {cfg, explicit, autoLimits: process.env.AUTO_LIMITS === '1'};
}
