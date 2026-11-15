import { describe, expect, it } from "vitest";
import { agendaItems, controlSheetItems, votes } from "../../db/schema";
import {
  moveSheetItemRow,
  sheetNotesIn,
  titleDocumentPayload,
} from "./agendaWrites";
import type { Executor } from "./events";

describe("titleDocumentPayload", () => {
  it("says nothing of an item written by hand", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: null,
        titleWithheld: false,
      }),
    ).toEqual({});
  });

  it("marks an automatic sub-item and names its document", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: "d1",
        hiddenWithDocumentId: null,
        titleWithheld: false,
      }),
    ).toEqual({ auto: true, documentId: "d1" });
  });

  it("names the document of one kept after it moved away, no longer automatic", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: "d1",
        titleWithheld: false,
      }),
    ).toEqual({ documentId: "d1" });
  });

  it("marks one whose title is withheld since its document was deleted", () => {
    expect(
      titleDocumentPayload({
        generatedForDocumentId: null,
        hiddenWithDocumentId: null,
        titleWithheld: true,
      }),
    ).toEqual({ titleWithheld: true });
  });
});

/**
 * A transaction that answers each select with the next queued result and
 * keeps what each update writes.
 */
function fakeTx(selects: unknown[][]) {
  const updates: { table: unknown; values: Record<string, unknown> }[] = [];
  let selectCalls = 0;
  const query = (): unknown => {
    const node: unknown = new Proxy(() => node, {
      get: (_target, prop) =>
        prop === "then"
          ? (resolve: (value: unknown) => void) =>
              resolve(selects.shift() ?? [])
          : () => node,
    });
    return node;
  };
  const tx = {
    select: () => {
      selectCalls += 1;
      return query();
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  return {
    tx: tx as unknown as Executor,
    updates,
    selectCalls: () => selectCalls,
  };
}

describe("sheetNotesIn", () => {
  it("asks nothing for no items", async () => {
    const fake = fakeTx([]);
    expect(await sheetNotesIn(fake.tx, [])).toBe(false);
    expect(fake.selectCalls()).toBe(0);
  });

  it("counts the sheet's notes and the votes on the items", async () => {
    // Notes first, then votes.
    expect(await sheetNotesIn(fakeTx([[], []]).tx, ["item"])).toBe(false);
    expect(await sheetNotesIn(fakeTx([[{ id: "row" }], []]).tx, ["item"])).toBe(
      true,
    );
    // A vote alone keeps the item, voided or not: it is the record.
    expect(
      await sheetNotesIn(fakeTx([[], [{ id: "vote" }]]).tx, ["item"]),
    ).toBe(true);
  });
});

describe("moveSheetItemRow", () => {
  it("moves the sheet row and the item's votes to the new sub-item", async () => {
    const fake = fakeTx([]);
    await moveSheetItemRow(fake.tx, "old", "new");
    expect(fake.updates).toEqual([
      { table: controlSheetItems, values: { agendaItemId: "new" } },
      { table: votes, values: { subjectId: "new" } },
    ]);
  });

  it("carries «Se vota el punto» to the new sub-item", async () => {
    const fake = fakeTx([[{ voted: true }]]);
    await moveSheetItemRow(fake.tx, "old", "new");
    expect(fake.updates).toEqual([
      { table: agendaItems, values: { voted: true } },
      { table: controlSheetItems, values: { agendaItemId: "new" } },
      { table: votes, values: { subjectId: "new" } },
    ]);

    // Off on the old one: the new one keeps its default.
    const off = fakeTx([[{ voted: false }]]);
    await moveSheetItemRow(off.tx, "old", "new");
    expect(off.updates.map((update) => update.table)).toEqual([
      controlSheetItems,
      votes,
    ]);
  });

  it("moves nothing to the same item", async () => {
    const fake = fakeTx([]);
    await moveSheetItemRow(fake.tx, "item", "item");
    expect(fake.updates).toEqual([]);
    expect(fake.selectCalls()).toBe(0);
  });
});
