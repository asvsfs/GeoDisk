import type { RefObject } from 'react';
import type {
  FlightPhase,
  MassBody,
  RocketState,
  TargetBeacon,
  TrajectoryPoint,
  WaypointBeacon,
} from '../physics/types';

export interface MinimapDestroyFlash {
  x: number;
  y: number;
  age: number;
  maxAge: number;
}

export interface MinimapRenderState {
  masses: readonly MassBody[];
  rocket: RocketState;
  rocketTrail: ReadonlyArray<{ x: number; y: number }>;
  predictedTrajectory: readonly TrajectoryPoint[];
  target: TargetBeacon;
  waypoints: readonly WaypointBeacon[];
  phase: FlightPhase;
  aimAngle: number;
  viewWidth: number;
  viewHeight: number;
  universeWidth: number;
  universeHeight: number;
  destroyFlashes: readonly MinimapDestroyFlash[];
}

export function renderUniverseMinimap(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  state: MinimapRenderState
): void {
  const scaleX = cssW / state.universeWidth;
  const scaleY = cssH / state.universeHeight;
  const scale = Math.min(scaleX, scaleY);
  const cx = cssW * 0.5;
  const cy = cssH * 0.5;

  const toMapX = (wx: number) => cx + wx * scale;
  const toMapY = (wy: number) => cy + wy * scale;

  ctx.fillStyle = '#05080E';
  ctx.fillRect(0, 0, cssW, cssH);

  // Subtle universe origin crosshairs
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, cssH);
  ctx.moveTo(0, cy);
  ctx.lineTo(cssW, cy);
  ctx.stroke();

  // Outer gravitational escape boundary
  ctx.save();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.34)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(1.5, 1.5, cssW - 3, cssH - 3);
  ctx.restore();

  // Main screen viewport rectangle inside the wider universe
  const vw = state.viewWidth * scale;
  const vh = state.viewHeight * scale;
  const vx = cx - vw * 0.5;
  const vy = cy - vh * 0.5;
  ctx.fillStyle = 'rgba(56, 189, 248, 0.04)';
  ctx.fillRect(vx, vy, vw, vh);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.42)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vx, vy, vw, vh);

  // Predicted trajectory across universe
  if (state.predictedTrajectory.length > 1) {
    ctx.save();
    ctx.strokeStyle =
      state.phase === 'aiming' ? 'rgba(34, 211, 238, 0.52)' : 'rgba(34, 211, 238, 0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    for (let i = 0; i < state.predictedTrajectory.length; i++) {
      const pt = state.predictedTrajectory[i];
      const px = toMapX(pt.x);
      const py = toMapY(pt.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Flown rocket trail
  if (state.rocketTrail.length > 1) {
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.78)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < state.rocketTrail.length; i++) {
      const pt = state.rocketTrail[i];
      const px = toMapX(pt.x);
      const py = toMapY(pt.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Waypoint nodes
  for (let i = 0; i < state.waypoints.length; i++) {
    const wp = state.waypoints[i];
    const px = toMapX(wp.x);
    const py = toMapY(wp.y);
    ctx.fillStyle = wp.collected ? 'rgba(16, 185, 129, 0.4)' : '#38BDF8';
    ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
  }

  // Target beacon
  {
    const tx = toMapX(state.target.x);
    const ty = toMapY(state.target.y);
    const tr = Math.max(3, state.target.radius * scale);
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(tx, ty, tr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Celestial masses (both onscreen and offscreen)
  for (let i = 0; i < state.masses.length; i++) {
    const m = state.masses[i];
    const mx = toMapX(m.x);
    const my = toMapY(m.y);
    const r = Math.max(1.8, m.radius * scale);

    // Velocity vector tail for moving stars
    const mvx = m.vx ?? 0;
    const mvy = m.vy ?? 0;
    const spd = Math.hypot(mvx, mvy);
    if (spd > 10) {
      const len = Math.min(8, 2 + spd * 0.02);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + (mvx / spd) * (r + len), my + (mvy / spd) * (r + len));
      ctx.stroke();
    }

    if (m.kind === 'singularity') {
      ctx.fillStyle = '#030508';
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (m.kind === 'star') {
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'compact') {
      ctx.fillStyle = '#38BDF8';
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#94A3B8';
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1.4, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Escape destruction flashes
  for (let i = 0; i < state.destroyFlashes.length; i++) {
    const f = state.destroyFlashes[i];
    const t = Math.min(1, f.age / Math.max(0.01, f.maxAge));
    const fx = Math.max(4, Math.min(cssW - 4, toMapX(f.x)));
    const fy = Math.max(4, Math.min(cssH - 4, toMapY(f.y)));
    const alpha = Math.max(0, 1 - t);
    ctx.strokeStyle = `rgba(251, 113, 133, ${alpha.toFixed(2)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(fx, fy, 3 + t * 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rocket marker
  if (state.phase !== 'crashed') {
    const rx = toMapX(state.rocket.x);
    const ry = toMapY(state.rocket.y);
    const isOffscreen =
      Math.abs(state.rocket.x) > state.viewWidth * 0.5 ||
      Math.abs(state.rocket.y) > state.viewHeight * 0.5;
    const ang = state.phase === 'aiming' ? state.aimAngle : state.rocket.angle;

    if (isOffscreen) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(rx, ry, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(ang);
    ctx.fillStyle = isOffscreen ? '#F59E0B' : '#F8FAFC';
    ctx.beginPath();
    ctx.moveTo(4.5, 0);
    ctx.lineTo(-2.8, -2.5);
    ctx.lineTo(-2.8, 2.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

interface UniverseMinimapProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rocketOffscreen: boolean;
  offscreenMassCount: number;
  escapedCount: number;
}

export function UniverseMinimap({
  canvasRef,
  rocketOffscreen,
  offscreenMassCount,
  escapedCount,
}: UniverseMinimapProps) {
  let statusText = 'In View';
  let statusTone = 'text-slate-400';

  if (rocketOffscreen) {
    statusText = 'Rocket Offscreen';
    statusTone = 'text-amber-300';
  } else if (offscreenMassCount > 0) {
    statusText = `${offscreenMassCount} Offscreen`;
    statusTone = 'text-cyan-300';
  }

  return (
    <section
      aria-label="Universe Minimap"
      className="pointer-events-auto bg-[#0B101B]/92 border border-slate-800 rounded-lg p-2 flex flex-col gap-1.5 self-start"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums px-0.5">
        <span className="uppercase tracking-wider text-slate-400">Universe</span>
        <div className="flex items-center gap-1.5">
          {escapedCount > 0 && (
            <span className="text-rose-400" title="Objects destroyed by escaping gravity field">
              {escapedCount} Escaped
            </span>
          )}
          {escapedCount > 0 && <span aria-hidden="true" className="text-slate-600">·</span>}
          <span className={statusTone}>{statusText}</span>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={216}
        height={135}
        data-testid="universe-minimap"
        aria-label="Universe tactical minimap showing viewport, stars, rocket, and gravitational boundary"
        className="w-[176px] h-[110px] sm:w-[216px] sm:h-[135px] block rounded bg-[#05080E] border border-slate-800/80"
      />
    </section>
  );
}
