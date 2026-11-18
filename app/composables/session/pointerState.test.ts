import { describe, expect, it } from "vitest";
import {
  EMPTY_POINTER_STATE,
  POINTER_IDLE_MS,
  RIPPLE_MS,
  STROKE_FADE_MS,
  applyPointerEvents,
  pointerStateActive,
  prunePointerState,
} from "./pointerState";

const p = (x: number, y = 0.5) => ({ page: 1, x, y });

describe("applyPointerEvents", () => {
  it("moves the pointer and hides it when it leaves", () => {
    const moved = applyPointerEvents(
      EMPTY_POINTER_STATE,
      [{ type: "move", point: p(0.2) }],
      10,
    );
    expect(moved.pointer).toEqual(p(0.2));
    expect(
      applyPointerEvents(moved, [{ type: "move", point: null }], 20).pointer,
    ).toBeNull();
  });

  it("adds a ripple per click", () => {
    const state = applyPointerEvents(
      EMPTY_POINTER_STATE,
      [
        { type: "click", point: p(0.1) },
        { type: "click", point: p(0.9) },
      ],
      0,
    );
    expect(state.ripples.map((ripple) => ripple.point)).toEqual([
      p(0.1),
      p(0.9),
    ]);
  });

  it("builds a stroke from its pieces and closes it", () => {
    let state = applyPointerEvents(
      EMPTY_POINTER_STATE,
      [
        {
          type: "stroke",
          id: "s1",
          points: [p(0.1), p(0.2)],
          end: false,
          pinned: false,
        },
      ],
      0,
    );
    state = applyPointerEvents(
      state,
      [
        {
          type: "stroke",
          id: "s1",
          points: [p(0.3)],
          end: true,
          pinned: false,
        },
      ],
      50,
    );
    expect(state.strokes).toEqual([
      {
        id: "s1",
        points: [p(0.1), p(0.2), p(0.3)],
        endedAt: 50,
        pinned: false,
      },
    ]);
    expect(state.pointer).toEqual(p(0.3));
  });

  it("keeps the selected words until they go or are cleared", () => {
    const span = {
      start: { blockId: "b1", offset: 4 },
      end: { blockId: "b2", offset: 10 },
    };
    const selected = applyPointerEvents(
      EMPTY_POINTER_STATE,
      [{ type: "select", span }],
      0,
    );
    expect(selected.selection).toEqual(span);
    expect(
      applyPointerEvents(selected, [{ type: "select", span: null }], 1)
        .selection,
    ).toBeNull();
    expect(
      applyPointerEvents(selected, [{ type: "clear" }], 1).selection,
    ).toBeNull();
  });

  it("clears the strokes and ripples", () => {
    const drawn = applyPointerEvents(
      EMPTY_POINTER_STATE,
      [
        { type: "stroke", id: "s1", points: [p(0.1)], end: true, pinned: true },
        { type: "click", point: p(0.5) },
      ],
      0,
    );
    const cleared = applyPointerEvents(drawn, [{ type: "clear" }], 1);
    expect(cleared.strokes).toEqual([]);
    expect(cleared.ripples).toEqual([]);
  });
});

describe("prunePointerState", () => {
  const drawn = applyPointerEvents(
    EMPTY_POINTER_STATE,
    [
      {
        type: "stroke",
        id: "loose",
        points: [p(0.1)],
        end: true,
        pinned: false,
      },
      { type: "stroke", id: "kept", points: [p(0.2)], end: true, pinned: true },
      {
        type: "stroke",
        id: "open",
        points: [p(0.3)],
        end: false,
        pinned: false,
      },
      { type: "click", point: p(0.4) },
    ],
    0,
  );

  it("keeps everything while it lasts, the same object", () => {
    expect(prunePointerState(drawn, RIPPLE_MS - 1)).toBe(drawn);
  });

  it("lets ripples go, then faded strokes, never pinned or open ones", () => {
    expect(prunePointerState(drawn, RIPPLE_MS).ripples).toEqual([]);
    expect(
      prunePointerState(drawn, STROKE_FADE_MS).strokes.map((s) => s.id),
    ).toEqual(["kept", "open"]);
  });

  it("hides a pointer that stays still too long", () => {
    expect(prunePointerState(drawn, POINTER_IDLE_MS).pointer).toBeNull();
  });

  it("is active while something moves or fades", () => {
    expect(pointerStateActive(EMPTY_POINTER_STATE)).toBe(false);
    expect(pointerStateActive(drawn)).toBe(true);
  });
});
