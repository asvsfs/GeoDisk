/**
 * @fileoverview Runs aiming previews in a Web Worker so even a full world
 * (where one preview costs over a frame budget) never stalls rendering.
 *
 * At most one request is in flight; while the worker is busy, only the
 * newest request is kept. Without Worker support it computes inline.
 */

import type {GameConfig} from '../../shared/config';
import {predictPath, type PathPoint, type Shot} from '../../shared/sim/predict';
import type {Body} from '../../shared/types';

/** Message sent to the worker. */
export interface PredictRequest {
  seq: number;
  /** Sent once, with the first request. */
  config?: GameConfig;
  bodies: Body[];
  shot: Shot;
  seconds: number;
  lead: number;
}

/** Latest-wins preview computer. */
export class Predictor {
  /** Most recent completed path. */
  path: PathPoint[] = [];
  private worker: Worker | null = null;
  private busy = false;
  private queued: PredictRequest | null = null;
  private seq = 0;
  private configSent = false;

  constructor(private readonly cfg: GameConfig) {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(
        new URL('./predict_worker.ts', import.meta.url),
        {
          type: 'module',
        },
      );
      this.worker.onmessage = (
        e: MessageEvent<{seq: number; path: PathPoint[]}>,
      ) => {
        this.busy = false;
        if (e.data.seq === this.seq) this.path = e.data.path;
        this.flush();
      };
      this.worker.onerror = () => {
        // Fall back to inline computation if the worker cannot load.
        this.worker?.terminate();
        this.worker = null;
        this.busy = false;
      };
    } catch {
      this.worker = null;
    }
  }

  /** Requests a preview; the result lands in `path` when ready. */
  request(
    bodies: readonly Body[],
    shot: Shot,
    seconds: number,
    lead: number,
  ): void {
    const req: PredictRequest = {
      seq: ++this.seq,
      bodies: bodies.map(b => ({...b})),
      shot,
      seconds,
      lead,
    };
    if (!this.worker) {
      this.path = predictPath(this.cfg, req.bodies, shot, {seconds, lead});
      return;
    }
    this.queued = req;
    this.flush();
  }

  /** Clears the current path (e.g. when the aiming tool is put away). */
  clear(): void {
    this.seq++;
    this.queued = null;
    this.path = [];
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private flush(): void {
    if (this.busy || !this.queued || !this.worker) return;
    const req = this.queued;
    this.queued = null;
    if (!this.configSent) {
      req.config = this.cfg;
      this.configSent = true;
    }
    this.busy = true;
    this.worker.postMessage(req);
  }
}
