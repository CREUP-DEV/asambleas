import { describe, expect, it } from "vitest";
import type {
  AcceptanceDto,
  AmendmentDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  proponentReviewBacklog,
  transactionalAfterSecretaria,
  transactionalAnswerOf,
  transactionalAnswerNotNeeded,
  transactionalAuthorTurn,
  transactionalClosure,
  transactionalAuthorsToAsk,
  transactionalComposerSeed,
  transactionalGroupSources,
  transactionalLinksOf,
  transactionalMemberList,
  transactionalNextSteps,
  transactionalPartySources,
  transactionalProgressMessage,
  transactionalProgressOf,
  type TransactionalProgressView,
  transactionalRejectedBy,
  transactionalRejectedByAuthors,
  transactionalSameBlocks,
  transactionalSameIds,
  transactionalSourceBlockers,
  transactionalSourceCandidates,
  transactionalSourceEligible,
  transactionalSourceLimit,
  transactionalSourcesInOrder,
  transactionalSourcesReplaced,
  transactionalsOverSource,
} from "./transactional";

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

const member = (id: string): MemberRef => ({
  id,
  acronym: id.toUpperCase(),
  name: `Consejo ${id}`,
  kind: "asociado",
});

const party = (
  id: string,
  role: AcceptanceDto["role"],
  decision: AcceptanceDto["decision"] = "pending",
): AcceptanceDto => ({
  member: member(id),
  role,
  decision,
  decidedAt: decision === "pending" ? null : "2026-11-02T10:00:00.000Z",
  recordedBy: "party",
});

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
  const block = base.find((candidate) => candidate.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from,
    to,
    text,
    baseText: block.text.slice(from, to),
  };
};

const vote: NonNullable<AmendmentDto["outcomeVote"]> = {
  id: "v",
  subjectType: "amendment",
  subjectId: "t",
  method: "show_of_hands",
  inFavor: 1,
  against: 9,
  abstentions: 0,
  blank: 0,
  invalid: 0,
  present: null,
  majority: "simple",
  result: "rejected",
  note: null,
  recordedAt: "2026-11-03T10:00:00.000Z",
};

describe("transactional sources", () => {
  const change = [replace("b2", 3, 10, "Comité")];

  it("combines only published, admitted, undecided amendments with text", () => {
    expect(transactionalSourceEligible(amendment("a", change))).toBe(true);
    // Recorded before validation existed: public.
    expect(
      transactionalSourceEligible(
        amendment("a", change, { reviewState: null }),
      ),
    ).toBe(true);
    const no = (extra: Partial<AmendmentDto>, ops = change) =>
      transactionalSourceEligible(amendment("a", ops, extra));
    expect(no({ status: "draft", reviewState: null })).toBe(false);
    expect(no({ reviewState: "pending_validation" })).toBe(false);
    expect(no({ reviewState: "validated" })).toBe(false);
    expect(no({ reviewState: "pending_authors" })).toBe(false);
    // Late and still waiting for the assembly's decision.
    expect(no({ late: true, admission: "pending" })).toBe(false);
    expect(no({ status: "approved", decidedAt: "2026-11-02" })).toBe(false);
    expect(no({ status: "withdrawn" })).toBe(false);
    expect(no({ status: "transacted" })).toBe(false);
    // A "devolución" has no passage to start from.
    expect(no({ kind: "totality_return" }, [])).toBe(false);
  });

  it("leaves out a transactional its main authors have not all accepted", () => {
    // The Mesa's live one: validated and published at once, authors pending.
    const live = (acceptances: AcceptanceDto[]) =>
      transactionalSourceEligible(
        amendment("t", change, {
          kind: "transactional",
          reviewState: "published",
          acceptances,
        }),
      );
    expect(
      live([party("ceum", "author", "accepted"), party("caub", "author")]),
    ).toBe(false);
    expect(live([party("ceum", "author", "rejected")])).toBe(false);
    expect(
      live([
        party("ceum", "author", "accepted"),
        party("caub", "author", "accepted"),
      ]),
    ).toBe(true);
    // A row left by the removed presenter approval does not hold it back.
    expect(
      live([party("ceum", "author", "accepted"), party("cea", "proponent")]),
    ).toBe(true);
    expect(live([])).toBe(true);
    // Accepted by every main author, but still with the Secretaría (not
    // published): it has not replaced what it groups yet.
    expect(
      transactionalSourceEligible(
        amendment("t", change, {
          kind: "transactional",
          reviewState: "pending_validation",
          admission: "pending",
          acceptances: [party("ceum", "author", "accepted")],
        }),
      ),
    ).toBe(false);
    // Closed by a main author's rejection.
    expect(
      transactionalSourceEligible(
        amendment("t", change, {
          kind: "transactional",
          status: "withdrawn",
          acceptances: [party("ceum", "author", "rejected")],
        }),
      ),
    ).toBe(false);
    // Offered nowhere: not in the candidates, the groups or the composer.
    const pendingLive = amendment("live", change, {
      kind: "transactional",
      acceptances: [party("ceum", "author")],
    });
    const open = amendment("open", change);
    expect(
      transactionalSourceCandidates([pendingLive, open]).map((a) => a.id),
    ).toEqual(["open"]);
    expect(transactionalGroupSources([pendingLive, open])).toEqual(["open"]);
    expect(
      transactionalSourceBlockers(
        ["live", "open"],
        new Map([pendingLive, open].map((item) => [item.id, item])),
      ),
    ).toEqual(["live"]);
  });

  it("lists candidates in text order and picks them from a group", () => {
    const late = amendment("late", change, {
      positionKey: 1,
      late: true,
      admission: "pending",
    });
    const second = amendment("second", change, { positionKey: 3 });
    const first = amendment("first", change, { positionKey: 2 });
    const decided = amendment("decided", change, {
      status: "rejected",
      decidedAt: "2026-11-02",
    });
    expect(
      transactionalSourceCandidates([second, late, decided, first]).map(
        (item) => item.id,
      ),
    ).toEqual(["first", "second"]);
    expect(transactionalGroupSources([late, first, decided, second])).toEqual([
      "first",
      "second",
    ]);
  });

  it("orders sources by presentation for the starting text", () => {
    const list = [
      { id: "c", number: null, positionKey: 1 },
      { id: "b", number: 7, positionKey: 5 },
      { id: "a", number: 3, positionKey: 9 },
      { id: "d", number: 7, positionKey: 2 },
    ];
    expect(transactionalSourcesInOrder(list).map((item) => item.id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("flags chosen sources that can no longer be combined", () => {
    const byId = new Map(
      [
        amendment("open", change),
        amendment("gone", change, {
          status: "approved",
          decidedAt: "2026-11-02",
        }),
      ].map((item) => [item.id, item]),
    );
    expect(
      transactionalSourceBlockers(["open", "gone", "missing"], byId),
    ).toEqual(["gone", "missing"]);
  });

  it("stops adding sources at the server's limit", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
    expect(transactionalSourceLimit(ids(2), 3)).toEqual({
      max: 3,
      full: false,
      over: false,
    });
    // Full: the remaining choices are disabled, but it can still be sent.
    expect(transactionalSourceLimit(ids(3), 3)).toMatchObject({
      full: true,
      over: false,
    });
    // Over: reached without the list (a group, a link); it cannot be sent.
    expect(transactionalSourceLimit(ids(4), 3)).toMatchObject({
      full: true,
      over: true,
    });
    // Repeats count once.
    expect(transactionalSourceLimit(["a", "a", "b"], 2).over).toBe(false);
    // The default is the API's MAX_TRANSACTIONAL_SOURCES (20).
    expect(transactionalSourceLimit(ids(20))).toMatchObject({
      max: 20,
      full: true,
      over: false,
    });
    expect(transactionalSourceLimit(ids(21)).over).toBe(true);
  });

  it("compares id sets and block contents", () => {
    expect(transactionalSameIds(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(transactionalSameIds(["a"], ["a", "b"])).toBe(false);
    expect(transactionalSameBlocks([p("x", "Hola")], [p("y", "Hola")])).toBe(
      true,
    );
    expect(transactionalSameBlocks([p("x", "Hola")], [p("x", "Adiós")])).toBe(
      false,
    );
  });
});

describe("transactional seed", () => {
  it("starts from the passage with the sources applied in order", () => {
    const first = amendment("first", [replace("b2", 3, 10, "Comité")]);
    const second = amendment("second", [replace("b3", 0, 6, "Último")]);
    const seed = transactionalComposerSeed(
      base,
      [first, second].map(({ id, ops }) => ({ id, ops })),
      newId,
    );
    expect(seed.passage.map((block) => block.id)).toEqual(["b2", "b3"]);
    expect(seed.anchorBefore).toBe("b1");
    expect(seed.seed.map((block) => block.text)).toEqual([
      "El Comité financiará la totalidad de las becas.",
      "Último párrafo con más contenido.",
    ]);
    expect(seed.skipped).toEqual([]);
    // Editing nothing more yields the combined change, valid over the base.
    const ops = diffPassage(seed.passage, seed.seed, seed.anchorBefore, newId);
    expect(ops.length).toBeGreaterThan(0);
    expect(validateOps(base, ops)).toEqual([]);
  });

  it("keeps the first source when two collide and reports the other", () => {
    const first = amendment("first", [replace("b2", 3, 10, "Comité")]);
    const clash = amendment("clash", [replace("b2", 3, 10, "Pleno")]);
    const seed = transactionalComposerSeed(
      base,
      [first, clash].map(({ id, ops }) => ({ id, ops })),
      newId,
    );
    expect(seed.seed.map((block) => block.text)).toEqual([
      "El Comité financiará la totalidad de las becas.",
    ]);
    expect(seed.skipped).toEqual(["clash"]);
  });

  it("gives inserted blocks fresh ids and handles an empty choice", () => {
    const insert = amendment("insert", [
      { op: "insert", afterBlockId: "b4", blocks: [p("own", "Nuevo final.")] },
    ]);
    const seed = transactionalComposerSeed(
      base,
      [{ id: insert.id, ops: insert.ops }],
      newId,
    );
    expect(seed.passage.map((block) => block.id)).toEqual(["b4"]);
    expect(seed.seed.map((block) => block.text)).toEqual([
      "Cuarto párrafo final.",
      "Nuevo final.",
    ]);
    expect(seed.seed[1]!.id).not.toBe("own");
    expect(transactionalComposerSeed(base, [], newId)).toEqual({
      passage: [],
      anchorBefore: null,
      seed: [],
      skipped: [],
    });
  });
});

describe("transactional progress", () => {
  const transactional = (extra: Partial<AmendmentDto>) =>
    amendment("t", [replace("b2", 3, 10, "Comité")], {
      kind: "transactional",
      code: "T1",
      sourceIds: ["s1", "s2"],
      ...extra,
    });
  const statusOf =
    (status: AmendmentDto["status"]) =>
    (id: string): AmendmentDto["status"] | undefined =>
      id === "s1" || id === "s2" ? status : undefined;

  it("says nothing for drafts, decided ones and ordinary amendments", () => {
    expect(
      transactionalProgressOf(
        transactional({ status: "draft", reviewState: null }),
        null,
      ),
    ).toBeNull();
    expect(
      transactionalProgressOf(
        transactional({
          status: "approved",
          acceptances: [party("ceum", "author", "accepted")],
        }),
        null,
      ),
    ).toBeNull();
    expect(transactionalProgressOf(amendment("a", []), null)).toBeNull();
  });

  it("waits first for the main authors, who see it is their turn", () => {
    const pending = transactional({
      reviewState: "pending_authors",
      acceptances: [
        party("ceum", "author", "accepted"),
        party("caub", "author"),
        party("ceuca", "author"),
      ],
    });
    const view = transactionalProgressOf(pending, null);
    expect(view).toMatchObject({ stage: "authors", actorTurn: false });
    expect(transactionalMemberList(view!.missing)).toBe("CAUB, CEUCA");
    expect(transactionalProgressOf(pending, "caub")?.actorTurn).toBe(true);
    // A main author who already answered does not have to again.
    expect(transactionalProgressOf(pending, "ceum")?.actorTurn).toBe(false);
  });

  it("waits for the main authors also when the Mesa published it live", () => {
    const live = transactional({
      reviewState: "published",
      acceptances: [party("ceum", "author"), party("caub", "author")],
    });
    expect(transactionalProgressOf(live, "ceum")).toMatchObject({
      stage: "authors",
      actorTurn: true,
    });
  });

  it("is closed as soon as a main author rejects it", () => {
    const acceptances = [
      party("ceum", "author", "rejected"),
      party("caub", "author"),
    ];
    // Kept "submitted" or closed by the server: the rejection is the news.
    for (const status of ["submitted", "rejected", "withdrawn"] as const) {
      const view = transactionalProgressOf(
        transactional({ status, reviewState: "pending_authors", acceptances }),
        "caub",
      );
      expect(view).toMatchObject({ stage: "rejected", actorTurn: false });
      expect(transactionalMemberList(view!.rejected)).toBe("CEUM");
    }
    expect(
      transactionalRejectedByAuthors(
        transactional({ status: "rejected", acceptances }),
      ),
    ).toBe(true);
    // Who closed it, from its acceptances (its outcome note may be empty).
    expect(
      transactionalRejectedBy(
        transactional({ status: "withdrawn", outcomeNote: null, acceptances }),
      ).map((m) => m.acronym),
    ).toEqual(["CEUM"]);
  });

  it("names nobody when no main author rejected it", () => {
    // Still open, closed on its own, or voted down.
    expect(
      transactionalRejectedBy(
        transactional({ acceptances: [party("ceum", "author")] }),
      ),
    ).toEqual([]);
    expect(
      transactionalRejectedBy(
        transactional({
          status: "withdrawn",
          acceptances: [party("ceum", "author")],
        }),
      ),
    ).toEqual([]);
    expect(
      transactionalRejectedBy(
        transactional({
          status: "rejected",
          outcomeVote: vote,
          acceptances: [party("ceum", "author", "rejected")],
        }),
      ),
    ).toEqual([]);
  });

  it("says why it closed on its own", () => {
    // The server stamps the settled amendment and the transactionals it
    // closes with the same instant.
    const at = "2026-11-03T10:00:00.000Z";
    const closed = (status: AmendmentDto["status"], decidedAt = at) =>
      transactional({
        status,
        decidedAt,
        acceptances: [party("ceum", "author")],
      });
    const lookup =
      (
        rows: Record<
          string,
          AmendmentDto["status"] | Pick<AmendmentDto, "status" | "decidedAt">
        >,
      ) =>
      (id: string): Pick<AmendmentDto, "status" | "decidedAt"> | undefined => {
        const row = rows[id];
        if (row === undefined) return undefined;
        if (typeof row !== "string") return row;
        return { status: row, decidedAt: row === "submitted" ? null : at };
      };
    // Another transactional replaced one of its amendments.
    expect(
      transactionalClosure(
        closed("lapsed"),
        lookup({ s1: "submitted", s2: "transacted" }),
      ),
    ).toEqual({ reason: "source_replaced", sourceId: "s2" });
    // One was settled otherwise: the first settled one in its order.
    for (const status of [
      "approved",
      "rejected",
      "withdrawn",
      "lapsed",
      "inadmissible",
    ] as const) {
      expect(
        transactionalClosure(
          closed("withdrawn"),
          lookup({ s1: status, s2: "transacted" }),
        ),
      ).toEqual({ reason: "source_decided", sourceId: "s1" });
    }
    // The same instant written another way still matches.
    expect(
      transactionalClosure(
        closed("withdrawn"),
        lookup({
          s1: { status: "approved", decidedAt: "2026-11-03T11:00:00+01:00" },
        }),
      ),
    ).toEqual({ reason: "source_decided", sourceId: "s1" });
    // Nothing settled in sight (withdrawn by its authors, or hidden).
    expect(
      transactionalClosure(closed("withdrawn"), lookup({ s1: "submitted" })),
    ).toEqual({ reason: "closed", sourceId: null });
    expect(transactionalClosure(closed("withdrawn"))).toEqual({
      reason: "closed",
      sourceId: null,
    });
    // No date on the transactional: nothing can be matched.
    expect(
      transactionalClosure(
        transactional({
          status: "withdrawn",
          decidedAt: null,
          acceptances: [party("ceum", "author")],
        }),
        lookup({ s1: "approved" }),
      ),
    ).toEqual({ reason: "closed", sourceId: null });
    // Open, rejected by a main author, voted, or not a transactional.
    expect(transactionalClosure(closed("submitted"))).toBeNull();
    expect(
      transactionalClosure(
        transactional({
          status: "withdrawn",
          acceptances: [party("ceum", "author", "rejected")],
        }),
      ),
    ).toBeNull();
    expect(
      transactionalClosure(
        transactional({ status: "rejected", outcomeVote: vote }),
      ),
    ).toBeNull();
    expect(
      transactionalClosure(
        amendment("a", [], { status: "withdrawn", sourceIds: ["s1"] }),
        lookup({ s1: "approved" }),
      ),
    ).toBeNull();
  });

  it("does not blame sources settled at another moment", () => {
    const replacedAt = "2026-11-03T10:00:00.000Z";
    const closedAt = "2026-11-03T12:30:00.000Z";
    const lookup =
      (rows: Record<string, Pick<AmendmentDto, "status" | "decidedAt">>) =>
      (id: string) =>
        rows[id];
    // It replaced its own sources (they are "transacted" because of it), and
    // the Mesa withdrew or lapsed it later with no note: nothing replaced it.
    for (const status of ["withdrawn", "lapsed"] as const) {
      expect(
        transactionalClosure(
          transactional({
            status,
            decidedAt: closedAt,
            reviewState: "published",
            acceptances: [party("ceum", "author", "accepted")],
          }),
          lookup({
            s1: { status: "transacted", decidedAt: replacedAt },
            s2: { status: "transacted", decidedAt: replacedAt },
          }),
        ),
      ).toEqual({ reason: "closed", sourceId: null });
    }
    // Its author withdrew it while every source was open; one was voted
    // afterwards, which did not close it.
    expect(
      transactionalClosure(
        transactional({
          status: "withdrawn",
          decidedAt: replacedAt,
          acceptances: [party("ceum", "author")],
        }),
        lookup({
          s1: { status: "approved", decidedAt: closedAt },
          s2: { status: "submitted", decidedAt: null },
        }),
      ),
    ).toEqual({ reason: "closed", sourceId: null });
    // Of two settled sources, the one settled when it closed is named, even
    // if another one comes first in its order.
    expect(
      transactionalClosure(
        transactional({
          status: "withdrawn",
          decidedAt: closedAt,
          acceptances: [party("ceum", "author")],
        }),
        lookup({
          s1: { status: "rejected", decidedAt: "2026-11-04T09:00:00.000Z" },
          s2: { status: "withdrawn", decidedAt: closedAt },
        }),
      ),
    ).toEqual({ reason: "source_decided", sourceId: "s2" });
  });

  it("leaves a transactional voted down to its outcome", () => {
    const voted = transactional({
      status: "rejected",
      decidedAt: "2026-11-03T10:00:00.000Z",
      outcomeVote: {
        id: "v",
        subjectType: "amendment",
        subjectId: "t",
        method: "show_of_hands",
        inFavor: 1,
        against: 9,
        abstentions: 0,
        blank: 0,
        invalid: 0,
        present: null,
        majority: "simple",
        result: "rejected",
        note: null,
        recordedAt: "2026-11-03T10:00:00.000Z",
      },
      acceptances: [party("ceum", "author", "rejected")],
    });
    expect(transactionalRejectedByAuthors(voted)).toBe(false);
    expect(transactionalProgressOf(voted, null)).toBeNull();
    expect(
      transactionalProgressOf(
        transactional({ status: "approved", acceptances: [] }),
        null,
      ),
    ).toBeNull();
  });

  it("then waits for the Secretaría to check and publish it", () => {
    const accepted = [party("ceum", "author", "accepted")];
    expect(
      transactionalProgressOf(
        transactional({
          reviewState: "pending_validation",
          acceptances: accepted,
        }),
        null,
      )?.stage,
    ).toBe("validation");
    // Every main author accepted, the state has not moved on yet.
    expect(
      transactionalProgressOf(
        transactional({
          reviewState: "pending_authors",
          acceptances: accepted,
        }),
        null,
      )?.stage,
    ).toBe("validation");
    expect(
      transactionalProgressOf(
        transactional({ reviewState: "validated", acceptances: accepted }),
        null,
      )?.stage,
    ).toBe("publication");
  });

  it("replaces the originals once validated and accepted", () => {
    const done = transactional({
      acceptances: [party("ceum", "author", "accepted")],
    });
    expect(
      transactionalProgressOf(done, null, statusOf("transacted")),
    ).toMatchObject({
      stage: "replaced",
      color: "success",
      sourceIds: ["s1", "s2"],
    });
    // The list does not show them replaced: no claim is made about them.
    expect(
      transactionalProgressOf(done, null, statusOf("submitted"))?.stage,
    ).toBe("accepted");
    expect(transactionalProgressOf(done, null)?.stage).toBe("accepted");
    // A source the viewer does not see.
    expect(
      transactionalProgressOf(done, null, (id) =>
        id === "s1" ? "transacted" : undefined,
      )?.stage,
    ).toBe("accepted");
    // Late: the assembly decides whether to treat it first.
    expect(
      transactionalProgressOf(
        { ...done, admission: "pending" },
        null,
        statusOf("transacted"),
      )?.stage,
    ).toBe("admission");
  });

  it("tells whether the sources are recorded as replaced", () => {
    expect(transactionalSourcesReplaced(["s1"])).toBeNull();
    expect(transactionalSourcesReplaced([], statusOf("transacted"))).toBeNull();
    expect(
      transactionalSourcesReplaced(["s1", "s2"], statusOf("transacted")),
    ).toBe(true);
    expect(
      transactionalSourcesReplaced(["s1", "s2"], statusOf("submitted")),
    ).toBe(false);
  });
});

describe("transactional progress sentences", () => {
  const view = (
    extra: Partial<TransactionalProgressView>,
  ): TransactionalProgressView => ({
    stage: "authors",
    color: "warning",
    icon: "i-lucide-users",
    missing: [],
    rejected: [],
    sourceIds: ["s1", "s2"],
    actorTurn: false,
    ...extra,
  });
  const message = (
    extra: Partial<TransactionalProgressView>,
    form: "short" | "long",
    words?: Parameters<typeof transactionalProgressMessage>[2],
  ) => transactionalProgressMessage(view(extra), form, words);
  const and = (items: string[]) => items.join(" y ");

  it("names the main authors missing, or tells one it is their turn", () => {
    const missing = [member("ceum"), member("ceuca")];
    expect(message({ missing }, "short")).toEqual({
      key: "transactional.progress.short.authors",
      params: { members: "CEUM, CEUCA" },
    });
    expect(message({ missing }, "long", { join: and })).toEqual({
      key: "transactional.progress.long.authors",
      params: { members: "CEUM y CEUCA" },
    });
    expect(message({ missing, actorTurn: true }, "short")).toEqual({
      key: "transactional.progress.short.yourAnswer",
      params: {},
    });
    expect(message({ missing, actorTurn: true }, "long")).toEqual({
      key: "transactional.progress.long.yourAnswer",
      params: { members: "CEUM, CEUCA" },
    });
  });

  it("names who rejected it, not who is still missing", () => {
    expect(
      message(
        {
          stage: "rejected",
          rejected: [member("ceune")],
          missing: [member("ceum")],
        },
        "long",
      ),
    ).toEqual({
      key: "transactional.progress.long.rejected",
      params: { members: "CEUNE" },
    });
  });

  it("names the amendments it replaced", () => {
    expect(
      message({ stage: "replaced" }, "short", {
        sources: ["CEUM 1", "CAUB 1"],
        join: and,
      }),
    ).toEqual({
      key: "transactional.progress.short.replaced",
      params: { list: "CEUM 1 y CAUB 1" },
    });
    // Without their labels, it says it was accepted.
    expect(message({ stage: "replaced" }, "long")?.key).toBe(
      "transactional.progress.long.accepted",
    );
    expect(message({ stage: "accepted" }, "long")?.key).toBe(
      "transactional.progress.long.accepted",
    );
    expect(message({ stage: "admission" }, "short")?.key).toBe(
      "transactional.progress.short.admission",
    );
  });

  it("leaves the detail to the Secretaría's sentence while it has it", () => {
    for (const stage of ["validation", "publication"] as const) {
      expect(message({ stage }, "long")).toBeNull();
      expect(message({ stage }, "short")?.key).toBe(
        `transactional.progress.short.${stage}`,
      );
    }
  });

  it("says what checking it will do: replace the originals", () => {
    const words = { sources: ["CEUM 1", "CAUB 1"], join: and };
    expect(
      transactionalAfterSecretaria(view({ stage: "validation" }), words),
    ).toEqual({
      key: "transactional.progress.afterSecretaria",
      params: { list: "CEUM 1 y CAUB 1" },
    });
    expect(
      transactionalAfterSecretaria(view({ stage: "publication" }), words, true),
    ).toEqual({
      key: "transactional.progress.alreadyReplaced",
      params: { list: "CEUM 1 y CAUB 1" },
    });
    expect(
      transactionalAfterSecretaria(view({ stage: "publication" }), words),
    ).toBeNull();
    expect(transactionalAfterSecretaria(view({ stage: "validation" }))).toBe(
      null,
    );
    expect(
      transactionalAfterSecretaria(view({ stage: "authors" }), words),
    ).toBeNull();
  });
});

describe("after sending a transactional", () => {
  it("goes to the main authors, the Secretaría, then replaces the originals", () => {
    const steps = transactionalNextSteps(
      {
        reviewState: "pending_authors",
        sourceIds: ["s1", "s2"],
        acceptances: [
          party("prop", "author", "accepted"),
          party("ceum", "author"),
        ],
      },
      "incorporate",
    );
    expect(steps).toEqual([
      { key: "authors", members: [member("ceum")] },
      { key: "secretaria" },
      { key: "replaces", sourceIds: ["s1", "s2"] },
      { key: "answer", rule: "incorporate" },
    ]);
  });

  it("goes straight to the Secretaría when the proposer is every main author", () => {
    expect(
      transactionalNextSteps({
        reviewState: "pending_validation",
        sourceIds: ["s1"],
        acceptances: [party("prop", "author", "accepted")],
      }).map((step) => step.key),
    ).toEqual(["secretaria", "replaces", "answer"]);
  });

  it("is public at once when the Mesa proposes it", () => {
    const steps = transactionalNextSteps({
      reviewState: "published",
      sourceIds: ["s1"],
      acceptances: [party("ceum", "author"), party("caub", "author")],
    });
    expect(steps.map((step) => step.key)).toEqual([
      "authors",
      "replaces",
      "answer",
    ]);
    expect(steps[0]).toEqual({
      key: "authors",
      members: [member("ceum"), member("caub")],
    });
    expect(steps[2]).toEqual({ key: "answer", rule: "vote" });
  });
});

describe("main authors of a transactional", () => {
  const source = (id: string, authors: string[], main: string | null = null) =>
    amendment(id, [], {
      authors: authors.map(member),
      mainAuthorId: main,
    });

  it("asks the main author of each amendment it combines, once", () => {
    const sources = [
      source("a", ["ceum", "caub"], "caub"),
      source("b", ["ceuca"]),
      source("c", ["caub"]),
    ];
    expect(transactionalAuthorsToAsk(sources, null).map((m) => m.id)).toEqual([
      "caub",
      "ceuca",
    ]);
    // The proposer's own answer is taken as given.
    expect(transactionalAuthorsToAsk(sources, "caub").map((m) => m.id)).toEqual(
      ["ceuca"],
    );
    // A co-author who is not the main one is never asked.
    expect(transactionalAuthorsToAsk(sources, "ceum").map((m) => m.id)).toEqual(
      ["caub", "ceuca"],
    );
  });

  it("finds a party's answer and the amendments it answers for", () => {
    const sources = [
      source("a", ["ceum", "caub"], "caub"),
      source("b", ["caub"]),
      source("c", ["ceuca"]),
    ];
    expect(
      transactionalPartySources(sources, "caub").map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(transactionalPartySources(sources, "ceum")).toEqual([]);
    const acceptances = [party("caub", "author", "accepted")];
    expect(transactionalAnswerOf(acceptances, "caub")?.decision).toBe(
      "accepted",
    );
    expect(transactionalAnswerOf(acceptances, "ceum")).toBeNull();
    expect(transactionalAnswerOf(acceptances, null)).toBeNull();
  });

  it("lets only the source's main author answer, while it waits", () => {
    const over = source("a", ["ceum", "caub"], "caub");
    const can = { ...amendment("x", []).can, accept: true };
    const transactional = (
      decision: AcceptanceDto["decision"],
      extra: Partial<AmendmentDto> = {},
    ) =>
      amendment("t", [], {
        kind: "transactional",
        reviewState: "pending_authors",
        acceptances: [party("caub", "author", decision)],
        can,
        ...extra,
      });
    expect(
      transactionalAuthorTurn(transactional("pending"), over, "caub"),
    ).toBe(true);
    // A co-author reads the answer; it does not give it.
    expect(
      transactionalAuthorTurn(transactional("pending"), over, "ceum"),
    ).toBe(false);
    expect(transactionalAuthorTurn(transactional("pending"), over, null)).toBe(
      false,
    );
    expect(
      transactionalAuthorTurn(transactional("accepted"), over, "caub"),
    ).toBe(false);
    expect(
      transactionalAuthorTurn(
        transactional("pending", { status: "withdrawn" }),
        over,
        "caub",
      ),
    ).toBe(false);
    expect(
      transactionalAuthorTurn(
        transactional("pending", { can: { ...can, accept: false } }),
        over,
        "caub",
      ),
    ).toBe(false);
  });

  it("keeps showing the main author's answer once given", () => {
    const over = {
      ...source("a", ["ceum", "caub"], "caub"),
      transactionalIds: [
        "open",
        "answered",
        "rejected",
        "silent",
        "voted",
        "hidden",
      ],
    };
    const transactional = (
      id: string,
      decision: AcceptanceDto["decision"],
      extra: Partial<AmendmentDto> = {},
    ) =>
      amendment(id, [], {
        kind: "transactional",
        acceptances: [party("caub", "author", decision)],
        ...extra,
      });
    const byId = new Map(
      [
        transactional("open", "pending"),
        // Answered, then voted: co-authors still see who accepted it.
        transactional("answered", "accepted", {
          status: "approved",
          decidedAt: "2026-11-03",
        }),
        // Closed by another main author's rejection.
        amendment("rejected", [], {
          kind: "transactional",
          status: "withdrawn",
          acceptances: [
            party("caub", "author"),
            party("ceuca", "author", "rejected"),
          ],
        }),
        // Closed on its own while waiting for its answer: it is told the
        // answer is no longer needed.
        transactional("silent", "pending", { status: "lapsed" }),
        // Voted without its answer: nothing to show.
        transactional("voted", "pending", {
          status: "rejected",
          outcomeVote: vote,
        }),
      ].map((item) => [item.id, item]),
    );
    expect(transactionalsOverSource(over, byId).map((t) => t.id)).toEqual([
      "open",
      "answered",
      "rejected",
      "silent",
    ]);
  });

  it("tells a main author its answer is no longer needed", () => {
    const closed = (
      status: AmendmentDto["status"],
      decision: AcceptanceDto["decision"] = "pending",
      extra: Partial<AmendmentDto> = {},
    ) =>
      amendment("t", [], {
        kind: "transactional",
        status,
        acceptances: [
          party("caub", "author", decision),
          party("ceuca", "author", "accepted"),
        ],
        ...extra,
      });
    // Closed because one of its amendments was settled or replaced.
    expect(transactionalAnswerNotNeeded(closed("withdrawn"), "caub")).toBe(
      true,
    );
    expect(transactionalAnswerNotNeeded(closed("lapsed"), "caub")).toBe(true);
    // Still open: the answer is needed.
    expect(transactionalAnswerNotNeeded(closed("submitted"), "caub")).toBe(
      false,
    );
    // Already answered, or never asked.
    expect(
      transactionalAnswerNotNeeded(closed("withdrawn", "accepted"), "caub"),
    ).toBe(false);
    expect(transactionalAnswerNotNeeded(closed("withdrawn"), "ceum")).toBe(
      false,
    );
    expect(transactionalAnswerNotNeeded(closed("withdrawn"), null)).toBe(false);
    // Closed by another main author's rejection: that is the news.
    expect(
      transactionalAnswerNotNeeded(
        closed("withdrawn", "pending", {
          acceptances: [
            party("caub", "author"),
            party("ceuca", "author", "rejected"),
          ],
        }),
        "caub",
      ),
    ).toBe(false);
    // Voted: its outcome is the news.
    expect(
      transactionalAnswerNotNeeded(
        closed("rejected", "pending", { outcomeVote: vote }),
        "caub",
      ),
    ).toBe(false);
  });
});

describe("the main presenter's review", () => {
  const can = { ...amendment("x", []).can, position: true };

  it("counts the amendments that reached it without an answer", () => {
    const list = [
      amendment("open", [], { can }),
      amendment("pendingPosition", [], {
        can,
        position: {
          position: "pending",
          comment: null,
          recordedBy: "presenter",
          updatedAt: "2026-11-01",
        },
      }),
      amendment("answered", [], {
        can,
        position: {
          position: "accept",
          comment: null,
          recordedBy: "presenter",
          updatedAt: "2026-11-01",
        },
      }),
      amendment("unchecked", [], { can, reviewState: "pending_validation" }),
      amendment("lateWaiting", [], { can, late: true, admission: "pending" }),
      amendment("decided", [], { can, status: "rejected" }),
      amendment("incorporated", [], {
        can,
        status: "approved",
        approvalMethod: "proponent",
        position: {
          position: "accept",
          comment: null,
          recordedBy: "presenter",
          updatedAt: "2026-11-01",
        },
      }),
      amendment("hidden", []),
      amendment("waitingAuthors", [], {
        can,
        kind: "transactional",
        reviewState: "pending_authors",
        acceptances: [party("ceum", "author")],
      }),
      amendment("replaced", [], {
        can,
        kind: "transactional",
        acceptances: [party("ceum", "author", "accepted")],
      }),
      // A row left by the removed presenter approval does not hold it back.
      amendment("olderRow", [], {
        can,
        kind: "transactional",
        acceptances: [
          party("ceum", "author", "accepted"),
          party("cea", "proponent"),
        ],
      }),
    ];
    for (const rule of ["vote", "incorporate"] as const) {
      expect(proponentReviewBacklog(list, rule)).toEqual({
        positions: 4,
        total: 4,
      });
    }
  });

  it("leaves out one the Secretaría keeps private, whatever the rule", () => {
    // Only published amendments are answered: delegates cannot read it yet.
    const list = [amendment("private", [], { can, reviewState: "validated" })];
    expect(proponentReviewBacklog(list, "vote").total).toBe(0);
    expect(proponentReviewBacklog(list, "incorporate").total).toBe(0);
  });

  it("counts nothing once the document was voted", () => {
    const list = [amendment("open", [], { can })];
    expect(proponentReviewBacklog(list, "vote").total).toBe(1);
    expect(
      proponentReviewBacklog(list, "vote", { finalVoted: true }).total,
    ).toBe(0);
    expect(
      proponentReviewBacklog(list, "incorporate", { finalVoted: true }).total,
    ).toBe(0);
  });
});

describe("transactional links of an amendment", () => {
  const source = (id: string, extra: Partial<AmendmentDto> = {}) =>
    amendment(id, [replace("b2", 3, 10, "x")], extra);
  const transactional = (id: string, extra: Partial<AmendmentDto> = {}) =>
    amendment(id, [replace("b2", 3, 10, "y")], {
      kind: "transactional",
      code: id.toUpperCase(),
      ...extra,
    });
  const byIdOf = (...items: AmendmentDto[]) =>
    new Map(items.map((item) => [item.id, item]));

  it("calls a pending transactional over a presented source a proposal", () => {
    const t2 = transactional("t2", {
      reviewState: "pending_authors",
      sourceIds: ["a", "b"],
      acceptances: [party("a", "author", "accepted"), party("b", "author")],
    });
    const a = source("a", { transactionalIds: ["t2"] });
    expect(transactionalLinksOf(a, byIdOf(a, t2))).toEqual({
      replacedBy: [],
      proposed: ["t2"],
    });
  });

  it("leaves out a transactional a main author rejected, still presented", () => {
    const t2 = transactional("t2", {
      sourceIds: ["a", "b"],
      acceptances: [
        party("a", "author", "accepted"),
        party("b", "author", "rejected"),
      ],
    });
    const a = source("a", { transactionalIds: ["t2"] });
    expect(transactionalLinksOf(a, byIdOf(a, t2)).proposed).toEqual([]);
  });

  it("leaves out drafts and transactionals the viewer does not see", () => {
    const draft = transactional("t3", { status: "draft", sourceIds: ["a"] });
    const a = source("a", { transactionalIds: ["t3", "hidden"] });
    expect(transactionalLinksOf(a, byIdOf(a, draft))).toEqual({
      replacedBy: [],
      proposed: [],
    });
  });

  it("names the one that replaced it, also once withdrawn, not a lapsed rival", () => {
    const t1 = transactional("t1", {
      status: "withdrawn",
      validatedAt: "2026-11-02T10:00:00.000Z",
      decidedAt: "2026-11-03T10:00:00.000Z",
      sourceIds: ["a"],
      acceptances: [party("a", "author", "accepted")],
    });
    const rival = transactional("t2", {
      status: "lapsed",
      decidedAt: "2026-11-02T10:00:00.000Z",
      sourceIds: ["a"],
      acceptances: [party("a", "author")],
    });
    const a = source("a", {
      status: "transacted",
      decidedAt: "2026-11-02T10:00:00.000Z",
      transactionalIds: ["t1", "t2"],
    });
    expect(transactionalLinksOf(a, byIdOf(a, t1, rival))).toEqual({
      replacedBy: ["t1"],
      proposed: [],
    });
  });

  it("follows a chain: a replaced transactional names the one over it", () => {
    const t1 = transactional("t1", {
      status: "transacted",
      validatedAt: "2026-11-02T10:00:00.000Z",
      sourceIds: ["a"],
      transactionalIds: ["t3"],
      acceptances: [party("a", "author", "accepted")],
    });
    const t3 = transactional("t3", {
      validatedAt: "2026-11-03T10:00:00.000Z",
      sourceIds: ["t1"],
      acceptances: [party("a", "author", "accepted")],
    });
    const a = source("a", { status: "transacted", transactionalIds: ["t1"] });
    const byId = byIdOf(a, t1, t3);
    expect(transactionalLinksOf(a, byId).replacedBy).toEqual(["t1"]);
    expect(transactionalLinksOf(t1, byId).replacedBy).toEqual(["t3"]);
  });

  it("drops a replacing transactional the viewer does not see", () => {
    const a = source("a", {
      status: "transacted",
      transactionalIds: ["hidden"],
    });
    expect(transactionalLinksOf(a, byIdOf(a)).replacedBy).toEqual([]);
  });

  it("has nothing for a decided or draft amendment", () => {
    const t2 = transactional("t2", { sourceIds: ["a"] });
    for (const status of ["approved", "draft", "withdrawn"] as const) {
      const a = source("a", { status, transactionalIds: ["t2"] });
      expect(transactionalLinksOf(a, byIdOf(a, t2))).toEqual({
        replacedBy: [],
        proposed: [],
      });
    }
  });
});
