import { describe, expect, it } from "vitest";
import {
  AGENDA_DELETE_NAMED_MAX,
  agendaDeleteRefusal,
  documentKeepsItem,
  planAgendaDelete,
  type AgendaDeleteDocument,
} from "./agendaDelete";

const items = [
  { id: "a", parentId: null, order: 0 },
  { id: "a1", parentId: "a", order: 0 },
  { id: "a2", parentId: "a", order: 1 },
  { id: "a2x", parentId: "a2", order: 0 },
  { id: "b", parentId: null, order: 1 },
];

function doc(
  title: string,
  agendaItemId: string,
  extra: Partial<AgendaDeleteDocument> = {},
): AgendaDeleteDocument {
  return {
    title,
    agendaItemId,
    amendmentCount: 0,
    hasAmendments: false,
    ...extra,
  };
}

describe("planAgendaDelete", () => {
  it("counts the sub-items at any depth and the documents under them", () => {
    const plan = planAgendaDelete(
      items,
      [doc("Uno", "a"), doc("Dos", "a2x"), doc("Otro", "b")],
      "a",
    );
    expect(plan).toEqual({
      subItems: 3,
      documents: 2,
      named: ["Uno", "Dos"],
      unnamed: 0,
      blockedBy: [],
    });
  });

  it("is empty for an item with nothing under it", () => {
    expect(planAgendaDelete(items, [doc("Uno", "a")], "b")).toEqual({
      subItems: 0,
      documents: 0,
      named: [],
      unnamed: 0,
      blockedBy: [],
    });
  });

  it("is empty for an item that is not on the agenda", () => {
    const plan = planAgendaDelete(items, [doc("Uno", "a")], "missing");
    expect(plan.subItems).toBe(0);
    expect(plan.documents).toBe(0);
  });

  it("names the first documents and counts the rest", () => {
    const documents = Array.from({ length: 8 }, (_, index) =>
      doc(`Documento ${index + 1}`, "a1"),
    );
    const plan = planAgendaDelete(items, documents, "a");
    expect(plan.named).toHaveLength(AGENDA_DELETE_NAMED_MAX);
    expect(plan.named[0]).toBe("Documento 1");
    expect(plan.unnamed).toBe(3);
    expect(plan.documents).toBe(8);
  });

  it("is blocked by every document with amendments in the branch", () => {
    const plan = planAgendaDelete(
      items,
      [
        doc("Limpio", "a"),
        doc("Con borradores", "a1", { hasAmendments: true }),
        doc("Enmendado", "a2x", { hasAmendments: true, amendmentCount: 4 }),
        doc("Fuera", "b", { hasAmendments: true }),
      ],
      "a",
    );
    expect(plan.blockedBy).toEqual(["Con borradores", "Enmendado"]);
  });
});

describe("documentKeepsItem", () => {
  it("trusts the exact answer managers get", () => {
    expect(documentKeepsItem(doc("x", "a", { hasAmendments: true }))).toBe(
      true,
    );
    expect(
      documentKeepsItem(
        doc("x", "a", { hasAmendments: false, amendmentCount: 0 }),
      ),
    ).toBe(false);
  });

  it("falls back to the visible amendments when it is not told", () => {
    expect(
      documentKeepsItem(
        doc("x", "a", { hasAmendments: null, amendmentCount: 2 }),
      ),
    ).toBe(true);
    expect(
      documentKeepsItem(
        doc("x", "a", { hasAmendments: null, amendmentCount: 0 }),
      ),
    ).toBe(false);
  });
});

describe("agendaDeleteRefusal", () => {
  it("reads the amendments refusal with its counts (ofetch error)", () => {
    expect(
      agendaDeleteRefusal({
        statusCode: 409,
        data: {
          statusCode: 409,
          data: { code: "agenda_item_amendments", documents: 2, amendments: 7 },
        },
      }),
    ).toEqual({ reason: "amendments", documents: 2, amendments: 7 });
  });

  it("reads it from an h3 error too", () => {
    expect(
      agendaDeleteRefusal({
        statusCode: 409,
        data: { code: "agenda_item_amendments", documents: 1, amendments: 1 },
      }),
    ).toEqual({ reason: "amendments", documents: 1, amendments: 1 });
  });

  it("reads the refusal during the session", () => {
    expect(
      agendaDeleteRefusal({ data: { data: { code: "agenda_item_live" } } }),
    ).toEqual({ reason: "live" });
  });

  it("is null for any other failure", () => {
    expect(agendaDeleteRefusal(null)).toBeNull();
    expect(agendaDeleteRefusal(new Error("network"))).toBeNull();
    expect(
      agendaDeleteRefusal({ data: { data: { code: "agenda_final" } } }),
    ).toBeNull();
    expect(agendaDeleteRefusal({ data: "Conflict" })).toBeNull();
  });
});
