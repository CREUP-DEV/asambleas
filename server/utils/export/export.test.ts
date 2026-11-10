import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Content,
  ContentOrderedList,
  ContentText,
  ContentUnorderedList,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { create as createFont } from "fontkit";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { FORMAT_CHANGE_CODES } from "../../../shared/types/content";
import { consolidate } from "../../../shared/utils/content/consolidate";
import {
  BRAND_FILES,
  BRAND_RED,
  bandLabelKey,
  type ExportBrand,
} from "./brand";
import {
  CELL_FILLS,
  CELL_FILL_NAMES,
  CELL_FILL_TEXT,
} from "../../../shared/constants/cellFills";
import {
  LINK_BLUE,
  LinkRegistry,
  annotatedToPdf,
  blocksToPdf,
  pdfImageKey,
} from "./content";
import {
  createFormatLabeller,
  createTranslator,
  formatExportDateRange,
  interpolate,
} from "./labels";
import {
  amendmentCodes,
  annexDisplayCode,
  approvalOrder,
  buildAgendaTree,
  buildAnnexRows,
  consolidationInput,
  presentersLabel,
  type AnnexAmendment,
} from "./mapping";
import {
  buildAssemblyPdf,
  buildDocumentPdf,
  type AssemblyExportData,
  type DocumentExportData,
  type ExportAssembly,
  type ExportDocumentMeta,
} from "./pdfBuilder";
import {
  RALEWAY_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "./pdfmake";

const FONTS_DIR = resolve(__dirname, "../../assets/fonts");
const ASSETS_DIR = resolve(__dirname, "../../assets");

/** The letterhead files the export worker reads. */
const brand: ExportBrand = {
  creupLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.creupLogo)),
  esuLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.esuLogo)),
  labelFont: createFont(readFileSync(resolve(FONTS_DIR, "Raleway-Bold.woff"))),
};

beforeAll(() => {
  const files = Object.fromEntries(
    Object.values(RALEWAY_FILES).map((name) => [
      name,
      readFileSync(resolve(FONTS_DIR, name)),
    ]),
  ) as Record<RalewayFile, Buffer>;
  registerPdfFonts(files);
});

async function render(
  definition: TDocumentDefinitions,
): Promise<{ pdf: string; pages: number }> {
  const buffer = await pdfmake.createPdf(definition).getBuffer();
  const pdf = buffer.toString("latin1");
  return { pdf, pages: (pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length };
}

// Fixtures ------------------------------------------------------------------

const p = (id: string, text: string, marks: Block["marks"] = []): Block => ({
  id,
  type: "paragraph",
  text,
  marks,
});

const li = (
  id: string,
  text: string,
  level: number,
  list: "bullet" | "ordered",
): Block => ({ id, type: "list_item", level, list, text, marks: [] });

const base: Block[] = [
  {
    id: "h1",
    type: "heading",
    level: 1,
    text: "Artículo 1. Objeto",
    marks: [],
  },
  p(
    "b1",
    "El alumnado deberá reintegrar la ayuda cuando no supere el 50 % de los créditos.",
    [
      { type: "bold", from: 0, to: 11 },
      { type: "italic", from: 3, to: 20 },
      { type: "link", from: 21, to: 29, href: "https://creup.es/becas" },
    ],
  ),
  {
    id: "h2",
    type: "heading",
    level: 2,
    text: "Artículo 2. Procedimiento",
    marks: [],
  },
  li("l1", "Primera fase", 0, "ordered"),
  li("l2", "Subfase con detalle", 1, "bullet"),
  li("l3", "Segunda fase", 0, "ordered"),
  li("l4", "Tercera fase", 0, "ordered"),
  {
    id: "q1",
    type: "quote",
    level: undefined,
    text: "Cita literal del reglamento.",
    marks: [{ type: "underline", from: 0, to: 4 }],
  },
  p("b2", "Disposición final.", [{ type: "strike", from: 0, to: 11 }]),
];

const percent = base[1]!.text.indexOf("50 %");
const opsA: AmendmentOp[] = [
  {
    op: "replace",
    blockId: "b1",
    from: percent,
    to: percent + 4,
    text: "40 %",
    baseText: "50 %",
  },
];
const opsB: AmendmentOp[] = [{ op: "delete", blockIds: ["l3"] }];
const opsC: AmendmentOp[] = [
  {
    op: "insert",
    afterBlockId: "b2",
    blocks: [p("n1", "Disposición adicional nueva.")],
  },
];
const opsConflict: AmendmentOp[] = [
  {
    op: "replace",
    blockId: "b1",
    from: percent,
    to: percent + 4,
    text: "30 %",
    baseText: "50 %",
  },
];

function amendment(
  overrides: Partial<AnnexAmendment> & Pick<AnnexAmendment, "id">,
): AnnexAmendment {
  return {
    number: null,
    code: null,
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    approvalMethod: null,
    decidedAt: null,
    positionKey: 0,
    authors: [],
    sourceIds: [],
    derivedIds: [],
    vote: null,
    ...overrides,
  };
}

const amendments: AnnexAmendment[] = [
  amendment({
    id: "a1",
    number: 1,
    code: "CEUM 1",
    status: "approved",
    approvalMethod: "vote",
    decidedAt: new Date("2026-11-21T10:00:00Z"),
    authors: ["CEUM"],
    vote: { inFavor: 30, against: 4, abstentions: 2 },
  }),
  amendment({
    id: "a2",
    number: 2,
    code: "CEUCO 1",
    status: "approved",
    approvalMethod: "proponent",
    decidedAt: new Date("2026-11-21T09:00:00Z"),
    authors: ["CEUCO"],
  }),
  amendment({
    id: "a3",
    number: 3,
    code: "DA 1",
    status: "transacted",
    authors: ["DA", "CEUM"],
    derivedIds: ["t1"],
  }),
  amendment({
    id: "t1",
    number: 5,
    code: "T1",
    kind: "transactional",
    status: "approved",
    approvalMethod: "assent",
    decidedAt: new Date("2026-11-21T11:00:00Z"),
    sourceIds: ["a3", "hidden"],
    authors: ["DA"],
  }),
  amendment({
    id: "a4",
    number: 4,
    code: "CEUM 2",
    status: "approved",
    approvalMethod: "vote",
    decidedAt: new Date("2026-11-21T12:00:00Z"),
    authors: ["CEUM"],
  }),
  amendment({ id: "draft", status: "draft", authors: ["CEUM"] }),
  amendment({
    id: "hidden",
    number: 6,
    code: "X 1",
    status: "submitted",
    late: true,
    admission: "pending",
  }),
];

const opsById: Record<string, AmendmentOp[]> = {
  a1: opsA,
  a2: opsB,
  t1: opsC,
  a4: opsConflict,
};

const assembly: ExportAssembly = {
  label: "80.ª AGO",
  type: "AGO",
  startDate: new Date("2026-11-20T09:00:00Z"),
  endDate: new Date("2026-11-22T14:00:00Z"),
  location: "Universidad de Murcia",
};

const meta: ExportDocumentMeta = {
  title: "Resolución sobre becas",
  reference: "RES 012/2026",
  kind: "resolution",
  format: "structured",
  proponent: "CEUM",
  fileName: null,
  agendaNumbering: "3.1",
  agendaTitle: "Resoluciones",
  finalVote: {
    inFavor: 40,
    against: 2,
    abstentions: 1,
    majority: "two_thirds",
    result: "approved",
    recordedAt: new Date("2026-11-22T12:00:00Z"),
  },
};

// Mapping -------------------------------------------------------------------

describe("buildAgendaTree", () => {
  it("numbers items hierarchically and lists documents in agenda order", () => {
    const tree = buildAgendaTree(
      [
        {
          id: "r2",
          parentId: null,
          title: "Ruegos",
          description: null,
          order: 2,
        },
        {
          id: "r1",
          parentId: null,
          title: "Resoluciones",
          description: "Debate",
          order: 1,
        },
        {
          id: "c2",
          parentId: "r1",
          title: "Segunda",
          description: null,
          order: 1,
        },
        {
          id: "c1",
          parentId: "r1",
          title: "Primera",
          description: null,
          order: 0,
        },
        {
          id: "g1",
          parentId: "c2",
          title: "Nieta",
          description: null,
          order: 0,
        },
        {
          id: "orphan",
          parentId: "missing",
          title: "Huérfano",
          description: null,
          order: 5,
        },
      ],
      [
        {
          id: "d3",
          agendaItemId: "r2",
          title: "D3",
          reference: null,
          kind: "other",
        },
        {
          id: "d1",
          agendaItemId: "c2",
          title: "D1",
          reference: "RES 001/2026",
          kind: "resolution",
        },
        {
          id: "d2",
          agendaItemId: "g1",
          title: "D2",
          reference: null,
          kind: "report",
        },
      ],
    );
    expect(tree.nodes.map((node) => `${node.numbering} ${node.title}`)).toEqual(
      ["1 Resoluciones", "2 Ruegos", "3 Huérfano"],
    );
    expect(tree.nodes[0]!.children.map((node) => node.numbering)).toEqual([
      "1.1",
      "1.2",
    ]);
    expect(tree.numbering.get("g1")).toBe("1.2.1");
    expect(tree.documentOrder).toEqual(["d1", "d2", "d3"]);
  });

  it("places items caught in a parent cycle once, as roots", () => {
    const tree = buildAgendaTree([
      { id: "a", parentId: "b", title: "A", description: null, order: 0 },
      { id: "b", parentId: "a", title: "B", description: null, order: 1 },
      { id: "c", parentId: null, title: "C", description: null, order: 0 },
    ]);
    // The same tree every screen builds: each item of the cycle is a root.
    expect(tree.nodes.map((node) => node.numbering)).toEqual(["1", "2", "3"]);
    expect(tree.numbering.get("a")).toBe("1");
    expect(tree.numbering.get("c")).toBe("2");
    expect(tree.numbering.get("b")).toBe("3");
  });

  it("gives no number to an unlisted item and never shifts its siblings", () => {
    const row = (id: string, parentId: string | null, order: number) => ({
      id,
      parentId,
      title: id,
      description: null,
      order,
    });
    const tree = buildAgendaTree([
      row("r", null, 0),
      { ...row("draft", "r", 0), unlisted: true },
      row("published", "r", 1),
      row("s", null, 1),
    ]);
    expect(tree.numbering.get("draft")).toBeNull();
    expect(tree.numbering.get("published")).toBe("1.1");
    expect(tree.numbering.get("s")).toBe("2");
    expect(tree.nodes[0]!.children.map((node) => node.numbering)).toEqual([
      null,
      "1.1",
    ]);
  });

  it("never carries the title of an item marked as hidden", () => {
    const tree = buildAgendaTree([
      {
        id: "a",
        parentId: null,
        title: "Borrador ajeno",
        description: null,
        order: 0,
        titleHidden: true,
      },
      { id: "b", parentId: "a", title: "B", description: null, order: 0 },
    ]);
    expect(tree.nodes[0]).toMatchObject({ title: "", titleHidden: true });
    expect(tree.nodes[0]!.children[0]).toMatchObject({ title: "B" });
    expect(tree.nodes[0]!.children[0]).not.toHaveProperty("titleHidden");
  });
});

describe("presentersLabel", () => {
  it("names the main presenter first, then the co-presenters", () => {
    expect(presentersLabel("CEUAM", ["CEUM", "UPV"])).toBe("CEUAM, CEUM, UPV");
    expect(presentersLabel("CEUAM", [])).toBe("CEUAM");
  });

  it("never repeats a member and says nothing when nobody presents it", () => {
    expect(presentersLabel("CEUM", ["CEUM"])).toBe("CEUM");
    expect(presentersLabel(null, [])).toBeNull();
    expect(presentersLabel(undefined, ["UPV"])).toBe("UPV");
  });
});

describe("annex", () => {
  const ordered = approvalOrder(amendments).map((entry) => entry.id);
  const result = consolidate(
    base,
    ordered.map((id) => ({ id, ops: opsById[id] ?? [] })),
  );

  it("consolidates approved amendments in decision order and reports conflicts", () => {
    expect(ordered).toEqual(["a2", "a1", "t1", "a4"]);
    expect(result.applied).toEqual(["a2", "a1", "t1"]);
    expect(result.conflicts).toEqual([
      { amendmentId: "a4", conflictsWith: ["a1"] },
    ]);
  });

  it("lists visible amendments past draft by number, without leaking hidden codes", () => {
    const visible = new Set(["a1", "a2", "a3", "t1", "a4", "draft"]);
    const rows = buildAnnexRows({
      amendments,
      visibleIds: visible,
      conflicts: result.conflicts,
    });
    expect(rows.map((row) => row.displayCode)).toEqual([
      "1 · CEUM 1",
      "2 · CEUCO 1",
      "3 · DA 1",
      "4 · CEUM 2",
      "5 · T1",
    ]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.a3!.transactedInto).toEqual(["T1"]);
    expect(byId.t1!.sourceCodes).toEqual(["DA 1"]);
    expect(byId.a4!.conflict).toEqual(["CEUM 1"]);
    expect(byId.a1!.conflict).toBeNull();
  });

  it("leaves approved amendments without operations out of consolidation", () => {
    const input = consolidationInput([
      { ...amendments[0]!, ops: opsA },
      {
        ...amendment({
          id: "ret",
          kind: "totality_return",
          status: "approved",
          decidedAt: new Date("2026-11-21T08:00:00Z"),
        }),
        ops: [],
      },
      { ...amendments[2]!, ops: opsB },
    ]);
    expect(input).toEqual([{ id: "a1", ops: opsA }]);
    expect(consolidate(base, input).conflicts).toEqual([]);
  });

  it("formats codes", () => {
    expect(annexDisplayCode({ number: 7, code: null })).toBe("7");
    expect(annexDisplayCode({ number: null, code: null })).toBe("?");
    expect(amendmentCodes(amendments).a1).toBe("CEUM 1");
  });
});

// Content -------------------------------------------------------------------

describe("blocksToPdf", () => {
  it("nests lists, keeps marks and numbers links", () => {
    const links = new LinkRegistry();
    const nodes = blocksToPdf(base, { links });
    const paragraph = nodes[1] as ContentText;
    const pieces = paragraph.text as ContentText[];
    expect(pieces[0]).toMatchObject({ text: "El ", bold: true });
    expect(pieces[1]).toMatchObject({
      text: "alumnado",
      bold: true,
      italics: true,
    });
    expect(pieces.some((piece) => piece.sup && piece.text === "[1]")).toBe(
      true,
    );
    expect(links.entries).toEqual(["https://creup.es/becas"]);

    const list = nodes[3] as ContentOrderedList;
    expect(list.ol).toHaveLength(4);
    expect((list.ol[1] as ContentUnorderedList).ul).toHaveLength(1);
    expect((list.ol[3] as { counter?: number }).counter).toBe(3);
  });

  it("never turns unsafe links into references", () => {
    const links = new LinkRegistry();
    blocksToPdf(
      [
        p("x", "click", [
          { type: "link", from: 0, to: 5, href: "javascript:alert(1)" },
        ]),
      ],
      {
        links,
      },
    );
    expect(links.entries).toEqual([]);
  });
});

describe("annotatedToPdf", () => {
  const { annotated } = consolidate(base, [
    { id: "a2", ops: opsB },
    { id: "a1", ops: opsA },
    { id: "t1", ops: opsC },
  ]);
  const nodes = annotatedToPdf(annotated, {
    links: new LinkRegistry(),
    codeOf: (id) => ({ a1: "CEUM 1", a2: "CEUCO 1", t1: "T1" })[id] ?? "?",
  });
  const flat = JSON.stringify(nodes);

  it("underlines inserted text, strikes removed text and marks the code", () => {
    const pieces = (nodes[1] as ContentText).text as ContentText[];
    expect(pieces).toContainEqual(
      expect.objectContaining({ text: "50 %", decoration: "lineThrough" }),
    );
    expect(pieces).toContainEqual(
      expect.objectContaining({ text: "40 %", decoration: "underline" }),
    );
    expect(pieces).toContainEqual(
      expect.objectContaining({ text: "CEUM 1", sup: true }),
    );
    expect(flat).toContain("Disposición adicional nueva.");
  });

  it("keeps deleted list items struck and unnumbered", () => {
    const list = nodes[3] as ContentOrderedList;
    const deleted = list.ol[2] as { listType?: string; counter?: number };
    expect(deleted.listType).toBe("none");
    expect((list.ol[3] as { counter?: number }).counter).toBe(2);
  });

  it("says in words what a change of format does", () => {
    const formatted = consolidate(base, [
      {
        id: "f1",
        ops: [
          {
            op: "replace",
            blockId: "b2",
            from: 12,
            to: 17,
            text: "final",
            baseText: "final",
            marks: [{ type: "bold", from: 0, to: 5 }],
          },
          {
            op: "replace",
            blockId: "l1",
            from: 0,
            to: 0,
            text: "",
            baseText: "",
            block: { type: "heading", level: 2 },
          },
        ],
      },
    ]).annotated;
    for (const locale of ["es", "en"] as const) {
      const es = locale === "es";
      const content = annotatedToPdf(formatted, {
        links: new LinkRegistry(),
        codeOf: () => "CEUM 2",
        formatLabel: createFormatLabeller(locale),
      });
      // The text keeps its place over a dotted line, in its new format,
      // followed by the change and the amendment's code.
      const pieces = (content[content.length - 1] as ContentText)
        .text as ContentText[];
      const at = pieces.findIndex((piece) => piece.text === "final");
      expect(pieces[at]).toMatchObject({
        bold: true,
        decoration: "underline",
        decorationStyle: "dotted",
      });
      expect(pieces[at + 1]).toMatchObject({
        text: es ? " (pasa a negrita)" : " (becomes bold)",
        style: "formatNote",
      });
      expect(pieces[at + 2]).toMatchObject({ text: "CEUM 2", sup: true });
      // Written once: never struck and written again.
      expect(pieces.filter((piece) => piece.text === "final")).toHaveLength(1);

      // The list item is a heading now, and starts by saying so. The words
      // stay out of its bookmark.
      const heading = content[3] as ContentText;
      expect(heading.style).toBe("heading2");
      expect((heading.text as ContentText[]).slice(0, 2)).toMatchObject([
        {
          text: es
            ? "[pasa a título de nivel 2]"
            : "[becomes a level 2 heading]",
          style: "formatNote",
        },
        { text: "CEUM 2", sup: true },
      ]);
      expect(heading.outlineText).toBeUndefined();
    }
    const outlined = annotatedToPdf(formatted, {
      links: new LinkRegistry(),
      outline: {},
      codeOf: () => "CEUM 2",
      formatLabel: createFormatLabeller("es"),
    });
    expect((outlined[3] as ContentText).outlineText).toBe("Primera fase");
  });

  it("names every change of format in both languages", () => {
    for (const locale of ["es", "en"] as const) {
      const label = createFormatLabeller(locale);
      for (const code of FORMAT_CHANGE_CODES) {
        const text = label({ code, value: 3 });
        expect(text, `${locale} ${code}`).not.toBe("");
        expect(text).not.toContain("{");
      }
    }
  });
});

describe("labels", () => {
  it("interpolates named placeholders", () => {
    expect(interpolate("{a} y {b} {missing}", { a: 1, b: "dos" })).toBe(
      "1 y dos {missing}",
    );
  });

  it("falls back to the key path when a label is missing", () => {
    const t = createTranslator("en");
    expect(t("__missing__")).toBe("export.pdf.__missing__");
  });

  it("prints a single day without a range", () => {
    const t = createTranslator("es");
    const day = new Date("2026-11-20T09:00:00Z");
    expect(
      formatExportDateRange(day, new Date("2026-11-20T18:00:00Z"), "es", t),
    ).toBe("20 de noviembre de 2026");
  });
});

// Rendering -----------------------------------------------------------------

describe("pdf rendering", () => {
  it("renders a clean document", async () => {
    const data: DocumentExportData = {
      assembly,
      document: meta,
      body: { variant: "clean", source: "working", blocks: base },
      generatedAt: new Date(),
    };
    const { pdf, pages } = await render(buildDocumentPdf(data, "es"));
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pdf).toContain("/Outlines");
  });

  it("renders an annotated document with its annex on a new page", async () => {
    const ordered = approvalOrder(amendments);
    const result = consolidate(
      base,
      ordered.map(({ id }) => ({ id, ops: opsById[id] ?? [] })),
    );
    const data: DocumentExportData = {
      assembly,
      document: meta,
      body: {
        variant: "annotated",
        blocks: result.annotated,
        codes: amendmentCodes(amendments),
        annex: buildAnnexRows({
          amendments,
          visibleIds: new Set(amendments.map((entry) => entry.id)),
          conflicts: result.conflicts,
        }),
      },
      generatedAt: new Date(),
    };
    const { pdf, pages } = await render(buildDocumentPdf(data, "en"));
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  it("renders an empty annotated document and an empty annex", async () => {
    const data: DocumentExportData = {
      assembly,
      document: {
        ...meta,
        finalVote: null,
        proponent: null,
        agendaNumbering: null,
      },
      body: { variant: "annotated", blocks: [], codes: {}, annex: [] },
      generatedAt: new Date(),
    };
    const { pages } = await render(buildDocumentPdf(data, "es"));
    expect(pages).toBe(2);
  });

  it("renders the assembly dossier with structured and uploaded documents", async () => {
    const tree = buildAgendaTree(
      [
        {
          id: "r1",
          parentId: null,
          title: "Resoluciones",
          description: "Debate y votación",
          order: 0,
        },
        {
          id: "c1",
          parentId: "r1",
          title: "Becas",
          description: null,
          order: 0,
        },
        {
          id: "r2",
          parentId: null,
          title: "Cuentas",
          description: null,
          order: 1,
        },
      ],
      [
        {
          id: "d1",
          agendaItemId: "c1",
          title: meta.title,
          reference: meta.reference,
          kind: meta.kind,
        },
        {
          id: "d2",
          agendaItemId: "r2",
          title: "Cuentas 2025",
          reference: null,
          kind: "accounts",
        },
      ],
    );
    const data: AssemblyExportData = {
      assembly,
      agenda: tree.nodes,
      documents: [
        { meta, source: "consolidated", blocks: base },
        {
          meta: {
            ...meta,
            title: "Cuentas 2025",
            format: "file",
            fileName: "cuentas.pdf",
            finalVote: null,
          },
          source: null,
          blocks: [],
        },
        { meta: { ...meta, title: "Vacío" }, source: "base", blocks: [] },
      ],
      generatedAt: new Date(),
    };
    const { pdf, pages } = await render(buildAssemblyPdf(data, "es"));
    expect(pdf.startsWith("%PDF")).toBe(true);
    // Cover, agenda and one page per document.
    expect(pages).toBe(5);
  });

  it("renders a dossier without agenda or documents", async () => {
    const data: AssemblyExportData = {
      assembly: { ...assembly, endDate: assembly.startDate },
      agenda: [],
      documents: [],
      generatedAt: new Date(),
    };
    const { pages } = await render(buildAssemblyPdf(data, "en"));
    expect(pages).toBe(2);
  });

  it("escapes nothing and embeds no remote content", () => {
    const definition = buildDocumentPdf(
      {
        assembly,
        document: meta,
        body: {
          variant: "clean",
          source: "base",
          blocks: [p("x", "<img src=x onerror=alert(1)>", [])],
        },
        generatedAt: new Date(),
      },
      "es",
    );
    const flat = JSON.stringify(definition.content as Content);
    expect(flat).toContain("<img src=x onerror=alert(1)>");
    expect(flat).not.toContain('"image"');
  });
});

// Template ------------------------------------------------------------------

/** The layers of a page's background (the watermark, then the band). */
function background(definition: TDocumentDefinitions): { svg: string }[] {
  const page = (
    definition.background as (page: number) => {
      stack: { svg: string }[];
    }
  )(1);
  return page.stack;
}

describe("images", () => {
  // A 1x1 red PNG.
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
  const ASSET = "q8w2e9r1t7y3u6i4o0p5a2s8";
  const picture = (id: string, width: number, height: number): Block => ({
    id,
    type: "image",
    image: { asset: ASSET, width, height, alt: "Organigrama" },
    text: "",
    marks: [],
  });

  it("draws an image at its size, never wider than the text", () => {
    const images = { [ASSET]: { dataUrl: PNG, width: 3000, height: 1500 } };
    const [small, large] = blocksToPdf(
      [picture("img1", 200, 100), picture("img2", 3000, 1500)],
      { links: new LinkRegistry(), images },
    ) as { image: string; width: number; height: number }[];
    expect(small).toMatchObject({
      image: pdfImageKey(ASSET),
      width: 150,
      height: 75,
    });
    expect(large!.width).toBeCloseTo(595.28 - 85 - 85.6, 1);
    expect(large!.height).toBeCloseTo(large!.width / 2, 1);
  });

  it("leaves the description where an image could not be loaded", () => {
    const [node] = blocksToPdf([picture("img3", 10, 10)], {
      links: new LinkRegistry(),
    }) as ContentText[];
    expect(node).toMatchObject({ text: "[Organigrama]", italics: true });
  });

  it("embeds an image once, however often the text shows it", async () => {
    // Opaque, so it is one image object (a transparent one adds its mask).
    const opaque = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#792225" },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${opaque.toString("base64")}`;
    const { pdf } = await render(
      buildDocumentPdf(
        {
          assembly,
          document: meta,
          body: {
            variant: "clean",
            source: "base",
            blocks: [picture("img4", 10, 10), picture("img5", 10, 10)],
          },
          generatedAt: new Date(),
          images: { [ASSET]: { dataUrl, width: 2, height: 2 } },
        },
        "es",
      ),
    );
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(1);
  });
});

describe("CREUP template", () => {
  const heading = (id: string, level: number, text: string): Block => ({
    id,
    type: "heading",
    level,
    text,
    marks: [],
  });

  const headings = [
    heading("a", 1, "Áreas de trabajo"),
    heading("b", 2, "Trabajo individual"),
    heading("c", 3, "Trabajo realizado"),
    heading("d", 4, "Dominios"),
  ];
  type HeadingNode = Content & {
    style?: string;
    headlineLevel?: number;
    table?: { body: ContentText[][] };
    layout?: { fillColor?: () => string | null };
  };

  it("draws level 1 on a burgundy bar and level 3 in a box, keeping bookmarks", () => {
    const nodes = blocksToPdf(headings, {
      links: new LinkRegistry(),
      outline: {},
    }) as HeadingNode[];
    expect(nodes.map((node) => node.headlineLevel)).toEqual([1, 2, 3, 4]);
    const bar = nodes[0]!;
    expect(bar.layout!.fillColor!()).toBe(BRAND_RED);
    expect(bar.table!.body[0]![0]).toMatchObject({
      style: "barHeading",
      outline: true,
      outlineText: "Áreas de trabajo",
    });
    expect(nodes[2]!.layout!.fillColor!()).toBeNull();
    expect(nodes[1]).toMatchObject({ style: "heading2", outline: true });
  });

  it("nests each bookmark under the nearest higher heading", () => {
    const nodes = blocksToPdf(
      [
        heading("a", 1, "Áreas"),
        heading("b", 1, "Valoración"),
        heading("c", 2, "Individual"),
        heading("d", 3, "Realizado"),
        heading("e", 4, "Dominios"),
        heading("f", 3, "Pendiente"),
        heading("g", 2, "Comisión"),
      ],
      { links: new LinkRegistry(), outline: { parentId: "doc" } },
    ) as HeadingNode[];
    const marks = nodes.map((node) => {
      const text = (
        node.table ? node.table.body[0]![0] : node
      ) as ContentText & {
        id?: string;
      };
      return [text.outlineText, text.id, text.outlineParentId];
    });
    expect(marks).toEqual([
      ["Áreas", "doc-heading-1", "doc"],
      ["Valoración", "doc-heading-2", "doc"],
      ["Individual", "doc-heading-3", "doc-heading-2"],
      ["Realizado", "doc-heading-4", "doc-heading-3"],
      ["Dominios", "doc-heading-5", "doc-heading-4"],
      ["Pendiente", "doc-heading-6", "doc-heading-3"],
      ["Comisión", "doc-heading-7", "doc-heading-2"],
    ]);
  });

  it("draws a draft's watermark as outlines, not selectable text", () => {
    const data: DocumentExportData = {
      assembly,
      document: meta,
      body: { variant: "clean", source: "working", blocks: base },
      generatedAt: new Date(),
    };
    const definition = buildDocumentPdf(data, "es", brand);
    expect(definition.watermark).toBeUndefined();
    const [watermark, band] = background(definition);
    expect(watermark!.svg).toMatch(/fill-opacity="0.07" d="M/);
    expect(watermark!.svg).not.toContain("<text");
    expect(band!.svg).toContain(`fill="${BRAND_RED}"`);
    // Without the letterhead's font, pdfmake's own watermark stands in.
    expect(buildDocumentPdf(data, "es").watermark).toMatchObject({
      text: "BORRADOR",
    });
  });

  it("colours links, makes them work and keeps their references", () => {
    const nodes = blocksToPdf(
      [
        p("x", "Ver la web y esto", [
          { type: "link", from: 4, to: 10, href: "https://creup.es" },
          { type: "link", from: 13, to: 17, href: "javascript:alert(1)" },
        ]),
      ],
      { links: new LinkRegistry() },
    );
    const pieces = (nodes[0] as ContentText).text as ContentText[];
    expect(pieces).toContainEqual(
      expect.objectContaining({
        text: "la web",
        color: LINK_BLUE,
        link: "https://creup.es",
        decoration: "underline",
      }),
    );
    expect(pieces).toContainEqual(
      expect.objectContaining({ text: "[1]", sup: true }),
    );
    // An unsafe link stays plain text.
    expect(pieces.find((piece) => piece.text === "esto")).not.toHaveProperty(
      "link",
    );
  });

  it("lays out the letterhead: logos, band and footer", () => {
    const data: DocumentExportData = {
      assembly,
      document: meta,
      body: { variant: "clean", source: "base", blocks: base },
      generatedAt: new Date(),
    };
    const definition = buildDocumentPdf(data, "es", brand);
    expect(Object.keys(definition.images ?? {})).toEqual([
      "creupLogo",
      "esuLogo",
    ]);
    const header = JSON.stringify((definition.header as () => Content)());
    expect(header).toContain('"image":"creupLogo"');
    expect(header).toContain('"image":"esuLogo"');

    const layers = background(definition);
    // A published text has no watermark: the band alone.
    expect(layers).toHaveLength(1);
    const band = layers[0]!;
    expect(band.svg).toContain(`fill="${BRAND_RED}"`);
    // The label, drawn as glyph outlines.
    expect(band.svg).toMatch(/<path [^>]*rotate\(-90\)[^>]*d="M/);

    const footer = JSON.stringify(
      (definition.footer as (page: number, total: number) => Content)(3, 12),
    );
    expect(footer).toContain('"link":"https://www.creup.es/"');
    expect(footer).toContain('"link":"mailto:info@creup.es"');
    expect(footer).toContain(
      '{"text":"3","bold":true},{"text":" de "},{"text":"12","bold":true}',
    );
    // This fixture is a resolution: no cover.
    expect(definition.content).not.toContainEqual(
      expect.objectContaining({ style: "coverTitle" }),
    );

    // Without the letterhead files the band keeps no label.
    const bare = buildDocumentPdf(data, "en");
    expect(bare.images).toBeUndefined();
    expect(background(bare)[0]!.svg).not.toContain("<path");
  });

  it("renders the letterhead into every page, embedding the logos once", async () => {
    const blocks = Array.from({ length: 120 }, (_, index) =>
      p(`p${index}`, "Texto de relleno para ocupar varias páginas. ".repeat(6)),
    );
    const { pdf, pages } = await render(
      buildDocumentPdf(
        {
          assembly,
          document: meta,
          body: { variant: "clean", source: "base", blocks },
          generatedAt: new Date(),
        },
        "es",
        brand,
      ),
    );
    expect(pages).toBeGreaterThan(3);
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBeLessThanOrEqual(
      4,
    );
    // Laying out several pages takes seconds under a full run's load.
  }, 15_000);

  it("names the kind of document on the band", () => {
    const label = (kind: ExportDocumentMeta["kind"]) => bandLabelKey(kind);
    expect(label("internal_motion")).toBe("internalMotion");
    expect(label("regulation")).toBe("ownRegulations");
    expect(label("statutes")).toBe("ownRegulations");
    expect(label("positioning")).toBe("positioning");
    expect(label("resolution")).toBe("resolution");
    expect(label("report")).toBe("internalDocument");
    expect(createTranslator("es")("band.internalMotion")).toBe(
      "Moción Interna",
    );
  });

  it("opens a positioning with a cover and counts pages after it", async () => {
    const data: DocumentExportData = {
      assembly,
      document: {
        ...meta,
        kind: "positioning",
        title: "Posicionamiento sobre becas",
      },
      body: { variant: "clean", source: "base", blocks: base },
      generatedAt: new Date(),
    };
    const definition = buildDocumentPdf(data, "es", brand);
    expect((definition.content as Content[])[0]).toMatchObject({
      text: "POSICIONAMIENTO SOBRE BECAS",
      style: "coverTitle",
      pageBreak: "after",
    });
    const header = definition.header as (page: number) => Content | null;
    const footer = definition.footer as (
      page: number,
      total: number,
    ) => Content | null;
    expect(header(1)).toBeNull();
    expect(footer(1, 5)).toBeNull();
    expect(JSON.stringify(footer(2, 5))).toContain(
      '{"text":"1","bold":true},{"text":" de "},{"text":"4","bold":true}',
    );
    const { pages } = await render(definition);
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  it("numbers PDF lists with their marker and start", () => {
    const item = (id: string, text: string, extra: Partial<Block> = {}) => ({
      ...li(id, text, 0, "ordered"),
      ...extra,
    });
    const nodes = blocksToPdf(
      [
        item("a", "Primero", { marker: "a)" }),
        item("b", "Segundo", { marker: "a)" }),
        p("c", "Párrafo intermedio."),
        item("d", "Tercero", { marker: "a)", start: 3 }),
        item("e", "Cuarto", { marker: "I." }),
      ],
      { links: new LinkRegistry() },
    ) as (ContentOrderedList & { separator?: string })[];
    const lists = nodes.filter((node) => "ol" in node);
    expect(lists.map((list) => [list.type, list.separator])).toEqual([
      ["lower-alpha", ")"],
      ["lower-alpha", ")"],
      ["upper-roman", "."],
    ]);
    const counters = lists.map((list) =>
      list.ol.map((entry) => (entry as { counter?: number }).counter),
    );
    expect(counters).toEqual([[1, 2], [3], [1]]);
  });

  it("draws tables with header rows, spans and widths that fit the page", async () => {
    const at = (row: string, cell: string, extra = {}) => ({
      table: "tab1",
      row,
      cell,
      ...extra,
    });
    const cellBlock = (id: string, text: string, cell: Block["cell"]) => ({
      ...p(id, text),
      cell,
    });
    const blocks: Block[] = [
      cellBlock("c1", "Órgano/organismo", at("r1", "a", { header: true })),
      cellBlock("c2", "Fecha", at("r1", "b", { header: true })),
      cellBlock("c3", "Descripción", at("r1", "c", { header: true })),
      cellBlock("c4", "Vocalía de Relaciones Internacionales", at("r2", "d")),
      cellBlock("c5", "05/03/2026", at("r2", "e")),
      cellBlock(
        "c6",
        "Contestación de encuesta de ESU sobre IA y digitalización en las universidades.",
        at("r2", "f"),
      ),
      cellBlock(
        "c7",
        "Explicación breve que ocupa dos",
        at("r3", "g", { colspan: 2 }),
      ),
      cellBlock("c8", "Resto", at("r3", "h")),
    ];
    const [node] = blocksToPdf(blocks, { links: new LinkRegistry() }) as {
      table: {
        headerRows: number;
        widths: number[];
        body: Record<string, unknown>[][];
      };
    }[];
    expect(node!.table.headerRows).toBe(1);
    expect(node!.table.body[0]![0]).toMatchObject({
      fillColor: BRAND_RED,
      color: "#ffffff",
    });
    // The spanning cell, then pdfmake's placeholder for what it covers.
    expect(node!.table.body[2]![0]).toMatchObject({ colSpan: 2 });
    expect(node!.table.body[2]![1]).toEqual({});
    // pdfmake adds each cell's padding (5 pt a side) and the rules (0.75 pt)
    // to the widths: with them, the table fills the text width exactly.
    const columns = node!.table.widths.length;
    const total = node!.table.widths.reduce((sum, width) => sum + width, 0);
    expect(total + columns * 10 + (columns + 1) * 0.75).toBeCloseTo(
      595.28 - 85 - 85.6,
      1,
    );
    // The date column is wide enough for its date.
    expect(node!.table.widths[1]).toBeGreaterThan(60);

    const { pages } = await render(
      buildDocumentPdf(
        {
          assembly,
          document: meta,
          body: { variant: "clean", source: "base", blocks },
          generatedAt: new Date(),
        },
        "es",
      ),
    );
    expect(pages).toBe(1);
  });

  it("fills cells from the palette, with the text colour of each fill", () => {
    const cell = (id: string, extra: Partial<Block["cell"]>) => ({
      ...p(id, id),
      cell: { table: "fill", row: "r1", cell: `c${id}`, ...extra },
    });
    const [node] = blocksToPdf(
      [
        // A header without a fill keeps the template's burgundy.
        cell("h", { header: true }),
        // Content saved before the palette: `shade` is beige.
        cell("s", { shade: true }),
        cell("n", {}),
        cell("b", { fill: "blue" }),
        cell("g", { fill: "lightGrey" }),
        // A header with a fill takes the fill, and stays bold.
        cell("hg", { header: true, fill: "green" }),
      ],
      { links: new LinkRegistry() },
    ) as {
      table: {
        body: { fillColor?: string; color?: string; bold?: boolean }[][];
      };
    }[];
    expect(
      node!.table.body[0]!.map((entry) => [
        entry.fillColor,
        entry.color,
        entry.bold ?? false,
      ]),
    ).toEqual([
      [BRAND_RED, "#ffffff", true],
      [CELL_FILLS.beige.hex, CELL_FILL_TEXT.dark, false],
      [undefined, undefined, false],
      [CELL_FILLS.blue.hex, CELL_FILL_TEXT.light, false],
      [CELL_FILLS.lightGrey.hex, CELL_FILL_TEXT.dark, false],
      [CELL_FILLS.green.hex, CELL_FILL_TEXT.light, true],
    ]);
    // Every fill of the palette reaches the PDF with its own colours.
    for (const name of CELL_FILL_NAMES) {
      const [filled] = blocksToPdf([cell("x", { fill: name })], {
        links: new LinkRegistry(),
      }) as { table: { body: { fillColor?: string; color?: string }[][] } }[];
      expect(filled!.table.body[0]![0]).toMatchObject({
        fillColor: CELL_FILLS[name].hex,
        color: CELL_FILL_TEXT[CELL_FILLS[name].text],
      });
    }
  });

  it("gives links and headings in a filled cell the cell's text colour", () => {
    const at = (cellId: string, extra: Partial<Block["cell"]> = {}) => ({
      table: "ink",
      row: "r1",
      cell: cellId,
      ...extra,
    });
    const link: Block = {
      ...p("l", "Enlace"),
      marks: [{ type: "link", from: 0, to: 6, href: "https://creup.es" }],
    };
    const [node] = blocksToPdf(
      [
        { ...link, id: "l1", cell: at("a", { fill: "blue" }) },
        {
          id: "h1",
          type: "heading",
          level: 2,
          text: "Título",
          marks: [],
          cell: at("a", { fill: "blue" }),
        },
        // An unfilled cell keeps the link's own colour.
        { ...link, id: "l2", cell: at("b") },
      ],
      { links: new LinkRegistry() },
    ) as {
      table: {
        body: {
          stack: { color?: string; text: { color?: string }[] }[];
        }[][];
      };
    }[];
    const [filled, plain] = node!.table.body[0]!;
    expect(filled!.stack[0]!.text.map((inline) => inline.color)).toEqual([
      CELL_FILL_TEXT.light,
      CELL_FILL_TEXT.light,
    ]);
    expect(filled!.stack[1]!.color).toBe(CELL_FILL_TEXT.light);
    expect(plain!.stack[0]!.text[0]!.color).toBe(LINK_BLUE);
  });

  it("sets wide tables in smaller type, cell by cell", () => {
    const cells = Array.from({ length: 8 }, (_, index) => ({
      ...p(`w${index}`, `Celda ${index}`),
      cell: { table: "wide", row: "r1", cell: `c${index}` },
    }));
    const [node] = blocksToPdf(cells, { links: new LinkRegistry() }) as {
      table: { body: { stack: { fontSize?: number }[] }[][] };
    }[];
    expect(node!.table.body[0]!.map((cell) => cell.stack[0]!.fontSize)).toEqual(
      Array.from({ length: 8 }, () => 8),
    );
    // Up to five columns keep the body's size.
    const [narrow] = blocksToPdf(cells.slice(0, 5), {
      links: new LinkRegistry(),
    }) as { table: { body: { stack: { fontSize?: number }[] }[][] } }[];
    expect(narrow!.table.body[0]![0]!.stack[0]!.fontSize).toBeUndefined();
  });

  it("aligns centred and right-aligned blocks", () => {
    const nodes = blocksToPdf(
      [
        { ...p("r1", "Última actualización"), align: "right" },
        { ...p("r2", "Firma"), align: "center" },
        p("r3", "Normal"),
      ],
      { links: new LinkRegistry() },
    ) as ContentText[];
    expect(nodes.map((node) => node.alignment)).toEqual([
      "right",
      "center",
      undefined,
    ]);
  });
});
