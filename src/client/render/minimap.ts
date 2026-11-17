/**
 * @fileoverview Whole-universe minimap.
 */

import {PLAYER_COLORS} from '../../shared/config';
import type {PlayerInfo} from '../../shared/net/protocol';
import type {Body, Sat} from '../../shared/types';
import type {Viewport} from './camera';

const KIND_COLOR: Record<Body['kind'], string> = {
  star: '#FBBF24',
  planet: '#60A5FA',
  rock: '#64748B',
  compact: '#7DD3FC',
  hole: '#F59E0B',
  white: '#F8FAFC',
};

/** Draws the minimap into a `w` x `h` CSS-pixel context. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  universe: {width: number; height: number},
  bodies: readonly Body[],
  sats: readonly Sat[],
  players: readonly PlayerInfo[],
  vp: Viewport,
): void {
  const k = Math.min(w / universe.width, h / universe.height);
  const ox = w / 2;
  const oy = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(2,6,23,0.75)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(245,158,11,0.35)';
  ctx.strokeRect(
    ox - (universe.width * k) / 2,
    oy - (universe.height * k) / 2,
    universe.width * k,
    universe.height * k,
  );

  const colors = new Map(
    players.map(p => [p.id, PLAYER_COLORS[p.color % PLAYER_COLORS.length]]),
  );
  for (const s of sats) {
    ctx.fillStyle = colors.get(s.owner) ?? '#94A3B8';
    ctx.fillRect(ox + s.x * k - 0.75, oy + s.y * k - 0.75, 1.5, 1.5);
  }
  for (const b of bodies) {
    const r = Math.max(1.2, b.radius * k * 2.5);
    ctx.fillStyle = KIND_COLOR[b.kind];
    ctx.beginPath();
    ctx.arc(ox + b.x * k, oy + b.y * k, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const vw = (vp.width / vp.scale) * k;
  const vh = (vp.height / vp.scale) * k;
  ctx.strokeStyle = 'rgba(34,211,238,0.8)';
  ctx.strokeRect(
    ox + vp.cam.x * k - vw / 2,
    oy + vp.cam.y * k - vh / 2,
    vw,
    vh,
  );
}

/** Converts a minimap click to world coordinates. */
export function minimapToWorld(
  sx: number,
  sy: number,
  w: number,
  h: number,
  universe: {width: number; height: number},
): {x: number; y: number} {
  const k = Math.min(w / universe.width, h / universe.height);
  return {x: (sx - w / 2) / k, y: (sy - h / 2) / k};
}
