/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameHud, type HudTelemetry } from './components/GameHud';
import { GameModals } from './components/GameModals';
import { TitleScreen } from './components/TitleScreen';
import {
  renderUniverseMinimap,
  type MinimapDestroyFlash,
} from './components/UniverseMinimap';
import { soundEngine } from './game/audio';
import {
  MISSIONS,
  evaluateFlightState,
  generateDeterministicCluster,
} from './game/missions';
import {
  CAMERA_LIMITS,
  ParticlePool,
  clampCamera,
  computeViewportTransform,
  renderSpacetimeFieldFallback2D,
  renderVectorOverlay,
  screenToWorld,
  worldToScreen,
  zoomCameraAroundPoint,
  type ViewportTransform,
} from './gpu/spacetimeCanvasRenderer';
import { WebGPUGameBackend } from './gpu/webgpuGravityRenderer';
import {
  CpuGravityGridSolver,
  DEFAULT_GRID_CONFIG,
  Direct3DFieldSampler,
  UNIVERSE_CONFIG,
  advanceOrbitingMasses,
  stepMassBodiesNBody,
} from './physics/gravityField';
import {
  DEFAULT_ROCKET_CONFIG,
  ROCKET_PHYSICS_REGISTRY,
  createInitialRocketState,
  predictTrajectory,
} from './physics/rocketPhysics';
import type {
  FieldViewMode,
  FlightPhase,
  GameState,
  MassBody,
  RocketState,
  RunSnapshot,
  TrajectoryPoint,
  WaypointBeacon,
} from './physics/types';

interface MutableSim {
  gameState: GameState;
  phase: FlightPhase;
  missionIndex: number;
  masses: MassBody[];
  baseMasses: MassBody[];
  waypoints: WaypointBeacon[];
  rocket: RocketState;
  rocketTrail: Array<{ x: number; y: number }>;
  predictedTrajectory: TrajectoryPoint[];
  aimAngle: number;
  launchSpeed: number;
  viewMode: FieldViewMode;
  physicsModelId: string;
  nBodyEnabled: boolean;
  elapsedTime: number;
  hitstop: number;
  trauma: number;
  pendingOutcomeDelay: number;
  pendingOutcome: RunSnapshot | null;
  gridDirty: boolean;
  cameraDirty: boolean;
  selectedMassId: string | null;
  dragMode: 'none' | 'aim' | 'mass' | 'pan';
  panLastX: number;
  panLastY: number;
  camX: number;
  camY: number;
  zoom: number;
  cameraTool: 'aim' | 'pan';
  followRocket: boolean;
  cssWidth: number;
  cssHeight: number;
  lastTelemetrySync: number;
  lastGridSync: number;
  lastPredictionSync: number;
  escapedCount: number;
  destroyFlashes: MinimapDestroyFlash[];
}

function buildWaypoints(missionIdx: number): WaypointBeacon[] {
  return MISSIONS[missionIdx].waypoints.map((w) => ({
    ...w,
    collected: false,
  }));
}

function cloneMasses(masses: readonly MassBody[]): MassBody[] {
  return masses.map((m) => ({
    ...m,
    orbit: m.orbit ? { ...m.orbit } : undefined,
  }));
}

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webgpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const vectorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const initialMissionIdx = 0;
  const initialMission = MISSIONS[initialMissionIdx];

  const [gameState, setGameState] = useState<GameState>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        return 'playing';
      }
    }
    return 'title';
  });
  const [phase, setPhase] = useState<FlightPhase>('aiming');
  const [missionIndex, setMissionIndex] = useState<number>(initialMissionIdx);
  const [viewMode, setViewMode] = useState<FieldViewMode>('spacetime');
  const [physicsModelId, setPhysicsModelId] = useState<string>('gr-3d');
  const [nBodyEnabled, setNBodyEnabled] = useState<boolean>(
    Boolean(initialMission.nBodyDefault)
  );
  const [aimAngleDeg, setAimAngleDeg] = useState<number>(
    (initialMission.defaultAimAngle * 180) / Math.PI
  );
  const [launchSpeed, setLaunchSpeed] = useState<number>(initialMission.defaultLaunchSpeed);
  const [muted, setMuted] = useState<boolean>(false);
  const [gpuActive, setGpuActive] = useState<boolean | null>(null);
  const [zoom, setZoom] = useState<number>(CAMERA_LIMITS.defaultZoom);
  const [cameraTool, setCameraTool] = useState<'aim' | 'pan'>('aim');
  const [followRocket, setFollowRocket] = useState<boolean>(false);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [telemetry, setTelemetry] = useState<HudTelemetry>({
    speed: initialMission.defaultLaunchSpeed,
    speedPctC: (initialMission.defaultLaunchSpeed / initialMission.speedOfLight) * 100,
    fuel: initialMission.rocketFuel,
    maxFuel: initialMission.rocketFuel,
    coordTime: 0,
    properTime: 0,
    lapse: 1.0,
    waypointsCollected: 0,
    waypointsTotal: initialMission.waypoints.length,
    massCount: initialMission.masses.length,
    rocketOffscreen: false,
    offscreenMassCount: 0,
    escapedCount: 0,
  });

  const solverRef = useRef<CpuGravityGridSolver>(
    new CpuGravityGridSolver({
      ...DEFAULT_GRID_CONFIG,
      speedOfLight: initialMission.speedOfLight,
    })
  );
  const particlesRef = useRef<ParticlePool>(new ParticlePool(300));
  const gpuBackendRef = useRef<WebGPUGameBackend | null>(null);
  const vpRef = useRef<ViewportTransform>(
    computeViewportTransform(1280, 720, DEFAULT_GRID_CONFIG.worldWidth, DEFAULT_GRID_CONFIG.worldHeight)
  );
  const keysRef = useRef<Set<string>>(new Set());

  const simRef = useRef<MutableSim>({
    gameState,
    phase: 'aiming',
    missionIndex: initialMissionIdx,
    masses: cloneMasses(initialMission.masses),
    baseMasses: cloneMasses(initialMission.masses),
    waypoints: buildWaypoints(initialMissionIdx),
    rocket: createInitialRocketState(
      initialMission.launchPos.x,
      initialMission.launchPos.y,
      initialMission.defaultAimAngle,
      initialMission.rocketFuel,
      0
    ),
    rocketTrail: [],
    predictedTrajectory: [],
    aimAngle: initialMission.defaultAimAngle,
    launchSpeed: initialMission.defaultLaunchSpeed,
    viewMode: 'spacetime',
    physicsModelId: 'gr-3d',
    nBodyEnabled: Boolean(initialMission.nBodyDefault),
    elapsedTime: 0,
    hitstop: 0,
    trauma: 0,
    pendingOutcomeDelay: 0,
    pendingOutcome: null,
    gridDirty: true,
    cameraDirty: true,
    selectedMassId: null,
    dragMode: 'none',
    panLastX: 0,
    panLastY: 0,
    camX: 0,
    camY: 0,
    zoom: CAMERA_LIMITS.defaultZoom,
    cameraTool: 'aim',
    followRocket: false,
    cssWidth: 1280,
    cssHeight: 720,
    lastTelemetrySync: 0,
    lastGridSync: 0,
    lastPredictionSync: 0,
    escapedCount: 0,
    destroyFlashes: [],
  });

  const applyCameraState = useCallback((camX: number, camY: number, nextZoom: number) => {
    const sim = simRef.current;
    const clamped = clampCamera(
      camX,
      camY,
      nextZoom,
      UNIVERSE_CONFIG.universeWidth,
      UNIVERSE_CONFIG.universeHeight
    );
    sim.camX = clamped.camX;
    sim.camY = clamped.camY;
    sim.zoom = clamped.zoom;
    sim.cameraDirty = true;
    vpRef.current = computeViewportTransform(
      sim.cssWidth,
      sim.cssHeight,
      DEFAULT_GRID_CONFIG.worldWidth,
      DEFAULT_GRID_CONFIG.worldHeight,
      clamped.camX,
      clamped.camY,
      clamped.zoom
    );
    setZoom(clamped.zoom);
  }, []);

  const recomputePredictionOnly = useCallback(() => {
    const sim = simRef.current;
    const solver = solverRef.current;
    const mission = MISSIONS[sim.missionIndex];
    const model = ROCKET_PHYSICS_REGISTRY[sim.physicsModelId] ?? ROCKET_PHYSICS_REGISTRY['gr-3d'];
    const previewRocket =
      sim.phase === 'aiming'
        ? createInitialRocketState(
            mission.launchPos.x,
            mission.launchPos.y,
            sim.aimAngle,
            mission.rocketFuel,
            sim.launchSpeed
          )
        : sim.rocket;

    if (sim.nBodyEnabled && sim.masses.length > 1) {
      let previewMasses = cloneMasses(sim.masses);
      const dynamicSampler = new Direct3DFieldSampler(previewMasses, solver.config);
      sim.predictedTrajectory = predictTrajectory(
        previewRocket,
        model,
        dynamicSampler,
        previewMasses,
        DEFAULT_ROCKET_CONFIG,
        95,
        0.04,
        (stepDt) => {
          const stepRes = stepMassBodiesNBody(previewMasses, stepDt, mission.speedOfLight, {
            worldWidth: DEFAULT_GRID_CONFIG.worldWidth,
            worldHeight: DEFAULT_GRID_CONFIG.worldHeight,
            worldDepth: DEFAULT_GRID_CONFIG.worldDepth,
            universeWidth: UNIVERSE_CONFIG.universeWidth,
            universeHeight: UNIVERSE_CONFIG.universeHeight,
            universeDepth: UNIVERSE_CONFIG.universeDepth,
            containInArena: false,
            mergeOnCollision: true,
            destroyOnEscape: true,
            escapeFieldThreshold: UNIVERSE_CONFIG.escapeFieldThreshold,
            minEscapeRadius: UNIVERSE_CONFIG.minEscapeRadius,
          });
          previewMasses = stepRes.masses;
          dynamicSampler.setMasses(previewMasses);
          return previewMasses;
        },
        UNIVERSE_CONFIG.universeWidth,
        UNIVERSE_CONFIG.universeHeight,
        UNIVERSE_CONFIG.escapeFieldThreshold,
        UNIVERSE_CONFIG.minEscapeRadius,
        UNIVERSE_CONFIG.universeDepth
      );
    } else {
      sim.predictedTrajectory = predictTrajectory(
        previewRocket,
        model,
        solver,
        sim.masses,
        DEFAULT_ROCKET_CONFIG,
        155,
        0.032,
        undefined,
        UNIVERSE_CONFIG.universeWidth,
        UNIVERSE_CONFIG.universeHeight,
        UNIVERSE_CONFIG.escapeFieldThreshold,
        UNIVERSE_CONFIG.minEscapeRadius,
        UNIVERSE_CONFIG.universeDepth
      );
    }
    sim.lastPredictionSync = performance.now();
  }, []);

  const recomputeGridAndPrediction = useCallback(() => {
    const sim = simRef.current;
    const solver = solverRef.current;
    const mission = MISSIONS[sim.missionIndex];
    solver.updateSpeedOfLight(mission.speedOfLight);
    solver.computeGrid(sim.masses);
    sim.gridDirty = true;
    sim.lastGridSync = performance.now();
    recomputePredictionOnly();
  }, [recomputePredictionOnly]);

  const syncTelemetryImmediate = useCallback(() => {
    const sim = simRef.current;
    const mission = MISSIONS[sim.missionIndex];
    const spd =
      sim.phase === 'aiming'
        ? sim.launchSpeed
        : Math.hypot(sim.rocket.vx, sim.rocket.vy, sim.rocket.vz);
    const collected = sim.waypoints.filter((w) => w.collected).length;
    const halfViewW = DEFAULT_GRID_CONFIG.worldWidth * 0.5;
    const halfViewH = DEFAULT_GRID_CONFIG.worldHeight * 0.5;
    const rocketOffscreen =
      sim.phase === 'flying' &&
      (Math.abs(sim.rocket.x) > halfViewW || Math.abs(sim.rocket.y) > halfViewH);

    let offscreenMassCount = 0;
    for (let i = 0; i < sim.masses.length; i++) {
      const m = sim.masses[i];
      if (Math.abs(m.x) > halfViewW || Math.abs(m.y) > halfViewH) {
        offscreenMassCount++;
      }
    }

    setTelemetry({
      speed: spd,
      speedPctC: (spd / mission.speedOfLight) * 100,
      fuel: sim.rocket.fuel,
      maxFuel: sim.rocket.maxFuel,
      coordTime: sim.rocket.coordTime,
      properTime: sim.rocket.properTime,
      lapse: sim.rocket.lastLapse,
      waypointsCollected: collected,
      waypointsTotal: sim.waypoints.length,
      massCount: sim.masses.length,
      rocketOffscreen,
      offscreenMassCount,
      escapedCount: sim.escapedCount,
    });
  }, []);

  const loadMission = useCallback(
    (idx: number, preserveSandboxMasses = false) => {
      const clampedIdx = Math.max(0, Math.min(MISSIONS.length - 1, idx));
      const m = MISSIONS[clampedIdx];
      const sim = simRef.current;

      sim.missionIndex = clampedIdx;
      sim.phase = 'aiming';
      if (!preserveSandboxMasses) {
        sim.baseMasses = cloneMasses(m.masses);
        sim.masses = cloneMasses(m.masses);
        sim.nBodyEnabled = Boolean(m.nBodyDefault);
        setNBodyEnabled(sim.nBodyEnabled);
      }
      sim.waypoints = buildWaypoints(clampedIdx);
      sim.aimAngle = m.defaultAimAngle;
      sim.launchSpeed = m.defaultLaunchSpeed;
      sim.rocket = createInitialRocketState(
        m.launchPos.x,
        m.launchPos.y,
        m.defaultAimAngle,
        m.rocketFuel,
        0
      );
      sim.rocketTrail = [];
      sim.elapsedTime = 0;
      sim.hitstop = 0;
      sim.trauma = 0;
      sim.pendingOutcome = null;
      sim.pendingOutcomeDelay = 0;
      sim.selectedMassId = null;
      sim.escapedCount = 0;
      sim.destroyFlashes = [];
      sim.camX = 0;
      sim.camY = 0;
      sim.zoom = CAMERA_LIMITS.defaultZoom;
      sim.cameraDirty = true;
      sim.followRocket = false;
      vpRef.current = computeViewportTransform(
        sim.cssWidth,
        sim.cssHeight,
        DEFAULT_GRID_CONFIG.worldWidth,
        DEFAULT_GRID_CONFIG.worldHeight,
        0,
        0,
        CAMERA_LIMITS.defaultZoom
      );
      setZoom(CAMERA_LIMITS.defaultZoom);
      setFollowRocket(false);
      particlesRef.current.clear();
      soundEngine.setThrustActive(false);

      setMissionIndex(clampedIdx);
      setPhase('aiming');
      setAimAngleDeg((m.defaultAimAngle * 180) / Math.PI);
      setLaunchSpeed(m.defaultLaunchSpeed);
      setSnapshot(null);

      recomputeGridAndPrediction();
      syncTelemetryImmediate();
    },
    [recomputeGridAndPrediction, syncTelemetryImmediate]
  );

  const setGameStateSynced = useCallback((next: GameState) => {
    simRef.current.gameState = next;
    setGameState(next);
    document.body.dataset.state = next;
    if (next !== 'playing') {
      soundEngine.setThrustActive(false);
    }
  }, []);

  const handleStartGame = useCallback(() => {
    keysRef.current.clear();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    loadMission(simRef.current.missionIndex);
    setGameStateSynced('playing');
  }, [loadMission, setGameStateSynced]);

  const handleLaunchRocket = useCallback(() => {
    const sim = simRef.current;
    if (sim.gameState !== 'playing' || sim.phase !== 'aiming') return;
    const mission = MISSIONS[sim.missionIndex];

    sim.rocket = createInitialRocketState(
      mission.launchPos.x,
      mission.launchPos.y,
      sim.aimAngle,
      mission.rocketFuel,
      sim.launchSpeed
    );
    sim.rocketTrail = [{ x: sim.rocket.x, y: sim.rocket.y }];
    sim.phase = 'flying';
    setPhase('flying');
    soundEngine.playLaunchIgnition();
    syncTelemetryImmediate();
  }, [syncTelemetryImmediate]);

  const handleResetMission = useCallback(() => {
    const sim = simRef.current;
    const mission = MISSIONS[sim.missionIndex];
    loadMission(sim.missionIndex, Boolean(mission.isSandbox));
    if (sim.gameState !== 'title') {
      setGameStateSynced('playing');
    }
  }, [loadMission, setGameStateSynced]);

  const handleTogglePause = useCallback(() => {
    const sim = simRef.current;
    if (sim.gameState === 'playing') {
      setGameStateSynced('paused');
    } else if (sim.gameState === 'paused') {
      setGameStateSynced('playing');
    }
  }, [setGameStateSynced]);

  const handleToggleMute = useCallback(() => {
    const next = !soundEngine.isMuted();
    soundEngine.setMuted(next);
    setMuted(next);
  }, []);

  const handleSelectMission = useCallback(
    (idx: number) => {
      loadMission(idx);
      if (simRef.current.gameState !== 'title') {
        setGameStateSynced('playing');
      }
    },
    [loadMission, setGameStateSynced]
  );

  const handleChangeViewMode = useCallback((mode: FieldViewMode) => {
    simRef.current.viewMode = mode;
    setViewMode(mode);
  }, []);

  const handleChangePhysicsModel = useCallback(
    (id: string) => {
      simRef.current.physicsModelId = id;
      setPhysicsModelId(id);
      recomputeGridAndPrediction();
    },
    [recomputeGridAndPrediction]
  );

  const handleChangeAimAngleDeg = useCallback(
    (deg: number) => {
      const sim = simRef.current;
      if (sim.phase !== 'aiming') return;
      const rad = (deg * Math.PI) / 180;
      sim.aimAngle = rad;
      sim.rocket.angle = rad;
      setAimAngleDeg(deg);
      recomputeGridAndPrediction();
    },
    [recomputeGridAndPrediction]
  );

  const handleChangeLaunchSpeed = useCallback(
    (spd: number) => {
      const sim = simRef.current;
      if (sim.phase !== 'aiming') return;
      sim.launchSpeed = spd;
      setLaunchSpeed(spd);
      recomputeGridAndPrediction();
      syncTelemetryImmediate();
    },
    [recomputeGridAndPrediction, syncTelemetryImmediate]
  );

  const handleToggleNBody = useCallback(() => {
    const sim = simRef.current;
    sim.nBodyEnabled = !sim.nBodyEnabled;
    setNBodyEnabled(sim.nBodyEnabled);
    recomputeGridAndPrediction();
  }, [recomputeGridAndPrediction]);

  const handleAddSandboxMass = useCallback(
    (kind: 'star' | 'singularity' | 'cluster16') => {
      const sim = simRef.current;
      const idBase = `sb-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      if (kind === 'cluster16') {
        const extra = generateDeterministicCluster(16, Math.floor(Math.random() * 99999), 0, 0, 380, 270);
        sim.masses = [...sim.masses, ...extra];
      } else {
        const jx = (Math.random() - 0.5) * 380;
        const jy = (Math.random() - 0.5) * 260;
        const jz = (Math.random() - 0.5) * 120;
        const dist = Math.max(40, Math.hypot(jx, jy));
        const orbSpd = sim.nBodyEnabled ? 115 : 0;
        sim.masses = [
          ...sim.masses,
          {
            id: idBase,
            label: kind === 'star' ? 'Star' : 'Singularity',
            x: Math.round(jx),
            y: Math.round(jy),
            z: Math.round(jz),
            vx: Math.round((-jy / dist) * orbSpd),
            vy: Math.round((jx / dist) * orbSpd),
            vz: sim.nBodyEnabled ? Math.round((Math.random() - 0.5) * 38) : 0,
            mu: kind === 'star' ? 9800000 : 13500000,
            softening: kind === 'star' ? 40 : 30,
            radius: kind === 'star' ? 32 : 26,
            spin: kind === 'singularity' ? 14000 : 0,
            kind,
          },
        ];
      }
      sim.baseMasses = cloneMasses(sim.masses);
      recomputeGridAndPrediction();
      syncTelemetryImmediate();
    },
    [recomputeGridAndPrediction, syncTelemetryImmediate]
  );

  const handleClearSandboxMasses = useCallback(() => {
    const sim = simRef.current;
    sim.masses = [];
    sim.baseMasses = [];
    sim.selectedMassId = null;
    recomputeGridAndPrediction();
    syncTelemetryImmediate();
  }, [recomputeGridAndPrediction, syncTelemetryImmediate]);

  const handleZoomIn = useCallback(() => {
    const sim = simRef.current;
    applyCameraState(sim.camX, sim.camY, sim.zoom * 1.28);
  }, [applyCameraState]);

  const handleZoomOut = useCallback(() => {
    const sim = simRef.current;
    applyCameraState(sim.camX, sim.camY, sim.zoom / 1.28);
  }, [applyCameraState]);

  const handleResetCamera = useCallback(() => {
    const sim = simRef.current;
    sim.followRocket = false;
    setFollowRocket(false);
    applyCameraState(0, 0, CAMERA_LIMITS.defaultZoom);
  }, [applyCameraState]);

  const handleToggleCameraTool = useCallback(() => {
    const sim = simRef.current;
    const next = sim.cameraTool === 'aim' ? 'pan' : 'aim';
    sim.cameraTool = next;
    setCameraTool(next);
  }, []);

  const handleToggleFollowRocket = useCallback(() => {
    const sim = simRef.current;
    const next = !sim.followRocket;
    sim.followRocket = next;
    setFollowRocket(next);
    if (next) {
      applyCameraState(sim.rocket.x, sim.rocket.y, sim.zoom);
    }
  }, [applyCameraState]);

  const handlePanToWorld = useCallback(
    (wx: number, wy: number) => {
      const sim = simRef.current;
      if (sim.followRocket) {
        sim.followRocket = false;
        setFollowRocket(false);
      }
      applyCameraState(wx, wy, sim.zoom);
    },
    [applyCameraState]
  );

  // Keep body data-state synced on mount
  useEffect(() => {
    document.body.dataset.state = simRef.current.gameState;
  }, []);

  // Initialize WebGPU + ResizeObserver + 60 FPS Simulation Loop once
  useEffect(() => {
    const container = containerRef.current;
    const gpuCanvas = webgpuCanvasRef.current;
    const bgCanvas = bgCanvasRef.current;
    const vecCanvas = vectorCanvasRef.current;
    if (!container || !gpuCanvas || !bgCanvas || !vecCanvas) return;

    const bgCtx = bgCanvas.getContext('2d');
    const vecCtx = vecCanvas.getContext('2d');
    if (!bgCtx || !vecCtx) return;

    let disposed = false;
    let rafId = 0;

    let fieldCacheDirty = true;
    let cachedViewMode: FieldViewMode = simRef.current.viewMode;
    let renderedWhileIdle = false;
    let lastBgRedraw = 0;

    // Initial compute
    recomputeGridAndPrediction();
    syncTelemetryImmediate();

    const handleResize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.max(1, Math.round(rect.width * dpr));
      const ph = Math.max(1, Math.round(rect.height * dpr));

      if (gpuCanvas.width !== pw || gpuCanvas.height !== ph) {
        gpuCanvas.width = pw;
        gpuCanvas.height = ph;
      }
      if (bgCanvas.width !== pw || bgCanvas.height !== ph) {
        bgCanvas.width = pw;
        bgCanvas.height = ph;
      }
      if (vecCanvas.width !== pw || vecCanvas.height !== ph) {
        vecCanvas.width = pw;
        vecCanvas.height = ph;
      }

      vecCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fieldCacheDirty = true;
      renderedWhileIdle = false;
      const sim = simRef.current;
      sim.cssWidth = rect.width;
      sim.cssHeight = rect.height;
      vpRef.current = computeViewportTransform(
        rect.width,
        rect.height,
        DEFAULT_GRID_CONFIG.worldWidth,
        DEFAULT_GRID_CONFIG.worldHeight,
        sim.camX,
        sim.camY,
        sim.zoom
      );
    };

    handleResize();
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);

    // Probe and initialize WebGPU compute + render backend cleanly
    WebGPUGameBackend.create(gpuCanvas, DEFAULT_GRID_CONFIG).then((backend) => {
      if (disposed) {
        backend?.dispose();
        return;
      }
      gpuBackendRef.current = backend;
      setGpuActive(Boolean(backend));
      if (backend) {
        simRef.current.gridDirty = true;
      }
    });

    let lastTime = performance.now();
    let lastCpuFrame = 0;

    const frame = (now: number) => {
      if (disposed) return;

      // On CPU fallback (no hardware WebGPU), pace rendering to ~32 Hz so the compositor stays responsive
      if (!gpuBackendRef.current && now - lastCpuFrame < 30) {
        rafId = requestAnimationFrame(frame);
        return;
      }
      lastCpuFrame = now;

      const rawDt = (now - lastTime) / 1000;
      lastTime = now;
      const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

      const sim = simRef.current;
      const solver = solverRef.current;
      const mission = MISSIONS[sim.missionIndex];

      // Age active minimap destruction flashes
      if (sim.destroyFlashes.length > 0) {
        for (let i = sim.destroyFlashes.length - 1; i >= 0; i--) {
          sim.destroyFlashes[i].age += dt;
          if (sim.destroyFlashes[i].age >= sim.destroyFlashes[i].maxAge) {
            sim.destroyFlashes.splice(i, 1);
          }
        }
      }

      // Ambient world motion on Title OR active simulation in Playing
      if (sim.gameState === 'title' || sim.gameState === 'playing') {
        if (sim.hitstop > 0) {
          sim.hitstop = Math.max(0, sim.hitstop - dt);
        } else {
          sim.elapsedTime += dt;

          // Update moving stars: true mutual N-body 3D attraction OR kinematic orbits
          let massesMoved = false;
          let hadTopologyChange = false;
          if (sim.nBodyEnabled && sim.masses.length > 1) {
            const nbodyRes = stepMassBodiesNBody(sim.masses, dt, mission.speedOfLight, {
              worldWidth: DEFAULT_GRID_CONFIG.worldWidth,
              worldHeight: DEFAULT_GRID_CONFIG.worldHeight,
              worldDepth: DEFAULT_GRID_CONFIG.worldDepth,
              universeWidth: UNIVERSE_CONFIG.universeWidth,
              universeHeight: UNIVERSE_CONFIG.universeHeight,
              universeDepth: UNIVERSE_CONFIG.universeDepth,
              containInArena: false,
              mergeOnCollision: true,
              destroyOnEscape: true,
              escapeFieldThreshold: UNIVERSE_CONFIG.escapeFieldThreshold,
              minEscapeRadius: UNIVERSE_CONFIG.minEscapeRadius,
            });
            sim.masses = nbodyRes.masses;
            massesMoved = true;

            if (nbodyRes.mergers.length > 0) {
              hadTopologyChange = true;
              for (const mg of nbodyRes.mergers) {
                for (let k = 0; k < 18; k++) {
                  const a = (k / 18) * Math.PI * 2;
                  const spd = 70 + Math.random() * 160;
                  particlesRef.current.spawn(
                    mg.x,
                    mg.y,
                    Math.cos(a) * spd,
                    Math.sin(a) * spd,
                    0.5,
                    3.8,
                    1
                  );
                }
              }
              soundEngine.playWaypointChime();
            }

            if (nbodyRes.escaped.length > 0) {
              hadTopologyChange = true;
              sim.escapedCount += nbodyRes.escaped.length;
              for (const esc of nbodyRes.escaped) {
                sim.destroyFlashes.push({ x: esc.x, y: esc.y, age: 0, maxAge: 0.9 });
              }
              soundEngine.playCrash();
            }

            if (hadTopologyChange) {
              syncTelemetryImmediate();
            }
          } else {
            const movedMasses = advanceOrbitingMasses(sim.baseMasses, sim.elapsedTime);
            if (movedMasses !== sim.baseMasses) {
              sim.masses = movedMasses;
              massesMoved = true;
            }
          }

          if (massesMoved) {
            const gridInterval = !gpuBackendRef.current && sim.masses.length > 10 ? 45 : 0;
            if (hadTopologyChange || now - sim.lastGridSync >= gridInterval) {
              solver.computeGrid(sim.masses);
              sim.gridDirty = true;
              sim.lastGridSync = now;
            }
            if (sim.phase === 'aiming' && (hadTopologyChange || now - sim.lastPredictionSync >= 110)) {
              recomputePredictionOnly();
            }
          }
        }

        // Camera keyboard panning (when Pan tool active during aiming, or holding Shift anytime)
        if (sim.gameState === 'playing') {
          const keys = keysRef.current;
          const shiftHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');
          const panWithKeys =
            shiftHeld || (sim.cameraTool === 'pan' && sim.phase === 'aiming');

          if (panWithKeys) {
            const panX =
              (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
              (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
            const panY =
              (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) -
              (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);

            if (panX !== 0 || panY !== 0) {
              const panSpd = (780 / Math.max(0.25, sim.zoom)) * dt;
              if (sim.followRocket) {
                sim.followRocket = false;
                setFollowRocket(false);
              }
              applyCameraState(
                sim.camX + panX * panSpd,
                sim.camY + panY * panSpd,
                sim.zoom
              );
            }
          } else if (sim.phase === 'aiming') {
            // Aiming keyboard adjustment
            let angleChanged = false;
            let speedChanged = false;

            if (keys.has('KeyA') || keys.has('ArrowLeft')) {
              sim.aimAngle -= 1.6 * dt;
              angleChanged = true;
            }
            if (keys.has('KeyD') || keys.has('ArrowRight')) {
              sim.aimAngle += 1.6 * dt;
              angleChanged = true;
            }
            if (keys.has('KeyW') || keys.has('ArrowUp')) {
              sim.launchSpeed = Math.min(mission.maxLaunchSpeed, sim.launchSpeed + 190 * dt);
              speedChanged = true;
            }
            if (keys.has('KeyS') || keys.has('ArrowDown')) {
              sim.launchSpeed = Math.max(120, sim.launchSpeed - 190 * dt);
              speedChanged = true;
            }

            if (angleChanged || speedChanged) {
              sim.rocket.angle = sim.aimAngle;
              if (angleChanged) setAimAngleDeg((sim.aimAngle * 180) / Math.PI);
              if (speedChanged) setLaunchSpeed(sim.launchSpeed);
              recomputeGridAndPrediction();
            }
          }
        }

        // Active Rocket Flight Integration via the replaceable RocketPhysicsModel
        if (sim.gameState === 'playing' && sim.phase === 'flying' && sim.hitstop <= 0) {
          const keys = keysRef.current;
          const throttle =
            keys.has('KeyW') || keys.has('ArrowUp') || keys.has('Space')
              ? 1
              : keys.has('KeyS') || keys.has('ArrowDown')
                ? -0.55
                : 0;
          const turn =
            (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
            (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);

          const model =
            ROCKET_PHYSICS_REGISTRY[sim.physicsModelId] ??
            ROCKET_PHYSICS_REGISTRY['gr-3d'];

          sim.rocket = model.step(
            sim.rocket,
            { throttle, turn },
            solver,
            dt,
            DEFAULT_ROCKET_CONFIG
          );

          soundEngine.setThrustActive(sim.rocket.thrusting);

          if (sim.rocket.thrusting) {
            const backX = sim.rocket.x - Math.cos(sim.rocket.angle) * 12;
            const backY = sim.rocket.y - Math.sin(sim.rocket.angle) * 12;
            const jitter = (Math.random() - 0.5) * 45;
            particlesRef.current.spawn(
              backX,
              backY,
              sim.rocket.vx - Math.cos(sim.rocket.angle) * 150 + jitter,
              sim.rocket.vy - Math.sin(sim.rocket.angle) * 150 + jitter,
              0.38,
              3.2,
              0
            );
          }

          const lastPt = sim.rocketTrail[sim.rocketTrail.length - 1];
          if (
            !lastPt ||
            Math.hypot(sim.rocket.x - lastPt.x, sim.rocket.y - lastPt.y) > 8
          ) {
            sim.rocketTrail.push({ x: sim.rocket.x, y: sim.rocket.y });
            if (sim.rocketTrail.length > 260) {
              sim.rocketTrail.shift();
            }
          }

          const evalRes = evaluateFlightState(
            sim.rocket,
            sim.masses,
            mission.target,
            sim.waypoints,
            DEFAULT_ROCKET_CONFIG,
            UNIVERSE_CONFIG.universeWidth,
            UNIVERSE_CONFIG.universeHeight,
            UNIVERSE_CONFIG.escapeFieldThreshold,
            UNIVERSE_CONFIG.minEscapeRadius,
            UNIVERSE_CONFIG.universeDepth
          );

          if (evalRes.collectedWaypointIds.length > 0) {
            for (const wp of sim.waypoints) {
              if (evalRes.collectedWaypointIds.includes(wp.id)) {
                wp.collected = true;
              }
            }
            soundEngine.playWaypointChime();
          }

          if (evalRes.status === 'victory' || evalRes.status === 'crashed') {
            sim.phase = evalRes.status;
            setPhase(evalRes.status);
            soundEngine.setThrustActive(false);

            if (evalRes.status === 'crashed') {
              sim.hitstop = 0.055;
              sim.trauma = 0.85;
              sim.destroyFlashes.push({
                x: sim.rocket.x,
                y: sim.rocket.y,
                age: 0,
                maxAge: 0.9,
              });
              soundEngine.playCrash();
              for (let k = 0; k < 26; k++) {
                const a = (k / 26) * Math.PI * 2 + Math.random() * 0.2;
                const spd = 80 + Math.random() * 210;
                particlesRef.current.spawn(
                  sim.rocket.x,
                  sim.rocket.y,
                  Math.cos(a) * spd,
                  Math.sin(a) * spd,
                  0.55 + Math.random() * 0.3,
                  4.2,
                  1
                );
              }
            } else {
              soundEngine.playVictory();
            }

            const wpCollected = sim.waypoints.filter((w) => w.collected).length;
            sim.pendingOutcome = {
              outcome: evalRes.status === 'victory' ? 'victory' : 'defeat',
              reason: evalRes.reason ?? '',
              missionTitle: mission.title,
              coordTime: sim.rocket.coordTime,
              properTime: sim.rocket.properTime,
              timeDilationSaved: Math.max(0, sim.rocket.coordTime - sim.rocket.properTime),
              peakSpeed: sim.rocket.peakSpeed,
              minLapse: sim.rocket.minLapse,
              fuelRemainingPct:
                sim.rocket.maxFuel > 0 ? (sim.rocket.fuel / sim.rocket.maxFuel) * 100 : 0,
              waypointsCollected: wpCollected,
              waypointsTotal: sim.waypoints.length,
              physicsModelName: model.name,
            };
            sim.pendingOutcomeDelay = evalRes.status === 'crashed' ? 0.48 : 0.25;
            syncTelemetryImmediate();
          }
        }

        // Delayed Victory / Game Over modal reveal after crash/capture beat
        if (
          sim.gameState === 'playing' &&
          sim.pendingOutcome &&
          sim.pendingOutcomeDelay > 0
        ) {
          sim.pendingOutcomeDelay -= dt;
          if (sim.pendingOutcomeDelay <= 0) {
            setSnapshot(sim.pendingOutcome);
            sim.pendingOutcome = null;
            setGameStateSynced('gameover');
          }
        }

        particlesRef.current.update(dt);
        if (sim.trauma > 0) {
          sim.trauma = Math.max(0, sim.trauma - dt * 1.9);
        }

        // Follow-rocket camera tracking
        if (sim.followRocket && sim.gameState === 'playing' && sim.phase !== 'crashed') {
          const lerp = 1 - Math.exp(-9 * dt);
          const nextX = sim.camX + (sim.rocket.x - sim.camX) * lerp;
          const nextY = sim.camY + (sim.rocket.y - sim.camY) * lerp;
          const clamped = clampCamera(
            nextX,
            nextY,
            sim.zoom,
            UNIVERSE_CONFIG.universeWidth,
            UNIVERSE_CONFIG.universeHeight
          );
          if (Math.abs(clamped.camX - sim.camX) > 0.25 || Math.abs(clamped.camY - sim.camY) > 0.25) {
            sim.camX = clamped.camX;
            sim.camY = clamped.camY;
            sim.cameraDirty = true;
            vpRef.current = computeViewportTransform(
              sim.cssWidth,
              sim.cssHeight,
              DEFAULT_GRID_CONFIG.worldWidth,
              DEFAULT_GRID_CONFIG.worldHeight,
              sim.camX,
              sim.camY,
              sim.zoom
            );
          }
        }

        // Throttle React HUD telemetry state updates (~4.5 Hz) to avoid reconciliation pressure
        if (now - sim.lastTelemetrySync > 220 && (sim.phase === 'flying' || sim.nBodyEnabled)) {
          sim.lastTelemetrySync = now;
          syncTelemetryImmediate();
        }
      }

      // Avoid burning CPU redraws while a static Pause/GameOver modal covers the screen
      const isModalOpen = sim.gameState === 'paused' || sim.gameState === 'gameover';
      if (isModalOpen && renderedWhileIdle && !sim.gridDirty && !sim.cameraDirty) {
        rafId = requestAnimationFrame(frame);
        return;
      }
      renderedWhileIdle = isModalOpen;

      // Compute camera shake offset from decaying trauma^2
      const shakeAmp = sim.trauma * sim.trauma * 10;
      const shakeX = shakeAmp > 0.1 ? (Math.random() - 0.5) * 2 * shakeAmp : 0;
      const shakeY = shakeAmp > 0.1 ? (Math.random() - 0.5) * 2 * shakeAmp : 0;
      const vp: ViewportTransform = {
        ...vpRef.current,
        offsetX: vpRef.current.offsetX + shakeX,
        offsetY: vpRef.current.offsetY + shakeY,
      };
      const viewWorldW = vp.cssWidth / Math.max(0.001, vp.scale);
      const viewWorldH = vp.cssHeight / Math.max(0.001, vp.scale);

      // Render Layer 1: WebGPU Compute+Render OR Static CPU Canvas2D Field Fallback
      const gpuBackend = gpuBackendRef.current;
      if (gpuBackend) {
        gpuBackend.renderFrame(
          sim.masses,
          mission.speedOfLight,
          sim.viewMode,
          sim.elapsedTime,
          sim.gridDirty,
          sim.camX,
          sim.camY,
          viewWorldW,
          viewWorldH,
          sim.zoom
        );
        sim.gridDirty = false;
        sim.cameraDirty = false;
      } else if (
        fieldCacheDirty ||
        cachedViewMode !== sim.viewMode ||
        (sim.cameraDirty && now - lastBgRedraw > 45) ||
        (sim.gridDirty && now - lastBgRedraw > 110)
      ) {
        renderSpacetimeFieldFallback2D(
          bgCtx,
          solver,
          sim.masses,
          sim.viewMode,
          vpRef.current
        );
        sim.gridDirty = false;
        sim.cameraDirty = false;
        fieldCacheDirty = false;
        cachedViewMode = sim.viewMode;
        lastBgRedraw = now;
      }

      // Render Layer 2: Crisp Transparent Vector Overlay (Masses, Target, Waypoints, Trajectory, Rocket)
      renderVectorOverlay(
        vecCtx,
        {
          masses: sim.masses,
          rocket: sim.rocket,
          rocketTrail: sim.rocketTrail,
          predictedTrajectory: sim.predictedTrajectory,
          target: mission.target,
          waypoints: sim.waypoints,
          phase: sim.phase,
          viewMode: sim.viewMode,
          aimAngle: sim.aimAngle,
          launchSpeed: sim.launchSpeed,
          elapsedTime: sim.elapsedTime,
          isDraggingAim: sim.dragMode === 'aim',
          selectedMassId: sim.selectedMassId,
          solver,
          particles: particlesRef.current,
          transparentBg: true,
        },
        vp
      );

      // Render Layer 3: Universe Minimap
      const miniCanvas = minimapCanvasRef.current;
      if (miniCanvas && sim.gameState !== 'title') {
        const mCtx = miniCanvas.getContext('2d');
        if (mCtx) {
          renderUniverseMinimap(mCtx, miniCanvas.width, miniCanvas.height, {
            masses: sim.masses,
            rocket: sim.rocket,
            rocketTrail: sim.rocketTrail,
            predictedTrajectory: sim.predictedTrajectory,
            target: mission.target,
            waypoints: sim.waypoints,
            phase: sim.phase,
            aimAngle: sim.aimAngle,
            viewWidth: DEFAULT_GRID_CONFIG.worldWidth,
            viewHeight: DEFAULT_GRID_CONFIG.worldHeight,
            universeWidth: UNIVERSE_CONFIG.universeWidth,
            universeHeight: UNIVERSE_CONFIG.universeHeight,
            camX: sim.camX,
            camY: sim.camY,
            camViewWidth: viewWorldW,
            camViewHeight: viewWorldH,
            destroyFlashes: sim.destroyFlashes,
          });
        }
      }

      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      gpuBackendRef.current?.dispose();
      gpuBackendRef.current = null;
    };
  }, [applyCameraState, recomputeGridAndPrediction, recomputePredictionOnly, setGameStateSynced, syncTelemetryImmediate]);

  // Unified Keyboard Input & Window Blur Hygiene
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const sim = simRef.current;

      if (sim.gameState === 'title') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          handleStartGame();
        }
        return;
      }

      if (e.code === 'KeyP' || e.code === 'Escape') {
        if (sim.gameState === 'playing' || sim.gameState === 'paused') {
          e.preventDefault();
          handleTogglePause();
        }
        return;
      }

      if (e.code === 'KeyM') {
        e.preventDefault();
        handleToggleMute();
        return;
      }

      if (e.code === 'KeyR' && sim.gameState === 'playing') {
        e.preventDefault();
        handleResetMission();
        return;
      }

      if (sim.gameState === 'playing') {
        if (e.code === 'Equal' || e.code === 'NumpadAdd') {
          e.preventDefault();
          handleZoomIn();
          return;
        }
        if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          handleZoomOut();
          return;
        }
        if (e.code === 'Digit0' || e.code === 'Numpad0') {
          e.preventDefault();
          handleResetCamera();
          return;
        }
        if (e.code === 'KeyV') {
          e.preventDefault();
          handleToggleCameraTool();
          return;
        }
        if (e.code === 'KeyC') {
          e.preventDefault();
          handleToggleFollowRocket();
          return;
        }
      }

      if (sim.gameState === 'playing' && sim.phase === 'aiming') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          handleLaunchRocket();
          return;
        }
      }

      keysRef.current.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };

    const clearInputs = () => {
      keysRef.current.clear();
      simRef.current.dragMode = 'none';
      soundEngine.setThrustActive(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearInputs);
    document.addEventListener('visibilitychange', clearInputs);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearInputs);
      document.removeEventListener('visibilitychange', clearInputs);
    };
  }, [
    handleLaunchRocket,
    handleResetCamera,
    handleResetMission,
    handleStartGame,
    handleToggleCameraTool,
    handleToggleFollowRocket,
    handleToggleMute,
    handleTogglePause,
    handleZoomIn,
    handleZoomOut,
  ]);

  // Wheel Zoom toward cursor
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const sim = simRef.current;
      if (sim.gameState !== 'playing') return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0014);
      const next = zoomCameraAroundPoint(
        { camX: sim.camX, camY: sim.camY, zoom: sim.zoom },
        sim.zoom * factor,
        sx,
        sy,
        rect.width,
        rect.height,
        DEFAULT_GRID_CONFIG.worldWidth,
        DEFAULT_GRID_CONFIG.worldHeight
      );
      applyCameraState(next.camX, next.camY, next.zoom);
    },
    [applyCameraState]
  );

  // Pointer Aiming, Map Panning & Sandbox Mass Dragging
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (sim.gameState !== 'playing') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const worldPt = screenToWorld(sx, sy, vpRef.current);
    const mission = MISSIONS[sim.missionIndex];

    // Right-drag, middle-drag, Shift+drag, Pan tool, or left-drag during active flight pans the map
    const wantsPan =
      e.button === 1 ||
      e.button === 2 ||
      e.shiftKey ||
      sim.cameraTool === 'pan' ||
      (e.button === 0 && sim.phase !== 'aiming' && !mission.isSandbox);

    if (wantsPan) {
      sim.dragMode = 'pan';
      sim.panLastX = e.clientX;
      sim.panLastY = e.clientY;
      if (sim.followRocket) {
        sim.followRocket = false;
        setFollowRocket(false);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // In Sandbox, check if pointer clicked an existing mass to drag it
    if (mission.isSandbox) {
      for (let i = sim.masses.length - 1; i >= 0; i--) {
        const m = sim.masses[i];
        const hitRadius = Math.max(m.radius + 18, 22 / Math.max(0.3, sim.zoom));
        if (Math.hypot(worldPt.x - m.x, worldPt.y - m.y) <= hitRadius) {
          sim.selectedMassId = m.id;
          sim.dragMode = 'mass';
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (sim.phase !== 'aiming') {
        sim.dragMode = 'pan';
        sim.panLastX = e.clientX;
        sim.panLastY = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (sim.phase === 'aiming') {
      sim.dragMode = 'aim';
      e.currentTarget.setPointerCapture(e.pointerId);

      const dx = worldPt.x - sim.rocket.x;
      const dy = worldPt.y - sim.rocket.y;
      if (Math.hypot(dx, dy) > 12) {
        const ang = Math.atan2(dy, dx);
        const spd = Math.max(
          120,
          Math.min(mission.maxLaunchSpeed, Math.hypot(dx, dy) * 2.1)
        );
        sim.aimAngle = ang;
        sim.rocket.angle = ang;
        sim.launchSpeed = spd;
        setAimAngleDeg((ang * 180) / Math.PI);
        setLaunchSpeed(spd);
        recomputeGridAndPrediction();
        syncTelemetryImmediate();
      }
    }
  }, [recomputeGridAndPrediction, syncTelemetryImmediate]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (sim.dragMode === 'none') return;

    if (sim.dragMode === 'pan') {
      const dxScreen = e.clientX - sim.panLastX;
      const dyScreen = e.clientY - sim.panLastY;
      sim.panLastX = e.clientX;
      sim.panLastY = e.clientY;
      const scale = Math.max(0.05, vpRef.current.scale);
      applyCameraState(
        sim.camX - dxScreen / scale,
        sim.camY - dyScreen / scale,
        sim.zoom
      );
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const worldPt = screenToWorld(sx, sy, vpRef.current);
    const mission = MISSIONS[sim.missionIndex];
    const maxMassX = UNIVERSE_CONFIG.universeWidth * 0.5 - 60;
    const maxMassY = UNIVERSE_CONFIG.universeHeight * 0.5 - 60;

    if (sim.dragMode === 'mass' && sim.selectedMassId) {
      sim.masses = sim.masses.map((m) =>
        m.id === sim.selectedMassId
          ? {
              ...m,
              x: Math.max(-maxMassX, Math.min(maxMassX, worldPt.x)),
              y: Math.max(-maxMassY, Math.min(maxMassY, worldPt.y)),
            }
          : m
      );
      sim.baseMasses = cloneMasses(sim.masses);
      recomputeGridAndPrediction();
      return;
    }

    if (sim.dragMode === 'aim' && sim.phase === 'aiming') {
      const rp = worldToScreen(sim.rocket.x, sim.rocket.y, vpRef.current);
      const dx = sx - rp.x;
      const dy = sy - rp.y;
      if (Math.hypot(dx, dy) > 8) {
        const ang = Math.atan2(dy, dx);
        const worldDist = Math.hypot(worldPt.x - sim.rocket.x, worldPt.y - sim.rocket.y);
        const spd = Math.max(120, Math.min(mission.maxLaunchSpeed, worldDist * 2.1));
        sim.aimAngle = ang;
        sim.rocket.angle = ang;
        sim.launchSpeed = spd;
        setAimAngleDeg((ang * 180) / Math.PI);
        setLaunchSpeed(spd);
        recomputeGridAndPrediction();
        syncTelemetryImmediate();
      }
    }
  }, [applyCameraState, recomputeGridAndPrediction, syncTelemetryImmediate]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (simRef.current.dragMode !== 'none') {
      simRef.current.dragMode = 'none';
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  }, []);

  const currentMission = MISSIONS[missionIndex];

  return (
    <main className="relative w-full h-full overflow-hidden bg-[#070A10]">
      {/* Isolated Simulation Viewport Mount */}
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full"
        data-testid="simulation-viewport"
      >
        <canvas
          ref={webgpuCanvasRef}
          className={
            gpuActive === true
              ? 'absolute inset-0 w-full h-full block pointer-events-none'
              : 'hidden'
          }
          aria-hidden="true"
        />
        <canvas
          ref={bgCanvasRef}
          className={
            gpuActive === true
              ? 'hidden'
              : 'absolute inset-0 w-full h-full block pointer-events-none'
          }
          aria-hidden="true"
        />
        <canvas
          ref={vectorCanvasRef}
          data-testid="game-canvas"
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`absolute inset-0 w-full h-full block touch-none ${
            cameraTool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
          }`}
        />
      </div>

      {gameState === 'title' && (
        <TitleScreen
          missions={MISSIONS}
          selectedMissionIndex={missionIndex}
          onSelectMission={handleSelectMission}
          onStart={handleStartGame}
          gpuActive={gpuActive}
        />
      )}

      {gameState !== 'title' && (
        <GameHud
          missions={MISSIONS}
          missionIndex={missionIndex}
          onSelectMission={handleSelectMission}
          phase={phase}
          viewMode={viewMode}
          onChangeViewMode={handleChangeViewMode}
          physicsModelId={physicsModelId}
          onChangePhysicsModel={handleChangePhysicsModel}
          nBodyEnabled={nBodyEnabled}
          onToggleNBody={handleToggleNBody}
          aimAngleDeg={aimAngleDeg}
          onChangeAimAngleDeg={handleChangeAimAngleDeg}
          launchSpeed={launchSpeed}
          maxLaunchSpeed={currentMission.maxLaunchSpeed}
          onChangeLaunchSpeed={handleChangeLaunchSpeed}
          onLaunch={handleLaunchRocket}
          onReset={handleResetMission}
          onPause={handleTogglePause}
          muted={muted}
          onToggleMute={handleToggleMute}
          gpuActive={gpuActive}
          telemetry={telemetry}
          isSandbox={Boolean(currentMission.isSandbox)}
          onAddSandboxMass={handleAddSandboxMass}
          onClearSandboxMasses={handleClearSandboxMasses}
          minimapCanvasRef={minimapCanvasRef}
          universeWidth={UNIVERSE_CONFIG.universeWidth}
          universeHeight={UNIVERSE_CONFIG.universeHeight}
          zoom={zoom}
          cameraTool={cameraTool}
          followRocket={followRocket}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetCamera={handleResetCamera}
          onToggleCameraTool={handleToggleCameraTool}
          onToggleFollowRocket={handleToggleFollowRocket}
          onPanToWorld={handlePanToWorld}
        />
      )}

      <GameModals
        gameState={gameState}
        snapshot={snapshot}
        hasNextMission={missionIndex < MISSIONS.length - 1}
        onResume={handleTogglePause}
        onRestart={() => {
          handleResetMission();
          setGameStateSynced('playing');
        }}
        onNextMission={() => {
          loadMission(missionIndex + 1);
          setGameStateSynced('playing');
        }}
        onReturnTitle={() => {
          loadMission(missionIndex);
          setGameStateSynced('title');
        }}
      />
    </main>
  );
}
