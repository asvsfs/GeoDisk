import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_CONFIG, mergeConfig, type GameConfig} from '../config';
import {EventKind, type Body} from '../types';
import {Collisions, limitSpin} from './collide';
import {DirectSolver, TreeSolver, newSample} from './gravity';
import {BodyMotion, SatMotion} from './motion';
import {defaultSystems} from './pipeline';
import {Rng} from './rng';
import {breakupSpin} from './bodies';
import {classify} from './classes';
import {createWorld} from './pipeline';
import {predictPath} from './predict';
import {StellarEvolution, supernova} from './stars';
import {Walls} from './walls';
import {World, type System} from './world';

function world(
  systems: System[],
  patch: Parameters<typeof mergeConfig>[1] = {},
): World {
  const cfg: GameConfig = mergeConfig(DEFAULT_CONFIG, patch);
  return new World(cfg, systems, 42);
}

function momentum(bodies: readonly Body[]): [number, number, number] {
  let mu = 0;
  let px = 0;
  let py = 0;
  for (const b of bodies) {
    mu += b.mu;
    px += b.vx * b.mu;
    py += b.vy * b.mu;
  }
  return [mu, px, py];
}

test('tree solver matches direct summation', () => {
  const rng = new Rng(7);
  const w = world([]);
  for (let i = 0; i < 300; i++) {
    w.addBody({
      kind: 'planet',
      x: rng.range(-2000, 2000),
      y: rng.range(-1500, 1500),
      z: rng.range(-200, 200),
      mu: rng.range(5e4, 5e6),
    });
  }
  w.bodies.length = Math.min(w.bodies.length, 300);
  const direct = new DirectSolver(900);
  const tree = new TreeSolver(900, 0.5);
  direct.build(w.bodies);
  tree.build(w.bodies);
  const a = newSample();
  const b = newSample();
  for (let k = 0; k < 50; k++) {
    const x = rng.range(-2500, 2500);
    const y = rng.range(-2000, 2000);
    direct.sample(x, y, 0, a);
    tree.sample(x, y, 0, b);
    // Scale by the summed per-body pull: relative error against the net field
    // is meaningless where opposing pulls cancel.
    let scale = 0;
    for (const o of w.bodies) {
      scale +=
        o.mu / ((x - o.x) ** 2 + (y - o.y) ** 2 + o.z ** 2 + o.soft ** 2);
    }
    const err = Math.hypot(a.gx - b.gx, a.gy - b.gy, a.gz - b.gz);
    assert.ok(err / scale < 0.05, `relative error ${err / scale}`);
    assert.ok(Math.abs(a.phi - b.phi) / Math.abs(a.phi) < 0.02);
  }
});

test('tree solver handles coincident bodies', () => {
  const w = world([], {limits: {maxBodies: 300}});
  for (let i = 0; i < 70; i++)
    w.addBody({kind: 'rock', x: 10, y: 10, mu: 1000});
  const tree = new TreeSolver(900, 0.6);
  tree.build(w.bodies);
  const s = tree.sample(500, 10, 0, newSample());
  const expected = (70 * 1000) / (490 * 490);
  assert.ok(Math.abs(-s.gx - expected) / expected < 0.01);
});

test('circular orbit stays bounded under velocity Verlet', () => {
  const w = world([new BodyMotion()]);
  const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 5e6})!;
  star.fixed = true;
  const r = 200;
  const p = w.addBody({
    kind: 'planet',
    x: r,
    y: 0,
    vy: Math.sqrt(5e6 / r),
    mu: 1e5,
  })!;
  // Correct for softening so the orbit is exactly circular.
  const s2 = star.soft * star.soft;
  p.vy = Math.sqrt((5e6 * r * r) / Math.pow(r * r + s2, 1.5));
  for (let i = 0; i < 60 * 60; i++) w.step();
  const d = Math.hypot(p.x, p.y);
  assert.ok(Math.abs(d - r) < 4, `radius drifted to ${d}`);
});

test('slow planets merge conserving mass and momentum', () => {
  const w = world([new Collisions()]);
  w.addBody({kind: 'planet', x: 0, y: 0, vx: 10, mu: 1e5});
  w.addBody({kind: 'planet', x: 8, y: 0, vx: -10, mu: 5e4});
  const before = momentum(w.bodies);
  w.step();
  assert.equal(w.bodies.length, 1);
  const after = momentum(w.bodies);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-6);
  assert.ok(Math.abs(after[1] - before[1]) < 1e-3);
  assert.equal(w.events[0].kind, EventKind.MERGE);
});

test('fast planets shatter into momentum-neutral fragments', () => {
  const w = world([new Collisions()]);
  w.addBody({kind: 'planet', x: 0, y: 0, vx: 600, vy: 40, mu: 1e5});
  w.addBody({kind: 'planet', x: 8, y: 0, vx: -600, vy: 40, mu: 1e5});
  const before = momentum(w.bodies);
  w.step();
  assert.ok(w.bodies.length >= 3, `expected fragments, got ${w.bodies.length}`);
  const after = momentum(w.bodies);
  assert.ok(
    Math.abs(after[0] - before[0]) / before[0] < 1e-9,
    'mass conserved',
  );
  assert.ok(Math.abs(after[1] - before[1]) < 1, 'x momentum conserved');
  assert.ok(Math.abs(after[2] - before[2]) < 1, 'y momentum conserved');
  assert.ok(w.events.some(e => e.kind === EventKind.SHATTER));
  // The remnant keeps the larger body's id.
  assert.ok(w.bodies.some(b => b.id === 1));
});

test('shatter falls back to merge when the body cap is full', () => {
  const w = world([new Collisions()], {limits: {maxBodies: 2}});
  w.addBody({kind: 'planet', x: 0, y: 0, vx: 600, mu: 1e5});
  w.addBody({kind: 'planet', x: 8, y: 0, vx: -600, mu: 1e5});
  w.step();
  assert.equal(w.bodies.length, 1);
  assert.ok(Math.abs(w.bodies[0].mu - 2e5) < 1e-6);
});

test('stars swallow planets', () => {
  const w = world([new Collisions()]);
  w.addBody({kind: 'star', x: 0, y: 0, mu: 5e6});
  w.addBody({kind: 'planet', x: 20, y: 0, vx: -900, mu: 1e5});
  w.step();
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].kind, 'star');
});

const PHYS = DEFAULT_CONFIG.physics;
const totalMass = (w: World) => w.bodies.reduce((m, b) => m + b.mu, 0);
const sat = (id: number, owner: number, x: number, y: number, vx: number) => ({
  id,
  owner,
  x,
  y,
  z: 0,
  vx,
  vy: 0,
  vz: 0,
  age: 0,
});

test('heavy stars collapse into neutron stars, conserving mass', () => {
  const w = world([new StellarEvolution()]);
  const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 1e7})!;
  star.life = 0.001;
  w.sats.push(sat(99, 1, 300, 0, 0));
  w.step();
  assert.equal(star.kind, 'compact');
  assert.ok(w.bodies.length > 1, 'ejecta created');
  assert.ok(Math.abs(totalMass(w) - 1e7) < 1e-3, 'mass conserved');
  assert.ok(w.sats[0].vx > 50, 'satellite pushed outward');
  assert.ok(w.events.some(e => e.kind === EventKind.NOVA));
});

test('a spinning star leaves a pulsar; a still one a neutron star', () => {
  for (const [frac, expect] of [
    [0.2, 'pulsar'],
    [0, 'neutron-star'],
  ] as const) {
    const w = world([new StellarEvolution()]);
    const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 1e7})!;
    star.spin = frac * breakupSpin(star.mu, star.radius);
    star.life = 0.001;
    w.step();
    assert.equal(classify(star, PHYS, 900).id, expect);
  }
});

test('the heaviest stars collapse straight into black holes', () => {
  const w = world([new StellarEvolution()]);
  const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 2e7})!;
  star.life = 0.001;
  w.step();
  assert.equal(star.kind, 'hole');
});

test('light stars shed a nebula and leave a white dwarf', () => {
  const w = world([new StellarEvolution()]);
  const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 5e6})!;
  star.life = 0.001;
  w.step();
  assert.equal(star.kind, 'white');
  assert.ok(Math.abs(star.mu - 5e6 * PHYS.dwarfFrac) < 1);
  assert.ok(Math.abs(totalMass(w) - 5e6) < 1e-3, 'mass conserved');
  assert.ok(w.events.some(e => e.kind === EventKind.NEBULA));
});

test('white dwarfs past the Chandrasekhar limit blow apart completely', () => {
  const w = world([new StellarEvolution()]);
  const dwarf = w.addBody({
    kind: 'white',
    x: 0,
    y: 0,
    mu: PHYS.chandraMu * 1.05,
  })!;
  w.step();
  assert.ok(!w.bodies.includes(dwarf), 'no remnant');
  assert.ok(w.bodies.length >= 2, 'debris created');
  assert.ok(
    Math.abs(totalMass(w) - PHYS.chandraMu * 1.05) < 1e-3,
    'mass conserved',
  );
  assert.ok(w.events.some(e => e.kind === EventKind.TYPE_IA));
});

test('neutron stars merging make a kilonova, past TOV a black hole', () => {
  const w = world([new Collisions()]);
  w.addBody({kind: 'compact', x: 0, y: 0, mu: 3e6});
  w.addBody({kind: 'compact', x: 4, y: 0, vx: -30, mu: 2.9e6});
  w.step();
  assert.ok(w.events.some(e => e.kind === EventKind.KILONOVA));
  assert.ok(
    w.bodies.some(b => b.kind === 'hole'),
    'collapsed past TOV',
  );
  assert.ok(Math.abs(totalMass(w) - 5.9e6) < 1e-3, 'mass conserved');
});

test('a star engulfs a lighter neutron star instead of becoming one', () => {
  const w = world([new Collisions()]);
  w.addBody({kind: 'star', x: 0, y: 0, mu: 1.2e7});
  w.addBody({kind: 'compact', x: 30, y: 0, vx: -100, mu: 3e6});
  w.step();
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].kind, 'star');
});

test('off-centre mergers turn orbital angular momentum into spin', () => {
  const w = world([new Collisions()]);
  const a = w.addBody({kind: 'planet', x: 0, y: 0, mu: 1e5, radius: 8})!;
  w.addBody({kind: 'planet', x: 0, y: 10, vx: 40, vy: -5, mu: 1e5, radius: 8});
  w.step();
  // L = mu_red * (dx * dvy - dy * dvx) = 5e4 * (0 - 10 * 40).
  assert.ok(Math.abs(a.spin - -2e7) < 1);
  // Volumes add: r = cbrt(8^3 + 8^3).
  assert.ok(Math.abs(a.radius - Math.cbrt(1024)) < 1e-9);
});

test('bodies spun far past breakup fling off fragments', () => {
  const w = world([]);
  const a = w.addBody({kind: 'planet', x: 0, y: 0, mu: 4e5, radius: 10})!;
  a.spin = 3 * breakupSpin(a.mu, a.radius);
  limitSpin(w, a);
  assert.ok(w.events.some(e => e.kind === EventKind.FISSION));
  assert.ok(w.bodies.length > 1, 'fragments flung off');
  assert.ok(Math.abs(a.spin) <= breakupSpin(a.mu, a.radius) * 1.0001);
  assert.ok(Math.abs(totalMass(w) - 4e5) < 1e-6, 'mass conserved');
  const [, px, py] = momentum(w.bodies);
  assert.ok(Math.abs(px) < 1e-3 && Math.abs(py) < 1e-3, 'momentum conserved');
});

test('classes follow mass, density and spin', () => {
  const c = (kind: Body['kind'], mu: number, radius: number, spin = 0) =>
    classify(
      {kind, mu, radius, spin, vx: 0, vy: 0, vz: 0, fixed: false},
      PHYS,
      900,
    ).id;
  assert.equal(c('star', 3.5e6, 25), 'red-dwarf');
  assert.equal(c('star', 5e6, 30), 'yellow-dwarf');
  assert.equal(c('star', 9e6, 35), 'blue-giant');
  assert.equal(c('star', 1.5e7, 45), 'supergiant');
  assert.equal(c('planet', 1e5, 6), 'rocky-planet');
  assert.equal(c('planet', 1e5, 16), 'gas-giant');
  assert.equal(c('planet', 2e6, 20), 'brown-dwarf');
  assert.equal(c('compact', 4e6, 3.5), 'neutron-star');
  assert.equal(c('compact', 4e6, 3.5, 0.5 * breakupSpin(4e6, 3.5)), 'pulsar');
  assert.equal(c('hole', 1e7, 3), 'stellar-black-hole');
  assert.equal(c('hole', 3e8, 70), 'supermassive-black-hole');
});

test('mergers past novaMu trigger a supernova', () => {
  const w = world([new Collisions(), new StellarEvolution()]);
  w.addBody({kind: 'star', x: 0, y: 0, mu: 1.2e7});
  w.addBody({kind: 'star', x: 10, y: 0, vx: -50, mu: 1.1e7});
  w.step();
  assert.ok(w.events.some(e => e.kind === EventKind.NOVA));
});

test('ejecta never exceed the body cap; the rest falls back', () => {
  const w = world([new StellarEvolution()], {limits: {maxBodies: 5}});
  const star = w.addBody({kind: 'star', x: 0, y: 0, mu: 1e7})!;
  supernova(w, star);
  assert.ok(w.bodies.length <= 5);
  assert.ok(Math.abs(totalMass(w) - 1e7) < 1e-3, 'mass conserved');
});

test('satellites crash into bodies; walls keep everything inside', () => {
  const w = world([new BodyMotion(), new SatMotion(), new Walls()]);
  w.addBody({kind: 'planet', x: 100, y: 0, mu: 1e5});
  const rogue = w.addBody({kind: 'rock', x: 3990, y: 0, vx: 800, mu: 1e3})!;
  w.sats.push(sat(1, 3, 80, 0, 600));
  w.sats.push(sat(2, 4, 3995, 2000, 800));
  for (let i = 0; i < 10; i++) w.step();
  assert.equal(w.sats.length, 1);
  assert.ok(w.events.some(e => e.kind === EventKind.CRASH && e.ref === 3));
  assert.ok(w.sats[0].vx < 0, 'satellite bounced');
  assert.ok(w.bodies.includes(rogue) && rogue.vx < 0, 'body bounced');
  assert.ok(Math.abs(rogue.x) <= 4000);
});

test('the seeded universe never spawns or loses mass on its own', () => {
  const w = createWorld(DEFAULT_CONFIG, 7);
  const m0 = totalMass(w);
  for (let i = 0; i < 60 * 90; i++) w.step();
  assert.ok(Math.abs(totalMass(w) - m0) / m0 < 1e-9);
  assert.ok(w.bodies.length <= w.bodyCap);
});

test('full pipeline at the caps stays within the step budget', () => {
  const w = world(defaultSystems());
  const rng = new Rng(3);
  while (w.bodies.length < w.bodyCap) {
    w.addBody({
      kind: 'planet',
      x: rng.range(-3000, 3000),
      y: rng.range(-2200, 2200),
      vx: rng.range(-40, 40),
      vy: rng.range(-40, 40),
      mu: rng.range(4e4, 2e5),
    });
  }
  for (let i = 0; i < w.satCap; i++) {
    w.sats.push({
      id: 1000 + i,
      owner: 1,
      x: rng.range(-3000, 3000),
      y: rng.range(-2200, 2200),
      z: 0,
      vx: rng.range(-100, 100),
      vy: rng.range(-100, 100),
      vz: 0,
      age: 0,
    });
  }
  const t0 = performance.now();
  const steps = 120;
  for (let i = 0; i < steps; i++) w.step();
  const ms = (performance.now() - t0) / steps;
  console.log(
    `  ${w.bodyCap} bodies + ${w.satCap} sats: ${ms.toFixed(3)} ms/step (${w.field.name})`,
  );
  assert.ok(ms < 16, `step took ${ms} ms`);
});

test('previews launch from where the home body will be after the lead', () => {
  const w = world([new BodyMotion()]);
  w.addBody({kind: 'star', x: 0, y: 0, mu: 5e6});
  const home = w.addBody({kind: 'planet', x: 300, y: 0, vy: 129, mu: 1e5})!;
  const shot = {home: home.id, angle: 0, pitch: 0, speed: 200};
  const now = predictPath(DEFAULT_CONFIG, w.bodies, shot, {seconds: 0.2});
  const later = predictPath(DEFAULT_CONFIG, w.bodies, shot, {
    seconds: 0.2,
    lead: 0.5,
  });
  // The planet moves about 0.5 s * 129 = 64 units along y in the lead time.
  assert.ok(
    Math.abs(later[0].y - now[0].y - 64) < 6,
    `${later[0].y - now[0].y}`,
  );
});

test('satellites feel full gravity near a black hole and fall in', () => {
  // Regression: the old 1PN factor alpha^4 shrank gravity to under 1% inside
  // ~2 mu / c^2, so satellites hovered around heavy holes instead of falling.
  for (const v of [0, 250]) {
    const w = world([new BodyMotion(), new SatMotion()]);
    w.addBody({kind: 'hole', x: 0, y: 0, vx: v, mu: 6e7});
    w.sats.push(sat(1, 1, 290, 0, v));
    w.step();
    const ax = (w.sats[0].vx - v) / DEFAULT_CONFIG.world.dt;
    const newton = -6e7 / (290 * 290 + w.bodies[0].soft ** 2);
    assert.ok(
      ax < newton * 0.95 && ax > newton * 1.1,
      `hole moving at ${v}: a=${ax}, newton=${newton}`,
    );
    for (let i = 0; i < 120 && w.sats.length > 0; i++) w.step();
    assert.equal(w.sats.length, 0, `satellite crashed (hole speed ${v})`);
  }
});

test('the Schwarzschild term only acts on moving satellites near compact bodies', () => {
  for (const kind of ['hole', 'planet'] as const) {
    const s = new DirectSolver(DEFAULT_CONFIG.world.c);
    s.build([
      {...newBodyLike(kind), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0},
    ] as Body[]);
    const out = {ax: 0, ay: 0, az: 0};
    s.addStrong(500, 0, 0, 0, 0, 0, out);
    assert.equal(out.ax, 0, `${kind}: no correction at rest (L = 0)`);
    s.addStrong(500, 0, 0, 0, 400, 0, out);
    if (kind === 'hole') assert.ok(out.ax < 0, 'extra inward pull');
    else assert.equal(out.ax, 0, 'ordinary matter has no strong-field term');
  }
});

function newBodyLike(kind: 'hole' | 'planet'): Partial<Body> {
  return {id: 1, kind, mu: 6e7, radius: 15, soft: 18, spin: 0, fixed: false};
}
