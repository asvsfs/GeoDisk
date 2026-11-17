import { useRef, type PointerEvent, type RefObject } from 'react';
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
  camX: number;
  camY: number;
  camViewWidth: number;
  camViewHeight: number;
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

  // Core uniform grid frame (1600 x 1000)
  {
    const gw = state.viewWidth * scale;
    const gh = state.viewHeight * scale;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - gw * 0.5, cy - gh * 0.5, gw, gh);
  }

  // Live Camera Viewport Rectangle (tracks pan & zoom across the universe)
  {
    const cw = state.camViewWidth * scale;
    const ch = state.camViewHeight * scale;
    const camLeft = toMapX(state.camX) - cw * 0.5;
    const camTop = toMapY(state.camY) - ch * 0.5;
    ctx.fillStyle = 'rgba(34, 211, 238, 0.06)';
    ctx.fillRect(camLeft, camTop, cw, ch);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.strokeRect(camLeft, camTop, cw, ch);
  }

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
      Math.abs(state.rocket.x - state.camX) > state.camViewWidth * 0.5 ||
      Math.abs(state.rocket.y - state.camY) > state.camViewHeight * 0.5;
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
  universeWidth: number;
  universeHeight: number;
  zoom: number;
  cameraTool: 'aim' | 'pan';
  followRocket: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetCamera: () => void;
  onToggleCameraTool: () => void;
  onToggleFollowRocket: () => void;
  onPanToWorld: (wx: number, wy: number) => void;
}

export function UniverseMinimap({
  canvasRef,
  rocketOffscreen,
  offscreenMassCount,
  escapedCount,
  universeWidth,
  universeHeight,
  zoom,
  cameraTool,
  followRocket,
  onZoomIn,
  onZoomOut,
  onResetCamera,
  onToggleCameraTool,
  onToggleFollowRocket,
  onPanToWorld,
}: UniverseMinimapProps) {
  const draggingRef = useRef(false);

  let statusText = 'In View';
  let statusTone = 'text-slate-400';

  if (rocketOffscreen) {
    statusText = 'Rocket Offscreen';
    statusTone = 'text-amber-300';
  } else if (offscreenMassCount > 0) {
    statusText = `${offscreenMassCount} Offscreen`;
    statusTone = 'text-cyan-300';
  }

  const panFromPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    onPanToWorld(nx * universeWidth, ny * universeHeight);
  };

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
        width={232}
        height={145}
        data-testid="universe-minimap"
        aria-label="Universe tactical minimap showing viewport, stars, rocket, and gravitational boundary. Click or drag to move camera."
        onPointerDown={(e) => {
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          panFromPointer(e);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) {
            panFromPointer(e);
          }
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        className="w-[184px] h-[115px] sm:w-[232px] sm:h-[145px] block rounded bg-[#05080E] border border-slate-800/80 cursor-crosshair touch-none"
      />

      {/* Camera Zoom & Map Navigation Controls */}
      <div
        role="group"
        aria-label="Map camera controls"
        className="flex items-center justify-between gap-1 pt-0.5"
      >
        <div className="flex items-center gap-0.5 bg-[#070A10] border border-slate-800 rounded p-0.5">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Zoom out"
            title="Zoom Out (-)"
            onClick={(e) => {
              onZoomOut();
              e.currentTarget.blur();
            }}
            className="w-6 h-6 flex items-center justify-center rounded text-xs font-mono text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
          >
            -
          </button>
          <span
            aria-label="Camera zoom level"
            className="px-1 text-[10px] font-mono text-slate-300 tabular-nums w-9 text-center"
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Zoom in"
            title="Zoom In (+)"
            onClick={(e) => {
              onZoomIn();
              e.currentTarget.blur();
            }}
            className="w-6 h-6 flex items-center justify-center rounded text-xs font-mono text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
          >
            +
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            tabIndex={-1}
            aria-pressed={cameraTool === 'pan'}
            title="Toggle Pan Map tool (V) · Or right-drag / Shift+drag anywhere"
            onClick={(e) => {
              onToggleCameraTool();
              e.currentTarget.blur();
            }}
            className={`px-2 h-7 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              cameraTool === 'pan'
                ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                : 'bg-[#070A10] border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800'
            }`}
          >
            Pan
          </button>

          <button
            type="button"
            tabIndex={-1}
            aria-pressed={followRocket}
            title="Follow rocket (C)"
            onClick={(e) => {
              onToggleFollowRocket();
              e.currentTarget.blur();
            }}
            className={`px-2 h-7 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              followRocket
                ? 'bg-slate-800 border-emerald-500/60 text-emerald-300'
                : 'bg-[#070A10] border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800'
            }`}
          >
            Follow
          </button>

          <button
            type="button"
            tabIndex={-1}
            aria-label="Reset camera view"
            title="Reset View (0)"
            onClick={(e) => {
              onResetCamera();
              e.currentTarget.blur();
            }}
            className="px-2 h-7 text-[11px] font-medium rounded border bg-[#070A10] border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  );
}
