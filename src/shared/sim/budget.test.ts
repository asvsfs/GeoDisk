import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_CONFIG} from '../config';
import {Budget, type LoadSample} from './budget';

const lim = {...DEFAULT_CONFIG.limits, cpuShare: 0.5, minSnapHz: 15};
const pump = (busyFrac: number, bytesPerSec = 0): LoadSample => ({
  elapsedMs: 50,
  physicsMs: 50 * busyFrac * 0.8,
  netMs: 50 * busyFrac * 0.2,
  bytes: bytesPerSec / 20,
  steps: 3,
});
const run = (b: Budget, s: LoadSample, seconds: number) => {
  for (let t = 0; t < seconds * 20; t++) b.record(s);
};

test('overload lowers the snapshot rate before shrinking caps', () => {
  const b = new Budget(lim, 30);
  run(b, pump(0.9), 1.5);
  assert.ok(b.snapHz < 30, 'rate dropped first');
  assert.equal(b.scale, 1, 'caps untouched while the rate can drop');
  run(b, pump(0.9), 10);
  assert.equal(b.snapHz, 15, 'stops at minSnapHz');
  assert.ok(b.scale < 1 && b.bodyCap() < lim.maxBodies, 'then caps shrink');
  assert.ok(b.scale >= 0.25);
});

test('recovery grows caps back first, then the snapshot rate', () => {
  const b = new Budget(lim, 30);
  run(b, pump(0.9), 15);
  run(b, pump(0.05), 3);
  assert.ok(b.scale > 0.25);
  assert.equal(b.snapHz, 15, 'rate waits until caps are restored');
  run(b, pump(0.05), 60);
  assert.equal(b.scale, 1);
  assert.equal(b.snapHz, 30);
});

test('the upload budget sheds load like the CPU budget', () => {
  const b = new Budget({...lim, maxUploadMbps: 1}, 30);
  run(b, pump(0.05, 400_000), 3); // 3.2 Mbit/s against a 1 Mbit/s budget.
  assert.ok(b.snapHz < 30);
});

test('steady moderate load changes nothing', () => {
  const b = new Budget(lim, 30);
  run(b, pump(0.4), 10);
  assert.equal(b.snapHz, 30);
  assert.equal(b.scale, 1);
  assert.ok(Math.abs(b.cpu - 0.4) < 0.02);
});
