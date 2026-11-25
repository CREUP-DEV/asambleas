import { describe, expect, it } from "vitest";
import {
  breadcrumbTrail,
  documentItemCrumbs,
  pendingStep,
  stripLocalePrefix,
  truncateLabel,
  unloadedDocumentKey,
  type TrailRegistry,
} from "./-trail";

const kinds = (path: string) =>
  breadcrumbTrail(path).steps.map((step) => step.kind);

describe("stripLocalePrefix", () => {
  it("removes the locale of a prefixed path", () => {
    expect(stripLocalePrefix("/en/asambleas/80-ago", ["es", "en"])).toBe(
      "/asambleas/80-ago",
    );
    expect(stripLocalePrefix("/en", ["es", "en"])).toBe("/");
  });

  it("leaves the default locale's paths alone", () => {
    expect(stripLocalePrefix("/asambleas", ["es", "en"])).toBe("/asambleas");
    expect(stripLocalePrefix("/", ["es", "en"])).toBe("/");
  });
});

describe("breadcrumbTrail", () => {
  it("gives the home page and unknown pages no trail", () => {
    expect(breadcrumbTrail("/").steps).toEqual([]);
    expect(breadcrumbTrail("/login").steps).toEqual([]);
    expect(breadcrumbTrail("/proyeccion/80-ago").steps).toEqual([]);
  });

  it("lists the assemblies on their own", () => {
    expect(breadcrumbTrail("/asambleas")).toEqual({
      steps: [{ kind: "assemblies", path: "/asambleas" }],
      exact: true,
    });
    expect(breadcrumbTrail("/asambleas/").exact).toBe(true);
  });

  it("ends an assembly's overview on the assembly", () => {
    expect(breadcrumbTrail("/asambleas/80-ago")).toEqual({
      steps: [
        { kind: "assemblies", path: "/asambleas" },
        { kind: "assembly", path: "/asambleas/80-ago", param: "80-ago" },
      ],
      exact: true,
    });
  });

  it("adds the section of an assembly", () => {
    const trail = breadcrumbTrail("/asambleas/80-ago/orden-del-dia");
    expect(trail.exact).toBe(true);
    expect(trail.steps[2]).toEqual({
      kind: "section",
      path: "/asambleas/80-ago/orden-del-dia",
      section: "agenda",
    });
    expect(kinds("/asambleas/80-ago/sesion")).toEqual([
      "assemblies",
      "assembly",
      "section",
    ]);
  });

  it("names the room as a section of the assembly", () => {
    expect(breadcrumbTrail("/asambleas/80-ago/sala")).toEqual({
      steps: [
        { kind: "assemblies", path: "/asambleas" },
        { kind: "assembly", path: "/asambleas/80-ago", param: "80-ago" },
        { kind: "section", path: "/asambleas/80-ago/sala", section: "seating" },
      ],
      exact: true,
    });
  });

  it("adds the document and the page open on it", () => {
    const base = "/asambleas/80-ago/documentos/resoluci%C3%B3n-x";
    expect(breadcrumbTrail(base)).toEqual({
      steps: [
        { kind: "assemblies", path: "/asambleas" },
        { kind: "assembly", path: "/asambleas/80-ago", param: "80-ago" },
        {
          kind: "section",
          path: "/asambleas/80-ago/documentos",
          section: "documents",
        },
        { kind: "document", path: base, param: "resolución-x" },
      ],
      exact: true,
    });
    for (const [segment, view] of [
      ["editar", "edit"],
      ["revisar", "answers"],
      ["consolidado", "consolidated"],
    ] as const) {
      const trail = breadcrumbTrail(`${base}/${segment}`);
      expect(trail.exact).toBe(true);
      expect(trail.steps[4]).toEqual({
        kind: "documentView",
        path: `${base}/${segment}`,
        view,
      });
    }
  });

  it("adds the page of an agenda item", () => {
    const path = "/asambleas/80-ago/orden-del-dia/punto-3";
    const trail = breadcrumbTrail(path);
    expect(trail.exact).toBe(true);
    expect(trail.steps).toHaveLength(4);
    expect(trail.steps[3]).toEqual({
      kind: "agendaItem",
      path,
      param: "punto-3",
    });
    expect(breadcrumbTrail(`${path}/otra`)).toMatchObject({
      exact: false,
      steps: { length: 4 },
    });
  });

  it("keeps the last known step as an ancestor on deeper paths", () => {
    const trail = breadcrumbTrail("/asambleas/80-ago/sesion/otra");
    expect(trail.exact).toBe(false);
    expect(trail.steps).toHaveLength(3);
    expect(breadcrumbTrail("/asambleas/80-ago/otra-cosa")).toMatchObject({
      exact: false,
      steps: [{ kind: "assemblies" }, { kind: "assembly" }],
    });
    expect(breadcrumbTrail("/asambleas/80-ago/documentos/doc/otra").exact).toBe(
      false,
    );
  });

  it("gives the admin pages no trail: the sidebar names the section", () => {
    expect(breadcrumbTrail("/admin")).toEqual({ steps: [], exact: false });
    expect(breadcrumbTrail("/admin/usuarios")).toEqual({
      steps: [],
      exact: false,
    });
  });

  it("names the personal activity page", () => {
    expect(breadcrumbTrail("/actividad")).toEqual({
      steps: [{ kind: "myActivity", path: "/actividad" }],
      exact: true,
    });
  });

  it("ignores the query and the hash", () => {
    expect(breadcrumbTrail("/asambleas/80-ago/documentos?kind=x").exact).toBe(
      true,
    );
  });
});

describe("truncateLabel", () => {
  it("keeps short labels", () => {
    expect(truncateLabel("  R-3  ")).toBe("R-3");
  });

  it("cuts long labels at a word", () => {
    const label = truncateLabel(
      "Resolución sobre la financiación de las universidades públicas",
      30,
    );
    expect(label).toBe("Resolución sobre la…");
    expect(label.length).toBeLessThanOrEqual(30);
  });

  it("cuts a single long word", () => {
    expect(truncateLabel("a".repeat(60), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("pendingStep", () => {
  const empty: TrailRegistry = {
    labels: {},
    agendaChains: {},
    documentChains: {},
  };
  const pending = (path: string, registry: TrailRegistry) => {
    const { steps } = breadcrumbTrail(path);
    return steps.map((step) => pendingStep(step, steps, registry));
  };

  it("leaves the levels named by the route alone", () => {
    expect(pending("/asambleas/80-ago/documentos", empty)).toEqual([
      false,
      false,
      false,
    ]);
    expect(pending("/asambleas/80-ago/sesion", empty)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("keeps a document and its section pending until its page registers them", () => {
    const path = "/asambleas/80-ago/documentos/res-4/revisar";
    expect(pending(path, empty)).toEqual([false, false, true, true, false]);
    expect(
      pending(path, {
        ...empty,
        labels: { "document:res-4": "Resolución 4" },
        documentChains: { "document:res-4": [{ id: "x", label: "3.12" }] },
      }),
    ).toEqual([false, false, false, false, false]);
  });

  it("treats an empty chain as registered: the route's trail stays", () => {
    const path = "/asambleas/80-ago/documentos/res-4";
    expect(
      pending(path, {
        ...empty,
        labels: { "document:res-4": "Resolución 4" },
        documentChains: { "document:res-4": [] },
      }),
    ).toEqual([false, false, false, false]);
  });

  it("keeps an agenda item pending until its chain is registered", () => {
    const path = "/asambleas/80-ago/orden-del-dia/punto-3";
    expect(pending(path, empty)).toEqual([false, false, false, true]);
    expect(
      pending(path, {
        ...empty,
        agendaChains: { "punto-3": [{ id: "punto-3", label: "3. Punto" }] },
      }),
    ).toEqual([false, false, false, false]);
  });

  it("never takes a key of Object.prototype as registered", () => {
    const path = "/asambleas/80-ago/orden-del-dia/constructor";
    expect(pending(path, empty)).toEqual([false, false, false, true]);
  });
});

describe("unloadedDocumentKey", () => {
  const empty = { labels: {}, documentChains: {} };

  it("settles the route's document once its load has failed", () => {
    expect(unloadedDocumentKey("res-4", true, empty)).toBe("document:res-4");
  });

  it("waits while the document may still come", () => {
    expect(unloadedDocumentKey("res-4", false, empty)).toBeNull();
  });

  it("needs a route param", () => {
    expect(unloadedDocumentKey("", true, empty)).toBeNull();
    expect(unloadedDocumentKey(undefined, true, empty)).toBeNull();
    expect(unloadedDocumentKey(["res-4"], true, empty)).toBeNull();
  });

  it("settles only what is not registered yet", () => {
    expect(
      unloadedDocumentKey("res-4", true, {
        labels: { "document:res-4": "" },
        documentChains: {},
      }),
    ).toBe("document:res-4");
    expect(
      unloadedDocumentKey("res-4", true, {
        labels: { "document:res-4": "" },
        documentChains: { "document:res-4": [] },
      }),
    ).toBeNull();
  });

  it("leaves both levels settled for pendingStep: «Documentos › Documento»", () => {
    const path = "/asambleas/80-ago/documentos/res-4/editar";
    const key = unloadedDocumentKey("res-4", true, empty)!;
    const registry: TrailRegistry = {
      labels: { [key]: "" },
      agendaChains: {},
      documentChains: { [key]: [] },
    };
    const { steps } = breadcrumbTrail(path);
    expect(steps.map((step) => pendingStep(step, steps, registry))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("documentItemCrumbs", () => {
  const node = (
    number: string | null,
    slug: string,
    title: string,
    generatedForDocumentId: string | null = null,
  ) => ({
    number,
    item: {
      slug,
      title,
      auto: generatedForDocumentId !== null,
      generatedForDocumentId,
    },
  });

  it("numbers every item from the root down", () => {
    expect(
      documentItemCrumbs(
        [node("3", "resoluciones", "Resoluciones"), node("3.2", "res", "Otra")],
        "doc-1",
        "(sin publicar)",
      ),
    ).toEqual([
      { id: "resoluciones", label: "3. Resoluciones" },
      { id: "res", label: "3.2. Otra" },
    ]);
  });

  it("names the document's own automatic sub-item by its number alone", () => {
    expect(
      documentItemCrumbs(
        [
          node("3", "informes", "Informes"),
          node("3.12", "informe-x", "Informe X", "doc-1"),
        ],
        "doc-1",
        "(sin publicar)",
      ),
    ).toEqual([
      { id: "informes", label: "3. Informes" },
      { id: "informe-x", label: "3.12" },
    ]);
  });

  it("keeps the title of another document's sub-item or one with no number", () => {
    expect(
      documentItemCrumbs(
        [node("3.1", "otro", "Otro", "doc-2")],
        "doc-1",
        "(sin publicar)",
      ),
    ).toEqual([{ id: "otro", label: "3.1. Otro" }]);
    expect(
      documentItemCrumbs(
        [node(null, "nuevo", "Nuevo", "doc-1")],
        "doc-1",
        "(sin publicar)",
      ),
    ).toEqual([{ id: "nuevo", label: "Nuevo (sin publicar)" }]);
  });

  it("names a hand-made item by its number when it holds only the document under its title", () => {
    expect(
      documentItemCrumbs(
        [
          node("3", "informes", "Informes"),
          node("3.22", "logistica", "Informe de la Vocalía de Logística"),
        ],
        "doc-1",
        "(sin publicar)",
        {
          title: "  informe de la vocalía  de logística ",
          aloneInItem: true,
        },
      ),
    ).toEqual([
      { id: "informes", label: "3. Informes" },
      { id: "logistica", label: "3.22" },
    ]);
  });

  it("keeps a hand-made item's title when it differs or holds other documents", () => {
    const path = [node("3.22", "logistica", "Informe de Logística")];
    expect(
      documentItemCrumbs(path, "doc-1", "(sin publicar)", {
        title: "Informe de la Vocalía de Logística",
        aloneInItem: true,
      }),
    ).toEqual([{ id: "logistica", label: "3.22. Informe de Logística" }]);
    expect(
      documentItemCrumbs(path, "doc-1", "(sin publicar)", {
        title: "Informe de Logística",
        aloneInItem: false,
      }),
    ).toEqual([{ id: "logistica", label: "3.22. Informe de Logística" }]);
  });

  it("only shortens the document's own item, not an ancestor with the same title", () => {
    expect(
      documentItemCrumbs(
        [node("3", "informe", "Informe"), node("3.1", "otro", "Otro")],
        "doc-1",
        "(sin publicar)",
        { title: "Informe", aloneInItem: true },
      ),
    ).toEqual([
      { id: "informe", label: "3. Informe" },
      { id: "otro", label: "3.1. Otro" },
    ]);
  });
});
