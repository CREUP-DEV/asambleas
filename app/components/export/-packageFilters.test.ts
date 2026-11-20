import { describe, expect, it } from "vitest";
import type { PackageOptionsDto } from "~~/shared/types/api";
import {
  authorChoices,
  documentMenuValues,
  documentsAfterMenu,
  groupValue,
  packageSelectionOf,
  packageSummary,
  presetState,
} from "./-packageFilters";

const options: PackageOptionsDto = {
  groups: [
    {
      id: "item-1",
      numbering: "1",
      title: "Resoluciones",
      documentIds: ["res4", "res5"],
    },
    { id: "item-2", numbering: "2", title: "Informes", documentIds: ["inf1"] },
  ],
  documents: [
    {
      id: "res4",
      title: "Becas",
      reference: "RES 4",
      numbering: null,
      hasText: true,
      amendments: [
        { id: "a1", code: "UGR1", authorIds: ["ugr"] },
        { id: "a2", code: "CEA1", authorIds: ["cea", "uco"] },
      ],
    },
    {
      id: "res5",
      title: "Vivienda",
      reference: "RES 5",
      numbering: null,
      hasText: true,
      amendments: [{ id: "a3", code: "UCO1", authorIds: ["uco"] }],
    },
    {
      id: "inf1",
      title: "Informe",
      reference: null,
      numbering: null,
      hasText: true,
      amendments: [],
    },
  ],
  authors: [
    {
      id: "cea",
      acronym: "CEA",
      name: "Comisión Ejecutiva Ampliada",
      kind: "executive",
      university: null,
    },
    {
      id: "ugr",
      acronym: "UGR",
      name: "Consejo de Estudiantes",
      kind: "asociado",
      university: "Universidad de Granada",
    },
    {
      id: "uco",
      acronym: "UCO",
      name: "Consejo de Estudiantes",
      kind: "asociado",
      university: "Universidad de Córdoba",
    },
  ],
};

describe("package filters", () => {
  it("asks for the whole package when nothing is filtered", () => {
    expect(packageSelectionOf(presetState(null))).toBeNull();
    expect(
      packageSelectionOf(presetState({ documentIds: ["res4"] })),
    ).toMatchObject({ documentIds: ["res4"], amendments: "all" });
    expect(
      packageSelectionOf(
        presetState({ documentIds: ["res4"], amendmentIds: ["a1"] }),
      ),
    ).toMatchObject({ amendments: "selected", amendmentIds: ["a1"] });
  });

  it("ticks an item with all its documents and unticks them together", () => {
    const groups = options.groups;
    const one = groupValue("item-1");
    expect(documentsAfterMenu([], [one], groups)).toEqual(["res4", "res5"]);
    const full = documentMenuValues(["res4", "res5"], groups);
    expect(full).toContain(one);
    // A document unticked inside a full item leaves the other one.
    expect(
      documentsAfterMenu(
        full,
        full.filter((value) => value !== "res5"),
        groups,
      ),
    ).toEqual(["res4"]);
    expect(
      documentsAfterMenu(
        full,
        full.filter((value) => value !== one),
        groups,
      ),
    ).toEqual([]);
  });

  it("offers who signs in the documents chosen, a council by its university", () => {
    expect(
      authorChoices(options, []).map((author) => [author.id, author.count]),
    ).toEqual([
      ["uco", 2],
      ["ugr", 1],
      ["cea", 1],
    ]);
    expect(authorChoices(options, ["res5"]).map((author) => author.id)).toEqual(
      ["uco"],
    );
  });

  it("counts what a download holds, and the chosen amendments not public", () => {
    const state = presetState(null);
    expect(packageSummary(options, state)).toEqual({
      documents: 3,
      amendments: 3,
      dropped: 0,
    });
    expect(
      packageSummary(options, {
        ...state,
        texts: false,
        amendments: "authors",
        memberIds: ["cea"],
      }),
    ).toEqual({ documents: 1, amendments: 1, dropped: 0 });
    expect(
      packageSummary(
        options,
        presetState({
          documentIds: ["res4"],
          texts: false,
          amendmentIds: ["a1", "draft"],
        }),
      ),
    ).toEqual({ documents: 1, amendments: 1, dropped: 1 });
  });
});
