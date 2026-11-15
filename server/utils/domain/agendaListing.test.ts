import { describe, expect, it } from "vitest";
import { numberAgendaItems } from "~~/shared/utils/agendaNumbering";
import { agendaItemDtos, type AgendaItemRow } from "./assemblies";

/**
 * `AgendaItemDto.unlisted`: the items someone who sees only the public
 * documents does not receive, so everyone reads the same numbers.
 */

const row = (
  id: string,
  parentId: string | null,
  order: number,
  extra: Partial<AgendaItemRow> = {},
): AgendaItemRow => ({
  id,
  assemblyId: "assembly",
  parentId,
  title: id,
  description: null,
  order,
  acceptsSubmissions: false,
  submissionKinds: [],
  voted: false,
  generatedForDocumentId: null,
  hiddenWithDocumentId: null,
  titleWithheld: false,
  titleCustom: false,
  createdAt: new Date("2026-11-01T09:00:00Z"),
  updatedAt: new Date("2026-11-01T09:00:00Z"),
  ...extra,
});

/** 17 Resoluciones: a draft, then a published resolution, then one presented. */
const items = [
  row("first", null, 0),
  row("resolutions", null, 1, { acceptsSubmissions: true }),
  row("draft", "resolutions", 0, { generatedForDocumentId: "d-draft" }),
  row("published", "resolutions", 1, { generatedForDocumentId: "d-pub" }),
  row("submitted", "resolutions", 2, { generatedForDocumentId: "d-sub" }),
  row("last", null, 2),
];
const documents = [
  { id: "d-draft", agendaItemId: "draft", status: "draft" },
  { id: "d-pub", agendaItemId: "published", status: "published" },
  { id: "d-sub", agendaItemId: "submitted", status: "submitted" },
];
const publicOnly = documents.filter((document) => document.id === "d-pub");

const numbered = (dtos: ReturnType<typeof agendaItemDtos>) =>
  Object.fromEntries(numberAgendaItems(dtos));

describe("agendaItemDtos", () => {
  it("marks for the Secretaría the items an attendee does not get", () => {
    const dtos = agendaItemDtos(items, documents, true);
    expect(dtos.filter((item) => item.unlisted).map((item) => item.id)).toEqual(
      ["draft", "submitted"],
    );
    expect(numbered(dtos)).toEqual({
      first: "1",
      resolutions: "2",
      draft: null,
      published: "2.1",
      submitted: null,
      last: "3",
    });
  });

  it("marks nothing for an attendee, who reads the same numbers", () => {
    const dtos = agendaItemDtos(items, publicOnly, false);
    expect(dtos.map((item) => item.id)).toEqual([
      "first",
      "resolutions",
      "published",
      "last",
    ]);
    expect(dtos.some((item) => item.unlisted)).toBe(false);
    const forSecretaria = numbered(agendaItemDtos(items, documents, true));
    for (const [id, number] of Object.entries(numbered(dtos))) {
      expect(forSecretaria[id]).toBe(number);
    }
  });

  it("marks for a presenter only its own unpublished sub-item", () => {
    // The presenter of the draft sees it and the published one.
    const dtos = agendaItemDtos(
      items,
      documents.filter((document) => document.id !== "d-sub"),
      false,
    );
    expect(dtos.map((item) => [item.id, item.unlisted])).toEqual([
      ["first", false],
      ["resolutions", false],
      ["draft", true],
      ["published", false],
      ["last", false],
    ]);
    expect(numbered(dtos).published).toBe("2.1");
  });

  it("counts a postponed document as public", () => {
    const dtos = agendaItemDtos(
      items,
      documents.map((document) =>
        document.id === "d-sub"
          ? { ...document, status: "postponed" }
          : document,
      ),
      true,
    );
    expect(dtos.find((item) => item.id === "submitted")?.unlisted).toBe(false);
    expect(numbered(dtos).submitted).toBe("2.2");
  });

  it("lists an item that everyone gets without its title", () => {
    // The sub-item of a draft that holds a published document stays for
    // everyone, without its title: it has a number.
    const holding = [
      row("root", null, 0),
      row("auto", "root", 0, { generatedForDocumentId: "d-draft" }),
    ];
    const held = [{ id: "d-other", agendaItemId: "auto", status: "published" }];
    const [, auto] = agendaItemDtos(holding, held, false);
    expect(auto).toMatchObject({
      id: "auto",
      title: "",
      titleHidden: true,
      unlisted: false,
    });
    expect(numbered(agendaItemDtos(holding, held, false)).auto).toBe("1.1");
  });

  it("marks a withheld title that holds nothing, for whoever reads it", () => {
    const withheld = [
      row("root", null, 0),
      row("gone", "root", 0, { titleWithheld: true }),
      row("next", "root", 1),
    ];
    const forManager = agendaItemDtos(withheld, [], true);
    expect(forManager.find((item) => item.id === "gone")?.unlisted).toBe(true);
    expect(numbered(forManager).next).toBe("1.1");
    expect(agendaItemDtos(withheld, [], false).map((item) => item.id)).toEqual([
      "root",
      "next",
    ]);
  });
});

describe("AgendaItemDto.publicTitleHidden", () => {
  // A withheld title kept by its sub-item, and the sub-item of a submitted
  // document kept by a published one inside it: everyone gets both, without
  // their titles.
  const guarded = [
    ...items,
    row("gone", "resolutions", 3, { titleWithheld: true }),
    row("under", "gone", 0),
    row("holder", "resolutions", 4, { generatedForDocumentId: "d-sub2" }),
    row("inner", "holder", 0, { generatedForDocumentId: "d-in" }),
  ];
  const guardedDocuments = [
    ...documents,
    { id: "d-sub2", agendaItemId: "holder", status: "submitted" },
    { id: "d-in", agendaItemId: "inner", status: "published" },
  ];
  const marks = (dtos: ReturnType<typeof agendaItemDtos>) =>
    Object.fromEntries(
      dtos.map((item) => [
        item.id,
        [item.titleHidden, item.unlisted, item.publicTitleHidden],
      ]),
    );

  it("tells a manager which titles the public does not read", () => {
    // [titleHidden, unlisted, publicTitleHidden]
    expect(marks(agendaItemDtos(guarded, guardedDocuments, true))).toEqual({
      first: [false, false, false],
      resolutions: [false, false, false],
      draft: [false, true, true],
      published: [false, false, false],
      submitted: [false, true, true],
      last: [false, false, false],
      gone: [false, false, true],
      under: [false, false, false],
      holder: [false, false, true],
      inner: [false, false, false],
    });
  });

  it("is the viewer's own titleHidden for someone who sees only what is public", () => {
    const dtos = agendaItemDtos(
      guarded,
      guardedDocuments.filter((document) => document.status === "published"),
      false,
    );
    for (const item of dtos) {
      expect(item.publicTitleHidden).toBe(item.titleHidden);
    }
    expect(dtos.find((item) => item.id === "gone")).toMatchObject({
      titleHidden: true,
      publicTitleHidden: true,
    });
  });
});
