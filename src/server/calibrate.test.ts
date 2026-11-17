import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_CONFIG, mergeConfig} from '../shared/config';
import {calibrate, calibratedLimits, snapshotBytes} from './calibrate';

test('calibration finds caps that fit the budget and respects overrides', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    limits: {cpuShare: 0.2, maxUploadMbps: 20},
  });
  const cal = calibrate(cfg, {steps: 8});
  assert.ok(cal.maxBodies >= 8 && cal.maxBodies <= 256);
  assert.equal(cal.maxSats, Math.round(cal.maxBodies * 4));
  const fit = cal.points.find(p => p.bodies === cal.maxBodies);
  if (fit) assert.ok(fit.stepMs <= cal.stepBudgetMs);
  // Players come first: 16 players must fit in 20 Mbit/s, shrinking the
  // world (to about 36 bodies at 30 snapshots/s).
  assert.equal(cal.maxPlayers, 16);
  assert.ok(cal.bytesPerPlayer * 16 <= 2_500_000);
  if (cal.maxBodies < cal.cpuBodies) assert.equal(cal.limitedBy, 'upload');
  const lim = calibratedLimits(cal, {maxBodies: 50});
  assert.equal(lim.maxBodies, 50, 'explicit values win');
  assert.equal(lim.maxSats, cal.maxSats);
});

test('a tiny upload budget cuts players once the world is at its floor', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {limits: {maxUploadMbps: 0.5}});
  const cal = calibrate(cfg, {steps: 4});
  assert.equal(cal.maxBodies, Math.min(32, cal.cpuBodies));
  assert.ok(cal.maxPlayers < 16);
});

test('snapshot size matches the wire format', () => {
  assert.equal(snapshotBytes(2, 1), 21 + 2 * 38 + 24);
});
