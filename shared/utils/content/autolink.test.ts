import { describe, expect, it } from "vitest";
import type { Block } from "../../types/content";
import { findBareUrls, withAutolinks } from "./autolink";
import { consolidate } from "./consolidate";
import { diffText } from "./diff";
import { renderAnnotated, renderBlocks } from "./render";

const p = (id: string, text: string, marks: Block["marks"] = []): Block => ({
  id,
  type: "paragraph",
  text,
  marks,
});

/** The addresses found in `text`, as text. */
const urls = (text: string) =>
  findBareUrls(text).map(({ from, to }) => text.slice(from, to));

const anchor = (href: string, inner = href) =>
  `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank" draggable="false">${inner}</a>`;

describe("findBareUrls", () => {
  it("leaves out the full stop that ends the sentence", () => {
    // The real footnote of the 80.ª AGO document (block 288).
    const url =
      "https://transparente.ugr.es/sites/serv/transp/public/ficheros/Institucional/20241027_CONTRATO%20PROGRAMA%20CUII%20-%20UGR%20(v3)_def%2026_12_24%20(%20rev)(limpio).pdf";
    expect(urls(`[23]  Consejería de Universidad. ${url}.`)).toEqual([url]);
  });

  it("drops sentence punctuation and quotes at the end", () => {
    expect(urls("Ver https://creup.es, y https://x.org/a?b=1;")).toEqual([
      "https://creup.es",
      "https://x.org/a?b=1",
    ]);
    expect(urls("«https://creup.es/a» y “http://creup.es/b”.")).toEqual([
      "https://creup.es/a",
      "http://creup.es/b",
    ]);
    expect(urls("¿Está en https://creup.es/faq?")).toEqual([
      "https://creup.es/faq",
    ]);
    expect(urls("Véanse https://creup.es/a… y 'https://creup.es/b'.")).toEqual([
      "https://creup.es/a",
      "https://creup.es/b",
    ]);
  });

  it("drops a closing bracket the address did not open", () => {
    expect(urls("(véase https://creup.es/a).")).toEqual(["https://creup.es/a"]);
    expect(urls("(https://es.wikipedia.org/wiki/Bolonia_(Italia))")).toEqual([
      "https://es.wikipedia.org/wiki/Bolonia_(Italia)",
    ]);
    expect(urls("[https://creup.es]")).toEqual(["https://creup.es"]);
  });

  it("keeps escapes, queries and fragments", () => {
    expect(
      urls("https://www.boe.es/buscar/act.php?id=BOE-A-2023-7500&p=20%20x#a5"),
    ).toEqual([
      "https://www.boe.es/buscar/act.php?id=BOE-A-2023-7500&p=20%20x#a5",
    ]);
  });

  it("finds every address, at any case, and ends one at a blank", () => {
    expect(urls("HTTPS://A.ES/x\nhttp://b.es/y\thttps://c.es/z y fin")).toEqual(
      ["HTTPS://A.ES/x", "http://b.es/y", "https://c.es/z"],
    );
  });

  it("skips what is not a bare web address", () => {
    expect(urls("https:// suelto, https:/// y https://.")).toEqual([]);
    expect(urls("mailto:alguien@creup.es y ftp://creup.es")).toEqual([]);
    expect(urls("xhttps://creup.es y ahttp://creup.es")).toEqual([]);
    expect(urls("Texto sin enlaces.")).toEqual([]);
  });
});

describe("withAutolinks", () => {
  it("adds a link mark over each address", () => {
    const text = "Ver https://creup.es.";
    expect(withAutolinks(text, [])).toEqual([
      { type: "link", from: 4, to: 20, href: "https://creup.es" },
    ]);
  });

  it("returns the same marks when there is nothing to link", () => {
    const marks: Block["marks"] = [{ type: "bold", from: 0, to: 3 }];
    expect(withAutolinks("Sin enlaces", marks)).toBe(marks);
  });

  it("never links inside a link or a formula", () => {
    const text = "Ver https://creup.es y https://x.org";
    const link = {
      type: "link" as const,
      from: 0,
      to: 10,
      href: "https://otra.es",
    };
    const formula = { type: "formula" as const, from: 23, to: 28 };
    expect(withAutolinks(text, [link, formula])).toEqual([link, formula]);
  });

  it("never links an address that touches an excepted range", () => {
    const text = "Ver https://creup.es y https://x.org";
    expect(withAutolinks(text, [], [{ from: 10, to: 11 }])).toEqual([
      { type: "link", from: 23, to: 36, href: "https://x.org" },
    ]);
  });
});

describe("rendering bare addresses", () => {
  it("draws them as links, the full stop outside", () => {
    expect(renderBlocks([p("u001", "Ver https://creup.es/a?b=1&c=2.")])).toBe(
      `<p data-block-id="u001">Ver ${anchor("https://creup.es/a?b=1&amp;c=2")}.</p>`,
    );
  });

  it("links several, and keeps the marks inside one", () => {
    const html = renderBlocks([
      p("u002", "https://a.es/x y https://b.es/y", [
        { type: "bold", from: 8, to: 20 },
      ]),
    ]);
    expect(html).toBe(
      '<p data-block-id="u002">' +
        anchor("https://a.es/x", "https://") +
        anchor("https://a.es/x", "<strong>a.es/x</strong>") +
        "<strong> y </strong>" +
        anchor("https://b.es/y", "<strong>htt</strong>") +
        anchor("https://b.es/y", "ps://b.es/y") +
        "</p>",
    );
  });

  it("keeps a stored link's own target", () => {
    const html = renderBlocks([
      p("u003", "https://creup.es", [
        { type: "link", from: 0, to: 16, href: "https://otra.es" },
      ]),
    ]);
    expect(html).toBe(
      `<p data-block-id="u003">${anchor("https://otra.es", "https://creup.es")}</p>`,
    );
  });

  it("leaves a formula drawn whole", () => {
    const html = renderBlocks([
      p("u004", "x https://a.es", [{ type: "formula", from: 0, to: 1 }]),
    ]);
    expect(html).toContain("<math");
    expect(html).toContain(anchor("https://a.es"));
  });

  it("links the address as it reads now in the clean text", () => {
    const base = [p("u005", "Fuente: https://creup.es/2024/informe.pdf.")];
    const ops = diffText(
      base[0]!,
      "Fuente: https://creup.es/2025/informe.pdf.",
    );
    const { annotated } = consolidate(base, [{ id: "A", ops }]);

    expect(renderAnnotated(annotated, { mode: "clean" })).toBe(
      renderBlocks([p("u005", "Fuente: https://creup.es/2025/informe.pdf.")]),
    );
  });

  it("never links an address an amended fragment touches", () => {
    // A click on the fragment picks its amendment (an interactive view
    // makes it a button): a link inside it would open the site instead.
    const base = [p("u007", "Fuente: https://creup.es/2024/informe.pdf.")];
    const ops = diffText(
      base[0]!,
      "Fuente: https://creup.es/2025/informe.pdf.",
    );
    const { annotated } = consolidate(base, [{ id: "A", ops }]);

    const diff = renderAnnotated(annotated, { mode: "diff" });
    expect(diff).not.toContain("<a ");
    expect(diff).toMatch(
      /<del class="cx-del[^"]*" data-amendment-id="A">[^<]*4[^<]*<\/del>/,
    );
    expect(diff).toMatch(
      /<ins class="cx-ins[^"]*" data-amendment-id="A">[^<]*5[^<]*<\/ins>/,
    );
    const provenance = renderAnnotated(annotated, {
      mode: "provenance",
      label: () => "1",
    });
    expect(provenance).not.toContain("<a ");
    expect(provenance).toContain(
      '<span class="cx-prov" data-amendment-id="A">',
    );
  });

  it("still links an address the amendment leaves alone", () => {
    const base = [p("u008", "Fuente: https://creup.es/a. Año 2024.")];
    const ops = diffText(base[0]!, "Fuente: https://creup.es/a. Año 2025.");
    const { annotated } = consolidate(base, [{ id: "A", ops }]);
    for (const mode of ["diff", "provenance"] as const) {
      const html = renderAnnotated(annotated, { mode, label: () => "1" });
      expect(html).toContain(anchor("https://creup.es/a"));
      expect(html).toContain('data-amendment-id="A"');
    }
  });

  it("never links inside a block formatted anew in provenance", () => {
    const base: Block[] = [p("u009", "Fuente: https://creup.es/a.")];
    const { annotated } = consolidate(base, [
      {
        id: "F",
        ops: [
          {
            op: "replace",
            blockId: "u009",
            from: 0,
            to: 0,
            text: "",
            baseText: "",
            block: { type: "heading", level: 2 },
          },
        ],
      },
    ]);
    const html = renderAnnotated(annotated, {
      mode: "provenance",
      label: () => "1",
    });
    expect(html).toContain('class="cx-prov" data-amendment-id="F"');
    expect(html).not.toContain("<a ");
  });

  it("does not link a formula block's source", () => {
    const html = renderBlocks([
      { id: "u006", type: "formula", text: "x", marks: [] },
    ]);
    expect(html).not.toContain("<a ");
  });
});
