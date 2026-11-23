/**
 * A small Excel (.xlsx) writer: the XML parts of a workbook of text sheets,
 * for the caller to zip (app/utils/xlsxDownload.ts, with JSZip). Each sheet
 * has some lines above its table (a large title, then smaller lines such as
 * when it was exported), a header row in CREUP's burgundy, frozen and
 * filterable, and rows of text wrapped at the top of their cells, banded,
 * with thin borders; a cell may carry a status colour, as the platform's
 * badges do (a pale fill and dark text). Strings go inline (no shared
 * strings table) and are escaped, with the control characters XML cannot
 * carry dropped. Pure, so it is tested without a browser.
 */

/** How a cell looks: plain, centred, bold, or a status colour. */
export const XLSX_CELL_STYLES = [
  "text",
  "center",
  "strong",
  "success",
  "danger",
  "warning",
  "neutral",
  "info",
] as const;
export type XlsxCellStyle = (typeof XLSX_CELL_STYLES)[number];

/** A cell: its text, with the column's look, or its own. */
export type XlsxCell = string | { text: string; style: XlsxCellStyle };

export interface XlsxColumn {
  header: string;
  /** Width in characters. */
  width: number;
  /** How its cells look unless a cell says otherwise; `text` by default. */
  style?: "text" | "center" | "strong";
}

export interface XlsxSheet {
  /** The tab's name; made valid and unique by xlsxSheetNames. */
  name: string;
  /** Lines above the table: the first one a large title. */
  lines: string[];
  columns: XlsxColumn[];
  rows: XlsxCell[][];
  /** The tab's colour, as RRGGBB. */
  tabColor?: string;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  /** When it was made: the document's own creation date. */
  created: Date;
  title: string;
}

/** The longest name Excel gives a sheet. */
export const XLSX_SHEET_NAME_MAX = 31;

/** Characters XML 1.0 cannot carry, beyond tab and line ends. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(text: string): string {
  return text
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** «A», «B»… «Z», «AA»: the letters of a column, from 0. */
export function columnLetters(index: number): string {
  let letters = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/**
 * Valid, unique sheet names: without the characters Excel refuses
 * (`[]:*?/\`), no apostrophe at either end, at most 31 characters, never
 * empty, and a « (2)» on a repeated one.
 */
export function xlsxSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const clean =
      name
        .replace(/[[\]:*?/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^'+|'+$/g, "")
        .trim() || `Hoja ${index + 1}`;
    let candidate = clean.slice(0, XLSX_SHEET_NAME_MAX).trim();
    for (let copy = 2; used.has(candidate.toLocaleLowerCase()); copy++) {
      const suffix = ` (${copy})`;
      candidate = `${clean.slice(0, XLSX_SHEET_NAME_MAX - suffix.length).trim()}${suffix}`;
    }
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}

/** Style ids in styles.xml (cellXfs). */
const STYLE = {
  text: 1,
  header: 2,
  title: 3,
  line: 4,
  textBand: 5,
  center: 6,
  centerBand: 7,
  strong: 8,
  strongBand: 9,
  success: 10,
  danger: 11,
  warning: 12,
  neutral: 13,
  info: 14,
} as const;

/** The style id of a body cell, banded on every other row. */
function bodyStyle(style: XlsxCellStyle, banded: boolean): number {
  switch (style) {
    case "text":
      return banded ? STYLE.textBand : STYLE.text;
    case "center":
      return banded ? STYLE.centerBand : STYLE.center;
    case "strong":
      return banded ? STYLE.strongBand : STYLE.strong;
    default:
      return STYLE[style];
  }
}

function cell(ref: string, text: string, style: number): string {
  if (!text) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const out: string[] = [];
  let row = 0;
  sheet.lines.forEach((line, index) => {
    row++;
    const first = index === 0;
    const height = first ? ` ht="26" customHeight="1"` : "";
    const style = first ? STYLE.title : STYLE.line;
    out.push(`<row r="${row}"${height}>${cell(`A${row}`, line, style)}</row>`);
  });
  if (sheet.lines.length > 0) row++; // A blank row before the table.
  const headerRow = row + 1;
  row = headerRow;
  out.push(
    `<row r="${row}" ht="30" customHeight="1">${sheet.columns
      .map((column, index) =>
        cell(`${columnLetters(index)}${row}`, column.header, STYLE.header),
      )
      .join("")}</row>`,
  );
  sheet.rows.forEach((values, rowIndex) => {
    row++;
    const banded = rowIndex % 2 === 1;
    out.push(
      `<row r="${row}">${sheet.columns
        .map((column, index) => {
          const value = values[index] ?? "";
          const text = typeof value === "string" ? value : value.text;
          const style =
            typeof value === "string" ? (column.style ?? "text") : value.style;
          return cell(
            `${columnLetters(index)}${row}`,
            text,
            bodyStyle(style, banded),
          );
        })
        .join("")}</row>`,
    );
  });
  const lastColumn = columnLetters(Math.max(0, sheet.columns.length - 1));
  const cols = sheet.columns
    .map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`,
    )
    .join("");
  const tabColor = /^[0-9A-Fa-f]{6}$/.test(sheet.tabColor ?? "")
    ? `<tabColor rgb="FF${sheet.tabColor!.toUpperCase()}"/>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr>${tabColor}<pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${out.join("")}</sheetData>` +
    (sheet.rows.length > 0 && sheet.columns.length > 0
      ? `<autoFilter ref="A${headerRow}:${lastColumn}${row}"/>`
      : "") +
    `<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>` +
    `<headerFooter><oddFooter>&amp;L&amp;8&amp;A&amp;R&amp;8&amp;P / &amp;N</oddFooter></headerFooter>` +
    `</worksheet>`
  );
}

/** A font: its size, colour and look (bold, italic). */
function font(size: number, color: string, look = ""): string {
  return `<font>${look}<sz val="${size}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`;
}

function solid(color: string): string {
  return `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`;
}

/** One cell format of cellXfs. */
function xf(
  fontId: number,
  fillId: number,
  borderId: number,
  align: string,
): string {
  return `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`;
}

const TOP = `<alignment vertical="top" wrapText="1"/>`;
const TOP_CENTER = `<alignment horizontal="center" vertical="top" wrapText="1"/>`;

/**
 * Fonts: 0 normal, 1 header (white bold), 2 title (burgundy, large), 3 line
 * (grey italic), 4 strong, 5-9 the status colours (bold). Fills: 2 the
 * header's burgundy, 3 the band, 4-8 the status tints. Borders: 1 thin,
 * light grey all round.
 */
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="10">` +
  font(11, "1F1F1F") +
  font(11, "FFFFFF", "<b/>") +
  font(18, "7B1E22", "<b/>") +
  font(10, "6B6B6B", "<i/>") +
  font(11, "1F1F1F", "<b/>") +
  font(11, "1E6B34", "<b/>") +
  font(11, "A3262A", "<b/>") +
  font(11, "8A5A00", "<b/>") +
  font(11, "4A4A4A", "<b/>") +
  font(11, "1F4E8C", "<b/>") +
  `</fonts>` +
  `<fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  solid("7B1E22") +
  solid("FAF5F5") +
  solid("E3F3E7") +
  solid("FBE4E4") +
  solid("FFF1CF") +
  solid("EDEDED") +
  solid("E2ECF8") +
  `</fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left style="thin"><color rgb="FFDDDDDD"/></left><right style="thin"><color rgb="FFDDDDDD"/></right><top style="thin"><color rgb="FFDDDDDD"/></top><bottom style="thin"><color rgb="FFDDDDDD"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="15">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  xf(0, 0, 1, TOP) +
  xf(
    1,
    2,
    1,
    `<alignment horizontal="center" vertical="center" wrapText="1"/>`,
  ) +
  xf(2, 0, 0, `<alignment vertical="center"/>`) +
  xf(3, 0, 0, `<alignment vertical="center"/>`) +
  xf(0, 3, 1, TOP) +
  xf(0, 0, 1, TOP_CENTER) +
  xf(0, 3, 1, TOP_CENTER) +
  xf(4, 0, 1, TOP) +
  xf(4, 3, 1, TOP) +
  xf(5, 4, 1, TOP_CENTER) +
  xf(6, 5, 1, TOP_CENTER) +
  xf(7, 6, 1, TOP_CENTER) +
  xf(8, 7, 1, TOP_CENTER) +
  xf(9, 8, 1, TOP_CENTER) +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Every part of the workbook, by its path inside the zip. */
export function xlsxParts(book: XlsxWorkbook): Record<string, string> {
  const names = xlsxSheetNames(book.sheets.map((sheet) => sheet.name));
  const sheets = book.sheets.length > 0 ? book.sheets : [];
  const parts: Record<string, string> = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
    "docProps/core.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlEscape(book.title)}</dc:title>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${book.created.toISOString().replace(/\.\d{3}Z$/, "Z")}</dcterms:created>` +
      `</cp:coreProperties>`,
    "docProps/app.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Asambleas CREUP</Application></Properties>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView/></bookViews><sheets>` +
      sheets
        .map(
          (_, index) =>
            `<sheet name="${xmlEscape(names[index]!)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("") +
      `</sheets>` +
      // Each sheet's filter needs its defined name, or Excel repairs the file.
      (sheets.some((sheet) => sheet.rows.length > 0)
        ? `<definedNames>${sheets
            .map((sheet, index) => {
              if (sheet.rows.length === 0 || sheet.columns.length === 0)
                return "";
              const header = sheet.lines.length + (sheet.lines.length ? 2 : 1);
              const last = header + sheet.rows.length;
              const column = columnLetters(sheet.columns.length - 1);
              const quoted = `'${names[index]!.replace(/'/g, "''")}'`;
              return `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${xmlEscape(`${quoted}!$A$${header}:$${column}$${last}`)}</definedName>`;
            })
            .join("")}</definedNames>`
        : "") +
      `</workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    "xl/styles.xml": STYLES_XML,
  };
  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet);
  });
  return parts;
}
