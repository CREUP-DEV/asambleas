import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

// The Mesa's scope of the notices through loadWorkNews itself: the database
// answers each awaited read with the next rows queued (a read never awaited,
// such as a subquery, takes none), and visibility lets everything through,
// so the wiring is checked: who gets the scope, its query, the merge with
// the member's and what each row carries.
const reads = vi.hoisted(() => ({ queue: [] as unknown[][], count: 0 }));

vi.mock("../../db", () => {
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) => {
              reads.count += 1;
              return resolve(reads.queue.shift() ?? []);
            };
          }
          return () => chain();
        },
      },
    );
  return { db: { select: () => chain(), selectDistinct: () => chain() } };
});
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./amendments", () => ({
  canSeeLoadedAmendment: () => true,
  findAmendmentsByIds: vi.fn(),
}));
vi.mock("./presenters", () => ({
  coPresentedBy: () => undefined,
  withCoProponentIds: async (rows: object[]) =>
    rows.map((row) => ({ ...row, coProponentMemberIds: [] })),
}));
vi.mock("./impersonators", () => ({
  impersonatedByFor: () => null,
  loadImpersonators: async () => new Map(),
  seesImpersonator: () => false,
}));
vi.mock("./visibility", () => ({
  canSeeDocument: () => true,
  canSeePositions: () => true,
  isDocumentPresenter: () => false,
  redactMember: (_actor: unknown, member: unknown) => member,
  seesOthersValidatedAmendments: () => true,
  seesUnpublishedPositions: () => true,
}));

const { loadWorkNews } = await import("./news");
const { findAmendmentsByIds } = await import("./amendments");
const { testActor } = await import("../../testing/actor");

const NOW = new Date("2026-11-26T12:00:00Z");
const assembly = {
  ref: { id: "s1", slug: "80-ago", label: "80.ª AGO" },
  settings: {} as never,
  status: "in_session" as const,
};
const documentRow = {
  id: "d1",
  slug: "estatutos",
  title: "Estatutos",
  status: "published",
  proponentMemberId: "cea",
  submittedByUserId: null,
  positionsPublishedAt: null,
  positionsDebateStartedAt: null,
  acceptedAmendments: "vote",
  finalVoteId: null,
  proponentKind: "executive",
};

function event(
  id: string,
  minutesAgo: number,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    assemblyId: "s1",
    entityType: "amendment",
    entityId: "am1",
    type: "amendment_validated",
    payload: { admission: "admitted", method: "secretaria" },
    actorUserId: "secretaria",
    actorMemberId: null,
    impersonationId: null,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    ...over,
  };
}

function amendment(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    documentId: "d1",
    code: id.toUpperCase(),
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    validatedAt: new Date("2026-11-20T10:00:00Z"),
    publishedAt: null,
    approvalMethod: null,
    position: null,
    acceptances: [],
    meta: null,
    ...over,
  };
}

const moderator = (over: Parameters<typeof testActor>[0] = {}) =>
  testActor({ permissions: [PERMISSION_KEYS.SESSION_MODERATE], ...over });

beforeEach(() => {
  reads.queue = [];
  reads.count = 0;
  vi.mocked(findAmendmentsByIds).mockReset();
});

describe("loadWorkNews, the Mesa's scope", () => {
  it("reads nothing for an account with no member that does not moderate", async () => {
    const result = await loadWorkNews(testActor(), [assembly], NOW);
    expect(result).toEqual({
      news: [],
      watchDocumentIds: [],
      watchAssemblyIds: [],
    });
    expect(reads.count).toBe(0);
  });

  it("tells a moderator without a member, grouped by document, and watches the assembly", async () => {
    const t1 = amendment("t1", {
      kind: "transactional",
      validatedAt: null,
      acceptances: [
        {
          memberId: "ugr",
          role: "author",
          decision: "accepted",
          decidedAt: new Date(NOW.getTime() - 50 * 60_000),
        },
        {
          memberId: "upv",
          role: "author",
          decision: "accepted",
          decidedAt: new Date(NOW.getTime() - 40 * 60_000),
        },
      ],
    });
    reads.queue = [
      // The Mesa's query, newest first.
      [
        event("v3", 1, { entityId: "am3" }),
        event("v2", 2, { entityId: "am2" }),
        // The last party's acceptance: ready.
        event("ready", 40, {
          entityId: "t1",
          type: "acceptance_recorded",
          payload: { memberId: "upv", role: "author", decision: "accepted" },
          actorUserId: "upv-user",
          actorMemberId: "upv",
        }),
        // An earlier party's: not ready then.
        event("early", 50, {
          entityId: "t1",
          type: "acceptance_recorded",
          payload: { memberId: "ugr", role: "author", decision: "accepted" },
          actorUserId: "ugr-user",
          actorMemberId: "ugr",
        }),
      ],
      // The documents.
      [documentRow],
      // Who did it.
      [{ id: "upv", acronym: "UPV", name: "UPV", kind: "asociado" }],
    ];
    vi.mocked(findAmendmentsByIds).mockResolvedValue([
      amendment("am2"),
      amendment("am3"),
      t1,
    ] as never);

    const result = await loadWorkNews(moderator(), [assembly], NOW);
    expect(result.watchAssemblyIds).toEqual(["s1"]);
    expect(result.watchDocumentIds).toEqual([]);
    expect(result.news).toHaveLength(2);
    const [group, ready] = result.news;
    expect(group).toMatchObject({
      id: "v3",
      type: "amendment_validated",
      asMesa: true,
      count: 2,
      amendment: null,
      by: null,
    });
    expect(group).not.toHaveProperty("asPresenter");
    expect(group).not.toHaveProperty("awaitsAnswer");
    expect(group!.amendments!.map((item) => item.code)).toEqual(["AM2", "AM3"]);
    expect(ready).toMatchObject({
      id: "ready",
      type: "acceptance_recorded",
      value: "ready",
      asMesa: true,
      ownAmendment: false,
      amendment: { id: "t1", code: "T1", kind: "transactional" },
      by: { id: "upv", acronym: "UPV" },
    });
  });

  it("gives no validations to an account that validates amendments", async () => {
    // The mocked query ignores the SQL filter, so a validation is read
    // anyway: only the scope's check in loadWorkNews may leave it out.
    const queue = () => [
      [
        event("val", 3, { entityId: "am2" }),
        event("rejected", 5, {
          type: "acceptance_recorded",
          payload: { memberId: "upv", role: "author", decision: "rejected" },
          actorUserId: "upv-user",
          actorMemberId: "upv",
        }),
      ],
      [documentRow],
      [{ id: "upv", acronym: "UPV", name: "UPV", kind: "asociado" }],
    ];
    const amendments = [
      amendment("am1", { kind: "transactional", status: "withdrawn" }),
      amendment("am2"),
    ];
    vi.mocked(findAmendmentsByIds).mockResolvedValue(amendments as never);
    reads.queue = queue();
    const actor = moderator({
      permissions: [
        PERMISSION_KEYS.SESSION_MODERATE,
        PERMISSION_KEYS.AMENDMENT_REVIEW,
      ],
    });
    const result = await loadWorkNews(actor, [assembly], NOW);
    expect(result.news.map((item) => [item.id, item.value])).toEqual([
      ["rejected", "rejected"],
    ]);

    // The same events for a moderator who does not validate: told.
    reads.queue = queue();
    const told = await loadWorkNews(moderator(), [assembly], NOW);
    expect(told.news.map((item) => [item.id, item.value])).toEqual([
      ["val", "admitted"],
      ["rejected", "rejected"],
    ]);
  });

  it("tells an inclusion ready only while it waits for the Secretaría", async () => {
    const t1 = amendment("t1", { kind: "transactional", validatedAt: null });
    const run = async (status: string | null) => {
      reads.queue = [
        [
          event("inclusion", 5, {
            entityId: "t1",
            type: "transactional_revision_ready",
            payload: { revisionId: "r1" },
            actorUserId: "upv-user",
            actorMemberId: "upv",
          }),
        ],
        // The inclusion's status, read beside the amendments.
        status === null ? [] : [{ id: "r1", status }],
        [documentRow],
      ];
      vi.mocked(findAmendmentsByIds).mockResolvedValue([t1] as never);
      const result = await loadWorkNews(moderator(), [assembly], NOW);
      return result.news.map((item) => item.id);
    };
    expect(await run("pending_validation")).toEqual(["inclusion"]);
    // Validated (applied) or cancelled since: the transactional is still
    // undecided, but the notice no longer holds.
    expect(await run("applied")).toEqual([]);
    expect(await run("cancelled")).toEqual([]);
    expect(await run(null)).toEqual([]);
  });

  it("tells an account with both scopes each event once, the member's way", async () => {
    const own = event("own-validated", 3, { entityId: "mine" });
    reads.queue = [
      // The member's scopes: presented, answered, authored, overOwn.
      [],
      [],
      [{ id: "mine", documentId: "d1" }],
      [],
      // The member's query and the Mesa's both read the same event.
      [own],
      [own, event("other", 4, { entityId: "am2" })],
      [documentRow],
    ];
    vi.mocked(findAmendmentsByIds).mockResolvedValue([
      amendment("mine"),
      amendment("am2"),
    ] as never);
    const result = await loadWorkNews(
      moderator({ memberId: "ucm" }),
      [assembly],
      NOW,
    );
    expect(result.watchDocumentIds).toEqual(["d1"]);
    expect(result.watchAssemblyIds).toEqual(["s1"]);
    expect(
      result.news.map((item) => ({
        id: item.id,
        own: item.ownAmendment,
        mesa: item.asMesa ?? false,
      })),
    ).toEqual([
      { id: "own-validated", own: true, mesa: false },
      { id: "other", own: false, mesa: true },
    ]);
  });
});
