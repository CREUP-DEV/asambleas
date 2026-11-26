/**
 * Adjustments to the HTML mammoth returns, made on the parsed document before
 * htmlElementToBlocks walks it. Each is one pass over a selector. They add
 * no marks and no nesting that inspectHtml did not count: they remove nodes,
 * unwrap underlines of links, replace a superscript with a letter, move a
 * note's content into a <div> and write its "[1]" before it, and move the
 * cells of tables laid side by side into new <table> and <tr> elements at
 * the same depth (one table more per part, one row more per row and part;
 * every new row holds a cell inspectHtml counted). Word equations, which
 * the converter hands over as markers, become one <code data-formula> each,
 * or a <div data-formula> for one alone in its paragraph (formulas).
 */

import { nearestCellFill } from "../../../shared/constants/cellFills";
import { ommlToLatex, parseOmmlTree } from "./omml";
import {
  formatCellBorders,
  gridEdges,
  tableGrid,
  type CellEdge,
  type GridCell,
  type TableGroup,
} from "../../../shared/utils/content/tables";
import {
  CELL_SIDES,
  TABLE_MIN_WIDTH,
  type CellBorders,
  type CellSide,
} from "../../../shared/types/content";

export interface PrepareImportedHtmlOptions {
  /** The title of the document the import is for. */
  documentTitle?: string;
  /** Called when an equation could not be read (left out). */
  onFormulaDropped?: () => void;
  /** Called when tables laid side by side were split (tableGaps). */
  onTablesSplit?: () => void;
}

const NOTE_ITEM = /^(footnote|endnote)-(\d+)$/;

function comparable(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:]+$/, "")
    .toLocaleLowerCase("es");
}

/**
 * The Word title (`p.docx-title`, already bold through the style map) is
 * dropped when it repeats the document's title, and kept as a paragraph
 * otherwise.
 */
function resolveTitles(root: ParentNode, documentTitle?: string): void {
  const expected = documentTitle ? comparable(documentTitle) : null;
  for (const title of Array.from(root.querySelectorAll("p.docx-title"))) {
    if (expected !== null && comparable(title.textContent ?? "") === expected) {
      title.remove();
    } else {
      title.removeAttribute("class");
    }
  }
}

/**
 * Footnotes and endnotes: mammoth puts them at the end as a numbered list
 * whose items end in a "↑" link back to the reference. They become
 * paragraphs that start with the reference as it reads in the text ("[1]"),
 * which keeps its number.
 */
function flattenNotes(document: Document): void {
  // One pass for every reference: a lookup by id per note would walk the
  // document once per note.
  const references = new Map<string, string>();
  for (const reference of Array.from(
    document.querySelectorAll('a[id^="footnote-ref-"], a[id^="endnote-ref-"]'),
  )) {
    references.set(reference.id, reference.textContent?.trim() ?? "");
  }
  for (const backLink of Array.from(
    document.querySelectorAll(
      'a[href^="#footnote-ref-"], a[href^="#endnote-ref-"]',
    ),
  )) {
    backLink.remove();
  }
  for (const list of Array.from(document.querySelectorAll("ol"))) {
    const items = Array.from(list.children);
    if (
      items.length === 0 ||
      !items.every(
        (item) =>
          item.tagName.toLowerCase() === "li" && NOTE_ITEM.test(item.id),
      )
    ) {
      continue;
    }
    const holder = document.createElement("div");
    items.forEach((item, index) => {
      const [, kind, id] = NOTE_ITEM.exec(item.id)!;
      const label = references.get(`${kind}-ref-${id}`) || `[${index + 1}]`;
      const note = document.createElement("div");
      while (item.firstChild) note.appendChild(item.firstChild);
      // The label goes into the note's first paragraph.
      const first =
        note.firstElementChild?.tagName.toLowerCase() === "p"
          ? note.firstElementChild
          : note;
      first.insertBefore(
        document.createTextNode(`${label} `),
        first.firstChild,
      );
      holder.appendChild(note);
    });
    list.replaceWith(holder);
  }
}

const LIST_LABEL = /^(1|a|A|i|I)([.)])\|(\d{1,9})$/;

/**
 * The hidden numbers of list items (`span.docx-list-label`, "a)|3", see
 * NUMBERING_SCRIPT in docx.ts) become the item's marker (`data-marker`) and,
 * where it does not follow from the item before, its number (`data-start`),
 * which htmlElementToBlocks reads. Items follow on as orderedListNumbers
 * counts them: within one list and one marker.
 */
function listLabels(document: Document): void {
  for (const list of Array.from(document.querySelectorAll("ol"))) {
    let expected = 1;
    let previous: string | null = null;
    for (const item of Array.from(list.children)) {
      if (item.tagName.toLowerCase() !== "li") continue;
      const label = Array.from(item.children).find(
        (child) =>
          child.tagName.toLowerCase() === "span" &&
          child.classList.contains("docx-list-label"),
      );
      if (!label) continue;
      const match = LIST_LABEL.exec(label.textContent ?? "");
      label.remove();
      if (!match) continue;
      const marker = `${match[1]}${match[2]}`;
      const value = Number(match[3]);
      if (marker !== previous) expected = 1;
      if (marker !== "1.") item.setAttribute("data-marker", marker);
      if (value !== expected) item.setAttribute("data-start", String(value));
      expected = value + 1;
      previous = marker;
    }
  }
  // Any label left outside a list item is no text of the document.
  for (const stray of Array.from(
    document.querySelectorAll("span.docx-list-label"),
  )) {
    stray.remove();
  }
}

const ALIGNED_BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * The hidden alignment of a paragraph (`span.docx-align`, see alignmentRun
 * in docx.ts) becomes `data-align` on its block, which htmlElementToBlocks
 * reads.
 */
function alignments(document: Document): void {
  for (const span of Array.from(document.querySelectorAll("span.docx-align"))) {
    const value = span.textContent;
    const block = span.parentElement;
    span.remove();
    if (
      block &&
      (value === "center" || value === "right") &&
      ALIGNED_BLOCKS.has(block.tagName.toLowerCase())
    ) {
      block.setAttribute("data-align", value);
    }
  }
}

/**
 * Page breaks (`span.docx-page`, see pageBreakRun in docx.ts) become
 * `data-page-break` on the paragraph or heading that starts the new page
 * (user's decision of 2026-11-26): the one that holds the break before its
 * text, else the next one with text, blank lines aside. Only the text's own
 * paragraphs and headings start a page, never a list, a quote or a table,
 * which lose the break. One whose text starts with «Anexo» becomes an
 * annex's heading (`data-annex`, Block.annex), a paragraph made a heading
 * of level 1 for it.
 */
function pageBreaks(document: Document): void {
  const body = document.body;
  if (!body) return;
  const startsPage = (element: Element | null): element is Element =>
    element !== null &&
    element.parentElement === body &&
    /^(p|h[1-6])$/.test(tagOf(element));
  const hasText = (element: Element) =>
    Boolean((element.textContent ?? "").trim()) ||
    element.querySelector("img, [data-formula]") !== null;
  for (const span of Array.from(document.querySelectorAll("span.docx-page"))) {
    const where = span.textContent;
    const block = span.parentElement;
    span.remove();
    if (!block || block.parentElement !== body) continue;
    let target: Element | null =
      where === "before" && hasText(block) ? block : block.nextElementSibling;
    while (target && tagOf(target) === "p" && !hasText(target)) {
      target = target.nextElementSibling;
    }
    if (!startsPage(target)) continue;
    if (/^\s*anexo\b/i.test(target.textContent ?? "")) {
      let heading = target;
      if (tagOf(target) === "p") {
        heading = document.createElement("h1");
        for (const { name, value } of Array.from(target.attributes)) {
          heading.setAttribute(name, value);
        }
        heading.append(...Array.from(target.childNodes));
        target.replaceWith(heading);
      }
      heading.setAttribute("data-annex", "true");
    } else target.setAttribute("data-page-break", "true");
  }
}

/**
 * Filled cells (`span.docx-cell`, see cellFills in docx.ts, which writes
 * "dark:rrggbb" or "light:rrggbb"): each takes the palette colour nearest
 * to its Word fill (`data-fill`, nearestCellFill), and on a dark fill it
 * becomes a header cell too (`data-header="true"`); htmlElementToBlocks
 * reads both. Cells Word itself makes headers (repeated header rows, `th`)
 * stay so.
 */
function cellFills(document: Document): void {
  for (const span of Array.from(document.querySelectorAll("span.docx-cell"))) {
    const [tone, colour] = (span.textContent ?? "").split(":");
    const cell = span.closest("td, th");
    span.remove();
    if (!cell) continue;
    const fill = colour ? nearestCellFill(colour) : null;
    if (fill) cell.setAttribute("data-fill", fill);
    if (tone === "dark") cell.setAttribute("data-header", "true");
  }
}

/**
 * A table with dark cells (see cellFills) marks its headers by colour, so
 * its other cells of its own are no headers however bold their text
 * (`data-header="false"`, which htmlElementToBlocks reads). Runs after
 * tableGaps, so each table split off decides by its own dark cells: a bold
 * header on white beside a dark one still reads as a header.
 */
function colourHeaderTables(document: Document): void {
  const tables = new Set<Element>();
  for (const cell of Array.from(
    document.querySelectorAll('td[data-header="true"], th[data-header="true"]'),
  )) {
    const table = cell.closest("table");
    if (table) tables.add(table);
  }
  for (const table of tables) {
    for (const cell of Array.from(table.querySelectorAll("td"))) {
      if (
        cell.closest("table") === table &&
        !cell.hasAttribute("data-header")
      ) {
        cell.setAttribute("data-header", "false");
      }
    }
  }
}

const tagOf = (element: Element): string => element.tagName.toLowerCase();

/** A table's own rows, outside or inside thead, tbody and tfoot, as htmlElementToBlocks reads them. */
function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = tagOf(child);
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      rows.push(
        ...Array.from(child.children).filter((row) => tagOf(row) === "tr"),
      );
    }
  }
  return rows;
}

const rowCells = (row: Element): Element[] =>
  Array.from(row.children).filter((cell) => {
    const tag = tagOf(cell);
    return tag === "td" || tag === "th";
  });

/** A colspan or rowspan as htmlElementToBlocks reads it. */
function spanOf(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 100) : 1;
}

const isBlankCell = (cell: Element): boolean =>
  !(cell.textContent ?? "").trim() && !cell.querySelector("img");

const isHeaderCell = (cell: Element): boolean =>
  tagOf(cell) === "th" || cell.getAttribute("data-header") === "true";

/** A table laid on its grid, each cell's element its one "block". */
function elementGrid(rows: Element[]) {
  const group: TableGroup<Element> = {
    table: "table",
    rows: rows.map((row, r) => ({
      row: String(r),
      cells: rowCells(row).map((cell, c) => ({
        cell: {
          table: "table",
          row: String(r),
          cell: `${r}:${c}`,
          colspan: spanOf(cell.getAttribute("colspan")),
          rowspan: spanOf(cell.getAttribute("rowspan")),
        },
        blocks: [cell],
      })),
    })),
  };
  return tableGrid(group);
}

/** "top=thick;left=none" (see bordersOf and tableSpec in docx.ts) as a map. */
function parseSpec(text: string | null): Map<string, string> {
  const spec = new Map<string, string>();
  for (const part of (text ?? "").split(";")) {
    const [key, value] = part.split("=");
    if (key && value) spec.set(key, value);
  }
  return spec;
}

const edgeOf = (value: string | undefined): CellEdge | undefined =>
  value === "none" || value === "thin" || value === "thick" ? value : undefined;

/**
 * Tables' widths, places and rules, from the hidden runs the converter
 * writes (`span.docx-table` in a table's first cell, `span.docx-borders` in
 * a cell, see cellFills in docx.ts). A table narrower than the text gets
 * `data-table-width` (percent) and `data-table-align`. Each cell's sides
 * are worked out on the table's grid as Word draws them: an outer side
 * from the table's outer rule, an inner one from its inside rules, either
 * replaced by the cell's own; a side two cells share, as the stronger of
 * the two. The sides not drawn with the thin rule go to `data-borders`.
 * A table that sets no rules of its own (a style's, which the converter
 * does not read) keeps the thin rule everywhere. Runs before tableGaps, so
 * the tables split off keep the rules Word drew; tables nested in a cell
 * are left alone (htmlElementToBlocks flattens them). Every marker goes.
 */
function tableBorders(document: Document): void {
  const specs = new Map<Element, Map<string, string>>();
  for (const span of Array.from(document.querySelectorAll("span.docx-table"))) {
    const table = span.closest("table");
    const spec = parseSpec(span.textContent);
    span.remove();
    if (table && !specs.has(table)) specs.set(table, spec);
  }
  const own = new Map<Element, Map<string, string>>();
  for (const span of Array.from(
    document.querySelectorAll("span.docx-borders"),
  )) {
    const cell = span.closest("td, th");
    const spec = parseSpec(span.textContent);
    span.remove();
    if (cell) own.set(cell, spec);
  }
  const tables = new Set(specs.keys());
  for (const cell of own.keys()) {
    const table = cell.closest("table");
    if (table) tables.add(table);
  }
  for (const table of tables) {
    if (table.parentElement?.closest("td, th")) continue;
    const spec = specs.get(table) ?? new Map<string, string>();
    const width = Number(spec.get("w"));
    if (Number.isInteger(width) && width >= TABLE_MIN_WIDTH && width < 100) {
      table.setAttribute("data-table-width", String(width));
      const align = spec.get("a");
      if (align === "center" || align === "right") {
        table.setAttribute("data-table-align", align);
      }
    }
    const rows = tableRows(table);
    const grid = elementGrid(rows);
    const declared =
      CELL_SIDES.some((side) => spec.has(side)) ||
      spec.has("insideH") ||
      spec.has("insideV") ||
      spec.has("color") ||
      grid.rows.some((row) => row.some((cell) => own.has(cell.blocks[0]!)));
    if (!declared) continue;
    grid.rows.forEach((row, r) => {
      for (const cell of row) {
        const inner: Record<CellSide, string> = {
          top: r === 0 ? "top" : "insideH",
          bottom: r + cell.rowspan >= grid.rows.length ? "bottom" : "insideH",
          left: cell.column === 0 ? "left" : "insideV",
          right:
            cell.column + cell.colspan >= grid.columns ? "right" : "insideV",
        };
        const mine = own.get(cell.blocks[0]!);
        const borders: CellBorders = {};
        for (const side of CELL_SIDES) {
          const edge =
            edgeOf(mine?.get(side)) ?? edgeOf(spec.get(inner[side])) ?? "thin";
          if (edge !== "thin") borders[side] = edge;
        }
        cell.cell.borders = borders;
        // Its rules' colour: its own, else its table's, as the palette's
        // nearest; burgundy is the template's own.
        const colour = mine?.get("color") ?? spec.get("color");
        const fill = colour ? nearestCellFill(colour) : null;
        if (fill && fill !== "burgundy") {
          cell.blocks[0]!.setAttribute("data-border-color", fill);
        }
      }
    });
    for (const [cell, edges] of gridEdges(grid)) {
      const borders: CellBorders = {};
      for (const side of CELL_SIDES) {
        if (edges[side] !== "thin") borders[side] = edges[side];
      }
      const value = formatCellBorders(borders);
      if (value) cell.blocks[0]!.setAttribute("data-borders", value);
    }
  }
}

/**
 * Splits one table at its spacer columns (see tableGaps). Returns whether it
 * did; a table that does not clearly hold tables side by side stays whole.
 */
function splitTable(
  document: Document,
  table: Element,
  marked: Set<Element>,
): boolean {
  const rows = tableRows(table);
  if (rows.length < 2) return false;
  const grid = elementGrid(rows);
  const elementOf = (cell: GridCell<Element>) => cell.blocks[0]!;
  const blank = new Map<Element, boolean>();
  const isBlank = (cell: GridCell<Element>) => {
    const element = elementOf(cell);
    let value = blank.get(element);
    if (value === undefined) {
      value = isBlankCell(element);
      blank.set(element, value);
    }
    return value;
  };
  // Each row's own cells by the column they start at.
  const byColumn = grid.rows.map(
    (row) => new Map(row.map((cell) => [cell.column, cell])),
  );
  // An interior column where every row has a blank, unfilled cell of its own
  // with no top or bottom rule, which no span crosses. Each row checked
  // passes on a cell of its own, so the checks stay within the cells.
  const gaps = new Set<number>();
  for (let column = 1; column < grid.columns - 1; column++) {
    const spacer = byColumn.every((cells) => {
      const cell = cells.get(column);
      if (!cell || cell.colspan !== 1 || cell.rowspan !== 1) return false;
      const element = elementOf(cell);
      return (
        marked.has(element) &&
        !element.hasAttribute("data-fill") &&
        isBlank(cell)
      );
    });
    if (spacer) gaps.add(column);
  }
  if (gaps.size === 0) return false;
  // The columns between gaps, consecutive gaps counting as one.
  const parts: { from: number; to: number }[] = [];
  const partOf: number[] = [];
  let from = 0;
  for (let column = 0; column <= grid.columns; column++) {
    if (column < grid.columns && !gaps.has(column)) continue;
    if (column > from) {
      for (let c = from; c < column; c++) partOf[c] = parts.length;
      parts.push({ from, to: column });
    }
    from = column + 1;
  }
  // Each row's own cells in each part, and the rows a span covers there.
  const cells = parts.map(() => grid.rows.map(() => [] as GridCell<Element>[]));
  const covered = parts.map(() => grid.rows.map(() => false));
  for (const [r, row] of grid.rows.entries()) {
    for (const cell of row) {
      if (gaps.has(cell.column)) continue;
      const part = partOf[cell.column];
      // A cell spanning into a gap: the layout is not what it seems.
      if (part === undefined || cell.column + cell.colspan > parts[part]!.to) {
        return false;
      }
      cells[part]![r]!.push(cell);
      for (let below = r + 1; below < r + cell.rowspan; below++) {
        covered[part]![below] = true;
      }
    }
  }
  const hasContent = (own: GridCell<Element>[]) =>
    own.some((cell) => !isBlank(cell));
  // The parts each row has content in.
  const withContent = grid.rows.map((_, r) =>
    cells.reduce((count, part) => count + (hasContent(part[r]!) ? 1 : 0), 0),
  );
  // A filled or header cell: a band such as a header or totals row.
  const isBand = (element: Element) =>
    element.hasAttribute("data-fill") || isHeaderCell(element);
  // The last row where each part has plain data: text in a row of its own
  // with no fill or header cell. Padding only follows it.
  const lastPlain = cells.map((part) => {
    let last = -1;
    for (const [r, own] of part.entries()) {
      if (hasContent(own) && !own.some((cell) => isBand(elementOf(cell)))) {
        last = r;
      }
    }
    return last;
  });
  // A row a part leaves out: one with nothing of its own there (blank,
  // unfilled, no header, no span) while it has content in another part,
  // below the part's last row of plain data, so it only pads that part at
  // its end (before a closing band at most) to the other's length. A blank
  // row between data rows stays, or the rows after it would move up a line
  // and out of step with the other parts; so does a row blank everywhere,
  // as in any table, and one a span covers.
  const kept = parts.map((_, p) =>
    grid.rows.map((_, r) => {
      if (covered[p]![r]) return true;
      const own = cells[p]![r]!;
      if (own.length === 0) return false;
      const padding = own.every(
        (cell) =>
          cell.rowspan === 1 && !isBand(elementOf(cell)) && isBlank(cell),
      );
      return !(padding && withContent[r]! > 0 && r > lastPlain[p]!);
    }),
  );
  for (const [p, part] of parts.entries()) {
    const keptRows = cells[p]!.filter((_, r) => kept[p]![r]);
    // A part needs two columns, some text and a row of two cells at least:
    // a table with one cell per row reads as a box of paragraphs.
    if (part.to - part.from < 2) return false;
    if (!keptRows.some(hasContent)) return false;
    if (!keptRows.some((own) => own.length >= 2)) return false;
    // A row a span covers with no cell of its own there would vanish and
    // stretch the span over the next one.
    if (keptRows.some((own) => own.length === 0)) return false;
  }
  // The cells move into the new tables, never copied; the spacers go.
  const tables = parts.map((_, p) => {
    const part = document.createElement("table");
    for (const [r, own] of cells[p]!.entries()) {
      if (!kept[p]![r]) continue;
      const row = document.createElement("tr");
      for (const cell of own) row.appendChild(elementOf(cell));
      part.appendChild(row);
    }
    return part;
  });
  table.replaceWith(...tables);
  return true;
}

/**
 * Tables Word lays side by side as one table, with an empty column between
 * them whose cells hide their top and bottom rules (`span.docx-gap`, see
 * cellFills in docx.ts), become tables one after the other, left to right:
 * blocks have no layout to put them side by side, and their rows have
 * nothing to do with each other (a screen reader would read them as one).
 * Only a clear spacer splits a table: an interior column, blank and unfilled
 * in every row (each row with a cell of its own there that no span crosses),
 * in a table of two rows or more, leaving parts of two columns or more with
 * text. The rows that only pad a shorter part at its end go; a blank row
 * between a part's data rows stays, so its rows keep their place. Tables
 * nested in a cell are left alone (htmlElementToBlocks flattens them). Every
 * marker goes, whether its table splits or not. Returns whether any table
 * split.
 */
function tableGaps(document: Document): boolean {
  const marked = new Set<Element>();
  for (const span of Array.from(document.querySelectorAll("span.docx-gap"))) {
    const cell = span.closest("td, th");
    span.remove();
    if (cell) marked.add(cell);
  }
  const tables = new Set<Element>();
  for (const cell of marked) {
    const table = cell.closest("table");
    if (table && !table.parentElement?.closest("td, th")) tables.add(table);
  }
  let split = false;
  for (const table of tables) {
    if (splitTable(document, table, marked)) split = true;
  }
  return split;
}

/**
 * Takes each stored picture (`img[data-asset]`) out of the paragraph or
 * heading Word put it in, splitting that block around it: what came before
 * stays, the picture follows on its own, then a copy of the block (same
 * attributes, alignment included) holds what came after. Inline wrappers
 * (a link, bold) are split too; blocks left empty go. Pictures in a list
 * item or a table cell stay where they are, and the reader leaves those out.
 */
function liftImages(document: Document): void {
  for (const img of Array.from(document.querySelectorAll("img[data-asset]"))) {
    const block = img.closest("p, h1, h2, h3, h4, h5, h6");
    if (!block) continue;
    // From the picture up to the block, everything after it moves to copies.
    let current: Element = img;
    let tail: Element | null = null;
    while (current.parentElement && current.parentElement !== block) {
      const parent: Element = current.parentElement;
      const copy = parent.cloneNode(false) as Element;
      if (tail) copy.appendChild(tail);
      while (current.nextSibling) copy.appendChild(current.nextSibling);
      tail = copy;
      current = parent;
    }
    const after = block.cloneNode(false) as Element;
    if (tail) after.appendChild(tail);
    while (current.nextSibling) after.appendChild(current.nextSibling);
    img.remove();
    block.after(img, after);
    for (const part of [block, after]) {
      if (!(part.textContent ?? "").trim() && !part.querySelector("img")) {
        part.remove();
      }
    }
  }
}

/**
 * Blank paragraphs (the converter keeps them, `ignoreEmptyParagraphs`): the
 * room Word documents leave with blank lines, a signature's above all, stays
 * as empty paragraphs (`data-blank`, which htmlElementToBlocks keeps). Only
 * those among the text's own paragraphs, never at its start or end: one in
 * a table cell, a list, a quote or a note goes, as before.
 */
function blankParagraphs(document: Document): void {
  const body = document.body;
  if (!body) return;
  const isBlank = (element: Element) =>
    tagOf(element) === "p" &&
    !(element.textContent ?? "").trim() &&
    !element.querySelector("img, [data-formula]");
  for (const paragraph of Array.from(document.querySelectorAll("p"))) {
    if (!isBlank(paragraph)) continue;
    if (paragraph.parentElement === body) {
      paragraph.setAttribute("data-blank", "");
    } else {
      paragraph.remove();
    }
  }
  while (body.firstElementChild?.hasAttribute("data-blank")) {
    body.firstElementChild.remove();
  }
  while (body.lastElementChild?.hasAttribute("data-blank")) {
    body.lastElementChild.remove();
  }
}

/** Replaces `element` with its content. */
function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

/**
 * Links keep no underline of their own: Word and Google Docs underline the
 * text of every hyperlink, which would leave an underline behind wherever a
 * link is later removed.
 */
function linkUnderlines(document: Document): void {
  for (const underline of Array.from(document.querySelectorAll("a u"))) {
    unwrap(underline);
  }
  for (const underline of Array.from(document.querySelectorAll("u"))) {
    const only =
      underline.childNodes.length === 1 ? underline.firstChild : null;
    if (
      only?.nodeType === 1 &&
      (only as Element).tagName.toLowerCase() === "a"
    ) {
      unwrap(underline);
    }
  }
}

/** A Word equation as the converter marks it (MATH_SCRIPT in docx.ts). */
const FORMULA_MARKER = /\uE000([A-Za-z0-9+/=]{1,400000})\uE001/g;

function textNodesWithin(node: Node, found: Text[]): Text[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      if ((child.textContent ?? "").includes("\uE000"))
        found.push(child as Text);
    } else {
      textNodesWithin(child, found);
    }
  }
  return found;
}

/**
 * Word equations: each marker the converter left becomes the equation's
 * LaTeX (omml.ts) in a <code data-formula>, a formula inside a sentence;
 * one alone in its paragraph becomes a <div data-formula>, a formula block.
 * One that cannot be read is left out and said.
 */
function formulas(document: Document, onDropped?: () => void): void {
  const placed: Element[] = [];
  for (const node of textNodesWithin(document, [])) {
    const text = node.textContent ?? "";
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(FORMULA_MARKER)) {
      fragment.append(document.createTextNode(text.slice(last, match.index)));
      last = match.index + match[0].length;
      const tree = parseOmmlTree(
        Buffer.from(match[1]!, "base64").toString("utf8"),
      );
      const latex = tree ? ommlToLatex(tree) : "";
      if (!latex) {
        onDropped?.();
        continue;
      }
      const code = document.createElement("code");
      code.setAttribute("data-formula", "");
      code.textContent = latex;
      fragment.append(code);
      placed.push(code);
    }
    fragment.append(
      document.createTextNode(text.slice(last).replace(/[\uE000\uE001]/g, "")),
    );
    node.replaceWith(fragment);
  }
  for (const code of placed) {
    const paragraph = code.closest("p");
    if (
      !paragraph ||
      paragraph.querySelectorAll("code[data-formula], img").length !== 1 ||
      (paragraph.textContent ?? "").trim() !== (code.textContent ?? "").trim()
    ) {
      continue;
    }
    const block = document.createElement("div");
    block.setAttribute("data-formula", "");
    block.textContent = code.textContent;
    paragraph.replaceWith(block);
  }
}

/** The text right before `node` within its paragraph, as far as one step up. */
function textBefore(node: Node): string {
  let current: Node | null = node;
  for (let step = 0; step < 2 && current; step++) {
    const previous: Node | null = current.previousSibling;
    if (previous) return previous.textContent ?? "";
    current = current.parentNode;
  }
  return "";
}

/**
 * Spanish ordinals typed as a superscript letter ("80" and a raised "a")
 * become "80ª" and "1.º": blocks have no superscript, and "80a" reads wrong.
 */
function ordinalSuperscripts(document: Document): void {
  for (const sup of Array.from(document.querySelectorAll("sup"))) {
    const text = sup.textContent;
    if (text !== "a" && text !== "o") continue;
    if (!/[0-9.]$/.test(textBefore(sup))) continue;
    sup.replaceWith(document.createTextNode(text === "a" ? "ª" : "º"));
  }
}

export function prepareImportedHtml(
  document: Document,
  options: PrepareImportedHtmlOptions = {},
): void {
  resolveTitles(document, options.documentTitle);
  flattenNotes(document);
  listLabels(document);
  alignments(document);
  // Before the blank lines are told apart: a break alone is no text.
  pageBreaks(document);
  // After the alignment markers are gone: a centred equation is alone.
  formulas(document, options.onFormulaDropped);
  liftImages(document);
  blankParagraphs(document);
  cellFills(document);
  tableBorders(document);
  if (tableGaps(document)) options.onTablesSplit?.();
  colourHeaderTables(document);
  linkUnderlines(document);
  ordinalSuperscripts(document);
}
