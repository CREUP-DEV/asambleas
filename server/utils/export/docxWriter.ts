import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";
import {
  CELL_FILLS,
  cellFillOf,
  cellFillTextColour,
} from "../../../shared/constants/cellFills";
import type { Block, Mark } from "../../../shared/types/content";
import {
  formatListNumber,
  markerOf,
  orderedListNumbers,
} from "../../../shared/utils/content/lists";
import { isSafeHref } from "../../../shared/utils/content/render";
import { groupTables, tableGrid } from "../../../shared/utils/content/tables";
import {
  CONTACT,
  LOGOS,
  PAGE_WIDTH,
  TEMPLATE_MARGINS,
  type ExportBrand,
} from "./brand";
import { CREUP_RED, type ExportImage } from "./content";

/**
 * The editable version of a document's text, as a Word file: the same
 * blocks the PDF lays out (structured content, never HTML), on CREUP's
 * template as far as Word goes (the logos in the header, the website and
 * the page count in the footer, Raleway, burgundy headings). Lists carry
 * their numbers as text, the ones the PDF shows, so they never renumber in
 * a word processor; bullets are real lists. Links keep only safe addresses
 * (isSafeHref), as everywhere.
 */

export interface DocxDocumentData {
  title: string;
  /** "80.ª AGO", the file's subject. */
  assemblyLabel: string;
  /** The footer's page count, "{page} de {total}" (export.pdf.footer.page). */
  pageCount: string;
  blocks: Block[];
  /** The images the text shows, by asset id. */
  images?: Record<string, ExportImage>;
}

const RED = CREUP_RED.slice(1);
/** Points to twentieths of a point. */
const twips = (points: number) => Math.round(points * 20);
/** Points to pixels at 96 dpi, the unit of docx's image sizes. */
const pixels = (points: number) => Math.round((points * 96) / 72);
/** Font sizes go in half points. */
const half = (points: number) => Math.round(points * 2);

const CONTENT_WIDTH_PT = PAGE_WIDTH - TEMPLATE_MARGINS[0] - TEMPLATE_MARGINS[2];
const LIST_INDENT = 360;

const BULLETS = ["•", "◦", "▪"];

/** A PNG's size in pixels, from its header. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function imageType(dataUrl: string): "png" | "jpg" | null {
  if (dataUrl.startsWith("data:image/png;")) return "png";
  if (dataUrl.startsWith("data:image/jpeg;")) return "jpg";
  return null;
}

function imageData(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// Inline text -------------------------------------------------------------

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  color?: string;
}

/** The text split where marks start and end, each run with its marks. */
function markedRuns(
  text: string,
  marks: readonly Mark[],
  style: RunStyle = {},
): ParagraphChild[] {
  const cuts = new Set([0, text.length]);
  for (const mark of marks) {
    if (mark.from > 0 && mark.from < text.length) cuts.add(mark.from);
    if (mark.to > 0 && mark.to < text.length) cuts.add(mark.to);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const children: ParagraphChild[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const active = marks.filter((mark) => mark.from <= from && mark.to >= to);
    const has = (type: Mark["type"]) =>
      active.some((mark) => mark.type === type);
    const href = active.find((mark) => mark.type === "link")?.href;
    const link = isSafeHref(href) ? href : null;
    const runs = textRuns(text.slice(from, to), {
      bold: style.bold || has("bold") || undefined,
      italics: style.italics || has("italic") || undefined,
      underline: has("underline") || link ? {} : undefined,
      strike: has("strike") || undefined,
      color: link ? "1155CC" : style.color,
    });
    if (link) children.push(new ExternalHyperlink({ link, children: runs }));
    else children.push(...runs);
  }
  return children;
}

/** A run per line: a line break inside a block is a break in Word. */
function textRuns(
  text: string,
  options: Omit<ConstructorParameters<typeof TextRun>[0] & object, "text">,
): TextRun[] {
  return text.split("\n").map(
    (line, index) =>
      new TextRun({
        ...options,
        text: line,
        break: index > 0 ? 1 : undefined,
      }),
  );
}

// Blocks ------------------------------------------------------------------

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
] as const;

function alignment(block: Block): IParagraphOptions["alignment"] {
  if (block.align === "center") return AlignmentType.CENTER;
  if (block.align === "right") return AlignmentType.RIGHT;
  return undefined;
}

function imageParagraph(
  block: Block,
  images: Record<string, ExportImage> | undefined,
): Paragraph {
  const image = block.image ? images?.[block.image.asset] : undefined;
  const type = image ? imageType(image.dataUrl) : null;
  if (!image || !type || !block.image) {
    // Like the PDF: what the image shows, when the file is missing.
    return new Paragraph({
      alignment: alignment(block),
      children: [new TextRun({ text: block.image?.alt ?? "", italics: true })],
    });
  }
  const maxWidth = pixels(CONTENT_WIDTH_PT);
  const scale = Math.min(1, maxWidth / Math.max(1, image.width));
  return new Paragraph({
    alignment: alignment(block) ?? AlignmentType.CENTER,
    children: [
      new ImageRun({
        type,
        data: imageData(image.dataUrl),
        transformation: {
          width: Math.round(image.width * scale),
          height: Math.round(image.height * scale),
        },
        altText: {
          name: block.image.alt.slice(0, 120) || "image",
          description: block.image.alt,
          title: block.image.alt.slice(0, 120),
        },
      }),
    ],
  });
}

function blockParagraph(
  block: Block,
  numbers: Map<string, number>,
  images: Record<string, ExportImage> | undefined,
  style: RunStyle = {},
): Paragraph {
  if (block.type === "image") return imageParagraph(block, images);
  const align = alignment(block);
  if (block.type === "heading") {
    const level = Math.min(Math.max(block.level ?? 1, 1), 4);
    return new Paragraph({
      heading: HEADINGS[level - 1],
      alignment: align,
      children: markedRuns(block.text, block.marks, style),
    });
  }
  if (block.type === "quote") {
    return new Paragraph({
      style: "Quote",
      alignment: align,
      children: markedRuns(block.text, block.marks, style),
    });
  }
  if (block.type === "list_item") {
    const level = Math.min(Math.max(block.level ?? 0, 0), 8);
    if (block.list === "ordered") {
      const n = numbers.get(block.id) ?? 1;
      const left = LIST_INDENT * (level + 1);
      return new Paragraph({
        alignment: align,
        indent: { left, hanging: LIST_INDENT },
        tabStops: [{ type: TabStopType.LEFT, position: left }],
        children: [
          new TextRun({
            ...style,
            text: `${formatListNumber(n, markerOf(block))}\t`,
          }),
          ...markedRuns(block.text, block.marks, style),
        ],
      });
    }
    return new Paragraph({
      alignment: align,
      numbering: { reference: "bullets", level },
      children: markedRuns(block.text, block.marks, style),
    });
  }
  return new Paragraph({
    alignment: align,
    children: markedRuns(block.text, block.marks, style),
  });
}

const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 6, color: RED };

/** Body of the document: plain blocks, and tables as Word tables. */
function bodyOf(
  blocks: Block[],
  images: Record<string, ExportImage> | undefined,
): (Paragraph | Table)[] {
  const numbers = orderedListNumbers(blocks);
  const children: (Paragraph | Table)[] = [];
  for (const run of groupTables(blocks)) {
    if (run.kind === "blocks") {
      for (const block of run.items) {
        children.push(blockParagraph(block, numbers, images));
      }
      continue;
    }
    const grid = tableGrid(run.table, (block) => block.text.trim() === "");
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: TABLE_BORDER,
          bottom: TABLE_BORDER,
          left: TABLE_BORDER,
          right: TABLE_BORDER,
          insideHorizontal: TABLE_BORDER,
          insideVertical: TABLE_BORDER,
        },
        rows: grid.rows.map(
          (row, rowIndex) =>
            new TableRow({
              tableHeader: rowIndex < grid.headerRows || undefined,
              children: row.map((cell) => {
                const fill = cellFillOf(cell.cell);
                const header = cell.cell.header === true;
                const background = fill
                  ? CELL_FILLS[fill].hex
                  : header
                    ? CREUP_RED
                    : null;
                const color = fill
                  ? cellFillTextColour(fill).slice(1).toUpperCase()
                  : header
                    ? "FFFFFF"
                    : undefined;
                return new TableCell({
                  columnSpan: cell.colspan > 1 ? cell.colspan : undefined,
                  rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
                  shading: background
                    ? {
                        type: ShadingType.CLEAR,
                        fill: background.slice(1).toUpperCase(),
                        color: "auto",
                      }
                    : undefined,
                  children: cell.blocks.map((block) =>
                    blockParagraph(block, numbers, images, {
                      bold: header || undefined,
                      color,
                    }),
                  ),
                });
              }),
            }),
        ),
      }),
    );
  }
  return children;
}

// Document ------------------------------------------------------------------

function headerOf(brand: ExportBrand | undefined): Header {
  if (!brand) {
    return new Header({
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: "CREUP",
              bold: true,
              color: RED,
              size: half(22),
            }),
          ],
        }),
      ],
    });
  }
  const logo = (png: Buffer, widthPt: number) => {
    const size = pngSize(png);
    const width = pixels(widthPt);
    return new ImageRun({
      type: "png",
      data: png,
      transformation: {
        width,
        height: Math.round((size.height / size.width) * width),
      },
      altText: { name: "logo", description: "", title: "" },
    });
  };
  return new Header({
    children: [
      new Paragraph({
        tabStops: [
          { type: TabStopType.RIGHT, position: twips(CONTENT_WIDTH_PT) },
        ],
        children: [
          logo(brand.creupLogoPng, LOGOS.creup.width),
          new TextRun({ text: "\t" }),
          logo(brand.esuLogoPng, LOGOS.esu.width),
        ],
      }),
    ],
  });
}

function footerOf(pageCount: string): Footer {
  const red = { color: RED };
  const count = pageCount
    .split(/(\{page\}|\{total\})/)
    .filter(Boolean)
    .map((part) =>
      part === "{page}"
        ? new TextRun({ bold: true, children: [PageNumber.CURRENT] })
        : part === "{total}"
          ? new TextRun({ bold: true, children: [PageNumber.TOTAL_PAGES] })
          : new TextRun({ ...red, text: part }),
    );
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [
          { type: TabStopType.CENTER, position: twips(CONTENT_WIDTH_PT / 2) },
          { type: TabStopType.RIGHT, position: twips(CONTENT_WIDTH_PT) },
        ],
        children: [
          new TextRun({ text: "\t" }),
          new ExternalHyperlink({
            link: CONTACT.web.href,
            children: [
              new TextRun({ ...red, text: CONTACT.web.text, underline: {} }),
            ],
          }),
          new TextRun({ ...red, text: " – " }),
          new ExternalHyperlink({
            link: CONTACT.email.href,
            children: [
              new TextRun({ ...red, text: CONTACT.email.text, underline: {} }),
            ],
          }),
          new TextRun({ text: "\t" }),
          ...count,
        ],
      }),
    ],
  });
}

/** The document's text as a .docx file. */
export async function buildDocumentDocx(
  data: DocxDocumentData,
  brand?: ExportBrand,
): Promise<Buffer> {
  const document = new Document({
    creator: "CREUP",
    title: data.title,
    subject: data.assemblyLabel,
    styles: {
      default: {
        document: {
          run: { font: "Raleway", size: half(11) },
          paragraph: { spacing: { after: twips(12), line: 276 } },
        },
        heading1: {
          run: { font: "Raleway", size: half(15), bold: true, color: "FFFFFF" },
          paragraph: {
            shading: { type: ShadingType.CLEAR, fill: RED, color: "auto" },
            spacing: { before: twips(12), after: twips(12) },
            keepNext: true,
          },
        },
        heading2: {
          run: { font: "Raleway", size: half(14), bold: true, color: RED },
          paragraph: {
            spacing: { before: twips(6), after: twips(12) },
            keepNext: true,
          },
        },
        heading3: {
          run: { font: "Raleway", size: half(12), color: RED },
          paragraph: {
            border: {
              top: TABLE_BORDER,
              bottom: TABLE_BORDER,
              left: TABLE_BORDER,
              right: TABLE_BORDER,
            },
            spacing: { after: twips(12) },
            keepNext: true,
          },
        },
        heading4: {
          run: { font: "Raleway", size: half(12), bold: true, color: RED },
          paragraph: { spacing: { after: twips(12) }, keepNext: true },
        },
        title: {
          run: { font: "Raleway", size: half(22), bold: true, color: RED },
          paragraph: { spacing: { after: twips(16) } },
        },
      },
      paragraphStyles: [
        {
          id: "Quote",
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { italics: true, color: "3D3D3D" },
          paragraph: { indent: { left: twips(18), right: twips(18) } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: BULLETS[level % BULLETS.length]!,
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: {
                  left: LIST_INDENT * (level + 1),
                  hanging: LIST_INDENT,
                },
              },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              left: twips(TEMPLATE_MARGINS[0]),
              top: twips(TEMPLATE_MARGINS[1]),
              right: twips(TEMPLATE_MARGINS[2]),
              bottom: twips(TEMPLATE_MARGINS[3]),
              header: twips(LOGOS.creup.y),
              footer: twips(28),
            },
          },
        },
        headers: { default: headerOf(brand) },
        footers: { default: footerOf(data.pageCount) },
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: data.title })],
          }),
          ...bodyOf(data.blocks, data.images),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}
