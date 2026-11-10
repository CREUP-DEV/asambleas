import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "../constants/domain";
import {
  AGENDA_DELETE_AMENDMENTS_CODE,
  AGENDA_DELETE_LIVE_CODE,
  agendaDeleteBlocker,
  autoItemRemovable,
  BULK_DOCUMENTS_MAX,
  followsDocumentTitle,
  keepsDocumentTitle,
  carriesGuardedTitle,
  deletedTitleWithheld,
  hiddenTitleItemIds,
  isAutoItem,
  itemAcceptsKind,
  normalizeSubmissionKinds,
  SUBMISSION_KIND_REFUSED_REASON,
  titleDocumentId,
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
    hiddenWithDocumentId: string | null = null,
  ) => ({ id, parentId, generatedForDocumentId, hiddenWithDocumentId });
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

describe("an item kept after its document moved away", () => {
  const item = (
    id: string,
    parentId: string | null,
    hiddenWithDocumentId: string | null = null,
  ) => ({ id, parentId, generatedForDocumentId: null, hiddenWithDocumentId });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  // "kept" was the automatic sub-item of d1, which moved to "other".
  const items = [
    item("root", null),
    item("kept", "root", "d1"),
    item("child", "kept"),
    item("other", "root"),
  ];
  const d1 = { id: "d1", agendaItemId: "other" };

  it("is an ordinary item that still names the document of its title", () => {
    expect(isAutoItem(items[1]!)).toBe(false);
    expect(titleDocumentId(items[1]!)).toBe("d1");
    expect(titleDocumentId(items[0]!)).toBeNull();
    expect(
      titleDocumentId({
        generatedForDocumentId: "d2",
        hiddenWithDocumentId: null,
      }),
    ).toBe("d2");
  });

  it("shows with its title to whoever sees the document", () => {
    expect(ids(visibleAgendaItems(items, [d1]))).toEqual([
      "root",
      "kept",
      "child",
      "other",
    ]);
    expect([...hiddenTitleItemIds(items, [d1])]).toEqual([]);
  });

  it("stays without its title for whoever cannot see the document", () => {
    const kept = visibleAgendaItems(items, []);
    expect(ids(kept)).toEqual(["root", "kept", "child", "other"]);
    expect([...hiddenTitleItemIds(kept, [])]).toEqual(["kept"]);
  });

  it("is left out when nothing the viewer sees hangs from it", () => {
    const alone = items.filter((entry) => entry.id !== "child");
    expect(ids(visibleAgendaItems(alone, []))).toEqual(["root", "other"]);
    // A document the viewer sees keeps it, still without its title.
    const withDocument = [{ id: "d5", agendaItemId: "kept" }];
    const kept = visibleAgendaItems(alone, withDocument);
    expect(ids(kept)).toEqual(["root", "kept", "other"]);
    expect([...hiddenTitleItemIds(kept, withDocument)]).toEqual(["kept"]);
  });

  it("is a plain item again once a public document is deleted", () => {
    // The foreign key clears the link, and nothing is withheld.
    expect(deletedTitleWithheld("published")).toBe(false);
    expect(deletedTitleWithheld("postponed")).toBe(false);
    const cleared = items.map((entry) => ({
      ...entry,
      hiddenWithDocumentId: null,
    }));
    expect(ids(visibleAgendaItems(cleared, []))).toHaveLength(4);
    expect(hiddenTitleItemIds(cleared, []).size).toBe(0);
    expect(carriesGuardedTitle(cleared[1]!)).toBe(false);
  });

  it("keeps its title withheld once a document nobody saw is deleted", () => {
    for (const status of ["draft", "submitted", "withdrawn"]) {
      expect(deletedTitleWithheld(status)).toBe(true);
    }
    // The link is gone; the mark stays until a manager renames the item.
    const withheld = items.map((entry) =>
      entry.id === "kept"
        ? { ...entry, hiddenWithDocumentId: null, titleWithheld: true }
        : entry,
    );
    expect(carriesGuardedTitle(withheld[1]!)).toBe(true);
    const kept = visibleAgendaItems(withheld, []);
    expect(ids(kept)).toEqual(["root", "kept", "child", "other"]);
    expect([...hiddenTitleItemIds(kept, [])]).toEqual(["kept"]);
    // Document managers read it.
    expect(hiddenTitleItemIds(withheld, [], true).size).toBe(0);
    // Left out for the rest once nothing hangs from it.
    const alone = withheld.filter((entry) => entry.id !== "child");
    expect(ids(visibleAgendaItems(alone, []))).toEqual(["root", "other"]);
    expect(ids(visibleAgendaItems(alone, [], true))).toHaveLength(3);
  });

  it("hides the title of an automatic sub-item kept for its sub-items", () => {
    const auto = [
      item("root", null),
      { ...item("auto", "root"), generatedForDocumentId: "d2" },
      item("child", "auto"),
    ];
    const kept = visibleAgendaItems(auto, []);
    expect(ids(kept)).toEqual(["root", "auto", "child"]);
    expect([...hiddenTitleItemIds(kept, [])]).toEqual(["auto"]);
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

describe("keepsDocumentTitle", () => {
  it("holds while the item is titled like its document", () => {
    expect(keepsDocumentTitle({ titleCustom: false })).toBe(true);
  });

  it("ends once a manager gave the item its own title", () => {
    expect(keepsDocumentTitle({ titleCustom: true })).toBe(false);
  });
});
