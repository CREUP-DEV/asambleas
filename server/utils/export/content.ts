import type {
  Content,
  ContentText,
  Decoration,
  OrderedListElement,
  OrderedListElementProperties,
  OrderedListType,
  Style,
  UnorderedListElement,
  UnorderedListType,
} from "pdfmake/interfaces";
import type {
  Block,
  BlockType,
  ConsolidatedBlock,
  Mark,
} from "../../../shared/types/content";
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

/** Styles referenced by the nodes this module produces. */
export const CONTENT_STYLES: Record<string, Style> = {
  heading1: {
    fontSize: 15,
    bold: true,
    color: CREUP_RED,
    margin: [0, 14, 0, 6],
  },
  heading2: {
    fontSize: 13,
    bold: true,
    color: CREUP_RED,
    margin: [0, 12, 0, 5],
  },
  heading3: {
    fontSize: 11.5,
    bold: true,
    color: CREUP_RED,
    margin: [0, 10, 0, 4],
  },
  heading4: {
    fontSize: 10.5,
    bold: true,
    color: CREUP_RED,
    margin: [0, 8, 0, 3],
  },
  paragraph: { fontSize: 10, lineHeight: 1.35, margin: [0, 0, 0, 7] },
  quote: {
    fontSize: 10,
    lineHeight: 1.35,
    italics: true,
    color: "#3d3d3d",
    margin: [18, 0, 18, 7],
  },
  listItem: { fontSize: 10, lineHeight: 1.35, margin: [0, 0, 0, 3] },
  list: { margin: [0, 0, 0, 6] },
  amendmentRef: { color: CREUP_RED, bold: true },
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

export interface PdfContentContext {
  links: LinkRegistry;
  /** Adds headings to the PDF bookmarks, under the given parent bookmark id. */
  outline?: { parentId?: string };
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
  /** List items and nested lists, which pdfmake renders without a marker. */
  items: Content[];
  counter: number;
}

const ORDERED_TYPES: { type: OrderedListType; separator: string }[] = [
  { type: "decimal", separator: "." },
  { type: "lower-alpha", separator: ")" },
  { type: "lower-roman", separator: "." },
];
const UNORDERED_TYPES: UnorderedListType[] = ["disc", "circle", "square"];

function listNode(frame: ListFrame): Content {
  if (frame.kind === "ol") {
    const style = ORDERED_TYPES[frame.depth % ORDERED_TYPES.length]!;
    return {
      ol: frame.items as OrderedListElement[],
      type: style.type,
      separator: style.separator,
      style: "list",
    };
  }
  return {
    ul: frame.items as UnorderedListElement[],
    type: UNORDERED_TYPES[frame.depth % UNORDERED_TYPES.length],
    style: "list",
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

function blockNode(item: Item, ctx: PdfContentContext): ContentText {
  const text = emptySafe(item.inlines);
  if (item.shape.type === "heading") {
    const level = headingLevel(item.shape.level);
    const node: ContentText = {
      text,
      style: `heading${level}`,
      headlineLevel: level,
    };
    const label = plainText(item.inlines).slice(0, 120);
    if (ctx.outline && item.countable && label) {
      node.outline = true;
      node.outlineText = label;
      if (ctx.outline.parentId) node.outlineParentId = ctx.outline.parentId;
    }
    return node;
  }
  if (item.shape.type === "quote") return { text, style: "quote" };
  return { text, style: "paragraph" };
}

/**
 * Groups consecutive list items into nested pdfmake lists. A nested list is
 * a sibling element of its parent list, which pdfmake renders without a
 * marker. Ordered items carry an explicit counter so struck items do not
 * consume a number.
 */
function assemble(items: Item[], ctx: PdfContentContext): Content[] {
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
    while (stack.length > 0 && stack[stack.length - 1]!.level > level) {
      stack.pop();
    }
    let top = stack[stack.length - 1];
    if (top && top.level === level && top.kind !== kind) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < level) {
      const frame: ListFrame = {
        kind,
        level,
        depth: stack.length,
        items: [],
        counter: 0,
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
