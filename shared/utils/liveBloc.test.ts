import { describe, expect, it } from "vitest";
import {
  changedLiveFields,
  isLiveAdmissionProposable,
  nextLivePointer,
  normalizeBloc,
  normalizeBlocPurpose,
  sameBloc,
  type LivePointerFields,
} from "./liveBloc";
import { liveStateBodySchema } from "./schemas/assembly";

const empty: LivePointerFields = {
  agendaItemId: null,
  documentId: null,
  amendmentId: null,
  amendmentBloc: null,
  amendmentBlocOptions: null,
  amendmentBlocPurpose: null,
  voteId: null,
};
const onDocument: LivePointerFields = {
  ...empty,
  agendaItemId: "item",
  documentId: "doc",
};

function next(
  previous: LivePointerFields,
  body: Parameters<typeof nextLivePointer>[1],
  owner: string | null = null,
): LivePointerFields {
  const result = nextLivePointer(previous, body, owner);
  if ("error" in result) throw new Error(result.error);
  return result.next;
}

describe("bloc on screen", () => {
  it("stores no bloc as null and compares blocs by value", () => {
    expect(normalizeBloc([])).toBeNull();
    expect(normalizeBloc(null)).toBeNull();
    expect(normalizeBloc(["a"])).toEqual(["a"]);
    expect(sameBloc(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameBloc(null, [])).toBe(true);
    expect(sameBloc(["a"], ["a", "b"])).toBe(false);
    expect(
      changedLiveFields(
        { ...onDocument, amendmentBloc: ["a", "b"] },
        { ...onDocument, amendmentBloc: ["b", "a"] },
      ),
    ).toEqual([]);
    expect(
      changedLiveFields(onDocument, { ...onDocument, amendmentBloc: ["a"] }),
    ).toEqual(["amendmentBloc"]);
    // Only the pointer: the message and the rest are the caller's.
    expect(
      changedLiveFields(
        { ...onDocument, message: "a" } as LivePointerFields,
        {
          ...onDocument,
          amendmentBloc: ["a"],
          message: "b",
        } as LivePointerFields,
      ),
    ).toEqual(["amendmentBloc"]);
  });

  it("takes the amendment and the vote off when a bloc goes on", () => {
    expect(
      next(
        { ...onDocument, amendmentId: "x", voteId: "v" },
        { amendmentBloc: ["a", "b"] },
        "doc",
      ),
    ).toEqual({ ...onDocument, amendmentBloc: ["a", "b"] });
  });

  it("takes the bloc off when an amendment or a vote goes on", () => {
    const withBloc = { ...onDocument, amendmentBloc: ["a"] };
    expect(next(withBloc, { amendmentId: "x" }, "doc")).toEqual({
      ...onDocument,
      amendmentId: "x",
    });
    expect(next(withBloc, { voteId: "v" })).toEqual({
      ...onDocument,
      voteId: "v",
    });
    // Clearing them leaves the bloc alone.
    expect(next(withBloc, { amendmentId: null, voteId: null })).toEqual(
      withBloc,
    );
    expect(next(withBloc, { amendmentBloc: [] })).toEqual(onDocument);
  });

  it("refuses a bloc with an amendment or a vote", () => {
    expect(
      nextLivePointer(
        onDocument,
        { amendmentBloc: ["a"], amendmentId: "x" },
        "doc",
      ),
    ).toEqual({ error: "bloc_with_pointer" });
    expect(
      nextLivePointer(onDocument, { amendmentBloc: ["a"], voteId: "v" }, "doc"),
    ).toEqual({ error: "bloc_with_pointer" });
    // Taking them off at the same time is fine.
    expect(
      next(
        { ...onDocument, amendmentId: "x" },
        { amendmentBloc: ["a"], amendmentId: null, voteId: null },
        "doc",
      ),
    ).toEqual({ ...onDocument, amendmentBloc: ["a"] });
  });

  it("selects the bloc's document, or refuses another one", () => {
    expect(next(empty, { amendmentBloc: ["a"] }, "doc")).toEqual({
      ...empty,
      documentId: "doc",
      amendmentBloc: ["a"],
    });
    expect(
      nextLivePointer(
        onDocument,
        { documentId: "other", amendmentBloc: ["a"] },
        "doc",
      ),
    ).toEqual({ error: "foreign_document" });
  });

  it("drops the bloc of a document the screen leaves", () => {
    const withBloc = { ...onDocument, amendmentBloc: ["a"] };
    expect(next(withBloc, { documentId: "other" })).toEqual({
      ...onDocument,
      documentId: "other",
    });
    expect(next(withBloc, { documentId: null })).toEqual({
      ...onDocument,
      documentId: null,
    });
    // The same document keeps it.
    expect(next(withBloc, { documentId: "doc" })).toEqual(withBloc);
    // Nothing about the pointer keeps it.
    expect(next(withBloc, {})).toEqual(withBloc);
  });
});

describe("the bloc in PUT .../live-state", () => {
  const id = (n: number) => `amendment${String(n).padStart(16, "0")}`;

  it("takes distinct ids, up to 200, or null to take it off", () => {
    expect(
      liveStateBodySchema.safeParse({ amendmentBloc: [id(1), id(2)] }).success,
    ).toBe(true);
    expect(liveStateBodySchema.safeParse({ amendmentBloc: null }).success).toBe(
      true,
    );
    expect(liveStateBodySchema.safeParse({ amendmentBloc: [] }).success).toBe(
      true,
    );
    expect(
      liveStateBodySchema.safeParse({ amendmentBloc: [id(1), id(1)] }).success,
    ).toBe(false);
    expect(
      liveStateBodySchema.safeParse({
        amendmentBloc: Array.from({ length: 201 }, (_, n) => id(n)),
      }).success,
    ).toBe(false);
    expect(
      liveStateBodySchema.safeParse({ amendmentBloc: ["Not an id"] }).success,
    ).toBe(false);
  });
});

describe("bloc options", () => {
  it("go on screen with their bloc, split exactly", () => {
    expect(
      next(onDocument, {
        amendmentBloc: ["a", "b", "c"],
        amendmentBlocOptions: [["a"], ["b", "c"]],
      }).amendmentBlocOptions,
    ).toEqual([["a"], ["b", "c"]]);
    expect(
      nextLivePointer(
        onDocument,
        { amendmentBloc: ["a", "b"], amendmentBlocOptions: [["a"], ["c"]] },
        null,
      ),
    ).toEqual({ error: "bloc_options" });
  });

  it("leave with their bloc, or when a plain bloc replaces it", () => {
    const alternatives = next(onDocument, {
      amendmentBloc: ["a", "b"],
      amendmentBlocOptions: [["a"], ["b"]],
    });
    expect(next(alternatives, { voteId: "v" }).amendmentBlocOptions).toBeNull();
    expect(
      next(alternatives, { amendmentBloc: ["a", "b"] }).amendmentBlocOptions,
    ).toBeNull();
    expect(
      changedLiveFields(alternatives, {
        ...alternatives,
        amendmentBlocOptions: null,
      }),
    ).toEqual(["amendmentBlocOptions"]);
  });
});

describe("a proposal to admit late amendments", () => {
  const admit = (previous: LivePointerFields = onDocument) =>
    next(previous, {
      amendmentBloc: ["a", "b"],
      amendmentBlocPurpose: "admit",
    });

  it("goes on screen as a bloc with its purpose", () => {
    expect(admit()).toEqual({
      ...onDocument,
      amendmentBloc: ["a", "b"],
      amendmentBlocPurpose: "admit",
    });
    expect(
      next(onDocument, {
        amendmentBloc: ["a"],
        amendmentBlocPurpose: "inadmit",
      }).amendmentBlocPurpose,
    ).toBe("inadmit");
  });

  it("is one pointer: the amendment, the vote and another bloc replace it", () => {
    const proposal = admit({ ...onDocument, amendmentId: "x" });
    expect(proposal.amendmentId).toBeNull();
    expect(next(proposal, { voteId: "v" })).toEqual({
      ...onDocument,
      voteId: "v",
    });
    expect(next(proposal, { amendmentId: "x" }, "doc")).toEqual({
      ...onDocument,
      amendmentId: "x",
    });
    expect(next(proposal, { documentId: "other" })).toEqual({
      ...onDocument,
      documentId: "other",
    });
    expect(next(proposal, { amendmentBloc: null })).toEqual(onDocument);
    // The same amendments proposed for approval: no purpose left behind.
    expect(next(proposal, { amendmentBloc: ["a", "b"] })).toEqual({
      ...onDocument,
      amendmentBloc: ["a", "b"],
    });
    // What does not touch the pointer keeps it.
    expect(next(proposal, {})).toEqual(proposal);
    expect(next(proposal, { documentId: "doc" })).toEqual(proposal);
  });

  it("counts a change of purpose on the same amendments", () => {
    const proposal = admit();
    expect(
      changedLiveFields(proposal, {
        ...proposal,
        amendmentBlocPurpose: "inadmit",
      }),
    ).toEqual(["amendmentBlocPurpose"]);
    expect(
      changedLiveFields(proposal, { ...proposal, amendmentBlocPurpose: null }),
    ).toEqual(["amendmentBlocPurpose"]);
    expect(changedLiveFields(proposal, admit())).toEqual([]);
  });

  it("refuses a purpose without a bloc or with options", () => {
    expect(
      nextLivePointer(onDocument, { amendmentBlocPurpose: "admit" }, null),
    ).toEqual({ error: "bloc_purpose" });
    expect(
      nextLivePointer(
        onDocument,
        { amendmentBloc: [], amendmentBlocPurpose: "admit" },
        null,
      ),
    ).toEqual({ error: "bloc_purpose" });
    expect(
      nextLivePointer(
        onDocument,
        {
          amendmentBloc: ["a", "b"],
          amendmentBlocOptions: [["a"], ["b"]],
          amendmentBlocPurpose: "inadmit",
        },
        null,
      ),
    ).toEqual({ error: "bloc_purpose" });
    // Null is the plain bloc, with or without one.
    expect(
      next(onDocument, { amendmentBloc: null, amendmentBlocPurpose: null }),
    ).toEqual(onDocument);
  });

  it("reads a stored purpose only with a bloc and no options", () => {
    expect(normalizeBlocPurpose("admit", ["a"])).toBe("admit");
    expect(normalizeBlocPurpose("inadmit", ["a"])).toBe("inadmit");
    expect(normalizeBlocPurpose("admit", null)).toBeNull();
    expect(normalizeBlocPurpose("admit", ["a"], [["a"], ["b"]])).toBeNull();
    expect(normalizeBlocPurpose("approve", ["a"])).toBeNull();
    expect(normalizeBlocPurpose(null, ["a"])).toBeNull();
  });

  it("takes only late, published amendments still pending admission", () => {
    const late = {
      late: true,
      status: "submitted",
      admission: "pending",
      validatedAt: "2026-11-21T10:00:00.000Z",
      publishedAt: "2026-11-21T10:00:00.000Z",
    };
    expect(isLiveAdmissionProposable(late)).toBe(true);
    expect(isLiveAdmissionProposable({ ...late, publishedAt: null })).toBe(
      false,
    );
    expect(isLiveAdmissionProposable({ ...late, validatedAt: null })).toBe(
      false,
    );
    expect(isLiveAdmissionProposable({ ...late, late: false })).toBe(false);
    expect(isLiveAdmissionProposable({ ...late, admission: "admitted" })).toBe(
      false,
    );
    expect(
      isLiveAdmissionProposable({
        ...late,
        status: "inadmissible",
        admission: "inadmissible",
      }),
    ).toBe(false);
  });

  it("takes a purpose in PUT .../live-state", () => {
    const id = `amendment${"1".padStart(16, "0")}`;
    expect(
      liveStateBodySchema.safeParse({
        amendmentBloc: [id],
        amendmentBlocPurpose: "admit",
      }).success,
    ).toBe(true);
    expect(
      liveStateBodySchema.safeParse({ amendmentBlocPurpose: null }).success,
    ).toBe(true);
    expect(
      liveStateBodySchema.safeParse({
        amendmentBloc: [id],
        amendmentBlocPurpose: "approve",
      }).success,
    ).toBe(false);
  });
});
