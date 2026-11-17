/**
 * WGSL Compute & Render Shaders for the 2+1D Uniform Gravity Grid
 */

export const GRAVITY_COMPUTE_WGSL = /* wgsl */ `
struct GridUniforms {
  cols: u32,
  rows: u32,
  massCount: u32,
  viewMode: u32,
  worldWidth: f32,
  worldHeight: f32,
  refRadius: f32,
  speedOfLight: f32,
  time: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

struct MassGpu {
  posAndMu: vec4<f32>,   // x, y, mu, softening
  meta: vec4<f32>,       // spin, radius, kind, pad
};

@group(0) @binding(0) var<uniform> u: GridUniforms;
@group(0) @binding(1) var<storage, read> masses: array<MassGpu>;
@group(0) @binding(2) var<storage, read_write> grid: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let col = gid.x;
  let row = gid.y;
  if (col >= u.cols || row >= u.rows) {
    return;
  }

  let cellW = u.worldWidth / f32(u.cols - 1u);
  let cellH = u.worldHeight / f32(u.rows - 1u);
  let px = -0.5 * u.worldWidth + f32(col) * cellW;
  let py = -0.5 * u.worldHeight + f32(row) * cellH;

  let ref2Base = u.refRadius * u.refRadius;
  let invC2 = 1.0 / (u.speedOfLight * u.speedOfLight);

  var sumPhi: f32 = 0.0;
  var sumGx: f32 = 0.0;
  var sumGy: f32 = 0.0;
  var sumBz: f32 = 0.0;

  for (var i: u32 = 0u; i < u.massCount; i = i + 1u) {
    let m = masses[i];
    let dx = px - m.posAndMu.x;
    let dy = py - m.posAndMu.y;
    let mu = m.posAndMu.z;
    let eps = m.posAndMu.w;
    let eps2 = eps * eps;
    let r2 = dx * dx + dy * dy + eps2;
    let invR2 = 1.0 / r2;

    sumPhi = sumPhi + 0.5 * mu * log(r2 / (ref2Base + eps2));
    sumGx = sumGx - mu * dx * invR2;
    sumGy = sumGy - mu * dy * invR2;
    sumBz = sumBz + (m.meta.x * invC2 * 2500.0) * invR2;
  }

  let idx = row * u.cols + col;
  grid[idx] = vec4<f32>(sumPhi, sumGx, sumGy, sumBz);
}
`;

export const SPACETIME_RENDER_WGSL = /* wgsl */ `
struct GridUniforms {
  cols: u32,
  rows: u32,
  massCount: u32,
  viewMode: u32,
  worldWidth: f32,
  worldHeight: f32,
  refRadius: f32,
  speedOfLight: f32,
  time: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> u: GridUniforms;
@group(0) @binding(1) var<storage, read> grid: array<vec4<f32>>;

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
  // Flip Y so uv.y = 0 is top (-halfH) and uv.y = 1 is bottom (+halfH)
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

fn sampleGrid(wx: f32, wy: f32) -> vec4<f32> {
  let halfW = 0.5 * u.worldWidth;
  let halfH = 0.5 * u.worldHeight;
  let cellW = u.worldWidth / f32(u.cols - 1u);
  let cellH = u.worldHeight / f32(u.rows - 1u);

  let fu = clamp((wx + halfW) / cellW, 0.0, f32(u.cols) - 1.001);
  let fv = clamp((wy + halfH) / cellH, 0.0, f32(u.rows) - 1.001);

  let c0 = u32(floor(fu));
  let r0 = u32(floor(fv));
  let c1 = min(u.cols - 1u, c0 + 1u);
  let r1 = min(u.rows - 1u, r0 + 1u);

  let tx = fu - f32(c0);
  let ty = fv - f32(r0);

  let v00 = grid[r0 * u.cols + c0];
  let v10 = grid[r0 * u.cols + c1];
  let v01 = grid[r1 * u.cols + c0];
  let v11 = grid[r1 * u.cols + c1];

  let top = mix(v00, v10, tx);
  let bot = mix(v01, v11, tx);
  return mix(top, bot, ty);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let wx = (in.uv.x - 0.5) * u.worldWidth;
  let wy = (in.uv.y - 0.5) * u.worldHeight;

  let field = sampleGrid(wx, wy);
  let phi = field.x;
  let g = field.yz;
  let bz = field.w;

  let c2 = u.speedOfLight * u.speedOfLight;
  let lapseSq = clamp(1.0 + 2.0 * phi / c2, 0.04, 1.0);
  let lapse = sqrt(lapseSq);
  let dilation = 1.0 - lapse;
  let gMag = length(g);

  // Base deep space obsidian
  var col = vec3<f32>(0.027, 0.039, 0.063);

  // Subtle gravitational curvature glow (cyan for mild curvature, amber for strong time dilation)
  let fieldGlow = clamp(gMag / 750.0, 0.0, 1.0);
  let deepWell = smoothstep(0.08, 0.65, dilation);
  col = col + vec3<f32>(0.02, 0.11, 0.16) * pow(fieldGlow, 1.15);
  col = col + vec3<f32>(0.36, 0.14, 0.03) * pow(deepWell, 1.35);

  // Gravitomagnetic spin curl tint
  let spinGlow = clamp(abs(bz) * 0.45, 0.0, 1.0);
  col = col + vec3<f32>(0.04, 0.14, 0.22) * spinGlow;

  // Warped 2+1D spacetime coordinate lattice
  if (u.viewMode == 0u || u.viewMode == 2u) {
    let warpScale = 0.095;
    let warpedX = wx + g.x * warpScale;
    let warpedY = wy + g.y * warpScale;
    let spacing = 50.0;

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

  // Equipotential contours (always subtle, crisp in contours mode)
  let contourStep = 32000.0;
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
