import { describe, expect, it } from "vitest";
import {
  VIEW_FIT_PADDING,
  VIEW_LEGIBLE_SCALE,
  VIEW_MAX_SCALE,
  VIEW_MIN_SCALE,
  VIEW_NATURAL_SCALE,
  centreOn,
  clampScale,
  fitScale,
  fitView,
  focusBox,
  movedBeyond,
  panBy,
  pinchView,
  pointsBounds,
  roomToScreen,
  sameView,
  screenToRoom,
  snapToGrid,
  viewMatrix,
  wheelZoomFactor,
  zoomAt,
  type ViewTransform,
} from "./-viewport";

const close = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 6);

describe("room and screen", () => {
  it("map points both ways", () => {
    const view: ViewTransform = { scale: 0.5, x: 100, y: -20 };
    const screen = roomToScreen(view, { x: 200, y: 40 });
    expect(screen).toEqual({ x: 200, y: 0 });
    expect(screenToRoom(view, screen)).toEqual({ x: 200, y: 40 });
  });
});

describe("clampScale", () => {
  it("keeps the scale within its limits", () => {
    expect(clampScale(100)).toBe(VIEW_MAX_SCALE);
    expect(clampScale(0)).toBe(VIEW_MIN_SCALE);
    expect(clampScale(0.7)).toBe(0.7);
    expect(clampScale(Number.NaN)).toBe(VIEW_NATURAL_SCALE);
  });
});

describe("zoomAt", () => {
  it("keeps the room point under the anchor in place", () => {
    const view: ViewTransform = { scale: 0.8, x: 30, y: 50 };
    const anchor = { x: 310, y: 190 };
    const before = screenToRoom(view, anchor);
    const zoomed = zoomAt(view, 1.25, anchor);
    close(zoomed.scale, 1);
    const after = screenToRoom(zoomed, anchor);
    close(after.x, before.x);
    close(after.y, before.y);
  });

  it("stops at the limits and still keeps the anchor", () => {
    const view: ViewTransform = { scale: VIEW_MAX_SCALE, x: 0, y: 0 };
    const zoomed = zoomAt(view, 2, { x: 100, y: 100 });
    expect(zoomed.scale).toBe(VIEW_MAX_SCALE);
    expect(sameView(zoomed, view)).toBe(true);
  });
});

describe("panBy", () => {
  it("moves the view without scaling it", () => {
    expect(panBy({ scale: 2, x: 1, y: 2 }, 10, -5)).toEqual({
      scale: 2,
      x: 11,
      y: -3,
    });
  });
});

describe("fitView", () => {
  const size = { width: 800, height: 600 };

  it("fits the box and centres it", () => {
    const bounds = { minX: -500, minY: 0, maxX: 500, maxY: 1000 };
    const view = fitView(bounds, size);
    close(view.scale, (600 - 2 * VIEW_FIT_PADDING) / 1000);
    const centre = roomToScreen(view, { x: 0, y: 500 });
    close(centre.x, 400);
    close(centre.y, 300);
  });

  it("shows an empty room's origin at 100 %", () => {
    expect(fitView(null, size)).toEqual({ scale: 1, x: 400, y: 300 });
  });

  it("never divides by zero for a plan with no size yet", () => {
    const view = fitView(
      { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      {
        width: 0,
        height: 0,
      },
    );
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(Number.isFinite(view.x)).toBe(true);
  });

  it("fitScale is limited like any scale", () => {
    expect(
      fitScale(
        { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        { width: 5000, height: 5000 },
      ),
    ).toBe(VIEW_MAX_SCALE);
  });
});

describe("centreOn", () => {
  it("puts the point at the centre", () => {
    const view = centreOn({ x: 120, y: -40 }, { width: 400, height: 200 }, 2);
    expect(roomToScreen(view, { x: 120, y: -40 })).toEqual({ x: 200, y: 100 });
  });
});

describe("focusBox", () => {
  const size = { width: 1000, height: 800 };
  const small = { minX: 100, minY: 100, maxX: 160, maxY: 160 };

  it("zooms in to a legible scale from far out", () => {
    const view = focusBox({ scale: 0.1, x: 0, y: 0 }, small, size);
    close(view.scale, VIEW_LEGIBLE_SCALE);
    const centre = roomToScreen(view, { x: 130, y: 130 });
    close(centre.x, 500);
    close(centre.y, 400);
  });

  it("keeps the scale when the match already reads", () => {
    const view = focusBox({ scale: 2, x: 0, y: 0 }, small, size);
    close(view.scale, 2);
  });

  it("zooms out when the match does not fit", () => {
    const wide = { minX: 0, minY: 0, maxX: 3000, maxY: 100 };
    const view = focusBox({ scale: 2, x: 0, y: 0 }, wide, size);
    close(view.scale, fitScale(wide, size));
  });
});

describe("pointsBounds", () => {
  it("boxes the points with a margin", () => {
    expect(
      pointsBounds(
        [
          { x: 0, y: 10 },
          { x: 50, y: -10 },
        ],
        5,
      ),
    ).toEqual({ minX: -5, minY: -15, maxX: 55, maxY: 15 });
    expect(pointsBounds([])).toBeNull();
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in when scrolling up and out when scrolling down", () => {
    expect(
      wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }),
    ).toBeGreaterThan(1);
    expect(
      wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }),
    ).toBeLessThan(1);
  });

  it("gives a trackpad pinch a stronger pull than the wheel", () => {
    const wheel = wheelZoomFactor({
      deltaY: -10,
      deltaMode: 0,
      ctrlKey: false,
    });
    const pinch = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true });
    expect(pinch).toBeGreaterThan(wheel);
  });

  it("reads lines and pages as pixels and caps each event", () => {
    const line = wheelZoomFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false });
    const pixels = wheelZoomFactor({
      deltaY: 48,
      deltaMode: 0,
      ctrlKey: false,
    });
    close(line, pixels);
    const page = wheelZoomFactor({ deltaY: 1, deltaMode: 2, ctrlKey: false });
    const huge = wheelZoomFactor({
      deltaY: 10000,
      deltaMode: 0,
      ctrlKey: false,
    });
    close(page, huge);
  });
});

describe("pinchView", () => {
  const start: ViewTransform = { scale: 1, x: 0, y: 0 };

  it("scales by how far apart the fingers are, about their midpoint", () => {
    const view = pinchView(
      start,
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 50, y: 100 },
      { x: 250, y: 100 },
    );
    close(view.scale, 2);
    // The room point under the midpoint (150, 100) stays there.
    const room = screenToRoom(view, { x: 150, y: 100 });
    close(room.x, 150);
    close(room.y, 100);
  });

  it("pans with the midpoint when the fingers keep their distance", () => {
    const view = pinchView(
      start,
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 130, y: 140 },
      { x: 230, y: 140 },
    );
    expect(view).toEqual({ scale: 1, x: 30, y: 40 });
  });

  it("ignores fingers that landed on the same point", () => {
    const view = pinchView(
      start,
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 100, y: 100 },
    );
    expect(view.scale).toBe(1);
  });
});

describe("movedBeyond", () => {
  it("keeps a press within 4 px a tap", () => {
    expect(movedBeyond({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(false);
    expect(movedBeyond({ x: 0, y: 0 }, { x: 4, y: 3 })).toBe(true);
  });
});

describe("viewMatrix", () => {
  it("writes the layer's transform", () => {
    expect(viewMatrix({ scale: 0.5, x: 10.12345, y: -3 })).toBe(
      "matrix(0.5 0 0 0.5 10.123 -3)",
    );
  });
});

describe("snapToGrid", () => {
  it("rounds to the 10 cm grid", () => {
    expect(snapToGrid(14)).toBe(10);
    expect(snapToGrid(15)).toBe(20);
    expect(snapToGrid(-14)).toBe(-10);
    expect(snapToGrid(-4)).toBe(0);
    expect(snapToGrid(26, 25)).toBe(25);
  });
});
