import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create as createFont } from "fontkit";
import JSZip from "jszip";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { beforeAll, describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { previewAmendment } from "~~/shared/utils/content/consolidate";
import { BRAND_FILES, type ExportBrand } from "../brand";
import { buildDocumentDocx } from "../docxWriter";
import { createTranslator } from "../labels";
import {
  amendmentLocations,
  amendmentTypology,
  buildAgendaPdf,
  buildAmendmentPdf,
  buildConvocationPdf,
  type PackagePdfAssembly,
} from "../packagePdf";
import {
  RALEWAY_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "../pdfmake";
import { serializePdfDefinition } from "../pdfSerial";
import { NameRegistry, safeName, sortableNumbering } from "./names";
import {
  packageStillPublic,
  planPackage,
  type PackageAmendment,
  type PackageDocument,
  type PackageSource,
} from "./plan";

const FONTS_DIR = resolve(__dirname, "../../../assets/fonts");
const ASSETS_DIR = resolve(__dirname, "../../../assets");
const brand: ExportBrand = {
  creupLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.creupLogo)),
  esuLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.esuLogo)),
  labelFont: createFont(readFileSync(resolve(FONTS_DIR, "Raleway-Bold.woff"))),
};

beforeAll(() => {
  registerPdfFonts(
    Object.fromEntries(
      Object.values(RALEWAY_FILES).map((name) => [
        name,
        readFileSync(resolve(FONTS_DIR, name)),
      ]),
    ) as Record<RalewayFile, Buffer>,
  );
});

/** Renders as the render process would, after checking it crosses as JSON. */
async function render(definition: TDocumentDefinitions): Promise<string> {
  expect(() => serializePdfDefinition(definition)).not.toThrow();
  const buffer = await pdfmake.createPdf(definition).getBuffer();
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  return buffer.toString("latin1");
}

const t = createTranslator("es");

// Names -------------------------------------------------------------------------

describe("package names", () => {
  it("drops what Windows refuses and trailing dots", () => {
    expect(safeName("Elección de la sede de la 82.ª AGO..")).toBe(
      "Elección de la sede de la 82.ª AGO",
    );
    expect(safeName('Plan 2026/2027: "Ruta" <a|b>?*')).toBe(
      "Plan 2026 2027 Ruta a b",
    );
    expect(safeName("con")).toBe("_con");
    expect(safeName("  ...  ")).toBe("_");
    expect(safeName("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    expect(
      safeName("Informe de la Comisión Ejecutiva Ampliada (CEA)", 40),
    ).toBe("Informe de la Comisión Ejecutiva…");
  });

  it("pads agenda numbers so they sort as text", () => {
    expect(sortableNumbering("3")).toBe("03");
    expect(sortableNumbering("3.10")).toBe("03.10");
    expect(sortableNumbering("12.1")).toBe("12.01");
  });

  it("names twins apart, ignoring case", () => {
    const names = new NameRegistry();
    expect(names.claim("Informe", ".pdf")).toBe("Informe.pdf");
    expect(names.claim("informe", ".pdf")).toBe("informe (2).pdf");
    expect(names.claim("Informe", ".docx")).toBe("Informe.docx");
  });
});

// Plan --------------------------------------------------------------------------

function amendment(
  overrides: Partial<PackageAmendment> = {},
): PackageAmendment {
  return {
    id: "am1",
    number: 1,
    code: "UGR1",
    kind: "partial",
    status: "submitted",
    approvalMethod: null,
    updatedAt: new Date("2026-11-10T10:00:00Z"),
    authors: ["UGR"],
    sourceCodes: [],
    transactedInto: [],
    ...overrides,
  };
}

function document(overrides: Partial<PackageDocument> = {}): PackageDocument {
  return {
    id: "doc1",
    agendaItemId: "item-1-1",
    title: "Resolución sobre becas",
    reference: "RES 4",
    kind: "resolution",
    format: "structured",
    proponent: "UGR",
    finalVote: null,
    baseVersionId: "v-base",
    consolidatedVersionId: null,
    fileUrl: null,
    storedFile: null,
    amendments: [amendment()],
    ...overrides,
  };
}

function source(overrides: Partial<PackageSource> = {}): PackageSource {
  return {
    assembly: {
      id: "assembly1",
      label: "80.ª AGO",
      number: 80,
      type: "AGO",
      startDate: new Date("2026-11-18T09:00:00Z"),
      endDate: new Date("2026-11-22T14:00:00Z"),
      location: "Universidad de León",
      agendaFinal: true,
      convocationIntro: null,
      convocationFileUrl: null,
      convocationStoredFile: null,
      milestones: [],
    },
    items: [
      {
        id: "item-1",
        parentId: null,
        numbering: "1",
        title: "Aprobación de Resoluciones",
        depth: 0,
        documents: [],
      },
      {
        id: "item-1-1",
        parentId: "item-1",
        numbering: "1.1",
        title: "Resolución sobre becas",
        depth: 1,
        documents: [{ title: "Resolución sobre becas", reference: "RES 4" }],
      },
      {
        id: "item-2",
        parentId: null,
        numbering: "2",
        title: "Ruegos y preguntas",
        depth: 0,
        documents: [],
      },
    ],
    documents: [document()],
    ...overrides,
  };
}

describe("planPackage", () => {
  it("lays out the convocatoria, the agenda and a folder per item with documents", () => {
    const plan = planPackage(source(), { locale: "es", editable: false }, t);
    expect(plan.root).toBe("Documentación 80.ª AGO");
    expect(plan.entries.map((entry) => entry.path)).toEqual([
      "Documentación 80.ª AGO/00 Convocatoria.pdf",
      "Documentación 80.ª AGO/00 Orden del día.pdf",
      "Documentación 80.ª AGO/01 Aprobación de Resoluciones/01.01 Resolución sobre becas/RES 4 Resolución sobre becas.pdf",
      "Documentación 80.ª AGO/01 Aprobación de Resoluciones/01.01 Resolución sobre becas/Enmiendas/UGR1.pdf",
    ]);
    expect(plan.entries[0]!.piece).toEqual({ kind: "convocation" });
    expect(plan.includes).toEqual({
      documents: [
        {
          id: "doc1",
          baseVersionId: "v-base",
          consolidatedVersionId: null,
          fileUrl: null,
        },
      ],
      amendmentIds: ["am1"],
      convocationFileUrl: null,
    });
  });

  it("copies the signed convocatoria and uploaded PDFs as they are", () => {
    const base = source();
    const plan = planPackage(
      {
        ...base,
        assembly: {
          ...base.assembly,
          convocationFileUrl: "/api/uploads/convocations/a.pdf",
          convocationStoredFile: "a.pdf",
        },
        documents: [
          document({
            format: "file",
            storedFile: "b.pdf",
            fileUrl: "/api/uploads/documents/b.pdf",
            baseVersionId: null,
            amendments: [],
          }),
        ],
      },
      { locale: "es", editable: true },
      t,
    );
    expect(plan.entries[0]!.piece).toEqual({ kind: "file", stored: "a.pdf" });
    const uploaded = plan.entries.filter(
      (entry) => entry.piece.kind === "file",
    );
    expect(uploaded.map((entry) => entry.key)).toEqual([
      "file:a.pdf",
      "file:b.pdf",
    ]);
    // A PDF upload has no Word version, editable or not.
    expect(plan.entries.some((entry) => entry.path.endsWith(".docx"))).toBe(
      false,
    );
  });

  it("adds the consolidated text once voted, and the Word versions when editable", () => {
    const vote = {
      inFavor: 30,
      against: 2,
      abstentions: 1,
      majority: "simple" as const,
      result: "approved" as const,
      method: "show_of_hands" as const,
      unanimous: false,
      recordedAt: new Date("2026-11-21T12:00:00Z"),
    };
    const voted = source({
      documents: [
        document({ consolidatedVersionId: "v-cons", finalVote: vote }),
      ],
    });
    const plan = planPackage(voted, { locale: "es", editable: true }, t);
    const files = plan.entries
      .map((entry) => entry.path.split("/").pop())
      .filter((name) => name?.startsWith("RES 4"));
    expect(files).toEqual([
      "RES 4 Resolución sobre becas.pdf",
      "RES 4 Resolución sobre becas.docx",
      "RES 4 Resolución sobre becas (texto consolidado).pdf",
      "RES 4 Resolución sobre becas (texto consolidado).docx",
    ]);
    // The text as presented does not change when the vote is recorded.
    const before = planPackage(source(), { locale: "es", editable: true }, t);
    const key = (plan: typeof before, name: string) =>
      plan.entries.find((entry) => entry.path.endsWith(name))!.key;
    expect(key(plan, "RES 4 Resolución sobre becas.pdf")).toBe(
      key(before, "RES 4 Resolución sobre becas.pdf"),
    );
  });

  it("keeps every other piece's key when one amendment changes", () => {
    const before = planPackage(source(), { locale: "es", editable: false }, t);
    const after = planPackage(
      source({
        documents: [
          document({
            amendments: [
              amendment({ updatedAt: new Date("2026-11-21T09:00:00Z") }),
            ],
          }),
        ],
      }),
      { locale: "es", editable: false },
      t,
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
    const changed = after.entries.filter(
      (entry, index) => entry.key !== before.entries[index]!.key,
    );
    expect(changed.map((entry) => entry.piece.kind)).toEqual(["amendment"]);
  });

  it("gives each document its own amendments folder when an item holds several", () => {
    const plan = planPackage(
      source({
        documents: [
          document(),
          document({
            id: "doc2",
            title: "Resolución sobre vivienda",
            reference: "RES 5",
            amendments: [amendment({ id: "am2", code: "ANEM1" })],
          }),
        ],
      }),
      { locale: "es", editable: false },
      t,
    );
    const folders = plan.entries
      .filter((entry) => entry.piece.kind === "amendment")
      .map((entry) => entry.path.split("/").slice(-2, -1)[0]);
    expect(folders).toEqual([
      "Enmiendas RES 4 Resolución sobre becas",
      "Enmiendas RES 5 Resolución sobre vivienda",
    ]);
  });

  it("depends on the language and the variant", () => {
    const es = planPackage(source(), { locale: "es", editable: false }, t);
    const en = planPackage(
      source(),
      { locale: "en", editable: false },
      createTranslator("en"),
    );
    const editable = planPackage(source(), { locale: "es", editable: true }, t);
    expect(
      new Set([es.fingerprint, en.fingerprint, editable.fingerprint]).size,
    ).toBe(3);
    expect(en.root).toBe("Documentation 80.ª AGO");
  });
});

describe("packageStillPublic", () => {
  const shown = planPackage(
    source(),
    { locale: "es", editable: false },
    t,
  ).includes;

  it("hands out an older package while all of it is still public", () => {
    const now = planPackage(
      source({
        documents: [
          document({ amendments: [amendment(), amendment({ id: "am9" })] }),
        ],
      }),
      { locale: "es", editable: false },
      t,
    ).includes;
    expect(packageStillPublic(shown, now)).toBe(true);
  });

  it("never once a document or an amendment is gone or a text was replaced", () => {
    const plan = (documents: PackageDocument[]) =>
      planPackage(source({ documents }), { locale: "es", editable: false }, t)
        .includes;
    expect(packageStillPublic(shown, plan([]))).toBe(false);
    expect(
      packageStillPublic(shown, plan([document({ amendments: [] })])),
    ).toBe(false);
    expect(
      packageStillPublic(shown, plan([document({ baseVersionId: "v-new" })])),
    ).toBe(false);
    expect(
      packageStillPublic(shown, {
        ...plan([document()]),
        convocationFileUrl: "/api/uploads/convocations/new.pdf",
      }),
    ).toBe(false);
  });
});

// Amendments ------------------------------------------------------------------------

const heading = (id: string, level: number, text: string): Block => ({
  id,
  type: "heading",
  level,
  text,
  marks: [],
});
const paragraph = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const regulation: Block[] = [
  paragraph("intro", "Este reglamento regula el funcionamiento interno."),
  heading("t1", 1, "Título I. Disposiciones generales"),
  heading("a1", 2, "Artículo 1. Objeto"),
  paragraph("a1p", "La asociación se rige por estos estatutos."),
  heading("a2", 2, "Artículo 2. Sede"),
  paragraph("a2p", "La sede está en Madrid."),
];

describe("amendment typology", () => {
  const replace = (text: string, from: number, to: number): AmendmentOp => ({
    op: "replace",
    blockId: "a2p",
    from,
    to,
    text,
    baseText: "La sede está en Madrid.".slice(from, to),
  });

  it("reads the template's three typologies from the operations", () => {
    expect(
      amendmentTypology("partial", [{ op: "delete", blockIds: ["a2p"] }]),
    ).toBe("suppression");
    expect(amendmentTypology("partial", [replace("", 16, 22)])).toBe(
      "suppression",
    );
    expect(
      amendmentTypology("partial", [
        {
          op: "insert",
          afterBlockId: "a2p",
          blocks: [paragraph("n", "Nuevo")],
        },
      ]),
    ).toBe("addition");
    expect(amendmentTypology("partial", [replace("Sevilla", 16, 22)])).toBe(
      "both",
    );
    expect(
      amendmentTypology("partial", [
        { op: "delete", blockIds: ["a1p"] },
        {
          op: "insert",
          afterBlockId: "a2p",
          blocks: [paragraph("n", "Nuevo")],
        },
      ]),
    ).toBe("both");
    expect(amendmentTypology("totality_return", [])).toBe("suppression");
  });

  it("locates each change under its headings, each place once", () => {
    expect(
      amendmentLocations(regulation, [
        {
          op: "replace",
          blockId: "a2p",
          from: 16,
          to: 22,
          text: "Sevilla",
          baseText: "Madrid",
        },
        { op: "delete", blockIds: ["a2p"] },
        { op: "insert", afterBlockId: null, blocks: [paragraph("n", "X")] },
        {
          op: "replace",
          blockId: "intro",
          from: 0,
          to: 4,
          text: "",
          baseText: "Este",
        },
      ]),
    ).toEqual([
      {
        kind: "section",
        headings: ["Título I. Disposiciones generales", "Artículo 2. Sede"],
      },
      { kind: "start" },
      {
        kind: "passage",
        text: "Este reglamento regula el funcionamiento interno.",
      },
    ]);
  });
});

const pdfAssembly: PackagePdfAssembly = {
  label: "80.ª AGO",
  number: 80,
  type: "AGO",
  startDate: new Date("2026-11-18T09:00:00Z"),
  endDate: new Date("2026-11-22T14:00:00Z"),
  location: "Universidad de León",
  agendaFinal: false,
};

const rows = [
  {
    numbering: "1",
    title: "Ratificación de la Mesa de Moderación.",
    depth: 0,
    documents: [],
  },
  {
    numbering: "3.10",
    title: "Informe de la Vocalía de Cooperación y Sostenibilidad.",
    depth: 1,
    documents: [{ title: "Informe", reference: null }],
  },
  { numbering: "4", title: null, depth: 0, documents: [] },
];

describe("package PDFs", () => {
  it("renders the agenda on the letterhead", async () => {
    const pdf = await render(
      buildAgendaPdf({ assembly: pdfAssembly, rows }, "es", brand),
    );
    expect(pdf).toContain("/Title");
  });

  it("renders the generated convocatoria with its annex", async () => {
    const definition = buildConvocationPdf(
      {
        assembly: pdfAssembly,
        intro: null,
        rows,
        milestones: [
          {
            key: "documents_close",
            at: new Date("2026-11-10T22:59:00Z"),
            note: null,
          },
          {
            key: "convocation",
            at: new Date("2026-10-18T10:00:00Z"),
            note: "Enviada por correo",
          },
        ],
      },
      "en",
      brand,
    );
    // pdfmake writes its layout into the nodes: read them first.
    const text = JSON.stringify(definition.content);
    await render(definition);
    expect(text).toContain("Notice of the 80th Ordinary General Assembly");
    // The milestones in date order: the convocation first.
    expect(text.indexOf("Notice of meeting")).toBeLessThan(
      text.indexOf("Document submissions close"),
    );
  });

  it("renders an amendment on CREUP's template, without its own code in superscript", async () => {
    const ops: AmendmentOp[] = [
      {
        op: "replace",
        blockId: "a2p",
        from: 16,
        to: 22,
        text: "Sevilla",
        baseText: "Madrid",
      },
    ];
    const definition = buildAmendmentPdf(
      {
        assembly: pdfAssembly,
        document: {
          title: "Reglamento interno",
          reference: null,
          kind: "regulation",
        },
        amendment: {
          code: "UGR1",
          kind: "partial",
          status: "lapsed",
          approvalMethod: null,
          authors: ["UGR", "CEA"],
          sourceCodes: [],
          transactedInto: [],
          justification: "Primer motivo.\n\nSegundo motivo.",
        },
        typology: amendmentTypology("partial", ops),
        locations: amendmentLocations(regulation, ops),
        fragment: previewAmendment(regulation, { id: "am1", ops }),
      },
      "es",
      brand,
    );
    const text = JSON.stringify(definition.content);
    await render(definition);
    for (const expected of [
      "Solicitud de enmienda UGR1",
      "Documento a enmendar",
      "Título I. Disposiciones generales › Artículo 2. Sede",
      "Supresión y adición",
      "UGR, CEA",
      "Decaída",
      "Sevilla",
      "Segundo motivo.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('"sup":true');
  });

  it("renders a totality return, which changes no text", async () => {
    const definition = buildAmendmentPdf(
      {
        assembly: pdfAssembly,
        document: {
          title: "Posicionamiento",
          reference: null,
          kind: "positioning",
        },
        amendment: {
          code: "ANEM1",
          kind: "totality_return",
          status: "submitted",
          approvalMethod: null,
          authors: ["ANEM"],
          sourceCodes: [],
          transactedInto: [],
          justification: "",
        },
        typology: "suppression",
        locations: [],
        fragment: [],
      },
      "es",
      brand,
    );
    const text = JSON.stringify(definition.content);
    await render(definition);
    expect(text).toContain("Todo el documento");
    expect(text).toContain("Propone devolver el texto en su totalidad.");
    expect(text).toContain("Sin explicación.");
    expect(text).not.toContain("Resultado");
  });
});

// Word ------------------------------------------------------------------------------

describe("buildDocumentDocx", () => {
  it("writes the text as a Word file, numbers as the PDF shows them", async () => {
    const blocks: Block[] = [
      heading("h", 1, "Artículo 1"),
      {
        id: "p",
        type: "paragraph",
        text: "Texto con enlace y negrita.",
        marks: [
          { type: "link", from: 10, to: 16, href: "https://creup.es" },
          { type: "link", from: 0, to: 5, href: "javascript:alert(1)" },
          { type: "bold", from: 19, to: 26 },
        ],
      },
      {
        id: "l1",
        type: "list_item",
        list: "ordered",
        marker: "a)",
        start: 3,
        level: 0,
        text: "Tercero",
        marks: [],
      },
      {
        id: "l2",
        type: "list_item",
        list: "ordered",
        marker: "a)",
        level: 0,
        text: "Cuarto",
        marks: [],
      },
      {
        id: "c1",
        type: "paragraph",
        text: "Cabecera",
        marks: [],
        cell: { table: "t", row: "r1", cell: "c1", header: true },
      },
      {
        id: "c2",
        type: "paragraph",
        text: "Celda",
        marks: [],
        cell: { table: "t", row: "r2", cell: "c2", fill: "beige" },
      },
    ];
    const buffer = await buildDocumentDocx(
      {
        title: "Reglamento interno",
        assemblyLabel: "80.ª AGO",
        pageCount: "{page} de {total}",
        blocks,
      },
      brand,
    );
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const rels = await zip
      .file("word/_rels/document.xml.rels")!
      .async("string");
    expect(xml).toContain("Reglamento interno");
    expect(xml).toContain("c)\t");
    expect(xml).toContain("d)\t");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain('w:fill="F5EEE6"');
    expect(rels).toContain("https://creup.es");
    expect(rels).not.toContain("javascript:");
    expect(
      Object.keys(zip.files).some((name) => name.startsWith("word/media/")),
    ).toBe(true);
  });
});
