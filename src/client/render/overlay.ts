/**
 * @fileoverview Foreground vector layer: bodies, satellites, trails, homes,
 * the aiming line and spawn previews.
 */

import {PLAYER_COLORS} from '../../shared/config';
import type {PlayerInfo} from '../../shared/net/protocol';
import {newSample, type FieldSolver} from '../../shared/sim/gravity';
import type {PathPoint} from '../../shared/sim/predict';
import type {BodyClass, ClassId} from '../../shared/sim/classes';
import type {Body, Sat} from '../../shared/types';
import {toScreen, type ViewMode, type Viewport} from './camera';

/** Everything the overlay needs for one frame. */
export interface OverlayState {
  bodies: readonly Body[];
  sats: readonly Sat[];
  trails: ReadonlyMap<number, ReadonlyArray<{x: number; y: number}>>;
  players: readonly PlayerInfo[];
  you: number;
  mode: ViewMode;
  field: FieldSolver;
  time: number;
  universe: {width: number; height: number};
  aim: {angle: number; speed: number; path: readonly PathPoint[]} | null;
  spawn: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    label: string;
  } | null;
  hoverBody: number;
  /** Class of a body (memoised by the caller per frame). */
  classOf: (b: Body) => BodyClass;
}

const STARS = Array.from({length: 120}, (_, i) => {
  const f = (k: number) => {
    const v = Math.sin(i * k) * 43758.5453;
    return v - Math.floor(v);
  };
  return {
    x: f(12.9898),
    y: f(78.233),
    r: 0.6 + f(39.425) * 1.4,
    a: 0.12 + (i % 7) * 0.05,
  };
});

/** Draws the overlay; clears the canvas first. */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  s: OverlayState,
  vp: Viewport,
): void {
  ctx.clearRect(0, 0, vp.width, vp.height);
  for (const st of STARS) {
    ctx.fillStyle = `rgba(226,232,240,${st.a})`;
    ctx.fillRect(st.x * vp.width, st.y * vp.height, st.r, st.r);
  }
  drawBounds(ctx, s, vp);
  if (s.mode === 'vectors') drawVectors(ctx, s.field, vp);
  drawHomes(ctx, s, vp);
  for (const b of s.bodies) drawBody(ctx, b, s, vp);
  drawSats(ctx, s, vp);
  if (s.aim) drawAim(ctx, s, vp);
  if (s.spawn) drawSpawn(ctx, s.spawn, vp);
}

function colorOf(players: readonly PlayerInfo[], id: number): string {
  const p = players.find(q => q.id === id);
  return p ? PLAYER_COLORS[p.color % PLAYER_COLORS.length] : '#94A3B8';
}

function drawBounds(
  ctx: CanvasRenderingContext2D,
  s: OverlayState,
  vp: Viewport,
): void {
  const hw = s.universe.width / 2;
  const hh = s.universe.height / 2;
  const a = toScreen(-hw, -hh, vp);
  const b = toScreen(hw, hh, vp);
  ctx.save();
  ctx.strokeStyle = 'rgba(245,158,11,0.36)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

function drawVectors(
  ctx: CanvasRenderingContext2D,
  field: FieldSolver,
  vp: Viewport,
): void {
  const step = vp.scale < 0.4 ? 200 : 100;
  const left = Math.floor(-vp.offsetX / vp.scale / step) * step;
  const top = Math.floor(-vp.offsetY / vp.scale / step) * step;
  const right = (vp.width - vp.offsetX) / vp.scale;
  const bottom = (vp.height - vp.offsetY) / vp.scale;
  const f = newSample();
  ctx.lineWidth = 1.25;
  for (let x = left; x <= right; x += step) {
    for (let y = top; y <= bottom; y += step) {
      field.sample(x, y, 0, f);
      const mag = Math.hypot(f.gx, f.gy);
      if (mag < 2) continue;
      const len = Math.min(28, 6 + Math.sqrt(mag) * 0.72);
      const nx = f.gx / mag;
      const ny = f.gy / mag;
      const p = toScreen(x, y, vp);
      const heat = Math.min(1, mag / 550);
      ctx.strokeStyle =
        heat > 0.55
          ? `rgba(245,158,11,${0.35 + heat * 0.5})`
          : `rgba(34,211,238,${0.28 + heat * 0.55})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + nx * len, p.y + ny * len);
      ctx.stroke();
    }
  }
}

function drawHomes(
  ctx: CanvasRenderingContext2D,
  s: OverlayState,
  vp: Viewport,
): void {
  const byHome = new Map<number, PlayerInfo[]>();
  for (const p of s.players) {
    if (!p.home) continue;
    const list = byHome.get(p.home) ?? [];
    list.push(p);
    byHome.set(p.home, list);
  }
  ctx.font = '600 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  for (const b of s.bodies) {
    const residents = byHome.get(b.id);
    if (!residents) continue;
    const p = toScreen(b.x, b.y, vp);
    const r = Math.max(6, b.radius * vp.scale) + 8;
    residents.forEach((pl, i) => {
      ctx.strokeStyle = PLAYER_COLORS[pl.color % PLAYER_COLORS.length];
      ctx.lineWidth = pl.id === s.you ? 2 : 1.2;
      ctx.setLineDash(pl.id === s.you ? [] : [3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + i * 4, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    ctx.fillText(
      residents.map(q => q.name).join(' · '),
      p.x,
      p.y - r - residents.length * 4 - 6,
    );
  }
}

/** Body colours by class: [core, rim]. */
const CLASS_TINT: Record<ClassId, [string, string]> = {
  asteroid: ['#94A3B8', '#475569'],
  'rocky-planet': ['#93C5FD', '#1E3A8A'],
  'gas-giant': ['#FDBA74', '#9A3412'],
  'brown-dwarf': ['#C2410C', '#431407'],
  'red-dwarf': ['#FECACA', '#DC2626'],
  'yellow-dwarf': ['#FEF3C7', '#F59E0B'],
  'blue-giant': ['#F0F9FF', '#3B82F6'],
  supergiant: ['#FFEDD5', '#EA580C'],
  'white-dwarf': ['#FFFFFF', '#CBD5E1'],
  'neutron-star': ['#E0F2FE', '#38BDF8'],
  pulsar: ['#ECFEFF', '#22D3EE'],
  'stellar-black-hole': ['#F59E0B', '#030508'],
  'intermediate-black-hole': ['#F59E0B', '#030508'],
  'supermassive-black-hole': ['#F59E0B', '#030508'],
};

function drawBody(
  ctx: CanvasRenderingContext2D,
  b: Body,
  s: OverlayState,
  vp: Viewport,
): void {
  const p = toScreen(b.x, b.y, vp);
  const minR = b.kind === 'rock' ? 1.5 : b.kind === 'planet' ? 3 : 2.5;
  const r = Math.max(minR, b.radius * vp.scale);
  const pad = Math.max(r * 4, 60);
  if (
    p.x < -pad ||
    p.y < -pad ||
    p.x > vp.width + pad ||
    p.y > vp.height + pad
  ) {
    return;
  }
  const cls = s.classOf(b);
  const [core, rim] = CLASS_TINT[cls.id];

  switch (b.kind) {
    case 'hole': {
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.85, p.x, p.y, r * 1.8);
      g.addColorStop(0, 'rgba(245,158,11,0.95)');
      g.addColorStop(0.35, 'rgba(245,158,11,0.28)');
      g.addColorStop(1, 'rgba(245,158,11,0)');
      disc(ctx, p.x, p.y, r * 1.8, g);
      disc(ctx, p.x, p.y, Math.max(2, r), '#030508');
      if (cls.spinFrac > 0.05)
        swirl(ctx, p.x, p.y, r * 1.6, s.time, b.spin, cls.spinFrac);
      break;
    }
    case 'star': {
      // Stars near the end of their fuel pulse faster.
      const urgency = Number.isFinite(b.life)
        ? Math.max(0, 1 - b.life / 20)
        : 0;
      const pulse =
        1 + Math.sin(s.time * (3 + urgency * 14)) * (0.04 + urgency * 0.12);
      const glow =
        cls.id === 'supergiant' || cls.id === 'blue-giant' ? 1.8 : 1.4;
      const g = ctx.createRadialGradient(
        p.x,
        p.y,
        0,
        p.x,
        p.y,
        r * glow * pulse,
      );
      g.addColorStop(0, core);
      g.addColorStop(0.55, rim);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      disc(ctx, p.x, p.y, r * glow * pulse, g);
      break;
    }
    case 'white':
    case 'compact': {
      const g = ctx.createRadialGradient(
        p.x,
        p.y,
        0,
        p.x,
        p.y,
        Math.max(6, r * 3),
      );
      g.addColorStop(0, core);
      g.addColorStop(0.3, rim);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      disc(ctx, p.x, p.y, Math.max(6, r * 3), g);
      if (cls.id === 'pulsar')
        beams(ctx, p.x, p.y, Math.max(40, r * 14), s.time, b, cls.spinFrac);
      break;
    }
    case 'planet': {
      const g = ctx.createRadialGradient(
        p.x - r * 0.3,
        p.y - r * 0.3,
        r * 0.1,
        p.x,
        p.y,
        r,
      );
      g.addColorStop(0, core);
      g.addColorStop(1, rim);
      disc(ctx, p.x, p.y, r, g);
      if (cls.id === 'gas-giant' && r > 6) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.strokeStyle = 'rgba(67,20,7,0.35)';
        ctx.lineWidth = Math.max(1, r * 0.12);
        for (let k = -2; k <= 2; k++) {
          ctx.beginPath();
          ctx.moveTo(p.x - r, p.y + k * r * 0.35);
          ctx.lineTo(p.x + r, p.y + k * r * 0.35);
          ctx.stroke();
        }
        ctx.restore();
      }
      break;
    }
    default:
      disc(ctx, p.x, p.y, r, core);
      break;
  }
  if (b.id === s.hoverBody) drawLabel(ctx, b, cls, p.x, p.y, r);
}

/** Rotating frame-dragging arcs around a spinning black hole. */
function swirl(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  time: number,
  spin: number,
  frac: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(time * Math.sign(spin) * (0.5 + frac * 2));
  ctx.strokeStyle = `rgba(34,211,238,${0.2 + frac * 0.35})`;
  ctx.lineWidth = 1.25;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(0, 0, r, (k * Math.PI * 2) / 3, (k * Math.PI * 2) / 3 + 1.1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Two sweeping radio beams; faster spin sweeps faster. */
function beams(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  len: number,
  time: number,
  b: Body,
  frac: number,
): void {
  const a = time * Math.sign(b.spin || 1) * (1 + frac * 10) + b.id;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const side of [0, Math.PI]) {
    const g = ctx.createLinearGradient(
      x,
      y,
      x + Math.cos(a + side) * len,
      y + Math.sin(a + side) * len,
    );
    g.addColorStop(0, 'rgba(165,243,252,0.7)');
    g.addColorStop(1, 'rgba(165,243,252,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(
      x + Math.cos(a + side - 0.08) * len,
      y + Math.sin(a + side - 0.08) * len,
    );
    ctx.lineTo(
      x + Math.cos(a + side + 0.08) * len,
      y + Math.sin(a + side + 0.08) * len,
    );
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Class, mass, radius and qualifiers next to the hovered body. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  b: Body,
  cls: BodyClass,
  x: number,
  y: number,
  r: number,
): void {
  ctx.strokeStyle = '#22D3EE';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const lines = [
    cls.label,
    `μ ${formatMass(b.mu)} · r ${b.radius.toFixed(1)}`,
    ...cls.tags,
  ];
  if (b.kind === 'star' && Number.isFinite(b.life))
    lines.push(`fuel ${Math.round(b.life)} s`);
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12;
  const lx = x + r + 12;
  const ly = y - 8 - lines.length * 7;
  ctx.fillStyle = 'rgba(2,6,23,0.85)';
  ctx.fillRect(lx, ly, w, lines.length * 15 + 6);
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? '#F8FAFC' : '#94A3B8';
    ctx.fillText(l, lx + 6, ly + 15 + i * 15);
  });
}

/** Compact mass display, e.g. 4.5M or 120k. */
export function formatMass(mu: number): string {
  if (mu >= 1e6) return `${(mu / 1e6).toFixed(mu >= 1e7 ? 0 : 1)}M`;
  if (mu >= 1e3) return `${(mu / 1e3).toFixed(0)}k`;
  return mu.toFixed(0);
}

function disc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string | CanvasGradient,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawSats(
  ctx: CanvasRenderingContext2D,
  s: OverlayState,
  vp: Viewport,
): void {
  const colors = new Map<number, string>();
  const color = (owner: number) => {
    let c = colors.get(owner);
    if (!c) colors.set(owner, (c = colorOf(s.players, owner)));
    return c;
  };
  ctx.lineWidth = 1.2;
  for (const sat of s.sats) {
    const trail = s.trails.get(sat.id);
    if (trail && trail.length > 1) {
      ctx.strokeStyle = color(sat.owner);
      ctx.globalAlpha = sat.owner === s.you ? 0.55 : 0.3;
      ctx.beginPath();
      const p0 = toScreen(trail[0].x, trail[0].y, vp);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < trail.length; i++) {
        const p = toScreen(trail[i].x, trail[i].y, vp);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  for (const sat of s.sats) {
    const p = toScreen(sat.x, sat.y, vp);
    const a = Math.atan2(sat.vy, sat.vx);
    const k = sat.owner === s.you ? 1.25 : 1;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    ctx.fillStyle = color(sat.owner);
    ctx.beginPath();
    ctx.moveTo(6 * k, 0);
    ctx.lineTo(-4 * k, -3.5 * k);
    ctx.lineTo(-2 * k, 0);
    ctx.lineTo(-4 * k, 3.5 * k);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawAim(
  ctx: CanvasRenderingContext2D,
  s: OverlayState,
  vp: Viewport,
): void {
  const aim = s.aim!;
  const path = aim.path;
  if (path.length > 1) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    for (let i = 1; i < path.length; i++) {
      const a = toScreen(path[i - 1].x, path[i - 1].y, vp);
      const b = toScreen(path[i].x, path[i].y, vp);
      const fade = 1 - i / path.length;
      const tint = path[i].lapse < 0.78 ? '245,158,11' : '34,211,238';
      ctx.strokeStyle = `rgba(${tint},${fade * 0.85})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
  const me = s.players.find(p => p.id === s.you);
  const home = me ? s.bodies.find(b => b.id === me.home) : undefined;
  if (!home) return;
  const p = toScreen(home.x, home.y, vp);
  const len = 30 + aim.speed / 8;
  ctx.strokeStyle = '#22D3EE';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + Math.cos(aim.angle) * len, p.y + Math.sin(aim.angle) * len);
  ctx.stroke();
}

function drawSpawn(
  ctx: CanvasRenderingContext2D,
  sp: NonNullable<OverlayState['spawn']>,
  vp: Viewport,
): void {
  const p = toScreen(sp.x, sp.y, vp);
  ctx.save();
  ctx.strokeStyle = '#22D3EE';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(5, sp.radius * vp.scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + sp.vx * vp.scale * 0.5, p.y + sp.vy * vp.scale * 0.5);
  ctx.stroke();
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#E2E8F0';
  ctx.fillText(sp.label, p.x, p.y - Math.max(5, sp.radius * vp.scale) - 8);
  ctx.restore();
}
