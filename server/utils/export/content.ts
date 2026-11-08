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
  ConsolidatedBlock,
  ListMarker,
  Mark,
} from "../../../shared/types/content";
import { markerOf } from "../../../shared/utils/content/lists";
import {
  groupTables,
  tableGrid,
  type GridCell,
  type TableGrid,
  type TableGroup,
} from "../../../shared/utils/content/tables";
import { PAGE_WIDTH, TEMPLATE_MARGINS } from "./brand";
import { isSafeHref } from "../../../shared/utils/content/render";

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
};

/** The template's tables: burgundy rules around every cell. */
/** A table cell's side padding and its rules, in points. */
const TABLE_CELL_PADDING = 5;
const TABLE_RULE = 0.75;

export const TEMPLATE_TABLE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => TABLE_RULE,
  vLineWidth: () => TABLE_RULE,
  hLineColor: () => CREUP_RED,
  vLineColor: () => CREUP_RED,
  paddingLeft: () => TABLE_CELL_PADDING,
  paddingRight: () => TABLE_CELL_PADDING,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

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

export interface PdfContentContext {
  links: LinkRegistry;
  /** Adds headings to the PDF bookmarks, under the given parent bookmark id. */
  outline?: OutlineState;
}

export interface AnnotatedContext extends PdfContentContext {
  /** Short code shown in superscript for an amendment id, e.g. "CEUM 4". */
  codeOf: (amendmentId: string) => string;
}

type Inline = ContentText & { text: string };

interface SegmentStyle {
  decoration: Decoration;
  color?: string;
  decorationColor: string;
}

const INSERTED: SegmentStyle = {
  decoration: "underline",
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

/** Pieces of `text` with the marks that apply to them; `offset` shifts the marks. */
function markedInlines(
  text: string,
  marks: Mark[],
  offset: number,
  ctx: PdfContentContext,
  extra?: SegmentStyle,
): Inline[] {
  const local = marks
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
}

interface Item {
  shape: BlockShape;
  inlines: Inline[];
  /** Whether the item takes a number in an ordered list (deleted ones do not). */
  countable: boolean;
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
    .filter((inline) => !inline.sup)
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
    layout: {
      hLineWidth: () => border,
      vLineWidth: () => border,
      hLineColor: () => CREUP_RED,
      vLineColor: () => CREUP_RED,
      fillColor: () => (bar ? CREUP_RED : null),
      paddingLeft: () => (bar ? 4 : 3.5),
      paddingRight: () => 4,
      paddingTop: () => (bar ? 0.5 : 1),
      paddingBottom: () => (bar ? 0.5 : 1),
    },
    margin: bar ? [-6, 12, -6, 12] : [-4.5, 0, -4.5, 12],
    headlineLevel: level,
  };
  return table;
}

/** pdfmake's alignment for a block's, when it has one. */
function alignment(shape: BlockShape): Pick<ContentText, "alignment"> {
  return shape.align ? { alignment: shape.align } : {};
}

function blockNode(item: Item, ctx: PdfContentContext): Content {
  if (item.shape.type === "heading") return headingNode(item, ctx);
  const text = emptySafe(item.inlines);
  const align = alignment(item.shape);
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
    if (run.kind === "blocks") output.push(...assembleFlow(run.items, ctx));
    else output.push(tableNode(run.table, ctx));
  }
  return output;
}

/**
 * A table in the template's style: burgundy rules, a burgundy header row in
 * white bold that repeats on every page, and spans laid out as a browser
 * does (tableGrid). pdfmake wants every row full, so spanned positions get
 * the empty placeholders it expects, and rows an amendment left short are
 * filled with blank cells.
 */
function tableNode(table: TableGroup<Item>, ctx: PdfContentContext): Content {
  const grid = tableGrid(table);
  const body: TableCell[][] = grid.rows.map(() =>
    Array.from({ length: grid.columns }, () => ({ text: "" }) as TableCell),
  );
  // Positions a spanning cell covers, which pdfmake wants left empty.
  const covered = new Set<string>();
  grid.rows.forEach((row, r) => {
    for (const cell of row) {
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          if (dr || dc) covered.add(`${r + dr}:${cell.column + dc}`);
        }
      }
      const nodes = assembleFlow(cell.blocks, ctx);
      // Blocks in a cell sit close together, the last one flush.
      const stack = nodes.map((node, index) =>
        typeof node === "object" && node !== null
          ? { ...node, margin: [0, 0, 0, index < nodes.length - 1 ? 4 : 0] }
          : node,
      ) as Content[];
      body[r]![cell.column] = {
        stack,
        ...(cell.colspan > 1 ? { colSpan: cell.colspan } : {}),
        ...(cell.rowspan > 1 ? { rowSpan: cell.rowspan } : {}),
        ...(cell.cell.header
          ? { fillColor: CREUP_RED, color: "#ffffff", bold: true }
          : {}),
      } as TableCell;
    }
  });
  for (const key of covered) {
    const [r, c] = key.split(":").map(Number) as [number, number];
    if (body[r]) body[r]![c] = {} as TableCell;
  }
  return {
    table: {
      headerRows: grid.headerRows,
      // A row stays on one page, as in the template.
      dontBreakRows: true,
      widths: columnWidths(grid),
      body,
    },
    layout: TEMPLATE_TABLE_LAYOUT,
    margin: [0, 0, 0, 12],
  };
}

/** The text width a table may take: the page between the template's margins. */
const TABLE_WIDTH = PAGE_WIDTH - TEMPLATE_MARGINS[0] - TEMPLATE_MARGINS[2];
/** About the width of a character of Raleway 11 pt. */
const CHAR_WIDTH = 6.2;

/**
 * Column widths that, with each cell's padding and the rules between them
 * (which pdfmake adds on top of a fixed width), fill the text width, shared
 * as a browser's automatic layout would: by how much text each column's own
 * cells hold
 * (cells spanning several columns aside), but never narrower than its
 * longest word, which pdfmake would push past the page instead of wrapping.
 */
function columnWidths(grid: TableGrid<Item>): number[] {
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
  const available =
    TABLE_WIDTH -
    grid.columns * 2 * TABLE_CELL_PADDING -
    (grid.columns + 1) * TABLE_RULE;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => (available * weight) / total);
  const minimum = word.map((length) =>
    Math.min(length * CHAR_WIDTH + 1, available / grid.columns),
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
function assembleFlow(items: Item[], ctx: PdfContentContext): Content[] {
  const output: Content[] = [];
  const stack: ListFrame[] = [];

  for (const item of items) {
    if (item.shape.type !== "list_item") {
      stack.length = 0;
      output.push(blockNode(item, ctx));
      continue;
    }

    const level = Math.max(0, Math.min(6, item.shape.level ?? 0));
    const kind: ListKind = item.shape.list === "ordered" ? "ol" : "ul";
    const marker = markerOf(item.shape);
    // A struck item that would start the list again takes no number, so it
    // does not start it either.
    const start =
      kind === "ol" && item.countable ? item.shape.start : undefined;
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
      ...alignment(item.shape),
    };
    if (top.kind === "ol") {
      if (item.countable) {
        top.counter += 1;
        element.counter = top.counter;
      } else {
        element.listType = "none";
      }
    }
    top.items.push(element);
  }
  return output;
}

// Public converters -----------------------------------------------------

/** Plain rendering of a version (clean text). */
export function blocksToPdf(
  blocks: Block[],
  ctx: PdfContentContext,
): Content[] {
  return assemble(
    blocks.map((block) => ({
      shape: block,
      inlines: markedInlines(block.text, block.marks, 0, ctx),
      countable: true,
    })),
    ctx,
  );
}

/**
 * Annotated rendering of consolidated blocks: inserted text underlined,
 * removed text struck through in grey, and the amendment code in
 * superscript at the end of every run of text it produced or removed.
 */
export function annotatedToPdf(
  blocks: ConsolidatedBlock[],
  ctx: AnnotatedContext,
): Content[] {
  const items: Item[] = blocks.map((block) => {
    const inlines: Inline[] = [];
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
            segment.source ? INSERTED : undefined,
          ),
        );
        // Removed text is not part of the clean text the marks refer to.
        offset += segment.text.length;
      }
      const next = block.segments[index + 1];
      if (segment.source && next?.source !== segment.source) {
        inlines.push({
          text: ctx.codeOf(segment.source),
          sup: true,
          style: "amendmentRef",
        });
      }
    });
    return {
      shape: block,
      inlines,
      countable: block.status !== "deleted",
    };
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
