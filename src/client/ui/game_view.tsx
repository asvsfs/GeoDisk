/**
 * @fileoverview The playing screen: render loop, input and HUD wiring.
 *
 * Mutable per-frame state lives in a ref (`st`) so the loop never re-renders
 * React; the HUD receives throttled snapshots of it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {RENDER_GRID, type GameConfig} from '../../shared/config';
import type {PlayerInfo} from '../../shared/net/protocol';
import {AutoSolver} from '../../shared/sim/gravity';
import {spawnRange} from '../../shared/game/rules';
import {maxSpin, radiusFor} from '../../shared/sim/bodies';
import {classify, type BodyClass} from '../../shared/sim/classes';
import {
  EventKind,
  type Body,
  type SpawnKind,
  type WorldEvent,
} from '../../shared/types';
import {sfx} from '../audio';
import type {GameClient, View} from '../net/game_client';
import {Predictor} from '../sim/predictor';
import {
  ZOOM,
  clampCamera,
  toWorld,
  viewport,
  zoomAt,
  type Camera,
  type ViewMode,
  type Viewport,
} from '../render/camera';
import {Effects} from '../render/effects';
import {drawField2d} from '../render/field_2d';
import {drawMinimap, minimapToWorld} from '../render/minimap';
import {drawOverlay} from '../render/overlay';
import {WebGpuField} from '../render/webgpu_field';
import {
  BODY_MENU,
  Hud,
  type BodySpec,
  type HudStats,
  type Toast,
  type Tool,
} from './hud';

/** Game view props. */
export interface GameViewProps {
  client: GameClient;
  offline: boolean;
  onLeave(reason?: string): void;
}

type Drag =
  | {kind: 'aim'}
  | {kind: 'spawn'; x: number; y: number; vx: number; vy: number}
  | {kind: 'pan'; sx: number; sy: number};

const TRAIL_POINTS = 70;
const TRAIL_GAP = 10;
const PREDICT_MS = 140;
const HUD_MS = 250;
const MODES: readonly ViewMode[] = ['spacetime', 'contours', 'vectors'];
/** Launch speed per world unit of drag distance. */
const DRAG_SPEED = 1.6;
/** Spawn velocity per world unit of drag distance. */
const FLING = 1.2;

/** Playing screen. */
export function GameView({client, offline, onLeave}: GameViewProps) {
  const cfg = client.config;
  const lim = cfg.limits;
  const universe = {width: cfg.world.width, height: cfg.world.height};

  const boxRef = useRef<HTMLDivElement | null>(null);
  const gpuRef = useRef<HTMLCanvasElement | null>(null);
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const fgRef = useRef<HTMLCanvasElement | null>(null);
  const miniRef = useRef<HTMLCanvasElement | null>(null);

  const [tool, setTool] = useState<Tool>('launch');
  const [body, setBody] = useState<BodySpec>(() => defaultSpec('planet', cfg));
  const [speed, setSpeed] = useState(260);
  const [angleDeg, setAngleDeg] = useState(-90);
  const [mode, setMode] = useState<ViewMode>('spacetime');
  const [muted, setMuted] = useState(sfx.isMuted());
  const [follow, setFollow] = useState(true);
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [players, setPlayers] = useState<readonly PlayerInfo[]>(client.players);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [stats, setStats] = useState<HudStats>({
    bodies: 0,
    bodyCap: lim.maxBodies,
    sats: 0,
    satCap: lim.maxSats,
    mine: 0,
    mineCap: lim.maxSatsPerPlayer,
    rtt: 0,
    offline,
    homeless: false,
    satsBy: new Map(),
  });

  const st = useRef({
    cam: {x: 0, y: 0, zoom: ZOOM.initial} as Camera,
    width: 1280,
    height: 720,
    tool: 'launch' as Tool,
    body: defaultSpec('planet', cfg),
    angle: -Math.PI / 2,
    speed: 260,
    mode: 'spacetime' as ViewMode,
    follow: true,
    drag: null as Drag | null,
    hover: 0,
    pathAt: 0,
    trails: new Map<number, Array<{x: number; y: number}>>(),
    keys: new Set<string>(),
    view: null as View | null,
    vp: null as Viewport | null,
    field: new AutoSolver(
      cfg.world.c,
      cfg.physics.theta,
      cfg.physics.treeThreshold,
    ),
    effects: new Effects(),
    toastId: 0,
  }).current;

  // Per-frame memo of body classes for the overlay.
  const classCache = useRef(new Map<Body, BodyClass>()).current;
  const classOf = useCallback(
    (b: Body): BodyClass => {
      let c = classCache.get(b);
      if (!c) classCache.set(b, (c = classify(b, cfg.physics, cfg.world.c)));
      return c;
    },
    [cfg, classCache],
  );
  const specClass = useCallback(
    (spec: BodySpec): BodyClass =>
      classify(
        {
          ...spec,
          vx: 0,
          vy: 0,
          vz: 0,
          fixed: false,
          spin: spec.spin * maxSpin(spec, cfg.world.c),
        },
        cfg.physics,
        cfg.world.c,
      ),
    [cfg],
  );

  const toast = useCallback(
    (text: string, tone: Toast['tone'] = 'info') => {
      const id = ++st.toastId;
      setToasts(t => [...t.slice(-3), {id, text, tone}]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
    },
    [st],
  );

  const home = useCallback((): Body | undefined => {
    const me = client.me();
    // Read the client directly: the render loop pauses in background tabs.
    const view = st.view ?? client.view();
    return me && view ? view.bodies.find(b => b.id === me.home) : undefined;
  }, [client, st]);

  const launch = useCallback(() => {
    if (!home()) {
      toast('No home planet. Spawn a planet or double-click one.', 'warn');
      return;
    }
    client.launch(st.angle, st.speed);
  }, [client, home, st, toast]);

  const chooseTool = useCallback(
    (t: Tool) => {
      st.tool = t;
      st.drag = null;
      setTool(t);
    },
    [st],
  );

  /** Updates the body to place; switching kind resets to its defaults. */
  const changeBody = useCallback(
    (next: BodySpec) => {
      let spec = next;
      if (next.kind !== st.body.kind)
        spec = {...defaultSpec(next.kind, cfg), spin: next.spin};
      const range = spawnRange(spec.kind, cfg.physics);
      spec = {
        ...spec,
        mu: Math.min(range.muMax, Math.max(range.muMin, spec.mu)),
        radius:
          range.rMin === range.rMax
            ? range.rMin
            : Math.min(range.rMax, Math.max(range.rMin, spec.radius)),
      };
      st.body = spec;
      setBody(spec);
    },
    [cfg, st],
  );

  const chooseMode = useCallback(
    (m: ViewMode) => {
      st.mode = m;
      setMode(m);
    },
    [st],
  );

  const toggleFollow = useCallback(() => {
    st.follow = !st.follow;
    setFollow(st.follow);
  }, [st]);

  const toggleMute = useCallback(() => {
    sfx.setMuted(!sfx.isMuted());
    setMuted(sfx.isMuted());
  }, []);

  const changeSpeed = useCallback(
    (v: number) => {
      st.speed = v;
      st.pathAt = 0;
      setSpeed(v);
    },
    [st],
  );

  // Server traffic.
  useEffect(() => {
    const onEvents = (events: readonly WorldEvent[]) => {
      st.effects.apply(events);
      const vp = st.vp;
      let merged = false;
      for (const e of events) {
        const near = vp
          ? 1 -
            Math.min(
              1,
              Math.hypot(e.x - vp.cam.x, e.y - vp.cam.y) /
                (vp.width / vp.scale),
            )
          : 0;
        switch (e.kind) {
          case EventKind.NOVA:
            sfx.nova(near);
            toast('Supernova!', 'boom');
            break;
          case EventKind.SHATTER:
            if (near > 0) sfx.shatter();
            toast('Planetary collision', 'boom');
            break;
          case EventKind.MERGE:
            merged ||= near > 0;
            break;
          case EventKind.IGNITE:
            toast('A new star ignites', 'info');
            break;
          case EventKind.COLLAPSE:
            toast('Collapse: a new black hole or neutron star', 'info');
            break;
          case EventKind.NEBULA:
            toast('Planetary nebula: a white dwarf is born', 'info');
            break;
          case EventKind.TYPE_IA:
            sfx.nova(near);
            toast('Type Ia supernova: a white dwarf blew apart', 'boom');
            break;
          case EventKind.KILONOVA:
            sfx.nova(near * 0.6);
            toast('Kilonova: neutron stars merged', 'boom');
            break;
          case EventKind.FISSION:
            if (near > 0) sfx.shatter();
            toast('A body spun itself apart', 'info');
            break;
          case EventKind.LAUNCH:
            if (e.ref === client.you) sfx.launch();
            break;
          case EventKind.CRASH:
            if (e.ref === client.you) sfx.crash();
            break;
          default:
            break;
        }
      }
      if (merged) sfx.merge();
    };
    client.listen({
      onPlayers: p => setPlayers(p),
      onEvents,
      onReject: r => toast(r.text, 'warn'),
      onClose: reason =>
        onLeave(reason === 'left' ? undefined : `Disconnected: ${reason}`),
    });
    return () => client.listen({});
  }, [client, onLeave, st, toast]);

  // Render loop.
  useEffect(() => {
    const box = boxRef.current;
    const gpuCanvas = gpuRef.current;
    const bg = bgRef.current?.getContext('2d');
    const fg = fgRef.current?.getContext('2d');
    if (!box || !gpuCanvas || !bg || !fg) return;
    let gpuField: WebGpuField | null = null;
    const predictor = new Predictor(cfg);
    let disposed = false;
    let raf = 0;
    let last = performance.now();
    let hudAt = 0;
    let miniAt = 0;
    let bgAt = 0;
    let dpr = 1;

    const resize = () => {
      const r = box.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      st.width = r.width;
      st.height = r.height;
      for (const c of [gpuCanvas, bgRef.current!, fgRef.current!]) {
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
      }
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgAt = 0;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);

    WebGpuField.create(gpuCanvas, RENDER_GRID).then(f => {
      if (disposed) {
        f?.dispose();
        return;
      }
      gpuField = f;
      setGpu(Boolean(f));
    });

    const frame = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const view = client.view();
      st.view = view;
      if (!view) return;
      st.field.build(view.bodies);
      classCache.clear();
      updateTrails(st.trails, view);
      steer(dt);

      const me = client.me();
      const homeBody = me ? view.bodies.find(b => b.id === me.home) : undefined;
      if (st.follow && homeBody && st.drag?.kind !== 'pan') {
        const k = 1 - Math.exp(-6 * dt);
        st.cam = {
          ...st.cam,
          x: st.cam.x + (homeBody.x - st.cam.x) * k,
          y: st.cam.y + (homeBody.y - st.cam.y) * k,
        };
      }
      st.cam = clampCamera(st.cam, universe.width / 2, universe.height / 2);

      const snap = client.latest();
      if (
        st.tool === 'launch' &&
        homeBody &&
        snap &&
        now - st.pathAt > PREDICT_MS
      ) {
        st.pathAt = now;
        // Start from the newest snapshot advanced to when the server will
        // apply a launch sent now, not from the delayed interpolated view.
        const lead = Math.min(1, Math.max(0, client.requestTime() - snap.time));
        predictor.request(
          snap.bodies,
          {home: homeBody.id, angle: st.angle, pitch: 0, speed: st.speed},
          5,
          lead,
        );
      } else if (st.tool !== 'launch' || !homeBody) {
        predictor.clear();
      }

      st.effects.update(dt);
      const shake = st.effects.trauma ** 2 * 12;
      const base = viewport(st.cam, st.width, st.height);
      st.vp = base;
      const vp: Viewport = {
        ...base,
        offsetX: base.offsetX + (Math.random() - 0.5) * shake,
        offsetY: base.offsetY + (Math.random() - 0.5) * shake,
      };

      if (gpuField) {
        gpuField.renderFrame(
          view.bodies,
          cfg.world.c,
          st.mode,
          view.time,
          true,
          st.cam.x,
          st.cam.y,
          vp.width / vp.scale,
          vp.height / vp.scale,
          st.cam.zoom,
        );
      } else if (now - bgAt > 33) {
        bgAt = now;
        drawField2d(bg, st.field, view.bodies, st.mode, cfg.world.c, vp);
      }

      drawOverlay(
        fg,
        {
          bodies: view.bodies,
          sats: view.sats,
          trails: st.trails,
          players: client.players,
          you: client.you,
          mode: st.mode,
          field: st.field,
          time: now / 1000,
          universe,
          aim:
            st.tool === 'launch' && homeBody
              ? {angle: st.angle, speed: st.speed, path: predictor.path}
              : null,
          spawn:
            st.drag?.kind === 'spawn'
              ? {
                  ...st.drag,
                  radius: st.body.radius,
                  label: specClass(st.body).label,
                }
              : null,
          hoverBody: st.hover,
          classOf,
        },
        vp,
      );
      st.effects.render(fg, vp);

      const mini = miniRef.current;
      if (mini && now - miniAt > 100) {
        miniAt = now;
        const r = mini.getBoundingClientRect();
        if (r.width > 0) {
          if (mini.width !== Math.round(r.width * dpr)) {
            mini.width = Math.round(r.width * dpr);
            mini.height = Math.round(r.height * dpr);
          }
          const mctx = mini.getContext('2d')!;
          mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawMinimap(
            mctx,
            r.width,
            r.height,
            universe,
            view.bodies,
            view.sats,
            client.players,
            base,
          );
        }
      }

      if (now - hudAt > HUD_MS) {
        hudAt = now;
        const snap = client.latest();
        const satsBy = new Map<number, number>();
        for (const s of view.sats)
          satsBy.set(s.owner, (satsBy.get(s.owner) ?? 0) + 1);
        setStats({
          bodies: view.bodies.length,
          bodyCap: snap?.bodyCap ?? lim.maxBodies,
          sats: view.sats.length,
          satCap: snap?.satCap ?? lim.maxSats,
          mine: satsBy.get(client.you) ?? 0,
          mineCap: lim.maxSatsPerPlayer,
          rtt: client.rtt,
          offline,
          homeless: !homeBody,
          satsBy,
        });
        setAngleDeg((st.angle * 180) / Math.PI);
      }
    };

    const steer = (dt: number) => {
      const k = st.keys;
      const panX = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
      const panY = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
      if (panX || panY) {
        const v = (900 / st.cam.zoom) * dt;
        st.cam = {...st.cam, x: st.cam.x + panX * v, y: st.cam.y + panY * v};
        if (st.follow) {
          st.follow = false;
          setFollow(false);
        }
      }
      if (st.tool !== 'launch') return;
      const turn = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const push = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      if (turn) {
        st.angle += turn * 1.8 * dt;
        st.pathAt = 0;
      }
      if (push) {
        st.speed = Math.max(
          lim.minLaunchSpeed,
          Math.min(lim.maxLaunchSpeed, st.speed + push * 220 * dt),
        );
        st.pathAt = 0;
        setSpeed(st.speed);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      gpuField?.dispose();
      predictor.dispose();
    };
  }, [
    cfg,
    classCache,
    classOf,
    client,
    lim,
    offline,
    st,
    universe.height,
    universe.width,
  ]);

  // Keyboard.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const pick = BODY_MENU.find(m => `Digit${m.key}` === e.code);
      if (e.code === 'Digit1') chooseTool('launch');
      else if (pick) {
        chooseTool('body');
        changeBody({...st.body, kind: pick.kind});
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (st.tool === 'launch') launch();
      } else if (e.code === 'KeyV')
        chooseMode(MODES[(MODES.indexOf(st.mode) + 1) % MODES.length]);
      else if (e.code === 'KeyM') toggleMute();
      else if (e.code === 'KeyF') toggleFollow();
      else if (e.code === 'Escape') st.drag = null;
      else if (e.code === 'Equal')
        st.cam = {...st.cam, zoom: Math.min(ZOOM.max, st.cam.zoom * 1.25)};
      else if (e.code === 'Minus')
        st.cam = {...st.cam, zoom: Math.max(ZOOM.min, st.cam.zoom / 1.25)};
      st.keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => st.keys.delete(e.code);
    const blur = () => st.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [
    changeBody,
    chooseMode,
    chooseTool,
    launch,
    st,
    toggleFollow,
    toggleMute,
  ]);

  const worldAt = (
    e: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>,
  ) => {
    const r = e.currentTarget.getBoundingClientRect();
    return toWorld(
      e.clientX - r.left,
      e.clientY - r.top,
      viewport(st.cam, st.width, st.height),
    );
  };

  const bodyAt = (x: number, y: number): Body | undefined => {
    const scale = viewport(st.cam, st.width, st.height).scale;
    let best: Body | undefined;
    let bestD = Infinity;
    for (const b of st.view?.bodies ?? []) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < Math.max(b.radius, 10 / scale) + 6 / scale && d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  };

  const aimAt = (x: number, y: number) => {
    const h = home();
    if (!h) return;
    st.angle = Math.atan2(y - h.y, x - h.x);
    const dist = Math.hypot(x - h.x, y - h.y);
    changeSpeed(
      Math.max(
        lim.minLaunchSpeed,
        Math.min(lim.maxLaunchSpeed, dist * DRAG_SPEED),
      ),
    );
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button !== 0 || e.shiftKey) {
      st.drag = {kind: 'pan', sx: e.clientX, sy: e.clientY};
      return;
    }
    const w = worldAt(e);
    if (st.tool === 'launch') {
      st.drag = {kind: 'aim'};
      aimAt(w.x, w.y);
    } else {
      st.drag = {kind: 'spawn', x: w.x, y: w.y, vx: 0, vy: 0};
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = st.drag;
    const w = worldAt(e);
    if (!d) {
      st.hover = bodyAt(w.x, w.y)?.id ?? 0;
      return;
    }
    if (d.kind === 'pan') {
      const scale = viewport(st.cam, st.width, st.height).scale;
      st.cam = {
        ...st.cam,
        x: st.cam.x - (e.clientX - d.sx) / scale,
        y: st.cam.y - (e.clientY - d.sy) / scale,
      };
      d.sx = e.clientX;
      d.sy = e.clientY;
      if (st.follow) {
        st.follow = false;
        setFollow(false);
      }
    } else if (d.kind === 'aim') {
      aimAt(w.x, w.y);
    } else {
      d.vx = (w.x - d.x) * FLING;
      d.vy = (w.y - d.y) * FLING;
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = st.drag;
    st.drag = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'aim') launch();
    else if (d.kind === 'spawn') {
      client.spawn({...st.body, x: d.x, y: d.y, vx: d.vx, vy: d.vy});
    }
  };

  const onDoubleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const w = worldAt(e);
    const b = bodyAt(w.x, w.y);
    if (b && (b.kind === 'planet' || b.kind === 'rock')) {
      client.setHome(b.id);
      toast('Home planet changed');
    }
  };

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    st.cam = zoomAt(
      st.cam,
      Math.exp(-e.deltaY * 0.0015),
      e.clientX - r.left,
      e.clientY - r.top,
      st.width,
      st.height,
    );
  };

  const onMinimap = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = minimapToWorld(
      e.clientX - r.left,
      e.clientY - r.top,
      r.width,
      r.height,
      universe,
    );
    st.cam = {...st.cam, x: w.x, y: w.y};
    st.follow = false;
    setFollow(false);
  };

  return (
    <div ref={boxRef} className="absolute inset-0">
      <canvas
        ref={gpuRef}
        className={gpu ? 'absolute inset-0 h-full w-full' : 'hidden'}
        aria-hidden="true"
      />
      <canvas
        ref={bgRef}
        className={gpu ? 'hidden' : 'absolute inset-0 h-full w-full'}
        aria-hidden="true"
      />
      <canvas
        ref={fgRef}
        data-testid="game-canvas"
        className={`absolute inset-0 h-full w-full touch-none ${tool === 'launch' ? 'cursor-crosshair' : 'cursor-copy'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (st.drag = null)}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={e => e.preventDefault()}
      />
      <Hud
        stats={stats}
        players={players}
        you={client.you}
        tool={tool}
        onTool={chooseTool}
        speed={speed}
        minSpeed={lim.minLaunchSpeed}
        maxSpeed={lim.maxLaunchSpeed}
        onSpeed={changeSpeed}
        angleDeg={angleDeg}
        onLaunch={launch}
        mode={mode}
        onMode={chooseMode}
        muted={muted}
        onMute={toggleMute}
        follow={follow}
        onFollow={toggleFollow}
        onLeave={() => client.leave()}
        toasts={toasts}
        minimapRef={miniRef}
        onMinimap={onMinimap}
        body={body}
        bodyRange={spawnRange(body.kind, cfg.physics)}
        bodyClass={specClass(body).label}
        onBody={changeBody}
      />
    </div>
  );
}

/** Default placement spec for `kind`: preset mass, size for that mass. */
function defaultSpec(kind: SpawnKind, cfg: GameConfig): BodySpec {
  const range = spawnRange(kind, cfg.physics);
  return {kind, mu: range.mu, radius: radiusFor(kind, range.mu), spin: 0};
}

/** Appends interpolated positions to per-satellite trails; drops dead ones. */
function updateTrails(
  trails: Map<number, Array<{x: number; y: number}>>,
  view: View,
): void {
  const alive = new Set<number>();
  for (const s of view.sats) {
    alive.add(s.id);
    let t = trails.get(s.id);
    if (!t) trails.set(s.id, (t = []));
    const last = t[t.length - 1];
    if (!last || Math.hypot(s.x - last.x, s.y - last.y) > TRAIL_GAP) {
      t.push({x: s.x, y: s.y});
      if (t.length > TRAIL_POINTS) t.shift();
    }
  }
  for (const id of trails.keys()) if (!alive.has(id)) trails.delete(id);
}
