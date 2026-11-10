import type {
  Content,
  ContentText,
  Style,
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
  BRAND_RED,
  CONTACT,
  COVER,
  LOGOS,
  PAGE_WIDTH,
  TEMPLATE_MARGINS,
  PAGE_HEIGHT,
  bandLabelKey,
  bandSvg,
  watermarkSvg,
  hasCover,
  type ExportBrand,
} from "./brand";
import {
  CONTENT_STYLES,
  CREUP_RED,
  LinkRegistry,
  MUTED_GREY,
  TEMPLATE_TABLE_LAYOUT,
  annotatedToPdf,
  blocksToPdf,
  linksToPdf,
  pdfImages,
  type ExportImage,
  type PdfContentContext,
} from "./content";
import {
  EXPORT_INTL_LOCALES,
  createFormatLabeller,
  createTranslator,
  formatExportDate,
  formatExportDateRange,
  formatExportDateTime,
  type ExportLocale,
  type Translate,
} from "./labels";

export type { ExportLocale } from "./labels";
export type { ExportBrand } from "./brand";

/**
 * pdfmake document definitions for exports. Pure: buildData.ts loads and
 * filters everything, and the export worker reads the letterhead files
 * (`ExportBrand`), so these functions only lay the data out. The layout
 * follows CREUP's document template (brand.ts and CONTENT_STYLES).
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
  /** The images its text shows, by asset id. */
  images?: Record<string, ExportImage>;
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
  /** The images their texts show, by asset id. */
  images?: Record<string, ExportImage>;
}

// Layout ----------------------------------------------------------------

const PAGE_MARGINS = TEMPLATE_MARGINS;

/**
 * Raleway's "fi"/"fl" ligatures have no Unicode mapping in the embedded
 * font, so the text layer would read "fnal" when copied, searched or read
 * aloud. fontkit drops a feature only when given the object form, which
 * pdfmake forwards untouched although its typings only list the array.
 */
const NO_LIGATURES = { liga: false, clig: false } as unknown as NonNullable<
  Style["fontFeatures"]
>;

const STYLES = {
  ...CONTENT_STYLES,
  // The template's title: Raleway Bold 22 pt in burgundy.
  docTitle: {
    fontSize: 22,
    bold: true,
    color: CREUP_RED,
    lineHeight: 1,
    margin: [0, 6, 0, 8],
  },
  // The cover of a positioning.
  coverTitle: {
    fontSize: 28,
    bold: true,
    color: CREUP_RED,
    alignment: "center",
    lineHeight: 1.05,
    margin: [0, 120, 0, 0],
  },
  meta: { fontSize: 10, color: "#333333", margin: [0, 0, 0, 1] },
  note: {
    fontSize: 9.5,
    italics: true,
    color: MUTED_GREY,
    margin: [0, 2, 0, 2],
  },
  sectionTitle: {
    fontSize: 14,
    bold: true,
    color: CREUP_RED,
    margin: [0, 0, 0, 12],
  },
  linksTitle: {
    fontSize: 10,
    bold: true,
    color: CREUP_RED,
    margin: [0, 12, 0, 4],
  },
  legend: { fontSize: 9.5, color: "#333333", margin: [0, 0, 0, 1] },
  // The template's tables: a burgundy header row in white bold.
  tableHeader: {
    fontSize: 9.5,
    bold: true,
    color: "#ffffff",
    fillColor: CREUP_RED,
  },
  tableCell: { fontSize: 9.5 },
  coverLabel: {
    fontSize: 30,
    bold: true,
    color: CREUP_RED,
    margin: [0, 140, 0, 6],
  },
  coverType: { fontSize: 15, color: "#333333", margin: [0, 0, 0, 18] },
  coverMeta: { fontSize: 11, color: "#333333", margin: [0, 0, 0, 4] },
  agendaItem: { fontSize: 11, margin: [0, 5, 0, 1] },
  agendaDescription: {
    fontSize: 9.5,
    color: MUTED_GREY,
    margin: [0, 0, 0, 1],
  },
  agendaDocument: { fontSize: 10, color: "#333333" },
} satisfies TDocumentDefinitions["styles"];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "3 de 12" with the numbers in bold, as the template's footer has it. */
function pageCount(t: Translate, page: number, total: number): ContentText[] {
  // Private-use characters mark where the numbers go in the label.
  const PAGE = String.fromCharCode(0xe000);
  const TOTAL = String.fromCharCode(0xe001);
  return t("footer.page", { page: PAGE, total: TOTAL })
    .split(new RegExp(`(${PAGE}|${TOTAL})`))
    .filter(Boolean)
    .map((part) =>
      part === PAGE
        ? { text: String(page), bold: true }
        : part === TOTAL
          ? { text: String(total), bold: true }
          : { text: part },
    );
}

/**
 * The template's letterhead: logos in the header (or the name in text when
 * the worker has no brand files), the "internal document" band down the
 * left edge, and the website, email and page count in the footer.
 */
function frame(input: {
  locale: ExportLocale;
  t: Translate;
  assembly: ExportAssembly;
  title: string;
  content: Content[];
  brand?: ExportBrand;
  /** What the band down the left edge says. */
  bandLabel: string;
  /** The first page is a cover: no letterhead, and pages count from the next. */
  cover?: boolean;
  /** A draft's watermark ("BORRADOR"). */
  watermark?: string;
}): TDocumentDefinitions {
  const { locale, t, assembly, brand } = input;
  const band = bandSvg(input.bandLabel, brand?.labelFont);
  // Drawn as outlines with the letterhead's font; without it, pdfmake's own
  // (text) watermark stands in.
  const watermark =
    input.watermark && brand
      ? watermarkSvg(input.watermark, brand.labelFont)
      : null;
  const onCover = (page: number) => input.cover === true && page === 1;
  const firstPage = input.cover ? 1 : 0;
  return {
    content: input.content,
    styles: STYLES,
    defaultStyle: { font: "Raleway", fontSize: 11, fontFeatures: NO_LIGATURES },
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
    ...(brand
      ? {
          images: {
            creupLogo: `data:image/png;base64,${brand.creupLogoPng.toString("base64")}`,
            esuLogo: `data:image/png;base64,${brand.esuLogoPng.toString("base64")}`,
          },
        }
      : {}),
    background: (page: number) =>
      onCover(page)
        ? coverBackground(brand)
        : {
            stack: [
              ...(watermark
                ? [
                    {
                      svg: watermark,
                      width: PAGE_WIDTH,
                      height: PAGE_HEIGHT,
                      absolutePosition: { x: 0, y: 0 },
                    },
                  ]
                : []),
              {
                svg: band.svg,
                width: band.width,
                height: band.height,
                absolutePosition: { x: band.x, y: band.y },
              },
            ],
          },
    header: (page: number) =>
      onCover(page)
        ? null
        : brand
          ? {
              stack: [
                {
                  image: "creupLogo",
                  width: LOGOS.creup.width,
                  absolutePosition: { x: LOGOS.creup.x, y: LOGOS.creup.y },
                },
                {
                  image: "esuLogo",
                  width: LOGOS.esu.width,
                  absolutePosition: { x: LOGOS.esu.x, y: LOGOS.esu.y },
                },
              ],
            }
          : {
              text: "CREUP",
              bold: true,
              fontSize: 22,
              color: BRAND_RED,
              margin: [LOGOS.creup.x, LOGOS.creup.y + 8, 0, 0],
            },
    footer: (currentPage: number, pageTotal: number) =>
      onCover(currentPage)
        ? null
        : {
            columns: [
              { text: "", width: "*" },
              {
                text: [
                  {
                    text: CONTACT.web.text,
                    link: CONTACT.web.href,
                    decoration: "underline",
                  },
                  " – ",
                  {
                    text: CONTACT.email.text,
                    link: CONTACT.email.href,
                    decoration: "underline",
                  },
                ],
                width: "auto",
              },
              {
                text: pageCount(
                  t,
                  currentPage - firstPage,
                  pageTotal - firstPage,
                ),
                alignment: "right",
                width: "*",
              },
            ],
            columnGap: 12,
            color: BRAND_RED,
            fontSize: 11,
            margin: [PAGE_MARGINS[0], 28, PAGE_MARGINS[2], 0],
          },
  };
}

/**
 * The cover's lower half, after CREUP's positioning template: the logo
 * centred, a burgundy rule across the page, and a burgundy band with the
 * website and email in white.
 */
function coverBackground(brand?: ExportBrand): Content {
  const logoX = (PAGE_WIDTH - COVER.logo.width) / 2;
  return {
    stack: [
      ...(brand
        ? [
            {
              image: "creupLogo",
              width: COVER.logo.width,
              absolutePosition: { x: logoX, y: COVER.logo.y },
            },
          ]
        : []),
      {
        canvas: [
          {
            type: "line",
            x1: 0,
            y1: COVER.rule.y,
            x2: PAGE_WIDTH,
            y2: COVER.rule.y,
            lineWidth: COVER.rule.width,
            lineColor: BRAND_RED,
          },
          {
            type: "rect",
            x: 0,
            y: COVER.band.y,
            w: PAGE_WIDTH,
            h: COVER.band.height,
            color: BRAND_RED,
          },
        ],
        absolutePosition: { x: 0, y: 0 },
      },
      {
        text: [
          { text: CONTACT.web.text, link: CONTACT.web.href },
          " - ",
          { text: CONTACT.email.text, link: CONTACT.email.href },
        ],
        color: "#ffffff",
        bold: true,
        fontSize: 13,
        alignment: "center",
        absolutePosition: { x: 0, y: COVER.band.y + 6 },
      },
    ],
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
    text: t(
      vote.result === "approved" ? "finalVote.approved" : "finalVote.rejected",
      params,
    ),
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
  /** False when a cover page already shows the title. */
  title?: boolean;
  outlineId?: string;
  pageBreak?: boolean;
}): Content[] {
  const { meta, assembly, locale, t } = input;
  const lines: Content[] = [];
  if (input.title !== false) {
    // pdfmake reads `id` to nest bookmarks under it; its typings omit it here.
    const title: ContentText & { id?: string } = {
      text: meta.title || t("untitled"),
      style: "docTitle",
    };
    if (input.outlineId) {
      title.id = input.outlineId;
      title.outline = true;
      title.outlineText = truncate(meta.title || t("untitled"), 120);
    }
    if (input.pageBreak) title.pageBreak = "before";
    lines.push(title);
  }
  const vote = finalVoteLine(meta, assembly, locale, t);
  if (vote) lines.push(vote);
  if (lines.length === 0) return [];
  // The text starts after a paragraph's worth of space.
  return [{ stack: lines, margin: [0, 0, 0, 16] }];
}

/**
 * The cover of a positioning: its title in capitals, a third of the way down.
 * The logo, rule and contact band under it are drawn by the frame.
 */
function coverTitle(
  meta: ExportDocumentMeta,
  locale: ExportLocale,
  t: Translate,
): Content {
  const text = meta.title || t("untitled");
  return {
    text: text.toLocaleUpperCase(EXPORT_INTL_LOCALES[locale]),
    style: "coverTitle",
    outline: true,
    outlineText: truncate(text, 120),
    pageBreak: "after",
  };
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
        ? t("amendmentStatuses.transactedInto", {
            codes: row.transactedInto.join(", "),
          })
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
      text: row.vote
        ? `${row.vote.inFavor} / ${row.vote.against} / ${row.vote.abstentions}`
        : "-",
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
  if (rows.length === 0)
    return [title, { text: t("annex.empty"), style: "note" }];

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
        widths: ["auto", 62, 80, "*", 58],
        body: [header, ...rows.map((row) => annexRow(row, t))],
      },
      layout: TEMPLATE_TABLE_LAYOUT,
    },
  ];
}

function legendSection(t: Translate): Content[] {
  return [
    {
      text: [
        {
          text: t("legend.inserted.sample"),
          decoration: "underline",
          decorationColor: CREUP_RED,
        },
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
    {
      text: [
        {
          text: t("legend.formatted.sample"),
          decoration: "underline",
          decorationStyle: "dotted",
          decorationColor: CREUP_RED,
        },
        `: ${t("legend.formatted.text")}`,
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
  brand?: ExportBrand,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const { assembly, document: meta, body } = data;
  const links = new LinkRegistry();
  const ctx: PdfContentContext = { links, outline: {}, images: data.images };
  const cover = hasCover(meta.kind);
  const draft = body.variant === "clean" && body.source === "working";

  const content: Content[] = cover ? [coverTitle(meta, locale, t)] : [];
  const heading = documentHeading({
    meta,
    assembly,
    locale,
    t,
    title: !cover,
  });
  if (body.variant === "clean") {
    content.push(
      ...heading,
      ...cleanBody(body.blocks, ctx, t),
      ...linksSection(links, t),
    );
  } else {
    const conflicting = body.annex.filter((row) => row.conflict);
    content.push(...heading, ...legendSection(t));
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
            formatLabel: createFormatLabeller(locale),
          })),
      ...linksSection(links, t),
      ...annexSection(body.annex, t),
    );
  }

  const definition = frame({
    locale,
    t,
    assembly,
    title: documentHeaderRight(meta),
    content,
    brand,
    bandLabel: t(`band.${bandLabelKey(meta.kind)}`),
    cover,
    watermark: draft ? t("watermarkDraft") : undefined,
  });
  withContentImages(definition, data.images);
  // Keeps headings with the text that follows them.
  definition.pageBreakBefore = (node, queries) =>
    node.headlineLevel !== undefined &&
    queries.getFollowingNodesOnPage().length === 0;
  if (draft && !brand) {
    definition.watermark = {
      text: t("watermarkDraft"),
      color: CREUP_RED,
      opacity: 0.07,
      bold: true,
    };
  }
  return definition;
}

function agendaContent(
  nodes: ExportAgendaNode[],
  t: Translate,
  depth = 0,
): Content[] {
  const content: Content[] = [];
  const indent = depth * 16;
  for (const node of nodes) {
    content.push({
      text: [
        { text: `${node.numbering}. `, bold: true, color: CREUP_RED },
        node.title,
      ],
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
  brand?: ExportBrand,
): TDocumentDefinitions {
  const t = createTranslator(locale);
  const { assembly } = data;
  const typeName = t(`assemblyTypes.${assembly.type}`);

  const content: Content[] = [
    { text: assembly.label, style: "coverLabel" },
    { text: typeName, style: "coverType" },
    {
      text: formatExportDateRange(
        assembly.startDate,
        assembly.endDate,
        locale,
        t,
      ),
      style: "coverMeta",
    },
    { text: assembly.location, style: "coverMeta" },
    {
      text: t("footer.generatedAt", {
        date: formatExportDateTime(data.generatedAt, locale),
      }),
      style: "coverMeta",
      color: MUTED_GREY,
    },
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
    content.push({
      text: t("noPublishedDocuments"),
      style: "note",
      margin: [0, 14, 0, 0],
    });
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
      ...cleanBody(
        entry.blocks,
        { links, outline: { parentId: outlineId }, images: data.images },
        t,
      ),
      ...linksSection(links, t),
    );
  });

  return withContentImages(
    frame({
      locale,
      t,
      assembly,
      title: `${assembly.label} · ${typeName}`,
      content,
      brand,
      bandLabel: t("band.internalDocument"),
    }),
    data.images,
  );
}

/** Adds the text's images to the PDF's (the letterhead's logos stay). */
function withContentImages(
  definition: TDocumentDefinitions,
  images: Record<string, ExportImage> | undefined,
): TDocumentDefinitions {
  const entries = pdfImages(images);
  if (Object.keys(entries).length > 0) {
    definition.images = { ...definition.images, ...entries };
  }
  return definition;
}
