import type {
  Content,
  ContentText,
  TDocumentDefinitions,
  TableCell,
} from "pdfmake/interfaces";
import type { AssemblyType } from "../../../shared/constants/assemblyTypes";
import type {
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  DocumentFormat,
  DocumentKind,
  Majority,
  VoteResult,
} from "../../../shared/constants/domain";
import type { Block, ConsolidatedBlock } from "../../../shared/types/content";
import {
  CONTENT_STYLES,
  CREUP_RED,
  LinkRegistry,
  MUTED_GREY,
  annotatedToPdf,
  blocksToPdf,
  linksToPdf,
  type PdfContentContext,
} from "./content";
import {
  EXPORT_INTL_LOCALES,
  createTranslator,
  formatExportDate,
  formatExportDateRange,
  formatExportDateTime,
  type ExportLocale,
  type Translate,
} from "./labels";

export type { ExportLocale } from "./labels";

/**
 * pdfmake document definitions for exports. Pure: buildData.ts loads and
 * filters everything, so these functions only lay the data out.
 */

// Data ------------------------------------------------------------------

export interface ExportAssembly {
  /** formatAssemblyLabel, e.g. "80.ª AGO". */
  label: string;
  type: AssemblyType;
  startDate: Date;
  endDate: Date;
  location: string;
}

export interface ExportVote {
  inFavor: number;
  against: number;
  abstentions: number;
  majority: Majority;
  result: VoteResult;
  recordedAt: Date;
}

export interface ExportDocumentMeta {
  title: string;
  reference: string | null;
  kind: DocumentKind;
  format: DocumentFormat;
  /** Acronym of the proponent member. */
  proponent: string | null;
  fileName: string | null;
  /** Hierarchical number of the agenda item, e.g. "3.1". */
  agendaNumbering: string | null;
  agendaTitle: string | null;
  finalVote: ExportVote | null;
}

export interface ExportAnnexRow {
  id: string;
  /** "12 · CEUM 4" */
  displayCode: string;
  /** Member acronyms. */
  authors: string[];
  kind: AmendmentKind;
  status: AmendmentStatus;
  admission: AdmissionStatus;
  late: boolean;
  approvalMethod: ApprovalMethod | null;
  vote: Pick<ExportVote, "inFavor" | "against" | "abstentions"> | null;
  /** Codes of the parents of a transactional. */
  sourceCodes: string[];
  /** Codes of the transactionals that absorbed this amendment. */
  transactedInto: string[];
  /**
   * Approved but not incorporated into the annotated text: the codes it
   * collides with, or an empty array when it no longer fits the base.
   */
  conflict: string[] | null;
}

export type CleanSource = "consolidated" | "base" | "working";

export type ExportBody =
  | { variant: "clean"; source: CleanSource; blocks: Block[] }
  | {
      variant: "annotated";
      blocks: ConsolidatedBlock[];
      /** Superscript code by amendment id. */
      codes: Record<string, string>;
      annex: ExportAnnexRow[];
    };

export interface DocumentExportData {
  assembly: ExportAssembly;
  document: ExportDocumentMeta;
  body: ExportBody;
  generatedAt: Date;
}

export interface ExportAgendaNode {
  numbering: string;
  title: string;
  description: string | null;
  documents: { title: string; reference: string | null; kind: DocumentKind }[];
  children: ExportAgendaNode[];
}

export interface AssemblyDocumentEntry {
  meta: ExportDocumentMeta;
  /** Null for uploaded PDFs. */
  source: Exclude<CleanSource, "working"> | null;
  blocks: Block[];
}

export interface AssemblyExportData {
  assembly: ExportAssembly;
  agenda: ExportAgendaNode[];
  /** Published documents in agenda order. */
  documents: AssemblyDocumentEntry[];
  generatedAt: Date;
}

// Layout ----------------------------------------------------------------

const PAGE_MARGINS: [number, number, number, number] = [50, 62, 50, 54];
/** A4 width minus the horizontal margins. */
const CONTENT_WIDTH = 595.28 - PAGE_MARGINS[0] - PAGE_MARGINS[2];
const LIGHT_RED = "#f4e9ea";

const STYLES = {
  ...CONTENT_STYLES,
  docTitle: { fontSize: 18, bold: true, color: CREUP_RED, margin: [0, 0, 0, 4] },
  docSubtitle: { fontSize: 10, color: MUTED_GREY, margin: [0, 0, 0, 2] },
  meta: { fontSize: 9, color: "#333333", margin: [0, 0, 0, 1] },
  note: { fontSize: 9, italics: true, color: MUTED_GREY, margin: [0, 2, 0, 2] },
  sectionTitle: { fontSize: 14, bold: true, color: CREUP_RED, margin: [0, 0, 0, 8] },
  linksTitle: { fontSize: 9, bold: true, color: CREUP_RED, margin: [0, 10, 0, 3] },
  legend: { fontSize: 8.5, color: "#333333", margin: [0, 0, 0, 1] },
  tableHeader: { fontSize: 8.5, bold: true, color: CREUP_RED, fillColor: LIGHT_RED },
  tableCell: { fontSize: 8.5 },
  coverLabel: { fontSize: 30, bold: true, color: CREUP_RED, margin: [0, 160, 0, 6] },
  coverType: { fontSize: 15, color: "#333333", margin: [0, 0, 0, 18] },
  coverMeta: { fontSize: 11, color: "#333333", margin: [0, 0, 0, 4] },
  agendaItem: { fontSize: 10.5, margin: [0, 5, 0, 1] },
  agendaDescription: { fontSize: 8.5, color: MUTED_GREY, margin: [0, 0, 0, 1] },
  agendaDocument: { fontSize: 9, color: "#333333" },
} satisfies TDocumentDefinitions["styles"];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function rule(): Content {
  return {
    canvas: [
      {
        type: "line",
        x1: 0,
        y1: 0,
        x2: CONTENT_WIDTH,
        y2: 0,
        lineWidth: 0.6,
        lineColor: CREUP_RED,
      },
    ],
    margin: [0, 6, 0, 10],
  };
}

function frame(input: {
  locale: ExportLocale;
  t: Translate;
  assembly: ExportAssembly;
  headerRight: string;
  title: string;
  generatedAt: Date;
  content: Content[];
}): TDocumentDefinitions {
  const { locale, t, assembly } = input;
  const generated = t("footer.generatedAt", {
    date: formatExportDateTime(input.generatedAt, locale),
  });
  return {
    content: input.content,
    styles: STYLES,
    defaultStyle: { font: "Raleway", fontSize: 10 },
    pageSize: "A4",
    pageMargins: PAGE_MARGINS,
    language: EXPORT_INTL_LOCALES[locale],
    displayTitle: true,
    info: {
      title: input.title,
      author: "CREUP",
      subject: assembly.label,
      creator: "CREUP",
    },
    header: () => ({
      columns: [
        { text: `CREUP · ${assembly.label}`, bold: true, color: CREUP_RED, width: "auto" },
        {
          text: truncate(input.headerRight, 95),
          alignment: "right",
          color: MUTED_GREY,
          width: "*",
        },
      ],
      columnGap: 12,
      fontSize: 8,
      margin: [PAGE_MARGINS[0], 26, PAGE_MARGINS[2], 0],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: generated, color: MUTED_GREY, width: "*" },
        {
          text: t("footer.page", { page: currentPage, total: pageCount }),
          alignment: "right",
          width: "auto",
        },
      ],
      fontSize: 8,
      margin: [PAGE_MARGINS[0], 18, PAGE_MARGINS[2], 0],
    }),
  };
}

// Shared sections ---------------------------------------------------------

function documentHeaderRight(meta: ExportDocumentMeta): string {
  return meta.reference ? `${meta.title} · ${meta.reference}` : meta.title;
}

function voteCounts(
  vote: Pick<ExportVote, "inFavor" | "against" | "abstentions">,
  t: Translate,
): string {
  return t("voteCounts", {
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
  });
}

function finalVoteLine(
  meta: ExportDocumentMeta,
  assembly: ExportAssembly,
  locale: ExportLocale,
  t: Translate,
): Content | null {
  const vote = meta.finalVote;
  if (!vote) return null;
  const params = {
    assembly: assembly.label,
    date: formatExportDate(vote.recordedAt, locale),
    majority: t(`majorities.${vote.majority}`),
    counts: voteCounts(vote, t),
  };
  return {
    text: t(vote.result === "approved" ? "finalVote.approved" : "finalVote.rejected", params),
    style: "meta",
    bold: true,
    margin: [0, 2, 0, 1],
  };
}

function documentHeading(input: {
  meta: ExportDocumentMeta;
  assembly: ExportAssembly;
  locale: ExportLocale;
  t: Translate;
  versionNote: string | null;
  outlineId?: string;
  pageBreak?: boolean;
}): Content[] {
  const { meta, assembly, locale, t } = input;
  const title: ContentText = { text: meta.title || t("untitled"), style: "docTitle" };
  if (input.outlineId) {
    title.id = input.outlineId;
    title.outline = true;
    title.outlineText = truncate(meta.title || t("untitled"), 120);
  }
  if (input.pageBreak) title.pageBreak = "before";

  const subtitle = [t(`documentKinds.${meta.kind}`), meta.reference]
    .filter(Boolean)
    .join(" · ");
  const lines: Content[] = [title, { text: subtitle, style: "docSubtitle" }];
  if (meta.agendaNumbering && meta.agendaTitle) {
    lines.push({
      text: t("agendaPoint", { number: meta.agendaNumbering, title: meta.agendaTitle }),
      style: "meta",
    });
  }
  if (meta.proponent) {
    lines.push({ text: t("presentedBy", { members: meta.proponent }), style: "meta" });
  }
  const vote = finalVoteLine(meta, assembly, locale, t);
  if (vote) lines.push(vote);
  if (input.versionNote) lines.push({ text: input.versionNote, style: "note" });
  lines.push(rule());
  return lines;
}

function linksSection(links: LinkRegistry, t: Translate): Content[] {
  const list = linksToPdf(links);
  return list ? [{ text: t("links.title"), style: "linksTitle" }, list] : [];
}

function cleanBody(
  blocks: Block[],
  ctx: PdfContentContext,
  t: Translate,
): Content[] {
  if (blocks.length === 0) return [{ text: t("emptyDocument"), style: "note" }];
  return blocksToPdf(blocks, ctx);
}

// Annex -------------------------------------------------------------------

function outcomeLabel(row: ExportAnnexRow, t: Translate): string {
  switch (row.status) {
    case "submitted":
      return row.admission === "pending"
        ? t("amendmentStatuses.pendingAdmission")
        : t("amendmentStatuses.admitted");
    case "approved":
      return row.approvalMethod
        ? t("amendmentStatuses.approvedBy", {
            method: t(`approvalMethods.${row.approvalMethod}`),
          })
        : t("amendmentStatuses.approved");
    case "transacted":
      return row.transactedInto.length > 0
        ? t("amendmentStatuses.transactedInto", { codes: row.transactedInto.join(", ") })
        : t("amendmentStatuses.transacted");
    default:
      return t(`amendmentStatuses.${row.status}`);
  }
}

function annexRow(row: ExportAnnexRow, t: Translate): TableCell[] {
  const kind: Content[] = [t(`amendmentKinds.${row.kind}`)];
  if (row.sourceCodes.length > 0) {
    kind.push({
      text: t("annex.sources", { codes: row.sourceCodes.join(", ") }),
      color: MUTED_GREY,
    });
  }

  const outcome: Content[] = [outcomeLabel(row, t)];
  if (row.late) outcome.push({ text: t("annex.late"), color: MUTED_GREY });
  if (row.conflict) {
    outcome.push({
      text:
        row.conflict.length > 0
          ? t("annex.notApplied", { codes: row.conflict.join(", ") })
          : t("annex.notAppliedInvalid"),
      color: CREUP_RED,
    });
  }

  return [
    { text: row.displayCode, bold: true, style: "tableCell" },
    { text: row.authors.join(", ") || "-", style: "tableCell" },
    { stack: kind, style: "tableCell" },
    { stack: outcome, style: "tableCell" },
    {
      text: row.vote ? `${row.vote.inFavor} / ${row.vote.against} / ${row.vote.abstentions}` : "-",
      alignment: "center",
      style: "tableCell",
    },
  ];
}

function annexSection(rows: ExportAnnexRow[], t: Translate): Content[] {
  const title: ContentText = {
    text: t("annex.title"),
    style: "sectionTitle",
    pageBreak: "before",
    outline: true,
    outlineText: t("annex.title"),
  };
  if (rows.length === 0) return [title, { text: t("annex.empty"), style: "note" }];

  const header: TableCell[] = [
    t("annex.code"),
    t("annex.authors"),
    t("annex.kind"),
    t("annex.outcome"),
    t("annex.votes"),
  ].map((text) => ({ text, style: "tableHeader" }));

  return [
    title,
    {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: ["auto", 70, 90, "*", 62],
        body: [header, ...rows.map((row) => annexRow(row, t))],
      },
      layout: "lightHorizontalLines",
    },
  ];
}

function legendSection(t: Translate): Content[] {
  return [
    {
      text: [
        { text: t("legend.inserted.sample"), decoration: "underline", decorationColor: CREUP_RED },
        `: ${t("legend.inserted.text")}`,
      ],
      style: "legend",
    },
    {
      text: [
        {
          text: t("legend.removed.sample"),
          decoration: "lineThrough",
          decorationColor: MUTED_GREY,
          color: MUTED_GREY,
        },
        `: ${t("legend.removed.text")}`,
      ],
      style: "legend",
    },
    { text: t("legend.code"), style: "legend", margin: [0, 0, 0, 8] },
  ];
}

// Public builders ---------------------------------------------------------

/** Clean or annotated export of one document. */
export function buildDocumentPdf(
  data: DocumentExportData,
  locale: ExportLocale,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const { assembly, document: meta, body } = data;
  const links = new LinkRegistry();
  const ctx: PdfContentContext = { links, outline: {} };

  const content: Content[] = [];
  if (body.variant === "clean") {
    content.push(
      ...documentHeading({
        meta,
        assembly,
        locale,
        t,
        versionNote: t(`version.${body.source}`),
      }),
      ...cleanBody(body.blocks, ctx, t),
      ...linksSection(links, t),
    );
  } else {
    const conflicting = body.annex.filter((row) => row.conflict);
    content.push(
      ...documentHeading({
        meta,
        assembly,
        locale,
        t,
        versionNote: t("version.annotated"),
      }),
      ...legendSection(t),
    );
    if (conflicting.length > 0) {
      content.push({
        text: t("conflicts", {
          codes: conflicting.map((row) => row.displayCode).join(", "),
        }),
        style: "note",
        color: CREUP_RED,
        margin: [0, 0, 0, 8],
      });
    }
    content.push(
      ...(body.blocks.length === 0
        ? [{ text: t("emptyDocument"), style: "note" }]
        : annotatedToPdf(body.blocks, {
            ...ctx,
            codeOf: (id) => body.codes[id] ?? "?",
          })),
      ...linksSection(links, t),
      ...annexSection(body.annex, t),
    );
  }

  const definition = frame({
    locale,
    t,
    assembly,
    headerRight: documentHeaderRight(meta),
    title: documentHeaderRight(meta),
    generatedAt: data.generatedAt,
    content,
  });
  // Keeps headings with the text that follows them.
  definition.pageBreakBefore = (node, queries) =>
    node.headlineLevel !== undefined && queries.getFollowingNodesOnPage().length === 0;
  if (body.variant === "clean" && body.source === "working") {
    definition.watermark = {
      text: t("watermarkDraft"),
      color: CREUP_RED,
      opacity: 0.07,
      bold: true,
    };
  }
  return definition;
}

function agendaContent(nodes: ExportAgendaNode[], t: Translate, depth = 0): Content[] {
  const content: Content[] = [];
  const indent = depth * 16;
  for (const node of nodes) {
    content.push({
      text: [{ text: `${node.numbering}. `, bold: true, color: CREUP_RED }, node.title],
      style: "agendaItem",
      bold: depth === 0,
      margin: [indent, depth === 0 ? 7 : 3, 0, 1],
    });
    if (node.description) {
      content.push({
        text: node.description,
        style: "agendaDescription",
        margin: [indent + 16, 0, 0, 1],
      });
    }
    if (node.documents.length > 0) {
      content.push({
        ul: node.documents.map((doc) => ({
          text: [
            doc.title,
            {
              text: `  ${[t(`documentKinds.${doc.kind}`), doc.reference].filter(Boolean).join(" · ")}`,
              color: MUTED_GREY,
            },
          ],
        })),
        style: "agendaDocument",
        type: "circle",
        margin: [indent + 16, 1, 0, 2],
      });
    }
    content.push(...agendaContent(node.children, t, depth + 1));
  }
  return content;
}

/** Assembly dossier: cover, agenda and every published document (clean). */
export function buildAssemblyPdf(
  data: AssemblyExportData,
  locale: ExportLocale,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const { assembly } = data;
  const typeName = t(`assemblyTypes.${assembly.type}`);

  const content: Content[] = [
    { text: assembly.label, style: "coverLabel" },
    { text: typeName, style: "coverType" },
    {
      text: formatExportDateRange(assembly.startDate, assembly.endDate, locale, t),
      style: "coverMeta",
    },
    { text: assembly.location, style: "coverMeta" },
    {
      text: t("agendaTitle"),
      style: "sectionTitle",
      pageBreak: "before",
      outline: true,
      outlineText: t("agendaTitle"),
    },
    ...(data.agenda.length > 0
      ? agendaContent(data.agenda, t)
      : [{ text: t("agendaEmpty"), style: "note" }]),
  ];

  if (data.documents.length === 0) {
    content.push({ text: t("noPublishedDocuments"), style: "note", margin: [0, 14, 0, 0] });
  }

  data.documents.forEach((entry, index) => {
    const outlineId = `export-document-${index}`;
    const links = new LinkRegistry();
    content.push(
      ...documentHeading({
        meta: entry.meta,
        assembly,
        locale,
        t,
        versionNote: entry.source ? t(`version.${entry.source}`) : null,
        outlineId,
        pageBreak: true,
      }),
    );
    if (entry.meta.format === "file") {
      content.push({
        text: entry.meta.fileName
          ? t("fileDocument", { file: entry.meta.fileName })
          : t("fileDocumentUnnamed"),
        style: "note",
      });
      return;
    }
    content.push(
      ...cleanBody(entry.blocks, { links, outline: { parentId: outlineId } }, t),
      ...linksSection(links, t),
    );
  });

  return frame({
    locale,
    t,
    assembly,
    headerRight: typeName,
    title: `${assembly.label} · ${typeName}`,
    generatedAt: data.generatedAt,
    content,
  });
}
