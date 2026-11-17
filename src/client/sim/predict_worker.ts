/**
 * @fileoverview Web Worker that computes aiming previews off the main thread.
 */

import type {GameConfig} from '../../shared/config';
import {predictPath, type PathPoint} from '../../shared/sim/predict';
import type {PredictRequest} from './predictor';

interface WorkerScope {
  onmessage: ((e: MessageEvent<PredictRequest>) => void) | null;
  postMessage(msg: {seq: number; path: PathPoint[]}): void;
}

const scope = self as unknown as WorkerScope;
let cfg: GameConfig | null = null;

scope.onmessage = e => {
  const req = e.data;
  if (req.config) cfg = req.config;
  if (!cfg) return;
  const path = predictPath(cfg, req.bodies, req.shot, {
    seconds: req.seconds,
    lead: req.lead,
  });
  scope.postMessage({seq: req.seq, path});
};
