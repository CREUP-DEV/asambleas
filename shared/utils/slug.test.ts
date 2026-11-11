import { describe, expect, it } from "vitest";
import {
  agendaItemSlugs,
  pickDocumentSlug,
  planDocumentSlugs,
  SLUG_MAX_LENGTH,
  slugify,
} from "./slug";

describe("agendaItemSlugs", () => {
  it("names each item after its title, the first created keeping the plain one", () => {
    const slugs = agendaItemSlugs([
      { id: "b", title: "Ruegos y preguntas", createdAt: "2026-02-01" },
      {
        id: "a",
        title: "Ratificación de la Mesa de Moderación",
        createdAt: "2026-01-01",
      },
      { id: "c", title: "Ruegos y preguntas", createdAt: "2026-01-15" },
      { id: "d", title: "¿?", createdAt: "2026-03-01" },
    ]);
    expect(Object.fromEntries(slugs)).toEqual({
      a: "ratificacion-de-la-mesa-de-moderacion",
      c: "ruegos-y-preguntas",
      b: "ruegos-y-preguntas-2",
      d: "punto",
    });
  });
});

describe("pickDocumentSlug", () => {
  it("takes the title's slug when free, else the next -n", () => {
    expect(pickDocumentSlug("Informe", new Set())).toBe("informe");
    expect(pickDocumentSlug("Informe", new Set(["informe", "informe-2"]))).toBe(
      "informe-3",
    );
  });

  it("never takes a word of the routes nor an empty slug", () => {
    expect(pickDocumentSlug("Nuevo", new Set())).toBe("nuevo-2");
    expect(pickDocumentSlug("¿?", new Set())).toBe("documento");
  });
});

describe("planDocumentSlugs", () => {
  it("lists only the documents whose slug changes, first come first served", () => {
    const longTitle =
      "Resolución sobre la metodología de medición y garantía del cumplimiento";
    expect(
      planDocumentSlugs([
        { id: "a", slug: "informe", title: "Informe" },
        {
          id: "b",
          slug: "resolucion-sobre-la-metodologia-de-medicion-y-garantia-del",
          title: longTitle,
        },
        { id: "c", slug: "informe-2", title: "Informe" },
        { id: "d", slug: "otro", title: "Informe" },
      ]),
    ).toEqual([
      {
        id: "b",
        from: "resolucion-sobre-la-metodologia-de-medicion-y-garantia-del",
        to: "resolucion-sobre-la-metodologia-de-medicion-y-garantia-del-cumplimiento",
      },
      { id: "d", from: "otro", to: "informe-3" },
    ]);
  });
});

describe("slugify", () => {
  it("keeps a short title whole", () => {
    expect(slugify("Resolución sobre Ponderaciones")).toBe(
      "resolucion-sobre-ponderaciones",
    );
  });

  it("keeps a usual long title whole", () => {
    expect(
      slugify(
        "Posicionamiento sobre el Aprendizaje Centrado en el Estudiantado",
      ),
    ).toBe("posicionamiento-sobre-el-aprendizaje-centrado-en-el-estudiantado");
  });

  it("keeps a very long title whole", () => {
    expect(
      slugify(
        "Moción Interna sobre la traducción de documentos a las lenguas oficiales del Estado y su publicación en la web",
      ),
    ).toBe(
      "mocion-interna-sobre-la-traduccion-de-documentos-a-las-lenguas-oficiales-del-estado-y-su-publicacion-en-la-web",
    );
  });

  it("cuts a title past the limit after its last whole word", () => {
    const words = Array.from({ length: SLUG_MAX_LENGTH }, () => "Lengua");
    const slug = slugify(words.join(" "));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.length).toBeGreaterThan(SLUG_MAX_LENGTH - "-lengua".length);
    expect(slug.endsWith("-lengua")).toBe(true);
  });

  it("keeps a word that ends exactly at the limit", () => {
    const title = `${"a".repeat(SLUG_MAX_LENGTH - 4)} bcd efg`;
    expect(slugify(title)).toBe(`${"a".repeat(SLUG_MAX_LENGTH - 4)}-bcd`);
  });

  it("cuts a single overlong word at the limit", () => {
    expect(slugify("x".repeat(SLUG_MAX_LENGTH + 10))).toHaveLength(
      SLUG_MAX_LENGTH,
    );
  });
});
