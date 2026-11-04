import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Content,
  ContentOrderedList,
  ContentText,
  ContentUnorderedList,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { beforeAll, describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { consolidate } from "../../../shared/utils/content/consolidate";
import { LinkRegistry, annotatedToPdf, blocksToPdf } from "./content";
import { createTranslator, formatExportDateRange, interpolate } from "./labels";
import {
  amendmentCodes,
  annexDisplayCode,
  approvalOrder,
  buildAgendaTree,
  buildAnnexRows,
  consolidationInput,
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
    expect(tree.numbering.get("c")).toBe("1");
    expect(tree.numbering.get("a")).toBe("2");
    expect(tree.numbering.get("b")).toBe("2.1");
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
