/**
 * The pure maths of the seating plan's pan and zoom (useSvgViewport,
 * docs/seating-plan.md, section 7). A view maps the room's centimetres to
 * the plan's CSS pixels: screen = room × scale + (x, y). Screen points are
 * relative to the plan's top-left corner.
 *
 * The leading dash keeps Nuxt from auto-importing this file
 * (`ignorePrefix`); import it explicitly.
 */

export interface ViewTransform {
  /** CSS pixels per centimetre of the room. */
  scale: number;
  x: number;
  y: number;
}

export interface ViewPoint {
  x: number;
  y: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

/** A box in room coordinates (SeatingBounds has this shape). */
export interface ViewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** «100 %»: one centimetre of the room is one CSS pixel (a seat is 45 px). */
export const VIEW_NATURAL_SCALE = 1;
export const VIEW_MIN_SCALE = 0.05;
export const VIEW_MAX_SCALE = 8;
/** What the «+» and «−» buttons multiply the scale by. */
export const VIEW_ZOOM_STEP = 1.25;
/** Room left around what «Ajustar» fits, in CSS pixels. */
export const VIEW_FIT_PADDING = 24;
/** A press that moves less than this is a tap, not a drag (CSS pixels). */
export const TAP_THRESHOLD_PX = 4;
/** The smallest scale a search match is shown at: a seat of 27 px. */
export const VIEW_LEGIBLE_SCALE = 0.6;

export const IDENTITY_VIEW: Readonly<ViewTransform> = Object.freeze({
  scale: VIEW_NATURAL_SCALE,
  x: 0,
  y: 0,
});

export function clampScale(
  scale: number,
  min = VIEW_MIN_SCALE,
  max = VIEW_MAX_SCALE,
): number {
  if (!Number.isFinite(scale)) return VIEW_NATURAL_SCALE;
  return Math.min(max, Math.max(min, scale));
}

export function roomToScreen(view: ViewTransform, point: ViewPoint): ViewPoint {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

export function screenToRoom(view: ViewTransform, point: ViewPoint): ViewPoint {
  return {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  };
}

/**
 * Zooms by `factor` keeping the room point under `anchor` (a screen point,
 * the cursor or the plan's centre) where it is. The scale is clamped, and
 * the factor with it.
 */
export function zoomAt(
  view: ViewTransform,
  factor: number,
  anchor: ViewPoint,
): ViewTransform {
  const scale = clampScale(view.scale * factor);
  const room = screenToRoom(view, anchor);
  return { scale, x: anchor.x - room.x * scale, y: anchor.y - room.y * scale };
}

export function panBy(
  view: ViewTransform,
  dx: number,
  dy: number,
): ViewTransform {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}

/** The scale at which a box fits the plan with `padding` around it. */
export function fitScale(
  bounds: ViewBounds,
  size: ViewSize,
  padding = VIEW_FIT_PADDING,
): number {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const room = {
    width: Math.max(1, size.width - 2 * padding),
    height: Math.max(1, size.height - 2 * padding),
  };
  return clampScale(Math.min(room.width / width, room.height / height));
}

/** A view with `point` (room) at the plan's centre, at `scale`. */
export function centreOn(
  point: ViewPoint,
  size: ViewSize,
  scale: number,
): ViewTransform {
  const clamped = clampScale(scale);
  return {
    scale: clamped,
    x: size.width / 2 - point.x * clamped,
    y: size.height / 2 - point.y * clamped,
  };
}

const boxCentre = (bounds: ViewBounds): ViewPoint => ({
  x: (bounds.minX + bounds.maxX) / 2,
  y: (bounds.minY + bounds.maxY) / 2,
});

/**
 * «Ajustar»: the whole box in view, centred. An empty room (null) shows its
 * origin at «100 %».
 */
export function fitView(
  bounds: ViewBounds | null,
  size: ViewSize,
  padding = VIEW_FIT_PADDING,
): ViewTransform {
  if (!bounds) return centreOn({ x: 0, y: 0 }, size, VIEW_NATURAL_SCALE);
  return centreOn(boxCentre(bounds), size, fitScale(bounds, size, padding));
}

/**
 * Shows a box (a search match), centred: at the current scale when it fits,
 * zoomed in to a legible scale when the view is far out, zoomed out when it
 * does not fit.
 */
export function focusBox(
  view: ViewTransform,
  bounds: ViewBounds,
  size: ViewSize,
  options: { padding?: number; legibleScale?: number } = {},
): ViewTransform {
  const fits = fitScale(bounds, size, options.padding ?? VIEW_FIT_PADDING);
  const wanted = Math.max(
    view.scale,
    options.legibleScale ?? VIEW_LEGIBLE_SCALE,
  );
  return centreOn(boxCentre(bounds), size, Math.min(wanted, fits));
}

/** The box around some room points, `margin` around each; null for none. */
export function pointsBounds(
  points: readonly ViewPoint[],
  margin = 0,
): ViewBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x - margin);
    minY = Math.min(minY, point.y - margin);
    maxX = Math.max(maxX, point.x + margin);
    maxY = Math.max(maxY, point.y + margin);
  }
  return { minX, minY, maxX, maxY };
}

/** What a wheel event asks for, from WheelEvent's own fields. */
export interface WheelInput {
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.DOM_DELTA_*). */
  deltaMode: number;
  /** A trackpad pinch arrives as a wheel event with ctrlKey set. */
  ctrlKey: boolean;
}

/**
 * The zoom factor of one wheel event: a mouse wheel's notch is about 10 %;
 * a trackpad pinch sends small pixel deltas and gets a stronger factor, so
 * it follows the fingers. Each event is capped, so a fast flick never jumps.
 */
export function wheelZoomFactor(input: WheelInput): number {
  const pixels =
    input.deltaMode === 1
      ? input.deltaY * 16
      : input.deltaMode === 2
        ? input.deltaY * 400
        : input.deltaY;
  const capped = Math.max(-120, Math.min(120, pixels));
  const strength = input.ctrlKey ? 0.01 : 0.002;
  return Math.exp(-capped * strength);
}

const distance = (a: ViewPoint, b: ViewPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ViewPoint, b: ViewPoint): ViewPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/**
 * Two-finger pinch: the view as it was when both fingers landed (`start`,
 * at `a0` and `b0`), moved so the room point under their midpoint follows
 * it, and scaled by how far apart they are now (`a1`, `b1`).
 */
export function pinchView(
  start: ViewTransform,
  a0: ViewPoint,
  b0: ViewPoint,
  a1: ViewPoint,
  b1: ViewPoint,
): ViewTransform {
  const before = distance(a0, b0);
  const ratio = before < 1 ? 1 : distance(a1, b1) / before;
  const scale = clampScale(start.scale * ratio);
  const room = screenToRoom(start, midpoint(a0, b0));
  const now = midpoint(a1, b1);
  return { scale, x: now.x - room.x * scale, y: now.y - room.y * scale };
}

/** Whether a press moved far enough to be a drag rather than a tap. */
export function movedBeyond(
  start: ViewPoint,
  now: ViewPoint,
  threshold = TAP_THRESHOLD_PX,
): boolean {
  return distance(start, now) > threshold;
}

/** The SVG `transform` of the room's layer. */
export function viewMatrix(view: ViewTransform): string {
  const round = (value: number) => Math.round(value * 1000) / 1000 || 0;
  return `matrix(${round(view.scale)} 0 0 ${round(view.scale)} ${round(view.x)} ${round(view.y)})`;
}

/** A coordinate on the room's grid (10 cm by default). */
export function snapToGrid(value: number, grid = 10): number {
  return Math.round(value / grid) * grid || 0;
}

/** Whether two views are the same, give or take rounding. */
export function sameView(a: ViewTransform, b: ViewTransform): boolean {
  return (
    Math.abs(a.scale - b.scale) < 1e-6 &&
    Math.abs(a.x - b.x) < 1e-3 &&
    Math.abs(a.y - b.y) < 1e-3
  );
}
