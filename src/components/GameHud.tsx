import type { RefObject } from 'react';
import type {
  FieldViewMode,
  FlightPhase,
  MissionConfig,
} from '../physics/types';
import { UniverseMinimap } from './UniverseMinimap';

export interface HudTelemetry {
  speed: number;
  speedPctC: number;
  fuel: number;
  maxFuel: number;
  coordTime: number;
  properTime: number;
  lapse: number;
  waypointsCollected: number;
  waypointsTotal: number;
  massCount: number;
  rocketOffscreen: boolean;
  offscreenMassCount: number;
  escapedCount: number;
}

interface GameHudProps {
  missions: readonly MissionConfig[];
  missionIndex: number;
  onSelectMission: (idx: number) => void;
  phase: FlightPhase;
  viewMode: FieldViewMode;
  onChangeViewMode: (mode: FieldViewMode) => void;
  physicsModelId: string;
  onChangePhysicsModel: (id: string) => void;
  nBodyEnabled: boolean;
  onToggleNBody: () => void;
  aimAngleDeg: number;
  onChangeAimAngleDeg: (deg: number) => void;
  launchSpeed: number;
  maxLaunchSpeed: number;
  onChangeLaunchSpeed: (spd: number) => void;
  onLaunch: () => void;
  onReset: () => void;
  onPause: () => void;
  muted: boolean;
  onToggleMute: () => void;
  gpuActive: boolean | null;
  telemetry: HudTelemetry;
  isSandbox: boolean;
  onAddSandboxMass: (kind: 'star' | 'singularity' | 'cluster16') => void;
  onClearSandboxMasses: () => void;
  minimapCanvasRef: RefObject<HTMLCanvasElement | null>;
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

export function GameHud({
  missions,
  missionIndex,
  onSelectMission,
  phase,
  viewMode,
  onChangeViewMode,
  physicsModelId,
  onChangePhysicsModel,
  nBodyEnabled,
  onToggleNBody,
  aimAngleDeg,
  onChangeAimAngleDeg,
  launchSpeed,
  maxLaunchSpeed,
  onChangeLaunchSpeed,
  onLaunch,
  onReset,
  onPause,
  muted,
  onToggleMute,
  gpuActive,
  telemetry,
  isSandbox,
  onAddSandboxMass,
  onClearSandboxMasses,
  minimapCanvasRef,
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
}: GameHudProps) {
  const fuelPct =
    telemetry.maxFuel > 0
      ? Math.max(0, Math.min(100, Math.round((telemetry.fuel / telemetry.maxFuel) * 100)))
      : 0;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between p-4">
      {/* Top Perimeter Clusters */}
      <div className="flex items-start justify-between gap-4">
        {/* Top-Left Cluster: Mission Selector + Grid Readout */}
        <div className="pointer-events-auto bg-[#0B101B]/92 border border-slate-800 rounded-lg px-3.5 py-2.5 flex flex-col gap-1.5 max-w-xs sm:max-w-sm">
          <div className="flex items-center gap-2.5">
            <select
              aria-label="Select Mission"
              value={missionIndex}
              onChange={(e) => {
                onSelectMission(Number(e.target.value));
                e.currentTarget.blur();
              }}
              className="bg-[#070A10] border border-slate-700 text-slate-100 text-xs font-medium rounded px-2.5 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              {missions.map((m, idx) => (
                <option key={m.id} value={idx}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 tabular-nums">
            <span>{gpuActive ? 'WebGPU Compute' : 'CPU Grid'}</span>
            <span aria-hidden="true">·</span>
            <span>{telemetry.massCount} Masses</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                phase === 'flying'
                  ? 'text-cyan-300'
                  : phase === 'victory'
                    ? 'text-emerald-400'
                    : 'text-slate-300'
              }
            >
              {phase === 'aiming' ? 'Aiming' : phase === 'flying' ? 'In Flight' : phase === 'victory' ? 'Captured' : 'Lost'}
            </span>
          </div>
        </div>

        {/* Top-Right Cluster: Field Mode, N-Body Toggle, Replaceable Rocket Physics, Utility Buttons */}
        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
          {/* Field Visualization Mode */}
          <div
            className="bg-[#0B101B]/92 border border-slate-800 rounded-lg p-1 flex items-center gap-0.5"
            role="group"
            aria-label="Gravity field visualization"
          >
            {(['spacetime', 'contours', 'vectors'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onChangeViewMode(mode);
                  e.currentTarget.blur();
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === mode
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode === 'spacetime' ? 'Lattice' : mode === 'contours' ? 'Contours' : 'Vectors'}
              </button>
            ))}
          </div>

          {/* Mutual Star-to-Star N-Body Gravity Toggle */}
          <div className="bg-[#0B101B]/92 border border-slate-800 rounded-lg p-1 flex items-center">
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={nBodyEnabled}
              onClick={(e) => {
                onToggleNBody();
                e.currentTarget.blur();
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                nBodyEnabled
                  ? 'bg-slate-800 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Toggle mutual N-body gravity between stars"
            >
              {nBodyEnabled ? 'N-Body: On' : 'N-Body: Off'}
            </button>
          </div>

          {/* Replaceable Rocket Physics Module Selector */}
          <div
            className="bg-[#0B101B]/92 border border-slate-800 rounded-lg p-1 flex items-center gap-0.5"
            role="group"
            aria-label="Rocket physics module"
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                onChangePhysicsModel('gr-3d');
                e.currentTarget.blur();
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                physicsModelId === 'gr-3d' || physicsModelId === 'gr-2plus1d'
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="3D 1PN General Relativity Geodesic Module (2D Shadow Render)"
            >
              GR 3D
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                onChangePhysicsModel('newtonian');
                e.currentTarget.blur();
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                physicsModelId === 'newtonian'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Classical Newtonian Rocket Module"
            >
              Newtonian
            </button>
          </div>

          {/* Square Utility Buttons */}
          <div className="bg-[#0B101B]/92 border border-slate-800 rounded-lg p-1 flex items-center gap-1">
            <button
              type="button"
              tabIndex={-1}
              aria-label={muted ? 'Unmute audio (M)' : 'Mute audio (M)'}
              title="Toggle Mute (M)"
              onClick={(e) => {
                onToggleMute();
                e.currentTarget.blur();
              }}
              className="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                {muted ? (
                  <path d="M23 9l-6 6M17 9l6 6" />
                ) : (
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
                )}
              </svg>
            </button>

            <button
              type="button"
              tabIndex={-1}
              aria-label="Reset mission (R)"
              title="Reset (R)"
              onClick={(e) => {
                onReset();
                e.currentTarget.blur();
              }}
              className="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>

            <button
              type="button"
              tabIndex={-1}
              aria-label="Pause game (P)"
              title="Pause (P)"
              onClick={(e) => {
                onPause();
                e.currentTarget.blur();
              }}
              className="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Perimeter Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-end justify-between gap-3">
        {/* Bottom-Left Stack: Universe Minimap + Optional Sandbox Palette */}
        <div className="flex flex-col items-start gap-2">
          <UniverseMinimap
            canvasRef={minimapCanvasRef}
            rocketOffscreen={telemetry.rocketOffscreen}
            offscreenMassCount={telemetry.offscreenMassCount}
            escapedCount={telemetry.escapedCount}
            universeWidth={universeWidth}
            universeHeight={universeHeight}
            zoom={zoom}
            cameraTool={cameraTool}
            followRocket={followRocket}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onResetCamera={onResetCamera}
            onToggleCameraTool={onToggleCameraTool}
            onToggleFollowRocket={onToggleFollowRocket}
            onPanToWorld={onPanToWorld}
          />

          {isSandbox && (
            <div className="pointer-events-auto bg-[#0B101B]/92 border border-slate-800 rounded-lg px-3 py-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-mono text-slate-400 mr-1">Sandbox:</span>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onAddSandboxMass('star');
                  e.currentTarget.blur();
                }}
                className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 rounded cursor-pointer whitespace-nowrap"
              >
                + Star
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onAddSandboxMass('singularity');
                  e.currentTarget.blur();
                }}
                className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded cursor-pointer whitespace-nowrap"
              >
                + Singularity
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onAddSandboxMass('cluster16');
                  e.currentTarget.blur();
                }}
                className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded cursor-pointer whitespace-nowrap"
              >
                +16 Cluster
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onClearSandboxMasses();
                  e.currentTarget.blur();
                }}
                className="px-2.5 py-1 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-rose-300 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Telemetry & Launch Control Bar */}
        <div className="pointer-events-auto bg-[#0B101B]/92 border border-slate-800 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-5">
          {/* Live Telemetry Figures */}
          <div className="flex items-center gap-5">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Fuel
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="w-20 h-2 bg-slate-800 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 transition-transform duration-100 origin-left"
                    style={{ transform: `scaleX(${fuelPct / 100})` }}
                  />
                </div>
                <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                  {fuelPct}%
                </span>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Velocity
              </div>
              <div className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                {Math.round(telemetry.speed)}{' '}
                <span className="text-[11px] font-normal text-slate-400">
                  ({Math.round(telemetry.speedPctC)}% c)
                </span>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Time Lapse <span className="normal-case">α</span>
              </div>
              <div
                className={`font-mono text-sm font-semibold tabular-nums ${
                  telemetry.lapse < 0.78 ? 'text-amber-400' : 'text-slate-100'
                }`}
              >
                {telemetry.lapse.toFixed(2)}×
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Clock <span className="normal-case">τ / t</span>
              </div>
              <div className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                {telemetry.properTime.toFixed(1)}s{' '}
                <span className="text-[11px] font-normal text-slate-400">
                  / {telemetry.coordTime.toFixed(1)}s
                </span>
              </div>
            </div>

            {telemetry.waypointsTotal > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                  Nodes
                </div>
                <div className="font-mono text-sm font-semibold text-emerald-400 tabular-nums">
                  {telemetry.waypointsCollected}/{telemetry.waypointsTotal}
                </div>
              </div>
            )}
          </div>

          {/* Aiming Sliders + Launch CTA (Aiming) OR Flight Controls */}
          {phase === 'aiming' ? (
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs font-mono text-slate-300">
                <span>Angle</span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={Math.round(aimAngleDeg)}
                  onChange={(e) => onChangeAimAngleDeg(Number(e.target.value))}
                  className="telemetry-slider w-20"
                  aria-label="Launch angle in degrees"
                />
                <span className="w-10 text-right tabular-nums">
                  {Math.round(aimAngleDeg)}°
                </span>
              </label>

              <label className="flex items-center gap-2 text-xs font-mono text-slate-300">
                <span>Impulse</span>
                <input
                  type="range"
                  min={120}
                  max={maxLaunchSpeed}
                  value={Math.round(launchSpeed)}
                  onChange={(e) => onChangeLaunchSpeed(Number(e.target.value))}
                  className="telemetry-slider w-20"
                  aria-label="Launch impulse speed"
                />
                <span className="w-9 text-right tabular-nums">
                  {Math.round(launchSpeed)}
                </span>
              </label>

              <button
                type="button"
                onClick={(e) => {
                  onLaunch();
                  e.currentTarget.blur();
                }}
                className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Launch Rocket
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono text-slate-400 hidden sm:inline">
                W/Space Thrust · A/D Steer · S Retro
              </span>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  onReset();
                  e.currentTarget.blur();
                }}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium rounded-md border border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Reset Launch
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
