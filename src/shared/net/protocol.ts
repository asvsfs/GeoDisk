/**
 * @fileoverview Binary game protocol.
 *
 * Every message starts with a u8 type. Field layouts are append-only: a newer
 * peer may add trailing fields, and decoders ignore bytes they do not know.
 * Breaking changes bump `PROTOCOL_VERSION`, which the server checks in HELLO.
 */

import {mergeConfig, DEFAULT_CONFIG, type GameConfig} from '../config';
import {softFor} from '../sim/bodies';
import {
  BODY_KINDS,
  SPAWN_KINDS,
  type Body,
  type EventKind,
  type Sat,
  type SpawnKind,
  type WorldEvent,
} from '../types';
import {Reader, Writer} from './codec';

/** Incremented on incompatible wire changes. */
export const PROTOCOL_VERSION = 2;

/** Message type codes. Client-to-server < 64 <= server-to-client. */
export enum Msg {
  HELLO = 1,
  LAUNCH = 2,
  SPAWN = 3,
  PING = 4,
  HOME = 5,
  WELCOME = 64,
  REJECT = 65,
  PLAYERS = 66,
  SNAP = 67,
  EVENTS = 68,
  PONG = 69,
}

/** Why the server refused a request. */
export enum Reject {
  VERSION = 1,
  FULL = 2,
  COOLDOWN = 3,
  SAT_CAP = 4,
  BODY_CAP = 5,
  NO_HOME = 6,
  BAD_SPOT = 7,
  BAD_INPUT = 8,
}

/** Velocity quantisation: i16 units per world unit per second. */
const VEL_SCALE = 10;
/** Life sent as whole seconds; this value means "forever". */
const LIFE_FOREVER = 0xffff;

// ---------------------------------------------------------------- Messages

/** Client greeting. */
export interface Hello {
  type: Msg.HELLO;
  version: number;
  name: string;
}

/** Launch a satellite from the sender's home planet. */
export interface Launch {
  type: Msg.LAUNCH;
  /** Heading in the x-y plane, radians. */
  angle: number;
  /** Elevation out of the plane, radians. */
  pitch: number;
  /** Speed relative to the home planet. */
  speed: number;
}

/** Spawn a body. */
export interface Spawn {
  type: Msg.SPAWN;
  kind: SpawnKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Requested mass (mu); clamped by the server to the kind's range. */
  mu: number;
  /** Requested radius; ignored for degenerate kinds, whose size is physics. */
  radius: number;
  /** Spin as a signed fraction of the body's limit, -1..1. */
  spin: number;
}

/** Latency probe; echoed as PONG. */
export interface Ping {
  type: Msg.PING;
  t: number;
}

/** Choose a different home planet. */
export interface Home {
  type: Msg.HOME;
  body: number;
}

/** Server greeting with the active configuration. */
export interface Welcome {
  type: Msg.WELCOME;
  version: number;
  you: number;
  config: GameConfig;
}

/** A refused request. */
export interface Rejected {
  type: Msg.REJECT;
  code: Reject;
  text: string;
}

/** Public view of a player. */
export interface PlayerInfo {
  id: number;
  color: number;
  home: number;
  name: string;
}

/** Full player roster. */
export interface Players {
  type: Msg.PLAYERS;
  players: PlayerInfo[];
}

/**
 * World state at one tick. Per body: id u32, kind u8, flags u8 (bit 0
 * anchored, bit 1 permanent), position
 * 3 x f32, velocity 3 x i16, mu f32, radius f32, spin f32, life u16.
 */
export interface Snap {
  type: Msg.SNAP;
  tick: number;
  time: number;
  /** Effective caps at this tick (may be below configured limits). */
  bodyCap: number;
  satCap: number;
  bodies: Body[];
  sats: Sat[];
}

/** Events since the previous EVENTS message. */
export interface Events {
  type: Msg.EVENTS;
  events: WorldEvent[];
}

/** Echo of a PING. */
export interface Pong {
  type: Msg.PONG;
  t: number;
}

/** Messages a client sends. */
export type ClientMsg = Hello | Launch | Spawn | Ping | Home;
/** Messages the server sends. */
export type ServerMsg = Welcome | Rejected | Players | Snap | Events | Pong;

// ---------------------------------------------------------------- Encoding

/** Encodes any protocol message. */
export function encode(m: ClientMsg | ServerMsg): Uint8Array {
  const w = new Writer(m.type === Msg.SNAP ? 1024 : 64);
  w.u8(m.type);
  switch (m.type) {
    case Msg.HELLO:
      w.u16(m.version).str(m.name);
      break;
    case Msg.LAUNCH:
      w.f32(m.angle).f32(m.pitch).f32(m.speed);
      break;
    case Msg.SPAWN:
      w.u8(SPAWN_KINDS.indexOf(m.kind)).f32(m.x).f32(m.y).f32(m.vx).f32(m.vy);
      w.f32(m.mu).f32(m.radius).f32(m.spin);
      break;
    case Msg.PING:
    case Msg.PONG:
      w.f64(m.t);
      break;
    case Msg.HOME:
      w.u32(m.body);
      break;
    case Msg.WELCOME:
      w.u16(m.version).u32(m.you).text(JSON.stringify(m.config));
      break;
    case Msg.REJECT:
      w.u8(m.code).str(m.text);
      break;
    case Msg.PLAYERS:
      w.u8(m.players.length);
      for (const p of m.players)
        w.u32(p.id).u8(p.color).u32(p.home).str(p.name);
      break;
    case Msg.SNAP:
      writeSnap(w, m);
      break;
    case Msg.EVENTS:
      w.u16(m.events.length);
      for (const e of m.events) {
        w.u8(e.kind).f32(e.x).f32(e.y).f32(e.z).f32(e.size).u32(e.ref);
      }
      break;
  }
  return w.done();
}

function writeSnap(w: Writer, m: Snap): void {
  w.u32(m.tick).f64(m.time).u16(m.bodyCap).u16(m.satCap);
  w.u16(m.bodies.length);
  for (const b of m.bodies) {
    w.u32(b.id)
      .u8(BODY_KINDS.indexOf(b.kind))
      .u8((b.fixed ? 1 : 0) | (b.permanent ? 2 : 0));
    w.f32(b.x).f32(b.y).f32(b.z);
    w.i16(b.vx * VEL_SCALE)
      .i16(b.vy * VEL_SCALE)
      .i16(b.vz * VEL_SCALE);
    w.f32(b.mu).f32(b.radius).f32(b.spin);
    w.u16(
      Number.isFinite(b.life)
        ? Math.min(LIFE_FOREVER - 1, Math.max(0, b.life))
        : LIFE_FOREVER,
    );
  }
  w.u16(m.sats.length);
  for (const s of m.sats) {
    w.u32(s.id).u16(s.owner);
    w.f32(s.x).f32(s.y).f32(s.z);
    w.i16(s.vx * VEL_SCALE)
      .i16(s.vy * VEL_SCALE)
      .i16(s.vz * VEL_SCALE);
  }
}

// ---------------------------------------------------------------- Decoding

/** Decodes a client message; throws `DecodeError` on malformed input. */
export function decodeClient(data: Uint8Array): ClientMsg {
  const r = new Reader(data);
  const type = r.u8();
  switch (type) {
    case Msg.HELLO:
      return {type, version: r.u16(), name: r.str()};
    case Msg.LAUNCH:
      return {type, angle: r.f32(), pitch: r.f32(), speed: r.f32()};
    case Msg.SPAWN: {
      const kind = SPAWN_KINDS[r.u8()];
      if (!kind) throw new RangeError('unknown spawn kind');
      return {
        type,
        kind,
        x: r.f32(),
        y: r.f32(),
        vx: r.f32(),
        vy: r.f32(),
        mu: r.f32(),
        radius: r.f32(),
        spin: r.f32(),
      };
    }
    case Msg.PING:
      return {type, t: r.f64()};
    case Msg.HOME:
      return {type, body: r.u32()};
    default:
      throw new RangeError(`unknown client message ${type}`);
  }
}

/** Decodes a server message; throws on malformed input. */
export function decodeServer(data: Uint8Array): ServerMsg {
  const r = new Reader(data);
  const type = r.u8();
  switch (type) {
    case Msg.WELCOME: {
      const version = r.u16();
      const you = r.u32();
      const patch = JSON.parse(r.text()) as Partial<GameConfig>;
      return {type, version, you, config: mergeConfig(DEFAULT_CONFIG, patch)};
    }
    case Msg.REJECT:
      return {type, code: r.u8(), text: r.str()};
    case Msg.PLAYERS: {
      const n = r.u8();
      const players: PlayerInfo[] = [];
      for (let i = 0; i < n; i++) {
        players.push({
          id: r.u32(),
          color: r.u8(),
          home: r.u32(),
          name: r.str(),
        });
      }
      return {type, players};
    }
    case Msg.SNAP:
      return readSnap(r);
    case Msg.EVENTS: {
      const n = r.u16();
      const events: WorldEvent[] = [];
      for (let i = 0; i < n; i++) {
        events.push({
          kind: r.u8() as EventKind,
          x: r.f32(),
          y: r.f32(),
          z: r.f32(),
          size: r.f32(),
          ref: r.u32(),
        });
      }
      return {type, events};
    }
    case Msg.PONG:
      return {type, t: r.f64()};
    default:
      throw new RangeError(`unknown server message ${type}`);
  }
}

function readSnap(r: Reader): Snap {
  const tick = r.u32();
  const time = r.f64();
  const bodyCap = r.u16();
  const satCap = r.u16();
  const nb = r.u16();
  const bodies: Body[] = new Array(nb);
  for (let i = 0; i < nb; i++) {
    const id = r.u32();
    const kind = BODY_KINDS[r.u8()] ?? 'rock';
    const flags = r.u8();
    const x = r.f32();
    const y = r.f32();
    const z = r.f32();
    const vx = r.i16() / VEL_SCALE;
    const vy = r.i16() / VEL_SCALE;
    const vz = r.i16() / VEL_SCALE;
    const mu = r.f32();
    const radius = r.f32();
    const spin = r.f32();
    const life = r.u16();
    bodies[i] = {
      id,
      kind,
      x,
      y,
      z,
      vx,
      vy,
      vz,
      ax: 0,
      ay: 0,
      az: 0,
      mu,
      radius,
      soft: softFor(kind, radius),
      spin,
      life: life === LIFE_FOREVER ? Infinity : life,
      fixed: (flags & 1) !== 0,
      permanent: (flags & 2) !== 0,
    };
  }
  const ns = r.u16();
  const sats: Sat[] = new Array(ns);
  for (let i = 0; i < ns; i++) {
    sats[i] = {
      id: r.u32(),
      owner: r.u16(),
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      vx: r.i16() / VEL_SCALE,
      vy: r.i16() / VEL_SCALE,
      vz: r.i16() / VEL_SCALE,
      age: 0,
    };
  }
  return {type: Msg.SNAP, tick, time, bodyCap, satCap, bodies, sats};
}
