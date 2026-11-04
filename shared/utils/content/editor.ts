import type { Block, Mark, MarkType } from "../../types/content";
import { MARK_TYPES } from "../../types/content";

/**
 * Conversion between blocks and the ProseMirror JSON used by the TipTap
 * editor (Nuxt UI UEditor). Paragraphs and headings carry a `blockId`
 * attribute so block ids survive editing.
 */

export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

interface Inline {
  text: string;
  marks: Mark[];
}

function readInline(nodes: EditorNode[] | undefined): Inline {
  let text = "";
  const marks: Mark[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      text += "\n";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const from = text.length;
    text += node.text;
    for (const mark of node.marks ?? []) {
      if (!(MARK_TYPES as readonly string[]).includes(mark.type)) continue;
      const entry: Mark = {
        type: mark.type as MarkType,
        from,
        to: text.length,
      };
      if (mark.type === "link" && typeof mark.attrs?.href === "string") {
        entry.href = mark.attrs.href;
      }
      const previous = marks.find(
        (m) => m.type === entry.type && m.to === from && m.href === entry.href,
      );
      if (previous) previous.to = entry.to;
      else marks.push(entry);
    }
  }
  return { text, marks };
}

export function editorToBlocks(doc: EditorNode, newId: () => string): Block[] {
  const blocks: Block[] = [];
  const used = new Set<string>();
  const idFor = (node: EditorNode) => {
    const candidate = node.attrs?.blockId;
    if (typeof candidate === "string" && candidate && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    const fresh = newId();
    used.add(fresh);
    return fresh;
  };

  const walk = (
    nodes: EditorNode[] | undefined,
    context: { list?: "bullet" | "ordered"; level: number; quote: boolean },
  ) => {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "paragraph": {
          const inline = readInline(node.content);
          const block: Block = {
            id: idFor(node),
            type: context.list
              ? "list_item"
              : context.quote
                ? "quote"
                : "paragraph",
            ...inline,
          };
          if (context.list) {
            block.level = context.level;
            block.list = context.list;
          }
          blocks.push(block);
          break;
        }
        case "heading": {
          const level = Number(node.attrs?.level ?? 1);
          blocks.push({
            id: idFor(node),
            type: "heading",
            level: Math.max(1, Math.min(4, level)),
            ...readInline(node.content),
          });
          break;
        }
        case "bulletList":
        case "orderedList": {
          const list = node.type === "orderedList" ? "ordered" : "bullet";
          const level = context.list ? context.level + 1 : 0;
          for (const item of node.content ?? []) {
            walk(item.content, { list, level, quote: context.quote });
          }
          break;
        }
        case "blockquote":
          walk(node.content, { ...context, quote: true });
          break;
        default:
          walk(node.content, context);
      }
    }
  };

  walk(doc.content, { level: 0, quote: false });
  return blocks;
}

function inlineNodes(block: Pick<Block, "text" | "marks">): EditorNode[] {
  if (!block.text) return [];
  const cuts = new Set<number>([0, block.text.length]);
  for (const mark of block.marks) {
    cuts.add(mark.from);
    cuts.add(mark.to);
  }
  for (let i = 0; i < block.text.length; i += 1) {
    if (block.text[i] === "\n") {
      cuts.add(i);
      cuts.add(i + 1);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const nodes: EditorNode[] = [];
  for (let k = 0; k < points.length - 1; k += 1) {
    const from = points[k]!;
    const to = points[k + 1]!;
    const text = block.text.slice(from, to);
    if (text === "\n") {
      nodes.push({ type: "hardBreak" });
      continue;
    }
    const marks = block.marks
      .filter((mark) => mark.from <= from && mark.to >= to)
      .map((mark) =>
        mark.type === "link"
          ? { type: "link", attrs: { href: mark.href } }
          : { type: mark.type },
      );
    nodes.push(
      marks.length ? { type: "text", text, marks } : { type: "text", text },
    );
  }
  return nodes;
}

function paragraph(block: Block): EditorNode {
  const content = inlineNodes(block);
  return {
    type: "paragraph",
    attrs: { blockId: block.id },
    ...(content.length ? { content } : {}),
  };
}

/** Builds nested lists from a run of list items starting at `start`. */
function buildList(
  blocks: Block[],
  start: number,
  level: number,
): [EditorNode, number] {
  const list = blocks[start]!.list ?? "bullet";
  const node: EditorNode = {
    type: list === "ordered" ? "orderedList" : "bulletList",
    content: [],
  };
  let i = start;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.type !== "list_item") break;
    const blockLevel = block.level ?? 0;
    if (blockLevel < level) break;
    if (blockLevel === level && (block.list ?? "bullet") !== list) break;
    const last = node.content![node.content!.length - 1];
    if (blockLevel > level && last) {
      const [nested, next] = buildList(blocks, i, blockLevel);
      last.content!.push(nested);
      i = next;
      continue;
    }
    // A list cannot start deeper than its first item; such items stay at
    // this level.
    node.content!.push({ type: "listItem", content: [paragraph(block)] });
    i += 1;
  }
  return [node, i];
}

export function blocksToEditor(blocks: Block[]): EditorNode {
  const content: EditorNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.type === "list_item") {
      const [list, next] = buildList(blocks, i, block.level ?? 0);
      content.push(list);
      i = next;
      continue;
    }
    if (block.type === "heading") {
      const inline = inlineNodes(block);
      content.push({
        type: "heading",
        attrs: { level: block.level ?? 1, blockId: block.id },
        ...(inline.length ? { content: inline } : {}),
      });
    } else if (block.type === "quote") {
      const quote: EditorNode = { type: "blockquote", content: [] };
      while (i < blocks.length && blocks[i]!.type === "quote") {
        quote.content!.push(paragraph(blocks[i]!));
        i += 1;
      }
      content.push(quote);
      continue;
    } else {
      content.push(paragraph(block));
    }
    i += 1;
  }
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

/**
 * Converts sanitized HTML (DOCX import, pasted content) to blocks. Works with
 * any DOM implementation: DOMParser in the browser, linkedom on the server.
 */
export function htmlElementToBlocks(
  root: Element,
  newId: () => string,
): Block[] {
  const blocks: Block[] = [];

  const readElementInline = (
    element: Element,
  ): { text: string; marks: Mark[] } => {
    let text = "";
    const marks: Mark[] = [];
    const visit = (node: Node, active: Mark[]) => {
      if (node.nodeType === 3) {
        const value = (node.textContent ?? "").replace(/\s+/g, " ");
        const from = text.length;
        text += value;
        for (const mark of active)
          marks.push({ ...mark, from, to: text.length });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        text += "\n";
        return;
      }
      const next = [...active];
      if (tag === "strong" || tag === "b")
        next.push({ type: "bold", from: 0, to: 0 });
      if (tag === "em" || tag === "i")
        next.push({ type: "italic", from: 0, to: 0 });
      if (tag === "u") next.push({ type: "underline", from: 0, to: 0 });
      if (tag === "s" || tag === "del" || tag === "strike")
        next.push({ type: "strike", from: 0, to: 0 });
      if (tag === "a" && el.getAttribute("href")) {
        next.push({
          type: "link",
          from: 0,
          to: 0,
          href: el.getAttribute("href")!,
        });
      }
      el.childNodes.forEach((child) => visit(child, next));
    };
    element.childNodes.forEach((child) => visit(child, []));
    const trimmedStart = text.length - text.trimStart().length;
    const trimmed = text.trim();
    return {
      text: trimmed,
      marks: marks
        .map((mark) => ({
          ...mark,
          from: Math.max(0, mark.from - trimmedStart),
          to: Math.min(trimmed.length, mark.to - trimmedStart),
        }))
        .filter((mark) => mark.from < mark.to),
    };
  };

  const walk = (
    element: Element,
    list: { type: "bullet" | "ordered"; level: number } | null,
    quote: boolean,
  ) => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const inline = readElementInline(child);
        if (inline.text) {
          blocks.push({
            id: newId(),
            type: "heading",
            level: Math.min(4, Number(tag[1])),
            ...inline,
          });
        }
      } else if (tag === "p" || tag === "div") {
        if (
          child.querySelector("p, ul, ol, h1, h2, h3, h4, h5, h6, blockquote")
        ) {
          walk(child, list, quote);
          continue;
        }
        const inline = readElementInline(child);
        if (!inline.text) continue;
        blocks.push(
          list
            ? {
                id: newId(),
                type: "list_item",
                level: list.level,
                list: list.type,
                ...inline,
              }
            : { id: newId(), type: quote ? "quote" : "paragraph", ...inline },
        );
      } else if (tag === "ul" || tag === "ol") {
        const type = tag === "ol" ? "ordered" : "bullet";
        const level = list ? list.level + 1 : 0;
        for (const item of Array.from(child.children)) {
          if (item.tagName.toLowerCase() !== "li") continue;
          const nested = Array.from(item.children).filter((c) =>
            ["ul", "ol", "p"].includes(c.tagName.toLowerCase()),
          );
          if (nested.some((c) => c.tagName.toLowerCase() === "p")) {
            walk(item, { type, level }, quote);
            continue;
          }
          const clone = item.cloneNode(true) as Element;
          clone.querySelectorAll("ul, ol").forEach((sub) => sub.remove());
          const inline = readElementInline(clone);
          if (inline.text) {
            blocks.push({
              id: newId(),
              type: "list_item",
              level,
              list: type,
              ...inline,
            });
          }
          for (const sub of nested)
            walk(
              sub.parentElement === item ? wrap(sub) : sub,
              { type, level },
              quote,
            );
        }
      } else if (tag === "blockquote") {
        walk(child, list, true);
      } else if (tag === "table") {
        for (const row of Array.from(child.querySelectorAll("tr"))) {
          const text = Array.from(row.querySelectorAll("td, th"))
            .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" | ");
          if (text)
            blocks.push({ id: newId(), type: "paragraph", text, marks: [] });
        }
      } else {
        walk(child, list, quote);
      }
    }
  };

  // A nested list inside <li> is walked through a synthetic parent so the
  // list branch above handles it uniformly.
  const wrap = (element: Element): Element => {
    const holder = element.ownerDocument.createElement("div");
    holder.appendChild(element.cloneNode(true));
    return holder;
  };

  walk(root, null, false);
  return blocks;
}
