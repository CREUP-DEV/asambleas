import type { Block } from "~~/shared/types/content";

/**
 * CREUP's Word templates open with the document's title and a line such as
 * "Aprobada en la [NUM] Asamblea General Ordinaria el XX/XX/XXXX…". The
 * platform shows the title and the approval itself, so a DOCX import offers
 * to drop those leading lines (DocxImport).
 */

/** How many leading blocks to look at: title, subtitle and approval line. */
const MAX_HEADER_BLOCKS = 4;

/** Share of the title's words a paragraph must repeat to count as it. */
const TITLE_OVERLAP = 0.6;

/** Longest header line: the full official name, or the approval line. */
const MAX_TITLE_LINE_WORDS = 30;

const STOP_WORDS = new Set([
  "a",
  "al",
  "de",
  "del",
  "e",
  "el",
  "en",
  "la",
  "las",
  "los",
  "o",
  "para",
  "por",
  "sobre",
  "u",
  "y",
]);

/** Lower case, without accents or punctuation, single spaces. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function significantWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/**
 * Whether a paragraph repeats the document's title, allowing for the small
 * differences a title gets between the Word file and the platform.
 */
export function repeatsTitle(text: string, title: string): boolean {
  const line = normalize(text);
  const reference = normalize(title);
  if (!line || !reference) return false;
  if (line === reference) return true;
  // A short line inside the title (or the other way round) only counts when
  // it is most of it: "Resolución" alone is not the title.
  if (line.includes(reference) || reference.includes(line)) {
    const shorter = Math.min(line.length, reference.length);
    const longer = Math.max(line.length, reference.length);
    if (shorter / longer >= TITLE_OVERLAP) return true;
  }
  const lineWords = significantWords(text);
  const titleWords = significantWords(title);
  if (lineWords.size === 0 || titleWords.size === 0) return false;
  let shared = 0;
  for (const word of lineWords) if (titleWords.has(word)) shared++;
  return shared / Math.max(lineWords.size, titleWords.size) >= TITLE_OVERLAP;
}

/** The template's approval line, filled in or still a placeholder. */
export function isApprovalLine(text: string): boolean {
  const line = normalize(text);
  return (
    /^aprobad[oa]s? /.test(line) &&
    line.split(" ").length <= MAX_TITLE_LINE_WORDS &&
    /\b(asamblea|ago|age|aget|num)\b/.test(line)
  );
}

/**
 * Whether the first line of a file is the full official name the title
 * abbreviates ("Convenio marco de participación de entidades sectoriales en
 * la Coordinadora de Representantes…" for "Convenio Marco de participación
 * de entidades sectoriales"): a short line with every word of the title.
 */
export function expandsTitle(text: string, title: string): boolean {
  const titleWords = significantWords(title);
  if (titleWords.size < 2) return false;
  if (normalize(text).split(" ").length > MAX_TITLE_LINE_WORDS) return false;
  const lineWords = significantWords(text);
  for (const word of titleWords) if (!lineWords.has(word)) return false;
  return true;
}

/**
 * How many blocks at the start of an imported text are the template's
 * header: lines that repeat the title (the first one may also spell it out
 * in full) or are the approval line, before the first line that is neither.
 * Only plain paragraphs and headings count, never list items, quotes or
 * table cells.
 */
export function templateHeaderLength(blocks: Block[], title: string): number {
  let count = 0;
  for (const [index, block] of blocks.slice(0, MAX_HEADER_BLOCKS).entries()) {
    if (block.cell || (block.type !== "paragraph" && block.type !== "heading"))
      break;
    const isTitle =
      repeatsTitle(block.text, title) ||
      (index === 0 && expandsTitle(block.text, title));
    if (!isTitle && !isApprovalLine(block.text)) break;
    count++;
  }
  return count;
}
