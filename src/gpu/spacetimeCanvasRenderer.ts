import { UNIVERSE_CONFIG, type CpuGravityGridSolver } from '../physics/gravityField';
import type {
  FieldViewMode,
  FlightPhase,
  MassBody,
  RocketState,
  TargetBeacon,
  TrajectoryPoint,
  WaypointBeacon,
} from '../physics/types';

export const CAMERA_LIMITS = {
  minZoom: 0.26,
  maxZoom: 2.5,
  defaultZoom: 1,
} as const;

export interface CameraState {
  camX: number;
  camY: number;
  zoom: number;
}

export interface ViewportTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  cssWidth: number;
  cssHeight: number;
  camX: number;
  camY: number;
  zoom: number;
}

export function clampCamera(
  camX: number,
  camY: number,
  zoom: number,
  universeWidth = UNIVERSE_CONFIG.universeWidth,
  universeHeight = UNIVERSE_CONFIG.universeHeight
): CameraState {
  const clampedZoom = Math.max(CAMERA_LIMITS.minZoom, Math.min(CAMERA_LIMITS.maxZoom, zoom));
  const maxX = universeWidth * 0.5;
  const maxY = universeHeight * 0.5;
  return {
    camX: Math.max(-maxX, Math.min(maxX, camX)),
    camY: Math.max(-maxY, Math.min(maxY, camY)),
    zoom: clampedZoom,
  };
}

export function zoomCameraAroundPoint(
  current: CameraState,
  nextZoom: number,
  screenX: number,
  screenY: number,
  cssWidth: number,
  cssHeight: number,
  worldWidth: number,
  worldHeight: number
): CameraState {
  const clampedNext = Math.max(CAMERA_LIMITS.minZoom, Math.min(CAMERA_LIMITS.maxZoom, nextZoom));
  const baseScale = Math.min(cssWidth / worldWidth, cssHeight / worldHeight);
  if (baseScale <= 0) return clampCamera(current.camX, current.camY, clampedNext);

  const oldScale = baseScale * current.zoom;
  const newScale = baseScale * clampedNext;
  const worldX = current.camX + (screenX - cssWidth * 0.5) / oldScale;
  const worldY = current.camY + (screenY - cssHeight * 0.5) / oldScale;
  const nextCamX = worldX - (screenX - cssWidth * 0.5) / newScale;
  const nextCamY = worldY - (screenY - cssHeight * 0.5) / newScale;
  return clampCamera(nextCamX, nextCamY, clampedNext);
}

export function computeViewportTransform(
  cssWidth: number,
  cssHeight: number,
  worldWidth: number,
  worldHeight: number,
  camX = 0,
  camY = 0,
  zoom = 1
): ViewportTransform {
  const baseScale = Math.min(cssWidth / worldWidth, cssHeight / worldHeight);
  const scale = baseScale * zoom;
  return {
    scale,
    offsetX: cssWidth * 0.5 - camX * scale,
    offsetY: cssHeight * 0.5 - camY * scale,
    cssWidth,
    cssHeight,
    camX,
    camY,
    zoom,
  };
}

export function worldToScreen(
  wx: number,
  wy: number,
  vp: ViewportTransform
): { x: number; y: number } {
  return {
    x: vp.offsetX + wx * vp.scale,
    y: vp.offsetY + wy * vp.scale,
  };
}

export function screenToWorld(
  sx: number,
  sy: number,
  vp: ViewportTransform
): { x: number; y: number } {
  return {
    x: (sx - vp.offsetX) / vp.scale,
    y: (sy - vp.offsetY) / vp.scale,
  };
}

/**
 * Fixed-capacity zero-GC particle ring buffer for rocket exhaust & horizon burst effects.
 */
export class ParticlePool {
  private readonly capacity: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly kind: Uint8Array; // 0 = exhaust cyan, 1 = burst amber/white
  private cursor = 0;

  constructor(capacity = 280) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
  }

  public spawn(
    px: number,
    py: number,
    vx: number,
    vy: number,
    lifeSec: number,
    size: number,
    kind: number
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.x[i] = px;
    this.y[i] = py;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = lifeSec;
    this.maxLife[i] = lifeSec;
    this.size[i] = size;
    this.kind[i] = kind;
  }

  public clear(): void {
    this.life.fill(0);
  }

  public update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] > 0) {
        this.life[i] -= dt;
        this.x[i] += this.vx[i] * dt;
        this.y[i] += this.vy[i] * dt;
        this.vx[i] *= 0.98;
        this.vy[i] *= 0.98;
      }
    }
  }

  public render(ctx: CanvasRenderingContext2D, vp: ViewportTransform): void {
    for (let i = 0; i < this.capacity; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const alpha = Math.max(0, l / this.maxLife[i]);
      const sx = vp.offsetX + this.x[i] * vp.scale;
      const sy = vp.offsetY + this.y[i] * vp.scale;
      const r = Math.max(1.2, this.size[i] * vp.scale * (0.4 + 0.6 * alpha));

      ctx.fillStyle =
        this.kind[i] === 0
          ? `rgba(34, 211, 238, ${(alpha * 0.85).toFixed(3)})`
          : `rgba(245, 158, 11, ${(alpha * 0.95).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const STAR_SEEDS = Array.from({ length: 90 }, (_, i) => {
  const s1 = Math.sin(i * 12.9898 + 1.23) * 43758.5453;
  const s2 = Math.sin(i * 78.233 + 4.56) * 19341.231;
  const s3 = Math.sin(i * 39.425 + 7.89) * 91823.112;
  return {
    nx: s1 - Math.floor(s1),
    ny: s2 - Math.floor(s2),
    r: 0.7 + (s3 - Math.floor(s3)) * 1.4,
    alpha: 0.16 + ((i % 7) / 7) * 0.35,
  };
});

/**
 * CPU Canvas2D fallback renderer for the uniform gravity grid when WebGPU is unavailable
 * (e.g. headless Chromium without hardware GPU). Draws the exact same 2+1D warped spacetime
 * lattice, gravity field glow, and equipotential isolines directly from `CpuGravityGridSolver`.
 */
export function renderSpacetimeFieldFallback2D(
  ctx: CanvasRenderingContext2D,
  solver: CpuGravityGridSolver,
  masses: readonly MassBody[],
  viewMode: FieldViewMode,
  vp: ViewportTransform
): void {
  const { cssWidth, cssHeight } = vp;
  ctx.fillStyle = '#070A10';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Subtle 3D gravity potential glow projected onto the z=0 shadow plane
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i];
    const sp = worldToScreen(m.x, m.y, vp);
    const glowR = Math.max(60, Math.cbrt(m.mu) * 1.25) * vp.scale;
    const grad = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, glowR);
    if (m.kind === 'singularity') {
      grad.addColorStop(0, 'rgba(245, 158, 11, 0.28)');
      grad.addColorStop(0.45, 'rgba(217, 119, 6, 0.08)');
      grad.addColorStop(1, 'rgba(7, 10, 16, 0)');
    } else if (m.kind === 'compact') {
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.22)');
      grad.addColorStop(0.5, 'rgba(14, 165, 233, 0.06)');
      grad.addColorStop(1, 'rgba(7, 10, 16, 0)');
    } else {
      grad.addColorStop(0, 'rgba(251, 191, 36, 0.22)');
      grad.addColorStop(0.45, 'rgba(34, 211, 238, 0.07)');
      grad.addColorStop(1, 'rgba(7, 10, 16, 0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw warped 2+1D spacetime coordinate lattice across visible universe bounds
  const { speedOfLight } = solver.config;
  const univHalfW = UNIVERSE_CONFIG.universeWidth * 0.5;
  const univHalfH = UNIVERSE_CONFIG.universeHeight * 0.5;
  const c2 = speedOfLight * speedOfLight;

  const viewLeft = Math.max(-univHalfW, -vp.offsetX / vp.scale);
  const viewRight = Math.min(univHalfW, (cssWidth - vp.offsetX) / vp.scale);
  const viewTop = Math.max(-univHalfH, -vp.offsetY / vp.scale);
  const viewBottom = Math.min(univHalfH, (cssHeight - vp.offsetY) / vp.scale);

  if (viewMode === 'spacetime' || viewMode === 'vectors') {
    const spacing = vp.zoom < 0.55 ? 100 : 50;
    const step = vp.zoom < 0.55 ? 80 : 40;
    const warpFactor = 0.095;
    const startX = Math.floor(viewLeft / spacing) * spacing;
    const endX = Math.ceil(viewRight / spacing) * spacing;
    const startY = Math.floor(viewTop / spacing) * spacing;
    const endY = Math.ceil(viewBottom / spacing) * spacing;
    const lineStartY = Math.max(-univHalfH, Math.floor(viewTop / step) * step);
    const lineEndY = Math.min(univHalfH, Math.ceil(viewBottom / step) * step);
    const lineStartX = Math.max(-univHalfW, Math.floor(viewLeft / step) * step);
    const lineEndX = Math.min(univHalfW, Math.ceil(viewRight / step) * step);

    ctx.lineWidth = 1;
    ctx.strokeStyle =
      viewMode === 'spacetime'
        ? 'rgba(56, 189, 248, 0.20)'
        : 'rgba(56, 189, 248, 0.09)';

    ctx.beginPath();
    const maxWarp = 62;
    // Vertical warped lines batched into one path
    for (let wx = startX; wx <= endX; wx += spacing) {
      let first = true;
      for (let wy = lineStartY; wy <= lineEndY; wy += step) {
        const s = solver.sampleAt(wx, wy);
        const gMag = Math.hypot(s.gx, s.gy);
        const rawDisp = gMag * warpFactor;
        const scale = rawDisp > 1e-4 ? (rawDisp / (1 + rawDisp / maxWarp)) / gMag : 0;
        const dispX = wx - s.gx * scale;
        const dispY = wy - s.gy * scale;
        const pt = worldToScreen(dispX, dispY, vp);
        if (first) {
          ctx.moveTo(pt.x, pt.y);
          first = false;
        } else {
          ctx.lineTo(pt.x, pt.y);
        }
      }
    }

    // Horizontal warped lines batched into the same path
    for (let wy = startY; wy <= endY; wy += spacing) {
      let first = true;
      for (let wx = lineStartX; wx <= lineEndX; wx += step) {
        const s = solver.sampleAt(wx, wy);
        const gMag = Math.hypot(s.gx, s.gy);
        const rawDisp = gMag * warpFactor;
        const scale = rawDisp > 1e-4 ? (rawDisp / (1 + rawDisp / maxWarp)) / gMag : 0;
        const dispX = wx - s.gx * scale;
        const dispY = wy - s.gy * scale;
        const pt = worldToScreen(dispX, dispY, vp);
        if (first) {
          ctx.moveTo(pt.x, pt.y);
          first = false;
        } else {
          ctx.lineTo(pt.x, pt.y);
        }
      }
    }
    ctx.stroke();
  }

  // Equipotential contour bands sampled cleanly over visible universe bounds
  if (viewMode === 'contours') {
    const cols = 72;
    const rows = 45;
    const spanW = Math.max(100, viewRight - viewLeft);
    const spanH = Math.max(100, viewBottom - viewTop);
    const dx = spanW / cols;
    const dy = spanH / rows;
    const contourInterval = 22000;

    for (let r = 0; r < rows; r++) {
      const y0 = viewTop + r * dy;
      for (let c = 0; c < cols; c++) {
        const x0 = viewLeft + c * dx;
        const s0 = solver.sampleAt(x0, y0);
        const s1 = solver.sampleAt(x0 + dx, y0);
        const s2 = solver.sampleAt(x0, y0 + dy);

        const b0 = Math.floor(s0.phi / contourInterval);
        const b1 = Math.floor(s1.phi / contourInterval);
        const b2 = Math.floor(s2.phi / contourInterval);

        if (b0 !== b1 || b0 !== b2) {
          const dilation = Math.max(0, 1 - Math.sqrt(Math.max(0.08, 1 + (2 * s0.phi) / c2)));
          const pt = worldToScreen(x0 + dx * 0.5, y0 + dy * 0.5, vp);
          ctx.fillStyle =
            dilation > 0.25
              ? 'rgba(245, 158, 11, 0.65)'
              : 'rgba(34, 211, 238, 0.5)';
          ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3);
        }
      }
    }
  }
}

export interface OverlayRenderState {
  masses: readonly MassBody[];
  rocket: RocketState;
  rocketTrail: ReadonlyArray<{ x: number; y: number }>;
  predictedTrajectory: readonly TrajectoryPoint[];
  target: TargetBeacon;
  waypoints: readonly WaypointBeacon[];
  phase: FlightPhase;
  viewMode: FieldViewMode;
  aimAngle: number;
  launchSpeed: number;
  elapsedTime: number;
  isDraggingAim: boolean;
  selectedMassId: string | null;
  solver: CpuGravityGridSolver;
  particles: ParticlePool;
  transparentBg: boolean;
}

/**
 * Renders crisp vector instrumentation, mass bodies, vector field arrows, target/waypoints,
 * trajectory arc, and the rocket onto the foreground canvas.
 */
export function renderVectorOverlay(
  ctx: CanvasRenderingContext2D,
  state: OverlayRenderState,
  vp: ViewportTransform
): void {
  const { cssWidth, cssHeight } = vp;
  if (state.transparentBg) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
  }

  // Faint background starfield
  for (let i = 0; i < STAR_SEEDS.length; i++) {
    const st = STAR_SEEDS[i];
    ctx.fillStyle = `rgba(226, 232, 240, ${st.alpha})`;
    const sz = st.r * 1.4;
    ctx.fillRect(st.nx * cssWidth, st.ny * cssHeight, sz, sz);
  }

  // Core uniform grid boundary frame (1600 x 1000)
  const topLeft = worldToScreen(
    -state.solver.config.worldWidth * 0.5,
    -state.solver.config.worldHeight * 0.5,
    vp
  );
  const botRight = worldToScreen(
    state.solver.config.worldWidth * 0.5,
    state.solver.config.worldHeight * 0.5,
    vp
  );
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    topLeft.x,
    topLeft.y,
    botRight.x - topLeft.x,
    botRight.y - topLeft.y
  );

  // Outer universe gravitational escape boundary (4800 x 3000)
  {
    const univHalfW = UNIVERSE_CONFIG.universeWidth * 0.5;
    const univHalfH = UNIVERSE_CONFIG.universeHeight * 0.5;
    const uTL = worldToScreen(-univHalfW, -univHalfH, vp);
    const uBR = worldToScreen(univHalfW, univHalfH, vp);
    ctx.save();
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.36)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(uTL.x, uTL.y, uBR.x - uTL.x, uBR.y - uTL.y);
    ctx.restore();
  }

  // Vector field arrows when viewMode === 'vectors'
  if (state.viewMode === 'vectors') {
    const step = vp.zoom < 0.55 ? 160 : 80;
    const univHalfW = UNIVERSE_CONFIG.universeWidth * 0.5 - 40;
    const univHalfH = UNIVERSE_CONFIG.universeHeight * 0.5 - 40;
    const minWX = Math.max(-univHalfW, Math.floor((-vp.offsetX / vp.scale) / step) * step);
    const maxWX = Math.min(univHalfW, Math.ceil(((cssWidth - vp.offsetX) / vp.scale) / step) * step);
    const minWY = Math.max(-univHalfH, Math.floor((-vp.offsetY / vp.scale) / step) * step);
    const maxWY = Math.min(univHalfH, Math.ceil(((cssHeight - vp.offsetY) / vp.scale) / step) * step);
    ctx.lineWidth = 1.25;

    for (let wx = minWX; wx <= maxWX; wx += step) {
      for (let wy = minWY; wy <= maxWY; wy += step) {
        const s = state.solver.sampleAt(wx, wy);
        const mag = Math.hypot(s.gx, s.gy);
        if (mag < 2) continue;
        const len = Math.min(28, 6 + Math.sqrt(mag) * 0.72) * Math.max(0.45, vp.scale);
        const nx = s.gx / mag;
        const ny = s.gy / mag;
        const p0 = worldToScreen(wx, wy, vp);
        const p1x = p0.x + nx * len;
        const p1y = p0.y + ny * len;

        const heat = Math.min(1, mag / 550);
        ctx.strokeStyle =
          heat > 0.55
            ? `rgba(245, 158, 11, ${(0.35 + heat * 0.5).toFixed(2)})`
            : `rgba(34, 211, 238, ${(0.28 + heat * 0.55).toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1x, p1y);
        ctx.stroke();

        // Arrow head
        const ang = Math.atan2(ny, nx);
        const head = Math.max(3, 4.5 * Math.max(0.45, vp.scale));
        ctx.beginPath();
        ctx.moveTo(p1x, p1y);
        ctx.lineTo(p1x - Math.cos(ang - 0.5) * head, p1y - Math.sin(ang - 0.5) * head);
        ctx.moveTo(p1x, p1y);
        ctx.lineTo(p1x - Math.cos(ang + 0.5) * head, p1y - Math.sin(ang + 0.5) * head);
        ctx.stroke();
      }
    }
  }

  // Waypoint beacons
  for (let i = 0; i < state.waypoints.length; i++) {
    const wp = state.waypoints[i];
    const p = worldToScreen(wp.x, wp.y, vp);
    const r = wp.radius * vp.scale;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(state.elapsedTime * 0.8 + i);
    ctx.strokeStyle = wp.collected ? 'rgba(16, 185, 129, 0.35)' : 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.72);
    ctx.lineTo(r * 0.72, 0);
    ctx.lineTo(0, r * 0.72);
    ctx.lineTo(-r * 0.72, 0);
    ctx.closePath();
    ctx.stroke();
    if (wp.collected) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
      ctx.fill();
    }
    ctx.restore();
  }

  // Target Orbital Beacon
  {
    const tp = worldToScreen(state.target.x, state.target.y, vp);
    const tr = state.target.radius * vp.scale;
    const pulse = 1 + Math.sin(state.elapsedTime * 3.2) * 0.06;

    const grad = ctx.createRadialGradient(tp.x, tp.y, tr * 0.2, tp.x, tp.y, tr * 1.45);
    grad.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
    grad.addColorStop(0.7, 'rgba(16, 185, 129, 0.08)');
    grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, tr * 1.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, tr * pulse, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating capture reticle ticks
    ctx.save();
    ctx.translate(tp.x, tp.y);
    ctx.rotate(-state.elapsedTime * 0.55);
    ctx.strokeStyle = 'rgba(110, 231, 183, 0.8)';
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * tr * 0.65, Math.sin(a) * tr * 0.65);
      ctx.lineTo(Math.cos(a) * tr * 1.15, Math.sin(a) * tr * 1.15);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#A7F3D0';
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TARGET', tp.x, tp.y - tr - 8);
  }

  // Mass bodies (rendered as 2D orthographic shadow motion + oblique z-depth shadow cue)
  for (let i = 0; i < state.masses.length; i++) {
    const m = state.masses[i];
    const mz = m.z ?? 0;
    const mp = worldToScreen(m.x, m.y, vp);
    const depthScale = Math.max(0.72, Math.min(1.22, 1 + mz * 0.0007));
    const r = Math.max(4, m.radius * vp.scale * depthScale);
    const isSelected = state.selectedMassId === m.id;

    // 3D-to-2D cast shadow footprint when body has non-zero z elevation
    if (Math.abs(mz) > 3) {
      const sh = worldToScreen(m.x + mz * 0.22, m.y + mz * 0.22, vp);
      ctx.save();
      ctx.strokeStyle =
        mz > 0 ? 'rgba(34, 211, 238, 0.22)' : 'rgba(245, 158, 11, 0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mp.x, mp.y);
      ctx.lineTo(sh.x, sh.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(2, 6, 23, 0.58)';
      ctx.strokeStyle =
        mz > 0 ? 'rgba(56, 189, 248, 0.28)' : 'rgba(245, 158, 11, 0.28)';
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, Math.max(3, r * 0.88), Math.max(2.5, r * 0.68), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Subtle velocity vector tail for mutually moving stars (projected 2D motion)
    const mvx = m.vx ?? 0;
    const mvy = m.vy ?? 0;
    const mSpd = Math.hypot(mvx, mvy);
    if (mSpd > 8) {
      const tailLen = Math.min(42, 10 + mSpd * 0.14) * vp.scale;
      const ux = mvx / mSpd;
      const uy = mvy / mSpd;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(mp.x, mp.y);
      ctx.lineTo(mp.x + ux * (r + tailLen), mp.y + uy * (r + tailLen));
      ctx.stroke();
    }

    // Spin frame-dragging swirl rings
    if (Math.abs(m.spin) > 500) {
      const dir = Math.sign(m.spin);
      ctx.save();
      ctx.translate(mp.x, mp.y);
      ctx.rotate(state.elapsedTime * dir * 1.4);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)';
      ctx.lineWidth = 1.25;
      for (let arc = 0; arc < 3; arc++) {
        const start = (arc * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.55, start, start + 1.1);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (m.kind === 'singularity') {
      // Photon ring + event horizon core
      const photonGrad = ctx.createRadialGradient(mp.x, mp.y, r * 0.85, mp.x, mp.y, r * 1.65);
      photonGrad.addColorStop(0, 'rgba(245, 158, 11, 0.95)');
      photonGrad.addColorStop(0.35, 'rgba(245, 158, 11, 0.28)');
      photonGrad.addColorStop(1, 'rgba(245, 158, 11, 0)');
      ctx.fillStyle = photonGrad;
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r * 1.65, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#030508';
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.kind === 'star') {
      const starGrad = ctx.createRadialGradient(mp.x, mp.y, 0, mp.x, mp.y, r * 1.35);
      starGrad.addColorStop(0, '#FEF3C7');
      starGrad.addColorStop(0.55, '#F59E0B');
      starGrad.addColorStop(0.85, 'rgba(217, 119, 6, 0.45)');
      starGrad.addColorStop(1, 'rgba(217, 119, 6, 0)');
      ctx.fillStyle = starGrad;
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r * 1.35, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.kind === 'compact') {
      const cGrad = ctx.createRadialGradient(mp.x, mp.y, 0, mp.x, mp.y, r * 1.3);
      cGrad.addColorStop(0, '#E0F2FE');
      cGrad.addColorStop(0.6, '#38BDF8');
      cGrad.addColorStop(1, 'rgba(14, 165, 233, 0)');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r * 1.3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Asteroid / cluster body
      ctx.fillStyle = '#475569';
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (isSelected) {
      ctx.strokeStyle = '#22D3EE';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(mp.x, mp.y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Predicted geodesic trajectory (shown during aiming or faintly during flight)
  if (state.predictedTrajectory.length > 1) {
    ctx.save();
    ctx.lineWidth = state.phase === 'aiming' ? 2.0 : 1.2;
    ctx.setLineDash(state.phase === 'aiming' ? [6, 5] : [3, 6]);
    for (let i = 1; i < state.predictedTrajectory.length; i++) {
      const a = state.predictedTrajectory[i - 1];
      const b = state.predictedTrajectory[i];
      const pa = worldToScreen(a.x, a.y, vp);
      const pb = worldToScreen(b.x, b.y, vp);
      const fade = 1 - i / state.predictedTrajectory.length;
      const dilationTint = b.lapse < 0.78 ? '245, 158, 11' : '34, 211, 238';
      const baseAlpha = state.phase === 'aiming' ? 0.85 : 0.25;
      ctx.strokeStyle = `rgba(${dilationTint}, ${(fade * baseAlpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Live flown rocket trail
  if (state.rocketTrail.length > 1) {
    ctx.lineWidth = 2;
    for (let i = 1; i < state.rocketTrail.length; i++) {
      const a = state.rocketTrail[i - 1];
      const b = state.rocketTrail[i];
      const pa = worldToScreen(a.x, a.y, vp);
      const pb = worldToScreen(b.x, b.y, vp);
      const fade = i / state.rocketTrail.length;
      ctx.strokeStyle = `rgba(34, 211, 238, ${(fade * 0.75).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  // Pooled exhaust & impact particles
  state.particles.render(ctx, vp);

  // Aim vector handle during aiming phase
  const rp = worldToScreen(state.rocket.x, state.rocket.y, vp);
  if (state.phase === 'aiming') {
    const vecLen = Math.max(36, (state.launchSpeed / 5.5) * vp.scale);
    const tipX = rp.x + Math.cos(state.aimAngle) * vecLen;
    const tipY = rp.y + Math.sin(state.aimAngle) * vecLen;

    ctx.strokeStyle = state.isDraggingAim ? '#F59E0B' : '#22D3EE';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rp.x, rp.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    ctx.fillStyle = state.isDraggingAim ? '#F59E0B' : '#22D3EE';
    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rocket hull (with subtle 2D shadow drop when deflected in 3D z)
  if (state.phase !== 'crashed') {
    if (Math.abs(state.rocket.z) > 2) {
      const rSh = worldToScreen(
        state.rocket.x + state.rocket.z * 0.22,
        state.rocket.y + state.rocket.z * 0.22,
        vp
      );
      ctx.save();
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(rp.x, rp.y);
      ctx.lineTo(rSh.x, rSh.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.6)';
      ctx.beginPath();
      ctx.arc(rSh.x, rSh.y, Math.max(3, 6 * vp.scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(rp.x, rp.y);
    ctx.rotate(state.rocket.angle);
    const s = Math.max(0.55, vp.scale);

    // Thruster flame cone when thrusting
    if (state.rocket.thrusting) {
      const flameLen = (14 + Math.sin(state.elapsedTime * 45) * 4) * s;
      ctx.fillStyle = 'rgba(34, 211, 238, 0.9)';
      ctx.beginPath();
      ctx.moveTo(-9 * s, -3.5 * s);
      ctx.lineTo(-9 * s - flameLen, 0);
      ctx.lineTo(-9 * s, 3.5 * s);
      ctx.closePath();
      ctx.fill();
    }

    // Rocket metallic delta silhouette
    ctx.fillStyle = '#F8FAFC';
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(13 * s, 0);
    ctx.lineTo(-8 * s, -6.5 * s);
    ctx.lineTo(-5 * s, 0);
    ctx.lineTo(-8 * s, 6.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Canopy accent
    ctx.fillStyle = '#22D3EE';
    ctx.beginPath();
    ctx.moveTo(5 * s, 0);
    ctx.lineTo(-1 * s, -2.5 * s);
    ctx.lineTo(-1 * s, 2.5 * s);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}
