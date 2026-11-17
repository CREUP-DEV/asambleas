import type {
  Content,
  ContentText,
  CustomTableLayout,
  TDocumentDefinitions,
  TableCell,
} from "pdfmake/interfaces";
import type {
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  DocumentKind,
} from "../../../shared/constants/domain";
import type {
  AmendmentOp,
  Block,
  ConsolidatedBlock,
} from "../../../shared/types/content";
import { changeKinds } from "../../../shared/utils/content/ops";
import { assemblyOrdinal } from "../../../shared/utils/slug";
import { PAGE_WIDTH, TEMPLATE_MARGINS, type ExportBrand } from "./brand";
import {
  CREUP_RED,
  LinkRegistry,
  MUTED_GREY,
  annotatedToPdf,
  blocksToPdf,
  linksToPdf,
  type ExportImage,
  type PdfContentContext,
} from "./content";
import {
  createAppTranslator,
  createFormatLabeller,
  createTranslator,
  formatExportDate,
  formatExportDateTime,
  type ExportLocale,
  type Translate,
} from "./labels";
import { frame, withContentImages, type ExportAssembly } from "./pdfBuilder";
import { constantLayout, pdfFunction } from "./pdfSerial";

/**
 * The PDFs of the assembly's documentation package (package/build.ts) that
 * no other export makes: the agenda (orden del día), the convocatoria
 * generated from the assembly when no signed one was uploaded, and each
 * amendment on CREUP's amendment template. Pure, like pdfBuilder.ts: the
 * package's loader gives them what a reader who sees only what is public
 * reads.
 */

/** Width of the text column between the template's margins. */
const CONTENT_WIDTH = PAGE_WIDTH - TEMPLATE_MARGINS[0] - TEMPLATE_MARGINS[2];

export interface PackagePdfAssembly extends ExportAssembly {
  /** The calendar's "orden del día definitivo" date has come. */
  agendaFinal: boolean;
}

export interface PackageAgendaRow {
  /** "3.1": only numbered items, the ones everyone reads. */
  numbering: string;
  /** Null when the item carries the title of a document that is not public. */
  title: string | null;
  depth: number;
  /** Public documents under the item, for the convocatoria. */
  documents: { title: string; reference: string | null }[];
}

// Shared pieces ---------------------------------------------------------

/** A level 1 heading of the template: white on a burgundy bar. */
function barHeading(text: string): Content[] {
  return blocksToPdf(
    [{ id: "package-heading", type: "heading", level: 1, text, marks: [] }],
    { links: new LinkRegistry() },
  );
}

/** A rule across the text column, as under the convocatoria's facts. */
function rule(): Content {
  return {
    canvas: [
      {
        type: "line",
        x1: 0,
        y1: 0,
        x2: CONTENT_WIDTH,
        y2: 0,
        lineWidth: 1,
        lineColor: "#000000",
      },
    ],
  };
}

/** "Sesión: 80.ª AGO" lines, each with its rule, as the signed convocatoria has them. */
function factLines(facts: (readonly [string, string])[][]): Content[] {
  const content: Content[] = [];
  for (const line of facts) {
    content.push({
      columns: line.map(([label, value]) => ({
        text: [{ text: `${label}: `, bold: true }, value],
        width: "*",
      })),
      columnGap: 12,
      fontSize: 10.5,
      margin: [0, 6, 0, 5],
    });
    content.push(rule());
  }
  return [{ stack: content, margin: [0, 4, 0, 18] }];
}

/** Numbers hang in their own column, deeper items further in. */
function agendaRows(
  rows: readonly PackageAgendaRow[],
  t: Translate,
  withDocuments: boolean,
): Content[] {
  return rows.map((row) => {
    const numberWidth = 22 + row.depth * 8;
    const title: Content[] = [
      {
        text: row.title ?? t("agendaHiddenTitle"),
        italics: row.title === null,
      },
    ];
    if (withDocuments && row.documents.length > 0) {
      title.push({
        ul: row.documents.map((document) =>
          document.reference
            ? `${document.title} (${document.reference})`
            : document.title,
        ),
        type: "circle",
        fontSize: 9.5,
        color: "#333333",
        margin: [0, 2, 0, 0],
      });
    }
    return {
      columns: [
        { text: `${row.numbering}.`, width: numberWidth },
        { stack: title, width: "*" },
      ],
      columnGap: 6,
      fontSize: 11,
      lineHeight: 1.15,
      margin: [row.depth * 28, row.depth === 0 ? 5 : 2, 0, 2],
      unbreakable: true,
    };
  });
}

function assemblyFacts(
  assembly: PackagePdfAssembly,
  locale: ExportLocale,
  t: Translate,
  app: Translate,
): (readonly [string, string])[][] {
  return [
    [[t("package.session"), assembly.label]],
    [[app("convocation.place"), assembly.location]],
    [
      [
        app("convocation.start"),
        formatExportDateTime(assembly.startDate, locale),
      ],
      [app("convocation.end"), formatExportDateTime(assembly.endDate, locale)],
    ],
  ];
}

/** "80.ª Asamblea General Ordinaria" / "80th Ordinary General Assembly". */
function assemblyFullName(
  assembly: PackagePdfAssembly,
  locale: ExportLocale,
  t: Translate,
): string {
  return `${assemblyOrdinal(assembly.number, locale)} ${t(`assemblyTypes.${assembly.type}`)}`;
}

function provisionalNote(
  assembly: PackagePdfAssembly,
  app: Translate,
): Content[] {
  return assembly.agendaFinal
    ? []
    : [
        {
          text: app("convocation.provisionalAgenda"),
          style: "note",
          color: CREUP_RED,
          margin: [0, 0, 0, 8],
        },
      ];
}

// Agenda ------------------------------------------------------------------

export interface AgendaPdfData {
  assembly: PackagePdfAssembly;
  rows: PackageAgendaRow[];
}

/** The orden del día alone: title, the assembly's facts and the numbered items. */
export function buildAgendaPdf(
  data: AgendaPdfData,
  locale: ExportLocale,
  brand?: ExportBrand,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const app = createAppTranslator(locale);
  const { assembly } = data;
  const title = t("package.agendaHeading", {
    assembly: assemblyFullName(assembly, locale, t),
  });
  const content: Content[] = [
    { text: title, style: "docTitle" },
    ...provisionalNote(assembly, app),
    ...factLines(assemblyFacts(assembly, locale, t, app)),
    ...barHeading(app("convocation.agendaTitle")),
    ...(data.rows.length > 0
      ? agendaRows(data.rows, t, false)
      : [{ text: app("convocation.agendaEmpty"), style: "note" }]),
  ];
  return frame({
    locale,
    t,
    assembly,
    title,
    content,
    brand,
    bandLabel: t("band.internalDocument"),
  });
}

// Convocation ---------------------------------------------------------------

export interface ConvocationPdfData {
  assembly: PackagePdfAssembly;
  /** The text the Secretaría wrote; the default one when null. */
  intro: string | null;
  rows: PackageAgendaRow[];
  milestones: { key: string; at: Date; note: string | null }[];
}

/**
 * The convocatoria generated from the assembly, its agenda and its calendar,
 * as the platform shows it (ConvocationSheet, whose wording it reads), laid
 * out on the template of the signed one.
 */
export function buildConvocationPdf(
  data: ConvocationPdfData,
  locale: ExportLocale,
  brand?: ExportBrand,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const app = createAppTranslator(locale);
  const { assembly } = data;
  const fullName = assemblyFullName(assembly, locale, t);
  const title = app("convocation.heading", { assembly: fullName });
  const intro =
    data.intro?.trim() ||
    app("convocation.defaultIntro", {
      assembly: fullName,
      location: assembly.location,
      dates: formatAssemblyDates(assembly, locale, t),
    });
  const milestones = [...data.milestones].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  const convocation = milestones.find(
    (milestone) => milestone.key === "convocation",
  );

  const content: Content[] = [
    { text: title, style: "docTitle" },
    ...provisionalNote(assembly, app),
    ...factLines(assemblyFacts(assembly, locale, t, app)),
    ...intro
      .split(/\n{2,}/)
      .map((paragraph): Content => ({ text: paragraph, style: "paragraph" })),
    ...barHeading(app("convocation.agendaTitle")),
    ...(data.rows.length > 0
      ? agendaRows(data.rows, t, true)
      : [{ text: app("convocation.agendaEmpty"), style: "note" }]),
    {
      stack: [
        ...(convocation
          ? [
              {
                text: app("convocation.signedAt", {
                  location: assembly.location,
                  date: formatExportDate(convocation.at, locale),
                }),
              },
            ]
          : []),
        {
          text: app("convocation.signature"),
          bold: true,
          margin: [0, 18, 0, 0],
        },
      ],
      margin: [0, 18, 0, 0],
      unbreakable: true,
    },
  ];

  const annex: Content[] = [
    ...barHeading(app("convocation.annexTitle")),
    {
      text: app("convocation.annexIntro"),
      style: "note",
      margin: [0, 0, 0, 8],
    },
  ];
  if (milestones.length === 0) {
    annex.push({ text: app("convocation.annexEmpty"), style: "note" });
  } else {
    annex.push({
      table: {
        widths: [170, "*"],
        dontBreakRows: true,
        body: milestones.map((milestone): TableCell[] => [
          {
            stack: [
              {
                text: app(`calendar.milestones.${milestone.key}`),
                bold: true,
              },
              {
                text: formatExportDateTime(milestone.at, locale),
                fontSize: 9.5,
              },
            ],
          },
          {
            stack: [
              { text: app(`convocation.procedures.${milestone.key}`) },
              ...(milestone.note
                ? [{ text: milestone.note, italics: true, color: MUTED_GREY }]
                : []),
            ],
            fontSize: 9.5,
          },
        ]),
      },
      layout: ANNEX_TABLE_LAYOUT,
      fontSize: 10,
    });
  }
  annex.push({
    text: app("convocation.timeZoneNote"),
    style: "note",
    margin: [0, 10, 0, 0],
  });
  // The annex starts a page, as in the signed convocatoria.
  const [first, ...rest] = annex;
  content.push({ stack: [first!], pageBreak: "before" }, ...rest);

  return frame({
    locale,
    t,
    assembly,
    title,
    content,
    brand,
    bandLabel: t("band.internalDocument"),
  });
}

function formatAssemblyDates(
  assembly: PackagePdfAssembly,
  locale: ExportLocale,
  t: Translate,
): string {
  const start = formatExportDate(assembly.startDate, locale);
  const end = formatExportDate(assembly.endDate, locale);
  return start === end ? start : t("dateRange", { start, end });
}

const ANNEX_TABLE_LAYOUT: CustomTableLayout = constantLayout({
  hLineWidth: 0.75,
  vLineWidth: 0.75,
  hLineColor: CREUP_RED,
  vLineColor: CREUP_RED,
  paddingLeft: 6,
  paddingRight: 6,
  paddingTop: 4,
  paddingBottom: 4,
}) as CustomTableLayout;

// Amendment -----------------------------------------------------------------

/** The template's three typologies. */
export type AmendmentTypology = "suppression" | "addition" | "both";

/**
 * The typology the template asks for, from the operations: only removals
 * are a suppression, only insertions an addition, anything else (text
 * replaced, or formatting changed) both.
 */
export function amendmentTypology(
  ops: readonly AmendmentOp[],
): AmendmentTypology {
  const kinds = changeKinds([...ops]);
  if (kinds.length === 1 && kinds[0] === "suppression") return "suppression";
  if (kinds.length === 1 && kinds[0] === "addition") return "addition";
  return "both";
}

/** Where a location starts when it has no heading of its own. */
export type AmendmentLocation =
  | { kind: "section"; headings: string[] }
  | { kind: "passage"; text: string }
  | { kind: "start" };

const LOCATION_HEADING_MAX = 90;
const LOCATION_PASSAGE_MAX = 60;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The "título o sección" of each place an amendment changes: the headings
 * above it (the section, then the article...), or the start of the passage
 * when no heading comes before it. In operation order, each place once.
 */
export function amendmentLocations(
  base: readonly Block[],
  ops: readonly AmendmentOp[],
): AmendmentLocation[] {
  const index = new Map(base.map((block, i) => [block.id, i]));
  const anchors: (number | null)[] = [];
  for (const op of ops) {
    if (op.op === "replace") anchors.push(index.get(op.blockId) ?? null);
    else if (op.op === "delete") {
      const first = op.blockIds
        .map((id) => index.get(id))
        .find((i) => i !== undefined);
      anchors.push(first ?? null);
    } else {
      anchors.push(
        op.afterBlockId === null ? -1 : (index.get(op.afterBlockId) ?? null),
      );
    }
  }

  const seen = new Set<string>();
  const locations: AmendmentLocation[] = [];
  for (const anchor of anchors) {
    if (anchor === null) continue;
    let location: AmendmentLocation;
    if (anchor < 0) location = { kind: "start" };
    else {
      const headings: string[] = [];
      let above = Number.POSITIVE_INFINITY;
      for (let i = anchor; i >= 0 && above > 1; i -= 1) {
        const block = base[i]!;
        if (block.type !== "heading") continue;
        const level = block.level ?? 1;
        if (level >= above || !block.text.trim()) continue;
        headings.unshift(clip(block.text, LOCATION_HEADING_MAX));
        above = level;
      }
      location =
        headings.length > 0
          ? { kind: "section", headings }
          : {
              kind: "passage",
              text: clip(base[anchor]!.text, LOCATION_PASSAGE_MAX),
            };
    }
    const key = JSON.stringify(location);
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(location);
  }
  return locations;
}

const SETTLED_STATUSES: ReadonlySet<AmendmentStatus> = new Set([
  "approved",
  "rejected",
  "withdrawn",
  "lapsed",
  "transacted",
  "inadmissible",
]);

export interface AmendmentPdfData {
  assembly: ExportAssembly;
  document: { title: string; reference: string | null; kind: DocumentKind };
  amendment: {
    code: string | null;
    kind: AmendmentKind;
    status: AmendmentStatus;
    approvalMethod: ApprovalMethod | null;
    /** Acronyms of its authors, the main author first. */
    authors: string[];
    /** Codes of the amendments a transactional brings together. */
    sourceCodes: string[];
    /** Codes of the transactionals that took it in. */
    transactedInto: string[];
    justification: string;
  };
  typology: AmendmentTypology;
  locations: AmendmentLocation[];
  /** The blocks it changes over the published text (previewAmendment). */
  fragment: ConsolidatedBlock[];
  images?: Record<string, ExportImage>;
}

function locationText(location: AmendmentLocation, t: Translate): string {
  switch (location.kind) {
    case "section":
      return location.headings.join(" › ");
    case "passage":
      return t("package.amendment.passage", { text: location.text });
    case "start":
      return t("package.amendment.documentStart");
  }
}

function outcomeText(
  amendment: AmendmentPdfData["amendment"],
  t: Translate,
): string | null {
  if (!SETTLED_STATUSES.has(amendment.status)) return null;
  if (amendment.status === "approved" && amendment.approvalMethod) {
    return t("amendmentStatuses.approvedBy", {
      method: t(`approvalMethods.${amendment.approvalMethod}`),
    });
  }
  if (amendment.status === "transacted" && amendment.transactedInto.length) {
    return t("amendmentStatuses.transactedInto", {
      codes: amendment.transactedInto.join(", "),
    });
  }
  return t(`amendmentStatuses.${amendment.status}`);
}

/** Whether the amendment changes formatting somewhere: the legend says how it shows. */
function changesFormat(fragment: readonly ConsolidatedBlock[]): boolean {
  return fragment.some(
    (block) =>
      block.format !== undefined ||
      block.segments.some((segment) => segment.format !== undefined),
  );
}

/** The template's field table: the label in white on burgundy, a rule under each row. */
const FIELD_TABLE_LAYOUT: CustomTableLayout = constantLayout({
  hLineWidth: 0.75,
  vLineWidth: 0,
  hLineColor: CREUP_RED,
  paddingLeft: 6,
  paddingRight: 6,
  paddingTop: 4,
  paddingBottom: 4,
}) as CustomTableLayout;

/** The template's dark burgundy behind the field labels. */
const FIELD_LABEL_FILL = "#800000";

function sectionTitle(text: string): ContentText {
  return {
    text,
    bold: true,
    fontSize: 11,
    margin: [0, 16, 0, 8],
    headlineLevel: 2,
  } as ContentText;
}

/**
 * One amendment on CREUP's amendment template ("Solicitud de enmienda"):
 * the fields (the document, where, the typology, who presents it, and how it
 * ended once settled), then what it changes, shown over the published text
 * with the marks the platform uses (added text underlined, removed text
 * struck through), and its explanation. The change and the explanation sit
 * outside the table, so a long one breaks across pages.
 */
export function buildAmendmentPdf(
  data: AmendmentPdfData,
  locale: ExportLocale,
  brand?: ExportBrand,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const { amendment, document } = data;
  const links = new LinkRegistry();
  const ctx: PdfContentContext = { links, outline: {}, images: data.images };
  const title = amendment.code
    ? t("package.amendment.titleWithCode", { code: amendment.code })
    : t("package.amendment.title");

  const fields: [string, string][] = [
    [
      t("package.amendment.document"),
      document.reference
        ? `${document.title} (${document.reference})`
        : document.title,
    ],
    [
      t("package.amendment.location"),
      data.locations.length === 0
        ? t("package.amendment.wholeDocument")
        : data.locations
            .map((location) => locationText(location, t))
            .join("\n"),
    ],
    [
      t("package.amendment.typology"),
      t(`package.amendment.typologies.${data.typology}`),
    ],
    [t("package.amendment.proponent"), amendment.authors.join(", ") || "-"],
  ];
  if (amendment.sourceCodes.length > 0) {
    fields.push([
      t("package.amendment.sources"),
      amendment.sourceCodes.join(", "),
    ]);
  }
  const outcome = outcomeText(amendment, t);
  if (outcome) fields.push([t("package.amendment.outcome"), outcome]);

  const content: Content[] = [
    { text: title, style: "docTitle" },
    {
      table: {
        widths: [150, "*"],
        dontBreakRows: true,
        body: fields.map(([label, value]): TableCell[] => [
          { text: label, color: "#ffffff", fillColor: FIELD_LABEL_FILL },
          { text: value },
        ]),
      },
      layout: FIELD_TABLE_LAYOUT,
      fontSize: 10.5,
      margin: [0, 6, 0, 4],
    },
    sectionTitle(t("package.amendment.change")),
  ];

  if (data.fragment.length > 0) {
    content.push(
      {
        text: [
          {
            text: t("legend.inserted.sample"),
            decoration: "underline",
            decorationColor: CREUP_RED,
          },
          ` · `,
          {
            text: t("legend.removed.sample"),
            decoration: "lineThrough",
            decorationColor: MUTED_GREY,
            color: MUTED_GREY,
          },
          ...(changesFormat(data.fragment)
            ? [
                ` · `,
                {
                  text: t("legend.formatted.sample"),
                  decoration: "underline" as const,
                  decorationStyle: "dotted" as const,
                  decorationColor: CREUP_RED,
                },
              ]
            : []),
        ],
        style: "legend",
        margin: [0, 0, 0, 10],
      },
      ...annotatedToPdf(data.fragment, {
        ...ctx,
        formatLabel: createFormatLabeller(locale),
      }),
    );
  } else {
    content.push({
      text: t("package.amendment.noChange"),
      style: "note",
    });
  }

  content.push(sectionTitle(t("package.amendment.explanation")));
  const paragraphs = amendment.justification
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    content.push({ text: t("package.amendment.noExplanation"), style: "note" });
  } else {
    content.push(
      ...paragraphs.map((paragraph): Content => ({
        text: paragraph,
        style: "paragraph",
      })),
    );
  }
  const list = linksToPdf(links);
  if (list) content.push({ text: t("links.title"), style: "linksTitle" }, list);

  const definition = withContentImages(
    frame({
      locale,
      t,
      assembly: data.assembly,
      title,
      content,
      brand,
      bandLabel: null,
    }),
    data.images,
  );
  // Keeps the section titles with what follows them.
  definition.pageBreakBefore = pdfFunction<
    NonNullable<TDocumentDefinitions["pageBreakBefore"]>
  >({ kind: "keepHeadingWithNext" });
  return definition;
}
