import { describe, expect, it } from "vitest";
import type { AmendmentDto } from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { blocksToEditor, editorToBlocks } from "~~/shared/utils/content/editor";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  activeAmendmentFilterCount,
  amendmentBlockMarkers,
  amendmentsOnBlocks,
  amendmentHistoryVersion,
  amendmentDisplayLabel,
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentOverlapIndex,
  composerAuthorMemberIds,
  composerAuthorSeed,
  composerSyncState,
  consolidationInputs,
  emptyAmendmentFilters,
  filterAmendmentList,
  groupAmendmentsByOverlap,
  isAmendmentPrivate,
  isNewerAmendmentVersion,
  mineAmendments,
  seedComposerFromDraft,
  changedBlockCount,
  composerAmendmentKind,
  composerDocumentSeed,
  composerStartBlockId,
  composerEditSettler,
  composerIssues,
  documentAmendmentOps,
  showAmendmentAdmission,
  totalityAlternativeOps,
  amendmentLateOnSend,
  amendmentReviewQueue,
  amendmentReviewSentenceKey,
  amendmentsReturnedForCorrection,
  AMENDMENT_REVIEW_FILTERS,
  isAmendmentReturnedForCorrection,
  amendmentReviewView,
  amendmentSentNotice,
  amendmentsAwaitingActor,
  amendmentLateState,
  isAmendmentPresenter,
  amendmentAuthorsInOrder,
  amendmentAcceptBlocked,
  amendmentAwaitsPosition,
  amendmentMainAuthor,
  amendmentPositionBlocker,
  amendmentPositionNext,
  composerAuthorSet,
  composerMainAuthor,
  amendmentNeighbours,
  amendmentQuickFilterOf,
  amendmentStatusLine,
  applyAmendmentQuickFilter,
  compareAmendmentCodes,
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
    mainAuthorId: null,
    submittedAt: null,
    validatedAt: null,
    publishedAt: null,
    reviewState: "published",
    correctionNote: null,
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
      validate: false,
      publish: false,
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

/** The text as the editor gives it back when nobody touches it. */
const echoOf = (blocks: Block[]) =>
  editorToBlocks(blocksToEditor(blocks), newId);

/** A longer text with what an editor may read differently. */
const rich: Block[] = [
  { id: "r1", type: "heading", level: 1, text: "Título primero", marks: [] },
  {
    id: "r2",
    type: "paragraph",
    text: "Un párrafo con negrita y un enlace.",
    marks: [
      { type: "bold", from: 16, to: 23 },
      { type: "link", from: 29, to: 35, href: "https://creup.es" },
    ],
  },
  {
    id: "r3",
    type: "list_item",
    list: "ordered",
    level: 0,
    marker: "a)",
    text: "Primer punto",
    marks: [],
  },
  {
    id: "r4",
    type: "list_item",
    list: "ordered",
    level: 1,
    text: "Punto anidado",
    marks: [],
  },
  {
    id: "r5",
    type: "paragraph",
    text: "Celda uno",
    marks: [],
    cell: { table: "t1", row: "w1", cell: "c1", header: true },
  },
  {
    id: "r6",
    type: "paragraph",
    text: "Celda dos",
    marks: [],
    cell: { table: "t1", row: "w1", cell: "c2", shade: true },
  },
  { id: "r7", type: "quote", text: "Una cita final.", marks: [] },
];

describe("whole-document operations", () => {
  it("finds no change in a text nobody touched", () => {
    const seed = composerDocumentSeed(rich);
    expect(seed).toEqual(rich);
    expect(seed[1]).not.toBe(rich[1]);
    // As seeded, and as the editor returns it.
    expect(documentAmendmentOps(rich, seed, newId)).toEqual([]);
    const settle = composerEditSettler(seed, echoOf(seed));
    const ops = documentAmendmentOps(rich, settle(echoOf(seed)), newId);
    expect(ops).toEqual([]);
    expect(changedBlockCount(ops)).toBe(0);
  });

  it("takes an untouched block as the stored one, whatever the editor returns", () => {
    const seed = composerDocumentSeed(base);
    // An editor that gives the second paragraph back with a stray space.
    const echo = seed.map((block) =>
      block.id === "b2" ? { ...block, text: `${block.text} ` } : block,
    );
    const settle = composerEditSettler(seed, echo);
    expect(documentAmendmentOps(base, settle(echo), newId)).toEqual([]);
    // Once the author edits it, it is theirs.
    const edited = echo.map((block) =>
      block.id === "b2" ? { ...block, text: "Otro texto." } : block,
    );
    const ops = documentAmendmentOps(base, settle(edited), newId);
    expect(ops.every((op) => op.op === "replace" && op.blockId === "b2")).toBe(
      true,
    );
    expect(changedBlockCount(ops)).toBe(1);
  });

  it("opens a draft at its first change in the text, on a block the editor has", () => {
    const seed = composerDocumentSeed(base);
    // A new paragraph after the first and another ending: the operations
    // come with the replacement first.
    const edited = [
      seed[0]!,
      p("n1", "Párrafo nuevo."),
      seed[1]!,
      seed[2]!,
      { ...seed[3]!, text: "Otro final." },
    ];
    const ops = documentAmendmentOps(base, edited, newId);
    expect(ops[0]).toMatchObject({ op: "replace", blockId: base[3]!.id });
    expect(
      composerStartBlockId(base, ops, composerDocumentSeed(base, ops)),
    ).toBe(base[0]!.id);

    // A removed paragraph is not in the editor: the one before it, or the
    // one after when it was the first.
    const startOf = (blockId: string) => {
      const removal: AmendmentOp[] = [{ op: "delete", blockIds: [blockId] }];
      return composerStartBlockId(
        base,
        removal,
        composerDocumentSeed(base, removal),
      );
    };
    expect(startOf(base[2]!.id)).toBe(base[1]!.id);
    expect(startOf(base[0]!.id)).toBe(base[1]!.id);
    expect(composerStartBlockId(base, [], seed)).toBeNull();
  });

  it("derives modification, addition and suppression from one edit", () => {
    const seed = composerDocumentSeed(base);
    const edited = [
      seed[0]!,
      { ...seed[1]!, text: "El Consejo financiará la mitad de las becas." },
      p("n1", "Párrafo nuevo."),
      // b3 is gone.
      seed[3]!,
    ];
    const ops = documentAmendmentOps(base, edited, newId);
    expect(validateOps(base, ops)).toEqual([]);
    expect(ops.map((op) => op.op).sort()).toEqual([
      "delete",
      "insert",
      "replace",
    ]);
    expect(changedBlockCount(ops)).toBe(3);
    expect(
      consolidate(base, [{ id: "a", ops }]).blocks.map((block) => block.text),
    ).toEqual([
      "Primer párrafo del texto.",
      "El Consejo financiará la mitad de las becas.",
      "Párrafo nuevo.",
      "Cuarto párrafo final.",
    ]);
  });

  it("turns a change of format alone into an amendment", () => {
    const seed = composerDocumentSeed(rich);
    const edited = seed.map((block) => {
      if (block.id === "r1") return { ...block, level: 2 };
      if (block.id === "r7") {
        return {
          ...block,
          marks: [{ type: "italic" as const, from: 4, to: 8 }],
        };
      }
      return block;
    });
    const ops = documentAmendmentOps(rich, edited, newId);
    expect(validateOps(rich, ops)).toEqual([]);
    expect(changedBlockCount(ops)).toBe(2);
    const { blocks } = consolidate(rich, [{ id: "a", ops }]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[6]!.marks).toEqual([{ type: "italic", from: 4, to: 8 }]);
  });

  it("ignores empty paragraphs the author leaves around", () => {
    const seed = composerDocumentSeed(base);
    const edited = [...seed, p("n9", "   ")];
    expect(documentAmendmentOps(base, edited, newId)).toEqual([]);
  });

  it("counts every block an amendment rewrites, removes or adds", () => {
    expect(
      changedBlockCount([
        replace("b1", 0, 6, "Segundo"),
        replace("b1", 7, 14, "apartado"),
        { op: "delete", blockIds: ["b2", "b3"] },
        {
          op: "insert",
          afterBlockId: "b4",
          blocks: [p("n1", "Uno."), p("n2", "Dos.")],
        },
      ]),
    ).toBe(5);
    expect(changedBlockCount([])).toBe(0);
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
  /** A stored draft: one paragraph rewritten, one removed, one added. */
  const draftOps = (): AmendmentOp[] => {
    const seed = composerDocumentSeed(base);
    return documentAmendmentOps(
      base,
      [
        seed[0]!,
        { ...seed[1]!, text: "El Consejo financiará parte de las becas." },
        p("n1", "Párrafo insertado."),
        seed[3]!,
      ],
      newId,
    );
  };

  it("opens the whole text as the draft leaves it", () => {
    const ops = draftOps();
    const seed = seedComposerFromDraft(base, {
      kind: "partial",
      ops,
      globalReplace: null,
    });
    expect(seed.mode).toBe("document");
    expect(seed.edited.map((block) => block.id)).toEqual([
      "b1",
      "b2",
      "n1",
      "b4",
    ]);
    expect(seed.edited).toEqual(consolidate(base, [{ id: "a", ops }]).blocks);
  });

  it("gives the same amendment again when nothing else is touched", () => {
    const ops = draftOps();
    const seed = composerDocumentSeed(base, ops);
    const settle = composerEditSettler(seed, echoOf(seed));
    const again = documentAmendmentOps(base, settle(echoOf(seed)), newId);
    expect(validateOps(base, again)).toEqual([]);
    expect(consolidate(base, [{ id: "a", ops: again }]).blocks).toEqual(
      consolidate(base, [{ id: "a", ops }]).blocks,
    );
    expect(changedBlockCount(again)).toBe(changedBlockCount(ops));
  });

  it("lets the author go on editing the draft", () => {
    const seed = composerDocumentSeed(base, draftOps());
    const settle = composerEditSettler(seed, echoOf(seed));
    const edited = echoOf(seed).map((block) =>
      block.id === "b4"
        ? { ...block, text: "Cuarto párrafo, cambiado." }
        : block,
    );
    const ops = documentAmendmentOps(base, settle(edited), newId);
    expect(validateOps(base, ops)).toEqual([]);
    expect(
      consolidate(base, [{ id: "a", ops }]).blocks.map((block) => block.text),
    ).toEqual([
      "Primer párrafo del texto.",
      "El Consejo financiará parte de las becas.",
      "Párrafo insertado.",
      "Cuarto párrafo, cambiado.",
    ]);
  });

  it("keeps a draft that only changes formatting", () => {
    const first = composerDocumentSeed(rich);
    const ops = documentAmendmentOps(
      rich,
      first.map((block) =>
        block.id === "r1" ? { ...block, level: 3 } : block,
      ),
      newId,
    );
    const seed = composerDocumentSeed(rich, ops);
    expect(seed[0]).toMatchObject({ id: "r1", level: 3 });
    const settle = composerEditSettler(seed, echoOf(seed));
    const again = documentAmendmentOps(rich, settle(echoOf(seed)), newId);
    expect(consolidate(rich, [{ id: "a", ops: again }]).blocks).toEqual(
      consolidate(rich, [{ id: "a", ops }]).blocks,
    );
  });

  it("starts again from the base when the draft no longer applies", () => {
    const stale: AmendmentOp[] = [
      {
        op: "replace",
        blockId: "b2",
        from: 0,
        to: 2,
        text: "La",
        baseText: "XX",
      },
    ];
    expect(composerDocumentSeed(base, stale)).toEqual(base);
  });

  it("recognizes delete, global, return and alternative drafts", () => {
    // A draft that only removes paragraphs is one more edit of the text.
    const deleted = seedComposerFromDraft(base, {
      kind: "partial",
      ops: [{ op: "delete", blockIds: ["b2", "b3"] }],
      globalReplace: null,
    });
    expect(deleted.mode).toBe("document");
    expect(deleted.edited.map((block) => block.id)).toEqual(["b1", "b4"]);
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

describe("composer checks", () => {
  const change = [replace("b1", 0, 6, "Segundo")];

  it("asks for a change and for the kind of amendment", () => {
    expect(composerIssues({ mode: "document", kind: null, ops: [] })).toEqual([
      "no_changes",
      "kind_missing",
    ]);
    expect(
      composerIssues({ mode: "document", kind: null, ops: change }),
    ).toEqual(["kind_missing"]);
    expect(
      composerIssues({ mode: "document", kind: "formal", ops: change }),
    ).toEqual([]);
  });

  it("checks the word to change everywhere", () => {
    const global = { mode: "global" as const, kind: "partial" as const };
    expect(composerIssues({ ...global, ops: [], find: "  " })).toEqual([
      "find_empty",
    ]);
    expect(
      composerIssues({
        ...global,
        ops: [],
        find: "Consejo",
        replacement: "Consejo",
      }),
    ).toEqual(["same_term"]);
    expect(
      composerIssues({ ...global, ops: [], find: "Nada", replacement: "" }),
    ).toEqual(["no_matches"]);
    expect(
      composerIssues({
        ...global,
        ops: change,
        find: "Primer",
        replacement: "Segundo",
      }),
    ).toEqual([]);
  });

  it("never asks a totality amendment for its kind", () => {
    expect(composerIssues({ mode: "return", kind: null, ops: [] })).toEqual([]);
    expect(
      composerIssues({
        mode: "alternative",
        kind: null,
        ops: [],
        alternative: [p("x", "  ")],
      }),
    ).toEqual(["alternative_empty"]);
    expect(
      composerIssues({
        mode: "alternative",
        kind: null,
        ops: [],
        alternative: [p("x", "Texto.")],
      }),
    ).toEqual([]);
  });

  it("sends the kind the mode asks for", () => {
    expect(composerAmendmentKind("document", null)).toBeNull();
    expect(composerAmendmentKind("document", "formal")).toBe("formal");
    expect(composerAmendmentKind("global", "partial")).toBe("partial");
    expect(composerAmendmentKind("return", null)).toBe("totality_return");
    expect(composerAmendmentKind("alternative", "formal")).toBe(
      "totality_alternative",
    );
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

  it("lists the undecided amendments on some paragraphs", () => {
    const list = [c, b, a, closed, totality];
    expect(amendmentsOnBlocks(list, ["b2"]).map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
    // The draft being written is not one of the others.
    expect(
      amendmentsOnBlocks(list, ["b2", "b4"], "a").map((x) => x.id),
    ).toEqual(["b", "c"]);
    expect(amendmentsOnBlocks(list, [])).toEqual([]);
    expect(amendmentsOnBlocks(list, ["b1"])).toEqual([]);
  });

  it("groups by overlap cluster in text order, totality first", () => {
    const groups = groupAmendmentsByOverlap([c, b, totality, a]);
    expect(groups.map((g) => [g.kind, g.amendments.map((x) => x.id)])).toEqual([
      ["totality", ["t"]],
      ["overlap", ["a", "b"]],
      ["single", ["c"]],
    ]);
  });

  it("does not list a transactional and what it combines as overlaps", () => {
    const s1 = amendment("s1", [replace("b2", 0, 2, "Un")], {
      status: "transacted",
    });
    const s2 = amendment("s2", [replace("b2", 1, 5, "X")], {
      status: "transacted",
    });
    const t1 = amendment("t1", [replace("b2", 0, 5, "Uno X")], {
      kind: "transactional",
      status: "transacted",
      sourceIds: ["s1", "s2"],
    });
    // Built on t1: it absorbs t1's sources too.
    const t3 = amendment("t3", [replace("b2", 0, 6, "Unos X")], {
      kind: "transactional",
      sourceIds: ["t1"],
    });
    const other = amendment("o", [replace("b2", 1, 3, "zz")]);
    const index = amendmentOverlapIndex([s1, s2, t1, t3, other]);
    const ids = (id: string) => (index.get(id) ?? []).map((x) => x.id).sort();
    expect(ids("t3")).toEqual(["o"]);
    expect(ids("t1")).toEqual(["o"]);
    expect(ids("s1")).toEqual(["o", "s2"]);
    expect(ids("o")).toEqual(["s1", "s2", "t1", "t3"]);
  });

  it("still pairs unrelated amendments on the same passage", () => {
    const index = amendmentOverlapIndex([a, b, c]);
    expect(index.get("a")?.map((x) => x.id)).toEqual(["b"]);
    expect(index.get("b")?.map((x) => x.id)).toEqual(["a"]);
    expect(index.has("c")).toBe(false);
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
      position: {
        position: "accept",
        comment: null,
        recordedBy: "presenter",
        updatedAt: "",
      },
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
    // What validateOps says about a change of format has its own wording.
    for (const reason of [
      "format_shape",
      "format_image",
      "duplicate_format",
      "marks_out_of_range",
    ]) {
      expect(amendmentErrorKey(reason)).toBe(`amendment.errors.${reason}`);
    }
    expect(amendmentErrorReasons(new Error("x"))).toEqual([]);
  });
});

describe("composer authors", () => {
  it("keeps the actor's own member out of the picker and sends it back", () => {
    const seed = composerAuthorSeed(["P", "B", "C"], "P");
    expect(seed).toEqual({
      onBehalfOfMemberId: undefined,
      coAuthorIds: ["B", "C"],
      keptMemberId: "P",
      mainAuthorId: null,
    });
    expect(
      composerAuthorMemberIds(seed.coAuthorIds, seed.keptMemberId),
    ).toEqual(["B", "C", "P"]);
  });

  it("keeps a co-author who edits someone else's draft", () => {
    // The main author comes first: it is not taken for the presenting one.
    const seed = composerAuthorSeed(["C", "P", "B"], "B", "C");
    expect(seed.coAuthorIds).toEqual(["C", "P"]);
    expect(seed.keptMemberId).toBe("B");
    expect(seed.mainAuthorId).toBe("C");
    expect(
      composerAuthorMemberIds(seed.coAuthorIds, seed.keptMemberId),
    ).toEqual(["C", "P", "B"]);
    // Removing every visible co-author still sends the editor's own member.
    expect(composerAuthorMemberIds([], seed.keptMemberId)).toEqual(["B"]);
  });

  it("never seeds a presenting member on behalf from a stored draft", () => {
    // A moderator who is not an author: authors[0] is the main author, not
    // necessarily the presenting member, so nothing is sent on its behalf.
    const moderator = composerAuthorSeed(["B", "P"], "M", "B");
    expect(moderator.onBehalfOfMemberId).toBeUndefined();
    expect(moderator.coAuthorIds).toEqual(["B", "P"]);
    expect(moderator.keptMemberId).toBeNull();
    expect(
      composerAuthorMemberIds(moderator.coAuthorIds, moderator.keptMemberId),
    ).toEqual(["B", "P"]);

    const other = composerAuthorSeed(["P", "B"], null);
    expect(other.coAuthorIds).toEqual(["P", "B"]);
    expect(other.keptMemberId).toBeNull();
  });

  it("drops a stored main author that is no longer an author", () => {
    expect(composerAuthorSeed(["P", "B"], "P", "X").mainAuthorId).toBeNull();
  });

  it("starts empty for a new amendment", () => {
    expect(composerAuthorSeed([], "P")).toEqual({
      onBehalfOfMemberId: undefined,
      coAuthorIds: [],
      keptMemberId: null,
      mainAuthorId: null,
    });
  });

  it("lists everyone who will present it, without repeats", () => {
    expect(
      composerAuthorSet({
        presentingMemberId: "P",
        keptMemberId: null,
        coAuthorIds: ["B", "P"],
      }),
    ).toEqual(["P", "B"]);
    expect(
      composerAuthorSet({
        presentingMemberId: undefined,
        keptMemberId: "B",
        coAuthorIds: ["C"],
      }),
    ).toEqual(["B", "C"]);
    expect(
      composerAuthorSet({
        presentingMemberId: null,
        keptMemberId: null,
        coAuthorIds: [],
      }),
    ).toEqual([]);
  });

  it("requires a main author only when there are several", () => {
    // One author: it is the main one, and it is sent as such.
    expect(composerMainAuthor(["P"], null)).toEqual({
      required: false,
      value: "P",
      missing: false,
    });
    expect(composerMainAuthor(["P"], "P").value).toBe("P");
    // A stored choice that left the set does not override the sole author.
    expect(composerMainAuthor(["P"], "B").value).toBe("P");
    expect(composerMainAuthor([], null)).toEqual({
      required: false,
      value: null,
      missing: false,
    });
    expect(composerMainAuthor(["P", "B"], null)).toEqual({
      required: true,
      value: null,
      missing: true,
    });
    expect(composerMainAuthor(["P", "B"], "B")).toEqual({
      required: true,
      value: "B",
      missing: false,
    });
    // The chosen one was removed from the authors.
    expect(composerMainAuthor(["P", "B"], "C").missing).toBe(true);
  });
});

describe("main author", () => {
  const ceum = { id: "ceum", acronym: "CEUM" };
  const caub = { id: "caub", acronym: "CAUB" };

  it("is the one named, or the first author", () => {
    expect(
      amendmentMainAuthor({ authors: [ceum, caub], mainAuthorId: "caub" }),
    ).toBe(caub);
    expect(
      amendmentMainAuthor({ authors: [ceum, caub], mainAuthorId: null }),
    ).toBe(ceum);
    // Named but not among the authors (stale): the first one.
    expect(amendmentMainAuthor({ authors: [ceum], mainAuthorId: "caub" })).toBe(
      ceum,
    );
    expect(amendmentMainAuthor({ authors: [], mainAuthorId: null })).toBeNull();
  });

  it("goes first, and is marked only among several", () => {
    expect(
      amendmentAuthorsInOrder({ authors: [ceum, caub], mainAuthorId: "caub" }),
    ).toEqual({ main: caub, others: [ceum], marked: true });
    expect(
      amendmentAuthorsInOrder({ authors: [ceum], mainAuthorId: null }),
    ).toEqual({ main: ceum, others: [], marked: false });
  });
});

describe("the main presenter's answer", () => {
  const accepted = {
    member: { id: "ceum", acronym: "CEUM", name: "CEUM", kind: "asociado" },
    role: "author",
    decision: "accepted",
    decidedAt: "2026-11-02T10:00:00.000Z",
    recordedBy: "party",
  } as const;
  const pending = {
    ...accepted,
    decision: "pending",
    decidedAt: null,
    recordedBy: "party" as const,
  } as const;
  const rules = ["vote", "incorporate"] as const;

  it("is offered once validated and admitted", () => {
    for (const rule of rules) {
      expect(amendmentAwaitsPosition(amendment("a", []), rule)).toBe(true);
      // Recorded before validation existed.
      expect(
        amendmentAwaitsPosition(
          amendment("a", [], { reviewState: null }),
          rule,
        ),
      ).toBe(true);
      expect(
        amendmentAwaitsPosition(
          amendment("a", [], {
            reviewState: "pending_validation",
            admission: "pending",
          }),
          rule,
        ),
      ).toBe(false);
      // Late and the assembly has not decided to treat it.
      expect(
        amendmentAwaitsPosition(
          amendment("a", [], { late: true, admission: "pending" }),
          rule,
        ),
      ).toBe(false);
      expect(
        amendmentAwaitsPosition(
          amendment("a", [], { status: "withdrawn" }),
          rule,
        ),
      ).toBe(false);
    }
  });

  it("answers only published amendments, whatever the rule", () => {
    const private_ = amendment("a", [], { reviewState: "validated" });
    // Delegates cannot read it yet: not even the Mesa answers it for the
    // presenter until the Secretaría publishes it.
    for (const rule of rules) {
      expect(amendmentAwaitsPosition(private_, rule)).toBe(false);
      expect(amendmentPositionBlocker(private_, rule)).toBe("publication");
      expect(amendmentPositionNext(private_, rule)).toBeNull();
    }
    // Late, validated and private: the assembly decides first.
    expect(
      amendmentPositionBlocker(
        amendment("a", [], {
          reviewState: "validated",
          late: true,
          admission: "pending",
        }),
        "vote",
      ),
    ).toBe("admission");
    // A transactional validated before it was always published: same rule.
    expect(
      amendmentPositionBlocker(
        amendment("t", [], { kind: "transactional", reviewState: "validated" }),
        "incorporate",
      ),
    ).toBe("publication");
    // Decided ones wait for nothing.
    expect(
      amendmentPositionBlocker({ ...private_, status: "withdrawn" }, "vote"),
    ).toBeNull();
    // Kept for older callers; it never decides anything on its own now.
    expect(amendmentAcceptBlocked(private_, "incorporate")).toBe(true);
    expect(amendmentAcceptBlocked(amendment("a", []), "incorporate")).toBe(
      false,
    );
  });

  it("takes no answer once the document was voted", () => {
    const voted = { finalVoted: true };
    for (const rule of rules) {
      expect(amendmentAwaitsPosition(amendment("a", []), rule, voted)).toBe(
        false,
      );
      expect(
        amendmentPositionBlocker(amendment("a", []), rule, voted),
      ).toBeNull();
      expect(amendmentPositionNext(amendment("a", []), rule, voted)).toBeNull();
      // Not voted yet: the amendment-level rule applies.
      expect(
        amendmentAwaitsPosition(amendment("a", []), rule, {
          finalVoted: false,
        }),
      ).toBe(true);
    }
    // Not even one the presenter's acceptance incorporated.
    const incorporated = amendment("a", [], {
      status: "approved",
      approvalMethod: "proponent",
      decidedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(amendmentAwaitsPosition(incorporated, "incorporate")).toBe(true);
    expect(amendmentAwaitsPosition(incorporated, "incorporate", voted)).toBe(
      false,
    );
  });

  it("keeps an amendment incorporated by the presenter open to a change", () => {
    const incorporated = amendment("a", [], {
      status: "approved",
      approvalMethod: "proponent",
      decidedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(amendmentAwaitsPosition(incorporated, "incorporate")).toBe(true);
    // Approved that way under "vote" (by the Mesa): it is decided.
    expect(amendmentAwaitsPosition(incorporated, "vote")).toBe(false);
    expect(
      amendmentAwaitsPosition(
        { ...incorporated, approvalMethod: "vote" },
        "incorporate",
      ),
    ).toBe(false);
  });

  it("waits for a transactional's main authors first", () => {
    const transactional = (extra: Partial<AmendmentDto>) =>
      amendment("t", [], { kind: "transactional", ...extra });
    expect(
      amendmentAwaitsPosition(
        transactional({ acceptances: [accepted] }),
        "vote",
      ),
    ).toBe(true);
    expect(
      amendmentAwaitsPosition(
        transactional({ acceptances: [accepted, pending] }),
        "vote",
      ),
    ).toBe(false);
    expect(
      amendmentPositionBlocker(
        transactional({
          reviewState: "pending_authors",
          acceptances: [pending],
        }),
        "vote",
      ),
    ).toBe("authors");
    // The Mesa's live one is public at once: still the authors first.
    expect(
      amendmentPositionBlocker(
        transactional({ acceptances: [accepted, pending] }),
        "incorporate",
      ),
    ).toBe("authors");
    // Only the main authors' rows count, not an older presenter row.
    expect(
      amendmentAwaitsPosition(
        transactional({
          acceptances: [accepted, { ...pending, role: "proponent" }],
        }),
        "vote",
      ),
    ).toBe(true);
  });

  it("says why it cannot be answered yet", () => {
    expect(amendmentPositionBlocker(amendment("a", []), "vote")).toBeNull();
    expect(
      amendmentPositionBlocker(
        amendment("a", [], { reviewState: "pending_validation" }),
        "vote",
      ),
    ).toBe("validation");
    expect(
      amendmentPositionBlocker(
        amendment("a", [], { late: true, admission: "pending" }),
        "vote",
      ),
    ).toBe("admission");
    // Older rows: no review state, and not validated yet.
    expect(
      amendmentPositionBlocker(
        amendment("a", [], { reviewState: null, admission: "pending" }),
        "vote",
      ),
    ).toBe("validation");
    expect(
      amendmentPositionBlocker(
        amendment("a", [], {
          reviewState: null,
          admission: "pending",
          validatedAt: "2026-11-01T10:00:00.000Z",
        }),
        "vote",
      ),
    ).toBe("admission");
    expect(
      amendmentPositionBlocker(
        amendment("a", [], { status: "rejected" }),
        "vote",
      ),
    ).toBeNull();
  });

  it("says what happens next with the document's rule", () => {
    const answered = (position: "pending" | "accept" | "reject") =>
      amendment("a", [], {
        position: {
          position,
          comment: null,
          recordedBy: "presenter",
          updatedAt: "2026-11-02",
        },
      });
    expect(amendmentPositionNext(amendment("a", []), "incorporate")).toBe(
      "incorporateIfAccepted",
    );
    expect(amendmentPositionNext(answered("pending"), "incorporate")).toBe(
      "incorporateIfAccepted",
    );
    expect(
      amendmentPositionNext(
        {
          ...answered("accept"),
          status: "approved",
          approvalMethod: "proponent",
        },
        "incorporate",
      ),
    ).toBe("incorporated");
    expect(amendmentPositionNext(answered("reject"), "incorporate")).toBe(
      "vote",
    );
    expect(amendmentPositionNext(amendment("a", []), "vote")).toBe(
      "voteAnyway",
    );
    expect(amendmentPositionNext(answered("accept"), "vote")).toBe("vote");
    // Not reached the presenter yet, or decided otherwise.
    expect(
      amendmentPositionNext(
        amendment("a", [], { reviewState: "pending_validation" }),
        "vote",
      ),
    ).toBeNull();
    expect(
      amendmentPositionNext(
        amendment("a", [], { status: "rejected", decidedAt: "2026-11-02" }),
        "incorporate",
      ),
    ).toBeNull();
  });
});

describe("composer sync", () => {
  const t1 = "2026-11-01T10:00:00.000Z";
  const t2 = "2026-11-01T10:05:00.000Z";
  const remote = (
    updatedAt: string,
    status: AmendmentDto["status"] = "draft",
  ) => ({ id: "d1", status, updatedAt }) as const;

  it("compares versions strictly by time", () => {
    expect(isNewerAmendmentVersion(t2, t1)).toBe(true);
    expect(isNewerAmendmentVersion(t1, t2)).toBe(false);
    expect(isNewerAmendmentVersion(t1, t1)).toBe(false);
    expect(isNewerAmendmentVersion(null, t1)).toBe(false);
    expect(isNewerAmendmentVersion("nope", t1)).toBe(false);
  });

  it("never adopts a newer stored copy silently", () => {
    const base = { draftId: "d1", token: t1, conflicted: false };
    expect(composerSyncState({ ...base, remote: remote(t1) })).toBe("in_sync");
    // An older copy landing after the composer's own save is not a conflict.
    expect(composerSyncState({ ...base, token: t2, remote: remote(t1) })).toBe(
      "in_sync",
    );
    expect(composerSyncState({ ...base, remote: remote(t2) })).toBe(
      "remote_newer",
    );
    expect(
      composerSyncState({ ...base, remote: remote(t2, "submitted") }),
    ).toBe("not_editable");
    expect(
      composerSyncState({ ...base, remote: remote(t1, "submitted") }),
    ).toBe("not_editable");
    // The list may briefly lack a draft just created: not a conflict yet.
    expect(composerSyncState({ ...base, remote: null })).toBe("in_sync");
  });

  it("waits for the stored copy after a refused save", () => {
    const base = { draftId: "d1", token: t1, conflicted: true };
    expect(composerSyncState({ ...base, remote: remote(t1) })).toBe("conflict");
    expect(composerSyncState({ ...base, remote: remote(t2) })).toBe(
      "remote_newer",
    );
    expect(composerSyncState({ ...base, remote: null })).toBe("not_editable");
    expect(
      composerSyncState({ ...base, remote: remote(t1, "withdrawn") }),
    ).toBe("not_editable");
  });

  it("ends the edit once the document stops admitting amendments", () => {
    expect(
      composerSyncState({
        draftId: "d1",
        token: t1,
        remote: remote(t1),
        conflicted: true,
        documentOpen: false,
      }),
    ).toBe("not_editable");
  });

  it("has nothing to sync before the first save", () => {
    expect(
      composerSyncState({
        draftId: null,
        token: null,
        remote: null,
        conflicted: false,
      }),
    ).toBe("in_sync");
  });
});

describe("history version", () => {
  const member = (id: string) => ({
    id,
    acronym: id,
    name: id,
    kind: "asociado" as const,
  });

  it("changes with positions, acceptances and relations", () => {
    const plain = amendment("a1", []);
    const v0 = amendmentHistoryVersion(plain, []);
    expect(amendmentHistoryVersion(plain, [])).toBe(v0);

    const positioned = amendment("a1", [], {
      position: {
        position: "accept",
        comment: null,
        recordedBy: "presenter",
        updatedAt: "2026-11-01T11:00:00.000Z",
      },
    });
    expect(amendmentHistoryVersion(positioned, [])).not.toBe(v0);

    const pending = amendment("a1", [], {
      acceptances: [
        {
          member: member("m1"),
          role: "author",
          decision: "pending",
          decidedAt: null,
          recordedBy: "party" as const,
        },
      ],
    });
    const accepted = amendment("a1", [], {
      acceptances: [
        {
          member: member("m1"),
          role: "author",
          decision: "accepted",
          decidedAt: "2026-11-01T12:00:00.000Z",
          recordedBy: "party" as const,
        },
      ],
    });
    expect(amendmentHistoryVersion(accepted, [])).not.toBe(
      amendmentHistoryVersion(pending, []),
    );

    expect(amendmentHistoryVersion(plain, ["r1"])).not.toBe(v0);
    expect(amendmentHistoryVersion(plain, ["r2", "r1"])).toBe(
      amendmentHistoryVersion(plain, ["r1", "r2"]),
    );
  });
});

describe("review by the Secretaría", () => {
  const can = (
    extra: Partial<AmendmentDto["can"]> = {},
  ): AmendmentDto["can"] => ({
    ...amendment("x", []).can,
    ...extra,
  });

  it("says where it stands, worded for the viewer", () => {
    const view = (extra: Partial<AmendmentDto>) =>
      amendmentReviewView(amendment("a", [], extra))?.key ?? null;
    expect(view({ status: "draft", reviewState: null })).toBe("draft");
    expect(
      view({
        status: "draft",
        reviewState: "correction_requested",
        can: can({ edit: true }),
      }),
    ).toBe("correction");
    expect(view({ status: "draft", reviewState: "correction_requested" })).toBe(
      "correction_sent",
    );
    expect(view({ reviewState: "pending_validation" })).toBe("pending");
    expect(
      view({ reviewState: "pending_validation", can: can({ validate: true }) }),
    ).toBe("to_validate");
    expect(view({ reviewState: "validated" })).toBe("validated");
    expect(
      view({ reviewState: "validated", can: can({ publish: true }) }),
    ).toBe("to_publish");
    expect(view({ reviewState: "published" })).toBe("published");
    // Recorded before validation existed: public.
    expect(view({ reviewState: null })).toBe("published");
    // Decided: the outcome says it all.
    expect(view({ status: "approved" })).toBeNull();
    expect(
      view({ status: "withdrawn", reviewState: "pending_validation" }),
    ).toBe(null);
  });

  it("lets the Secretaría publish a decided amendment it kept private", () => {
    const view = (extra: Partial<AmendmentDto>) =>
      amendmentReviewView(amendment("a", [], extra));
    const approved = view({
      status: "approved",
      reviewState: "validated",
      can: can({ publish: true }),
    });
    expect(approved).toMatchObject({ key: "to_publish", private: true });
    expect(approved?.awaitingAdmission).toBe(false);
    // Its authors and the Mesa are not promised a publication.
    expect(
      view({ status: "approved", reviewState: "validated" })?.key ?? null,
    ).toBeNull();
    expect(
      view({
        status: "withdrawn",
        reviewState: "validated",
        can: can({ publish: true }),
      })?.key,
    ).toBe("to_publish");
    expect(
      view({ status: "rejected", reviewState: "published" })?.key ?? null,
    ).toBeNull();
  });

  it("words the sentence for presenters and for everyone else", () => {
    expect(amendmentReviewSentenceKey("pending", true)).toBe(
      "amendment.review.states.pending",
    );
    expect(amendmentReviewSentenceKey("pending", false)).toBe(
      "amendment.review.states.pending_others",
    );
    expect(amendmentReviewSentenceKey("validated", true)).toBe(
      "amendment.review.states.validated",
    );
    expect(amendmentReviewSentenceKey("validated", false)).toBe(
      "amendment.review.states.validated_others",
    );
    // The Secretaría's own keys and the rest read the same for everyone.
    expect(amendmentReviewSentenceKey("to_publish", false)).toBe(
      "amendment.review.states.to_publish",
    );
    expect(amendmentReviewSentenceKey("correction_sent", false)).toBe(
      "amendment.review.states.correction_sent",
    );
  });

  it("knows who presents it", () => {
    const me = {
      id: "m1",
      acronym: "CEUM",
      name: "CEUM",
      kind: "asociado" as const,
    };
    expect(
      isAmendmentPresenter(amendment("a", [], { authors: [me] }), "m1"),
    ).toBe(true);
    expect(
      isAmendmentPresenter(amendment("a", [], { authors: [me] }), "m2"),
    ).toBe(false);
    expect(
      isAmendmentPresenter(amendment("a", [], { authors: [me] }), null),
    ).toBe(false);
    // A draft created on behalf of a member: its creator can edit it.
    expect(
      isAmendmentPresenter(
        amendment("a", [], { status: "draft", can: can({ edit: true }) }),
        null,
      ),
    ).toBe(true);
  });

  it("counts what waits for the author and for the Secretaría", () => {
    const correction = amendment("fix", [], {
      status: "draft",
      reviewState: "correction_requested",
      can: can({ edit: true }),
    });
    const draft = amendment("draft", [], {
      status: "draft",
      reviewState: null,
      can: can({ edit: true }),
    });
    // Seen by the Secretaría, which cannot edit it.
    const sentBack = amendment("sent", [], {
      status: "draft",
      reviewState: "correction_requested",
    });
    const pending = amendment("p", [], { reviewState: "pending_validation" });
    const awaiting = amendmentsAwaitingActor([
      draft,
      pending,
      correction,
      sentBack,
    ]);
    expect(awaiting.corrections.map((a) => a.id)).toEqual(["fix"]);
    expect(awaiting.drafts.map((a) => a.id)).toEqual(["draft"]);

    expect(
      amendmentReviewQueue([
        amendment("a", [], { can: can({ validate: true }) }),
        amendment("b", [], { can: can({ validate: true }) }),
        amendment("c", [], { can: can({ publish: true }) }),
        amendment("d", []),
      ]),
    ).toEqual({ toValidate: 2, toPublish: 1, returned: 0 });
  });

  it("tells the amendments sent back for correction the viewer cannot edit", () => {
    const sentBack = amendment("sent", [], {
      status: "draft",
      reviewState: "correction_requested",
    });
    // Its authors fix it: theirs, in "Mis enmiendas".
    const ownCorrection = amendment("fix", [], {
      status: "draft",
      reviewState: "correction_requested",
      can: can({ edit: true }),
    });
    // Never sent: reviewers receive it too, but nothing was returned.
    const unsent = amendment("draft", [], {
      status: "draft",
      reviewState: null,
    });
    const pending = amendment("p", [], { reviewState: "pending_validation" });
    const list = [pending, sentBack, ownCorrection, unsent];

    expect(isAmendmentReturnedForCorrection(sentBack)).toBe(true);
    expect(isAmendmentReturnedForCorrection(ownCorrection)).toBe(false);
    expect(isAmendmentReturnedForCorrection(unsent)).toBe(false);
    expect(isAmendmentReturnedForCorrection(pending)).toBe(false);
    expect(amendmentsReturnedForCorrection(list)).toEqual([sentBack]);
  });

  it("counts what the Secretaría sent back, for reviewers only", () => {
    const reviewer = can({ review: true });
    const list = [
      amendment("p", [], {
        reviewState: "pending_validation",
        can: can({ review: true, validate: true }),
      }),
      amendment("s1", [], {
        status: "draft",
        reviewState: "correction_requested",
        can: reviewer,
      }),
      amendment("s2", [], {
        status: "draft",
        reviewState: "correction_requested",
        can: reviewer,
      }),
      amendment("u", [], { status: "draft", reviewState: null, can: reviewer }),
    ];
    expect(amendmentReviewQueue(list)).toEqual({
      toValidate: 1,
      toPublish: 0,
      returned: 2,
    });
    // Someone else who cannot edit them (not a reviewer): nothing to count.
    expect(
      amendmentReviewQueue([
        amendment("s", [], {
          status: "draft",
          reviewState: "correction_requested",
        }),
      ]).returned,
    ).toBe(0);
  });

  it("keeps the original timing when a correction is sent again", () => {
    expect(amendmentLateOnSend(null, true)).toBe(true);
    expect(amendmentLateOnSend(null, false)).toBe(false);
    expect(amendmentLateOnSend({ late: false, reviewState: null }, true)).toBe(
      true,
    );
    // On time at first: fixing it after the window closed is still on time.
    expect(
      amendmentLateOnSend(
        { late: false, reviewState: "correction_requested" },
        true,
      ),
    ).toBe(false);
    // Late at first: still late, even if the window is open again.
    expect(
      amendmentLateOnSend(
        { late: true, reviewState: "correction_requested" },
        false,
      ),
    ).toBe(true);
  });

  it("marks what is not public yet and late ones waiting for the Mesa", () => {
    const validatedLate = amendmentReviewView(
      amendment("a", [], {
        reviewState: "validated",
        late: true,
        admission: "pending",
      }),
    );
    expect(validatedLate).toMatchObject({
      private: true,
      awaitingAdmission: true,
    });
    const pending = amendmentReviewView(
      amendment("b", [], {
        reviewState: "pending_validation",
        admission: "pending",
      }),
    );
    expect(pending).toMatchObject({ private: true, awaitingAdmission: false });
    expect(
      amendmentReviewView(amendment("c", [], { reviewState: "published" })),
    ).toMatchObject({ private: false, awaitingAdmission: false });

    expect(isAmendmentPrivate({ status: "draft", reviewState: null })).toBe(
      true,
    );
    expect(isAmendmentPrivate({ status: "submitted", reviewState: null })).toBe(
      false,
    );
    expect(
      isAmendmentPrivate({ status: "withdrawn", reviewState: "validated" }),
    ).toBe(true);
  });

  it("shows admission only once the Secretaría validated it", () => {
    expect(
      showAmendmentAdmission({
        status: "submitted",
        reviewState: "pending_validation",
        admission: "pending",
      }),
    ).toBe(false);
    expect(
      showAmendmentAdmission({
        status: "submitted",
        reviewState: "validated",
        admission: "pending",
      }),
    ).toBe(true);
    expect(
      showAmendmentAdmission({
        status: "submitted",
        reviewState: "published",
        admission: "admitted",
      }),
    ).toBe(false);
    expect(
      showAmendmentAdmission({
        status: "draft",
        reviewState: null,
        admission: "pending",
      }),
    ).toBe(false);
    expect(
      showAmendmentAdmission({
        status: "submitted",
        reviewState: "pending_authors",
        admission: "pending",
      }),
    ).toBe(false);
  });

  it("says a transactional waits for the main authors", () => {
    const view = amendmentReviewView(
      amendment("t", [], {
        kind: "transactional",
        reviewState: "pending_authors",
        admission: "pending",
      }),
    );
    expect(view).toMatchObject({
      key: "pending_authors",
      private: true,
      awaitingAdmission: false,
    });
  });

  it("tells late amendments waiting for the assembly's decision apart", () => {
    const late = (extra: Partial<AmendmentDto>) =>
      amendmentLateState(amendment("a", [], { late: true, ...extra }));
    expect(amendmentLateState(amendment("a", []))).toBeNull();
    expect(
      late({ reviewState: "pending_validation", admission: "pending" }),
    ).toBe("late");
    expect(late({ reviewState: "validated", admission: "pending" })).toBe(
      "awaiting_decision",
    );
    expect(late({ reviewState: "published", admission: "pending" })).toBe(
      "awaiting_decision",
    );
    expect(late({ reviewState: "published", admission: "admitted" })).toBe(
      "late",
    );
    expect(late({ status: "inadmissible", admission: "inadmissible" })).toBe(
      "late",
    );
  });

  it("lists my amendments, what needs me first", () => {
    const me = {
      id: "m1",
      acronym: "CEUM",
      name: "CEUM",
      kind: "asociado" as const,
    };
    const other = {
      id: "m2",
      acronym: "CEUV",
      name: "CEUV",
      kind: "asociado" as const,
    };
    const published = amendment("pub", [], { authors: [me] });
    const pending = amendment("pend", [], {
      authors: [me],
      reviewState: "pending_validation",
    });
    const validated = amendment("val", [], {
      authors: [other, me],
      reviewState: "validated",
    });
    const draft = amendment("draft", [], {
      status: "draft",
      reviewState: null,
      authors: [me],
      can: can({ edit: true }),
    });
    const correction = amendment("fix", [], {
      status: "draft",
      reviewState: "correction_requested",
      authors: [me],
      can: can({ edit: true }),
    });
    const decided = amendment("done", [], {
      authors: [me],
      status: "approved",
    });
    const othersDraft = amendment("od", [], {
      status: "draft",
      reviewState: null,
      authors: [other],
    });
    const othersPublished = amendment("op", [], { authors: [other] });
    // On behalf of a member: editable by its creator, not authored by them.
    const onBehalf = amendment("ob", [], {
      status: "draft",
      reviewState: null,
      authors: [other],
      can: can({ edit: true }),
    });

    expect(
      mineAmendments(
        [
          published,
          decided,
          pending,
          othersDraft,
          validated,
          draft,
          othersPublished,
          correction,
          onBehalf,
        ],
        "m1",
      ).map((a) => a.id),
    ).toEqual(["fix", "draft", "ob", "pend", "val", "pub", "done"]);
    expect(
      mineAmendments([published, onBehalf], null).map((a) => a.id),
    ).toEqual(["ob"]);
  });

  it("filters by review state", () => {
    const pending = amendment("p", [], { reviewState: "pending_validation" });
    const validated = amendment("v", [], { reviewState: "validated" });
    const published = amendment("x", [], { reviewState: "published" });
    const legacy = amendment("l", [], { reviewState: null });
    const list = [pending, validated, published, legacy];
    const filters = emptyAmendmentFilters();
    expect(filterAmendmentList(list, filters, null)).toEqual(list);
    expect(
      filterAmendmentList(
        list,
        { ...filters, review: "pending_validation" },
        null,
      ),
    ).toEqual([pending]);
    expect(
      filterAmendmentList(list, { ...filters, review: "validated" }, null),
    ).toEqual([validated]);
    expect(
      filterAmendmentList(list, { ...filters, review: "published" }, null),
    ).toEqual([published, legacy]);
    expect(activeAmendmentFilterCount(filters)).toBe(0);
    expect(
      activeAmendmentFilterCount({ ...filters, review: "validated" }),
    ).toBe(1);
  });

  it("lists the amendments sent back for correction only under their filter", () => {
    const member = {
      id: "m1",
      acronym: "CEUM",
      name: "CEUM",
      kind: "asociado" as const,
    };
    const published = amendment("x", [replace("b1", 0, 6, "Primero")], {
      reviewState: "published",
    });
    const pending = amendment("p", [], { reviewState: "pending_validation" });
    const sentBack = amendment("s", [replace("b2", 0, 2, "Un")], {
      status: "draft",
      reviewState: "correction_requested",
      authors: [member],
    });
    const otherSentBack = amendment("o", [replace("b4", 0, 6, "Último")], {
      status: "draft",
      reviewState: "correction_requested",
      late: true,
    });
    // The author's own correction and an unsent draft are never listed.
    const ownCorrection = amendment("fix", [], {
      status: "draft",
      reviewState: "correction_requested",
      can: { ...amendment("y", []).can, edit: true },
    });
    const unsent = amendment("d", [], { status: "draft", reviewState: null });
    const list = [
      published,
      pending,
      sentBack,
      otherSentBack,
      ownCorrection,
      unsent,
    ];
    const filters = emptyAmendmentFilters();
    const returned = { ...filters, review: "correction_requested" as const };

    expect(AMENDMENT_REVIEW_FILTERS).toContain("correction_requested");
    // Any other review filter keeps drafts out.
    expect(filterAmendmentList(list, filters, null)).toEqual([
      published,
      pending,
    ]);
    expect(
      filterAmendmentList(
        list,
        { ...filters, review: "pending_validation" },
        null,
      ),
    ).toEqual([pending]);
    // Under its own filter, only the returned drafts the viewer cannot edit.
    expect(filterAmendmentList(list, returned, null)).toEqual([
      sentBack,
      otherSentBack,
    ]);
    // The other filters narrow them as usual.
    expect(
      filterAmendmentList(list, { ...returned, memberIds: ["m1"] }, null),
    ).toEqual([sentBack]);
    expect(
      filterAmendmentList(list, { ...returned, late: "late" }, null),
    ).toEqual([otherSentBack]);
    expect(
      filterAmendmentList(list, { ...returned, blockId: "b4" }, null),
    ).toEqual([otherSentBack]);
    expect(
      filterAmendmentList(list, { ...returned, query: "ceum" }, null),
    ).toEqual([sentBack]);
    expect(activeAmendmentFilterCount(returned)).toBe(1);
  });
});

describe("sent notice", () => {
  it("says whether it waits for the Secretaría or is public at once", () => {
    expect(
      amendmentSentNotice({ late: false, reviewState: "pending_validation" }),
    ).toBe("review");
    expect(
      amendmentSentNotice({ late: true, reviewState: "pending_validation" }),
    ).toBe("review_late");
    // A transactional presented by the Mesa is validated and published at once.
    expect(amendmentSentNotice({ late: false, reviewState: "published" })).toBe(
      "public",
    );
  });
});

describe("reader", () => {
  it("finds the neighbours of an amendment in the list on screen", () => {
    const ids = ["a", "b", "c"];
    expect(amendmentNeighbours(ids, "a")).toEqual({
      index: 0,
      total: 3,
      previous: null,
      next: "b",
    });
    expect(amendmentNeighbours(ids, "b")).toEqual({
      index: 1,
      total: 3,
      previous: "a",
      next: "c",
    });
    expect(amendmentNeighbours(ids, "c")).toEqual({
      index: 2,
      total: 3,
      previous: "b",
      next: null,
    });
    expect(amendmentNeighbours(["a"], "a")).toEqual({
      index: 0,
      total: 1,
      previous: null,
      next: null,
    });
  });

  it("gives no neighbours to an amendment the list does not hold", () => {
    // Opened from the text or a link, or filtered out since.
    expect(amendmentNeighbours(["a", "b"], "z")).toEqual({
      index: -1,
      total: 2,
      previous: null,
      next: null,
    });
    expect(amendmentNeighbours(["a", "b"], null)).toEqual({
      index: -1,
      total: 2,
      previous: null,
      next: null,
    });
    expect(amendmentNeighbours([], "a")).toEqual({
      index: -1,
      total: 0,
      previous: null,
      next: null,
    });
  });

  it("tells which chip the filters amount to", () => {
    const empty = emptyAmendmentFilters();
    expect(amendmentQuickFilterOf(empty)).toBe("all");
    // A search narrows any chip.
    expect(amendmentQuickFilterOf({ ...empty, query: "becas" })).toBe("all");
    expect(amendmentQuickFilterOf({ ...empty, statuses: ["submitted"] })).toBe(
      "pending",
    );
    expect(amendmentQuickFilterOf({ ...empty, late: "late" })).toBe("late");
    // Filters with no chip narrow "pending" and "late", never "all".
    expect(
      amendmentQuickFilterOf({
        ...empty,
        statuses: ["submitted"],
        kinds: ["formal"],
      }),
    ).toBe("pending");
    expect(amendmentQuickFilterOf({ ...empty, kinds: ["formal"] })).toBeNull();
    expect(amendmentQuickFilterOf({ ...empty, blockId: "b1" })).toBeNull();
    // Combinations no chip stands for.
    expect(
      amendmentQuickFilterOf({ ...empty, statuses: ["submitted", "approved"] }),
    ).toBeNull();
    expect(
      amendmentQuickFilterOf({
        ...empty,
        statuses: ["submitted"],
        late: "late",
      }),
    ).toBeNull();
    expect(amendmentQuickFilterOf({ ...empty, late: "on_time" })).toBeNull();
    expect(
      amendmentQuickFilterOf({ ...empty, late: "late", mine: true }),
    ).toBeNull();
  });

  it("applies a chip over the current filters", () => {
    const current = {
      ...emptyAmendmentFilters(),
      query: "becas",
      kinds: ["formal" as const],
      late: "on_time" as const,
      mine: true,
      blockId: "b1",
    };
    // "Todas" clears everything but the search.
    expect(applyAmendmentQuickFilter(current, "all")).toEqual({
      ...emptyAmendmentFilters(),
      query: "becas",
    });
    const pending = applyAmendmentQuickFilter(current, "pending");
    expect(pending).toEqual({
      ...current,
      statuses: ["submitted"],
      late: "any",
      mine: false,
    });
    expect(amendmentQuickFilterOf(pending)).toBe("pending");
    const late = applyAmendmentQuickFilter(pending, "late");
    expect(late).toEqual({
      ...current,
      statuses: [],
      late: "late",
      mine: false,
    });
    expect(amendmentQuickFilterOf(late)).toBe("late");
    // Drafts sent back for correction are not presented.
    expect(
      applyAmendmentQuickFilter(
        { ...emptyAmendmentFilters(), review: "correction_requested" },
        "pending",
      ).review,
    ).toBe("any");
    expect(
      applyAmendmentQuickFilter(
        { ...emptyAmendmentFilters(), review: "validated" },
        "pending",
      ).review,
    ).toBe("validated");
  });

  it("the chips filter the list", () => {
    const list = [
      amendment("a1", []),
      amendment("a2", [], { late: true }),
      amendment("a3", [], { status: "approved" }),
      amendment("a4", [], { status: "rejected", late: true }),
    ];
    const ids = (quick: "all" | "pending" | "late") =>
      filterAmendmentList(
        list,
        applyAmendmentQuickFilter(emptyAmendmentFilters(), quick),
        null,
      ).map((item) => item.id);
    expect(ids("all")).toEqual(["a1", "a2", "a3", "a4"]);
    expect(ids("pending")).toEqual(["a1", "a2"]);
    expect(ids("late")).toEqual(["a2", "a4"]);
  });

  it("the unread chip keeps only what the account has left to read", () => {
    const list = [
      amendment("a1", []),
      amendment("a2", [], { late: true }),
      amendment("a3", [], { status: "approved" }),
    ];
    const unread = applyAmendmentQuickFilter(
      { ...emptyAmendmentFilters(), statuses: ["approved"], late: "late" },
      "unread",
    );
    expect(unread).toMatchObject({ unread: true, statuses: [], late: "any" });
    expect(amendmentQuickFilterOf(unread)).toBe("unread");
    expect(activeAmendmentFilterCount(unread)).toBe(1);
    const left = new Set(["a2", "a3"]);
    expect(
      filterAmendmentList(list, unread, null, (id) => left.has(id)).map(
        (item) => item.id,
      ),
    ).toEqual(["a2", "a3"]);
    // Nobody says what is left: nothing is listed.
    expect(filterAmendmentList(list, unread, null)).toEqual([]);
    // The other chips turn it off.
    expect(applyAmendmentQuickFilter(unread, "pending").unread).toBe(false);
    expect(applyAmendmentQuickFilter(unread, "late").unread).toBe(false);
    expect(applyAmendmentQuickFilter(unread, "all").unread).toBe(false);
    // Narrowed by a status it is no chip's list any more.
    expect(
      amendmentQuickFilterOf({ ...unread, statuses: ["submitted"] }),
    ).toBeNull();
  });

  it("shows one status: the review state while it says more", () => {
    const can = amendment("x", []).can;
    // A draft, and one waiting for the Secretaría.
    expect(
      amendmentStatusLine(
        amendment("a", [], { status: "draft", reviewState: null }),
      ),
    ).toMatchObject({ type: "review", view: { key: "draft" } });
    expect(
      amendmentStatusLine(
        amendment("a", [], { reviewState: "pending_validation" }),
      ),
    ).toMatchObject({ type: "review", view: { key: "pending" } });
    expect(
      amendmentStatusLine(
        amendment("a", [], {
          reviewState: "pending_validation",
          can: { ...can, validate: true },
        }),
      ),
    ).toMatchObject({ type: "review", view: { key: "to_validate" } });
    // Published: "Presentada", unless the list asks for "Publicada".
    expect(amendmentStatusLine(amendment("a", []))).toEqual({
      type: "status",
      status: "submitted",
    });
    expect(
      amendmentStatusLine(amendment("a", []), { showPublished: true }),
    ).toMatchObject({ type: "review", view: { key: "published" } });
    // Decided: how it ended, also for the Secretaría that can still publish it.
    expect(
      amendmentStatusLine(
        amendment("a", [], {
          status: "approved",
          reviewState: "validated",
          can: { ...can, publish: true },
        }),
        { showPublished: true },
      ),
    ).toEqual({ type: "status", status: "approved" });
  });
});

describe("compareAmendmentCodes", () => {
  it("orders the numbers of one acronym as numbers", () => {
    const codes = ["CEA 10", "CEA 2", "CEUM 1", "CEA 1", null];
    expect([...codes].sort(compareAmendmentCodes)).toEqual([
      null,
      "CEA 1",
      "CEA 2",
      "CEA 10",
      "CEUM 1",
    ]);
  });

  it("is zero for the same code and for two missing ones", () => {
    expect(compareAmendmentCodes("CEA 3", "CEA 3")).toBe(0);
    expect(compareAmendmentCodes(null, undefined)).toBe(0);
  });
});
