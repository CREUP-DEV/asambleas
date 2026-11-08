/**
 * Adjustments to the HTML mammoth returns, made on the parsed document before
 * htmlElementToBlocks walks it. Each is one pass over a selector. They add
 * no marks and no nesting that inspectHtml did not count: they remove nodes,
 * unwrap underlines of links, replace a superscript with a letter, move a
 * note's content into a <div> and write its "[1]" before it.
 */

export interface PrepareImportedHtmlOptions {
  /** The title of the document the import is for. */
  documentTitle?: string;
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
 * Filled cells (`span.docx-cell`, see cellFills in docx.ts): on a dark fill
 * they become header cells (`data-header="true"`), on a light one shaded
 * cells (`data-shade="true"`). A table that marks dark cells marks its
 * headers by colour, so its other cells are no headers however bold their
 * text (`data-header="false"`); htmlElementToBlocks reads all three. Cells
 * Word itself makes headers (repeated header rows, `th`) stay so.
 */
function cellFills(document: Document): void {
  const tables = new Set<Element>();
  for (const span of Array.from(document.querySelectorAll("span.docx-cell"))) {
    const fill = span.textContent;
    const cell = span.closest("td, th");
    span.remove();
    if (!cell) continue;
    if (fill === "light") {
      cell.setAttribute("data-shade", "true");
      continue;
    }
    if (fill !== "dark") continue;
    cell.setAttribute("data-header", "true");
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
  cellFills(document);
  linkUnderlines(document);
  ordinalSuperscripts(document);
}
