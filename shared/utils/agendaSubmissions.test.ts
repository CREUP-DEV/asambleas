import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "../constants/domain";
import {
  AGENDA_DELETE_AMENDMENTS_CODE,
  AGENDA_DELETE_LIVE_CODE,
  agendaDeleteBlocker,
  autoItemRemovable,
  BULK_DOCUMENTS_MAX,
  followsDocumentTitle,
  isAutoItem,
  itemAcceptsKind,
  normalizeSubmissionKinds,
  SUBMISSION_KIND_REFUSED_REASON,
  visibleAgendaItems,
} from "./agendaSubmissions";
import { agendaItemBodySchema } from "./schemas/assembly";
import { bulkDocumentsSchema } from "./schemas/document";

describe("itemAcceptsKind", () => {
  it("takes no kind while the item accepts no submissions", () => {
    const closed = { acceptsSubmissions: false, submissionKinds: [] };
    for (const kind of DOCUMENT_KINDS) {
      expect(itemAcceptsKind(closed, kind)).toBe(false);
    }
    expect(
      itemAcceptsKind(
        { acceptsSubmissions: false, submissionKinds: ["resolution"] },
        "resolution",
      ),
    ).toBe(false);
  });

  it("takes every kind with an empty list", () => {
    const open = { acceptsSubmissions: true, submissionKinds: [] };
    for (const kind of DOCUMENT_KINDS) {
      expect(itemAcceptsKind(open, kind)).toBe(true);
    }
  });

  it("takes only the kinds listed", () => {
    const item = {
      acceptsSubmissions: true,
      submissionKinds: ["resolution", "internal_motion"] as const,
    };
    expect(itemAcceptsKind(item, "resolution")).toBe(true);
    expect(itemAcceptsKind(item, "internal_motion")).toBe(true);
    expect(itemAcceptsKind(item, "positioning")).toBe(false);
    expect(itemAcceptsKind(item, "report")).toBe(false);
  });

  it("keeps its codes stable", () => {
    expect(SUBMISSION_KIND_REFUSED_REASON).toBe("submission_kind");
    expect(AGENDA_DELETE_AMENDMENTS_CODE).toBe("agenda_item_amendments");
    expect(AGENDA_DELETE_LIVE_CODE).toBe("agenda_item_live");
  });
});

describe("normalizeSubmissionKinds", () => {
  it("stores none while the item accepts no submissions", () => {
    expect(normalizeSubmissionKinds(false, ["resolution"])).toEqual([]);
  });

  it("keeps each kind once, in order", () => {
    expect(
      normalizeSubmissionKinds(true, [
        "resolution",
        "internal_motion",
        "resolution",
      ]),
    ).toEqual(["resolution", "internal_motion"]);
    expect(normalizeSubmissionKinds(true, undefined)).toEqual([]);
    expect(normalizeSubmissionKinds(true, null)).toEqual([]);
  });
});

describe("followsDocumentTitle", () => {
  const item = { id: "i1", generatedForDocumentId: "d1", titleCustom: false };
  const document = { id: "d1", agendaItemId: "i1" };

  it("follows the document it was created for", () => {
    expect(followsDocumentTitle(item, document)).toBe(true);
  });

  it("keeps a title a manager gave it", () => {
    expect(followsDocumentTitle({ ...item, titleCustom: true }, document)).toBe(
      false,
    );
  });

  it("ignores other documents and items written by hand", () => {
    expect(followsDocumentTitle(item, { id: "d2", agendaItemId: "i1" })).toBe(
      false,
    );
    expect(
      followsDocumentTitle({ ...item, generatedForDocumentId: null }, document),
    ).toBe(false);
  });

  it("stops once the document hangs elsewhere", () => {
    expect(followsDocumentTitle(item, { id: "d1", agendaItemId: "i9" })).toBe(
      false,
    );
  });
});

describe("autoItemRemovable", () => {
  const item = { generatedForDocumentId: "d1" };
  const empty = { otherDocuments: 0, children: 0 };

  it("goes with its document when it holds nothing else", () => {
    expect(autoItemRemovable(item, "d1", empty)).toBe(true);
  });

  it("stays while it holds another document or a sub-item", () => {
    expect(
      autoItemRemovable(item, "d1", { otherDocuments: 1, children: 0 }),
    ).toBe(false);
    expect(
      autoItemRemovable(item, "d1", { otherDocuments: 0, children: 2 }),
    ).toBe(false);
  });

  it("never removes an item written by hand or another document's", () => {
    expect(
      autoItemRemovable({ generatedForDocumentId: null }, "d1", empty),
    ).toBe(false);
    expect(autoItemRemovable(item, "d2", empty)).toBe(false);
  });

  it("tells automatic sub-items apart", () => {
    expect(isAutoItem(item)).toBe(true);
    expect(isAutoItem({ generatedForDocumentId: null })).toBe(false);
  });
});

describe("visibleAgendaItems", () => {
  const item = (
    id: string,
    parentId: string | null,
    generatedForDocumentId: string | null = null,
  ) => ({ id, parentId, generatedForDocumentId });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const items = [
    item("root", null),
    item("auto1", "root", "d1"),
    item("auto2", "root", "d2"),
    item("plain", "root"),
  ];

  it("returns every item when the viewer sees every document", () => {
    expect(
      ids(
        visibleAgendaItems(items, [
          { id: "d1", agendaItemId: "auto1" },
          { id: "d2", agendaItemId: "auto2" },
        ]),
      ),
    ).toEqual(["root", "auto1", "auto2", "plain"]);
  });

  it("leaves out the automatic sub-item of a document the viewer cannot see", () => {
    expect(
      ids(visibleAgendaItems(items, [{ id: "d1", agendaItemId: "auto1" }])),
    ).toEqual(["root", "auto1", "plain"]);
    expect(ids(visibleAgendaItems(items, []))).toEqual(["root", "plain"]);
  });

  it("keeps one that holds a document the viewer does see", () => {
    expect(
      ids(visibleAgendaItems(items, [{ id: "d9", agendaItemId: "auto2" }])),
    ).toEqual(["root", "auto2", "plain"]);
  });

  it("keeps one with a sub-item that stays", () => {
    const withChild = [...items, item("child", "auto2")];
    expect(ids(visibleAgendaItems(withChild, []))).toEqual([
      "root",
      "auto2",
      "plain",
      "child",
    ]);
  });

  it("drops a chain of hidden automatic sub-items", () => {
    const chain = [
      item("root", null),
      item("a", "root", "d1"),
      item("b", "a", "d2"),
    ];
    expect(ids(visibleAgendaItems(chain, []))).toEqual(["root"]);
  });
});

describe("agendaDeleteBlocker", () => {
  it("lets items without documents or amendments go", () => {
    expect(agendaDeleteBlocker([])).toBeNull();
    expect(agendaDeleteBlocker([0, 0, 0])).toBeNull();
  });

  it("counts the documents with amendments and their amendments", () => {
    expect(agendaDeleteBlocker([0, 1])).toEqual({
      documents: 1,
      amendments: 1,
    });
    expect(agendaDeleteBlocker([3, 0, 2])).toEqual({
      documents: 2,
      amendments: 5,
    });
  });
});

describe("submissionKinds in the agenda schema", () => {
  it("is optional and takes document kinds", () => {
    expect(
      agendaItemBodySchema.parse({ title: "Resoluciones" }).submissionKinds,
    ).toBeUndefined();
    expect(
      agendaItemBodySchema.parse({
        title: "Resoluciones",
        acceptsSubmissions: true,
        submissionKinds: ["resolution", "internal_motion"],
      }).submissionKinds,
    ).toEqual(["resolution", "internal_motion"]);
  });

  it("refuses unknown and repeated kinds", () => {
    expect(
      agendaItemBodySchema.safeParse({
        title: "Resoluciones",
        submissionKinds: ["poem"],
      }).success,
    ).toBe(false);
    expect(
      agendaItemBodySchema.safeParse({
        title: "Resoluciones",
        submissionKinds: ["resolution", "resolution"],
      }).success,
    ).toBe(false);
  });
});

describe("bulkDocumentsSchema", () => {
  const row = { title: "Informe", kind: "report", format: "file" };

  it("takes rows with a title, a kind and a format", () => {
    const parsed = bulkDocumentsSchema.parse({
      documents: [
        row,
        {
          ...row,
          title: "  Moción  ",
          proponentMemberId: null,
          dueAt: "2026-11-20T10:00:00.000Z",
        },
      ],
    });
    expect(parsed.documents).toHaveLength(2);
    expect(parsed.documents[1]?.title).toBe("Moción");
  });

  it("needs at least one row and at most the limit", () => {
    expect(bulkDocumentsSchema.safeParse({ documents: [] }).success).toBe(
      false,
    );
    expect(
      bulkDocumentsSchema.safeParse({
        documents: Array.from({ length: BULK_DOCUMENTS_MAX }, () => row),
      }).success,
    ).toBe(true);
    expect(
      bulkDocumentsSchema.safeParse({
        documents: Array.from({ length: BULK_DOCUMENTS_MAX + 1 }, () => row),
      }).success,
    ).toBe(false);
  });

  it("refuses rows without a title or with an unknown kind", () => {
    expect(
      bulkDocumentsSchema.safeParse({ documents: [{ ...row, title: " " }] })
        .success,
    ).toBe(false);
    expect(
      bulkDocumentsSchema.safeParse({ documents: [{ ...row, kind: "poem" }] })
        .success,
    ).toBe(false);
  });
});
