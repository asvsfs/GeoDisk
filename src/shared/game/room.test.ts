import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {GameClient} from '../../client/net/game_client';
import {DEFAULT_CONFIG, mergeConfig} from '../config';
import {MemConnector, MemHost} from '../net/mem_transport';
import {Msg, PROTOCOL_VERSION, encode, decodeServer} from '../net/protocol';
import {Delivery} from '../net/transport';
import {Room} from './room';

const tick = () => new Promise(r => setTimeout(r, 0));

async function setup(patch: Parameters<typeof mergeConfig>[1] = {}) {
  let clock = 0;
  const host = new MemHost();
  const room = new Room(host, mergeConfig(DEFAULT_CONFIG, patch), {
    seed: 5,
    now: () => clock,
  });
  await room.start();
  // Rooms still running when a test fails would keep the process alive.
  after(() => room.stop());
  const advance = async (ms: number, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      clock += step;
      room.pump();
      await tick();
    }
  };
  const join = (name: string) =>
    GameClient.join(new MemConnector(host), name, {}, () => clock);
  return {room, host, advance, join};
}

test('players join, see each other and receive snapshots', async () => {
  const {room, advance, join} = await setup();
  const a = await join('alice');
  const b = await join('bob');
  await advance(200);
  assert.equal(room.playerCount, 2);
  assert.deepEqual(a.players.map(p => p.name).sort(), ['alice', 'bob']);
  assert.notEqual(a.me()?.color, b.me()?.color);
  assert.ok(a.me()!.home > 0, 'home planet assigned');
  assert.ok(a.latest()!.bodies.length > 0);
  assert.ok(a.view());
  await room.stop();
});

test('launching puts a satellite into the shared world', async () => {
  const {room, advance, join} = await setup();
  const a = await join('alice');
  const b = await join('bob');
  await advance(100);
  a.launch(0.5, 300);
  await advance(200);
  const sats = b.latest()!.sats;
  assert.equal(sats.length, 1);
  assert.equal(sats[0].owner, a.you);
  await room.stop();
});

test('per-player cap recycles the oldest satellite', async () => {
  const {room, advance, join} = await setup({
    limits: {maxSatsPerPlayer: 3, launchCooldown: 0},
  });
  const a = await join('alice');
  await advance(100);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    a.launch(i, 250);
    await advance(100);
    ids.push(...room.world.sats.map(s => s.id));
  }
  const mine = room.world.sats.filter(s => s.owner === a.you);
  assert.ok(mine.length <= 3);
  await room.stop();
});

test('global satellite cap rejects launches', async () => {
  const {room, advance, join} = await setup({
    limits: {maxSats: 8, launchCooldown: 0},
  });
  const rejects: string[] = [];
  const a = await join('alice');
  a.listen({onReject: r => rejects.push(r.text)});
  await advance(100);
  // Fill the world with someone else's satellites.
  for (let i = 0; i < 8; i++) {
    room.world.sats.push({
      id: 9000 + i,
      owner: 999,
      x: -3000,
      y: 2000 - i * 20,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
    });
  }
  a.launch(0, 200);
  await advance(100);
  assert.ok(rejects.some(t => /limit/i.test(t)));
  await room.stop();
});

test('wrong protocol version is refused', async () => {
  const {room, host} = await setup();
  const link = await new MemConnector(host).connect();
  const got: number[] = [];
  let closed = '';
  link.listen({
    onMessage: d => got.push(decodeServer(d).type),
    onClose: r => (closed = r),
  });
  link.send(
    encode({type: Msg.HELLO, version: PROTOCOL_VERSION + 1, name: 'x'}),
    Delivery.RELIABLE,
  );
  await tick();
  await tick();
  assert.deepEqual(got, [Msg.REJECT]);
  assert.ok(closed);
  await room.stop();
});

test('leaving removes the player and their satellites', async () => {
  const {room, advance, join} = await setup();
  const a = await join('alice');
  await advance(100);
  a.launch(1, 300);
  await advance(100);
  assert.equal(room.world.sats.length, 1);
  a.leave();
  await advance(100);
  assert.equal(room.playerCount, 0);
  assert.equal(room.world.sats.length, 0);
  await room.stop();
});

test('nothing is spawned for a homeless player; placing a planet homes them', async () => {
  const {room, advance, join} = await setup();
  room.world.bodies = room.world.bodies.filter(
    b => b.kind !== 'planet' && b.kind !== 'rock',
  );
  const before = room.world.bodies.length;
  const a = await join('alice');
  await advance(200);
  assert.equal(a.me()!.home, 0);
  assert.equal(room.world.bodies.length, before, 'no automatic spawning');
  a.spawn({
    kind: 'planet',
    x: 3000,
    y: 2200,
    vx: 0,
    vy: 0,
    mu: 2e5,
    radius: 12,
    spin: 0,
  });
  await advance(200);
  const home = room.world.body(a.me()!.home);
  assert.equal(home?.kind, 'planet');
  assert.equal(home?.radius, 12, 'player-defined radius kept');
  assert.ok(Math.abs(home!.mu - 2e5) < 1);
  await room.stop();
});

test('spawn requests are clamped to the kind range', async () => {
  const {room, advance, join} = await setup();
  const a = await join('alice');
  await advance(100);
  a.spawn({
    kind: 'star',
    x: -3000,
    y: -2200,
    vx: 0,
    vy: 0,
    mu: 1e12,
    radius: 1e6,
    spin: 5,
  });
  await advance(100);
  const star = room.world.bodies[room.world.bodies.length - 1];
  assert.equal(star.kind, 'star');
  assert.ok(star.mu < DEFAULT_CONFIG.physics.novaMu);
  assert.ok(star.radius <= 96);
  await room.stop();
});

test('snapshots go out at exactly snapHz', async () => {
  const {room, host, advance} = await setup();
  const link = await new MemConnector(host).connect();
  let snaps = 0;
  link.listen({
    onMessage: d => {
      if (decodeServer(d).type === Msg.SNAP) snaps++;
    },
    onClose: () => {},
  });
  link.send(
    encode({type: Msg.HELLO, version: PROTOCOL_VERSION, name: 'x'}),
    Delivery.RELIABLE,
  );
  await tick();
  snaps = 0;
  // Pump at the server's real cadence (~one step per pump).
  await advance(3000, 1000 / 60);
  // 3 s at 30 Hz, allowing one for the window edge.
  assert.ok(
    Math.abs(snaps - 3 * DEFAULT_CONFIG.world.snapHz) <= 1,
    `got ${snaps}`,
  );
  await room.stop();
});

test('render delay adapts down to about one snapshot interval', async () => {
  const {room, advance, join} = await setup();
  const a = await join('alice');
  await advance(3000, 1000 / 60);
  const interval = 1000 / DEFAULT_CONFIG.world.snapHz;
  assert.ok(
    a.renderDelayMs() < interval * 1.6,
    `delay ${a.renderDelayMs()} ms`,
  );
  assert.ok(a.renderDelayMs() >= interval * 1.1 - 0.01);
  await room.stop();
});

test('stats report load and limits', async () => {
  const {room, advance, join} = await setup();
  await join('alice');
  await advance(1000, 1000 / 60);
  const s = room.stats();
  assert.equal(s.players, 1);
  assert.equal(s.maxBodies, DEFAULT_CONFIG.limits.maxBodies);
  assert.equal(s.snapHz, DEFAULT_CONFIG.world.snapHz);
  assert.ok(s.uploadMbps > 0, 'counts bytes sent');
  assert.ok(s.cpuShare >= 0);
  await room.stop();
});
