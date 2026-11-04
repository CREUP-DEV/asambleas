import type {
  Block,
  ConsolidatedBlock,
  Mark,
  MarkType,
  Segment,
} from "../../types/content";

/**
 * HTML rendering of structured content. Text is always escaped and links are
 * restricted to safe schemes, so the output is safe for v-html by
 * construction: no stored HTML is ever echoed back.
 */

const MARK_ORDER: MarkType[] = ["link", "bold", "italic", "underline", "strike"];
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
}

type RenderableBlock = Pick<Block, "id" | "type" | "level" | "list"> & {
  inner: string;
  attrs?: string;
};

function wrapBlocks(items: RenderableBlock[]): string {
  let html = "";
  const stack: ListFrame[] = [];
  const closeFrame = () => {
    html += `</li></${stack.pop()!.tag}>`;
  };

  for (const item of items) {
    const attrs = `data-block-id="${escapeHtml(item.id)}"${item.attrs ?? ""}`;
    if (item.type === "list_item") {
      const level = Math.max(0, Math.min(6, item.level ?? 0));
      const tag = item.list === "ordered" ? "ol" : "ul";
      while (stack.length > 0 && stack[stack.length - 1]!.level > level) {
        closeFrame();
      }
      const top = stack[stack.length - 1];
      if (top && top.level === level && top.tag === tag) {
        html += `</li><li ${attrs}>${item.inner}`;
        continue;
      }
      if (top && top.level === level) closeFrame();
      // Opens a new list, nested inside the open item when deeper.
      html += `<${tag}><li ${attrs}>${item.inner}`;
      stack.push({ tag, level });
      continue;
    }
    while (stack.length > 0) closeFrame();
    if (item.type === "heading") {
      const level = Math.max(2, Math.min(4, (item.level ?? 1) + 1));
      html += `<h${level} ${attrs}>${item.inner}</h${level}>`;
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
export function renderBlocks(blocks: Block[]): string {
  return wrapBlocks(
    blocks.map((block) => ({
      ...block,
      inner: renderInline(block.text, block.marks) || "<br>",
    })),
  );
}

export type AnnotatedMode = "diff" | "provenance" | "clean";

export interface AnnotatedOptions {
  mode: AnnotatedMode;
  /** Short label shown next to provenance, e.g. "12" or "T1". */
  label?: (amendmentId: string) => string;
  /** Highlights the segments of one amendment. */
  focus?: string | null;
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
      ? `<del class="cx-del${focused}" data-amendment-id="${id}">${inner}</del>`
      : "";
  }
  if (options.mode === "diff") {
    return `<ins class="cx-ins${focused}" data-amendment-id="${id}">${inner}</ins>`;
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
    if (block.status !== "kept" && block.source) {
      attrs = ` data-amendment-id="${escapeHtml(block.source)}" class="cx-block-${block.status}"`;
    }
    items.push({ ...block, inner: inner || "<br>", attrs });
  }
  return wrapBlocks(items);
}

/**
 * Human references for blocks: the nearest preceding heading and the
 * paragraph's ordinal under it, e.g. { heading: "3. Devolución", paragraph: 2 }.
 */
export function blockLabels(
  blocks: Block[],
): Map<string, { heading: string | null; paragraph: number }> {
  const labels = new Map<string, { heading: string | null; paragraph: number }>();
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
