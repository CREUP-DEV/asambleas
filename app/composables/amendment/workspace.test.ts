import { describe, expect, it } from "vitest";
import type { AmendmentDto } from "../../../shared/types/api";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { consolidate } from "../../../shared/utils/content/consolidate";
import { validateOps } from "../../../shared/utils/content/ops";
import {
  amendmentBlockMarkers,
  amendmentDisplayLabel,
  amendmentErrorKey,
  amendmentErrorReasons,
  consolidationInputs,
  contiguousBlockRange,
  deletePassageOps,
  draftPassage,
  emptyAmendmentFilters,
  extendBlockSelection,
  filterAmendmentList,
  groupAmendmentsByOverlap,
  passageAmendmentOps,
  passageSeed,
  seedComposerFromDraft,
  totalityAlternativeOps,
} from "./workspace";

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const base: Block[] = [
  p("b1", "Primer párrafo del texto."),
  p("b2", "El Consejo financiará la totalidad de las becas."),
  p("b3", "Tercer párrafo con más contenido."),
  p("b4", "Cuarto párrafo final."),
];

let counter = 0;
const newId = () => `new${(counter += 1).toString().padStart(4, "0")}`;

function amendment(
  id: string,
  ops: AmendmentOp[],
  extra: Partial<AmendmentDto> = {},
): AmendmentDto {
  return {
    id,
    documentId: "doc",
    number: null,
    code: null,
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    ops,
    globalReplace: null,
    justification: "",
    positionKey: 0,
    changeKinds: [],
    authors: [],
    submittedAt: null,
    decidedAt: null,
    approvalMethod: null,
    outcomeNote: null,
    outcomeVote: null,
    position: null,
    sourceIds: [],
    transactionalIds: [],
    acceptances: [],
    updatedAt: "2026-11-01T10:00:00.000Z",
    can: {
      edit: false,
      submit: false,
      withdraw: false,
      accept: false,
      position: false,
      moderate: false,
      review: false,
    },
    ...extra,
  };
}

const replace = (
  blockId: string,
  from: number,
  to: number,
  text: string,
): AmendmentOp => {
  const block = base.find((b) => b.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from,
    to,
    text,
    baseText: block.text.slice(from, to),
  };
};

describe("labels", () => {
  it("joins number and code, and keeps transactional codes", () => {
    expect(
      amendmentDisplayLabel({ number: 12, code: "CEUM 4", kind: "partial" }),
    ).toBe("12 · CEUM 4");
    expect(
      amendmentDisplayLabel({ number: 3, code: "T1", kind: "transactional" }),
    ).toBe("T1");
    expect(
      amendmentDisplayLabel({ number: null, code: null, kind: "partial" }),
    ).toBeNull();
  });
});

describe("selection", () => {
  it("normalizes to a contiguous range in base order", () => {
    expect(contiguousBlockRange(base, ["b3", "b1"])).toEqual([
      "b1",
      "b2",
      "b3",
    ]);
    expect(contiguousBlockRange(base, ["missing"])).toEqual([]);
  });

  it("selects, toggles and extends from the anchor", () => {
    let selection = extendBlockSelection(
      base,
      { ids: [], anchor: null },
      "b2",
      false,
    );
    expect(selection).toEqual({ ids: ["b2"], anchor: "b2" });
    selection = extendBlockSelection(base, selection, "b4", true);
    expect(selection.ids).toEqual(["b2", "b3", "b4"]);
    selection = extendBlockSelection(base, selection, "b3", true);
    expect(selection.ids).toEqual(["b2", "b3"]);
    selection = extendBlockSelection(base, selection, "b1", true);
    expect(selection.ids).toEqual(["b1", "b2"]);
    selection = extendBlockSelection(
      base,
      { ids: ["b1"], anchor: "b1" },
      "b1",
      false,
    );
    expect(selection.ids).toEqual([]);
  });
});

describe("passage operations", () => {
  it("diffs an edited passage against the base", () => {
    const edited = passageSeed(base, ["b2"]);
    edited[0] = {
      ...edited[0]!,
      text: edited[0]!.text.replace("la totalidad", "la mitad"),
    };
    const ops = passageAmendmentOps(base, ["b2"], edited, newId);
    expect(validateOps(base, ops)).toEqual([]);
    const { blocks } = consolidate(base, [{ id: "a", ops }]);
    expect(blocks[1]!.text).toBe(
      "El Consejo financiará la mitad de las becas.",
    );
  });

  it("adds a paragraph after the selection only once it has text", () => {
    const seeded = passageSeed(base, ["b3"], { appendEmpty: newId });
    expect(seeded).toHaveLength(2);
    expect(passageAmendmentOps(base, ["b3"], seeded, newId)).toEqual([]);
    seeded[1] = { ...seeded[1]!, text: "Nuevo párrafo." };
    const ops = passageAmendmentOps(base, ["b3"], seeded, newId);
    expect(ops).toEqual([
      { op: "insert", afterBlockId: "b3", blocks: [seeded[1]] },
    ]);
  });

  it("deletes a contiguous passage", () => {
    expect(deletePassageOps(base, ["b3", "b2"])).toEqual([
      { op: "delete", blockIds: ["b2", "b3"] },
    ]);
  });

  it("builds a full alternative text with fresh ids", () => {
    const ops = totalityAlternativeOps(
      base,
      [p("b1", "Texto nuevo."), p("x1", "   "), p("x2", "Otro.")],
      newId,
    );
    expect(validateOps(base, ops)).toEqual([]);
    expect(ops[0]).toEqual({
      op: "delete",
      blockIds: ["b1", "b2", "b3", "b4"],
    });
    const inserted = ops[1]!.op === "insert" ? ops[1]!.blocks : [];
    expect(inserted.map((b) => b.text)).toEqual(["Texto nuevo.", "Otro."]);
    expect(inserted[0]!.id).not.toBe("b1");
    const { blocks } = consolidate(base, [{ id: "t", ops }]);
    expect(blocks.map((b) => b.text)).toEqual(["Texto nuevo.", "Otro."]);
  });
});

describe("draft re-seeding", () => {
  it("rebuilds an edited passage that re-diffs to the same operations", () => {
    const edited = passageSeed(base, ["b2", "b3"]);
    edited[0] = {
      ...edited[0]!,
      text: "El Consejo financiará parte de las becas.",
    };
    edited.splice(1, 0, p("n1", "Párrafo insertado."));
    const ops = passageAmendmentOps(base, ["b2", "b3"], edited, newId);
    const seed = seedComposerFromDraft(base, {
      kind: "partial",
      ops,
      globalReplace: null,
    });
    expect(seed.mode).toBe("passage");
    const again = passageAmendmentOps(base, seed.selection, seed.edited, newId);
    expect(consolidate(base, [{ id: "a", ops: again }]).blocks).toEqual(
      consolidate(base, [{ id: "a", ops }]).blocks,
    );
  });

  it("handles a deleted first block replaced by new text", () => {
    const edited = [p("n2", "Sustituto."), ...passageSeed(base, ["b3"])];
    const ops = passageAmendmentOps(base, ["b2", "b3"], edited, newId);
    const seed = draftPassage(base, ops);
    const again = passageAmendmentOps(base, seed.selection, seed.edited, newId);
    expect(consolidate(base, [{ id: "a", ops: again }]).blocks).toEqual(
      consolidate(base, [{ id: "a", ops }]).blocks,
    );
  });

  it("recognizes delete, global, return and alternative drafts", () => {
    expect(
      seedComposerFromDraft(base, {
        kind: "partial",
        ops: deletePassageOps(base, ["b2", "b3"]),
        globalReplace: null,
      }),
    ).toMatchObject({ mode: "delete", selection: ["b2", "b3"] });
    expect(
      seedComposerFromDraft(base, {
        kind: "formal",
        ops: [replace("b2", 3, 10, "Comité")],
        globalReplace: { find: "Consejo", replace: "Comité" },
      }),
    ).toMatchObject({ mode: "global", find: "Consejo", replace: "Comité" });
    expect(
      seedComposerFromDraft(base, {
        kind: "totality_return",
        ops: [],
        globalReplace: null,
      }).mode,
    ).toBe("return");
    const alternative = totalityAlternativeOps(
      base,
      [p("z1", "Nuevo.")],
      newId,
    );
    expect(
      seedComposerFromDraft(base, {
        kind: "totality_alternative",
        ops: alternative,
        globalReplace: null,
      }),
    ).toMatchObject({ mode: "alternative", edited: [p("z1", "Nuevo.")] });
  });
});

describe("markers and groups", () => {
  const a = amendment("a", [replace("b2", 0, 2, "Un")], { positionKey: 1 });
  const b = amendment("b", [replace("b2", 1, 5, "X")], { positionKey: 1.01 });
  const c = amendment("c", [replace("b4", 0, 6, "Último")], {
    positionKey: 3,
  });
  const closed = amendment("d", [replace("b4", 0, 6, "Quinto")], {
    positionKey: 3,
    status: "rejected",
  });
  const totality = amendment("t", [], {
    kind: "totality_return",
    positionKey: -2,
  });

  it("counts undecided amendments per block and flags overlaps", () => {
    expect(amendmentBlockMarkers([a, b, c, closed, totality])).toEqual({
      b2: { count: 2, overlap: true },
      b4: { count: 1, overlap: false },
    });
  });

  it("groups by overlap cluster in text order, totality first", () => {
    const groups = groupAmendmentsByOverlap([c, b, totality, a]);
    expect(groups.map((g) => [g.kind, g.amendments.map((x) => x.id)])).toEqual([
      ["totality", ["t"]],
      ["overlap", ["a", "b"]],
      ["single", ["c"]],
    ]);
  });

  it("filters by status, member, late, mine and block", () => {
    const member = {
      id: "m1",
      acronym: "CEUM",
      name: "CEUM",
      kind: "asociado" as const,
    };
    const mine = amendment("m", [replace("b1", 0, 6, "Primero")], {
      authors: [member],
      late: true,
    });
    const list = [a, c, closed, mine];
    const filters = emptyAmendmentFilters();
    expect(
      filterAmendmentList(list, { ...filters, statuses: ["rejected"] }, null),
    ).toEqual([closed]);
    expect(
      filterAmendmentList(list, { ...filters, late: "late" }, null),
    ).toEqual([mine]);
    expect(filterAmendmentList(list, { ...filters, mine: true }, "m1")).toEqual(
      [mine],
    );
    expect(
      filterAmendmentList(list, { ...filters, memberIds: ["m1"] }, null),
    ).toEqual([mine]);
    expect(
      filterAmendmentList(list, { ...filters, blockId: "b4" }, null),
    ).toEqual([c, closed]);
    expect(
      filterAmendmentList(list, { ...filters, query: "ceum" }, null),
    ).toEqual([mine]);
  });
});

describe("consolidation inputs", () => {
  it("orders approved amendments by decision time, then accepted ones", () => {
    const first = amendment("first", [replace("b1", 0, 6, "Inicial")], {
      status: "approved",
      decidedAt: "2026-11-02T10:00:00.000Z",
    });
    const second = amendment("second", [replace("b3", 0, 6, "Otro")], {
      status: "approved",
      decidedAt: "2026-11-01T10:00:00.000Z",
    });
    const accepted = amendment("acc", [replace("b4", 0, 6, "Fin")], {
      position: { position: "accept", comment: null, updatedAt: "" },
    });
    expect(
      consolidationInputs([first, second, accepted]).map((x) => x.id),
    ).toEqual(["second", "first"]);
    expect(
      consolidationInputs([first, second, accepted], true).map((x) => x.id),
    ).toEqual(["second", "first", "acc"]);
  });
});

describe("api errors", () => {
  it("reads 422 reasons from the response body", () => {
    const error = {
      statusCode: 422,
      data: {
        data: {
          reasons: [
            { index: 0, reason: "noop" },
            { index: 1, reason: "noop" },
            { index: -1, reason: "something_new" },
          ],
        },
      },
    };
    expect(amendmentErrorReasons(error)).toEqual(["noop", "something_new"]);
    expect(amendmentErrorKey("noop")).toBe("amendment.errors.noop");
    expect(amendmentErrorKey("something_new")).toBe("amendment.errors.unknown");
    expect(amendmentErrorReasons(new Error("x"))).toEqual([]);
  });
});
