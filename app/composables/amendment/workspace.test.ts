import { describe, expect, it } from "vitest";
import type { AmendmentDto } from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  activeAmendmentFilterCount,
  amendmentBlockMarkers,
  amendmentComposerSteps,
  amendmentHistoryVersion,
  amendmentDisplayLabel,
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentOverlapIndex,
  composerAuthorMemberIds,
  composerAuthorSeed,
  composerSyncState,
  consolidationInputs,
  contiguousBlockRange,
  deletePassageOps,
  draftPassage,
  emptyAmendmentFilters,
  extendBlockSelection,
  filterAmendmentList,
  groupAmendmentsByOverlap,
  isAmendmentPrivate,
  isNewerAmendmentVersion,
  mineAmendments,
  passageAmendmentOps,
  passageSeed,
  seedComposerFromDraft,
  showAmendmentAdmission,
  totalityAlternativeOps,
  amendmentLateOnSend,
  amendmentReviewQueue,
  amendmentReviewSentenceKey,
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
    ).toEqual({ toValidate: 2, toPublish: 1 });
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
});

describe("composer steps", () => {
  it("skips what a mode does not need", () => {
    expect(amendmentComposerSteps("passage")).toEqual([
      "what",
      "write",
      "check",
      "why",
    ]);
    expect(amendmentComposerSteps("global")).toEqual([
      "what",
      "write",
      "check",
      "why",
    ]);
    expect(amendmentComposerSteps("alternative")).toEqual([
      "what",
      "write",
      "check",
      "why",
    ]);
    expect(amendmentComposerSteps("delete")).toEqual(["what", "check", "why"]);
    expect(amendmentComposerSteps("return")).toEqual(["what", "why"]);
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
