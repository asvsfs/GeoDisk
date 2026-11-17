/**
 * @fileoverview Game server entry point.
 *
 * Runs one authoritative room over WebTransport (UDP/QUIC). A small HTTP
 * listener serves the built client, `/wt-info` (where the WebTransport
 * endpoint is and which certificate hash to pin) and `/stats` (live load and
 * limits). All game traffic goes over WebTransport.
 *
 * Environment (limits and load: see env.ts):
 *   WT_PORT (4433), HTTP_PORT (8080), HOST (:: = dual-stack), PUBLIC_HOSTS
 *   (comma list for the self-signed cert, default "localhost,127.0.0.1"),
 *   CERT_FILE + KEY_FILE (CA-issued PEM; disables hash pinning), SEED,
 *   CLIENT_DIR (built client, default ./dist).
 */

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import {extname, join, normalize, resolve} from 'node:path';
import {mergeConfig, type GameConfig} from '../shared/config';
import {Room} from '../shared/game/room';
import {calibrate, calibratedLimits, snapshotBytes} from './calibrate';
import {fromFiles, selfSigned, type CertBundle} from './cert';
import {readEnv, type EnvConfig} from './env';
import {WtHost} from './wt_host';

const WT_PATH = '/geodisk';
const DIST = resolve(process.env.CLIENT_DIR ?? 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function log(line: string): void {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

async function loadCert(): Promise<CertBundle> {
  const {CERT_FILE, KEY_FILE} = process.env;
  if (CERT_FILE && KEY_FILE) return fromFiles(CERT_FILE, KEY_FILE);
  const hosts = (process.env.PUBLIC_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);
  return selfSigned(hosts);
}

async function main(): Promise<void> {
  const wtPort = envInt('WT_PORT', 4433);
  const httpPort = envInt('HTTP_PORT', 8080);
  const host = process.env.HOST ?? '::';
  const cfg = sizeLimits(readEnv());

  const cert = await loadCert();
  const wt = new WtHost({host, port: wtPort, path: WT_PATH, cert, log});
  const room = new Room(wt, cfg, {
    seed: envInt('SEED', Date.now() & 0xffff),
    log,
  });
  await room.start();
  log(
    `WebTransport on udp/${wtPort}${WT_PATH} (${cert.hash ? 'self-signed, pinned' : 'CA cert'})`,
  );
  if (cert.hash) {
    const days = Math.round((cert.expires.getTime() - Date.now()) / 86_400_000);
    log(`certificate expires in ${days} days; restart the server before then`);
  }

  const info = JSON.stringify({
    port: wtPort,
    path: WT_PATH,
    certHashes: cert.hash ? [cert.hash] : [],
  });
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/stats') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(room.stats(), null, 2));
      return;
    }
    if (url.pathname === '/wt-info') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(info);
      return;
    }
    void serveStatic(url.pathname, res);
  });
  http.listen(httpPort, host, () =>
    log(`HTTP on tcp/${httpPort} (client, /wt-info, /stats)`),
  );

  const shutdown = async () => {
    log('shutting down');
    http.close();
    await room.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/**
 * Applies calibration (AUTO_LIMITS=1) and the upload budget to the caps,
 * never overriding values the operator set explicitly, and logs the result.
 */
function sizeLimits(env: EnvConfig): GameConfig {
  let cfg = env.cfg;
  if (env.autoLimits) {
    const t0 = performance.now();
    const cal = calibrate(cfg);
    cfg = mergeConfig(cfg, {limits: calibratedLimits(cal, env.explicit)});
    log(
      `calibrated in ${Math.round(performance.now() - t0)} ms: ` +
        `physics budget ${cal.stepBudgetMs.toFixed(2)} ms/step fits ` +
        `${cal.cpuBodies} bodies; using ${cal.maxBodies} bodies, ` +
        `${cal.maxSats} satellites, ${cal.maxPlayers} players ` +
        `(limited by ${cal.limitedBy})`,
    );
  }
  const lim = cfg.limits;
  const perPlayer =
    snapshotBytes(lim.maxBodies, lim.maxSats) * cfg.world.snapHz * 1.06;
  if (lim.maxUploadMbps > 0) {
    const fit = Math.max(
      1,
      Math.floor((lim.maxUploadMbps * 125_000) / perPlayer),
    );
    if (fit < lim.maxPlayers) {
      if (env.explicit.maxPlayers === undefined) {
        cfg = mergeConfig(cfg, {limits: {maxPlayers: fit}});
        log(
          `upload budget ${lim.maxUploadMbps} Mbit/s fits ${fit} players at full caps`,
        );
      } else {
        log(
          `warning: MAX_PLAYERS=${lim.maxPlayers} exceeds the ${fit} the upload ` +
            `budget fits at full caps; the snapshot rate will drop under load`,
        );
      }
    }
  }
  const l = cfg.limits;
  log(
    `limits: ${l.maxBodies} bodies, ${l.maxSats} satellites (${l.maxSatsPerPlayer}/player), ` +
      `${l.maxPlayers} players, cpu share ${l.cpuShare}, ` +
      `snapshots ${l.minSnapHz}-${cfg.world.snapHz} Hz, ` +
      `upload ${l.maxUploadMbps > 0 ? `${l.maxUploadMbps} Mbit/s` : 'unlimited'} ` +
      `(${((perPlayer * 8) / 1e6).toFixed(2)} Mbit/s per player at full caps)`,
  );
  return cfg;
}

async function serveStatic(
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, rel || 'index.html');
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    file = join(DIST, 'index.html');
    try {
      await stat(file);
    } catch {
      res
        .writeHead(404, {'Content-Type': 'text/plain'})
        .end('Client not built. Run `npm run build`.');
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
