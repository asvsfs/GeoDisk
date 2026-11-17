/**
 * @fileoverview `npm run calibrate`: benchmarks this host and prints the
 * limits that fit its CPU and bandwidth budget.
 *
 * Honours CPU_SHARE, MAX_UPLOAD_MBPS, SNAP_HZ and MAX_PLAYERS (see env.ts).
 */

import {calibrate} from './calibrate';
import {readEnv} from './env';

const {cfg} = readEnv();
const lim = cfg.limits;
console.log(
  `Calibrating: cpu share ${lim.cpuShare} of one core, ` +
    `${cfg.world.snapHz} snapshots/s, upload ` +
    `${lim.maxUploadMbps > 0 ? `${lim.maxUploadMbps} Mbit/s` : 'unlimited'}\n`,
);
const t0 = performance.now();
const cal = calibrate(cfg);
console.log('  bodies   sats   physics ms/step   encode ms/snapshot');
for (const p of cal.points) {
  const mark = p.bodies === cal.cpuBodies ? '  <- CPU fit' : '';
  console.log(
    `${String(p.bodies).padStart(8)} ${String(p.sats).padStart(6)} ` +
      `${p.stepMs.toFixed(3).padStart(17)} ${p.encodeMs.toFixed(3).padStart(20)}${mark}`,
  );
}
const mbps = (cal.bytesPerPlayer * 8) / 1e6;
console.log(
  `\nPhysics budget: ${cal.stepBudgetMs.toFixed(2)} ms per step ` +
    `(${lim.cpuShare} x 16.7 ms x 70%; the rest is networking and GC).`,
);
console.log(`Bandwidth at full caps: ${mbps.toFixed(2)} Mbit/s per player.`);
if (cal.limitedBy === 'upload') {
  console.log(
    `Upload budget: shrank the world from ${cal.cpuBodies} to ${cal.maxBodies} ` +
      `bodies so ${cal.maxPlayers} players fit.`,
  );
} else if (Number.isFinite(cal.playersByUpload)) {
  console.log(`Upload budget fits ${cal.playersByUpload} players.`);
}
console.log(`Took ${((performance.now() - t0) / 1000).toFixed(1)} s.\n`);
console.log('Recommended:');
console.log(
  `  MAX_BODIES=${cal.maxBodies} MAX_SATS=${cal.maxSats} MAX_PLAYERS=${cal.maxPlayers} npm start`,
);
console.log('or let the server measure itself at startup:');
console.log('  AUTO_LIMITS=1 npm start');
