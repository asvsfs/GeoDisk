import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CpuGravityGridSolver,
  Direct2Plus1DFieldSampler,
  advanceOrbitingMasses,
  evaluateSingleMass2Plus1D,
  stepMassBodiesNBody,
} from './gravityField';
import {
  DEFAULT_ROCKET_CONFIG,
  NewtonianRocketPhysics,
  Relativistic2Plus1DRocketPhysics,
  createInitialRocketState,
  predictTrajectory,
} from './rocketPhysics';
import { evaluateFlightState, generateDeterministicCluster } from '../game/missions';
import type { MassBody } from './types';

test('uniform grid computes exact linear sum of gravities from multiple masses', () => {
  const masses: MassBody[] = [
    {
      id: 'm1',
      x: -200,
      y: 0,
      mu: 40000,
      softening: 30,
      radius: 25,
      spin: 1000,
      kind: 'star',
    },
    {
      id: 'm2',
      x: 200,
      y: 100,
      mu: 25000,
      softening: 25,
      radius: 20,
      spin: -500,
      kind: 'compact',
    },
  ];

  const solver = new CpuGravityGridSolver({
    cols: 161,
    rows: 101,
    worldWidth: 1600,
    worldHeight: 1000,
    potentialRefRadius: 2000,
    speedOfLight: 900,
  });
  solver.computeGrid(masses);

  // Sample exact grid node (x = 0, y = 0) -> col = 80, row = 50
  const sample = solver.sampleAt(0, 0);
  const c1 = evaluateSingleMass2Plus1D(0, 0, masses[0], 2000, 900);
  const c2 = evaluateSingleMass2Plus1D(0, 0, masses[1], 2000, 900);

  assert.ok(Math.abs(sample.phi - (c1.phi + c2.phi)) < 1e-2);
  assert.ok(Math.abs(sample.gx - (c1.gx + c2.gx)) < 1e-2);
  assert.ok(Math.abs(sample.gy - (c1.gy + c2.gy)) < 1e-2);
  assert.ok(Math.abs(sample.bz - (c1.bz + c2.bz)) < 1e-3);
});

test('2+1D gravity follows 1/r radial force law and softens cleanly at core', () => {
  const star: MassBody = {
    id: 'star',
    x: 0,
    y: 0,
    mu: 50000,
    softening: 20,
    radius: 20,
    spin: 0,
    kind: 'star',
  };

  const solver = new CpuGravityGridSolver();
  solver.computeGrid([star]);

  const s100 = solver.sampleAt(100, 0);
  const s200 = solver.sampleAt(200, 0);
  const center = solver.sampleAt(0, 0);

  // Force points inward (-x)
  assert.ok(s100.gx < 0);
  // In 2D space, |g| scales ~ 1/r (so at 200 it's roughly half of 100)
  const ratio = Math.abs(s100.gx) / Math.abs(s200.gx);
  assert.ok(ratio > 1.85 && ratio < 2.15, `Expected ~2.0 2D 1/r ratio, got ${ratio}`);
  // Softening prevents NaN / Infinity at r=0
  assert.ok(Number.isFinite(center.phi) && Number.isFinite(center.gx));
  // Potential well yields lapse < 1
  assert.ok(center.lapse < 1 && center.lapse > 0);
});

test('2+1D Relativistic Rocket Physics exhibits time dilation and frame-dragging vs Newtonian', () => {
  const spinningSingularity: MassBody = {
    id: 'bh',
    x: 0,
    y: 0,
    mu: 75000,
    softening: 35,
    radius: 28,
    spin: 18000,
    kind: 'singularity',
  };

  const solver = new CpuGravityGridSolver({ speedOfLight: 650 });
  solver.computeGrid([spinningSingularity]);

  const grPhysics = new Relativistic2Plus1DRocketPhysics();
  const newtonPhysics = new NewtonianRocketPhysics();

  const initial = createInitialRocketState(-350, -140, 0, 100, 320);

  const grTraj = predictTrajectory(initial, grPhysics, solver, [spinningSingularity], DEFAULT_ROCKET_CONFIG, 60, 0.032);
  const newtonTraj = predictTrajectory(
    initial,
    newtonPhysics,
    solver,
    [spinningSingularity],
    DEFAULT_ROCKET_CONFIG,
    60,
    0.032
  );

  // Both produce valid finite points, and relativistic corrections diverge measurably from Newtonian
  assert.ok(grTraj.length > 20 && newtonTraj.length > 20);
  const endGr = grTraj[grTraj.length - 1];
  const endNewt = newtonTraj[newtonTraj.length - 1];
  const divergence = Math.hypot(endGr.x - endNewt.x, endGr.y - endNewt.y);
  assert.ok(divergence > 5, `Expected relativistic trajectory divergence > 5, got ${divergence}`);

  // Step live rocket and verify properTime < coordTime in deep gravity well + high speed
  let rocket = initial;
  for (let i = 0; i < 40; i++) {
    rocket = grPhysics.step(rocket, { throttle: 0, turn: 0 }, solver, 0.032, DEFAULT_ROCKET_CONFIG);
  }
  assert.ok(rocket.properTime < rocket.coordTime, 'Proper time should dilate inside gravity well');
  assert.ok(rocket.minLapse < 1.0);
});

test('orbiting masses advance cleanly and cluster generator scales to many masses', () => {
  const cluster = generateDeterministicCluster(64, 123);
  assert.ok(cluster.length >= 50);

  const solver = new CpuGravityGridSolver();
  const t0 = performance.now();
  solver.computeGrid(cluster);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 150, `Expected fast CPU grid compute for 64 masses, took ${elapsed}ms`);

  const orbiter: MassBody[] = [
    {
      id: 'orb',
      x: 100,
      y: 0,
      mu: 20000,
      softening: 20,
      radius: 15,
      spin: 0,
      kind: 'star',
      orbit: { centerX: 0, centerY: 0, orbitRadius: 100, angularSpeed: Math.PI / 2, phase: 0 },
    },
  ];
  const moved = advanceOrbitingMasses(orbiter, 1.0);
  assert.ok(Math.abs(moved[0].x) < 1e-4 && Math.abs(moved[0].y - 100) < 1e-4);
});

test('flight evaluation triggers victory, waypoint collection, and event-horizon crash', () => {
  const masses: MassBody[] = [
    {
      id: 'bh',
      x: 0,
      y: 0,
      mu: 50000,
      softening: 30,
      radius: 30,
      spin: 0,
      kind: 'singularity',
    },
  ];
  const target = { x: 400, y: 0, radius: 40, maxCaptureSpeed: 0 };
  const waypoints = [{ id: 'wp1', x: -150, y: 0, radius: 25, collected: false }];

  // Crash at singularity
  const crashedRocket = createInitialRocketState(10, 0, 0, 100, 100);
  const crashEval = evaluateFlightState(crashedRocket, masses, target, waypoints, DEFAULT_ROCKET_CONFIG, 1600, 1000);
  assert.equal(crashEval.status, 'crashed');

  // Collect waypoint
  const wpRocket = createInitialRocketState(-150, 0, 0, 100, 100);
  const wpEval = evaluateFlightState(wpRocket, masses, target, waypoints, DEFAULT_ROCKET_CONFIG, 1600, 1000);
  assert.equal(wpEval.status, 'flying');
  assert.deepEqual(wpEval.collectedWaypointIds, ['wp1']);

  // Capture target
  const winRocket = createInitialRocketState(395, 0, 0, 100, 100);
  const winEval = evaluateFlightState(winRocket, masses, target, waypoints, DEFAULT_ROCKET_CONFIG, 1600, 1000);
  assert.equal(winEval.status, 'victory');
});

test('N-body stars mutually attract, conserve momentum, and orbit cleanly', () => {
  const binary: MassBody[] = [
    {
      id: 'star-1',
      x: 0,
      y: -155,
      vx: 150,
      vy: 0,
      mu: 46000,
      softening: 38,
      radius: 30,
      spin: 0,
      kind: 'star',
    },
    {
      id: 'star-2',
      x: 0,
      y: 155,
      vx: -150,
      vy: 0,
      mu: 46000,
      softening: 38,
      radius: 30,
      spin: 0,
      kind: 'compact',
    },
  ];

  let current = binary;
  for (let i = 0; i < 60; i++) {
    const res = stepMassBodiesNBody(current, 0.032, 860, {
      containInArena: false,
      mergeOnCollision: false,
    });
    current = res.masses;
  }

  // Stars must have moved from initial x = 0 positions along mutual orbit
  assert.ok(Math.abs(current[0].x) > 50, 'Star 1 should move tangentially in orbit');
  assert.ok(Math.abs(current[1].x) > 50, 'Star 2 should move tangentially in orbit');

  // Linear momentum must remain near zero (equal and opposite mutual pull)
  const px = current[0].mu * (current[0].vx ?? 0) + current[1].mu * (current[1].vx ?? 0);
  const py = current[0].mu * (current[0].vy ?? 0) + current[1].mu * (current[1].vy ?? 0);
  assert.ok(Math.abs(px) < 1e-3 && Math.abs(py) < 1e-3, `Expected conserved momentum, got (${px}, ${py})`);

  // Dynamic trajectory prediction reflects moving N-body sampler
  const sampler = new Direct2Plus1DFieldSampler(binary, new CpuGravityGridSolver().config);
  const sample = sampler.sampleAt(-200, 0);
  assert.ok(Number.isFinite(sample.gx) && sample.gx > 0);
});

test('colliding N-body stars merge while conserving total mu and momentum', () => {
  const pair: MassBody[] = [
    {
      id: 'a',
      x: -10,
      y: 0,
      vx: 80,
      vy: 0,
      mu: 30000,
      softening: 25,
      radius: 24,
      spin: 100,
      kind: 'star',
    },
    {
      id: 'b',
      x: 10,
      y: 0,
      vx: -40,
      vy: 0,
      mu: 20000,
      softening: 25,
      radius: 24,
      spin: 50,
      kind: 'star',
    },
  ];

  const res = stepMassBodiesNBody(pair, 0.03, 900, { mergeOnCollision: true });
  assert.equal(res.masses.length, 1);
  assert.equal(res.mergers.length, 1);
  assert.equal(res.masses[0].mu, 50000);
  assert.equal(res.masses[0].spin, 150);
  // Momentum-weighted velocity: (30000*80 + 20000*-40) / 50000 = 32
  assert.ok(Math.abs((res.masses[0].vx ?? 0) - 32) < 2.5);
});

test('offscreen movement is allowed while escaping gravitational field destroys rocket and stars', () => {
  const star: MassBody = {
    id: 'core',
    x: 0,
    y: 0,
    mu: 64000,
    softening: 40,
    radius: 34,
    spin: 0,
    kind: 'star',
  };
  const solver = new CpuGravityGridSolver();
  solver.computeGrid([star]);

  // Offscreen sampling at x=1200 should follow 1/r (~ -64000/1200 = -53.3), not clamp to x=800 (-80)
  const offSample = solver.sampleAt(1200, 0);
  assert.ok(offSample.gx < -45 && offSample.gx > -62, `Expected offscreen 1/r gx ~ -53.3, got ${offSample.gx}`);

  // Rocket flying offscreen at x=1050 (beyond 800 viewport half-width) with inward pull |g|~61 remains flying
  const offscreenRocket = createInitialRocketState(1050, 0, 0, 100, 220);
  const offEval = evaluateFlightState(offscreenRocket, [star], { x: 500, y: 0, radius: 40, maxCaptureSpeed: 0 }, [], DEFAULT_ROCKET_CONFIG);
  assert.equal(offEval.status, 'flying');

  // Rocket far offscreen moving outward in weak field (tiny mass -> |g| < 14 at r=1400) is destroyed
  const weakStar: MassBody = { ...star, mu: 5000 };
  const escapingRocket = createInitialRocketState(1400, 0, 0, 100, 300);
  const escEval = evaluateFlightState(escapingRocket, [weakStar], { x: 500, y: 0, radius: 40, maxCaptureSpeed: 0 }, [], DEFAULT_ROCKET_CONFIG);
  assert.equal(escEval.status, 'crashed');

  // N-body star allowed offscreen (x=950 > 800) stays alive while bound, and is destroyed if it escapes universe
  const boundPair: MassBody[] = [
    { ...star, id: 'anchor', pinned: true, mu: 80000 },
    { id: 'wanderer', x: 950, y: 0, vx: 0, vy: 120, mu: 4000, softening: 20, radius: 14, spin: 0, kind: 'asteroid' },
  ];
  const offscreenStep = stepMassBodiesNBody(boundPair, 0.032, 900, { containInArena: false, destroyOnEscape: true });
  assert.equal(offscreenStep.masses.length, 2);
  assert.ok(offscreenStep.masses[1].x > 800);

  const escapedPair: MassBody[] = [
    { ...star, id: 'anchor', pinned: true, mu: 5000 },
    { id: 'escapee', x: 1500, y: 0, vx: 280, vy: 0, mu: 1000, softening: 20, radius: 14, spin: 0, kind: 'asteroid' },
  ];
  const escapeStep = stepMassBodiesNBody(escapedPair, 0.032, 900, { containInArena: false, destroyOnEscape: true });
  assert.equal(escapeStep.masses.length, 1);
  assert.equal(escapeStep.escaped.length, 1);
  assert.equal(escapeStep.escaped[0].id, 'escapee');
});
