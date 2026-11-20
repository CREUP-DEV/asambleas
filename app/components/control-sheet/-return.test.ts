import { describe, expect, it } from "vitest";
import {
  debateMoved,
  firstRowInView,
  readSheetReturn,
  scrollTopForAnchor,
  SHEET_RETURN_KEY,
  withSheetReturn,
  type SheetReturnState,
} from "./-return";

const KEYS = ["orden", "q", "ver"];

const saved = (over: Partial<SheetReturnState> = {}): SheetReturnState => ({
  assemblyId: "asm1",
  scrollTop: 420,
  anchor: { rowId: "item1", offset: 12 },
  follow: true,
  live: { agendaItemId: "item1", documentId: null, amendmentId: null },
  tabQueries: { amendments: { orden: "codigo", ver: "pendientes" } },
  search: "resol",
  ...over,
});

describe("readSheetReturn", () => {
  it("round-trips what was saved, through the history state", () => {
    const state = withSheetReturn({ position: 3, back: "/x" }, saved());
    expect(state.position).toBe(3);
    expect(readSheetReturn(state, "asm1", KEYS)).toEqual(saved());
  });

  it("rejects another assembly, no state and bad shapes", () => {
    const state = withSheetReturn({}, saved());
    expect(readSheetReturn(state, "asm2", KEYS)).toBeNull();
    expect(readSheetReturn(null, "asm1", KEYS)).toBeNull();
    expect(readSheetReturn("x", "asm1", KEYS)).toBeNull();
    expect(readSheetReturn({ [SHEET_RETURN_KEY]: 4 }, "asm1", KEYS)).toBeNull();
    expect(readSheetReturn({ position: 1 }, "asm1", KEYS)).toBeNull();
  });

  it("keeps only the known query keys and sane values", () => {
    const state = {
      [SHEET_RETURN_KEY]: {
        assemblyId: "asm1",
        scrollTop: -5,
        anchor: { rowId: 7, offset: 3 },
        follow: "yes",
        live: { agendaItemId: 3, documentId: "d1" },
        tabQueries: {
          general: { orden: "resultado", evil: "x", q: 4 },
          other: { orden: "x" },
        },
        search: 12,
      },
    };
    expect(readSheetReturn(state, "asm1", KEYS)).toEqual({
      assemblyId: "asm1",
      scrollTop: 0,
      anchor: null,
      follow: false,
      live: { agendaItemId: null, documentId: "d1", amendmentId: null },
      tabQueries: { general: { orden: "resultado" } },
      search: "",
    });
  });
});

describe("withSheetReturn", () => {
  it("takes the saved state out with null, keeping the rest", () => {
    expect(withSheetReturn(withSheetReturn({ a: 1 }, saved()), null)).toEqual({
      a: 1,
    });
    expect(withSheetReturn(null, null)).toEqual({});
  });
});

describe("debateMoved", () => {
  const live = { agendaItemId: "i1", documentId: "d1", amendmentId: null };

  it("tells whether the Mesa moved what is on screen meanwhile", () => {
    expect(debateMoved(live, { ...live })).toBe(false);
    expect(debateMoved(live, { ...live, amendmentId: "a1" })).toBe(true);
    expect(debateMoved(live, null)).toBe(true);
    expect(
      debateMoved(
        { agendaItemId: null, documentId: null, amendmentId: null },
        null,
      ),
    ).toBe(false);
  });
});

describe("scrollTopForAnchor and firstRowInView", () => {
  it("finds the first row below the tabs and puts it back there", () => {
    const rows = [
      { id: "r1", top: 20, bottom: 90 },
      { id: "r2", top: 90, bottom: 160 },
    ];
    expect(firstRowInView(rows, 100)).toEqual({ rowId: "r2", offset: -10 });
    expect(firstRowInView(rows, 200)).toBeNull();
    // The row is now 300px further down: scroll that much more.
    expect(scrollTopForAnchor(500, 390, 100, -10)).toBe(800);
    expect(scrollTopForAnchor(0, 0, 100, 0)).toBe(0);
  });
});
