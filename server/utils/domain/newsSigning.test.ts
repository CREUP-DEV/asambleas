import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

// The signers' scope of the notices (an acta to sign again) through
// loadWorkNews itself: the database answers each awaited read with the next
// rows queued and keeps every `where` it was given, and visibility lets
// everything through, so the wiring is checked: who gets the scope, its
// query, when a notice stands and what each row carries.
const reads = vi.hoisted(() => ({
  queue: [] as unknown[][],
  count: 0,
  wheres: [] as unknown[],
}));

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
          if (prop === "where") {
            return (condition: unknown) => {
              reads.wheres.push(condition);
              return chain();
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

const {
  loadWorkNews,
  newsValue,
  signatureVoidStands,
  signingNewsScope,
  signingRowsOnce,
  isSigningNews,
  NEWS_SIGNATURE_VOIDED,
} = await import("./news");
const { findAmendmentsByIds } = await import("./amendments");
const { testActor, TEST_ACTOR_ID } = await import("../../testing/actor");

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

const NOW = new Date("2026-11-26T12:00:00Z");
const assembly = {
  ref: { id: "s1", slug: "80-ago", label: "80.ª AGO" },
  settings: {} as never,
  status: "in_session" as const,
};
const acta = {
  id: "d1",
  slug: "acta-79-ago",
  title: "Acta de la 79.ª AGO",
  status: "published",
  proponentMemberId: null,
  submittedByUserId: null,
  positionsPublishedAt: null,
  positionsDebateStartedAt: null,
  acceptedAmendments: "vote",
  finalVoteId: "v1",
  consolidatedVersionId: "ver2",
  generated: null,
  proponentKind: null,
};

function voided(
  id: string,
  minutesAgo: number,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    assemblyId: "s1",
    entityType: "document",
    entityId: "d1",
    type: "document_signature_voided",
    payload: { reason: "form_correction", fileName: "acta.pdf" },
    actorUserId: "mesa-user",
    actorMemberId: null,
    impersonationId: null,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    ...over,
  };
}

const signer = (over: Parameters<typeof testActor>[0] = {}) =>
  testActor({ permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE], ...over });

beforeEach(() => {
  reads.queue = [];
  reads.count = 0;
  reads.wheres = [];
  vi.mocked(findAmendmentsByIds).mockReset();
  vi.mocked(findAmendmentsByIds).mockResolvedValue([]);
});

describe("the signers' rules", () => {
  it("is the scope of whoever manages documents", () => {
    expect(signingNewsScope(signer())).toBe(true);
    expect(
      signingNewsScope(
        testActor({ permissions: [PERMISSION_KEYS.SESSION_MODERATE] }),
      ),
    ).toBe(false);
    expect(isSigningNews(voided("e", 1), true)).toBe(true);
    expect(isSigningNews(voided("e", 1), false)).toBe(false);
    expect(
      isSigningNews(voided("e", 1, { entityType: "amendment" }), true),
    ).toBe(false);
  });

  it("stands until a signature signs the text in force", () => {
    const document = { consolidatedVersionId: "ver2" };
    const signedAt = new Date("2026-11-26T11:00:00Z");
    expect(signatureVoidStands(document, undefined)).toBe(true);
    // The row emptied by clearSigning.
    expect(
      signatureVoidStands(document, {
        url: null,
        signedAt: null,
        versionId: null,
      }),
    ).toBe(true);
    // Signed for an earlier text.
    expect(
      signatureVoidStands(document, {
        url: "/api/files/x.pdf",
        signedAt,
        versionId: "ver1",
      }),
    ).toBe(true);
    expect(
      signatureVoidStands(document, {
        url: "/api/files/x.pdf",
        signedAt,
        versionId: "ver2",
      }),
    ).toBe(false);
    // No approved text in force (final vote annulled or rejected): nothing
    // to sign yet, so it waits hidden.
    expect(
      signatureVoidStands(
        { consolidatedVersionId: null },
        { url: "/api/files/x.pdf", signedAt, versionId: null },
      ),
    ).toBe(false);
    expect(
      signatureVoidStands({ consolidatedVersionId: null }, undefined),
    ).toBe(false);
  });

  it("keeps the latest row per document", () => {
    const rows = [
      { id: "new", entityId: "d1", signing: true },
      { id: "other", entityId: "d2", signing: true },
      { id: "old", entityId: "d1", signing: true },
      { id: "news", entityId: "d1", signing: false },
    ];
    expect(signingRowsOnce(rows).map((row) => row.id)).toEqual([
      "new",
      "other",
      "news",
    ]);
  });

  it("says why as the value", () => {
    expect(
      newsValue("document_signature_voided", {
        reason: "unanimity_changed",
      }),
    ).toBe("unanimity_changed");
  });
});

describe("loadWorkNews, the signers' scope", () => {
  it("tells a manager without a member the latest per document, while it stands, and watches its signings", async () => {
    reads.queue = [
      // The documents with a signing.
      [{ id: "d1" }, { id: "d2" }],
      // The signers' query, newest first.
      [
        voided("unanimity", 5, { payload: { reason: "unanimity_changed" } }),
        voided("signed-again", 8, { entityId: "d2" }),
        voided("first", 30),
      ],
      // The signings of those documents: d2 is signed for its text again.
      [
        { documentId: "d1", url: null, signedAt: null, versionId: null },
        {
          documentId: "d2",
          url: "/api/files/d2.pdf",
          signedAt: new Date(NOW.getTime() - 60_000),
          versionId: "ver7",
        },
      ],
      // The documents.
      [acta, { ...acta, id: "d2", consolidatedVersionId: "ver7" }],
    ];
    const result = await loadWorkNews(signer(), [assembly], NOW);
    expect(result.watchDocumentIds).toEqual(["d1", "d2"]);
    expect(result.watchAssemblyIds).toEqual([]);
    expect(result.news).toHaveLength(1);
    expect(result.news[0]).toMatchObject({
      id: "unanimity",
      type: "document_signature_voided",
      value: "unanimity_changed",
      document: { id: "d1", slug: "acta-79-ago" },
      amendment: null,
      ownAmendment: false,
    });
    expect(result.news[0]).not.toHaveProperty("asMesa");
    expect(result.news[0]).not.toHaveProperty("agreementsRecord");
  });

  it("reads the account's own acts, and tells them", async () => {
    reads.queue = [
      [{ id: "d1" }],
      [voided("mine", 2, { actorUserId: TEST_ACTOR_ID })],
      [],
      [acta],
    ];
    const result = await loadWorkNews(signer(), [assembly], NOW);
    expect(result.news.map((item) => item.id)).toEqual(["mine"]);
    // The events' query leaves the account's own acts in.
    const query = reads.wheres
      .map((where) => render(where))
      .find((rendered) => rendered.params.includes(NEWS_SIGNATURE_VOIDED));
    expect(query).toBeDefined();
    expect(query!.sql).not.toContain("actor_user_id");
  });

  it("marks the acta de acuerdos, which is signed on its own page", async () => {
    reads.queue = [
      [{ id: "d1" }],
      [voided("record", 2, { payload: { reason: "final_vote_annulled" } })],
      [],
      [{ ...acta, generated: "agreements_record" }],
    ];
    const result = await loadWorkNews(signer(), [assembly], NOW);
    expect(result.news[0]).toMatchObject({
      value: "final_vote_annulled",
      agreementsRecord: true,
    });
  });

  it("reads nothing of it for an account that does not manage documents", async () => {
    const result = await loadWorkNews(
      testActor({ permissions: [PERMISSION_KEYS.DOCUMENT_CORRECT_FORM] }),
      [assembly],
      NOW,
    );
    expect(result).toEqual({
      news: [],
      watchDocumentIds: [],
      watchAssemblyIds: [],
    });
    expect(reads.count).toBe(0);
  });
});
