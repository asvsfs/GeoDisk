/**
 * @fileoverview WGSL shaders: a compute pass that fills the 3D potential grid
 * and a full-screen pass that renders the warped spacetime lattice.
 */

export const GRAVITY_COMPUTE_WGSL = /* wgsl */ `
struct GridUniforms {
  cols: u32,
  rows: u32,
  layers: u32,
  massCount: u32,
  viewMode: u32,
  worldWidth: f32,
  worldHeight: f32,
  worldDepth: f32,
  speedOfLight: f32,
  time: f32,
  camX: f32,
  camY: f32,
  viewWorldW: f32,
  viewWorldH: f32,
  zoom: f32,
  pad0: f32,
};

struct MassGpu {
  posAndMu: vec4<f32>,   // x, y, z, mu
  props: vec4<f32>,       // softening, spin, radius, kind
};

@group(0) @binding(0) var<uniform> u: GridUniforms;
@group(0) @binding(1) var<storage, read> masses: array<MassGpu>;
@group(0) @binding(2) var<storage, read_write> grid: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let col = gid.x;
  let row = gid.y;
  let layer = gid.z;
  if (col >= u.cols || row >= u.rows || layer >= u.layers) {
    return;
  }

  let cellW = u.worldWidth / f32(max(1u, u.cols - 1u));
  let cellH = u.worldHeight / f32(max(1u, u.rows - 1u));
  let cellD = u.worldDepth / f32(max(1u, u.layers - 1u));
  let px = -0.5 * u.worldWidth + f32(col) * cellW;
  let py = -0.5 * u.worldHeight + f32(row) * cellH;
  let pz = select(0.0, -0.5 * u.worldDepth + f32(layer) * cellD, u.layers > 1u);

  let invC2 = 1.0 / (u.speedOfLight * u.speedOfLight);
  let ltCouple: f32 = 2.0;

  var sumPhi: f32 = 0.0;
  var sumGx: f32 = 0.0;
  var sumGy: f32 = 0.0;
  var sumGz: f32 = 0.0;
  var sumBx: f32 = 0.0;
  var sumBy: f32 = 0.0;
  var sumBz: f32 = 0.0;

  for (var i: u32 = 0u; i < u.massCount; i = i + 1u) {
    let m = masses[i];
    let dx = px - m.posAndMu.x;
    let dy = py - m.posAndMu.y;
    let dz = pz - m.posAndMu.z;
    let mu = m.posAndMu.w;
    let eps = m.props.x;
    let eps2 = eps * eps;
    let r2 = dx * dx + dy * dy + dz * dz + eps2;
    let r = sqrt(r2);
    let invR = 1.0 / r;
    let invR2 = 1.0 / r2;
    let invR3 = invR * invR2;
    let gFac = mu * invR3;

    sumPhi = sumPhi - mu * invR;
    sumGx = sumGx - dx * gFac;
    sumGy = sumGy - dy * gFac;
    sumGz = sumGz - dz * gFac;

    let sf = m.props.y * invC2 * ltCouple;
    let invR5 = invR3 * invR2;
    sumBx = sumBx + sf * (-3.0 * dz * dx) * invR5;
    sumBy = sumBy + sf * (-3.0 * dz * dy) * invR5;
    sumBz = sumBz + sf * (r2 - 3.0 * dz * dz) * invR5;
  }

  let cellIdx = (layer * (u.cols * u.rows) + row * u.cols + col) * 2u;
  grid[cellIdx] = vec4<f32>(sumPhi, sumGx, sumGy, sumGz);
  grid[cellIdx + 1u] = vec4<f32>(sumBx, sumBy, sumBz, 0.0);
}
`;

export const SPACETIME_RENDER_WGSL = /* wgsl */ `
struct GridUniforms {
  cols: u32,
  rows: u32,
  layers: u32,
  massCount: u32,
  viewMode: u32,
  worldWidth: f32,
  worldHeight: f32,
  worldDepth: f32,
  speedOfLight: f32,
  time: f32,
  camX: f32,
  camY: f32,
  viewWorldW: f32,
  viewWorldH: f32,
  zoom: f32,
  pad0: f32,
};

struct MassGpu {
  posAndMu: vec4<f32>,
  props: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: GridUniforms;
@group(0) @binding(1) var<storage, read> grid: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> masses: array<MassGpu>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  let p = positions[vid];
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

struct FieldPair {
  primary: vec4<f32>,   // phi, gx, gy, gz
  mag: vec4<f32>,       // bx, by, bz, 0
};

fn sampleShadowPlane(wx: f32, wy: f32) -> FieldPair {
  let halfW = 0.5 * u.worldWidth;
  let halfH = 0.5 * u.worldHeight;

  if (abs(wx) > halfW || abs(wy) > halfH) {
    let invC2 = 1.0 / (u.speedOfLight * u.speedOfLight);
    let ltCouple: f32 = 2.0;
    var sumPhi: f32 = 0.0;
    var sumGx: f32 = 0.0;
    var sumGy: f32 = 0.0;
    var sumGz: f32 = 0.0;
    var sumBz: f32 = 0.0;

    for (var i: u32 = 0u; i < u.massCount; i = i + 1u) {
      let m = masses[i];
      let dx = wx - m.posAndMu.x;
      let dy = wy - m.posAndMu.y;
      let dz = -m.posAndMu.z;
      let mu = m.posAndMu.w;
      let eps = m.props.x;
      let eps2 = eps * eps;
      let r2 = dx * dx + dy * dy + dz * dz + eps2;
      let r = sqrt(r2);
      let invR = 1.0 / r;
      let invR2 = 1.0 / r2;
      let invR3 = invR * invR2;
      let gFac = mu * invR3;

      sumPhi = sumPhi - mu * invR;
      sumGx = sumGx - dx * gFac;
      sumGy = sumGy - dy * gFac;
      sumGz = sumGz - dz * gFac;
      sumBz = sumBz + (m.props.y * invC2 * ltCouple) * (r2 - 3.0 * dz * dz) * (invR3 * invR2);
    }
    var res: FieldPair;
    res.primary = vec4<f32>(sumPhi, sumGx, sumGy, sumGz);
    res.mag = vec4<f32>(0.0, 0.0, sumBz, 0.0);
    return res;
  }

  let cellW = u.worldWidth / f32(max(1u, u.cols - 1u));
  let cellH = u.worldHeight / f32(max(1u, u.rows - 1u));

  let fu = clamp((wx + halfW) / cellW, 0.0, f32(u.cols) - 1.001);
  let fv = clamp((wy + halfH) / cellH, 0.0, f32(u.rows) - 1.001);
  let midLayer = (u.layers - 1u) / 2u;

  let c0 = u32(floor(fu));
  let r0 = u32(floor(fv));
  let c1 = min(u.cols - 1u, c0 + 1u);
  let r1 = min(u.rows - 1u, r0 + 1u);

  let tx = fu - f32(c0);
  let ty = fv - f32(r0);

  let sliceBase = midLayer * (u.cols * u.rows);
  let idx00 = (sliceBase + r0 * u.cols + c0) * 2u;
  let idx10 = (sliceBase + r0 * u.cols + c1) * 2u;
  let idx01 = (sliceBase + r1 * u.cols + c0) * 2u;
  let idx11 = (sliceBase + r1 * u.cols + c1) * 2u;

  let pTop = mix(grid[idx00], grid[idx10], tx);
  let pBot = mix(grid[idx01], grid[idx11], tx);
  let mTop = mix(grid[idx00 + 1u], grid[idx10 + 1u], tx);
  let mBot = mix(grid[idx01 + 1u], grid[idx11 + 1u], tx);

  var out: FieldPair;
  out.primary = mix(pTop, pBot, ty);
  out.mag = mix(mTop, mBot, ty);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let wx = u.camX + (in.uv.x - 0.5) * u.viewWorldW;
  let wy = u.camY + (in.uv.y - 0.5) * u.viewWorldH;

  let fp = sampleShadowPlane(wx, wy);
  let phi = fp.primary.x;
  let g = fp.primary.yz;
  let bz = fp.mag.z;

  let c2 = u.speedOfLight * u.speedOfLight;
  let lapseSq = clamp(1.0 + 2.0 * phi / c2, 0.04, 1.0);
  let lapse = sqrt(lapseSq);
  let dilation = 1.0 - lapse;
  let gMag = length(g);

  var col = vec3<f32>(0.027, 0.039, 0.063);

  let fieldGlow = clamp(gMag / 750.0, 0.0, 1.0);
  let deepWell = smoothstep(0.08, 0.65, dilation);
  col = col + vec3<f32>(0.02, 0.11, 0.16) * pow(fieldGlow, 1.15);
  col = col + vec3<f32>(0.36, 0.14, 0.03) * pow(deepWell, 1.35);

  let spinGlow = clamp(abs(bz) * 0.45, 0.0, 1.0);
  col = col + vec3<f32>(0.04, 0.14, 0.22) * spinGlow;

  if (u.viewMode == 0u || u.viewMode == 2u) {
    let warpScale = 0.095;
    let maxWarp = 62.0;
    let rawDisp = gMag * warpScale;
    let cappedScale = select(0.0, (rawDisp / (1.0 + rawDisp / maxWarp)) / max(gMag, 1e-4), rawDisp > 1e-4);
    let warpedX = wx + g.x * cappedScale;
    let warpedY = wy + g.y * cappedScale;
    let spacing = select(50.0, 100.0, u.zoom < 0.55);

    let gx = abs(fract(warpedX / spacing + 0.5) - 0.5) * spacing;
    let gy = abs(fract(warpedY / spacing + 0.5) - 0.5) * spacing;
    let lineDist = min(gx, gy);
    let aa = max(fwidth(lineDist), 1.0);
    let lineMask = 1.0 - smoothstep(0.5, 0.5 + aa * 1.1, lineDist);

    let lineColor = mix(
      vec3<f32>(0.11, 0.17, 0.26),
      vec3<f32>(0.13, 0.72, 0.86),
      clamp(fieldGlow * 1.1, 0.0, 0.85)
    );
    let finalLine = mix(lineColor, vec3<f32>(0.96, 0.62, 0.04), deepWell * 0.65);
    let alpha = select(0.22, 0.44, u.viewMode == 0u);
    col = mix(col, finalLine, lineMask * alpha);
  }

  let contourStep = 26000.0;
  let cVal = phi / contourStep;
  let cDist = abs(fract(cVal) - 0.5);
  let cWidth = max(fwidth(cVal), 0.025);
  let contourMask = 1.0 - smoothstep(0.02, 0.02 + cWidth * 1.3, cDist);
  let contourStrength = select(0.14, 0.65, u.viewMode == 1u);
  let contourCol = mix(vec3<f32>(0.13, 0.83, 0.93), vec3<f32>(0.96, 0.62, 0.04), deepWell);
  col = mix(col, contourCol, contourMask * contourStrength);

  return vec4<f32>(col, 1.0);
}
`;
