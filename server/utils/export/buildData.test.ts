import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AmendmentVisibilityContext } from "../domain/visibility";
import type { Actor } from "../domain/actor";

// annotatedBody and buildDocumentExportData with the database stubbed: the
// real visibility rules (visibility.ts, actor.ts) judge every amendment and
// presenter, with the actor the export hands them.

interface Row {
  id: string;
  number: number | null;
  code: string | null;
  status: AmendmentVisibilityContext["status"];
  publishedAt: Date | null;
  authors: { acronym: string; kind: "executive" | "asociado" }[];
}

const rows: Row[] = [
  {
    id: "cea",
    number: 1,
    code: "CEA 1",
    status: "submitted",
    publishedAt: new Date("2026-11-10T10:00:00Z"),
    authors: [{ acronym: "SG", kind: "executive" }],
  },
  {
    id: "council",
    number: 2,
    code: "CEUM 1",
    status: "submitted",
    publishedAt: new Date("2026-11-10T10:00:00Z"),
    authors: [
      { acronym: "CEUM", kind: "asociado" },
      { acronym: "PRES", kind: "executive" },
    ],
  },
  // Withdrawn before it was published: the Secretaría and its author read
  // it in the platform, nobody else.
  {
    id: "withdrawn",
    number: null,
    code: null,
    status: "withdrawn",
    publishedAt: null,
    authors: [{ acronym: "CEUCO", kind: "asociado" }],
  },
];

const seen: Actor[] = [];

/** The Secretaría as the export worker rebuilds it (loadExportActor). */
const secretaria = {
  user: { id: "secretaria", role: { id: "r", name: "Secretaria" } },
  memberId: null,
  memberKind: null,
  isAdmin: false,
  permissions: ["document:manage", "amendment:review", "assembly:manage"],
  can: (key: string) =>
    ["document:manage", "amendment:review", "assembly:manage"].includes(key),
  impersonation: null,
} as unknown as Actor;

/** A published document an executive office presents, with another one. */
const documentRow = {
  id: "doc",
  assemblyId: "asm",
  agendaItemId: "item",
  title: "Resolución sobre becas",
  reference: "RES 1/2026",
  kind: "resolution",
  format: "structured",
  status: "published",
  proponentMemberId: "m-sg",
  submittedByUserId: null,
  baseVersionId: "base",
  workingVersionId: null,
  consolidatedVersionId: null,
  finalVoteId: null,
  fileName: null,
  proponent: { acronym: "SG", kind: "executive" },
};

/** Its item, whose title was withheld when a document never public went. */
const agendaRows = [
  {
    id: "item",
    parentId: null,
    title: "Título de un documento retirado",
    description: null,
    order: 0,
    generatedForDocumentId: null,
    hiddenWithDocumentId: null,
    titleWithheld: true,
  },
];

vi.mock("../../db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const selected: Record<string, unknown[]> = {
    agenda_items: agendaRows,
    documents: [{ id: "doc", agendaItemId: "item" }],
    votes: [],
    document_versions: [
      {
        id: "base",
        blocks: [{ id: "b1", type: "paragraph", text: "Texto", marks: [] }],
      },
    ],
  };
  return {
    db: {
      query: {
        assemblies: {
          findFirst: async () => ({
            id: "asm",
            type: "AGO",
            number: 80,
            status: "convened",
            startDate: new Date("2026-11-20T09:00:00Z"),
            endDate: new Date("2026-11-22T14:00:00Z"),
            location: "Murcia",
          }),
        },
        documents: { findFirst: async () => documentRow },
        amendments: {
          findMany: async () =>
            rows.map((row) => ({
              id: row.id,
              number: row.number,
              code: row.code,
              kind: "partial",
              status: row.status,
              admission: "admitted",
              late: false,
              approvalMethod: null,
              decidedAt: null,
              positionKey: 0,
              outcomeVoteId: null,
              ops: [],
              authors: row.authors.map((member, index) => ({
                member: { id: `m-${row.id}-${index}`, ...member },
              })),
              sources: [],
              derived: [],
            })),
        },
      },
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => ({
          where: async () => selected[getTableName(table)] ?? [],
        }),
      }),
    },
  };
});
vi.mock("./actor", async () => ({
  ...(await vi.importActual<typeof import("./actor")>("./actor")),
  loadExportActor: async () => secretaria,
}));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("../core/logger", () => ({ logError: vi.fn() }));
vi.mock("../domain/documentImages", () => ({
  getImageDir: () => "/images",
  imageFileName: () => null,
}));
vi.mock("../domain/presenters", () => ({
  // A second office presents it with the first.
  loadCoProponents: async () =>
    new Map([["doc", [{ acronym: "PRES", kind: "executive" }]]]),
  withCoProponentIds: async (rows: object[]) =>
    rows.map((row) => ({ ...row, coProponentMemberIds: ["m-pres"] })),
}));
vi.mock("../domain/documents", async () => {
  const visibility = await vi.importActual<
    typeof import("../domain/visibility")
  >("../domain/visibility");
  // The same rule as documents.ts, over the rows above.
  return {
    loadAmendmentVisibility: async (actor: Actor) => {
      seen.push(actor);
      const visible = new Set(
        rows
          .filter((row) =>
            visibility.canSeeAmendment(actor, {
              status: row.status,
              publishedAt: row.publishedAt,
              createdByUserId: "secretaria",
              authorMemberIds: row.authors.map(
                (_, index) => `m-${row.id}-${index}`,
              ),
              partyMemberIds: [],
            }),
          )
          .map((row) => row.id),
      );
      return { all: new Set(rows.map((row) => row.id)), visible };
    },
  };
});

const { annotatedBody, buildDocumentExportData } = await import("./buildData");

beforeEach(() => {
  seen.length = 0;
});

/** A council's delegate: reads the offices as the generic "CEA". */
const delegate = {
  user: { id: "delegate", role: { id: "a", name: "Asociado" } },
  memberId: "m-ceum",
  memberKind: "asociado",
  isAdmin: false,
  permissions: ["document:create", "amendment:create"],
  can: (key: string) => ["document:create", "amendment:create"].includes(key),
  impersonation: null,
} as unknown as Actor;

describe("annotatedBody", () => {
  it("names the offices as the Secretaría reads them, like the clean PDF", async () => {
    const body = await annotatedBody(secretaria, {
      id: "doc",
      baseVersionId: "base",
    });
    if (body.variant !== "annotated") throw new Error("not annotated");

    expect(body.annex.map((row) => [row.displayCode, row.authors])).toEqual([
      ["1 · CEA 1", ["SG"]],
      ["2 · CEUM 1", ["CEUM", "PRES"]],
    ]);
  });

  it("names them as one CEA for a delegate", async () => {
    const body = await annotatedBody(delegate, {
      id: "doc",
      baseVersionId: "base",
    });
    if (body.variant !== "annotated") throw new Error("not annotated");

    expect(body.annex.map((row) => row.authors)).toEqual([
      ["CEA"],
      ["CEA", "CEUM"],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/SG|PRES/);
  });

  it("carries only published amendments, whoever asks", async () => {
    for (const actor of [secretaria, delegate]) {
      seen.length = 0;
      const body = await annotatedBody(actor, {
        id: "doc",
        baseVersionId: "base",
      });
      if (body.variant !== "annotated") throw new Error("not annotated");
      expect(Object.keys(body.codes).sort()).toEqual(["cea", "council"]);
      expect(JSON.stringify(body)).not.toMatch(/withdrawn|CEUCO/);
      // Which amendments: decided as whoever sees only what is public.
      expect(seen.map((reader) => reader.user.id)).toEqual([
        "export:public-reader",
      ]);
    }
  });

  it("would carry the withdrawn amendment if the Secretaría decided it", async () => {
    // Why the public reader picks the amendments: the Secretaría sees it.
    const visibility = await vi.importActual<
      typeof import("../domain/visibility")
    >("../domain/visibility");
    expect(
      visibility.canSeeAmendment(secretaria, {
        status: "withdrawn",
        publishedAt: null,
        createdByUserId: null,
        authorMemberIds: [],
        partyMemberIds: [],
      }),
    ).toBe(true);
  });
});

describe("buildDocumentExportData", () => {
  const job = {
    assemblyId: "asm",
    documentId: "doc",
    requestedBy: "secretaria",
    locale: "es" as const,
  };

  it("writes the Secretaría's annotated PDF as the Secretaría reads it", async () => {
    const data = await buildDocumentExportData({
      ...job,
      variant: "annotated",
    });
    if (data.body.variant !== "annotated") throw new Error("not annotated");

    // Header and annex read like the clean PDF: the real offices.
    expect(data.document.proponent).toBe("SG, PRES");
    expect(data.body.annex.map((row) => row.authors)).toEqual([
      ["SG"],
      ["CEUM", "PRES"],
    ]);
    // A document manager reads a withheld title, as in the clean PDF.
    expect(data.document.agendaTitle).toBe("Título de un documento retirado");
    // Still only the published amendments.
    expect(JSON.stringify(data)).not.toMatch(/withdrawn|CEUCO/);
  });

  it("keeps the requester's reading in the clean PDF", async () => {
    const data = await buildDocumentExportData({ ...job, variant: "clean" });
    expect(data.document.proponent).toBe("SG, PRES");
    expect(data.document.agendaTitle).toBe("Título de un documento retirado");
  });
});
