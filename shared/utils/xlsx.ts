/**
 * A small Excel (.xlsx) writer: the XML parts of a workbook of text sheets,
 * for the caller to zip (app/utils/xlsxDownload.ts, with JSZip). Each sheet
 * has some lines above its table (a title, when it was exported), a header
 * row frozen and filterable, and rows of text wrapped at the top of their
 * cells. Strings go inline (no shared strings table) and are escaped, with
 * the control characters XML cannot carry dropped. Pure, so it is tested
 * without a browser.
 */

export interface XlsxColumn {
  header: string;
  /** Width in characters. */
  width: number;
}

export interface XlsxSheet {
  /** The tab's name; made valid and unique by xlsxSheetNames. */
  name: string;
  /** Lines above the table, the first one in bold. */
  lines: string[];
  columns: XlsxColumn[];
  rows: string[][];
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

/** Style ids in styles.xml. */
const STYLE = { text: 1, header: 2, title: 3, line: 4 } as const;

function cell(ref: string, text: string, style: number): string {
  if (!text) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const out: string[] = [];
  let row = 0;
  sheet.lines.forEach((line, index) => {
    row++;
    out.push(
      `<row r="${row}">${cell(`A${row}`, line, index === 0 ? STYLE.title : STYLE.line)}</row>`,
    );
  });
  if (sheet.lines.length > 0) row++; // A blank row before the table.
  const headerRow = row + 1;
  row = headerRow;
  out.push(
    `<row r="${row}">${sheet.columns
      .map((column, index) =>
        cell(`${columnLetters(index)}${row}`, column.header, STYLE.header),
      )
      .join("")}</row>`,
  );
  for (const values of sheet.rows) {
    row++;
    out.push(
      `<row r="${row}">${sheet.columns
        .map((_, index) =>
          cell(
            `${columnLetters(index)}${row}`,
            values[index] ?? "",
            STYLE.text,
          ),
        )
        .join("")}</row>`,
    );
  }
  const lastColumn = columnLetters(Math.max(0, sheet.columns.length - 1));
  const cols = sheet.columns
    .map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${out.join("")}</sheetData>` +
    (sheet.rows.length > 0 && sheet.columns.length > 0
      ? `<autoFilter ref="A${headerRow}:${lastColumn}${row}"/>`
      : "") +
    `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>` +
    `</worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="4">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="13"/><color rgb="FF7B1E22"/><name val="Calibri"/></font>` +
  `<font><i/><sz val="10"/><color rgb="FF555555"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF7B1E22"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
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
