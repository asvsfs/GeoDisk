import type {
  MassBody,
  MissionConfig,
  RocketConfig,
  RocketState,
  WaypointBeacon,
} from '../physics/types';

/**
 * Generates a deterministic cluster of masses for the many-body uniform-grid showcase.
 */
export function generateDeterministicCluster(
  count: number,
  seed = 42,
  centerX = 0,
  centerY = 0,
  spreadX = 360,
  spreadY = 260
): MassBody[] {
  const bodies: MassBody[] = [];
  let s = seed >>> 0;
  const nextRand = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };

  for (let i = 0; i < count; i++) {
    // Keep a navigable channel near y = -160..160 or spread cleanly around ring
    const angle = (i / count) * Math.PI * 2 + (nextRand() - 0.5) * 0.45;
    const radial = 0.25 + 0.75 * Math.sqrt(nextRand());
    const x = centerX + Math.cos(angle) * spreadX * radial;
    const y = centerY + Math.sin(angle) * spreadY * radial;

    // Avoid spawning right on the launch pad (-620, 0) or target (620, 0)
    if (Math.hypot(x + 620, y) < 140 || Math.hypot(x - 620, y) < 140) {
      continue;
    }

    const mu = 4200 + nextRand() * 9800;
    const radius = 10 + Math.sqrt(mu / 1200) * 3.5;
    const dx = x - centerX;
    const dy = y - centerY;
    const dist = Math.max(40, Math.hypot(dx, dy));
    // Tangential orbital speed scaled for stable swirling cluster under 2D mutual gravity
    const orbitalSpeed = 95 + 55 * (dist / Math.max(spreadX, spreadY));
    const vx = Math.round((-dy / dist) * orbitalSpeed);
    const vy = Math.round((dx / dist) * orbitalSpeed);

    bodies.push({
      id: `cluster-${seed}-${i}`,
      x: Math.round(x),
      y: Math.round(y),
      vx,
      vy,
      mu: Math.round(mu),
      softening: radius + 12,
      radius,
      spin: (nextRand() - 0.5) * 1800,
      kind: mu > 11000 ? 'compact' : 'asteroid',
    });
  }
  return bodies;
}

export const MISSIONS: MissionConfig[] = [
  {
    id: 'single-well',
    index: 1,
    title: '01 · Single Well Slingshot',
    subtitle: 'Curve around a 2+1D logarithmic star well and capture the beacon.',
    nBodyDefault: false,
    speedOfLight: 900,
    launchPos: { x: -560, y: 120 },
    defaultAimAngle: -0.52,
    defaultLaunchSpeed: 315,
    maxLaunchSpeed: 540,
    rocketFuel: 100,
    target: { x: 540, y: -90, radius: 46, maxCaptureSpeed: 0 },
    waypoints: [
      { id: 'wp-1', x: -140, y: -155, radius: 26 },
      { id: 'wp-2', x: 220, y: -165, radius: 26 },
    ],
    masses: [
      {
        id: 'star-alpha',
        label: 'Helios Core',
        x: 0,
        y: 10,
        vx: 0,
        vy: 0,
        mu: 64000,
        softening: 46,
        radius: 38,
        spin: 0,
        kind: 'star',
      },
    ],
  },
  {
    id: 'binary-perihelion',
    index: 2,
    title: '02 · Binary Saddle Corridor',
    subtitle: 'Twin stars mutually orbiting under 2+1D gravity; thread the shifting saddle.',
    nBodyDefault: true,
    speedOfLight: 860,
    launchPos: { x: -600, y: 0 },
    defaultAimAngle: -0.18,
    defaultLaunchSpeed: 330,
    maxLaunchSpeed: 560,
    rocketFuel: 100,
    target: { x: 580, y: 20, radius: 44, maxCaptureSpeed: 0 },
    waypoints: [
      { id: 'wp-1', x: -160, y: -25, radius: 24 },
      { id: 'wp-2', x: 220, y: 35, radius: 24 },
    ],
    masses: [
      {
        id: 'bin-a',
        label: 'Castor A',
        x: 0,
        y: -155,
        vx: 150,
        vy: 0,
        mu: 46000,
        softening: 38,
        radius: 30,
        spin: 0,
        kind: 'star',
        orbit: {
          centerX: 0,
          centerY: 0,
          orbitRadius: 155,
          angularSpeed: 0.28,
          phase: -Math.PI * 0.5,
        },
      },
      {
        id: 'bin-b',
        label: 'Castor B',
        x: 0,
        y: 155,
        vx: -150,
        vy: 0,
        mu: 46000,
        softening: 38,
        radius: 30,
        spin: 0,
        kind: 'compact',
        orbit: {
          centerX: 0,
          centerY: 0,
          orbitRadius: 155,
          angularSpeed: 0.28,
          phase: Math.PI * 0.5,
        },
      },
    ],
  },
  {
    id: 'kerr-spin',
    index: 3,
    title: '03 · Frame-Dragging Vortex',
    subtitle: 'Ride gravitomagnetic swirl around a rapidly spinning 2+1D compact remnant.',
    nBodyDefault: false,
    speedOfLight: 780,
    launchPos: { x: -570, y: -180 },
    defaultAimAngle: 0.25,
    defaultLaunchSpeed: 325,
    maxLaunchSpeed: 550,
    rocketFuel: 110,
    target: { x: 540, y: 170, radius: 44, maxCaptureSpeed: 0 },
    waypoints: [
      { id: 'wp-1', x: -60, y: -155, radius: 24 },
      { id: 'wp-2', x: 140, y: 130, radius: 24 },
    ],
    masses: [
      {
        id: 'kerr-core',
        label: 'Spinning Remnant',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        mu: 78000,
        softening: 42,
        radius: 34,
        spin: 18500,
        kind: 'singularity',
      },
      {
        id: 'shepherd-moon',
        label: 'Outer Dwarf',
        x: 290,
        y: -210,
        vx: 115,
        vy: 158,
        mu: 22000,
        softening: 30,
        radius: 22,
        spin: 0,
        kind: 'compact',
      },
    ],
  },
  {
    id: 'dense-cluster',
    index: 4,
    title: '04 · 32-Mass Gravitational Belt',
    subtitle: 'Navigate a dynamic 32-body N-body cluster summed on the uniform grid.',
    nBodyDefault: true,
    speedOfLight: 850,
    launchPos: { x: -620, y: 180 },
    defaultAimAngle: -0.34,
    defaultLaunchSpeed: 350,
    maxLaunchSpeed: 580,
    rocketFuel: 120,
    target: { x: 600, y: -140, radius: 46, maxCaptureSpeed: 0 },
    waypoints: [
      { id: 'wp-1', x: -180, y: 40, radius: 24 },
      { id: 'wp-2', x: 190, y: -40, radius: 24 },
    ],
    masses: generateDeterministicCluster(32, 7711, 0, 0, 390, 290),
  },
  {
    id: 'horizon-needle',
    index: 5,
    title: '05 · Event Horizon Needle',
    subtitle: 'Thread twin singularities where gravitational time dilation slows proper time.',
    speedOfLight: 660,
    launchPos: { x: -610, y: 0 },
    defaultAimAngle: -0.06,
    defaultLaunchSpeed: 340,
    maxLaunchSpeed: 560,
    rocketFuel: 100,
    target: { x: 600, y: 0, radius: 42, maxCaptureSpeed: 0 },
    waypoints: [
      { id: 'wp-1', x: -180, y: -10, radius: 22 },
      { id: 'wp-2', x: 0, y: 0, radius: 22 },
      { id: 'wp-3', x: 220, y: 10, radius: 22 },
    ],
    masses: [
      {
        id: 'bh-north',
        label: 'Singularity N',
        x: 0,
        y: -148,
        mu: 76000,
        softening: 32,
        radius: 30,
        spin: 12000,
        kind: 'singularity',
      },
      {
        id: 'bh-south',
        label: 'Singularity S',
        x: 0,
        y: 148,
        mu: 76000,
        softening: 32,
        radius: 30,
        spin: -12000,
        kind: 'singularity',
      },
    ],
  },
  {
    id: 'sandbox',
    index: 6,
    title: '06 · Spacetime Sandbox Lab',
    subtitle: 'Place moving stars, singularities, or 16-mass clusters that attract and merge.',
    isSandbox: true,
    nBodyDefault: true,
    speedOfLight: 820,
    launchPos: { x: -580, y: 0 },
    defaultAimAngle: -0.25,
    defaultLaunchSpeed: 320,
    maxLaunchSpeed: 620,
    rocketFuel: 160,
    target: { x: 580, y: 0, radius: 48, maxCaptureSpeed: 0 },
    waypoints: [],
    masses: [
      {
        id: 'sandbox-star-1',
        label: 'Central Star',
        x: -110,
        y: 110,
        vx: 110,
        vy: 85,
        mu: 56000,
        softening: 42,
        radius: 34,
        spin: 0,
        kind: 'star',
      },
      {
        id: 'sandbox-bh-1',
        label: 'Compact Core',
        x: 130,
        y: -120,
        vx: -125,
        vy: -95,
        mu: 48000,
        softening: 34,
        radius: 26,
        spin: 10000,
        kind: 'singularity',
      },
    ],
  },
];

export interface FlightEvaluation {
  status: 'flying' | 'victory' | 'crashed';
  reason?: string;
  collectedWaypointIds: string[];
}

export function evaluateFlightState(
  rocket: RocketState,
  masses: readonly MassBody[],
  target: MissionConfig['target'],
  waypoints: readonly WaypointBeacon[],
  rocketConfig: RocketConfig,
  universeWidth = 4800,
  universeHeight = 3000,
  escapeFieldThreshold = 14,
  minEscapeRadius = 1250
): FlightEvaluation {
  const collectedWaypointIds: string[] = [];

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (!wp.collected) {
      const dist = Math.hypot(rocket.x - wp.x, rocket.y - wp.y);
      if (dist <= wp.radius + rocketConfig.hullRadius) {
        collectedWaypointIds.push(wp.id);
      }
    }
  }

  // Check mass / event horizon impact & compute barycenter + local gravitational pull
  let totalMu = 0;
  let baryX = 0;
  let baryY = 0;
  let gx = 0;
  let gy = 0;

  for (let i = 0; i < masses.length; i++) {
    const m = masses[i];
    const dx = rocket.x - m.x;
    const dy = rocket.y - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= m.radius + rocketConfig.hullRadius * 0.75) {
      const reason =
        m.kind === 'singularity'
          ? 'Crossed the event horizon and lost telemetry.'
          : `Impacted ${m.label ?? 'gravitational mass'}.`;
      return { status: 'crashed', reason, collectedWaypointIds };
    }

    totalMu += m.mu;
    baryX += m.x * m.mu;
    baryY += m.y * m.mu;
    const eps2 = m.softening * m.softening;
    const r2 = dx * dx + dy * dy + eps2;
    gx -= (m.mu * dx) / r2;
    gy -= (m.mu * dy) / r2;
  }

  // Check target orbital beacon capture
  const targetDist = Math.hypot(rocket.x - target.x, rocket.y - target.y);
  if (targetDist <= target.radius + rocketConfig.hullRadius * 0.5) {
    const speed = Math.hypot(rocket.vx, rocket.vy);
    if (target.maxCaptureSpeed <= 0 || speed <= target.maxCaptureSpeed) {
      return {
        status: 'victory',
        reason: 'Captured target beacon along relativistic geodesic.',
        collectedWaypointIds,
      };
    }
  }

  // Offscreen movement is allowed; destroy object only when escaping the gravitational field
  const univHalfW = universeWidth * 0.5;
  const univHalfH = universeHeight * 0.5;
  if (Math.abs(rocket.x) > univHalfW || Math.abs(rocket.y) > univHalfH) {
    return {
      status: 'crashed',
      reason: 'Escaped the gravitational field and exited the simulated universe.',
      collectedWaypointIds,
    };
  }

  if (totalMu > 0) {
    baryX /= totalMu;
    baryY /= totalMu;
  }
  const relX = rocket.x - baryX;
  const relY = rocket.y - baryY;
  const distFromBary = Math.hypot(relX, relY);
  const outwardDot = relX * rocket.vx + relY * rocket.vy;
  const fieldMag = Math.hypot(gx, gy);

  if (distFromBary > minEscapeRadius && outwardDot > 0 && fieldMag < escapeFieldThreshold) {
    return {
      status: 'crashed',
      reason: 'Escaped the gravitational field beyond orbital capture.',
      collectedWaypointIds,
    };
  }

  return { status: 'flying', collectedWaypointIds };
}
