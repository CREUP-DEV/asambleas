import { describe, expect, it } from "vitest";
import type { AmendmentDto, VoteDto } from "~~/shared/types/api";
import {
  DEFAULT_AMENDMENT_SORT,
  DEFAULT_GENERAL_SORT,
  EMPTY_AMENDMENT_FILTERS,
  EMPTY_GENERAL_FILTERS,
  activeFilterCount,
  amendmentSheetQuery,
  clearedSheetQuery,
  filtersKey,
  generalSheetQuery,
  keepSeen,
  matchingGeneralIds,
  nextSort,
  parseAmendmentSheetQuery,
  parseGeneralSheetQuery,
  shownAmendmentRows,
  shownGeneralRows,
  type AmendmentSheetFilters,
  type GeneralSheetFilters,
} from "./-filters";
import type { AmendmentSheetRow, GeneralSheetRow } from "./-model";

const vote = (over: Partial<VoteDto> = {}): VoteDto => ({
  id: "v",
  subjectType: "document",
  subjectId: "d",
  method: "show_of_hands",
  inFavor: 20,
  against: 2,
  abstentions: 1,
  blank: 0,
  invalid: 0,
  present: null,
  majority: "simple",
  result: "approved",
  note: null,
  question: null,
  unanimous: false,
  recordedAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  voidedAt: null,
  ...over,
});

const row = (over: Partial<GeneralSheetRow>): GeneralSheetRow => ({
  id: "i",
  kind: "item",
  number: "1",
  unlisted: false,
  title: "Punto",
  titleHidden: false,
  publicTitleHidden: false,
  depth: 0,
  index: 0,
  ancestorIds: [],
  parent: null,
  documents: [],
  outcome: { result: null, treated: false, byVote: false },
  autoTreated: false,
  speakers: [],
  sheet: null,
  live: false,
  voted: false,
  itemVotes: [],
  votedThroughDocuments: false,
  takesOwnVote: true,
  ownListed: false,
  ...over,
});

/**
 * 1 Informes (item), 2 Resoluciones (heading) with 2.1 RES 1 and 2.2 RES 2,
 * 3 Elecciones (item).
 */
const rows: GeneralSheetRow[] = [
  row({
    id: "1",
    number: "1",
    index: 0,
    title: "Informe de la Presidencia",
    outcome: { result: "not_applicable", treated: true, byVote: false },
    speakers: [{ label: "CEUAM", names: ["Ana"] }],
  }),
  row({
    id: "2",
    kind: "heading",
    number: "2",
    index: 1,
    title: "Resoluciones",
  }),
  row({
    id: "2a",
    number: "2.1",
    index: 2,
    depth: 1,
    ancestorIds: ["2"],
    title: "RES 1",
    documents: [
      {
        id: "d1",
        slug: "d1",
        title: "Resolución sobre becas",
        status: "published",
        voted: true,
        finalVote: vote({ result: "rejected" }),
        majority: "simple",
        undecided: 0,
        updatedAt: "2026-11-19T10:00:00.000Z",
        proponent: {
          id: "m1",
          acronym: "UCM",
          name: "Delegación Central de Estudiantes de la UCM",
          kind: "asociado",
        },
        coProponents: [
          {
            id: "m2",
            acronym: "CEUVa",
            name: "Consejo de Estudiantes de la UVa",
            kind: "asociado",
          },
        ],
      },
    ],
    outcome: { result: "rejected", treated: true, byVote: true },
  }),
  row({
    id: "2b",
    number: "2.2",
    index: 3,
    depth: 1,
    ancestorIds: ["2"],
    title: "RES 2",
    sheet: {
      id: "s",
      agendaItemId: "2b",
      listed: false,
      listedUpdatedAt: null,
      manualResult: null,
      resultUpdatedAt: null,
      treated: null,
      progressUpdatedAt: null,
      observations: "Moción de orden",
      observationsEdited: null,
      observationsUpdatedAt: null,
    },
  }),
  row({
    id: "3",
    number: "3",
    index: 4,
    title: "Elecciones",
    itemVotes: [
      vote({
        id: "v3",
        subjectType: "agenda_item",
        subjectId: "3",
        recordedAt: "2026-11-20T12:00:00.000Z",
      }),
    ],
    outcome: { result: "approved", treated: true, byVote: true },
    speakers: [{ label: "UGR", names: [] }],
  }),
];

const general = (over: Partial<GeneralSheetFilters>): GeneralSheetFilters => ({
  ...EMPTY_GENERAL_FILTERS,
  ...over,
});

const ids = (list: readonly GeneralSheetRow[]) =>
  list.map((entry) => `${entry.kind === "heading" ? "#" : ""}${entry.id}`);

describe("nextSort", () => {
  it("keeps the state that goes first while the direction turns", () => {
    const led = {
      key: "result" as const,
      dir: "asc" as const,
      lead: "rejected",
    };
    expect(nextSort(led, "result", DEFAULT_GENERAL_SORT)).toEqual({
      key: "result",
      dir: "desc",
      lead: "rejected",
    });
    // Another column starts plain; back to the default drops it.
    expect(nextSort(led, "votes", DEFAULT_GENERAL_SORT)).toEqual({
      key: "votes",
      dir: "asc",
    });
    expect(
      nextSort({ ...led, dir: "desc" }, "result", DEFAULT_GENERAL_SORT),
    ).toEqual(DEFAULT_GENERAL_SORT);
  });

  it("goes ascending, descending, then back to the default order", () => {
    let sort = nextSort(DEFAULT_GENERAL_SORT, "result", DEFAULT_GENERAL_SORT);
    expect(sort).toEqual({ key: "result", dir: "asc" });
    sort = nextSort(sort, "result", DEFAULT_GENERAL_SORT);
    expect(sort).toEqual({ key: "result", dir: "desc" });
    sort = nextSort(sort, "result", DEFAULT_GENERAL_SORT);
    expect(sort).toEqual(DEFAULT_GENERAL_SORT);
  });

  it("only switches direction on the default column", () => {
    const desc = nextSort(DEFAULT_GENERAL_SORT, "number", DEFAULT_GENERAL_SORT);
    expect(desc).toEqual({ key: "number", dir: "desc" });
    expect(nextSort(desc, "number", DEFAULT_GENERAL_SORT)).toEqual(
      DEFAULT_GENERAL_SORT,
    );
  });
});

describe("shownGeneralRows", () => {
  it("keeps the agenda's order and its headings by default", () => {
    expect(
      ids(shownGeneralRows(rows, DEFAULT_GENERAL_SORT, EMPTY_GENERAL_FILTERS)),
    ).toEqual(["1", "#2", "2a", "2b", "3"]);
  });

  it("keeps a heading only above a row that passes", () => {
    expect(
      ids(
        shownGeneralRows(
          rows,
          DEFAULT_GENERAL_SORT,
          general({ view: "treated" }),
        ),
      ),
    ).toEqual(["1", "#2", "2a", "3"]);
    expect(
      ids(
        shownGeneralRows(
          rows,
          DEFAULT_GENERAL_SORT,
          general({ query: "elecciones" }),
        ),
      ),
    ).toEqual(["3"]);
  });

  it("turns an item with rows shown under it into a heading", () => {
    const nested = [
      row({ id: "a", number: "1", index: 0, title: "Normativa" }),
      row({
        id: "b",
        number: "1.1",
        index: 1,
        ancestorIds: ["a"],
        title: "Reglamento",
      }),
    ];
    expect(
      ids(
        shownGeneralRows(
          nested,
          DEFAULT_GENERAL_SORT,
          general({ query: "reglamento" }),
        ),
      ),
    ).toEqual(["#a", "b"]);
  });

  it("drops the headings in any other order, ties in the agenda's", () => {
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "treated", dir: "asc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["2b", "1", "2a", "3"]);
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "number", dir: "desc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["3", "2b", "2a", "1"]);
  });

  it("puts «Pendiente» and rows without a vote last either way", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(
        ids(
          shownGeneralRows(rows, { key: "result", dir }, EMPTY_GENERAL_FILTERS),
        ).at(-1),
      ).toBe("2b");
    }
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "result", dir: "asc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["3", "2a", "1", "2b"]);
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "votes", dir: "desc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["3", "2a", "1", "2b"]);
  });

  it("sorts by speakers and by title", () => {
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "speakers", dir: "desc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["1", "3", "2a", "2b"]);
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "item", dir: "asc" },
          EMPTY_GENERAL_FILTERS,
        ),
      ),
    ).toEqual(["3", "1", "2a", "2b"]);
  });

  it("sorts by main presenter, rows without one last either way", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(
        ids(
          shownGeneralRows(
            rows,
            { key: "proponent", dir },
            EMPTY_GENERAL_FILTERS,
          ),
        ),
      ).toEqual(["2a", "1", "2b", "3"]);
    }
  });

  it("searches numbers, titles, documents and speakers, accents aside", () => {
    const find = (query: string) =>
      [...matchingGeneralIds(rows, general({ query }))].sort();
    expect(find("2")).toEqual(["2a", "2b"]);
    expect(find("2.1")).toEqual(["2a"]);
    expect(find("becas")).toEqual(["2a"]);
    expect(find("ucm")).toEqual(["2a"]);
    expect(find("delegacion central")).toEqual(["2a"]);
    expect(find("ceuva")).toEqual(["2a"]);
    expect(find("ana")).toEqual(["1"]);
    expect(find("informe presidencia")).toEqual(["1"]);
    expect(find("ELECCIÓN")).toEqual(["3"]);
    expect(find("21")).toEqual([]);
  });

  it("filters by pending, observations and result", () => {
    const find = (filters: Partial<GeneralSheetFilters>) =>
      [...matchingGeneralIds(rows, general(filters))].sort();
    expect(find({ view: "pending" })).toEqual(["2b"]);
    expect(find({ observations: true })).toEqual(["2b"]);
    expect(find({ results: ["pending", "rejected"] })).toEqual(["2a", "2b"]);
  });

  it("keeps the rows it is asked to, with their headings", () => {
    expect(
      ids(
        shownGeneralRows(
          rows,
          DEFAULT_GENERAL_SORT,
          general({ view: "pending" }),
          new Set(["2a"]),
        ),
      ),
    ).toEqual(["#2", "2a", "2b"]);
  });

  it("keeps a heading in debate when the filters hide what hangs from it", () => {
    // Only 3 is approved: neither 2.1 nor 2.2 passes.
    expect(
      ids(
        shownGeneralRows(
          rows,
          DEFAULT_GENERAL_SORT,
          general({ results: ["approved"] }),
          new Set(["2"]),
        ),
      ),
    ).toEqual(["#2", "3"]);
    const nested = [
      row({ id: "a", kind: "heading", number: "1", index: 0, title: "Normas" }),
      row({
        id: "b",
        kind: "heading",
        number: "1.1",
        index: 1,
        ancestorIds: ["a"],
        title: "Reglamentos",
      }),
      row({
        id: "c",
        number: "1.1.1",
        index: 2,
        ancestorIds: ["b", "a"],
        title: "RRI",
      }),
    ];
    expect(
      ids(
        shownGeneralRows(
          nested,
          DEFAULT_GENERAL_SORT,
          general({ view: "treated" }),
          new Set(["b"]),
        ),
      ),
    ).toEqual(["#a", "#b"]);
  });

  it("keeps a heading in debate in any other order, sorted among the rows", () => {
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "number", dir: "desc" },
          EMPTY_GENERAL_FILTERS,
          new Set(["2"]),
        ),
      ),
    ).toEqual(["3", "2b", "2a", "#2", "1"]);
    expect(
      ids(
        shownGeneralRows(
          rows,
          { key: "result", dir: "asc" },
          general({ view: "pending" }),
          new Set(["2"]),
        ),
      ),
    ).toEqual(["#2", "2b"]);
  });
});

const amendment = (
  id: string,
  over: Partial<AmendmentSheetRow> = {},
  dto: Partial<AmendmentDto> = {},
): AmendmentSheetRow => {
  const full = {
    id,
    code: id.toUpperCase(),
    authors: [{ id: "m1", acronym: "UGR", name: "Granada", kind: "asociado" }],
    mainAuthorId: "m1",
    position: { position: "pending", comment: null, recordedBy: "presenter" },
    outcomeVote: null,
    ...dto,
  } as AmendmentDto;
  return {
    amendment: full,
    state: "pending",
    note: null,
    treated: false,
    autoTreated: false,
    sheet: null,
    // The answer the row shows: the amendment's unless a test gives one.
    position: full.position ?? null,
    live: false,
    ...over,
  } as AmendmentSheetRow;
};

const amendments: AmendmentSheetRow[] = [
  amendment(
    "a1",
    { state: "approved", treated: true },
    {
      position: {
        position: "accept",
        comment: null,
        recordedBy: "presenter",
        updatedAt: "",
      },
      outcomeVote: vote({ recordedAt: "2026-11-20T11:00:00.000Z" }),
    },
  ),
  amendment(
    "a2",
    {},
    {
      position: null,
      authors: [
        { id: "m2", acronym: "ANEM", name: "Medicina", kind: "sectorial" },
      ],
      mainAuthorId: "m2",
    },
  ),
  amendment(
    "a3",
    { state: "rejected", treated: true },
    {
      outcomeVote: vote({ recordedAt: "2026-11-20T10:00:00.000Z" }),
    },
  ),
];

const amendmentIds = (list: readonly AmendmentSheetRow[]) =>
  list.map((entry) => entry.amendment.id);

const amendmentFilters = (
  over: Partial<AmendmentSheetFilters>,
): AmendmentSheetFilters => ({ ...EMPTY_AMENDMENT_FILTERS, ...over });

describe("shownAmendmentRows", () => {
  it("keeps the console's order by default", () => {
    expect(
      amendmentIds(
        shownAmendmentRows(
          amendments,
          DEFAULT_AMENDMENT_SORT,
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["a1", "a2", "a3"]);
  });

  it("puts no answer last either way", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(
        amendmentIds(
          shownAmendmentRows(
            amendments,
            { key: "position", dir },
            EMPTY_AMENDMENT_FILTERS,
          ),
        ).at(-1),
      ).toBe("a2");
    }
  });

  it("sorts by type, content before form", () => {
    const rows = [
      amendment("x1", {}, { kind: "formal" }),
      amendment("x2", {}, { kind: "partial" }),
      amendment("x3", {}, { kind: "formal" }),
    ];
    expect(
      amendmentIds(
        shownAmendmentRows(
          rows,
          { key: "kind", dir: "asc" },
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["x2", "x1", "x3"]);
  });

  it("sorts by presenter, state and vote, ties in the console's order", () => {
    expect(
      amendmentIds(
        shownAmendmentRows(
          amendments,
          { key: "authors", dir: "asc" },
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["a2", "a1", "a3"]);
    expect(
      amendmentIds(
        shownAmendmentRows(
          amendments,
          { key: "result", dir: "asc" },
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["a2", "a1", "a3"]);
    expect(
      amendmentIds(
        shownAmendmentRows(
          amendments,
          { key: "vote", dir: "asc" },
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["a3", "a1", "a2"]);
  });

  it("sorts by the answer the row shows, the sheet's own first", () => {
    // The sheet gave a2's answer though the amendment carries none.
    const withSheetAnswer = amendments.map((entry) =>
      entry.amendment.id === "a2"
        ? {
            ...entry,
            position: {
              position: "reject" as const,
              comment: null,
              recordedBy: "presenter" as const,
              updatedAt: "",
            },
          }
        : entry,
    );
    expect(
      amendmentIds(
        shownAmendmentRows(
          withSheetAnswer,
          { key: "position", dir: "asc" },
          EMPTY_AMENDMENT_FILTERS,
        ),
      ),
    ).toEqual(["a3", "a1", "a2"]);
  });

  it("filters by code, presenter, treated and state", () => {
    const find = (filters: Partial<AmendmentSheetFilters>) =>
      amendmentIds(
        shownAmendmentRows(
          amendments,
          DEFAULT_AMENDMENT_SORT,
          amendmentFilters(filters),
        ),
      );
    expect(find({ query: "a3" })).toEqual(["a3"]);
    expect(find({ query: "medicina" })).toEqual(["a2"]);
    expect(find({ view: "pending" })).toEqual(["a2"]);
    expect(find({ view: "treated" })).toEqual(["a1", "a3"]);
    expect(find({ states: ["rejected", "approved"] })).toEqual(["a1", "a3"]);
  });

  it("keeps the rows it is asked to", () => {
    expect(
      amendmentIds(
        shownAmendmentRows(
          amendments,
          DEFAULT_AMENDMENT_SORT,
          amendmentFilters({ view: "pending" }),
          new Set(["a3"]),
        ),
      ),
    ).toEqual(["a2", "a3"]);
  });

  it("filters by type, who presents, the answer and the vote", () => {
    const find = (filters: Partial<AmendmentSheetFilters>) =>
      amendmentIds(
        shownAmendmentRows(
          amendments,
          DEFAULT_AMENDMENT_SORT,
          amendmentFilters(filters),
        ),
      );
    // a2 is ANEM's (m2), the others m1's.
    expect(find({ members: ["m2"] })).toEqual(["a2"]);
    // a1 accepts, a2 has no answer, a3 is pending.
    expect(find({ positions: ["none", "accept"] })).toEqual(["a1", "a2"]);
    // a1 and a3 have their vote.
    expect(find({ votes: ["voted"] })).toEqual(["a1", "a3"]);
    expect(find({ votes: ["unvoted"] })).toEqual(["a2"]);
    expect(find({ votes: ["voted", "unvoted"] })).toEqual(["a1", "a2", "a3"]);
    expect(find({ kinds: ["formal"] })).toEqual([]);
    expect(find({ kinds: ["content"] })).toEqual(["a1", "a2", "a3"]);
  });

  it("round-trips the new filters of «Enmiendas»", () => {
    const filters = amendmentFilters({
      kinds: ["formal"],
      members: ["m2"],
      positions: ["none"],
      votes: ["voted"],
    });
    const query = amendmentSheetQuery({
      sort: DEFAULT_AMENDMENT_SORT,
      filters,
    });
    expect(query).toMatchObject({
      tipo: "forma",
      quien: "m2",
      respuesta: "sin-respuesta",
      votacion: "votadas",
    });
    expect(
      parseAmendmentSheetQuery(query as Record<string, string>).filters,
    ).toEqual(filters);
    // A malformed member id is left out.
    expect(
      parseAmendmentSheetQuery({ quien: "m1,<x>,m1" }).filters.members,
    ).toEqual(["m1"]);
  });

  it("sorts by the order they were presented in, by «Enmienda»", () => {
    // The console's order (the rows' own) is a2, a3, a1; presented 3, 1, 2.
    const presented = [
      amendment("a2", {}, { number: 3 }),
      amendment("a3", {}, { number: 1 }),
      amendment("a1", {}, { number: 2 }),
    ];
    const by = (key: "code" | "treatment", dir: "asc" | "desc") =>
      amendmentIds(
        shownAmendmentRows(presented, { key, dir }, EMPTY_AMENDMENT_FILTERS),
      );
    expect(by("code", "asc")).toEqual(["a3", "a1", "a2"]);
    expect(by("code", "desc")).toEqual(["a2", "a1", "a3"]);
    // The default, the order of treatment, is the rows' own.
    expect(by("treatment", "asc")).toEqual(["a2", "a3", "a1"]);
    expect(by("treatment", "desc")).toEqual(["a1", "a3", "a2"]);
  });

  it("puts any state first, the rest in the column's order", () => {
    const states = (key: "result" | "position", lead: string) =>
      amendmentIds(
        shownAmendmentRows(
          amendments,
          { key, dir: "asc", lead },
          EMPTY_AMENDMENT_FILTERS,
        ),
      );
    // a1 approved, a2 pending, a3 rejected.
    expect(states("result", "rejected")).toEqual(["a3", "a2", "a1"]);
    expect(states("result", "approved")).toEqual(["a1", "a2", "a3"]);
    // a1 accepts, a2 has no answer, a3 is pending: no answer may lead.
    expect(states("position", "none")).toEqual(["a2", "a3", "a1"]);
    expect(states("position", "accept")).toEqual(["a1", "a3", "a2"]);
  });
});

describe("keepSeen", () => {
  it("adds what passes now until the filters change", () => {
    const first = keepSeen(new Set(), new Set(["a"]), true);
    expect([...first]).toEqual(["a"]);
    const same = keepSeen(first, new Set(["a"]), false);
    expect(same).toBe(first);
    expect([...keepSeen(first, new Set(["b"]), false)]).toEqual(["a", "b"]);
    expect([...keepSeen(first, new Set(["b"]), true)]).toEqual(["b"]);
  });
});

describe("filters in use", () => {
  it("counts the search, the chip and the results", () => {
    expect(activeFilterCount(EMPTY_GENERAL_FILTERS)).toBe(0);
    expect(
      activeFilterCount(
        general({ query: " x ", view: "pending", results: ["approved"] }),
      ),
    ).toBe(3);
    expect(filtersKey(general({ query: " x " }))).toBe(
      filtersKey(general({ query: "x" })),
    );
  });
});

describe("the query", () => {
  it("reads nothing as the default order and no filters", () => {
    expect(parseGeneralSheetQuery({})).toEqual({
      sort: DEFAULT_GENERAL_SORT,
      filters: EMPTY_GENERAL_FILTERS,
    });
    expect(parseAmendmentSheetQuery({})).toEqual({
      sort: DEFAULT_AMENDMENT_SORT,
      filters: EMPTY_AMENDMENT_FILTERS,
    });
  });

  it("round-trips «General»", () => {
    const state = {
      sort: { key: "result" as const, dir: "desc" as const },
      filters: general({
        query: "becas",
        view: "pending",
        results: ["rejected", "pending"],
        members: ["m1", "m2"],
        votes: ["unvoted"],
        observations: true,
      }),
    };
    const query = generalSheetQuery(state);
    expect(query).toMatchObject({
      orden: "resultado",
      sentido: "desc",
      q: "becas",
      ver: "pendientes",
      resultado: "pendiente,rechazado",
      quien: "m1,m2",
      votacion: "sin-votar",
      observaciones: "con",
      estado: undefined,
    });
    expect(parseGeneralSheetQuery(query as Record<string, string>)).toEqual({
      ...state,
      filters: { ...state.filters, results: ["pending", "rejected"] },
    });
  });

  it("round-trips «Enmiendas», the default order writing nothing", () => {
    const state = {
      sort: DEFAULT_AMENDMENT_SORT,
      filters: amendmentFilters({
        view: "treated",
        states: ["late", "debating"],
      }),
    };
    const query = amendmentSheetQuery(state);
    expect(query).toEqual({
      orden: undefined,
      sentido: undefined,
      q: undefined,
      ver: "tratadas",
      resultado: undefined,
      estado: "en-debate,fuera-de-plazo",
    });
    expect(
      parseAmendmentSheetQuery({
        ver: "tratadas",
        estado: "en-debate,fuera-de-plazo",
      }),
    ).toEqual({
      ...state,
      filters: { ...state.filters, states: ["debating", "late"] },
    });
    expect(
      amendmentSheetQuery({
        sort: { key: "treatment", dir: "desc" },
        filters: EMPTY_AMENDMENT_FILTERS,
      }),
    ).toMatchObject({ orden: undefined, sentido: "desc" });
  });

  it("round-trips the state that goes first, only on a column of states", () => {
    const sort = { key: "result" as const, dir: "asc" as const, lead: "late" };
    const query = amendmentSheetQuery({
      sort,
      filters: EMPTY_AMENDMENT_FILTERS,
    });
    expect(query).toMatchObject({
      orden: "resultado",
      primero: "fuera-de-plazo",
    });
    expect(
      parseAmendmentSheetQuery({
        orden: "resultado",
        primero: "fuera-de-plazo",
      }).sort,
    ).toEqual(sort);
    expect(
      parseAmendmentSheetQuery({ orden: "respuesta", primero: "sin-respuesta" })
        .sort,
    ).toEqual({ key: "position", dir: "asc", lead: "none" });
    // A state the column does not have, or a column without states.
    expect(
      parseAmendmentSheetQuery({ orden: "resultado", primero: "raro" }).sort,
    ).toEqual({ key: "result", dir: "asc" });
    expect(
      parseAmendmentSheetQuery({ orden: "presenta", primero: "pendiente" })
        .sort,
    ).toEqual({ key: "authors", dir: "asc" });
    expect(
      parseGeneralSheetQuery({ orden: "resultado", primero: "pendiente" }).sort,
    ).toEqual({ key: "result", dir: "asc", lead: "pending" });
  });

  it("leaves out what it does not know", () => {
    expect(
      parseGeneralSheetQuery({
        orden: "nada",
        sentido: "desc",
        ver: "tratadas",
        resultado: ["aprobado,raro", "decaido"],
      }),
    ).toEqual({
      sort: DEFAULT_GENERAL_SORT,
      filters: general({ results: ["approved", "lapsed"] }),
    });
  });

  it("clears every sort and filter key", () => {
    expect(clearedSheetQuery()).toEqual({
      orden: undefined,
      sentido: undefined,
      q: undefined,
      ver: undefined,
      resultado: undefined,
      estado: undefined,
    });
  });
});
