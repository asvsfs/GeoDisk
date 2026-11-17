import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_CONFIG} from '../config';
import {makeBody} from '../sim/bodies';
import {EventKind} from '../types';
import {DecodeError} from './codec';
import {
  Msg,
  PROTOCOL_VERSION,
  Reject,
  decodeClient,
  decodeServer,
  encode,
  type Players,
} from './protocol';

test('client messages round-trip', () => {
  const msgs = [
    {type: Msg.HELLO, version: PROTOCOL_VERSION, name: 'Ada ✨'},
    {type: Msg.LAUNCH, angle: 1.25, pitch: 0, speed: 320},
    {
      type: Msg.SPAWN,
      kind: 'white',
      x: 10,
      y: -20,
      vx: 3,
      vy: 4,
      mu: 2e6,
      radius: 5,
      spin: -0.5,
    },
    {type: Msg.PING, t: 12345.5},
    {type: Msg.HOME, body: 77},
  ] as const;
  for (const m of msgs) assert.deepEqual(decodeClient(encode(m)), m);
});

test('server messages round-trip', () => {
  const welcome = decodeServer(
    encode({type: Msg.WELCOME, version: 1, you: 3, config: DEFAULT_CONFIG}),
  );
  assert.equal(welcome.type, Msg.WELCOME);
  if (welcome.type === Msg.WELCOME)
    assert.deepEqual(welcome.config, DEFAULT_CONFIG);

  const players: Players = {
    type: Msg.PLAYERS,
    players: [{id: 1, color: 2, home: 9, name: 'Bo'}],
  };
  assert.deepEqual(decodeServer(encode(players)), players);

  const reject = {
    type: Msg.REJECT,
    code: Reject.SAT_CAP,
    text: 'full',
  } as const;
  assert.deepEqual(decodeServer(encode(reject)), reject);

  const events = decodeServer(
    encode({
      type: Msg.EVENTS,
      events: [{kind: EventKind.NOVA, x: 1, y: 2, z: 3, size: 950, ref: 0}],
    }),
  );
  assert.deepEqual(events, {
    type: Msg.EVENTS,
    events: [{kind: EventKind.NOVA, x: 1, y: 2, z: 3, size: 950, ref: 0}],
  });
});

test('snapshots preserve bodies and satellites', () => {
  const star = makeBody(
    5,
    {
      kind: 'star',
      x: 100.5,
      y: -40.25,
      vx: 12.3,
      vy: -4.5,
      mu: 6e6,
      radius: 33.5,
    },
    DEFAULT_CONFIG.physics,
  );
  const hole = makeBody(
    6,
    {kind: 'hole', x: 0, y: 0, mu: 1e8, spin: 3e4, fixed: true},
    DEFAULT_CONFIG.physics,
  );
  const data = encode({
    type: Msg.SNAP,
    tick: 42,
    time: 0.7,
    bodyCap: 96,
    satCap: 384,
    bodies: [star, hole],
    sats: [
      {id: 9, owner: 2, x: 1, y: 2, z: 3, vx: 100, vy: -200, vz: 0, age: 1},
    ],
  });
  const s = decodeServer(data);
  assert.equal(s.type, Msg.SNAP);
  if (s.type !== Msg.SNAP) return;
  assert.equal(s.tick, 42);
  assert.equal(s.bodies[0].kind, 'star');
  assert.equal(s.bodies[0].radius, star.radius);
  assert.ok(Math.abs(s.bodies[0].vx - 12.3) < 0.051);
  assert.ok(Math.abs(s.bodies[0].life - star.life) < 1);
  assert.equal(s.bodies[1].fixed, true);
  assert.equal(s.bodies[1].life, Infinity);
  assert.equal(s.sats[0].owner, 2);
  assert.equal(s.sats[0].vy, -200);
  assert.ok(data.byteLength < 2 * 34 + 24 + 40);
});

test('truncated and unknown messages are rejected', () => {
  const data = encode({type: Msg.LAUNCH, angle: 1, pitch: 0, speed: 1});
  assert.throws(() => decodeClient(data.subarray(0, 5)), DecodeError);
  assert.throws(() => decodeClient(new Uint8Array([200])), RangeError);
  assert.throws(
    () => decodeClient(new Uint8Array([Msg.SPAWN, 99, 0, 0, 0, 0])),
    RangeError,
  );
});
