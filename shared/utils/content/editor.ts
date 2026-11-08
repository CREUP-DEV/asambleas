import type {
  Block,
  BlockCell,
  ListMarker,
  Mark,
  MarkType,
} from "../../types/content";
import { MARK_TYPES } from "../../types/content";
import {
  formatListNumber,
  isBlockAlign,
  isListMarker,
  markerOf,
} from "./lists";
import { groupTables, type TableGroup } from "./tables";

/**
 * Conversion between blocks and the ProseMirror JSON used by the TipTap
 * editor (Nuxt UI UEditor). Paragraphs and headings carry a `blockId`
 * attribute so block ids survive editing. An ordered list carries its
 * marker (`marker`, see ListMarkerExtension) and its first number (`start`),
 * which become `marker` on its items and `start` on its first one.
 */

/**
 * The number an ordered list starts at, still to be written on its first
 * item. Shared by the items of one list, so only the first takes it.
 */
interface PendingStart {
  value: number | null;
}

interface WalkContext {
  list?: "bullet" | "ordered";
  level: number;
  quote: boolean;
  marker?: ListMarker;
  start?: PendingStart;
  /** Inside a table: the cell the blocks go into. */
  cell?: BlockCell;
}

/** The TipTap nodes of a table cell. */
const CELL_NODES = new Set(["tableCell", "tableHeader"]);

/** A block's alignment as the DOCX import marks it (`data-align`). */
function alignFrom(element: Element): Pick<Block, "align"> {
  const value = element.getAttribute("data-align");
  return isBlockAlign(value) ? { align: value } : {};
}

/** Whether bold covers the whole of a block's text, spaces aside. */
function isAllBold(block: Block): boolean {
  if (!block.text.trim()) return false;
  const bold = new Array<boolean>(block.text.length).fill(false);
  for (const mark of block.marks) {
    if (mark.type !== "bold") continue;
    for (let i = mark.from; i < mark.to; i += 1) bold[i] = true;
  }
  return Array.from(block.text).every(
    (char, i) => bold[i] || char.trim() === "",
  );
}

/** A span attribute (colspan, rowspan) worth keeping: 2 to 100. */
function span(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 100) : undefined;
}

/** Writes an ordered list's marker, and its start on its first item. */
function placeInList(
  block: Block,
  context: Pick<WalkContext, "list" | "level" | "marker" | "start">,
): void {
  block.level = context.level;
  block.list = context.list;
  if (context.list !== "ordered") return;
  if (context.marker && context.marker !== "1.") block.marker = context.marker;
  if (context.start && context.start.value !== null) {
    block.start = context.start.value;
    context.start.value = null;
  }
}

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

  // Table, row and cell ids, kept unique: splitting a cell copies its id.
  const usedTableIds = new Set<string>();
  const tableIdFor = (node: EditorNode, attr: string) => {
    const candidate = node.attrs?.[attr];
    if (
      typeof candidate === "string" &&
      candidate &&
      !usedTableIds.has(candidate)
    ) {
      usedTableIds.add(candidate);
      return candidate;
    }
    const fresh = newId();
    usedTableIds.add(fresh);
    return fresh;
  };

  /** A blank cell's paragraph, so the cell keeps its place. */
  const blankCell = (cell: BlockCell): Block => ({
    id: newId(),
    type: "paragraph",
    text: "",
    marks: [],
    cell: { ...cell },
  });

  const walkTable = (node: EditorNode, context: WalkContext) => {
    // A table inside a cell joins that cell: blocks hold one cell only.
    if (context.cell) {
      for (const row of node.content ?? []) {
        for (const cell of row.content ?? []) walk(cell.content, context);
      }
      return;
    }
    const table = tableIdFor(node, "tableId");
    for (const rowNode of node.content ?? []) {
      if (rowNode.type !== "tableRow") continue;
      const row = tableIdFor(rowNode, "rowId");
      for (const cellNode of rowNode.content ?? []) {
        if (!CELL_NODES.has(cellNode.type)) continue;
        const cell: BlockCell = {
          table,
          row,
          cell: tableIdFor(cellNode, "cellId"),
        };
        if (cellNode.type === "tableHeader") cell.header = true;
        else if (cellNode.attrs?.shade === true) cell.shade = true;
        const colspan = span(cellNode.attrs?.colspan);
        const rowspan = span(cellNode.attrs?.rowspan);
        if (colspan) cell.colspan = colspan;
        if (rowspan) cell.rowspan = rowspan;
        const before = blocks.length;
        walk(cellNode.content, { level: 0, quote: false, cell });
        if (blocks.length === before) blocks.push(blankCell(cell));
      }
    }
  };

  const inCell = (block: Block, context: WalkContext): Block => {
    if (context.cell) block.cell = { ...context.cell };
    return block;
  };

  const walk = (nodes: EditorNode[] | undefined, context: WalkContext) => {
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
            ...alignOf(node),
          };
          if (context.list) placeInList(block, context);
          blocks.push(inCell(block, context));
          break;
        }
        case "heading": {
          const level = Number(node.attrs?.level ?? 1);
          blocks.push(
            inCell(
              {
                id: idFor(node),
                type: "heading",
                level: Math.max(1, Math.min(4, level)),
                ...readInline(node.content),
                ...alignOf(node),
              },
              context,
            ),
          );
          break;
        }
        case "bulletList":
        case "orderedList": {
          const list = node.type === "orderedList" ? "ordered" : "bullet";
          const level = context.list ? context.level + 1 : 0;
          const inner: WalkContext = {
            list,
            level,
            quote: context.quote,
            cell: context.cell,
          };
          if (list === "ordered") {
            const marker = node.attrs?.marker;
            if (isListMarker(marker)) inner.marker = marker;
            const value = Number(node.attrs?.start ?? 1);
            const start =
              Number.isSafeInteger(value) && value >= 0 && value <= 99_999
                ? value
                : 1;
            // Right after a list it would join, a list starting at 1 keeps
            // that start too, or the two would read as one.
            const previous = blocks[blocks.length - 1];
            const joins =
              previous?.type === "list_item" &&
              previous.list === "ordered" &&
              (previous.level ?? 0) === level &&
              markerOf(previous) === (inner.marker ?? "1.");
            if (start !== 1 || joins) inner.start = { value: start };
          }
          for (const item of node.content ?? []) walk(item.content, inner);
          break;
        }
        case "blockquote":
          walk(node.content, { ...context, quote: true });
          break;
        case "table":
          walkTable(node, context);
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

/** TipTap's `textAlign` for a block's alignment (TextAlign extension). */
function alignAttrs(block: Pick<Block, "align">): { textAlign?: string } {
  return block.align ? { textAlign: block.align } : {};
}

/** A block's alignment from a node's `textAlign`, when it is one blocks keep. */
function alignOf(node: EditorNode): Pick<Block, "align"> {
  const value = node.attrs?.textAlign;
  return isBlockAlign(value) ? { align: value } : {};
}

function paragraph(block: Block): EditorNode {
  const content = inlineNodes(block);
  return {
    type: "paragraph",
    attrs: { blockId: block.id, ...alignAttrs(block) },
    ...(content.length ? { content } : {}),
  };
}

/**
 * Builds nested lists from a run of list items starting at `start`. A list
 * ends where its level changes kind or marker, or an item starts again.
 */
function buildList(
  blocks: Block[],
  start: number,
  level: number,
): [EditorNode, number] {
  const first = blocks[start]!;
  const list = first.list ?? "bullet";
  const marker = markerOf(first);
  const node: EditorNode = {
    type: list === "ordered" ? "orderedList" : "bulletList",
    content: [],
  };
  if (list === "ordered") {
    node.attrs = {
      start: first.start ?? 1,
      ...(marker !== "1." ? { marker } : {}),
    };
  }
  let i = start;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.type !== "list_item") break;
    const blockLevel = block.level ?? 0;
    if (blockLevel < level) break;
    if (
      blockLevel === level &&
      i !== start &&
      ((block.list ?? "bullet") !== list ||
        (list === "ordered" &&
          (markerOf(block) !== marker || block.start !== undefined)))
    ) {
      break;
    }
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
  for (const run of groupTables(blocks)) {
    if (run.kind === "blocks") content.push(...flowNodes(run.items));
    else content.push(tableNode(run.table));
  }
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

/** A table, its rows and cells keeping their ids (TableIdsExtension). */
function tableNode(table: TableGroup<Block>): EditorNode {
  return {
    type: "table",
    attrs: { tableId: table.table },
    content: table.rows.map((row) => ({
      type: "tableRow",
      attrs: { rowId: row.row },
      content: row.cells.map((cell) => {
        const content = flowNodes(cell.blocks);
        return {
          type: cell.cell.header ? "tableHeader" : "tableCell",
          attrs: {
            cellId: cell.cell.cell,
            shade: !cell.cell.header && cell.cell.shade === true,
            colspan: cell.cell.colspan ?? 1,
            rowspan: cell.cell.rowspan ?? 1,
            colwidth: null,
          },
          content: content.length ? content : [{ type: "paragraph" }],
        };
      }),
    })),
  };
}

/** Blocks outside tables, or inside one cell. */
function flowNodes(blocks: Block[]): EditorNode[] {
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
        attrs: {
          level: block.level ?? 1,
          blockId: block.id,
          ...alignAttrs(block),
        },
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
  return content;
}

export interface HtmlToBlocksOptions {
  /**
   * Called for each table read as rows of text: one nested in a table cell,
   * which loses its layout.
   */
  onTableFlattened?: () => void;
  /** Ids for tables, rows and cells; `newId` when absent. */
  newTableId?: () => string;
}

/** Elements that end a line of table cell text; anything else is inline. */
const CELL_BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

const tagOf = (node: Node): string =>
  node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";

const childElements = (element: Element, tags: readonly string[]): Element[] =>
  Array.from(element.children).filter((child) => tags.includes(tagOf(child)));

/** The rows of a table, outside or inside thead, tbody and tfoot. */
function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = tagOf(child);
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      rows.push(...childElements(child, ["tr"]));
    }
  }
  return rows;
}

const rowCells = (row: Element): Element[] => childElements(row, ["td", "th"]);

function joinInlines(parts: Inline[], separator: string): Inline {
  let text = "";
  const marks: Mark[] = [];
  for (const part of parts) {
    if (text) text += separator;
    const offset = text.length;
    text += part.text;
    for (const mark of part.marks) {
      marks.push({ ...mark, from: mark.from + offset, to: mark.to + offset });
    }
  }
  return { text, marks };
}

function prefixInline(prefix: string, inline: Inline): Inline {
  return {
    text: prefix + inline.text,
    marks: inline.marks.map((mark) => ({
      ...mark,
      from: mark.from + prefix.length,
      to: mark.to + prefix.length,
    })),
  };
}

/**
 * Converts sanitized HTML (DOCX import, pasted content) to blocks. Works with
 * any DOM implementation: DOMParser in the browser, linkedom on the server.
 *
 * A table whose rows all have one cell is a box around content (a
 * signature, a framed note): its cells are read as if the table were not
 * there. Any other table becomes blocks marked with their cells (BlockCell),
 * header cells and spans included. A table nested in a cell becomes a
 * paragraph per row, its cells joined by " | " and the lines inside a cell
 * by line breaks, keeping their formatting and links. Each node is read
 * once.
 */
export function htmlElementToBlocks(
  root: Element,
  newId: () => string,
  options: HtmlToBlocksOptions = {},
): Block[] {
  const blocks: Block[] = [];
  const newTableId = options.newTableId ?? newId;
  // Walking a table cell, where a nested table becomes rows of text.
  let inCell = false;

  const readElementInline = (element: Element): Inline =>
    readInlineNodes(Array.from(element.childNodes));

  const readInlineNodes = (nodes: Node[]): Inline => {
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
    for (const node of nodes) visit(node, []);
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

  /** An ordered item's marker and number, as the DOCX import marks them. */
  const itemNumbering = (
    item: Element,
    type: "bullet" | "ordered",
  ): { marker?: ListMarker; start?: PendingStart } => {
    if (type !== "ordered") return {};
    const marker = item.getAttribute("data-marker");
    const start = item.getAttribute("data-start");
    return {
      ...(isListMarker(marker) ? { marker } : {}),
      ...(start !== null && /^\d{1,5}$/.test(start)
        ? { start: { value: Number(start) } }
        : {}),
    };
  };

  const walk = (
    element: Element,
    list: {
      type: "bullet" | "ordered";
      level: number;
      marker?: ListMarker;
      start?: PendingStart;
    } | null,
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
            ...alignFrom(child),
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
        if (list) {
          const block: Block = {
            id: newId(),
            type: "list_item",
            ...inline,
            ...alignFrom(child),
          };
          placeInList(block, { ...list, list: list.type });
          blocks.push(block);
        } else {
          blocks.push({
            id: newId(),
            type: quote ? "quote" : "paragraph",
            ...inline,
            ...alignFrom(child),
          });
        }
      } else if (tag === "ul" || tag === "ol") {
        const type = tag === "ol" ? "ordered" : "bullet";
        const level = list ? list.level + 1 : 0;
        for (const item of Array.from(child.children)) {
          if (item.tagName.toLowerCase() !== "li") continue;
          const nested = Array.from(item.children).filter((c) =>
            ["ul", "ol", "p"].includes(c.tagName.toLowerCase()),
          );
          const numbering = itemNumbering(item, type);
          if (nested.some((c) => c.tagName.toLowerCase() === "p")) {
            walk(item, { type, level, ...numbering }, quote);
            continue;
          }
          const clone = item.cloneNode(true) as Element;
          clone.querySelectorAll("ul, ol").forEach((sub) => sub.remove());
          const inline = readElementInline(clone);
          if (inline.text) {
            const block: Block = {
              id: newId(),
              type: "list_item",
              ...inline,
              ...alignFrom(item),
            };
            placeInList(block, { level, list: type, ...numbering });
            blocks.push(block);
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
        const rows = tableRows(child);
        if (rows.every((row) => rowCells(row).length <= 1)) {
          for (const row of rows) {
            for (const cell of rowCells(row)) walk(cell, list, quote);
          }
          continue;
        }
        // Blocks hold one cell only: a table in a cell becomes its rows.
        if (inCell) {
          options.onTableFlattened?.();
          for (const row of rows) {
            const inline = readRow(row);
            if (inline.text) {
              blocks.push({ id: newId(), type: "paragraph", ...inline });
            }
          }
          continue;
        }
        readTable(rows);
      } else {
        walk(child, list, quote);
      }
    }
  };

  /**
   * A table: every cell's content walked like the text around it, its blocks
   * marked with the cell (BlockCell), and a blank cell kept as an empty
   * paragraph.
   */
  const readTable = (rows: Element[]): void => {
    const table = newTableId();
    for (const rowElement of rows) {
      const row = newTableId();
      for (const cellElement of rowCells(rowElement)) {
        const cell: BlockCell = { table, row, cell: newTableId() };
        if (cellElement.tagName.toLowerCase() === "th") cell.header = true;
        const colspan = span(cellElement.getAttribute("colspan"));
        const rowspan = span(cellElement.getAttribute("rowspan"));
        if (colspan) cell.colspan = colspan;
        if (rowspan) cell.rowspan = rowspan;
        const before = blocks.length;
        inCell = true;
        try {
          walk(cellElement, null, false);
        } finally {
          inCell = false;
        }
        const own = blocks.slice(before);
        // Templates mark header cells by look, not as headers: by a dark
        // fill, as the DOCX import says (`data-header`), or else a cell all
        // in bold reads as one (Word's own header rows already are).
        const marked = cellElement.getAttribute("data-header");
        if (marked === "true") cell.header = true;
        else if (marked !== "false" && own.length > 0 && own.every(isAllBold)) {
          cell.header = true;
        }
        // A light fill, as the DOCX import says (`data-shade`).
        if (!cell.header && cellElement.getAttribute("data-shade") === "true") {
          cell.shade = true;
        }
        for (const block of own) block.cell = { ...cell };
        if (blocks.length === before) {
          blocks.push({
            id: newId(),
            type: "paragraph",
            text: "",
            marks: [],
            cell,
          });
        }
      }
    }
  };

  /** A table row as one line: its cells joined by " | ". */
  const readRow = (row: Element): Inline =>
    joinInlines(
      rowCells(row)
        .map((cell) => {
          const lines: Inline[] = [];
          readCellLines(cell, lines);
          return joinInlines(lines, "\n");
        })
        .filter((cell) => cell.text),
      " | ",
    );

  /**
   * The lines of text in a table cell: one per paragraph, heading, list item
   * ("• " or its number first) and row of a nested table.
   */
  const readCellLines = (element: Element, lines: Inline[]): void => {
    let pending: Node[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const inline = readInlineNodes(pending);
      if (inline.text) lines.push(inline);
      pending = [];
    };
    for (const node of Array.from(element.childNodes)) {
      const tag = tagOf(node);
      if (!CELL_BLOCK_TAGS.has(tag)) {
        pending.push(node);
        continue;
      }
      flush();
      const child = node as Element;
      if (tag === "table") {
        for (const row of tableRows(child)) {
          const inline = readRow(row);
          if (inline.text) lines.push(inline);
        }
      } else if (tag === "ul" || tag === "ol") {
        let n = 0;
        childElements(child, ["li"]).forEach((item) => {
          const numbering = itemNumbering(item, "ordered");
          n = numbering.start?.value ?? n + 1;
          const itemLines: Inline[] = [];
          readCellLines(item, itemLines);
          if (itemLines.length === 0) return;
          itemLines[0] = prefixInline(
            tag === "ol"
              ? `${formatListNumber(n, numbering.marker ?? "1.")} `
              : "• ",
            itemLines[0]!,
          );
          lines.push(...itemLines);
        });
      } else {
        readCellLines(child, lines);
      }
    }
    flush();
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
