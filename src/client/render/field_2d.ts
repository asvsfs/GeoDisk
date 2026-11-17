/**
 * @fileoverview Canvas 2D fallback for the spacetime field when WebGPU is
 * unavailable: body glows, a gravity-warped lattice, and potential contours.
 */

import type {Body} from '../../shared/types';
import {newSample, type FieldSolver} from '../../shared/sim/gravity';
import {toScreen, type ViewMode, type Viewport} from './camera';

const BG = '#070A10';
const MAX_WARP = 62;
const WARP = 0.095;
const CONTOUR_STEP = 22000;

/** Draws the field background for `bodies` sampled through `field`. */
export function drawField2d(
  ctx: CanvasRenderingContext2D,
  field: FieldSolver,
  bodies: readonly Body[],
  mode: ViewMode,
  c: number,
  vp: Viewport,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, vp.width, vp.height);
  drawGlows(ctx, bodies, vp);

  const left = -vp.offsetX / vp.scale;
  const right = (vp.width - vp.offsetX) / vp.scale;
  const top = -vp.offsetY / vp.scale;
  const bottom = (vp.height - vp.offsetY) / vp.scale;
  const s = newSample();

  if (mode === 'contours') {
    const cols = 72;
    const rows = 45;
    const dx = (right - left) / cols;
    const dy = (bottom - top) / rows;
    const c2 = c * c;
    for (let r = 0; r < rows; r++) {
      const y0 = top + r * dy;
      for (let k = 0; k < cols; k++) {
        const x0 = left + k * dx;
        const p0 = field.sample(x0, y0, 0, s).phi;
        const p1 = field.sample(x0 + dx, y0, 0, s).phi;
        const p2 = field.sample(x0, y0 + dy, 0, s).phi;
        const b0 = Math.floor(p0 / CONTOUR_STEP);
        if (
          b0 === Math.floor(p1 / CONTOUR_STEP) &&
          b0 === Math.floor(p2 / CONTOUR_STEP)
        )
          continue;
        const dilation = 1 - Math.sqrt(Math.max(0.08, 1 + (2 * p0) / c2));
        const pt = toScreen(x0 + dx / 2, y0 + dy / 2, vp);
        ctx.fillStyle =
          dilation > 0.25 ? 'rgba(245,158,11,0.65)' : 'rgba(34,211,238,0.5)';
        ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3);
      }
    }
    return;
  }

  // Warped lattice: grid lines displaced along the local pull.
  const spacing = vp.scale < 0.35 ? 200 : vp.scale < 0.7 ? 100 : 50;
  const step = spacing * 0.8;
  ctx.lineWidth = 1;
  ctx.strokeStyle =
    mode === 'spacetime' ? 'rgba(56,189,248,0.2)' : 'rgba(56,189,248,0.09)';
  ctx.beginPath();
  const warped = (x: number, y: number, first: boolean) => {
    field.sample(x, y, 0, s);
    const g = Math.hypot(s.gx, s.gy);
    const raw = g * WARP;
    const k = raw > 1e-4 ? raw / (1 + raw / MAX_WARP) / g : 0;
    const p = toScreen(x - s.gx * k, y - s.gy * k, vp);
    if (first) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  };
  for (let x = Math.floor(left / spacing) * spacing; x <= right; x += spacing) {
    let first = true;
    for (let y = Math.floor(top / step) * step; y <= bottom + step; y += step) {
      warped(x, y, first);
      first = false;
    }
  }
  for (let y = Math.floor(top / spacing) * spacing; y <= bottom; y += spacing) {
    let first = true;
    for (let x = Math.floor(left / step) * step; x <= right + step; x += step) {
      warped(x, y, first);
      first = false;
    }
  }
  ctx.stroke();
}

function drawGlows(
  ctx: CanvasRenderingContext2D,
  bodies: readonly Body[],
  vp: Viewport,
): void {
  for (const b of bodies) {
    const p = toScreen(b.x, b.y, vp);
    const r = Math.max(60, Math.cbrt(b.mu) * 1.25) * vp.scale;
    if (p.x < -r || p.y < -r || p.x > vp.width + r || p.y > vp.height + r)
      continue;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    const inner =
      b.kind === 'hole'
        ? 'rgba(245,158,11,0.28)'
        : b.kind === 'compact'
          ? 'rgba(56,189,248,0.22)'
          : 'rgba(251,191,36,0.16)';
    grad.addColorStop(0, inner);
    grad.addColorStop(1, 'rgba(7,10,16,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
