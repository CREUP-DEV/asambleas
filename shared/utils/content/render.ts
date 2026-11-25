import type {
  BlockImage,
  Block,
  ConsolidatedBlock,
  FormatChange,
  ListMarker,
  Mark,
  MarkType,
  Segment,
} from "../../types/content";
import {
  CELL_SIDES,
  IMAGE_ASSET_PATTERN,
  IMAGE_URL_PREFIX,
} from "../../types/content";
import { cellFillOf } from "../../constants/cellFills";
import type { FragmentBlock } from "./consolidate";
import { withAutolinks } from "./autolink";
import { renderFormula } from "./formula";
import { markerOf } from "./lists";
import {
  cellBorderTokens,
  gridSides,
  groupTables,
  tableGrid,
  tableLayoutAttributes,
  tableLayoutOf,
  type TableGroup,
} from "./tables";

/**
 * HTML rendering of structured content. Text is always escaped and links are
 * restricted to safe schemes, so the output is safe for v-html by
 * construction: no stored HTML is ever echoed back. Formulas are the one
 * markup not built here: MathML from their LaTeX source, checked against an
 * allowlist (formula.ts).
 */

const MARK_ORDER: MarkType[] = [
  "link",
  "bold",
  "italic",
  "underline",
  "strike",
];
const MARK_TAGS: Record<Exclude<MarkType, "link" | "formula">, string> = {
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

/**
 * Renders `text` with the marks that apply to it; `offset` shifts the marks.
 * A formula is drawn whole; one cut by the range (a change inside it, in a
 * diff) shows its source instead, so half a formula is never drawn.
 */
export function renderInline(text: string, marks: Mark[], offset = 0): string {
  const formulas = marks
    .filter((mark) => mark.type === "formula")
    .map((mark) => ({
      from: Math.max(0, mark.from - offset),
      to: Math.min(text.length, mark.to - offset),
      whole: mark.from - offset >= 0 && mark.to - offset <= text.length,
    }))
    .filter((mark) => mark.from < mark.to)
    .sort((a, b) => a.from - b.from);
  if (formulas.length === 0) return renderMarked(text, marks, offset);
  let html = "";
  let at = 0;
  for (const formula of formulas) {
    if (formula.from < at) continue;
    html += renderMarked(text.slice(at, formula.from), marks, offset + at);
    const source = text.slice(formula.from, formula.to);
    html += formula.whole
      ? renderFormula(source, false)
      : `<code class="cx-formula-source">${escapeText(source)}</code>`;
    at = formula.to;
  }
  return html + renderMarked(text.slice(at), marks, offset + at);
}

/** `text` with its marks other than formulas. */
function renderMarked(text: string, marks: Mark[], offset: number): string {
  if (!text) return "";
  const local = marks
    .filter((mark) => mark.type !== "formula")
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
          // Not draggable: a drag that starts on a link selects text, as the
          // selection bar («Hacer enmienda aquí») and the Mesa's select mode
          // need (Firefox reads the attribute, Chrome also main.css).
          piece = `<a href="${escapeHtml(mark.href.trim())}" rel="noopener noreferrer nofollow" target="_blank" draggable="false">${piece}</a>`;
        }
      } else if (type !== "formula") {
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
  /** Ordered lists: the number the next counted item shows. */
  next: number;
  /**
   * Ordered lists: the number the browser gives the next <li>. Every <li>
   * counts for it, a struck one too, so a counted item after one carries
   * `value` (as the PDF's counter skips struck items).
   */
  auto: number;
}

type RenderableBlock = Pick<
  Block,
  | "id"
  | "type"
  | "level"
  | "list"
  | "marker"
  | "start"
  | "cell"
  | "align"
  | "image"
> & {
  inner: string;
  attrs?: string;
  /** Extra class of the block element, e.g. "cx-block-inserted". */
  className?: string;
  /**
   * An ordered item that takes no number (deleted, in a diff): it shows no
   * marker and the items after it are not counted past it, as in the PDF
   * (orderedListNumbers' `counted`). One with `start` still starts its
   * list again, so the next item that counts shows that number.
   */
  uncounted?: boolean;
  /** Text is left out before it (FragmentBlock): «[…]» goes first. */
  gapBefore?: boolean;
};

/**
 * Where a fragment leaves text out: «[…]» on a line of its own, muted, and
 * said in words to screen readers when there is a label. It carries no
 * `data-block-id`, so it is no block to pick, count or page.
 */
function gapHtml(label: string | undefined): string {
  return label
    ? `<p class="cx-gap text-muted"><span aria-hidden="true">[…]</span><span class="sr-only">${escapeHtml(label)}</span></p>`
    : `<p class="cx-gap text-muted">[…]</p>`;
}

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
 * narrow screens. `gap` is the HTML of a gap (gapHtml): a table that opens
 * a run takes it before the table, any other block before itself.
 */
function wrapBlocks(
  items: RenderableBlock[],
  headings = true,
  gap = "",
): string {
  let html = "";
  for (const run of groupTables(items)) {
    if (run.kind === "blocks") {
      html += wrapFlow(run.items, headings, gap);
      continue;
    }
    const first = run.table.rows[0]?.cells[0]?.blocks[0];
    if (first?.gapBefore) html += gap;
    html += tableHtml(run.table, headings, gap, first);
  }
  return html;
}

function tableHtml(
  table: TableGroup<RenderableBlock>,
  headings: boolean,
  gap = "",
  /** The block whose gap went before the table. */
  opened?: RenderableBlock,
): string {
  // Its width and place (main.css reads them), escaped as any attribute.
  const layout = Object.entries(tableLayoutAttributes(tableLayoutOf(table)))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  // A table of one cell is a box (a signature's line), not data.
  const box =
    table.rows.length === 1 && table.rows[0]!.cells.length === 1
      ? ' role="presentation"'
      : "";
  // The colour of each side, as the cell that wins it says (gridSides), so
  // two cells that share it agree; by palette name only.
  const colours = new Map<string, string>();
  if (table.rows.some((row) => row.cells.some((c) => c.cell.borderColor))) {
    for (const [cell, sides] of gridSides(tableGrid(table))) {
      const style = CELL_SIDES.filter((side) => sides[side].colour)
        .map(
          (side) =>
            `border-${side}-color: var(--cx-fill-${sides[side].colour})`,
        )
        .join("; ");
      if (style) colours.set(cell.cell.cell, style);
    }
  }
  let html = `<div class="cx-table-wrap"><table class="cx-table"${layout}${box}><tbody>`;
  for (const row of table.rows) {
    html += "<tr>";
    for (const cell of row.cells) {
      const tag = cell.cell.header ? "th" : "td";
      // The fill by its name in the palette (main.css colours the class).
      const fill = cellFillOf(cell.cell);
      let attrs = fill ? ` class="cx-fill-${fill}"` : "";
      // Its sides, from a fixed set of names (main.css draws them).
      const borders = cellBorderTokens(cell.cell.borders);
      if (borders) attrs += ` data-cx-borders="${borders}"`;
      const colour = colours.get(cell.cell.cell);
      if (colour) attrs += ` style="${colour}"`;
      if (cell.cell.colspan)
        attrs += ` colspan="${Math.trunc(cell.cell.colspan)}"`;
      if (cell.cell.rowspan)
        attrs += ` rowspan="${Math.trunc(cell.cell.rowspan)}"`;
      html += `<${tag}${attrs}>${wrapFlow(cell.blocks, headings, gap, opened)}</${tag}>`;
    }
    html += "</tr>";
  }
  return `${html}</tbody></table></div>`;
}

/**
 * A stored image, by its asset id only (never a link given in the content);
 * its description and size escaped.
 */
function imageHtml(image: BlockImage | undefined): string {
  if (!image || !IMAGE_ASSET_PATTERN.test(image.asset)) return "";
  const width = Math.max(1, Math.trunc(image.width));
  const height = Math.max(1, Math.trunc(image.height));
  return `<img src="${IMAGE_URL_PREFIX}${image.asset}" alt="${escapeHtml(image.alt)}" width="${width}" height="${height}" loading="lazy" decoding="async">`;
}

/**
 * Blocks outside tables, or inside one cell: paragraphs, lists, headings.
 * A block with `gapBefore` (but `opened`, whose gap is already out) ends
 * the lists open and follows `gap`; its own `start` numbers it.
 */
function wrapFlow(
  items: RenderableBlock[],
  headings: boolean,
  gap = "",
  opened?: RenderableBlock,
): string {
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

  /** The opening of an item of `frame`, numbered as orderedListNumbers. */
  const itemTag = (item: RenderableBlock, frame: ListFrame): string => {
    if (frame.tag !== "ol") return `<li ${attrsOf(item)}>`;
    if (item.uncounted) {
      frame.auto += 1;
      return `<li ${attrsOf(item, "cx-uncounted")}>`;
    }
    const value = frame.auto === frame.next ? "" : ` value="${frame.next}"`;
    frame.auto = frame.next + 1;
    frame.next += 1;
    return `<li${value} ${attrsOf(item)}>`;
  };

  for (const item of items) {
    if (item.gapBefore && item !== opened && gap) {
      while (stack.length > 0) closeFrame();
      html += gap;
    }
    const attrs = attrsOf(item);
    if (item.type === "list_item") {
      const level = Math.max(0, Math.min(6, item.level ?? 0));
      const tag = item.list === "ordered" ? "ol" : "ul";
      const marker = tag === "ol" ? markerOf(item) : null;
      // A struck item with `start` starts its list again all the same: the
      // next counted item shows that number (`value`, see itemTag).
      const start =
        tag === "ol" && item.start !== undefined
          ? Math.trunc(item.start)
          : undefined;
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
        start === undefined
      ) {
        html += `</li>${itemTag(item, top)}${item.inner}`;
        continue;
      }
      if (top && top.level === level) closeFrame();
      // Opens a new list, nested inside the open item when deeper. Markers
      // other than "1." are drawn by the CSS for `data-marker`.
      let listAttrs = "";
      if (marker && marker !== "1.") {
        listAttrs += ` data-marker="${escapeHtml(marker)}"`;
      }
      if (start !== undefined) listAttrs += ` start="${start}"`;
      const frame: ListFrame = {
        tag,
        level,
        marker,
        next: start ?? 1,
        auto: start ?? 1,
      };
      html += `<${tag}${listAttrs}>${itemTag(item, frame)}${item.inner}`;
      stack.push(frame);
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
    } else if (item.type === "formula") {
      html += `<div ${attrsOf(item, "cx-formula-block")}>${item.inner}</div>`;
    } else if (item.type === "image") {
      // Its inner text is only the diff's hidden label, if any.
      const label = item.inner === "<br>" ? "" : item.inner;
      html += `<figure ${attrsOf(item, "cx-figure")}>${label}${imageHtml(item.image)}</figure>`;
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
      inner:
        block.type === "formula"
          ? renderFormula(block.text, true)
          : renderInline(
              block.text,
              block.type === "image"
                ? block.marks
                : withAutolinks(block.text, block.marks),
            ) || "<br>",
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
   * Visually hidden words that say what the «[…]» before a block with
   * `gapBefore` means (e.g. "Text left out"), in any mode.
   */
  omitted?: string;
  /**
   * Visually hidden words read before each insertion and removal in diff
   * mode (e.g. "Added:"), so the change is not told by colour alone.
   *
   * A change of formatting keeps its text, so words say it, in a note at
   * the end of its block: `formatted` opens it ("Cambia el formato:"),
   * `format` says each thing that changes ("deja de estar tachado"),
   * `quote` names the text it applies to ("«de»") and `space` names text
   * that is only blank.
   */
  diffLabels?: {
    inserted: string;
    removed: string;
    formatted?: string;
    format?: (change: FormatChange) => string;
    quote?: (text: string) => string;
    space?: string;
  };
}

/** The visible label of a formatting change: what changes, in words. */
function formatLabel(
  changes: FormatChange[],
  options: AnnotatedOptions,
): string {
  const describe = options.diffLabels?.format;
  if (!describe) return "";
  return changes
    .map((change) => describe(change))
    .filter(Boolean)
    .join(", ");
}

/** Longest text a format note quotes before cutting it with an ellipsis. */
const FORMAT_QUOTE_MAX = 40;

/** The text a format note names: "«de»", cut when long. */
function formatQuote(text: string, options: AnnotatedOptions): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const shown = flat
    ? flat.length > FORMAT_QUOTE_MAX
      ? `${flat.slice(0, FORMAT_QUOTE_MAX - 1).trimEnd()}…`
      : flat
    : (options.diffLabels?.space ?? " ");
  return options.diffLabels?.quote?.(shown) ?? `«${shown}»`;
}

/**
 * Whether a change of format inside a block is shown. One on blank text
 * alone (a space losing its strike) has nothing to show: it is told only
 * when it is the block's one change, and otherwise goes with the changes
 * around it (it is still applied).
 */
export function isShownFormatSegment(
  block: Pick<ConsolidatedBlock, "segments" | "format" | "status">,
  segment: Segment,
): boolean {
  if (!segment.format || !segment.source || segment.removed) return false;
  if (segment.text.trim() !== "") return true;
  if (block.status !== "kept" || block.format) return false;
  return !block.segments.some(
    (other) =>
      other !== segment &&
      other.source !== undefined &&
      other.source !== null &&
      (other.removed || !other.format || other.text.trim() !== ""),
  );
}

/** One item of a block's format note, linked to its amendment. */
function formatNotePart(
  source: string,
  words: string,
  options: AnnotatedOptions,
): string {
  const focused = options.focus === source ? " cx-focus" : "";
  return `<span class="cx-fmt-part${focused}" data-amendment-id="${escapeHtml(source)}">${escapeHtml(words)}</span>`;
}

function srOnly(label: string | undefined): string {
  return label ? `<span class="sr-only">${escapeHtml(label)} </span>` : "";
}

/** Longest text, blanks aside, that still counts as a tiny change. */
const TINY_CHANGE_MAX = 2;

/**
 * Whether an added or removed stretch is too small to see on its tint: a
 * comma, an accent, a space, "y". Diffs mark it apart (`cx-tiny`), so a
 * reader finds it in a long paragraph.
 */
export function isTinyChange(text: string): boolean {
  const visible = text.replace(/\s+/g, "");
  return (
    [...visible].length <= TINY_CHANGE_MAX || /^[\p{P}\p{S}]+$/u.test(visible)
  );
}

function segmentHtml(
  segment: Segment,
  inner: string,
  options: AnnotatedOptions,
  /** Collects the block's format note (diff mode). */
  notes?: string[],
  /** isShownFormatSegment: false leaves a blank format change unmarked. */
  shown = true,
  /** Inside a block added or removed whole, which its border shows. */
  wholeBlock = false,
): string {
  if (!segment.source) return inner;
  const id = escapeHtml(segment.source);
  const focused = options.focus === segment.source ? " cx-focus" : "";
  const tiny =
    options.mode === "diff" && !wholeBlock && isTinyChange(segment.text)
      ? " cx-tiny"
      : "";
  if (segment.removed) {
    return options.mode === "diff"
      ? `<del class="cx-del${tiny}${focused}" data-amendment-id="${id}">${srOnly(options.diffLabels?.removed)}${inner}</del>`
      : "";
  }
  if (segment.format && options.mode === "diff") {
    if (!shown) return inner;
    // Formatted anew, not added: the text shows its new format once, marked
    // apart from added and removed text, and the note at the end of the
    // block says in words what changes (the title says it on hover).
    const label = formatLabel(segment.format, options);
    if (label) {
      notes?.push(
        formatNotePart(
          segment.source,
          `${formatQuote(segment.text, options)} ${label}`,
          options,
        ),
      );
    }
    const title = label ? ` title="${escapeHtml(label)}"` : "";
    return `<span class="cx-fmt${focused}" data-amendment-id="${id}"${title}>${inner}</span>`;
  }
  if (options.mode === "diff") {
    return `<ins class="cx-ins${tiny}${focused}" data-amendment-id="${id}">${srOnly(options.diffLabels?.inserted)}${inner}</ins>`;
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
 * A formula block as annotated: drawn, unless a diff changes its source
 * inside it; then its source with the changes marked (`inner`, built from
 * the segments), and how it reads now drawn below.
 */
function formulaInner(
  block: ConsolidatedBlock,
  inner: string,
  options: AnnotatedOptions,
): string {
  const text = block.segments
    .filter((segment) => !segment.removed)
    .map((segment) => segment.text)
    .join("");
  const changed = block.segments.some((segment) => segment.source);
  if (options.mode !== "diff" || block.status !== "kept" || !changed) {
    return renderFormula(text, true);
  }
  // Drawn before and after, side by side (stacked when narrow), each said
  // to screen readers with the diff's own words; the source, its changes
  // marked, above them for whoever needs the detail.
  const before = block.segments
    .filter((segment) => !segment.source || segment.removed || segment.format)
    .map((segment) => segment.text)
    .join("");
  return (
    `<code class="cx-formula-source">${inner}</code>` +
    `<div class="cx-formula-compare">` +
    `<div class="cx-formula-before">${srOnly(options.diffLabels?.removed)}${renderFormula(before, true)}</div>` +
    `<div class="cx-formula-after">${srOnly(options.diffLabels?.inserted)}${renderFormula(text, true)}</div>` +
    `</div>`
  );
}

/**
 * The stretches of `now` (the block's text as it reads now) that the diff
 * and provenance modes wrap as an amended fragment: a click there picks its
 * amendment, and an interactive view makes it a button, so no bare address
 * is linked inside it (a link would take the click to another site and nest
 * a link in a button). Stored links keep theirs. The clean text marks none.
 */
function amendedRanges(
  block: ConsolidatedBlock,
  now: string,
  options: AnnotatedOptions,
): { from: number; to: number }[] {
  if (options.mode === "clean") return [];
  // Provenance wraps a block formatted anew whole (see renderAnnotated).
  if (options.mode === "provenance" && block.format && block.status === "kept")
    return [{ from: 0, to: now.length }];
  const ranges: { from: number; to: number }[] = [];
  let offset = 0;
  for (const segment of block.segments) {
    if (segment.removed) continue;
    const to = offset + segment.text.length;
    if (segment.source && to > offset) ranges.push({ from: offset, to });
    offset = to;
  }
  return ranges;
}

/**
 * Renders consolidated blocks in one of three modes:
 * - `diff`: insertions as <ins>, removals as <del> (styled by the diff mode),
 *   and formatting changes as their text in its new format, said in words in
 *   a note at the end of the block (`cx-fmt-label`);
 * - `provenance`: clean text with every amended fragment linked to its amendment;
 * - `clean`: the consolidated text alone.
 *
 * A fragment (previewAmendment) shows «[…]» where it leaves text out
 * (`gapBefore`), also when the block that carries it is not shown.
 */
export function renderAnnotated(
  blocks: FragmentBlock[],
  options: AnnotatedOptions,
): string {
  const items: RenderableBlock[] = [];
  let gapBefore = false;
  for (const block of blocks) {
    gapBefore ||= block.gapBefore === true;
    if (block.status === "deleted" && options.mode !== "diff") continue;

    let offset = 0;
    let inner = "";
    const notes: string[] = [];
    const wholeBlock = block.status !== "kept";
    // Bare addresses link over the text as it reads now (the marks' own
    // offsets); removed text and amended fragments are never linked
    // (amendedRanges). A formula's source is not text, and an image has none.
    const now = block.segments
      .filter((segment) => !segment.removed)
      .map((segment) => segment.text)
      .join("");
    const marks =
      block.type === "formula" || block.type === "image"
        ? block.marks
        : withAutolinks(now, block.marks, amendedRanges(block, now, options));
    // The clean text marks no segment apart, so it reads as one piece: a
    // link an amendment cut stays one link (one tab stop), as in
    // renderBlocks.
    if (options.mode === "clean") inner = renderInline(now, marks);
    for (const segment of options.mode === "clean" ? [] : block.segments) {
      if (segment.removed) {
        inner += segmentHtml(
          segment,
          escapeText(segment.text),
          options,
          undefined,
          true,
          wholeBlock,
        );
        continue;
      }
      const text = renderInline(segment.text, marks, offset);
      offset += segment.text.length;
      inner += segmentHtml(
        segment,
        text,
        options,
        notes,
        isShownFormatSegment(block, segment),
        wholeBlock,
      );
    }

    if (block.type === "formula") {
      inner = formulaInner(block, inner, options);
    }

    let attrs = "";
    let className: string | undefined;
    if (block.status !== "kept" && block.source) {
      attrs = ` data-amendment-id="${escapeHtml(block.source)}"`;
      className = `cx-block-${block.status}`;
      // An image has no text to say it was added or removed: its figure
      // says it to screen readers (the border shows it).
      if (block.type === "image" && options.mode === "diff") {
        inner = srOnly(
          block.status === "inserted"
            ? options.diffLabels?.inserted
            : options.diffLabels?.removed,
        );
      }
    }
    if (block.format && block.status === "kept") {
      // The block already shows its new format: say what it was changed to.
      const id = escapeHtml(block.format.source);
      const focused = options.focus === block.format.source ? " cx-focus" : "";
      if (options.mode === "diff") {
        const label = formatLabel(block.format.changes, options);
        if (label) {
          notes.unshift(formatNotePart(block.format.source, label, options));
        }
      } else if (options.mode === "provenance") {
        const label = options.label?.(block.format.source);
        const sup = label
          ? `<sup class="cx-ref" aria-hidden="true">${escapeHtml(label)}</sup>`
          : "";
        inner = `<span class="cx-prov${focused}" data-amendment-id="${id}">${inner}</span>${sup}`;
      }
    }
    // What changes of format, in words, below the block's text.
    if (notes.length > 0) {
      const opening = options.diffLabels?.formatted;
      inner = `${inner || "<br>"}<span class="cx-fmt-label">${opening ? `${escapeHtml(opening)} ` : ""}${notes.join("; ")}</span>`;
    }
    items.push({
      ...block,
      inner: inner || "<br>",
      attrs,
      className,
      // Shown struck, it takes no number (only diff mode shows it).
      uncounted: block.status === "deleted",
      // Nothing shown before it, nothing left out between.
      gapBefore: gapBefore && items.length > 0,
    });
    gapBefore = false;
  }
  return wrapBlocks(items, options.headings, gapHtml(options.omitted));
}

/** How long a heading may be in a block's label before it is shortened. */
const LABEL_HEADING_MAX = 80;

/**
 * A heading as a block's label names it: whitespace collapsed and, past
 * LABEL_HEADING_MAX characters, cut at the last word that fits (at the limit
 * when no space falls in its second half) and closed with «…», so a cut
 * never reads as the whole heading.
 */
export function labelHeading(text: string): string | null {
  const heading = text.trim().replace(/\s+/g, " ");
  if (!heading) return null;
  if (heading.length <= LABEL_HEADING_MAX) return heading;
  const head = heading.slice(0, LABEL_HEADING_MAX);
  // One character more: a space right after the limit ends a whole word.
  const space = heading.slice(0, LABEL_HEADING_MAX + 1).lastIndexOf(" ");
  const cut = space >= LABEL_HEADING_MAX / 2 ? heading.slice(0, space) : head;
  return `${cut.replace(/[\s.,;:·–-]+$/u, "")}…`;
}

/**
 * Human references for blocks: the nearest preceding heading and the
 * paragraph's ordinal under it, e.g. { heading: "3. Devolución", paragraph: 2 }.
 * A long heading is shortened with «…» (labelHeading).
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
      heading = labelHeading(block.text);
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
