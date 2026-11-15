import type { Ref } from "vue";
import {
  IDENTITY_VIEW,
  VIEW_NATURAL_SCALE,
  VIEW_ZOOM_STEP,
  centreOn,
  fitView,
  focusBox,
  movedBeyond,
  panBy,
  pinchView,
  roomToScreen,
  screenToRoom,
  wheelZoomFactor,
  zoomAt,
  type ViewBounds,
  type ViewPoint,
  type ViewSize,
  type ViewTransform,
} from "./-viewport";

/**
 * Pan and zoom of the seating plan's SVG (docs/seating-plan.md, section 7):
 * the wheel and a trackpad pinch zoom at the cursor, two fingers pinch, a
 * drag on the floor pans, and the buttons zoom in, out, fit and «100 %».
 * Pointer Events written here, with no library: a press becomes a drag only
 * past 4 px (TAP_THRESHOLD_PX), so a tap stays a tap and the browser's own
 * `click` reaches the seat; the plan's pointer is captured only once it
 * drags. Moves are applied once per animation frame.
 *
 * The maths is pure (-viewport.ts). Screen points are relative to the SVG;
 * room points come from the layer's getScreenCTM().inverse(), which follows
 * whatever transform the browser applies.
 */

/** A press the plan drags itself (a loose chair in Editar sala). */
export interface SvgViewportDrag {
  /** Room coordinates, once per frame while it moves. */
  move: (point: ViewPoint) => void;
  end: (point: ViewPoint) => void;
  cancel: () => void;
}

export interface SvgViewportOptions {
  svg: Readonly<Ref<SVGSVGElement | null>>;
  /** The transformed layer the room is drawn in. */
  layer: Readonly<Ref<SVGGElement | null>>;
  /** A press on something the plan drags itself; null pans the view. */
  claimDrag?: (event: PointerEvent) => SvgViewportDrag | null;
  /**
   * Whether a touch held still on this press is a long press (the seat
   * menu): asked when the press starts, so a touch anywhere else keeps its
   * tap and its pan however long it rests.
   */
  wantsLongPress?: (event: PointerEvent) => boolean;
  /** A touch held still where `wantsLongPress` said so. */
  onLongPress?: (event: PointerEvent) => void;
  /** The view starts to move: popovers anchored to the plan close. */
  onViewChange?: () => void;
}

const LONG_PRESS_MS = 550;

interface TrackedPointer {
  start: ViewPoint;
  now: ViewPoint;
}

type Gesture =
  | { kind: "idle" }
  | {
      kind: "press";
      pointerId: number;
      down: PointerEvent;
      drag: SvgViewportDrag | null;
    }
  | { kind: "pan"; pointerId: number; last: ViewPoint }
  | { kind: "drag"; pointerId: number; drag: SvgViewportDrag }
  | {
      kind: "pinch";
      start: ViewTransform;
      ids: [number, number];
      a0: ViewPoint;
      b0: ViewPoint;
    };

export function useSvgViewport(options: SvgViewportOptions) {
  const view = ref<ViewTransform>({ ...IDENTITY_VIEW });
  const size = ref<ViewSize>({ width: 0, height: 0 });
  /** True while a pan or a pinch moves the view. */
  const moving = ref(false);
  /** Set when a press was used up (a drag, a long press): ignore its click. */
  let swallowClick = false;

  useResizeObserver(options.svg, (entries) => {
    const box = entries[0]?.contentRect;
    if (box) size.value = { width: box.width, height: box.height };
  });

  // Screen and room ------------------------------------------------------------

  /** A client point (an event's clientX/Y) relative to the SVG. */
  function toScreen(clientX: number, clientY: number): ViewPoint {
    const rect = options.svg.value?.getBoundingClientRect();
    return rect
      ? { x: clientX - rect.left, y: clientY - rect.top }
      : { x: clientX, y: clientY };
  }

  /** A client point in room coordinates, through the layer's CTM. */
  function clientToRoom(clientX: number, clientY: number): ViewPoint {
    const svg = options.svg.value;
    const matrix = options.layer.value?.getScreenCTM();
    if (svg && matrix) {
      const point = new DOMPoint(clientX, clientY).matrixTransform(
        matrix.inverse(),
      );
      return { x: point.x, y: point.y };
    }
    return screenToRoom(view.value, toScreen(clientX, clientY));
  }

  // Frames ------------------------------------------------------------------------

  let frame: number | null = null;
  let nextView: ViewTransform | null = null;
  let pendingDragMove: { drag: SvgViewportDrag; point: ViewPoint } | null =
    null;

  function schedule(): void {
    if (frame !== null || !import.meta.client) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (nextView) {
        view.value = nextView;
        nextView = null;
      }
      if (pendingDragMove) {
        pendingDragMove.drag.move(pendingDragMove.point);
        pendingDragMove = null;
      }
    });
  }

  function setView(value: ViewTransform, immediate = false): void {
    if (immediate) {
      nextView = null;
      view.value = value;
      return;
    }
    nextView = value;
    schedule();
  }

  const current = () => nextView ?? view.value;
  const centre = (): ViewPoint => ({
    x: size.value.width / 2,
    y: size.value.height / 2,
  });

  // Buttons and programmatic moves ------------------------------------------------

  function zoomBy(factor: number, anchor: ViewPoint = centre()): void {
    options.onViewChange?.();
    setView(zoomAt(current(), factor, anchor), true);
  }

  const zoomIn = () => zoomBy(VIEW_ZOOM_STEP);
  const zoomOut = () => zoomBy(1 / VIEW_ZOOM_STEP);

  /** «Ajustar»: the whole room in view. */
  function fit(bounds: ViewBounds | null): void {
    options.onViewChange?.();
    setView(fitView(bounds, size.value), true);
  }

  /** «100 %», keeping the middle of the view where it is. */
  function actualSize(): void {
    options.onViewChange?.();
    const middle = screenToRoom(current(), centre());
    setView(centreOn(middle, size.value, VIEW_NATURAL_SCALE), true);
  }

  /** Centres a box (a search match), zooming to read it if needed. */
  function show(bounds: ViewBounds): void {
    options.onViewChange?.();
    setView(focusBox(current(), bounds, size.value), true);
  }

  /**
   * Brings a room point (the seat the keyboard moved to) into view at the
   * same scale, when it is out of it or too near an edge.
   */
  function reveal(point: ViewPoint, margin = 48): void {
    const screen = roomToScreen(current(), point);
    const { width, height } = size.value;
    if (
      screen.x >= margin &&
      screen.y >= margin &&
      screen.x <= width - margin &&
      screen.y <= height - margin
    ) {
      return;
    }
    options.onViewChange?.();
    setView(centreOn(point, size.value, current().scale), true);
  }

  /** The room point at the middle of the view. */
  function middleOfView(): ViewPoint {
    return screenToRoom(current(), centre());
  }

  // Wheel -----------------------------------------------------------------------------

  useEventListener(
    options.svg,
    "wheel",
    (event: WheelEvent) => {
      // The hub body scrolls otherwise.
      event.preventDefault();
      options.onViewChange?.();
      const factor = wheelZoomFactor(event);
      setView(
        zoomAt(current(), factor, toScreen(event.clientX, event.clientY)),
      );
    },
    { passive: false },
  );

  // Pointers ----------------------------------------------------------------------------

  const pointers = new Map<number, TrackedPointer>();
  let gesture: Gesture = { kind: "idle" };
  let longPress: ReturnType<typeof setTimeout> | null = null;

  function clearLongPress(): void {
    if (longPress !== null) clearTimeout(longPress);
    longPress = null;
  }

  function capture(pointerId: number): void {
    try {
      options.svg.value?.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone.
    }
  }

  function release(pointerId: number): void {
    try {
      if (options.svg.value?.hasPointerCapture(pointerId)) {
        options.svg.value.releasePointerCapture(pointerId);
      }
    } catch {
      // Nothing to release.
    }
  }

  function endGesture(): void {
    clearLongPress();
    gesture = { kind: "idle" };
    moving.value = false;
  }

  function onPointerDown(event: PointerEvent): void {
    // Only the main button of a mouse; any touch or pen.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = toScreen(event.clientX, event.clientY);
    pointers.set(event.pointerId, { start: point, now: point });
    swallowClick = false;

    if (pointers.size === 2) {
      // A second finger: whatever the first one started becomes a pinch.
      if (gesture.kind === "drag") gesture.drag.cancel();
      if (gesture.kind === "press") gesture.drag?.cancel();
      clearLongPress();
      const [first, second] = [...pointers.entries()];
      for (const [id] of pointers) capture(id);
      options.onViewChange?.();
      gesture = {
        kind: "pinch",
        start: current(),
        ids: [first![0], second![0]],
        a0: first![1].now,
        b0: second![1].now,
      };
      moving.value = true;
      swallowClick = true;
      return;
    }
    if (pointers.size > 2) return;

    gesture = {
      kind: "press",
      pointerId: event.pointerId,
      down: event,
      drag: options.claimDrag?.(event) ?? null,
    };
    if (
      event.pointerType === "touch" &&
      options.onLongPress &&
      !gesture.drag &&
      options.wantsLongPress?.(event)
    ) {
      const down = event;
      longPress = setTimeout(() => {
        longPress = null;
        if (gesture.kind === "press" && gesture.down === down) {
          gesture.drag?.cancel();
          swallowClick = true;
          endGesture();
          options.onLongPress?.(down);
        }
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const tracked = pointers.get(event.pointerId);
    if (!tracked) return;
    tracked.now = toScreen(event.clientX, event.clientY);

    switch (gesture.kind) {
      case "press": {
        if (gesture.pointerId !== event.pointerId) return;
        if (!movedBeyond(tracked.start, tracked.now)) return;
        clearLongPress();
        capture(event.pointerId);
        swallowClick = true;
        if (gesture.drag) {
          gesture = {
            kind: "drag",
            pointerId: event.pointerId,
            drag: gesture.drag,
          };
          pendingDragMove = {
            drag: gesture.drag,
            point: clientToRoom(event.clientX, event.clientY),
          };
          schedule();
          return;
        }
        options.onViewChange?.();
        moving.value = true;
        setView(
          panBy(
            current(),
            tracked.now.x - tracked.start.x,
            tracked.now.y - tracked.start.y,
          ),
        );
        gesture = {
          kind: "pan",
          pointerId: event.pointerId,
          last: tracked.now,
        };
        return;
      }
      case "pan": {
        if (gesture.pointerId !== event.pointerId) return;
        setView(
          panBy(
            current(),
            tracked.now.x - gesture.last.x,
            tracked.now.y - gesture.last.y,
          ),
        );
        gesture.last = tracked.now;
        return;
      }
      case "drag": {
        if (gesture.pointerId !== event.pointerId) return;
        pendingDragMove = {
          drag: gesture.drag,
          point: clientToRoom(event.clientX, event.clientY),
        };
        schedule();
        return;
      }
      case "pinch": {
        const a = pointers.get(gesture.ids[0]);
        const b = pointers.get(gesture.ids[1]);
        if (!a || !b) return;
        setView(pinchView(gesture.start, gesture.a0, gesture.b0, a.now, b.now));
        return;
      }
      default:
        return;
    }
  }

  function onPointerEnd(event: PointerEvent, cancelled: boolean): void {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    release(event.pointerId);
    if (gesture.kind === "drag" && gesture.pointerId === event.pointerId) {
      const drag = gesture.drag;
      // The last frame's move first, then the drop where the pointer is.
      pendingDragMove = null;
      if (cancelled) drag.cancel();
      else drag.end(clientToRoom(event.clientX, event.clientY));
      endGesture();
      return;
    }
    if (gesture.kind === "press" && gesture.pointerId === event.pointerId) {
      gesture.drag?.cancel();
      endGesture();
      return;
    }
    if (gesture.kind === "pinch") {
      // Lifting one finger ends the pinch; the other does not start a pan.
      if (pointers.size === 0) endGesture();
      else gesture = { kind: "idle" };
      moving.value = false;
      return;
    }
    if (pointers.size === 0) endGesture();
  }

  useEventListener(options.svg, "pointerdown", onPointerDown);
  useEventListener(options.svg, "pointermove", onPointerMove);
  useEventListener(options.svg, "pointerup", (event: PointerEvent) =>
    onPointerEnd(event, false),
  );
  useEventListener(options.svg, "pointercancel", (event: PointerEvent) =>
    onPointerEnd(event, true),
  );
  // Clicks that end a drag, a pan, a pinch or a long press are not taps.
  useEventListener(
    options.svg,
    "click",
    (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    { capture: true },
  );

  onBeforeUnmount(() => {
    clearLongPress();
    if (frame !== null) cancelAnimationFrame(frame);
  });

  return {
    view: readonly(view),
    size: readonly(size),
    moving: readonly(moving),
    clientToRoom,
    middleOfView,
    zoomIn,
    zoomOut,
    zoomBy,
    fit,
    actualSize,
    show,
    reveal,
  };
}

export type SvgViewport = ReturnType<typeof useSvgViewport>;
