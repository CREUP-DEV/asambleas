import { describe, expect, it } from "vitest";
import {
  EMPTY_AGENDA_FOLD,
  agendaAncestorIds,
  agendaFoldableIds,
  agendaNeighbours,
  agendaNodePath,
  agendaSubtreeTotals,
  buildAgendaTree,
  canMoveAgendaItem,
  collapseAllAgenda,
  collapsedAgendaIds,
  defaultCollapsedIds,
  expandAgendaAncestors,
  expandAllAgenda,
  findAgendaNode,
  isAgendaFinalConflict,
  agendaNumberInText,
  agendaNumbers,
  flattenAgendaTree,
  mergedAgendaDocument,
  numberedAgendaTitle,
  planAgendaMove,
  readAgendaFold,
  reorderChangesRoots,
  sameAgendaTitle,
  toggleAgendaFold,
  type AgendaTreeItem,
} from "./agendaTree";

/**
 * 1 a
 *   1.1 a1
 *     1.1.1 a1x
 *       1.1.1.1 a1xy
 *   1.2 a2
 * 2 b
 *   2.1 b1
 * 3 c
 */
const items: AgendaTreeItem[] = [
  { id: "a", parentId: null, order: 0 },
  { id: "a1", parentId: "a", order: 0 },
  { id: "a1x", parentId: "a1", order: 0 },
  { id: "a1xy", parentId: "a1x", order: 0 },
  { id: "a2", parentId: "a", order: 1 },
  { id: "b", parentId: null, order: 1 },
  { id: "b1", parentId: "b", order: 0 },
  { id: "c", parentId: null, order: 2 },
];

describe("agendaAncestorIds", () => {
  it("lists the items above, nearest first", () => {
    expect(agendaAncestorIds(items, "a1xy")).toEqual(["a1x", "a1", "a"]);
    expect(agendaAncestorIds(items, "a")).toEqual([]);
    expect(agendaAncestorIds(items, "missing")).toEqual([]);
  });

  it("stops on a parent that does not exist or loops", () => {
    expect(
      agendaAncestorIds([{ id: "x", parentId: "gone", order: 0 }], "x"),
    ).toEqual([]);
    const loop: AgendaTreeItem[] = [
      { id: "x", parentId: "y", order: 0 },
      { id: "y", parentId: "x", order: 0 },
    ];
    expect(agendaAncestorIds(loop, "x").length).toBeLessThanOrEqual(1);
  });
});

describe("numbers of an agenda with items not everyone receives", () => {
  /**
   * 1 r
   *   -   draft (unlisted)
   *   1.1 published
   *   -   submitted (unlisted)
   *   1.2 other
   * 2 s
   */
  const mixed: AgendaTreeItem[] = [
    { id: "r", parentId: null, order: 0 },
    { id: "draft", parentId: "r", order: 0, unlisted: true },
    { id: "published", parentId: "r", order: 1 },
    { id: "submitted", parentId: "r", order: 2, unlisted: true },
    { id: "other", parentId: "r", order: 3 },
    { id: "s", parentId: null, order: 1 },
  ];
  const tree = buildAgendaTree(mixed);

  it("keeps every item in its place and numbers only the listed ones", () => {
    expect(
      flattenAgendaTree(tree).map((node) => [node.item.id, node.number]),
    ).toEqual([
      ["r", "1"],
      ["draft", null],
      ["published", "1.1"],
      ["submitted", null],
      ["other", "1.2"],
      ["s", "2"],
    ]);
    // Position among the siblings, for the moves, still counts every item.
    expect(findAgendaNode(tree, "published")?.index).toBe(1);
    expect(findAgendaNode(tree, "published")?.siblingCount).toBe(4);
    expect(agendaNumbers(mixed).get("draft")).toBeNull();
  });

  it("moves an item without a number like any other", () => {
    expect(canMoveAgendaItem(mixed, "draft", "down")).toBe(true);
    expect(planAgendaMove(mixed, "draft", "down")).toEqual([
      { id: "published", parentId: "r", order: 0 },
      { id: "draft", parentId: "r", order: 1 },
    ]);
    expect(agendaNeighbours(tree, "draft").next?.item.id).toBe("published");
    expect(agendaNodePath(tree, "draft").map((node) => node.number)).toEqual([
      "1",
      null,
    ]);
  });

  it("never writes an empty number in a label", () => {
    expect(numberedAgendaTitle("1.1", "Título", "(sin publicar)")).toBe(
      "1.1. Título",
    );
    expect(numberedAgendaTitle(null, "Título", "(sin publicar)")).toBe(
      "Título (sin publicar)",
    );
    expect(numberedAgendaTitle(undefined, "Título", "(sin publicar)")).toBe(
      "Título (sin publicar)",
    );
    expect(agendaNumberInText("2", "(sin publicar)")).toBe("2");
    expect(agendaNumberInText(null, "(sin publicar)")).toBe("(sin publicar)");
  });
});

describe("the page of one item", () => {
  const tree = buildAgendaTree(items);

  it("finds a node at any depth", () => {
    expect(findAgendaNode(tree, "a1x")?.number).toBe("1.1.1");
    expect(findAgendaNode(tree, "missing")).toBeNull();
  });

  it("lists the nodes from the root item down to the item", () => {
    expect(agendaNodePath(tree, "a1xy").map((node) => node.number)).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.1.1.1",
    ]);
    expect(agendaNodePath(tree, "c").map((node) => node.item.id)).toEqual([
      "c",
    ]);
    expect(agendaNodePath(tree, "missing")).toEqual([]);
  });

  it("walks the agenda in reading order across levels", () => {
    const ids = (id: string) => {
      const { previous, next } = agendaNeighbours(tree, id);
      return [previous?.item.id ?? null, next?.item.id ?? null];
    };
    expect(ids("a")).toEqual([null, "a1"]);
    expect(ids("a1xy")).toEqual(["a1x", "a2"]);
    expect(ids("a2")).toEqual(["a1xy", "b"]);
    expect(ids("b")).toEqual(["a2", "b1"]);
    expect(ids("c")).toEqual(["b1", null]);
    expect(ids("missing")).toEqual([null, null]);
  });

  it("adds up the documents and amendments of an item and its sub-items", () => {
    const totals = agendaSubtreeTotals(items, [
      { agendaItemId: "a", amendmentCount: 1 },
      { agendaItemId: "a1xy", amendmentCount: 4 },
      { agendaItemId: "a1xy", amendmentCount: 0 },
      { agendaItemId: "a2", amendmentCount: 2 },
      { agendaItemId: "gone", amendmentCount: 9 },
    ]);
    expect(totals.get("a")).toEqual({ documents: 4, amendments: 7 });
    expect(totals.get("a1")).toEqual({ documents: 2, amendments: 4 });
    expect(totals.get("a1xy")).toEqual({ documents: 2, amendments: 4 });
    expect(totals.get("a2")).toEqual({ documents: 1, amendments: 2 });
    expect(totals.get("b")).toEqual({ documents: 0, amendments: 0 });
    expect(totals.has("gone")).toBe(false);
  });
});

describe("agenda folding", () => {
  it("folds by default the items below the root level that have sub-items", () => {
    expect([...defaultCollapsedIds(items)].sort()).toEqual(["a1", "a1x"]);
    expect(agendaFoldableIds(items)).toEqual(["a", "a1", "a1x", "b"]);
  });

  it("applies what the reader opened and closed over the default", () => {
    const state = { open: ["a1"], closed: ["b", "c", "gone"] };
    // "c" has no sub-items and "gone" does not exist: neither folds.
    expect([...collapsedAgendaIds(items, state)].sort()).toEqual(["a1x", "b"]);
  });

  it("toggles an item both ways and back to the default", () => {
    const opened = toggleAgendaFold(items, EMPTY_AGENDA_FOLD, "a1");
    expect(opened).toEqual({ open: ["a1"], closed: [] });
    expect(collapsedAgendaIds(items, opened).has("a1")).toBe(false);

    const closedAgain = toggleAgendaFold(items, opened, "a1");
    expect(closedAgain).toEqual({ open: [], closed: ["a1"] });
    expect(collapsedAgendaIds(items, closedAgain).has("a1")).toBe(true);

    const rootClosed = toggleAgendaFold(items, EMPTY_AGENDA_FOLD, "a");
    expect(rootClosed).toEqual({ open: [], closed: ["a"] });
    expect(EMPTY_AGENDA_FOLD).toEqual({ open: [], closed: [] });
  });

  it("unfolds everything above an item and nothing else", () => {
    const state = { open: [], closed: ["a", "b"] };
    const next = expandAgendaAncestors(items, state, "a1xy");
    expect([...collapsedAgendaIds(items, next)]).toEqual(["b"]);
    expect(next.closed).toEqual(["b"]);
  });

  it("returns the same state when nothing hides the item", () => {
    const state = { open: [], closed: ["b"] };
    expect(expandAgendaAncestors(items, state, "a1")).toBe(state);
    expect(expandAgendaAncestors(items, state, "missing")).toBe(state);
  });

  it("expands and collapses everything", () => {
    expect(collapsedAgendaIds(items, expandAllAgenda(items)).size).toBe(0);
    expect([...collapsedAgendaIds(items, collapseAllAgenda(items))]).toEqual(
      expect.arrayContaining(["a", "a1", "a1x", "b"]),
    );
  });

  it("reads a stored state, whatever is in it", () => {
    expect(readAgendaFold(null)).toEqual(EMPTY_AGENDA_FOLD);
    expect(readAgendaFold("x")).toEqual(EMPTY_AGENDA_FOLD);
    expect(readAgendaFold({ open: ["a", 3], closed: "b" })).toEqual({
      open: ["a"],
      closed: [],
    });
  });
});

describe("sameAgendaTitle", () => {
  it("ignores case, outer spaces and a final full stop", () => {
    expect(
      sameAgendaTitle(
        "Informe de la Presidencia.",
        "informe de la presidencia ",
      ),
    ).toBe(true);
    expect(
      sameAgendaTitle(
        "Informe  de la Presidencia",
        "Informe de la Presidencia",
      ),
    ).toBe(true);
  });

  it("matches the approval of a document with the document", () => {
    expect(
      sameAgendaTitle(
        "Aprobación, si procede, del Posicionamiento sobre el Sistema de Becas.",
        "Posicionamiento sobre el Sistema de Becas",
      ),
    ).toBe(true);
    expect(
      sameAgendaTitle(
        "Lectura y aprobación del acta anterior",
        "Acta anterior",
      ),
    ).toBe(true);
  });

  it("does not match different names", () => {
    expect(sameAgendaTitle("Informes", "Informe de la Presidencia")).toBe(
      false,
    );
    expect(sameAgendaTitle("Informe", "")).toBe(false);
    // Accents count: they are different words.
    expect(sameAgendaTitle("Resolución", "Resolucion")).toBe(false);
  });
});

describe("mergedAgendaDocument", () => {
  const report = { title: "Informe de la Presidencia" };

  it("is the only document when it is called like the item", () => {
    expect(mergedAgendaDocument("Informe de la Presidencia.", [report])).toBe(
      report,
    );
  });

  it("is null with no document, several, or another name", () => {
    expect(mergedAgendaDocument("Informe de la Presidencia", [])).toBeNull();
    expect(
      mergedAgendaDocument("Informe de la Presidencia", [report, report]),
    ).toBeNull();
    expect(mergedAgendaDocument("Informes", [report])).toBeNull();
  });
});

describe("moves and the final agenda", () => {
  it("plans moves of root items (no lock on the client any more)", () => {
    expect(canMoveAgendaItem(items, "b", "up")).toBe(true);
    expect(canMoveAgendaItem(items, "a", "up")).toBe(false);
    expect(canMoveAgendaItem(items, "b1", "outdent")).toBe(true);
  });

  it("knows which moves change the root items", () => {
    const plan = (id: string, move: Parameters<typeof planAgendaMove>[2]) =>
      planAgendaMove(items, id, move)!;
    expect(reorderChangesRoots(items, plan("b", "up"))).toBe(true);
    expect(reorderChangesRoots(items, plan("b", "indent"))).toBe(true);
    expect(reorderChangesRoots(items, plan("b1", "outdent"))).toBe(true);
    expect(reorderChangesRoots(items, plan("a2", "up"))).toBe(false);
    expect(reorderChangesRoots(items, plan("a2", "indent"))).toBe(false);
    expect(reorderChangesRoots(items, plan("a1x", "outdent"))).toBe(false);
  });

  it("recognises the server asking to confirm a final agenda change", () => {
    // ofetch: the response body, with createError's data inside.
    expect(
      isAgendaFinalConflict({
        statusCode: 409,
        data: { statusCode: 409, data: { code: "agenda_final" } },
      }),
    ).toBe(true);
    // h3: createError's data itself.
    expect(isAgendaFinalConflict({ data: { code: "agenda_final" } })).toBe(
      true,
    );
    expect(isAgendaFinalConflict({ statusCode: 409, data: {} })).toBe(false);
    expect(isAgendaFinalConflict({ data: { data: { code: "other" } } })).toBe(
      false,
    );
    expect(isAgendaFinalConflict(null)).toBe(false);
    expect(isAgendaFinalConflict(new Error("network"))).toBe(false);
  });
});
