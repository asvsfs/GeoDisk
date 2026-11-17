import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CpuGravityGridSolver,
  Direct3DFieldSampler,
  advanceOrbitingMasses,
  evaluateSingleMass3D,
  stepMassBodiesNBody,
} from './gravityField';
import {
  DEFAULT_ROCKET_CONFIG,
  NewtonianRocketPhysics,
  Relativistic3DRocketPhysics,
  createInitialRocketState,
  predictTrajectory,
} from './rocketPhysics';
import { evaluateFlightState, generateDeterministicCluster } from '../game/missions';
import {
  CAMERA_LIMITS,
  clampCamera,
  computeViewportTransform,
  screenToWorld,
  worldToScreen,
  zoomCameraAroundPoint,
} from '../gpu/spacetimeCanvasRenderer';
import type { MassBody } from './types';

test('3D uniform grid computes exact linear sum of gravities and Lense-Thirring field from multiple masses', () => {
  const masses: MassBody[] = [
    {
      id: 'm1',
      x: -200,
      y: 0,
      z: 40,
      mu: 8000000,
      softening: 30,
      radius: 25,
      spin: 12000,
      kind: 'star',
    },
    {
      id: 'm2',
      x: 200,
      y: 100,
      z: -60,
      mu: 5000000,
      softening: 25,
      radius: 20,
      spin: -6000,
      kind: 'compact',
    },
  ];

  const solver = new CpuGravityGridSolver({
    cols: 81,
    rows: 51,
    layers: 13,
    worldWidth: 1600,
    worldHeight: 1000,
    worldDepth: 600,
    speedOfLight: 900,
  });
  solver.computeGrid(masses);

  // Sample exact 3D grid node (x = 0, y = 0, z = 0) -> col=40, row=25, layer=6
  const sample = solver.sampleAt(0, 0, 0);
  const c1 = evaluateSingleMass3D(0, 0, 0, masses[0], 900);
  const c2 = evaluateSingleMass3D(0, 0, 0, masses[1], 900);

  assert.ok(Math.abs(sample.phi - (c1.phi + c2.phi)) < 1);
  assert.ok(Math.abs(sample.gx - (c1.gx + c2.gx)) < 1e-2);
  assert.ok(Math.abs(sample.gy - (c1.gy + c2.gy)) < 1e-2);
  assert.ok(Math.abs(sample.gz - (c1.gz + c2.gz)) < 1e-2);
  assert.ok(Math.abs(sample.bx - (c1.bx + c2.bx)) < 1e-3);
  assert.ok(Math.abs(sample.by - (c1.by + c2.by)) < 1e-3);
  assert.ok(Math.abs(sample.bz - (c1.bz + c2.bz)) < 1e-3);
});

test('3D gravity follows 1/r^2 inverse-square law and softens cleanly at core', () => {
  const star: MassBody = {
    id: 'star',
    x: 0,
    y: 0,
    z: 0,
    mu: 12000000,
    softening: 12,
    radius: 20,
    spin: 0,
    kind: 'star',
  };

  const solver = new CpuGravityGridSolver();
  solver.computeGrid([star]);

  const s100 = solver.sampleAt(100, 0, 0);
  const s200 = solver.sampleAt(200, 0, 0);
  const center = solver.sampleAt(0, 0, 0);

  // Force points inward (-x)
  assert.ok(s100.gx < 0);
  // In 3D space, |g| scales ~ 1/r^2 (so at r=100 it is ~4x stronger than at r=200)
  const ratio = Math.abs(s100.gx) / Math.abs(s200.gx);
  assert.ok(ratio > 3.6 && ratio < 4.4, `Expected ~4.0 3D 1/r^2 ratio, got ${ratio}`);
  assert.ok(Number.isFinite(center.phi) && Number.isFinite(center.gx));
  assert.ok(center.lapse < 1 && center.lapse > 0);
});

test('3D 1PN Relativistic Rocket Physics exhibits time dilation, frame-dragging, and 3D deflection vs Newtonian', () => {
  const spinningSingularity: MassBody = {
    id: 'bh',
    x: 0,
    y: 0,
    z: 55,
    mu: 15000000,
    softening: 35,
    radius: 28,
    spin: 22000,
    kind: 'singularity',
  };

  const solver = new CpuGravityGridSolver({ speedOfLight: 650 });
  solver.computeGrid([spinningSingularity]);

  const grPhysics = new Relativistic3DRocketPhysics();
  const newtonPhysics = new NewtonianRocketPhysics();

  const initial = createInitialRocketState(-350, -140, 0, 100, 320, 0, 0);

  const grTraj = predictTrajectory(
    initial,
    grPhysics,
    solver,
    [spinningSingularity],
    DEFAULT_ROCKET_CONFIG,
    60,
    0.032
  );
  const newtonTraj = predictTrajectory(
    initial,
    newtonPhysics,
    solver,
    [spinningSingularity],
    DEFAULT_ROCKET_CONFIG,
    60,
    0.032
  );

  assert.ok(grTraj.length > 20 && newtonTraj.length > 20);
  const endGr = grTraj[grTraj.length - 1];
  const endNewt = newtonTraj[newtonTraj.length - 1];
  const divergence = Math.hypot(endGr.x - endNewt.x, endGr.y - endNewt.y, endGr.z - endNewt.z);
  assert.ok(divergence > 5, `Expected 3D relativistic trajectory divergence > 5, got ${divergence}`);
  assert.ok(Math.abs(endGr.z) > 1, 'Rocket should deflect into 3D z when attracted by off-plane mass');

  let rocket = initial;
  for (let i = 0; i < 40; i++) {
    rocket = grPhysics.step(rocket, { throttle: 0, turn: 0 }, solver, 0.032, DEFAULT_ROCKET_CONFIG);
  }
  assert.ok(rocket.properTime < rocket.coordTime, 'Proper time should dilate inside gravity well');
  assert.ok(rocket.minLapse < 1.0);
});

test('3D orbiting masses advance cleanly and 3D cluster generator scales to many masses', () => {
  const cluster = generateDeterministicCluster(64, 123);
  assert.ok(cluster.length >= 50);

  const solver = new CpuGravityGridSolver();
  const t0 = performance.now();
  solver.computeGrid(cluster);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 300, `Expected fast CPU 3D grid compute for 64 masses, took ${elapsed}ms`);

  const orbiter: MassBody[] = [
    {
      id: 'orb',
      x: 100,
      y: 0,
      z: 0,
      mu: 5000000,
      softening: 20,
      radius: 15,
      spin: 0,
      kind: 'star',
      orbit: {
        centerX: 0,
        centerY: 0,
        centerZ: 0,
        orbitRadius: 100,
        angularSpeed: Math.PI / 2,
        phase: 0,
        zAmplitude: 30,
      },
    },
  ];
  const moved = advanceOrbitingMasses(orbiter, 1.0);
  assert.ok(Math.abs(moved[0].x) < 1e-4 && Math.abs(moved[0].y - 100) < 1e-4);
  assert.ok(Math.abs((moved[0].z ?? 0) - 30) < 1e-4);
});

test('flight evaluation triggers victory, waypoint collection, and event-horizon crash in 3D', () => {
  const masses: MassBody[] = [
    {
      id: 'bh',
      x: 0,
      y: 0,
      z: 0,
      mu: 12000000,
      softening: 30,
      radius: 30,
      spin: 0,
      kind: 'singularity',
    },
  ];
  const target = { x: 400, y: 0, radius: 40, maxCaptureSpeed: 0 };
  const waypoints = [{ id: 'wp1', x: -150, y: 0, radius: 25, collected: false }];

  const crashedRocket = createInitialRocketState(10, 0, 0, 100, 100, 0, 0);
  const crashEval = evaluateFlightState(
    crashedRocket,
    masses,
    target,
    waypoints,
    DEFAULT_ROCKET_CONFIG,
    1600,
    1000
  );
  assert.equal(crashEval.status, 'crashed');

  const wpRocket = createInitialRocketState(-150, 0, 0, 100, 100, 0, 0);
  const wpEval = evaluateFlightState(
    wpRocket,
    masses,
    target,
    waypoints,
    DEFAULT_ROCKET_CONFIG,
    1600,
    1000
  );
  assert.equal(wpEval.status, 'flying');
  assert.deepEqual(wpEval.collectedWaypointIds, ['wp1']);

  const winRocket = createInitialRocketState(395, 0, 0, 100, 100, 0, 0);
  const winEval = evaluateFlightState(
    winRocket,
    masses,
    target,
    waypoints,
    DEFAULT_ROCKET_CONFIG,
    1600,
    1000
  );
  assert.equal(winEval.status, 'victory');
});

test('3D N-body stars mutually attract, conserve 3D momentum, and orbit cleanly', () => {
  const binary: MassBody[] = [
    {
      id: 'star-1',
      x: 0,
      y: -155,
      z: -32,
      vx: 126,
      vy: 0,
      vz: 24,
      mu: 10500000,
      softening: 38,
      radius: 30,
      spin: 0,
      kind: 'star',
    },
    {
      id: 'star-2',
      x: 0,
      y: 155,
      z: 32,
      vx: -126,
      vy: 0,
      vz: -24,
      mu: 10500000,
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

  assert.ok(Math.abs(current[0].x) > 50, 'Star 1 should move tangentially in 3D orbit');
  assert.ok(Math.abs(current[1].x) > 50, 'Star 2 should move tangentially in 3D orbit');

  const px = current[0].mu * (current[0].vx ?? 0) + current[1].mu * (current[1].vx ?? 0);
  const py = current[0].mu * (current[0].vy ?? 0) + current[1].mu * (current[1].vy ?? 0);
  const pz = current[0].mu * (current[0].vz ?? 0) + current[1].mu * (current[1].vz ?? 0);
  assert.ok(
    Math.abs(px) < 1e-2 && Math.abs(py) < 1e-2 && Math.abs(pz) < 1e-2,
    `Expected conserved 3D momentum, got (${px}, ${py}, ${pz})`
  );

  const sampler = new Direct3DFieldSampler(binary, new CpuGravityGridSolver().config);
  const sample = sampler.sampleAt(-200, 0, 0);
  assert.ok(Number.isFinite(sample.gx) && sample.gx > 0);
});

test('colliding 3D N-body stars merge while conserving total mu and 3D momentum', () => {
  const pair: MassBody[] = [
    {
      id: 'a',
      x: -10,
      y: 0,
      z: -4,
      vx: 80,
      vy: 0,
      vz: 10,
      mu: 6000000,
      softening: 25,
      radius: 24,
      spin: 100,
      kind: 'star',
    },
    {
      id: 'b',
      x: 10,
      y: 0,
      z: 4,
      vx: -40,
      vy: 0,
      vz: -5,
      mu: 4000000,
      softening: 25,
      radius: 24,
      spin: 50,
      kind: 'star',
    },
  ];

  const res = stepMassBodiesNBody(pair, 0.03, 900, { mergeOnCollision: true });
  assert.equal(res.masses.length, 1);
  assert.equal(res.mergers.length, 1);
  assert.equal(res.masses[0].mu, 10000000);
  assert.equal(res.masses[0].spin, 150);
  // Momentum-weighted 3D velocity: (6e6*80 + 4e6*-40) / 1e7 = 32, z: (6e6*10 + 4e6*-5) / 1e7 = 4
  assert.ok(Math.abs((res.masses[0].vx ?? 0) - 32) < 2.5);
  assert.ok(Math.abs((res.masses[0].vz ?? 0) - 4) < 2.5);
});

test('offscreen 3D movement is allowed while escaping gravitational field destroys rocket and stars', () => {
  const star: MassBody = {
    id: 'core',
    x: 0,
    y: 0,
    z: 0,
    mu: 13200000,
    softening: 40,
    radius: 34,
    spin: 0,
    kind: 'star',
  };
  const solver = new CpuGravityGridSolver();
  solver.computeGrid([star]);

  // Offscreen sampling at x=1200, z=0 should follow 3D 1/r^2 (-13.2e6 / 1200^2 ~ -9.16)
  const offSample = solver.sampleAt(1200, 0, 0);
  assert.ok(offSample.gx < -8.5 && offSample.gx > -9.8, `Expected offscreen 1/r^2 gx ~ -9.16, got ${offSample.gx}`);

  // Rocket flying offscreen at x=1050 (beyond 800 viewport half-width) remains flying while bound
  const offscreenRocket = createInitialRocketState(1050, 0, 0, 100, 220);
  const offEval = evaluateFlightState(
    offscreenRocket,
    [star],
    { x: 500, y: 0, radius: 40, maxCaptureSpeed: 0 },
    [],
    DEFAULT_ROCKET_CONFIG
  );
  assert.equal(offEval.status, 'flying');

  // Rocket far offscreen moving outward in weak 3D field (tiny mass -> |g| < 3.2 at r=1400) is destroyed
  const weakStar: MassBody = { ...star, mu: 500000 };
  const escapingRocket = createInitialRocketState(1400, 0, 0, 100, 300);
  const escEval = evaluateFlightState(
    escapingRocket,
    [weakStar],
    { x: 500, y: 0, radius: 40, maxCaptureSpeed: 0 },
    [],
    DEFAULT_ROCKET_CONFIG
  );
  assert.equal(escEval.status, 'crashed');

  // N-body star allowed offscreen (x=950 > 800) stays alive while bound, and is destroyed if it escapes universe
  const boundPair: MassBody[] = [
    { ...star, id: 'anchor', pinned: true, mu: 15000000 },
    {
      id: 'wanderer',
      x: 950,
      y: 0,
      z: 30,
      vx: 0,
      vy: 120,
      vz: 0,
      mu: 800000,
      softening: 20,
      radius: 14,
      spin: 0,
      kind: 'asteroid',
    },
  ];
  const offscreenStep = stepMassBodiesNBody(boundPair, 0.032, 900, {
    containInArena: false,
    destroyOnEscape: true,
  });
  assert.equal(offscreenStep.masses.length, 2);
  assert.ok(offscreenStep.masses[1].x > 800);

  const escapedPair: MassBody[] = [
    { ...star, id: 'anchor', pinned: true, mu: 500000 },
    {
      id: 'escapee',
      x: 1500,
      y: 0,
      z: 0,
      vx: 280,
      vy: 0,
      vz: 0,
      mu: 100000,
      softening: 20,
      radius: 14,
      spin: 0,
      kind: 'asteroid',
    },
  ];
  const escapeStep = stepMassBodiesNBody(escapedPair, 0.032, 900, {
    containInArena: false,
    destroyOnEscape: true,
  });
  assert.equal(escapeStep.masses.length, 1);
  assert.equal(escapeStep.escaped.length, 1);
  assert.equal(escapeStep.escaped[0].id, 'escapee');
});

test('camera clamping and cursor-anchored zooming preserve world focus across zoom levels', () => {
  const clampedLow = clampCamera(-5000, 4200, 0.05);
  assert.equal(clampedLow.zoom, CAMERA_LIMITS.minZoom);
  assert.equal(clampedLow.camX, -2400);
  assert.equal(clampedLow.camY, 1500);

  const clampedHigh = clampCamera(5000, -4200, 8.0);
  assert.equal(clampedHigh.zoom, CAMERA_LIMITS.maxZoom);
  assert.equal(clampedHigh.camX, 2400);
  assert.equal(clampedHigh.camY, -1500);

  const cssWidth = 1440;
  const cssHeight = 900;
  const worldWidth = 1600;
  const worldHeight = 1000;
  const initialCam = { camX: 120, camY: -80, zoom: 1.0 };
  const cursorX = 1040;
  const cursorY = 270;

  const vpBefore = computeViewportTransform(
    cssWidth,
    cssHeight,
    worldWidth,
    worldHeight,
    initialCam.camX,
    initialCam.camY,
    initialCam.zoom
  );
  const worldUnderCursorBefore = screenToWorld(cursorX, cursorY, vpBefore);

  const zoomedOut = zoomCameraAroundPoint(
    initialCam,
    0.45,
    cursorX,
    cursorY,
    cssWidth,
    cssHeight,
    worldWidth,
    worldHeight
  );
  const vpAfterOut = computeViewportTransform(
    cssWidth,
    cssHeight,
    worldWidth,
    worldHeight,
    zoomedOut.camX,
    zoomedOut.camY,
    zoomedOut.zoom
  );
  const screenAfterOut = worldToScreen(worldUnderCursorBefore.x, worldUnderCursorBefore.y, vpAfterOut);
  assert.ok(Math.abs(screenAfterOut.x - cursorX) < 1e-4);
  assert.ok(Math.abs(screenAfterOut.y - cursorY) < 1e-4);

  const zoomedIn = zoomCameraAroundPoint(
    zoomedOut,
    1.85,
    cursorX,
    cursorY,
    cssWidth,
    cssHeight,
    worldWidth,
    worldHeight
  );
  const vpAfterIn = computeViewportTransform(
    cssWidth,
    cssHeight,
    worldWidth,
    worldHeight,
    zoomedIn.camX,
    zoomedIn.camY,
    zoomedIn.zoom
  );
  const screenAfterIn = worldToScreen(worldUnderCursorBefore.x, worldUnderCursorBefore.y, vpAfterIn);
  assert.ok(Math.abs(screenAfterIn.x - cursorX) < 1e-4);
  assert.ok(Math.abs(screenAfterIn.y - cursorY) < 1e-4);
});
