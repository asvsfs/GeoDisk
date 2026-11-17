# GeoDisk

A shared, multiplayer relativistic gravity sandbox. Anyone can join the
universe, launch satellites from a home planet, and place their own planets,
stars, white dwarfs, neutron stars or black holes with the mass and radius
they choose. Nothing is spawned or deleted automatically. Bodies only merge,
shatter, collapse or explode into pieces, following physical rules, and mass
is conserved exactly.

## Run it

```bash
npm install
npm run dev       # client on http://localhost:3000 (Vite)
npm run server    # game server: WebTransport udp/4433, HTTP tcp/8080
```

Open http://localhost:3000 in a WebTransport-capable browser (recent Chrome,
Edge or Firefox), pick a name and press **Join universe**. Open a second tab
to play against yourself. **Offline** runs the same room inside the page with
no network.

Production: `npm run build && npm start`, then open http://localhost:8080.

```bash
npm test          # sim, protocol, room and a real WebTransport round-trip
npm run calibrate # measure this host and print limits that fit it
npm run lint      # tsc --noEmit
npm run format    # Prettier with Google (gts) settings
```

### Controls

| Input | Action |
| --- | --- |
| `1` + drag | Aim from your home planet; release to launch a satellite |
| `W`/`S`, `A`/`D`, `Space` | Change speed, turn, launch |
| `2`–`7` | Asteroid, planet, star, white dwarf, neutron star, black hole |
| Body panel | Set mass (log scale), radius and spin; the panel shows the class it will be |
| Click / drag on the map | Place the body; drag to fling it |
| Hover a body | Its class, mass, radius, spin, speed tags and remaining fuel |
| Double-click a planet | Make it your home |
| Right-drag, arrows, wheel, minimap | Pan and zoom |
| `F` `V` `M` | Follow home, cycle field view, mute |

### Server environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `WT_PORT` / `HTTP_PORT` / `HOST` | 4433 / 8080 / `::` | Listen addresses (`::` is dual-stack) |
| `PUBLIC_HOSTS` | `localhost,127.0.0.1` | Names on the self-signed certificate |
| `CERT_FILE`, `KEY_FILE` | unset | CA-issued PEM; turns off hash pinning |
| `MAX_BODIES`, `MAX_SATS`, `MAX_SATS_PER_PLAYER`, `MAX_PLAYERS` | 96, 384, 24, 16 | Hard caps (explicit values always win) |
| `AUTO_LIMITS=1` | off | Benchmark this host at startup (about 0.3 s) and derive the caps |
| `CPU_SHARE` | 0.5 | Share of one core the room may keep busy (physics + network) |
| `MAX_UPLOAD_MBPS` | 0 (unlimited) | Upstream budget; also bounds caps and players at startup |
| `SNAP_HZ`, `MIN_SNAP_HZ` | 30, 15 | Highest and lowest snapshot rate |
| `SEED`, `CLIENT_DIR` | random, `./dist` | World seed, built client folder |

### Sizing a server

1. Run `npm run calibrate` on the target machine (add `CPU_SHARE` and
   `MAX_UPLOAD_MBPS` to match your plan). It times the real step pipeline on
   growing worlds and prints the largest one that fits 70% of the CPU budget
   (the rest is reserved for networking and GC), the bandwidth per player at
   those caps, and a ready-to-use command line.
2. Or start with `AUTO_LIMITS=1` and the server does the same at startup.
3. With an upload budget, players come first: the world is shrunk until
   `MAX_PLAYERS` fit at full caps, down to 32 bodies; only then is the player
   cap lowered. Calibration never recommends more than 256 bodies, the most
   the WebGPU field renderer holds.
4. Watch `GET /stats` while it runs: players, bodies, effective and
   configured caps, current snapshot rate, CPU share, physics ms per step,
   upload Mbit/s, and how far the caps have been scaled back.

One room uses one core (Node is single-threaded). For more players, run more
server processes rather than raising the caps.

Without `CERT_FILE`, the server mints an ECDSA certificate valid for 10 days
at each start. Browsers accept it because the page pins its SHA-256 hash.
Restart the server within 10 days, or use a real certificate.

## Architecture

```
src/
  shared/            runs in the browser and in Node, no DOM or Node APIs
    config.ts        every tunable limit and constant
    types.ts         Body, Sat, Player, WorldEvent
    sim/             the physics, as a pipeline of Systems
    net/             transport interfaces, codec, protocol, WebTransport link
    game/            Room (authoritative loop) and rules (launch, spawn, homes)
  server/            Node entry point, WebTransport host, certificates
  client/            React UI, renderers, client session, connectors
```

### Simulation (`shared/sim`)

`World` holds bodies, satellites and events. Each fixed step (60 Hz) it runs
an ordered list of `System`s (`sim/pipeline.ts`). To change a rule, swap,
add or reorder a system there:

1. **BodyMotion**: mutual N-body gravity with velocity Verlet. Builds the
   gravity field and the spatial hash once per step.
2. **SatMotion**: moves satellites through that field with a pluggable
   `SatModel` (Schwarzschild geodesic in proper time by default: full Newtonian
   gravity plus a per-body strong-field term near black holes, neutron stars and
   white dwarfs, so orbits precess and close passes plunge in; Newtonian available).
   A satellite that hits a body is absorbed by it.
3. **Collisions**: spatial-hash broad phase, then merge or shatter. The
   outcome depends on impact speed relative to mutual escape speed (see
   below).
4. **StellarEvolution**: stars burn fuel and die according to their mass.
5. **Walls**: the universe is closed. Bodies and satellites bounce off its
   edges (losing a little energy, never mass).

Nothing in the pipeline creates or deletes mass. The universe is seeded once
(`sim/scenario.ts`): a loose cluster around a spinning intermediate-mass
black hole, with a red dwarf, yellow dwarf, blue giant and supergiant,
rocky and gas-giant planets, a white dwarf and a pulsar. After that, only
players add bodies.

**Classes** (`sim/classes.ts`) are derived from kind, mass, radius, spin and
speed, never sent on the wire, so server and clients always agree:

| Kind | Classes |
| --- | --- |
| asteroid / planet | asteroid; rocky planet or gas giant by density (mass / r³); brown dwarf near the fusion limit |
| star | red dwarf, yellow dwarf, blue giant, supergiant by mass |
| white dwarf | white dwarf (shrinks as it gains mass) |
| neutron star | pulsar while spinning faster than `pulsarSpin` of breakup, else neutron star |
| black hole | stellar, intermediate, supermassive by mass; Kerr spin a* shown |

Tags add motion: *runaway* above `runawaySpeed`, *rapid rotator* above half
of breakup spin.

**Collisions and spin.** Mergers conserve mass, momentum and angular
momentum: the pair's orbital angular momentum becomes spin, so a grazing
impact spins the product up. Ordinary matter conserves volume (density is
kept, and fragments inherit it). Stars engulf lighter dead stars; a heavier
dead star accretes its partner; anything that touches a black hole joins it.
Planets merge when slow and shatter when fast, throwing fragments out in
momentum-neutral pairs. A body spun past `fissionSpin` × breakup flings off
equatorial fragments, and black-hole spin is capped at the Kerr limit.
Frame dragging uses the physical coupling B = 2J/c² (dipole), so a
fast-spinning black hole visibly twists nearby satellite paths.

**Stellar lives and deaths** (thresholds in `PhysicsConfig`, named after
the astrophysical limits whose order they keep):

- Fuel lasts about M^-2.5, so supergiants burn out in about a minute and red
  dwarfs last the longest.
- Light stars shed a planetary nebula and leave a white dwarf.
- Heavy stars go core-collapse supernova. The core becomes a neutron star
  (a pulsar if the star was spinning, since angular momentum is conserved)
  or, past the TOV limit, a black hole. The envelope flies out as debris, a
  shockwave pushes everything nearby, and the remnant gets a
  momentum-balanced natal kick.
- White dwarfs pushed past the Chandrasekhar limit explode completely
  (type Ia).
- Neutron stars merging throw out a kilonova; past TOV the product
  collapses into a black hole.
- Pulsars spin down over time.
- Debris can clump and ignite into new stars.

Gravity uses `FieldSolver`. `AutoSolver` picks exact direct summation for
small worlds and a Barnes-Hut octree (Salmon-Warren opening criterion, flat
typed arrays) above `treeThreshold` bodies.

**Compute limits.** `maxBodies`, `maxSats` and `maxSatsPerPlayer` bound the
work per step. Launching past your own cap recycles your oldest satellite.
`Budget` (`sim/budget.ts`) measures what each pump of the room loop costs
(physics, plus encoding and sending) and the bytes it sends. When the
smoothed CPU share or upload goes over its limit, it first lowers the
snapshot rate (30, 20, 15 per second, down to `MIN_SNAP_HZ`), then shrinks
the effective caps (to at least 25%). It recovers in reverse once load falls
below 60% of the limit. Clients measure the actual snapshot interval, so
their render delay follows the rate. Lowered caps only stop new entities;
nothing alive is removed, so a badly undersized server stays over budget,
and that is what the startup sizing is for. Fragments and ejecta only use
free slots. Without room, a
shatter becomes a merge and unplaced ejecta falls back onto the remnant, so
mass is never lost to the cap.

### Networking (`shared/net`)

Game code depends only on three interfaces in `transport.ts`:

```ts
interface Link      { send(data, delivery); listen(handler); close(); }
interface Host      { start(onLink); stop(); }      // server side
interface Connector { connect(): Promise<Link>; }   // client side
```

`Delivery.RELIABLE` is for control traffic and events; `Delivery.LATEST`
is for snapshots, which the next one supersedes. Current implementations:

- **WebTransport** (`wt_link.ts`, `server/wt_host.ts`,
  `client/net/wt_connector.ts`). RELIABLE uses one framed bidirectional
  stream. LATEST uses a datagram when it fits, otherwise a unidirectional
  stream per message, with an in-flight cap so stale snapshots are dropped
  instead of queued. The same `WtLink` serves browser and server.
- **In-memory** (`mem_transport.ts`), used for tests and offline play.

To add a transport (WebSocket fallback, WebRTC, a future WebTransport API),
implement those three interfaces. The room, protocol and client stay
unchanged.

The protocol (`protocol.ts`) is binary and append-only. Each message starts
with a type byte. Newer peers may add trailing fields, and breaking changes
bump `PROTOCOL_VERSION`, which the server checks at HELLO. The welcome
message carries the server's whole `GameConfig`, so clients never hard-code
limits. Snapshots carry only primary state; radius and softening are derived
from kind and mass on both sides.

All game traffic goes over WebTransport. The one plain HTTP request is
`GET /wt-info` at page load, which tells the page the WebTransport port and
the certificate hash to pin.

### Server authority and the client

`Room` runs the world, validates every request against the limits, rate-limits
each link, and broadcasts snapshots at `snapHz` (30) per second. Snapshots
are scheduled by step count (every 2 steps), not by accumulated float time,
which would sometimes add a step and drop the rate.

The client (`GameClient`) interpolates by entity id, rendering just far
enough behind the newest snapshot to always have the next one: one snapshot
interval plus the recent worst arrival lateness (eased, between 1.1 and 3
intervals; about 40 ms on a steady link). On loopback, launch-to-visible
averages about 30 ms; on the internet, add the round trip.

The aiming preview runs the same `BodyMotion` and `SatMotion` systems
(`sim/predict.ts`) in a Web Worker (`client/sim/predictor.ts`), so it never
stalls rendering even at the body cap. It starts from the newest snapshot
advanced to when the server will apply a launch sent now
(`GameClient.requestTime()`: freshest server time plus one round trip), so
the satellite leaves where the line shows. Rendering uses WebGPU (compute pass for the potential grid,
full-screen lattice pass) and falls back to Canvas 2D when WebGPU is missing
or its pipelines fail validation.

## Code style

Google TypeScript style: snake_case file names, named exports only, `private`
over `#`, no `public` modifiers, JSDoc on exported symbols, and Prettier with
the `gts` settings in `.prettierrc.json`.
