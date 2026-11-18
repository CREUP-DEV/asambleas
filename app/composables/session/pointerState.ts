import type {
  LivePoint,
  LivePointerEvent,
  LiveTextSpan,
} from "~~/shared/types/api";

/**
 * What the Mesa's pointer shows on the document in debate, on its own
 * screen and on the projection (user's decision of 2026-11-18): the
 * pointer, the ripples of each click and the strokes drawn. Strokes fade
 * a few seconds after they end unless the Mesa pins them; ripples last
 * under a second; the pointer hides when it leaves the document or stays
 * still for a while. Pure: the screens apply the same events.
 */

/** A stroke fades out over this long once it ends (unless pinned). */
export const STROKE_FADE_MS = 4500;
/** A click's ripples last this long. */
export const RIPPLE_MS = 1100;
/** The pointer hides after this long without moving. */
export const POINTER_IDLE_MS = 8000;

export interface PointerStroke {
  id: string;
  points: LivePoint[];
  /** When it ended; null while it is being drawn. */
  endedAt: number | null;
  pinned: boolean;
}

export interface PointerRipple {
  id: number;
  point: LivePoint;
  at: number;
}

export interface PointerState {
  pointer: LivePoint | null;
  pointerAt: number;
  /** The text the Mesa has selected (a text document), until it drops it. */
  selection: LiveTextSpan | null;
  strokes: PointerStroke[];
  ripples: PointerRipple[];
}

export const EMPTY_POINTER_STATE: PointerState = {
  pointer: null,
  pointerAt: 0,
  selection: null,
  strokes: [],
  ripples: [],
};

/** Strokes kept at most: the oldest go first. */
const MAX_STROKES = 60;
/** Points a stroke keeps at most. */
const MAX_STROKE_POINTS = 4000;

let rippleSeq = 0;

/** The state after some events, at `now`. */
export function applyPointerEvents(
  state: PointerState,
  events: readonly LivePointerEvent[],
  now: number,
): PointerState {
  let next: PointerState = { ...state, strokes: [...state.strokes] };
  for (const event of events) {
    switch (event.type) {
      case "move":
        next.pointer = event.point;
        next.pointerAt = now;
        break;
      case "select":
        next.selection = event.span;
        break;
      case "click":
        next.pointer = event.point;
        next.pointerAt = now;
        next.ripples = [
          ...next.ripples,
          { id: ++rippleSeq, point: event.point, at: now },
        ];
        break;
      case "stroke": {
        const index = next.strokes.findIndex((entry) => entry.id === event.id);
        const current = index === -1 ? null : next.strokes[index]!;
        const stroke: PointerStroke = {
          id: event.id,
          points: [...(current?.points ?? []), ...event.points].slice(
            -MAX_STROKE_POINTS,
          ),
          endedAt: event.end ? now : (current?.endedAt ?? null),
          pinned: event.pinned,
        };
        if (index === -1) next.strokes.push(stroke);
        else next.strokes[index] = stroke;
        const last = event.points.at(-1);
        if (last) {
          next.pointer = last;
          next.pointerAt = now;
        }
        break;
      }
      case "clear":
        next = { ...next, strokes: [], ripples: [], selection: null };
        break;
    }
  }
  if (next.strokes.length > MAX_STROKES) {
    next.strokes = next.strokes.slice(-MAX_STROKES);
  }
  return next;
}

/**
 * The state without what has gone by `now`: faded strokes, finished
 * ripples and a pointer still too long. The same object when nothing went.
 */
export function prunePointerState(
  state: PointerState,
  now: number,
): PointerState {
  const strokes = state.strokes.filter(
    (stroke) =>
      stroke.pinned ||
      stroke.endedAt === null ||
      now - stroke.endedAt < STROKE_FADE_MS,
  );
  const ripples = state.ripples.filter((ripple) => now - ripple.at < RIPPLE_MS);
  const pointer =
    state.pointer && now - state.pointerAt >= POINTER_IDLE_MS
      ? null
      : state.pointer;
  if (
    strokes.length === state.strokes.length &&
    ripples.length === state.ripples.length &&
    pointer === state.pointer
  ) {
    return state;
  }
  return { ...state, strokes, ripples, pointer };
}

/** Whether anything is on show (the prune timer runs only then). */
export function pointerStateActive(state: PointerState): boolean {
  return (
    state.pointer !== null ||
    state.ripples.length > 0 ||
    state.strokes.some((stroke) => !stroke.pinned)
  );
}
