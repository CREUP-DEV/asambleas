import type {
  Block,
  ConsolidatedBlock,
  ListMarker,
  Mark,
  MarkType,
  Segment,
} from "../../types/content";
import { markerOf } from "./lists";
import { groupTables, type TableGroup } from "./tables";

/**
 * HTML rendering of structured content. Text is always escaped and links are
 * restricted to safe schemes, so the output is safe for v-html by
 * construction: no stored HTML is ever echoed back.
 */

const MARK_ORDER: MarkType[] = [
  "link",
  "bold",
  "italic",
  "underline",
  "strike",
];
const MARK_TAGS: Record<Exclude<MarkType, "link">, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isSafeHref(href: string | undefined): href is string {
  return Boolean(href && /^(https?:|mailto:)/i.test(href.trim()));
}

function escapeText(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/** Renders `text` with the marks that apply to it; `offset` shifts the marks. */
export function renderInline(text: string, marks: Mark[], offset = 0): string {
  const local = marks
    .map((mark) => ({
      ...mark,
      from: Math.max(0, mark.from - offset),
      to: Math.min(text.length, mark.to - offset),
    }))
    .filter((mark) => mark.from < mark.to);
  if (local.length === 0) return escapeText(text);

  const cuts = new Set<number>([0, text.length]);
  local.forEach((mark) => {
    cuts.add(mark.from);
    cuts.add(mark.to);
  });
  const points = [...cuts].sort((a, b) => a - b);

  let html = "";
  for (let k = 0; k < points.length - 1; k += 1) {
    const from = points[k]!;
    const to = points[k + 1]!;
    const active = local.filter((mark) => mark.from <= from && mark.to >= to);
    let piece = escapeText(text.slice(from, to));
    for (const type of [...MARK_ORDER].reverse()) {
      const mark = active.find((candidate) => candidate.type === type);
      if (!mark) continue;
      if (type === "link") {
        if (isSafeHref(mark.href)) {
          piece = `<a href="${escapeHtml(mark.href.trim())}" rel="noopener noreferrer nofollow" target="_blank">${piece}</a>`;
        }
      } else {
        const tag = MARK_TAGS[type];
        piece = `<${tag}>${piece}</${tag}>`;
      }
    }
    html += piece;
  }
  return html;
}

interface ListFrame {
  tag: "ul" | "ol";
  level: number;
  /** Ordered lists: their marker; null for bullets. */
  marker: ListMarker | null;
}

type RenderableBlock = Pick<
  Block,
  "id" | "type" | "level" | "list" | "marker" | "start" | "cell" | "align"
> & {
  inner: string;
  attrs?: string;
  /** Extra class of the block element, e.g. "cx-block-inserted". */
  className?: string;
};

export interface RenderOptions {
  /**
   * Headings as real <h2>-<h5> (the default). Excerpts pass false so their
   * headings are styled paragraphs and stay out of the page outline.
   */
  headings?: boolean;
}

/**
 * Blocks to HTML: tables (groupTables) as <table>, each cell's blocks laid
 * out like the text around them, inside a wrapper that scrolls sideways on
 * narrow screens.
 */
function wrapBlocks(items: RenderableBlock[], headings = true): string {
  let html = "";
  for (const run of groupTables(items)) {
    html +=
      run.kind === "blocks"
        ? wrapFlow(run.items, headings)
        : tableHtml(run.table, headings);
  }
  return html;
}

function tableHtml(
  table: TableGroup<RenderableBlock>,
  headings: boolean,
): string {
  let html = '<div class="cx-table-wrap"><table class="cx-table"><tbody>';
  for (const row of table.rows) {
    html += "<tr>";
    for (const cell of row.cells) {
      const tag = cell.cell.header ? "th" : "td";
      let attrs =
        !cell.cell.header && cell.cell.shade ? ' class="cx-shade"' : "";
      if (cell.cell.colspan)
        attrs += ` colspan="${Math.trunc(cell.cell.colspan)}"`;
      if (cell.cell.rowspan)
        attrs += ` rowspan="${Math.trunc(cell.cell.rowspan)}"`;
      html += `<${tag}${attrs}>${wrapFlow(cell.blocks, headings)}</${tag}>`;
    }
    html += "</tr>";
  }
  return `${html}</tbody></table></div>`;
}

/** Blocks outside tables, or inside one cell: paragraphs, lists, headings. */
function wrapFlow(items: RenderableBlock[], headings: boolean): string {
  let html = "";
  const stack: ListFrame[] = [];
  const closeFrame = () => {
    html += `</li></${stack.pop()!.tag}>`;
  };
  const attrsOf = (item: RenderableBlock, ...classes: string[]) => {
    // Alignment from a fixed set (BLOCK_ALIGNMENTS), as a class.
    const align = item.align ? `cx-align-${item.align}` : "";
    const names = [...classes, item.className, align].filter(Boolean).join(" ");
    const classAttr = names ? ` class="${escapeHtml(names)}"` : "";
    return `data-block-id="${escapeHtml(item.id)}"${item.attrs ?? ""}${classAttr}`;
  };

  for (const item of items) {
    const attrs = attrsOf(item);
    if (item.type === "list_item") {
      const level = Math.max(0, Math.min(6, item.level ?? 0));
      const tag = item.list === "ordered" ? "ol" : "ul";
      const marker = tag === "ol" ? markerOf(item) : null;
      while (stack.length > 0 && stack[stack.length - 1]!.level > level) {
        closeFrame();
      }
      const top = stack[stack.length - 1];
      // An item with `start` begins its list again (orderedListNumbers).
      if (
        top &&
        top.level === level &&
        top.tag === tag &&
        top.marker === marker &&
        item.start === undefined
      ) {
        html += `</li><li ${attrs}>${item.inner}`;
        continue;
      }
      if (top && top.level === level) closeFrame();
      // Opens a new list, nested inside the open item when deeper. Markers
      // other than "1." are drawn by the CSS for `data-marker`.
      let listAttrs = "";
      if (marker && marker !== "1.") {
        listAttrs += ` data-marker="${escapeHtml(marker)}"`;
      }
      if (tag === "ol" && item.start !== undefined) {
        listAttrs += ` start="${Math.trunc(item.start)}"`;
      }
      html += `<${tag}${listAttrs}><li ${attrs}>${item.inner}`;
      stack.push({ tag, level, marker });
      continue;
    }
    while (stack.length > 0) closeFrame();
    if (item.type === "heading") {
      // Block levels 1-4 become h2-h5: pages keep their own h1.
      const level = Math.max(2, Math.min(5, (item.level ?? 1) + 1));
      html += headings
        ? `<h${level} ${attrs}>${item.inner}</h${level}>`
        : `<p ${attrsOf(item, "cx-heading", `cx-heading-${level}`)}>${item.inner}</p>`;
    } else if (item.type === "quote") {
      html += `<blockquote ${attrs}><p>${item.inner}</p></blockquote>`;
    } else {
      html += `<p ${attrs}>${item.inner}</p>`;
    }
  }
  while (stack.length > 0) closeFrame();
  return html;
}

/** Plain rendering of a version. Headings start at h2 so pages keep their h1. */
export function renderBlocks(
  blocks: Block[],
  options: RenderOptions = {},
): string {
  return wrapBlocks(
    blocks.map((block) => ({
      ...block,
      inner: renderInline(block.text, block.marks) || "<br>",
    })),
    options.headings,
  );
}

export type AnnotatedMode = "diff" | "provenance" | "clean";

export interface AnnotatedOptions extends RenderOptions {
  mode: AnnotatedMode;
  /** Short label shown next to provenance, e.g. "12" or "T1". */
  label?: (amendmentId: string) => string;
  /** Highlights the segments of one amendment. */
  focus?: string | null;
  /**
   * Visually hidden words read before each insertion and removal in diff
   * mode (e.g. "Added:"), so the change is not told by colour alone.
   */
  diffLabels?: { inserted: string; removed: string };
}

function srOnly(label: string | undefined): string {
  return label ? `<span class="sr-only">${escapeHtml(label)} </span>` : "";
}

function segmentHtml(
  segment: Segment,
  inner: string,
  options: AnnotatedOptions,
): string {
  if (!segment.source) return inner;
  const id = escapeHtml(segment.source);
  const focused = options.focus === segment.source ? " cx-focus" : "";
  if (segment.removed) {
    return options.mode === "diff"
      ? `<del class="cx-del${focused}" data-amendment-id="${id}">${srOnly(options.diffLabels?.removed)}${inner}</del>`
      : "";
  }
  if (options.mode === "diff") {
    return `<ins class="cx-ins${focused}" data-amendment-id="${id}">${srOnly(options.diffLabels?.inserted)}${inner}</ins>`;
  }
  if (options.mode === "provenance") {
    const label = options.label?.(segment.source);
    const sup = label
      ? `<sup class="cx-ref" aria-hidden="true">${escapeHtml(label)}</sup>`
      : "";
    return `<span class="cx-prov${focused}" data-amendment-id="${id}">${inner}</span>${sup}`;
  }
  return inner;
}

/**
 * Renders consolidated blocks in one of three modes:
 * - `diff`: insertions as <ins>, removals as <del> (styled by the diff mode);
 * - `provenance`: clean text with every amended fragment linked to its amendment;
 * - `clean`: the consolidated text alone.
 */
export function renderAnnotated(
  blocks: ConsolidatedBlock[],
  options: AnnotatedOptions,
): string {
  const items: RenderableBlock[] = [];
  for (const block of blocks) {
    if (block.status === "deleted" && options.mode !== "diff") continue;

    let offset = 0;
    let inner = "";
    for (const segment of block.segments) {
      if (segment.removed) {
        inner += segmentHtml(segment, escapeText(segment.text), options);
        continue;
      }
      const text = renderInline(segment.text, block.marks, offset);
      offset += segment.text.length;
      inner += segmentHtml(segment, text, options);
    }

    let attrs = "";
    let className: string | undefined;
    if (block.status !== "kept" && block.source) {
      attrs = ` data-amendment-id="${escapeHtml(block.source)}"`;
      className = `cx-block-${block.status}`;
    }
    items.push({ ...block, inner: inner || "<br>", attrs, className });
  }
  return wrapBlocks(items, options.headings);
}

/**
 * Human references for blocks: the nearest preceding heading and the
 * paragraph's ordinal under it, e.g. { heading: "3. Devolución", paragraph: 2 }.
 */
export function blockLabels(
  blocks: Block[],
): Map<string, { heading: string | null; paragraph: number }> {
  const labels = new Map<
    string,
    { heading: string | null; paragraph: number }
  >();
  let heading: string | null = null;
  let paragraph = 0;
  for (const block of blocks) {
    if (block.type === "heading") {
      heading = block.text.trim().slice(0, 80) || null;
      paragraph = 0;
      labels.set(block.id, { heading, paragraph: 0 });
      continue;
    }
    paragraph += 1;
    labels.set(block.id, { heading, paragraph });
  }
  return labels;
}

/** Plain text of a block list, for search, word counts and exports. */
export function blocksToPlainText(blocks: Pick<Block, "text">[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}
