import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import type { ItemVoteBody } from "~~/shared/types/api";
import type { Actor } from "./actor";

// The rules of the item vote paths, over a fake transaction: every select
// answers the next queued result, inserts and updates echo what they write.
// The locks and SQL themselves are the database's (opt-in DB tests).
const state = vi.hoisted(() => ({
  selects: [] as unknown[][],
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
}));

vi.mock("h3", () => ({
  createError: (input: {
    statusCode: number;
    message: string;
    data?: unknown;
  }) => Object.assign(new Error(input.message), input),
}));
vi.mock("../../db", () => {
  /** A query builder: any chained call returns it, awaiting it answers. */
  const query = (): unknown => {
    const node: unknown = new Proxy(() => node, {
      get: (_target, prop) =>
        prop === "then"
          ? (resolve: (value: unknown) => void) =>
              resolve(state.selects.shift() ?? [])
          : () => node,
    });
    return node;
  };
  const stored = (values: Record<string, unknown>) => ({
    id: "v1aaaaaaaaaaaaaaaaaaaaaa",
    recordedAt: new Date("2026-11-22T12:00:00Z"),
    updatedAt: new Date("2026-11-22T12:00:00Z"),
    voidedAt: null,
    ...values,
  });
  const tx = {
    select: () => query(),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          state.inserted.push(values);
          return [stored(values)];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updated.push(values);
            // `sql\`now()\`` comes back as the time it was written.
            const voided = values.voidedAt
              ? { voidedAt: new Date("2026-11-22T12:10:00Z") }
              : {};
            return [stored({ ...values, ...voided })];
          },
        }),
      }),
    }),
  };
  return {
    db: {
      ...tx,
      transaction: (callback: (executor: typeof tx) => unknown) => callback(tx),
    },
  };
});
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./resolvers", () => ({ resolveAgendaItem: vi.fn() }));
vi.mock("./controlSheet", () => ({
  // The reader gets "item" and "titleless"; the second without its title.
  loadReaderItems: vi.fn(async () => ({
    items: new Map([
      ["item", {}],
      ["titleless", {}],
    ]),
    titleHidden: new Set(["titleless"]),
  })),
}));
vi.mock("./amendments", () => ({
  // The majority it is given; the counts are amendments.test.ts's.
  evaluateVoteInput: (
    vote: { majority?: string },
    _settings: unknown,
    defaultMajority: string,
  ) => ({
    majority: vote.majority ?? defaultMajority,
    outcome: { result: "approved" },
  }),
}));
vi.mock("./headcounts", async () => ({
  ...(await vi.importActual<typeof import("./headcounts")>("./headcounts")),
  latestHeadcount: vi.fn(async () => ({ id: "hc1", present: 30 })),
}));
vi.mock("./documents", () => ({
  assemblySettings: (assembly: { settings: object | null }) => ({
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(assembly.settings ?? {}),
  }),
  shareLockAssembly: vi.fn(),
  projectItemVote: vi.fn(async () => true),
  clearLiveVote: vi.fn(),
}));

const { recordEvent } = await import("./events");
const documents = await import("./documents");
const { loadItemVotes, recordItemVote, setVoteUnanimity, voidItemVote } =
  await import("./itemVotes");
const { toItemVoteDto } = await import("./votes");

const VOTE_ID = "v1aaaaaaaaaaaaaaaaaaaaaa";

function makeActor(permissions: PermissionKey[] = []): Actor {
  return {
    user: {
      id: "u".repeat(32),
      name: "Ana",
      email: "ana@example.org",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: null,
      lastRoleSyncAt: null,
      role: null,
    },
    memberId: null,
    isAdmin: false,
    permissions,
    can: (key) => permissions.includes(key),
    impersonation: null,
  };
}

const mesa = makeActor([PERMISSION_KEYS.SESSION_MODERATE]);
const editor = makeActor([PERMISSION_KEYS.CONTROL_SHEET_EDIT]);
const reader = makeActor([PERMISSION_KEYS.CONTROL_SHEET_VIEW]);
const secretaria = makeActor([
  PERMISSION_KEYS.CONTROL_SHEET_EDIT,
  PERMISSION_KEYS.DOCUMENT_MANAGE,
]);

const assembly = {
  id: "asm",
  status: "in_session",
  settings: DEFAULT_ASSEMBLY_SETTINGS,
} as unknown as Parameters<typeof recordItemVote>[1];
const item = {
  id: "item",
  assemblyId: "asm",
  generatedForDocumentId: null,
  hiddenWithDocumentId: null,
  titleWithheld: false,
} as unknown as Parameters<typeof recordItemVote>[2];

/** The selects of a recording: the item again, then its documents. */
function recording(
  status: string,
  itemDocuments: { voted: boolean; status: string }[] = [],
  current: Record<string, unknown> = item as never,
) {
  vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
    status,
    settings: DEFAULT_ASSEMBLY_SETTINGS,
  } as never);
  state.selects.push([current], itemDocuments);
}

const body = (vote: ItemVoteBody["vote"], project?: boolean): ItemVoteBody => ({
  question: "Ratificación de la Mesa",
  vote,
  ...(project === undefined ? {} : { project }),
});

beforeEach(() => {
  state.selects.length = 0;
  state.inserted.length = 0;
  state.updated.length = 0;
  vi.mocked(recordEvent).mockClear();
  vi.mocked(documents.projectItemVote).mockClear();
  vi.mocked(documents.clearLiveVote).mockClear();
});

describe("recordItemVote", () => {
  it("is the Mesa's and the sheet editors', and only the Mesa projects", async () => {
    await expect(
      recordItemVote(reader, assembly, item, body({ method: "assent" })),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      recordItemVote(editor, assembly, item, body({ method: "assent" }, true)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a draft or closed assembly, read under the lock", async () => {
    for (const status of ["draft", "closed"]) {
      recording(status);
      await expect(
        recordItemVote(mesa, assembly, item, body({ method: "assent" })),
      ).rejects.toMatchObject({
        statusCode: 409,
        data: { messageKey: "common.errors.voteNotInSession" },
      });
    }
    expect(state.inserted).toEqual([]);
  });

  it("refuses an item voted through its documents", async () => {
    recording("in_session", [
      { voted: false, status: "published" },
      { voted: true, status: "published" },
    ]);
    await expect(
      recordItemVote(editor, assembly, item, body({ method: "assent" })),
    ).rejects.toMatchObject({
      statusCode: 422,
      data: { reason: "item_has_voted_documents" },
    });
    expect(state.inserted).toEqual([]);
  });

  it("names no document a sheet editor may not see yet", async () => {
    // A published document that is not voted says nothing of the other.
    const submitted = [
      { voted: true, status: "submitted" },
      { voted: false, status: "published" },
    ];
    recording("in_session", submitted);
    await expect(
      recordItemVote(editor, assembly, item, body({ method: "assent" })),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "Este punto no admite ahora una votación propia",
      data: { reason: "item_takes_no_vote" },
    });

    // The Mesa and the document managers see it: told why.
    for (const actor of [mesa, secretaria]) {
      recording("in_session", submitted);
      await expect(
        recordItemVote(actor, assembly, item, body({ method: "assent" })),
      ).rejects.toMatchObject({
        statusCode: 422,
        data: { reason: "item_has_voted_documents" },
      });
    }

    // A published one is everyone's: the editor is told why too.
    recording("in_session", [
      ...submitted,
      { voted: true, status: "published" },
    ]);
    await expect(
      recordItemVote(editor, assembly, item, body({ method: "assent" })),
    ).rejects.toMatchObject({
      statusCode: 422,
      data: { reason: "item_has_voted_documents" },
    });
    expect(state.inserted).toEqual([]);
  });

  it("refuses an item where members present", async () => {
    recording("in_session", [], { ...item, acceptsSubmissions: true });
    await expect(
      recordItemVote(editor, assembly, item, body({ method: "assent" })),
    ).rejects.toMatchObject({
      statusCode: 422,
      data: { reason: "item_is_container" },
    });
    expect(state.inserted).toEqual([]);
  });

  it("takes withdrawn, postponed and draft documents as not voting it", async () => {
    recording("convened", [
      { voted: true, status: "withdrawn" },
      { voted: true, status: "postponed" },
      { voted: true, status: "draft" },
    ]);
    const result = await recordItemVote(
      editor,
      assembly,
      item,
      body({ method: "assent", unanimous: true }),
    );
    expect(result.projected).toBe(false);
    expect(result.vote.unanimous).toBe(true);
  });

  it("stores the question, a simple majority and the latest headcount", async () => {
    recording("in_session");
    const result = await recordItemVote(
      mesa,
      assembly,
      item,
      body({
        method: "show_of_hands",
        inFavor: 20,
        against: 3,
        abstentions: 1,
        // Only an assent is unanimous.
        unanimous: true,
      }),
    );
    expect(state.inserted).toEqual([
      expect.objectContaining({
        subjectType: "agenda_item",
        subjectId: "item",
        question: "Ratificación de la Mesa",
        majority: "simple",
        result: "approved",
        unanimous: false,
        headcountId: "hc1",
        present: 30,
        note: null,
      }),
    ]);
    expect(result.vote).toMatchObject({
      subjectType: "agenda_item",
      question: "Ratificación de la Mesa",
      voidedAt: null,
    });
    expect(documents.projectItemVote).not.toHaveBeenCalled();
  });

  it("records the event without the live documentId, the title's document in the payload", async () => {
    recording("in_session", [], {
      ...item,
      generatedForDocumentId: "doc",
    });
    await recordItemVote(mesa, assembly, item, body({ method: "assent" }));
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(recordEvent).mock.calls[0]![1];
    expect(event).not.toHaveProperty("documentId");
    expect(event).toMatchObject({
      entityType: "vote",
      entityId: VOTE_ID,
      type: "vote_recorded",
      payload: {
        subjectType: "agenda_item",
        subjectId: "item",
        result: "approved",
        auto: true,
        documentId: "doc",
      },
    });
  });

  it("projects only when asked, and says whether it went on screen", async () => {
    recording("in_session");
    const shown = await recordItemVote(
      mesa,
      assembly,
      item,
      body({ method: "assent" }, true),
    );
    expect(shown.projected).toBe(true);
    expect(documents.projectItemVote).toHaveBeenCalledWith(expect.anything(), {
      assemblyId: "asm",
      voteId: VOTE_ID,
      agendaItemId: "item",
      actor: mesa,
    });

    vi.mocked(documents.projectItemVote).mockResolvedValueOnce(false);
    recording("in_session");
    const moved = await recordItemVote(
      mesa,
      assembly,
      item,
      body({ method: "assent" }, true),
    );
    expect(moved.projected).toBe(false);
  });
});

describe("voidItemVote", () => {
  const stored = (values: Record<string, unknown> = {}) => ({
    id: VOTE_ID,
    subjectType: "agenda_item",
    subjectId: "item",
    method: "show_of_hands",
    result: "approved",
    updatedAt: new Date("2026-11-22T12:00:00Z"),
    voidedAt: null,
    ...values,
  });
  const token = { updatedAt: "2026-11-22T12:00:00.000Z" };

  it("voids only votes on agenda items", async () => {
    state.selects.push([{ subjectType: "document", subjectId: "doc" }]);
    await expect(
      voidItemVote(mesa, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "common.errors.voteNotVoidable" },
    });
  });

  it("refuses a closed assembly and a vote already voided", async () => {
    state.selects.push([{ subjectType: "agenda_item", subjectId: "item" }]);
    vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
      status: "closed",
    } as never);
    await expect(
      voidItemVote(editor, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({ statusCode: 409 });

    state.selects.push(
      [{ subjectType: "agenda_item", subjectId: "item" }],
      [stored({ voidedAt: new Date() })],
    );
    vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
      status: "in_session",
    } as never);
    await expect(
      voidItemVote(editor, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "common.errors.voteVoided" },
    });
  });

  it("keeps the row, records the event and takes it off screen", async () => {
    state.selects.push(
      [{ subjectType: "agenda_item", subjectId: "item" }],
      [stored()],
      [
        {
          generatedForDocumentId: null,
          hiddenWithDocumentId: null,
          titleWithheld: false,
        },
      ],
    );
    vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
      status: "in_session",
    } as never);
    await voidItemVote(editor, assembly, VOTE_ID, token);
    expect(state.updated).toEqual([
      expect.objectContaining({ voidedByUserId: editor.user.id }),
    ]);
    expect(vi.mocked(recordEvent).mock.calls[0]![1]).toMatchObject({
      type: "vote_voided",
      payload: {
        subjectType: "agenda_item",
        subjectId: "item",
        result: "approved",
      },
    });
    expect(documents.clearLiveVote).toHaveBeenCalledWith(expect.anything(), {
      assemblyId: "asm",
      voteId: VOTE_ID,
      actor: editor,
    });
  });

  it("answers 409 to a stale token", async () => {
    state.selects.push(
      [{ subjectType: "agenda_item", subjectId: "item" }],
      [stored({ updatedAt: new Date("2026-11-22T12:05:00Z") })],
    );
    vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
      status: "in_session",
    } as never);
    await expect(
      voidItemVote(mesa, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(state.updated).toEqual([]);
  });
});

describe("setVoteUnanimity", () => {
  const token = { unanimous: true, updatedAt: "2026-11-22T12:00:00.000Z" };

  it("leaves a document's final vote to the Mesa and refuses other subjects", async () => {
    state.selects.push([{ subjectType: "document", subjectId: "doc" }]);
    await expect(
      setVoteUnanimity(editor, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({ statusCode: 403 });

    state.selects.push([{ subjectType: "amendment", subjectId: "a1" }]);
    await expect(
      setVoteUnanimity(mesa, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({
      statusCode: 422,
      data: { messageKey: "common.errors.voteUnanimityRefused" },
    });
  });

  it("takes only an assent, and only one its document still points at", async () => {
    const lockOpen = () =>
      vi.mocked(documents.shareLockAssembly).mockResolvedValueOnce({
        status: "in_session",
      } as never);
    const vote = (values: Record<string, unknown>) => ({
      id: VOTE_ID,
      subjectType: "document",
      subjectId: "doc",
      method: "assent",
      unanimous: false,
      updatedAt: new Date("2026-11-22T12:00:00Z"),
      voidedAt: null,
      ...values,
    });

    lockOpen();
    state.selects.push(
      [{ subjectType: "document", subjectId: "doc" }],
      [{ finalVoteId: VOTE_ID }],
      [vote({ method: "show_of_hands" })],
    );
    await expect(
      setVoteUnanimity(mesa, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({ statusCode: 422 });

    lockOpen();
    state.selects.push(
      [{ subjectType: "document", subjectId: "doc" }],
      [{ finalVoteId: null }],
      [vote({})],
    );
    await expect(
      setVoteUnanimity(mesa, assembly, VOTE_ID, token),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "common.errors.voteNotInForce" },
    });

    lockOpen();
    state.selects.push(
      [{ subjectType: "document", subjectId: "doc" }],
      [{ finalVoteId: VOTE_ID }],
      [vote({})],
    );
    const result = await setVoteUnanimity(mesa, assembly, VOTE_ID, token);
    expect(result.unanimous).toBe(true);
    // A document's: its pages refresh on the live event.
    expect(vi.mocked(recordEvent).mock.calls[0]![1]).toMatchObject({
      type: "vote_unanimity_changed",
      documentId: "doc",
      payload: { subjectType: "document", subjectId: "doc", unanimous: true },
    });
  });
});

describe("questions of items read without their title", () => {
  const voteRow = (
    id: string,
    subjectId: string,
    subjectType: "agenda_item" | "document" = "agenda_item",
  ) => ({
    id,
    assemblyId: "asm",
    subjectType,
    subjectId,
    method: "assent" as const,
    inFavor: 0,
    against: 0,
    abstentions: 0,
    blank: 0,
    invalid: 0,
    present: null,
    headcountId: null,
    majority: "simple" as const,
    result: "approved" as const,
    note: null,
    question: "Ratificación de la Mesa",
    unanimous: false,
    recordedByUserId: null,
    recordedAt: new Date("2026-11-22T12:00:00Z"),
    updatedAt: new Date("2026-11-22T12:00:00Z"),
    voidedAt: null,
    voidedByUserId: null,
  });

  it("drops the question only on a vote of such an item", () => {
    const hidden = new Set(["titleless"]);
    expect(
      toItemVoteDto(voteRow("a", "titleless") as never, hidden).question,
    ).toBeNull();
    expect(toItemVoteDto(voteRow("b", "item") as never, hidden).question).toBe(
      "Ratificación de la Mesa",
    );
    // Not an item's vote: nothing to do with its title.
    expect(
      toItemVoteDto(voteRow("c", "titleless", "document") as never, hidden)
        .question,
    ).toBe("Ratificación de la Mesa");
  });

  it("reads the votes of the items the reader gets, as its agenda sends them", async () => {
    state.selects.push([
      voteRow("a", "item"),
      voteRow("b", "titleless"),
      voteRow("c", "elsewhere"),
    ]);
    const { votes } = await loadItemVotes(reader, assembly);
    expect(votes.map((vote) => [vote.id, vote.question])).toEqual([
      ["a", "Ratificación de la Mesa"],
      ["b", null],
    ]);
  });
});
