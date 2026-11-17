/**
 * @fileoverview Camera and world/screen transforms.
 */

/** How the spacetime field is visualised. */
export type ViewMode = 'spacetime' | 'contours' | 'vectors';

/** Zoom bounds. */
export const ZOOM = {min: 0.12, max: 3, initial: 0.55} as const;

/** World units that fit the shorter screen side at zoom 1. */
export const BASE_SPAN = 1000;

/** Camera position and zoom. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Resolved mapping from world to CSS pixels. */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  cam: Camera;
}

/** Builds the viewport for a camera on a canvas of `width` x `height` CSS px. */
export function viewport(cam: Camera, width: number, height: number): Viewport {
  const scale = (Math.min(width, height) / BASE_SPAN) * cam.zoom;
  return {
    scale,
    offsetX: width / 2 - cam.x * scale,
    offsetY: height / 2 - cam.y * scale,
    width,
    height,
    cam,
  };
}

/** Clamps a camera to the universe and zoom bounds. */
export function clampCamera(cam: Camera, halfW: number, halfH: number): Camera {
  return {
    x: Math.max(-halfW, Math.min(halfW, cam.x)),
    y: Math.max(-halfH, Math.min(halfH, cam.y)),
    zoom: Math.max(ZOOM.min, Math.min(ZOOM.max, cam.zoom)),
  };
}

/** Zooms by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(
  cam: Camera,
  factor: number,
  sx: number,
  sy: number,
  width: number,
  height: number,
): Camera {
  const zoom = Math.max(ZOOM.min, Math.min(ZOOM.max, cam.zoom * factor));
  const before = viewport(cam, width, height);
  const after = viewport({...cam, zoom}, width, height);
  const wx = (sx - before.offsetX) / before.scale;
  const wy = (sy - before.offsetY) / before.scale;
  return {
    x: wx - (sx - width / 2) / after.scale,
    y: wy - (sy - height / 2) / after.scale,
    zoom,
  };
}

/** World to screen. */
export function toScreen(
  x: number,
  y: number,
  vp: Viewport,
): {x: number; y: number} {
  return {x: vp.offsetX + x * vp.scale, y: vp.offsetY + y * vp.scale};
}

/** Screen to world. */
export function toWorld(
  sx: number,
  sy: number,
  vp: Viewport,
): {x: number; y: number} {
  return {x: (sx - vp.offsetX) / vp.scale, y: (sy - vp.offsetY) / vp.scale};
}
