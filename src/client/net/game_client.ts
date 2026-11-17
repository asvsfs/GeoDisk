/**
 * @fileoverview Client session: handshake, requests and snapshot
 * interpolation. Transport-agnostic and DOM-free, so it runs in tests too.
 */

import type {GameConfig} from '../../shared/config';
import {
  Msg,
  PROTOCOL_VERSION,
  decodeServer,
  encode,
  type ClientMsg,
  type PlayerInfo,
  type Rejected,
  type Snap,
  type Spawn,
} from '../../shared/net/protocol';
import {Delivery, type Connector, type Link} from '../../shared/net/transport';
import type {Body, Sat, WorldEvent} from '../../shared/types';

/** Interpolated world state for rendering. */
export interface View {
  time: number;
  bodies: Body[];
  sats: Sat[];
}

/** Callbacks for asynchronous server traffic. */
export interface ClientHandlers {
  onPlayers?(players: readonly PlayerInfo[]): void;
  onEvents?(events: readonly WorldEvent[]): void;
  onReject?(reject: Rejected): void;
  onClose?(reason: string): void;
}

/** Snapshots kept for interpolation. */
const BUFFER = 8;
/** Longest extrapolation past the newest snapshot, in seconds. */
const MAX_EXTRAPOLATE = 0.25;
/** Safety margin added to the adaptive render delay, in seconds. */
const DELAY_MARGIN = 0.004;
/** Per-snapshot decay of the lateness peak (forgets old jitter in ~2 s). */
const PEAK_DECAY = 0.98;
const PING_EVERY_MS = 2000;

/** A joined game session. */
export class GameClient {
  /** Snapshots ordered by tick. */
  private snaps: Snap[] = [];
  /** Smoothed (server time - local time) in seconds. */
  private offset = 0;
  private hasOffset = false;
  /** Decaying peak of how late snapshots arrive versus the best one (s). */
  private latePeak = 0;
  /** Current render delay behind the freshest server time (s). */
  private delay: number;
  /**
   * Measured server time between snapshots (s). The server may lower its
   * snapshot rate under load, so this is observed, not configured.
   */
  private interval: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  players: readonly PlayerInfo[] = [];
  /** Round-trip time in milliseconds. */
  rtt = 0;
  closed = false;

  private constructor(
    private readonly link: Link,
    readonly you: number,
    readonly config: GameConfig,
    private handlers: ClientHandlers,
    private readonly now: () => number,
  ) {
    this.delay = 2 / config.world.snapHz;
    this.interval = 1 / config.world.snapHz;
  }

  /** Replaces the callbacks for server traffic. */
  listen(handlers: ClientHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Connects, sends HELLO and resolves once the server welcomes the player.
   * Rejects with the server's reason if the join is refused.
   */
  static async join(
    connector: Connector,
    name: string,
    handlers: ClientHandlers = {},
    now: () => number = () => performance.now(),
  ): Promise<GameClient> {
    const link = await connector.connect();
    return new Promise<GameClient>((resolve, reject) => {
      let client: GameClient | null = null;
      const early: Uint8Array[] = [];
      link.listen({
        onMessage: data => {
          if (client) {
            client.receive(data);
            return;
          }
          let msg;
          try {
            msg = decodeServer(data);
          } catch {
            link.close('malformed message');
            return;
          }
          if (msg.type === Msg.WELCOME) {
            client = new GameClient(link, msg.you, msg.config, handlers, now);
            client.startPing();
            for (const m of early) client.receive(m);
            resolve(client);
          } else if (msg.type === Msg.REJECT) {
            reject(new Error(msg.text));
          } else {
            early.push(data);
          }
        },
        onClose: reason => {
          if (client) client.onClosed(reason);
          else reject(new Error(`connection closed: ${reason}`));
        },
      });
      link.send(
        encode({type: Msg.HELLO, version: PROTOCOL_VERSION, name}),
        Delivery.RELIABLE,
      );
    });
  }

  /** Launches a satellite from the home planet. */
  launch(angle: number, speed: number, pitch = 0): void {
    this.send({type: Msg.LAUNCH, angle, pitch, speed});
  }

  /** Places a body; the server clamps mass and radius to the kind's range. */
  spawn(spec: Omit<Spawn, 'type'>): void {
    this.send({type: Msg.SPAWN, ...spec});
  }

  /** Requests a different home planet. */
  setHome(body: number): void {
    this.send({type: Msg.HOME, body});
  }

  /** Closes the session. */
  leave(): void {
    this.link.close('left');
  }

  /** This player's public info, if listed. */
  me(): PlayerInfo | undefined {
    return this.players.find(p => p.id === this.you);
  }

  /** Newest snapshot, or null before the first arrives. */
  latest(): Snap | null {
    return this.snaps.length > 0 ? this.snaps[this.snaps.length - 1] : null;
  }

  /**
   * Interpolated state, rendered slightly behind the newest snapshot so
   * there is always a pair to blend between.
   */
  view(): View | null {
    const n = this.snaps.length;
    if (n === 0) return null;
    const t = this.now() / 1000 + this.offset - this.delay;
    const newest = this.snaps[n - 1];
    if (t >= newest.time || n === 1) {
      return extrapolate(
        newest,
        Math.min(MAX_EXTRAPOLATE, Math.max(0, t - newest.time)),
      );
    }
    let i = n - 2;
    while (i > 0 && this.snaps[i].time > t) i--;
    const a = this.snaps[i];
    const b = this.snaps[i + 1];
    if (t <= a.time) return extrapolate(a, 0);
    return blend(a, b, (t - a.time) / (b.time - a.time));
  }

  /**
   * Estimated server time at which a request sent now will be applied:
   * the freshest server time we know plus a round trip (the offset already
   * hides one one-way delay; the request needs another).
   */
  requestTime(): number {
    return this.now() / 1000 + this.offset + this.rtt / 1000;
  }

  /** Current interpolation delay in milliseconds (for diagnostics). */
  renderDelayMs(): number {
    return this.delay * 1000;
  }

  private send(msg: ClientMsg): void {
    if (!this.closed) this.link.send(encode(msg), Delivery.RELIABLE);
  }

  private startPing(): void {
    const ping = () => this.send({type: Msg.PING, t: this.now()});
    ping();
    this.pingTimer = setInterval(ping, PING_EVERY_MS);
  }

  private receive(data: Uint8Array): void {
    let msg;
    try {
      msg = decodeServer(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case Msg.SNAP:
        this.addSnap(msg);
        break;
      case Msg.PLAYERS:
        this.players = msg.players;
        this.handlers.onPlayers?.(msg.players);
        break;
      case Msg.EVENTS:
        this.handlers.onEvents?.(msg.events);
        break;
      case Msg.REJECT:
        this.handlers.onReject?.(msg);
        break;
      case Msg.PONG:
        this.rtt =
          this.rtt === 0
            ? this.now() - msg.t
            : this.rtt * 0.7 + (this.now() - msg.t) * 0.3;
        break;
      case Msg.WELCOME:
        break;
    }
  }

  private addSnap(s: Snap): void {
    const last = this.latest();
    if (last && s.tick <= last.tick) return;
    if (last) {
      const gap = Math.min(0.5, s.time - last.time);
      this.interval += (gap - this.interval) * 0.2;
    }
    this.snaps.push(s);
    if (this.snaps.length > BUFFER) this.snaps.shift();
    const sample = s.time - this.now() / 1000;
    if (!this.hasOffset) {
      this.offset = sample;
      this.hasOffset = true;
    } else {
      // Track the earliest-arriving (least delayed) snapshots, drift slowly.
      this.offset =
        sample > this.offset
          ? sample
          : this.offset + (sample - this.offset) * 0.05;
    }
    // Render just far enough behind to have the next snapshot in hand: one
    // interval plus the recent worst lateness, eased to avoid time jumps.
    const interval = this.interval;
    this.latePeak = Math.max(this.offset - sample, this.latePeak * PEAK_DECAY);
    const target = Math.min(
      3 * interval,
      Math.max(1.1 * interval, interval + this.latePeak + DELAY_MARGIN),
    );
    this.delay += (target - this.delay) * 0.1;
  }

  private onClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.handlers.onClose?.(reason);
  }
}

function extrapolate(s: Snap, dt: number): View {
  if (dt === 0) return {time: s.time, bodies: s.bodies, sats: s.sats};
  return {
    time: s.time + dt,
    bodies: s.bodies.map(b => ({
      ...b,
      x: b.x + b.vx * dt,
      y: b.y + b.vy * dt,
      z: b.z + b.vz * dt,
    })),
    sats: s.sats.map(o => ({
      ...o,
      x: o.x + o.vx * dt,
      y: o.y + o.vy * dt,
      z: o.z + o.vz * dt,
    })),
  };
}

function blend(a: Snap, b: Snap, k: number): View {
  return {
    time: a.time + (b.time - a.time) * k,
    bodies: lerpById(a.bodies, b.bodies, k),
    sats: lerpById(a.sats, b.sats, k),
  };
}

interface Moving {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

function lerpById<T extends Moving>(
  from: readonly T[],
  to: readonly T[],
  k: number,
): T[] {
  const prev = new Map<number, T>();
  for (const o of from) prev.set(o.id, o);
  return to.map(o => {
    const p = prev.get(o.id);
    if (!p) return o;
    return {
      ...o,
      x: p.x + (o.x - p.x) * k,
      y: p.y + (o.y - p.y) * k,
      z: p.z + (o.z - p.z) * k,
      vx: p.vx + (o.vx - p.vx) * k,
      vy: p.vy + (o.vy - p.vy) * k,
      vz: p.vz + (o.vz - p.vz) * k,
    };
  });
}
