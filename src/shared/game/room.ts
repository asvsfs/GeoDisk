/**
 * @fileoverview Authoritative game room.
 *
 * A room owns one `World`, runs it at a fixed step, applies player requests
 * and streams snapshots and events. It depends only on the `Host` interface,
 * so the same room runs on the Node server (WebTransport) or inside the
 * browser for offline play (in-memory transport).
 */

import {PLAYER_COLORS, type GameConfig} from '../config';
import {
  Msg,
  PROTOCOL_VERSION,
  Reject,
  decodeClient,
  encode,
  type ClientMsg,
  type PlayerInfo,
} from '../net/protocol';
import {Delivery, type Host, type Link} from '../net/transport';
import {Budget} from '../sim/budget';
import {createWorld} from '../sim/pipeline';
import type {World} from '../sim/world';
import type {Player, WorldEvent} from '../types';
import {isLaunchPad, launch, pickHome, spawn} from './rules';

/** Live load and limits of a room (served at /stats). */
export interface RoomStats {
  uptimeS: number;
  players: number;
  maxPlayers: number;
  bodies: number;
  sats: number;
  /** Effective caps after load shedding. */
  bodyCap: number;
  satCap: number;
  /** Configured caps. */
  maxBodies: number;
  maxSats: number;
  snapHz: number;
  maxSnapHz: number;
  /** Busy share of one core (physics + network) and its limit. */
  cpuShare: number;
  cpuShareLimit: number;
  /** Physics cost per step, milliseconds. */
  stepMs: number;
  uploadMbps: number;
  /** 0 means unlimited. */
  uploadMbpsLimit: number;
  /** Fraction of the configured caps currently allowed. */
  capScale: number;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Room construction options. */
export interface RoomOptions {
  seed?: number;
  /** Millisecond clock; injectable for tests. */
  now?: () => number;
  log?: (line: string) => void;
}

/** Steps run per pump before the backlog is dropped. */
const MAX_CATCHUP = 5;
/** Seconds a new link has to send HELLO. */
const HELLO_TIMEOUT = 5;
/** Request rate limit: sustained per second, and burst. */
const RATE = 40;
const BURST = 80;
/** Most events sent per EVENTS message. */
const MAX_EVENTS = 128;
const MAX_NAME = 16;

const REJECT_TEXT: Record<Reject, string> = {
  [Reject.VERSION]: 'Client version is not supported.',
  [Reject.FULL]: 'Room is full.',
  [Reject.COOLDOWN]: 'Still cooling down.',
  [Reject.SAT_CAP]: 'Satellite limit reached for this room.',
  [Reject.BODY_CAP]: 'Body limit reached for this room.',
  [Reject.NO_HOME]: 'No home planet. Place a planet to launch from it.',
  [Reject.BAD_SPOT]: 'Cannot place a body there.',
  [Reject.BAD_INPUT]: 'Invalid request.',
};

interface Client {
  link: Link;
  player: Player | null;
  joinedAt: number;
  tokens: number;
  refillAt: number;
}

/** One running game room. */
export class Room {
  readonly world: World;
  private readonly clients = new Map<number, Client>();
  private readonly budget: Budget;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private acc = 0;
  /** Tick at which the next snapshot is due. */
  private snapTick = 0;
  /** Network time and bytes since the last budget sample. */
  private netMs = 0;
  private sentBytes = 0;
  private readonly startedAt: number;
  private events: WorldEvent[] = [];
  private nextPlayer = 1;
  private rosterDirty = false;

  constructor(
    private readonly host: Host,
    readonly cfg: GameConfig,
    opts: RoomOptions = {},
  ) {
    this.world = createWorld(cfg, opts.seed ?? Date.now() & 0xffffffff);
    this.budget = new Budget(cfg.limits, cfg.world.snapHz);
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.log = opts.log ?? (() => {});
  }

  /** Starts accepting links and running the simulation. */
  async start(): Promise<void> {
    await this.host.start(link => this.accept(link));
    this.last = this.now();
    const periodMs = Math.max(4, this.cfg.world.dt * 1000);
    this.timer = setInterval(() => this.pump(), periodMs);
  }

  /** Stops the loop, closes every link and the host. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients.values()) c.link.close('room stopped');
    this.clients.clear();
    await this.host.stop();
  }

  /** Number of joined players. */
  get playerCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.player) n++;
    return n;
  }

  /** Advances real time; public so tests can drive the loop directly. */
  pump(): void {
    const now = this.now();
    const elapsedMs = now - this.last;
    this.acc += elapsedMs / 1000;
    this.last = now;
    const dt = this.cfg.world.dt;
    let steps = 0;
    const t0 = this.now();
    while (this.acc >= dt && steps < MAX_CATCHUP) {
      this.world.step();
      this.acc -= dt;
      steps++;
    }
    const physicsMs = this.now() - t0;
    if (this.acc > dt * MAX_CATCHUP) this.acc = 0;

    if (steps > 0) {
      const t1 = this.now();
      this.world.bodyCap = this.budget.bodyCap();
      this.world.satCap = this.budget.satCap();
      this.collectEvents();
      this.keepHomes();
      this.expireIdle();
      if (this.rosterDirty) this.broadcastRoster();
      // Scheduled by step count, not float time: accumulated rounding in
      // world.time would otherwise sometimes need an extra step per snapshot.
      if (this.world.tick >= this.snapTick) {
        const every = Math.max(1, Math.round(1 / (dt * this.budget.snapHz)));
        this.snapTick = this.world.tick + every;
        this.broadcastState();
      }
      this.netMs += this.now() - t1;
    }
    this.budget.record({
      elapsedMs,
      physicsMs,
      netMs: this.netMs,
      bytes: this.sentBytes,
      steps,
    });
    this.netMs = 0;
    this.sentBytes = 0;
  }

  /** Live load and limits, for monitoring. */
  stats(): RoomStats {
    const b = this.budget;
    const lim = this.cfg.limits;
    return {
      uptimeS: Math.round((this.now() - this.startedAt) / 1000),
      players: this.playerCount,
      maxPlayers: lim.maxPlayers,
      bodies: this.world.bodies.length,
      sats: this.world.sats.length,
      bodyCap: this.world.bodyCap,
      satCap: this.world.satCap,
      maxBodies: lim.maxBodies,
      maxSats: lim.maxSats,
      snapHz: b.snapHz,
      maxSnapHz: this.cfg.world.snapHz,
      cpuShare: round3(b.cpu),
      cpuShareLimit: lim.cpuShare,
      stepMs: round3(b.stepMs),
      uploadMbps: round3((b.uploadBps * 8) / 1e6),
      uploadMbpsLimit: lim.maxUploadMbps,
      capScale: round3(b.scale),
    };
  }

  private accept(link: Link): void {
    const client: Client = {
      link,
      player: null,
      joinedAt: this.world.time,
      tokens: BURST,
      refillAt: this.now(),
    };
    this.clients.set(link.id, client);
    link.listen({
      onMessage: data => this.receive(client, data),
      onClose: reason => this.drop(client, reason),
    });
  }

  private receive(client: Client, data: Uint8Array): void {
    if (!this.allow(client)) return;
    let msg: ClientMsg;
    try {
      msg = decodeClient(data);
    } catch {
      client.link.close('malformed message');
      return;
    }
    if (!client.player) {
      if (msg.type === Msg.HELLO) this.join(client, msg.version, msg.name);
      else client.link.close('expected hello');
      return;
    }
    const player = client.player;
    switch (msg.type) {
      case Msg.LAUNCH: {
        const r = launch(this.world, player, msg.angle, msg.pitch, msg.speed);
        if (typeof r === 'number') this.reject(client, r);
        break;
      }
      case Msg.SPAWN: {
        const r = spawn(this.world, player, msg);
        if (typeof r === 'number') {
          this.reject(client, r);
        } else if (!player.home && isLaunchPad(r)) {
          player.home = r.id;
          this.rosterDirty = true;
        }
        break;
      }
      case Msg.HOME: {
        const b = this.world.body(msg.body);
        if (b && isLaunchPad(b)) {
          player.home = b.id;
          this.rosterDirty = true;
        } else {
          this.reject(client, Reject.NO_HOME);
        }
        break;
      }
      case Msg.PING:
        this.send(
          client,
          encode({type: Msg.PONG, t: msg.t}),
          Delivery.RELIABLE,
        );
        break;
      case Msg.HELLO:
        break;
    }
  }

  /** Token-bucket rate limit; floods close the link. */
  private allow(client: Client): boolean {
    const now = this.now();
    client.tokens = Math.min(
      BURST,
      client.tokens + ((now - client.refillAt) / 1000) * RATE,
    );
    client.refillAt = now;
    if (client.tokens < 1) {
      if (client.tokens < -BURST) client.link.close('rate limited');
      client.tokens -= 1;
      return false;
    }
    client.tokens -= 1;
    return true;
  }

  private join(client: Client, version: number, rawName: string): void {
    if (version !== PROTOCOL_VERSION) {
      this.reject(client, Reject.VERSION);
      client.link.close('version mismatch');
      return;
    }
    if (this.playerCount >= this.cfg.limits.maxPlayers) {
      this.reject(client, Reject.FULL);
      client.link.close('room full');
      return;
    }
    const players = this.players();
    const player: Player = {
      id: this.allocPlayerId(players),
      name: cleanName(rawName),
      color: pickColor(players),
      home: 0,
      launchAt: 0,
      spawnAt: 0,
    };
    player.home = pickHome(this.world, players, player);
    client.player = player;
    this.log(`join #${player.id} "${player.name}" (link ${client.link.id})`);
    this.send(
      client,
      encode({
        type: Msg.WELCOME,
        version: PROTOCOL_VERSION,
        you: player.id,
        config: this.cfg,
      }),
      Delivery.RELIABLE,
    );
    this.rosterDirty = true;
    this.broadcastRoster();
    this.send(client, this.encodeSnap(), Delivery.LATEST);
  }

  private drop(client: Client, reason: string): void {
    if (!this.clients.delete(client.link.id)) return;
    const player = client.player;
    if (!player) return;
    this.log(`leave #${player.id} "${player.name}": ${reason}`);
    this.world.sats = this.world.sats.filter(s => s.owner !== player.id);
    this.rosterDirty = true;
  }

  private reject(client: Client, code: Reject): void {
    this.send(
      client,
      encode({type: Msg.REJECT, code, text: REJECT_TEXT[code]}),
      Delivery.RELIABLE,
    );
  }

  private players(): Player[] {
    const out: Player[] = [];
    for (const c of this.clients.values()) if (c.player) out.push(c.player);
    return out;
  }

  private allocPlayerId(players: readonly Player[]): number {
    const used = new Set(players.map(p => p.id));
    for (;;) {
      const id = this.nextPlayer;
      this.nextPlayer = this.nextPlayer >= 0xfffe ? 1 : this.nextPlayer + 1;
      if (!used.has(id)) return id;
    }
  }

  private collectEvents(): void {
    const ev = this.world.events;
    if (ev.length === 0) return;
    const room = MAX_EVENTS * 2 - this.events.length;
    if (room > 0) this.events.push(...ev.slice(0, room));
    ev.length = 0;
  }

  /** Reassigns players whose home planet merged, shattered or escaped. */
  private keepHomes(): void {
    const players = this.players();
    for (const p of players) {
      const home = p.home ? this.world.body(p.home) : undefined;
      if (home && isLaunchPad(home)) continue;
      const next = pickHome(this.world, players, p);
      if (next !== p.home) {
        p.home = next;
        this.rosterDirty = true;
      }
    }
  }

  private expireIdle(): void {
    for (const c of this.clients.values()) {
      if (!c.player && this.world.time - c.joinedAt > HELLO_TIMEOUT) {
        c.link.close('hello timeout');
      }
    }
  }

  private broadcastRoster(): void {
    this.rosterDirty = false;
    const players: PlayerInfo[] = this.players().map(p => ({
      id: p.id,
      color: p.color,
      home: p.home,
      name: p.name,
    }));
    this.broadcast(encode({type: Msg.PLAYERS, players}), Delivery.RELIABLE);
  }

  private broadcastState(): void {
    if (this.events.length > 0) {
      const events = this.events.splice(0, MAX_EVENTS);
      this.broadcast(encode({type: Msg.EVENTS, events}), Delivery.RELIABLE);
    }
    this.broadcast(this.encodeSnap(), Delivery.LATEST);
  }

  private encodeSnap(): Uint8Array {
    const w = this.world;
    return encode({
      type: Msg.SNAP,
      tick: w.tick,
      time: w.time,
      bodyCap: w.bodyCap,
      satCap: w.satCap,
      bodies: w.bodies,
      sats: w.sats,
    });
  }

  private broadcast(data: Uint8Array, delivery: Delivery): void {
    for (const c of this.clients.values()) {
      if (c.player) this.send(c, data, delivery);
    }
  }

  /** Sends to one client, counting bytes for the upload budget. */
  private send(c: Client, data: Uint8Array, delivery: Delivery): void {
    this.sentBytes += data.byteLength;
    c.link.send(data, delivery);
  }
}

function cleanName(raw: string): string {
  const name = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, MAX_NAME);
  return name || 'pilot';
}

function pickColor(players: readonly Player[]): number {
  const used = new Set(players.map(p => p.color));
  for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
  return players.length % PLAYER_COLORS.length;
}
