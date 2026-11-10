import { describe, expect, it } from "vitest";
import { breadcrumbTrail, stripLocalePrefix, truncateLabel } from "./-trail";

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
