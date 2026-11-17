/**
 * @fileoverview In-game heads-up display (presentational only).
 */

import type {PointerEvent, RefObject} from 'react';
import {PLAYER_COLORS} from '../../shared/config';
import type {SpawnRange} from '../../shared/game/rules';
import type {PlayerInfo} from '../../shared/net/protocol';
import type {SpawnKind} from '../../shared/types';
import type {ViewMode} from '../render/camera';
import {formatMass} from '../render/overlay';

/** Active pointer tool. */
export type Tool = 'launch' | 'body';

/** The body a player is about to place. */
export interface BodySpec {
  kind: SpawnKind;
  mu: number;
  radius: number;
  /** Signed fraction of the spin limit, -1..1. */
  spin: number;
}

/** Spawnable kinds in menu order with their hotkeys. */
export const BODY_MENU: ReadonlyArray<{
  kind: SpawnKind;
  label: string;
  key: string;
}> = [
  {kind: 'rock', label: 'Asteroid', key: '2'},
  {kind: 'planet', label: 'Planet', key: '3'},
  {kind: 'star', label: 'Star', key: '4'},
  {kind: 'white', label: 'White dwarf', key: '5'},
  {kind: 'compact', label: 'Neutron star', key: '6'},
  {kind: 'hole', label: 'Black hole', key: '7'},
];

/** Live counters shown in the HUD. */
export interface HudStats {
  bodies: number;
  bodyCap: number;
  sats: number;
  satCap: number;
  mine: number;
  mineCap: number;
  rtt: number;
  offline: boolean;
  homeless: boolean;
  satsBy: ReadonlyMap<number, number>;
}

/** A transient message. */
export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'boom';
}

/** HUD props. */
export interface HudProps {
  stats: HudStats;
  players: readonly PlayerInfo[];
  you: number;
  tool: Tool;
  onTool(tool: Tool): void;
  speed: number;
  minSpeed: number;
  maxSpeed: number;
  onSpeed(speed: number): void;
  angleDeg: number;
  onLaunch(): void;
  mode: ViewMode;
  onMode(mode: ViewMode): void;
  muted: boolean;
  onMute(): void;
  follow: boolean;
  onFollow(): void;
  onLeave(): void;
  toasts: readonly Toast[];
  minimapRef: RefObject<HTMLCanvasElement | null>;
  onMinimap(e: PointerEvent<HTMLCanvasElement>): void;
  body: BodySpec;
  bodyRange: SpawnRange;
  /** Class the body would have, e.g. "Blue giant". */
  bodyClass: string;
  onBody(spec: BodySpec): void;
}

const TOOLS: ReadonlyArray<{
  id: Tool;
  label: string;
  key: string;
  hint: string;
}> = [
  {
    id: 'launch',
    label: 'Satellite',
    key: '1',
    hint: 'Drag to aim, release to launch',
  },
  {
    id: 'body',
    label: 'Place body',
    key: '2-7',
    hint: 'Click to place, drag to fling',
  },
];

const MODES: readonly ViewMode[] = ['spacetime', 'contours', 'vectors'];

const panel =
  'rounded-xl border border-slate-800/80 bg-slate-950/80 backdrop-blur-md';

function Meter({
  label,
  value,
  cap,
}: {
  label: string;
  value: number;
  cap: number;
}) {
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  return (
    <div className="min-w-[96px]">
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-wider text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums text-slate-200">
          {value}/{cap}
        </span>
      </div>
      <div className="mt-1 h-1 rounded bg-slate-800">
        <div
          className={`h-1 rounded ${pct > 90 ? 'bg-rose-400' : pct > 70 ? 'bg-amber-400' : 'bg-cyan-400'}`}
          style={{width: `${pct}%`}}
        />
      </div>
    </div>
  );
}

/** Heads-up display. */
export function Hud(p: HudProps) {
  const tool = TOOLS.find(t => t.id === p.tool)!;
  return (
    <div className="pointer-events-none absolute inset-0 select-none text-slate-100">
      {/* Top-left: status and limits. */}
      <div
        className={`${panel} pointer-events-auto absolute left-4 top-4 flex flex-wrap items-center gap-4 px-4 py-3`}
      >
        <div>
          <div className="font-display text-lg font-bold leading-none">
            GeoDisk
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-400">
            {p.stats.offline
              ? 'offline'
              : `WebTransport · ${Math.round(p.stats.rtt)} ms`}
          </div>
        </div>
        <Meter label="Bodies" value={p.stats.bodies} cap={p.stats.bodyCap} />
        <Meter label="Satellites" value={p.stats.sats} cap={p.stats.satCap} />
        <Meter label="Yours" value={p.stats.mine} cap={p.stats.mineCap} />
      </div>

      {/* Top-right: players. */}
      <div
        className={`${panel} pointer-events-auto absolute right-4 top-4 w-52 px-3 py-2`}
      >
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <span>Pilots · {p.players.length}</span>
          <button
            className="text-slate-400 hover:text-rose-300"
            onClick={p.onLeave}
          >
            Leave
          </button>
        </div>
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {p.players.map(pl => (
            <li key={pl.id} className="flex items-center gap-2 text-sm">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{
                  background: PLAYER_COLORS[pl.color % PLAYER_COLORS.length],
                }}
              />
              <span
                className={`flex-1 truncate ${pl.id === p.you ? 'font-semibold' : ''}`}
              >
                {pl.name}
                {pl.id === p.you ? ' (you)' : ''}
              </span>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {p.stats.satsBy.get(pl.id) ?? 0}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Toasts. */}
      <div className="absolute left-1/2 top-4 flex -translate-x-1/2 flex-col items-center gap-2">
        {p.toasts.map(t => (
          <div
            key={t.id}
            className={`${panel} px-3 py-1.5 font-mono text-xs ${
              t.tone === 'boom'
                ? 'text-amber-300'
                : t.tone === 'warn'
                  ? 'text-rose-300'
                  : 'text-slate-200'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>

      {/* Bottom: tools and launch controls. */}
      <div
        className={`${panel} pointer-events-auto absolute bottom-4 left-4 flex max-w-[calc(100vw-32px)] flex-wrap items-center gap-3 px-3 py-2.5 sm:max-w-[calc(100vw-260px)]`}
      >
        <div className="flex gap-1">
          {TOOLS.map(t => (
            <button
              key={t.id}
              title={`${t.hint} (${t.key})`}
              onClick={() => p.onTool(t.id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                p.tool === t.id
                  ? 'bg-cyan-400 text-slate-950'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <span className="mr-1 font-mono text-[10px] opacity-60">
                {t.key}
              </span>
              {t.label}
            </button>
          ))}
        </div>
        {p.tool === 'launch' && (
          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] uppercase text-slate-400">
              Speed
              <input
                type="range"
                className="telemetry-slider ml-2 w-28 align-middle"
                min={p.minSpeed}
                max={p.maxSpeed}
                value={p.speed}
                onChange={e => p.onSpeed(Number(e.target.value))}
              />
            </label>
            <span className="w-24 font-mono text-xs tabular-nums text-slate-300">
              {Math.round(p.speed)} u/s · {Math.round(p.angleDeg)}°
            </span>
            <button
              onClick={p.onLaunch}
              disabled={p.stats.homeless}
              className="rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-40"
            >
              Launch
            </button>
          </div>
        )}
        <div className="flex gap-1">
          {MODES.map(m => (
            <button
              key={m}
              onClick={() => p.onMode(m)}
              className={`rounded px-2 py-1 font-mono text-[10px] uppercase ${
                p.mode === m
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={p.onFollow}
          className={`font-mono text-[10px] uppercase ${p.follow ? 'text-cyan-300' : 'text-slate-400'}`}
        >
          Follow (F)
        </button>
        <button
          onClick={p.onMute}
          className="font-mono text-[10px] uppercase text-slate-400"
        >
          {p.muted ? 'Unmute' : 'Mute'} (M)
        </button>
        <span className="hidden font-mono text-[10px] text-slate-500 lg:inline">
          {p.stats.homeless ? 'No home planet: place a planet (3)' : tool.hint}{' '}
          · right-drag pan · wheel zoom · double-click a planet to move home
        </span>
      </div>

      {p.tool === 'body' && <BodyPanel {...p} />}

      {/* Minimap. */}
      <canvas
        ref={p.minimapRef}
        onPointerDown={p.onMinimap}
        className="pointer-events-auto absolute bottom-4 right-4 hidden h-[140px] w-[210px] cursor-pointer rounded-xl border border-slate-800 sm:block"
      />
    </div>
  );
}

/** Log-scale slider position (0..1000) for a mass in [min, max]. */
function toLog(v: number, min: number, max: number): number {
  return (Math.log(v / min) / Math.log(max / min)) * 1000;
}

function fromLog(t: number, min: number, max: number): number {
  return min * Math.pow(max / min, t / 1000);
}

/** Kind, mass, radius and spin of the body to place. */
function BodyPanel(p: HudProps) {
  const {body, bodyRange: range} = p;
  const fixedSize = range.rMin === range.rMax;
  const set = (patch: Partial<BodySpec>) => p.onBody({...body, ...patch});
  return (
    <div
      className={`${panel} pointer-events-auto absolute bottom-20 left-4 w-[min(360px,calc(100vw-32px))] space-y-2 px-3 py-3`}
    >
      <div className="flex flex-wrap gap-1">
        {BODY_MENU.map(m => (
          <button
            key={m.kind}
            onClick={() => set({kind: m.kind})}
            className={`rounded px-2 py-1 text-[11px] font-semibold ${
              body.kind === m.kind
                ? 'bg-cyan-400 text-slate-950'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span className="mr-1 font-mono text-[9px] opacity-60">
              {m.key}
            </span>
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex items-baseline justify-between">
        <span className="font-display text-sm font-semibold text-slate-100">
          {p.bodyClass}
        </span>
        <span className="font-mono text-[10px] text-slate-500">
          drag on the map to fling
        </span>
      </div>
      <label className="flex items-center gap-2 font-mono text-[10px] uppercase text-slate-400">
        <span className="w-12">Mass</span>
        <input
          type="range"
          className="telemetry-slider flex-1"
          min={0}
          max={1000}
          value={toLog(body.mu, range.muMin, range.muMax)}
          onChange={e =>
            set({mu: fromLog(Number(e.target.value), range.muMin, range.muMax)})
          }
        />
        <span className="w-14 text-right tabular-nums text-slate-200">
          {formatMass(body.mu)}
        </span>
      </label>
      <label
        className={`flex items-center gap-2 font-mono text-[10px] uppercase ${fixedSize ? 'text-slate-600' : 'text-slate-400'}`}
        title={fixedSize ? 'Set by physics for collapsed objects' : undefined}
      >
        <span className="w-12">Radius</span>
        <input
          type="range"
          className="telemetry-slider flex-1"
          min={range.rMin}
          max={fixedSize ? range.rMin + 1 : range.rMax}
          step={0.5}
          disabled={fixedSize}
          value={body.radius}
          onChange={e => set({radius: Number(e.target.value)})}
        />
        <span className="w-14 text-right tabular-nums text-slate-200">
          {body.radius.toFixed(1)}
        </span>
      </label>
      <label className="flex items-center gap-2 font-mono text-[10px] uppercase text-slate-400">
        <span className="w-12">Spin</span>
        <input
          type="range"
          className="telemetry-slider flex-1"
          min={-100}
          max={100}
          value={Math.round(body.spin * 100)}
          onChange={e => set({spin: Number(e.target.value) / 100})}
        />
        <span className="w-14 text-right tabular-nums text-slate-200">
          {Math.round(body.spin * 100)}%
        </span>
      </label>
    </div>
  );
}
