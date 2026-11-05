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
  transactionalAuthorTurn,
  transactionalAuthorsToAsk,
  transactionalComposerSeed,
  transactionalGroupSources,
  transactionalMemberList,
  transactionalNextSteps,
  transactionalPartySources,
  transactionalProgressMessage,
  transactionalProgressOf,
  type TransactionalProgressView,
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
      transactionalIds: ["open", "answered", "rejected", "silent", "hidden"],
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
        // Decided without its answer: nothing to show.
        transactional("silent", "pending", { status: "lapsed" }),
      ].map((item) => [item.id, item]),
    );
    expect(transactionalsOverSource(over, byId).map((t) => t.id)).toEqual([
      "open",
      "answered",
      "rejected",
    ]);
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
          updatedAt: "2026-11-01",
        },
      }),
      amendment("answered", [], {
        can,
        position: {
          position: "accept",
          comment: null,
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

  it("counts one the Secretaría keeps private only when it is voted", () => {
    // Under "vote" the Mesa can answer it already; under "incorporate"
    // accepting it would put unpublished text in the document.
    const list = [amendment("private", [], { can, reviewState: "validated" })];
    expect(proponentReviewBacklog(list, "vote").total).toBe(1);
    expect(proponentReviewBacklog(list, "incorporate").total).toBe(0);
  });
});
