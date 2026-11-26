import type {
  Content,
  ContentTable,
  ContentText,
  CustomTableLayout,
  Decoration,
  OrderedListElement,
  OrderedListElementProperties,
  OrderedListType,
  Style,
  TableCell,
  UnorderedListElement,
  UnorderedListType,
} from "pdfmake/interfaces";
import type {
  Block,
  BlockType,
  BlockAlign,
  BlockCell,
  BlockImage,
  FormatChange,
  ListMarker,
  Mark,
} from "../../../shared/types/content";
import type { FragmentBlock } from "../../../shared/utils/content/consolidate";
import {
  CELL_FILLS,
  cellFillOf,
  cellFillTextColour,
} from "../../../shared/constants/cellFills";
import { markerOf } from "../../../shared/utils/content/lists";
import {
  gridSides,
  groupTables,
  tableGrid,
  tableLayoutOf,
  type GridCell,
  type TableGrid,
  type TableGroup,
} from "../../../shared/utils/content/tables";
import { PAGE_WIDTH, TEMPLATE_MARGINS } from "./brand";
import { isSafeHref } from "../../../shared/utils/content/render";
import { formulaRuns } from "../../../shared/utils/content/formula";
import { formulaSvg } from "./formulaSvg";
import { constantLayout, pdfFunction } from "./pdfSerial";
import { PAGE_TAG_PREFIX, type PageTag } from "./pageMap";

/**
 * Converts structured content (blocks, or consolidated blocks with
 * provenance) into pdfmake nodes. Pure: no I/O, so it is unit-tested.
 *
 * Text never goes through HTML: marks become pdfmake text properties, and
 * links become plain text followed by a numbered reference whose URL is
 * listed at the end of the document.
 */

export const CREUP_RED = "#792225";
export const MUTED_GREY = "#6b6b6b";
/** Links, in the blue of the template. */
export const LINK_BLUE = "#1155cc";

/**
 * Styles referenced by the nodes this module produces, after CREUP's
 * document template: Raleway 11 pt at 1.15 lines, 12 pt after every block,
 * and four heading levels in burgundy: level 1 is white on a burgundy bar
 * and level 3 sits in a burgundy box (see headingNode). The space before
 * them is the template's, less the 12 pt the block above already leaves.
 */
export const CONTENT_STYLES: Record<string, Style> = {
  // Level 1 in white on the bar, level 3 inside the box.
  barHeading: {
    fontSize: 15,
    bold: true,
    color: "#ffffff",
    lineHeight: 1,
  },
  boxHeading: {
    fontSize: 12,
    color: CREUP_RED,
    lineHeight: 1,
  },
  heading2: {
    fontSize: 14,
    bold: true,
    color: CREUP_RED,
    lineHeight: 1,
    margin: [0, 0, 0, 12],
  },
  heading4: {
    fontSize: 12,
    bold: true,
    color: CREUP_RED,
    lineHeight: 1.15,
    margin: [0, 0, 0, 12],
  },
  paragraph: { fontSize: 11, lineHeight: 1.15, margin: [0, 0, 0, 12] },
  quote: {
    fontSize: 11,
    lineHeight: 1.15,
    italics: true,
    color: "#3d3d3d",
    margin: [18, 0, 18, 12],
  },
  listItem: { fontSize: 11, lineHeight: 1.15 },
  list: { margin: [0, 0, 0, 12] },
  amendmentRef: { color: CREUP_RED, bold: true },
  // What a formatting change does, in words next to the text it changes.
  formatNote: { fontSize: 8, bold: false, italics: true },
};

/** The template's tables: burgundy rules around every cell. */
/** A table cell's side padding and its rules, in points. */
const TABLE_CELL_PADDING = 5;
const TABLE_RULE = 0.75;
/** A thick rule (a cell's side drawn "thick", a signature's line). */
const TABLE_THICK_RULE = 1.5;

// Layouts are constants made with constantLayout, so that a definition
// crosses into the render process (pdfSerial.ts).
export const TEMPLATE_TABLE_LAYOUT: CustomTableLayout = constantLayout({
  hLineWidth: TABLE_RULE,
  vLineWidth: TABLE_RULE,
  hLineColor: CREUP_RED,
  vLineColor: CREUP_RED,
  paddingLeft: TABLE_CELL_PADDING,
  paddingRight: TABLE_CELL_PADDING,
  paddingTop: 3,
  paddingBottom: 3,
}) as CustomTableLayout;

/** Collects link targets and numbers them in order of appearance. */
export class LinkRegistry {
  private readonly urls: string[] = [];

  register(href: string): number {
    const existing = this.urls.indexOf(href);
    if (existing >= 0) return existing + 1;
    this.urls.push(href);
    return this.urls.length;
  }

  get entries(): readonly string[] {
    return this.urls;
  }
}

/**
 * The bookmarks of one document's headings. Each heading nests under the
 * nearest earlier heading of a higher level (a level 3 under the level 2
 * before it), and the top ones under `parentId` when given (the document's
 * title in the assembly dossier). The stack and counter are filled in as
 * headings are laid out; ids start with `parentId`, so they stay unique
 * across the documents of a dossier.
 */
export interface OutlineState {
  parentId?: string;
  open?: { level: number; id: string }[];
  count?: number;
}

/** A stored image ready for the PDF: its file as a data URL. */
export interface ExportImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface PdfContentContext {
  links: LinkRegistry;
  /** Adds headings to the PDF bookmarks, under the given parent bookmark id. */
  outline?: OutlineState;
  /** The images the text shows, by asset id (loaded with the export data). */
  images?: Record<string, ExportImage>;
  /**
   * Tags each block's node with its id (PageTag), so the render process can
   * say on which page each block lies (pageMap.ts). Only for one document's
   * clean text: block ids are unique within a version alone. Holds the
   * ids tagged so far, so a block id met twice is tagged once (pdfmake
   * refuses a repeated id).
   */
  pageTags?: Set<string>;
  /** Set inside a table's cells: which kind of row (tagNode). */
  tableRow?: "header" | "body";
  /**
   * Paragraphs, list items and quotes without an alignment of their own
   * are justified (the reader's preference, on by default). Never inside a
   * table's cells, whose columns are too narrow for it.
   */
  justify?: boolean;
}

/** pdfmake's node of a block's text: the cell of a framed heading's table. */
function pageTagLeaf(node: Content): Record<string, unknown> | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return null;
  }
  const table = (node as Partial<ContentTable>).table;
  if (table) {
    const inner = table.body[0]?.[0];
    return typeof inner === "object" && inner !== null
      ? (inner as Record<string, unknown>)
      : null;
  }
  return node as unknown as Record<string, unknown>;
}

/**
 * Tags `node`, the block `item`'s own node, with its block id (PageTag).
 * A text gets an id too (outside a header row, whose repetitions would
 * move it), unless it has one already: a heading's bookmark id serves.
 */
function tagNode<T extends Content>(
  node: T,
  item: Item,
  ctx: PdfContentContext,
): T {
  if (!ctx.pageTags || !item.blockId) return node;
  if (ctx.pageTags.has(item.blockId)) return node;
  const leaf = pageTagLeaf(node);
  if (!leaf) return node;
  ctx.pageTags.add(item.blockId);
  const tag: PageTag = { b: item.blockId };
  if (ctx.tableRow) tag.cell = 1;
  if (ctx.tableRow === "header") tag.header = 1;
  leaf.pageTag = tag;
  if ("text" in leaf && !leaf.id && ctx.tableRow !== "header") {
    leaf.id = `${PAGE_TAG_PREFIX}${item.blockId}`;
  }
  return node;
}

export interface AnnotatedContext extends PdfContentContext {
  /**
   * Short code shown in superscript for an amendment id, e.g. "CEUM 4".
   * Without it no code is shown: the text of a single amendment.
   */
  codeOf?: (amendmentId: string) => string;
  /** What a formatting change does, in words ("becomes bold"). */
  formatLabel?: (change: FormatChange) => string;
}

type Inline = ContentText & { text: string };

interface SegmentStyle {
  decoration: Decoration;
  decorationStyle?: "dotted";
  color?: string;
  decorationColor: string;
}

const INSERTED: SegmentStyle = {
  decoration: "underline",
  decorationColor: CREUP_RED,
};
/** Text an amendment keeps and formats anew: a dotted line, and a note. */
const FORMATTED: SegmentStyle = {
  decoration: "underline",
  decorationStyle: "dotted",
  decorationColor: CREUP_RED,
};
const REMOVED: SegmentStyle = {
  decoration: "lineThrough",
  decorationColor: MUTED_GREY,
  color: MUTED_GREY,
};

function withDecorations(inline: Inline, decorations: Decoration[]): Inline {
  const unique = [...new Set(decorations)];
  if (unique.length === 0) return inline;
  return { ...inline, decoration: unique.length === 1 ? unique[0] : unique };
}

/**
 * A formula inside a sentence as text (formulaRuns): subscripts and
 * superscripts raised, fractions "a/b". One a range cuts (a change inside
 * it) prints its source as it is.
 */
function formulaInlines(
  source: string,
  whole: boolean,
  extra?: SegmentStyle,
): Inline[] {
  const runs = whole ? formulaRuns(source) : [{ text: source }];
  return runs.map((run) => {
    const piece: Inline = { text: run.text, italics: whole };
    if ("script" in run && run.script === "sub") piece.sub = true;
    if ("script" in run && run.script === "sup") piece.sup = true;
    if (!extra) return piece;
    piece.decorationColor = extra.decorationColor;
    if (extra.decorationStyle) piece.decorationStyle = extra.decorationStyle;
    if (extra.color) piece.color = extra.color;
    return withDecorations(piece, [extra.decoration]);
  });
}

/**
 * Pieces of `text` with the marks that apply to them; `offset` shifts the
 * marks. Formulas print as text (formulaInlines).
 */
function markedInlines(
  text: string,
  marks: Mark[],
  offset: number,
  ctx: PdfContentContext,
  extra?: SegmentStyle,
): Inline[] {
  const formulas = marks
    .filter((mark) => mark.type === "formula")
    .map((mark) => ({
      from: Math.max(0, mark.from - offset),
      to: Math.min(text.length, mark.to - offset),
      whole: mark.from - offset >= 0 && mark.to - offset <= text.length,
    }))
    .filter((mark) => mark.from < mark.to)
    .sort((a, b) => a.from - b.from);
  if (formulas.length === 0) {
    return plainMarkedInlines(text, marks, offset, ctx, extra);
  }
  const inlines: Inline[] = [];
  let at = 0;
  for (const formula of formulas) {
    if (formula.from < at) continue;
    if (formula.from > at) {
      inlines.push(
        ...plainMarkedInlines(
          text.slice(at, formula.from),
          marks,
          offset + at,
          ctx,
          extra,
        ),
      );
    }
    inlines.push(
      ...formulaInlines(
        text.slice(formula.from, formula.to),
        formula.whole,
        extra,
      ),
    );
    at = formula.to;
  }
  if (at < text.length) {
    inlines.push(
      ...plainMarkedInlines(text.slice(at), marks, offset + at, ctx, extra),
    );
  }
  return inlines;
}

/** `text` with its marks other than formulas. */
function plainMarkedInlines(
  text: string,
  marks: Mark[],
  offset: number,
  ctx: PdfContentContext,
  extra?: SegmentStyle,
): Inline[] {
  const local = marks
    .filter((mark) => mark.type !== "formula")
    .map((mark) => ({
      mark,
      from: Math.max(0, mark.from - offset),
      to: Math.min(text.length, mark.to - offset),
    }))
    .filter((entry) => entry.from < entry.to);

  const cuts = new Set<number>([0, text.length]);
  local.forEach((entry) => {
    cuts.add(entry.from);
    cuts.add(entry.to);
  });
  const points = [...cuts].sort((a, b) => a - b);

  const inlines: Inline[] = [];
  for (let k = 0; k < points.length - 1; k += 1) {
    const from = points[k]!;
    const to = points[k + 1]!;
    const active = local.filter(
      (entry) => entry.from <= from && entry.to >= to,
    );
    const types = new Set(active.map((entry) => entry.mark.type));

    let piece: Inline = { text: text.slice(from, to) };
    if (types.has("bold")) piece.bold = true;
    if (types.has("italic")) piece.italics = true;
    const decorations: Decoration[] = [];
    if (types.has("underline")) decorations.push("underline");
    // Links read as links, and work on screen; the [n] after them lists
    // the address for print.
    const link = active.find(
      (entry) => entry.mark.type === "link" && isSafeHref(entry.mark.href),
    );
    if (link) {
      piece.color = LINK_BLUE;
      piece.link = link.mark.href!.trim();
      decorations.push("underline");
    }
    if (types.has("strike")) decorations.push("lineThrough");
    if (extra) {
      decorations.push(extra.decoration);
      piece.decorationColor = extra.decorationColor;
      if (extra.decorationStyle) piece.decorationStyle = extra.decorationStyle;
      if (extra.color) piece.color = extra.color;
    }
    piece = withDecorations(piece, decorations);
    inlines.push(piece);

    // The reference goes where the link really ends, not where a segment cuts it.
    for (const entry of active) {
      if (
        entry.mark.type === "link" &&
        entry.mark.to - offset === to &&
        isSafeHref(entry.mark.href)
      ) {
        const n = ctx.links.register(entry.mark.href.trim());
        inlines.push({ text: `[${n}]`, sup: true, color: CREUP_RED });
      }
    }
  }
  return inlines;
}

function emptySafe(inlines: Inline[]): Inline[] {
  return inlines.some((inline) => inline.text.length > 0)
    ? inlines
    : [{ text: " " }];
}

// Lists -------------------------------------------------------------------

interface BlockShape {
  type: BlockType;
  level?: number;
  list?: "bullet" | "ordered";
  marker?: ListMarker;
  start?: number;
  cell?: BlockCell;
  align?: BlockAlign;
  /** Starts on a new page (Block.pageBreak). */
  pageBreak?: true;
  image?: BlockImage;
}

interface Item {
  shape: BlockShape;
  inlines: Inline[];
  /**
   * A formula block: its source as it reads now, and whether a change
   * inside it is shown (then its source prints, changes marked, above it).
   */
  formula?: { source: string; changed: boolean };
  /** Whether the item takes a number in an ordered list (deleted ones do not). */
  countable: boolean;
  /** The block it shows, for page tags (PdfContentContext.pageTags). */
  blockId?: string;
}

type ListKind = "ol" | "ul";

interface ListFrame {
  kind: ListKind;
  level: number;
  depth: number;
  /** Ordered lists: how they number their items. */
  marker: ListMarker;
  /** List items and nested lists, which pdfmake renders without a marker. */
  items: Content[];
  counter: number;
}

/** pdfmake's list type for each number format of a marker. */
const ORDERED_TYPES: Record<string, OrderedListType> = {
  "1": "decimal",
  a: "lower-alpha",
  A: "upper-alpha",
  i: "lower-roman",
  I: "upper-roman",
};
const UNORDERED_TYPES: UnorderedListType[] = ["disc", "circle", "square"];

function listNode(frame: ListFrame): Content {
  // Only the outermost list leaves space after it.
  const style = frame.depth === 0 ? "list" : undefined;
  if (frame.kind === "ol") {
    return {
      ol: frame.items as OrderedListElement[],
      type: ORDERED_TYPES[frame.marker[0]!] ?? "decimal",
      separator: frame.marker[1]!,
      style,
    };
  }
  return {
    ul: frame.items as UnorderedListElement[],
    type: UNORDERED_TYPES[frame.depth % UNORDERED_TYPES.length],
    markerColor: CREUP_RED,
    style,
  };
}

function headingLevel(level: number | undefined): number {
  return Math.max(1, Math.min(4, level ?? 1));
}

function plainText(inlines: Inline[]): string {
  return inlines
    .filter((inline) => !inline.sup && inline.style !== "formatNote")
    .map((inline) => inline.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Colours that would vanish on the burgundy bar, made light. */
function onBurgundy(inline: Inline): Inline {
  const light = { ...inline };
  if (light.style === "amendmentRef" || light.color === CREUP_RED) {
    light.color = "#ffffff";
  } else if (light.color === MUTED_GREY) {
    light.color = "#e6c7c9";
  } else if (light.color === LINK_BLUE) {
    light.color = "#ffffff";
  }
  if (light.decorationColor) light.decorationColor = "#ffffff";
  return light;
}

/**
 * A heading in the template's style. Levels 1 and 3 are one-cell tables: a
 * burgundy bar with a 2 pt border that sticks out 6 pt on each side, and a
 * 1 pt burgundy box. The table carries `headlineLevel`, so the heading keeps
 * with the text after it, and its text the bookmark.
 */
function headingNode(item: Item, ctx: PdfContentContext): Content {
  const level = headingLevel(item.shape.level);
  const framed = level === 1 || level === 3;
  const bar = framed && level === 1;
  const text: ContentText = {
    text: emptySafe(bar ? item.inlines.map(onBurgundy) : item.inlines),
    style: framed ? (bar ? "barHeading" : "boxHeading") : `heading${level}`,
    ...alignment(item.shape),
  };
  const label = plainText(item.inlines).slice(0, 120);
  if (ctx.outline && item.countable && label) {
    const outline = ctx.outline;
    const open = (outline.open ??= []);
    while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
    const parent = open[open.length - 1]?.id ?? outline.parentId;
    outline.count = (outline.count ?? 0) + 1;
    const id = `${outline.parentId ?? "outline"}-heading-${outline.count}`;
    // pdfmake reads `id` to nest bookmarks under it; its typings omit it.
    (text as ContentText & { id?: string }).id = id;
    text.outline = true;
    text.outlineText = label;
    if (parent) text.outlineParentId = parent;
    open.push({ level, id });
  }
  if (!framed) return { ...text, headlineLevel: level };

  const border = bar ? 2 : 1;
  const table: ContentTable = {
    table: { widths: ["*"], body: [[text]] },
    layout: constantLayout({
      hLineWidth: border,
      vLineWidth: border,
      hLineColor: CREUP_RED,
      vLineColor: CREUP_RED,
      fillColor: bar ? CREUP_RED : null,
      paddingLeft: bar ? 4 : 3.5,
      paddingRight: 4,
      paddingTop: bar ? 0.5 : 1,
      paddingBottom: bar ? 0.5 : 1,
    }) as CustomTableLayout,
    margin: bar ? [-6, 12, -6, 12] : [-4.5, 0, -4.5, 12],
    headlineLevel: level,
  };
  return table;
}

/** pdfmake's alignment for a block's, when it has one. */
function alignment(shape: BlockShape): Pick<ContentText, "alignment"> {
  return shape.align ? { alignment: shape.align } : {};
}

/**
 * A running text's alignment: its own, else justified when the context asks
 * for it (PdfContentContext.justify). Justifying spreads the spaces of the
 * lines pdfmake has already broken, so it never moves a page break.
 */
function textAlignment(
  shape: BlockShape,
  ctx: PdfContentContext,
): Pick<ContentText, "alignment"> {
  if (shape.align) return { alignment: shape.align };
  return ctx.justify ? { alignment: "justify" } : {};
}

/** The tallest an image is drawn, in points: most of a page. */
const IMAGE_MAX_HEIGHT = 560;

/** The key an image takes in the PDF's `images` (embedded once). */
export function pdfImageKey(asset: string): string {
  return `doc-image-${asset}`;
}

/** The PDF's `images` entries for the loaded images. */
export function pdfImages(
  images: Record<string, ExportImage> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(images ?? {}).map(([asset, image]) => [
      pdfImageKey(asset),
      image.dataUrl,
    ]),
  );
}

/**
 * An image block: at its own size (a pixel read as at 96 dpi), no wider
 * than the text nor taller than most of a page, centred. One an amendment
 * removes shows faded. An image that could not be loaded leaves its
 * description in its place.
 */
function imageNode(item: Item, ctx: PdfContentContext): Content {
  const image = item.shape.image;
  if (!image || !ctx.images?.[image.asset]) {
    return {
      text: image?.alt ? `[${image.alt}]` : "",
      style: "paragraph",
      italics: true,
      alignment: "center",
    };
  }
  let width = Math.min(TABLE_WIDTH, image.width * 0.75);
  let height = (width * image.height) / image.width;
  if (height > IMAGE_MAX_HEIGHT) {
    height = IMAGE_MAX_HEIGHT;
    width = (height * image.width) / image.height;
  }
  return {
    image: pdfImageKey(image.asset),
    width,
    height,
    alignment: "center",
    margin: [0, 6, 0, 12],
    ...(item.countable ? {} : { opacity: 0.35 }),
  };
}

/**
 * A formula block: drawn (formulaSvg), centred, no wider than the text; one
 * that cannot be drawn prints as text (formulaRuns). A change inside it
 * prints its source with the change marked above how it reads now.
 */
function formulaNode(item: Item): Content {
  const source = item.formula?.source ?? plainText(item.inlines);
  const drawn = formulaSvg(source);
  const faded = item.countable ? {} : { opacity: 0.35 };
  const formula: Content = drawn
    ? {
        svg: drawn.svg,
        width: Math.min(TABLE_WIDTH, drawn.width),
        alignment: "center",
        margin: [0, 6, 0, 10],
        ...faded,
      }
    : {
        text: formulaInlines(source, true),
        style: "paragraph",
        alignment: "center",
        ...faded,
      };
  if (!item.formula?.changed) return formula;
  return {
    stack: [{ text: emptySafe(item.inlines), style: "paragraph" }, formula],
  };
}

function blockNode(item: Item, ctx: PdfContentContext): Content {
  if (item.shape.type === "heading") return headingNode(item, ctx);
  if (item.shape.type === "image") return imageNode(item, ctx);
  if (item.shape.type === "formula") return formulaNode(item);
  const text = emptySafe(item.inlines);
  const align = textAlignment(item.shape, ctx);
  if (item.shape.type === "quote") return { text, style: "quote", ...align };
  return { text, style: "paragraph", ...align };
}

/** Tables (groupTables) become pdfmake tables; other blocks flow. */
function assemble(items: Item[], ctx: PdfContentContext): Content[] {
  const output: Content[] = [];
  const runs = groupTables(
    items.map((item) => ({ ...item, cell: item.shape.cell })),
  );
  for (const run of runs) {
    if (run.kind === "blocks") {
      output.push(...assembleFlow(run.items, ctx, output.length > 0));
    } else output.push(tableNode(run.table, ctx));
  }
  return output;
}

/**
 * A table in the template's style: burgundy rules, a burgundy header row in
 * white bold that repeats on every page, cells on their fill from the
 * palette (cellLook), and spans laid out as a browser
 * does (tableGrid). pdfmake wants every row full, so spanned positions get
 * the empty placeholders it expects, and rows an amendment left short are
 * filled with blank cells. A table narrower than the text shares its own
 * width among its columns and sits where it says (tableLayoutOf). Its cells'
 * sides (BlockCell.borders) are drawn as the web view draws them
 * (gridEdges): a hidden side is left out, and a thick one makes the whole
 * rule it lies on thick, since pdfmake gives each rule one width.
 */
function tableNode(table: TableGroup<Item>, ctx: PdfContentContext): Content {
  const grid = tableGrid(table, (item) => !plainText(item.inlines).trim());
  const place = tableLayoutOf(table);
  const width = (TABLE_WIDTH * place.width) / 100;
  const offset =
    place.align === "center"
      ? (TABLE_WIDTH - width) / 2
      : place.align === "right"
        ? TABLE_WIDTH - width
        : 0;
  // Only a table with sides or rule colours of its own leaves the
  // template's rules.
  const edges = grid.rows.some((row) =>
    row.some((cell) => cell.cell.borders || cell.cell.borderColor),
  )
    ? gridSides(grid)
    : null;
  const thickRows = new Set<number>();
  const thickColumns = new Set<number>();
  // Wide tables (a balance sheet, landscape in Word) take a smaller type so
  // their figures and words fit their columns.
  const fontSize = tableFontSize(grid.columns);
  const body: TableCell[][] = grid.rows.map(() =>
    Array.from({ length: grid.columns }, () => ({ text: "" }) as TableCell),
  );
  // Positions a spanning cell covers, which pdfmake wants left empty but
  // with the sides of the cell that covers them.
  const covered = new Map<
    string,
    { border?: boolean[]; borderColor?: (string | undefined)[] }
  >();
  grid.rows.forEach((row, r) => {
    for (const cell of row) {
      const sides = edges?.get(cell);
      // pdfmake's order: left, top, right, bottom; a side without a colour
      // of its own takes the template's (the layout's).
      const order = ["left", "top", "right", "bottom"] as const;
      const border = sides
        ? order.map((side) => sides[side].edge !== "none")
        : undefined;
      const colours = sides?.[order[0]]
        ? order.map((side) => {
            const colour = sides[side].colour;
            return colour ? CELL_FILLS[colour].hex : undefined;
          })
        : undefined;
      const borderColor = colours?.some(Boolean) ? colours : undefined;
      if (sides?.top.edge === "thick") thickRows.add(r);
      if (sides?.bottom.edge === "thick") thickRows.add(r + cell.rowspan);
      if (sides?.left.edge === "thick") thickColumns.add(cell.column);
      if (sides?.right.edge === "thick") {
        thickColumns.add(cell.column + cell.colspan);
      }
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          if (dr || dc) {
            covered.set(`${r + dr}:${cell.column + dc}`, {
              border,
              borderColor,
            });
          }
        }
      }
      const look = cellLook(cell.cell);
      const cellCtx: PdfContentContext = {
        ...ctx,
        justify: false,
        ...(ctx.pageTags
          ? { tableRow: r < grid.headerRows ? "header" : "body" }
          : {}),
      };
      const nodes = look.color
        ? assembleFlow(
            cell.blocks.map((item) => onFill(item, look.color!)),
            cellCtx,
          ).map((node) => headingOnFill(node, look.color!))
        : assembleFlow(cell.blocks, cellCtx);
      // Blocks in a cell sit close together, the last one flush, in the
      // table's type (their own style would set the body's).
      const stack = nodes.map((node, index) =>
        typeof node === "object" && node !== null
          ? {
              ...node,
              margin: [0, 0, 0, index < nodes.length - 1 ? 4 : 0],
              ...(fontSize < BODY_FONT_SIZE ? { fontSize } : {}),
            }
          : node,
      ) as Content[];
      body[r]![cell.column] = {
        stack,
        ...(cell.colspan > 1 ? { colSpan: cell.colspan } : {}),
        ...(cell.rowspan > 1 ? { rowSpan: cell.rowspan } : {}),
        ...(border ? { border } : {}),
        ...(borderColor ? { borderColor } : {}),
        ...look,
      } as TableCell;
    }
  });
  for (const [key, sides] of covered) {
    const [r, c] = key.split(":").map(Number) as [number, number];
    if (body[r]) {
      body[r]![c] = {
        ...(sides.border ? { border: sides.border } : {}),
        ...(sides.borderColor ? { borderColor: sides.borderColor } : {}),
      } as TableCell;
    }
  }
  const rowRules = Array.from({ length: grid.rows.length + 1 }, (_, i) =>
    thickRows.has(i) ? TABLE_THICK_RULE : TABLE_RULE,
  );
  const columnRules = Array.from({ length: grid.columns + 1 }, (_, i) =>
    thickColumns.has(i) ? TABLE_THICK_RULE : TABLE_RULE,
  );
  const layout: CustomTableLayout =
    thickRows.size || thickColumns.size
      ? {
          ...TEMPLATE_TABLE_LAYOUT,
          hLineWidth: pdfFunction({
            kind: "byIndex",
            values: rowRules,
            fallback: TABLE_RULE,
          }),
          vLineWidth: pdfFunction({
            kind: "byIndex",
            values: columnRules,
            fallback: TABLE_RULE,
          }),
        }
      : TEMPLATE_TABLE_LAYOUT;
  return {
    table: {
      headerRows: grid.headerRows,
      // A row stays on one page, as in the template.
      dontBreakRows: true,
      widths: columnWidths(
        grid,
        fontSize,
        width,
        columnRules.reduce((sum, rule) => sum + rule, 0),
      ),
      body,
    },
    layout,
    margin: [offset, 0, 0, 12],
  };
}

/**
 * A block of a header cell or a filled one, with every colour of its own
 * (links and their references, amendment marks, removed text, notes) turned
 * into the cell's text colour: pdfmake keeps an inline's colour over the
 * cell's, and those would not read on a fill, or would be the fill itself.
 * A level 1 heading keeps its own bar and colours (onBurgundy).
 */
function onFill(item: Item, color: string): Item {
  if (item.shape.type === "heading" && headingLevel(item.shape.level) === 1)
    return item;
  return {
    ...item,
    inlines: item.inlines.map((inline) => {
      const plain = { ...inline };
      if (plain.color || plain.style === "amendmentRef") plain.color = color;
      if (plain.decorationColor) plain.decorationColor = color;
      return plain;
    }),
  };
}

const HEADING_STYLE = /^(heading\d|boxHeading)$/;

/** A heading below the bar takes the cell's text colour, not the burgundy. */
function headingOnFill(node: Content, color: string): Content {
  if (typeof node !== "object" || node === null || Array.isArray(node))
    return node;
  const style = (node as { style?: unknown }).style;
  if (typeof style === "string" && HEADING_STYLE.test(style))
    return { ...node, color } as Content;
  // The level 3 box is a one-cell table around the heading's text.
  const table = (node as Partial<ContentTable>).table;
  const inner = table?.body[0]?.[0];
  if (
    table &&
    typeof inner === "object" &&
    inner !== null &&
    (inner as { style?: unknown }).style === "boxHeading"
  ) {
    return {
      ...node,
      table: { ...table, body: [[{ ...inner, color } as TableCell]] },
    } as Content;
  }
  return node;
}

/**
 * A cell's fill and text colour: its fill from the palette (CELL_FILLS) with
 * the text colour that reads on it; a header cell is bold, and burgundy
 * with white text when it has no fill of its own.
 */
function cellLook(cell: BlockCell): {
  fillColor?: string;
  color?: string;
  bold?: boolean;
} {
  const fill = cellFillOf(cell);
  const look = fill
    ? { fillColor: CELL_FILLS[fill].hex, color: cellFillTextColour(fill) }
    : cell.header
      ? { fillColor: CREUP_RED, color: "#ffffff" }
      : {};
  return cell.header ? { ...look, bold: true } : look;
}

/** The body text's size, which tables keep up to five columns. */
const BODY_FONT_SIZE = 11;

function tableFontSize(columns: number): number {
  if (columns <= 5) return BODY_FONT_SIZE;
  return columns <= 7 ? 9 : 8;
}

/** The text width a table may take: the page between the template's margins. */
const TABLE_WIDTH = PAGE_WIDTH - TEMPLATE_MARGINS[0] - TEMPLATE_MARGINS[2];
/**
 * About the width of a character of Raleway Bold 11 pt: a column's longest
 * word must fit, in bold too (a header's, say).
 */
const BOLD_CHAR_WIDTH = 6.8;

/**
 * Column widths that, with each cell's padding and the rules between them
 * (which pdfmake adds on top of a fixed width), fill the text width, shared
 * as a browser's automatic layout would: by how much text each column's own
 * cells hold
 * (cells spanning several columns aside), but never narrower than its
 * longest word, which pdfmake would push past the page instead of wrapping.
 */
function columnWidths(
  grid: TableGrid<Item>,
  fontSize = BODY_FONT_SIZE,
  tableWidth = TABLE_WIDTH,
  rules = (grid.columns + 1) * TABLE_RULE,
): number[] {
  const scale = fontSize / BODY_FONT_SIZE;
  const text = (cell: GridCell<Item>) =>
    cell.blocks.map((item) => plainText(item.inlines)).join(" ");
  const longest = Array.from({ length: grid.columns }, () => 0);
  const word = Array.from({ length: grid.columns }, () => 0);
  for (const row of grid.rows) {
    for (const cell of row) {
      if (cell.colspan > 1) continue;
      const content = text(cell);
      longest[cell.column] = Math.max(longest[cell.column]!, content.length);
      for (const part of content.split(/\s+/)) {
        word[cell.column] = Math.max(word[cell.column]!, part.length);
      }
    }
  }
  // Long text wraps anyway: past 40 characters a column wants no more.
  const weights = longest.map((length, column) =>
    Math.max(Math.min(length, 40), word[column]!, 4),
  );
  const available = tableWidth - grid.columns * 2 * TABLE_CELL_PADDING - rules;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => (available * weight) / total);
  const minimum = word.map((length) =>
    Math.min(length * BOLD_CHAR_WIDTH * scale + 1, available / grid.columns),
  );
  // Columns under their minimum take it from the others, in proportion.
  const short = widths.map((width, column) => width < minimum[column]!);
  const missing = widths.reduce(
    (sum, width, column) =>
      sum + (short[column] ? minimum[column]! - width : 0),
    0,
  );
  const spare = widths.reduce(
    (sum, width, column) =>
      sum + (short[column] ? 0 : width - minimum[column]!),
    0,
  );
  return widths.map((width, column) =>
    short[column]
      ? minimum[column]!
      : width -
        (spare > 0 ? (missing * (width - minimum[column]!)) / spare : 0),
  );
}

/**
 * Groups consecutive list items into nested pdfmake lists. A nested list is
 * a sibling element of its parent list, which pdfmake renders without a
 * marker. Ordered items carry an explicit counter so struck items do not
 * consume a number.
 */
function assembleFlow(
  items: Item[],
  ctx: PdfContentContext,
  /** Something of the text comes before these blocks. */
  afterContent = false,
): Content[] {
  const output: Content[] = [];
  const stack: ListFrame[] = [];

  for (const item of items) {
    if (item.shape.type !== "list_item") {
      stack.length = 0;
      const node = tagNode(blockNode(item, ctx), item, ctx);
      // «Empezar en una página nueva» (user's decision of 2026-11-26), never
      // for the text's first block, which would leave the title alone on a
      // page, nor inside a table (assemble sends cells elsewhere).
      if (
        item.shape.pageBreak &&
        !item.shape.cell &&
        (afterContent || output.length > 0) &&
        typeof node === "object" &&
        node !== null &&
        !Array.isArray(node)
      ) {
        (node as { pageBreak?: string }).pageBreak = "before";
      }
      output.push(node);
      continue;
    }

    const level = Math.max(0, Math.min(6, item.shape.level ?? 0));
    const kind: ListKind = item.shape.list === "ordered" ? "ol" : "ul";
    const marker = markerOf(item.shape);
    // A struck item takes no number, but one with `start` still starts the
    // list again: the next counted item shows that number.
    const start = kind === "ol" ? item.shape.start : undefined;
    while (stack.length > 0 && stack[stack.length - 1]!.level > level) {
      stack.pop();
    }
    let top = stack[stack.length - 1];
    // A list ends where its level changes kind or marker, or starts again
    // (as orderedListNumbers groups items).
    if (
      top &&
      top.level === level &&
      (top.kind !== kind ||
        (kind === "ol" && (top.marker !== marker || start !== undefined)))
    ) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < level) {
      const frame: ListFrame = {
        kind,
        level,
        depth: stack.length,
        marker,
        items: [],
        counter: start !== undefined ? start - 1 : 0,
      };
      const node = listNode(frame);
      if (top) top.items.push(node);
      else output.push(node);
      stack.push(frame);
      top = frame;
    }

    const element: ContentText & OrderedListElementProperties = {
      text: emptySafe(item.inlines),
      style: "listItem",
      ...textAlignment(item.shape, ctx),
    };
    if (top.kind === "ol") {
      if (item.countable) {
        top.counter += 1;
        element.counter = top.counter;
      } else {
        element.listType = "none";
      }
    }
    top.items.push(tagNode(element, item, ctx));
  }
  return output;
}

// Public converters -----------------------------------------------------

/** Plain rendering of a version (clean text). */
export function blocksToPdf(
  blocks: Block[],
  ctx: PdfContentContext,
  /**
   * A note to open a block with, by block id: «Pendiente de conciliar E3 y
   * E5» before a passage approved pending conciliation.
   */
  notes?: ReadonlyMap<string, string>,
): Content[] {
  return assemble(
    blocks.map((block) => ({
      shape: block,
      inlines: [
        ...(notes?.has(block.id)
          ? [
              {
                text: `[${notes.get(block.id)}] `,
                style: "formatNote",
                color: CREUP_RED,
                bold: true,
              } satisfies Inline,
            ]
          : []),
        ...markedInlines(block.text, block.marks, 0, ctx),
      ],
      countable: true,
      blockId: block.id,
      ...(block.type === "formula"
        ? { formula: { source: block.text, changed: false } }
        : {}),
    })),
    ctx,
  );
}

/** The note of a formatting change: what changes, in words; null without. */
function formatNote(
  changes: FormatChange[],
  ctx: AnnotatedContext,
  wrap: (label: string) => string,
): Inline | null {
  const describe = ctx.formatLabel;
  if (!describe) return null;
  const label = changes
    .map((change) => describe(change))
    .filter(Boolean)
    .join(", ");
  if (!label) return null;
  return { text: wrap(label), style: "formatNote", color: MUTED_GREY };
}

/**
 * Annotated rendering of consolidated blocks: inserted text underlined,
 * removed text struck through in grey, and the amendment code in
 * superscript at the end of every run of text it produced or removed.
 * Text whose formatting an amendment changes shows its new format over a
 * dotted line, followed by what changes in words; a block whose own format
 * changes (to a heading, a list...) starts with those words.
 * A fragment (previewAmendment) prints «[…]», in grey, on a line of its
 * own where it leaves text out (`gapBefore`), as renderAnnotated does.
 */
export function annotatedToPdf(
  blocks: FragmentBlock[],
  ctx: AnnotatedContext,
): Content[] {
  const items: Item[] = blocks.flatMap((block, index): Item[] => {
    const gap: Item[] =
      block.gapBefore && index > 0
        ? [
            {
              shape: { type: "paragraph" },
              inlines: [{ text: "[…]", color: MUTED_GREY }],
              countable: true,
            },
          ]
        : [];
    const inlines: Inline[] = [];
    if (block.format && block.status === "kept") {
      const note = formatNote(
        block.format.changes,
        ctx,
        (label) => `[${label}]`,
      );
      if (note) {
        inlines.push(note);
        if (ctx.codeOf) {
          inlines.push({
            text: ctx.codeOf(block.format.source),
            sup: true,
            style: "amendmentRef",
          });
        }
        inlines.push({ text: " " });
      }
    }
    let offset = 0;
    block.segments.forEach((segment, index) => {
      if (segment.removed) {
        inlines.push(
          withDecorations(
            {
              text: segment.text,
              color: REMOVED.color,
              decorationColor: REMOVED.decorationColor,
            },
            [REMOVED.decoration],
          ),
        );
      } else {
        inlines.push(
          ...markedInlines(
            segment.text,
            block.marks,
            offset,
            ctx,
            segment.format ? FORMATTED : segment.source ? INSERTED : undefined,
          ),
        );
        if (segment.format) {
          const note = formatNote(
            segment.format,
            ctx,
            (label) => ` (${label})`,
          );
          if (note) inlines.push(note);
        }
        // Removed text is not part of the clean text the marks refer to.
        offset += segment.text.length;
      }
      const next = block.segments[index + 1];
      if (ctx.codeOf && segment.source && next?.source !== segment.source) {
        inlines.push({
          text: ctx.codeOf(segment.source),
          sup: true,
          style: "amendmentRef",
        });
      }
    });
    return [
      ...gap,
      {
        shape: block,
        inlines,
        countable: block.status !== "deleted",
        ...(block.type === "formula"
          ? {
              formula: {
                source: block.segments
                  .filter((segment) => !segment.removed)
                  .map((segment) => segment.text)
                  .join(""),
                changed:
                  block.status === "kept" &&
                  block.segments.some((segment) => segment.source),
              },
            }
          : {}),
      },
    ];
  });
  return assemble(items, ctx);
}

/** Numbered list of the URLs referenced as [n] in the text. */
export function linksToPdf(links: LinkRegistry): Content | null {
  if (links.entries.length === 0) return null;
  return {
    ol: links.entries.map((url) => ({
      text: url,
      link: url,
      color: CREUP_RED,
      fontSize: 8.5,
    })),
    separator: ["[", "]"],
    fontSize: 8.5,
    margin: [0, 0, 0, 6],
  };
}
