// Builders shared by the DOCX converter's tests (server/utils/content/docx*.test.ts),
// which are split over several files so that Vitest runs them side by side:
// each one spawns converter processes one after another. Kept out of
// server/utils so that Nitro never scans it.
import { constants, deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { convertDocx, DOCX_LIMITS } from "../utils/content/docx";
import type { DocxLimits } from "../utils/content/docx";

export const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

let owners = 0;

/** A fresh user for every conversion, so the per-user limit stays out of the way. */
export function nextOwner(): string {
  return `user-${++owners}`;
}

export function convert(data: Buffer, limits: DocxLimits = DOCX_LIMITS) {
  return convertDocx(data, { owner: nextOwner(), limits });
}

export async function buildDocx(
  body: string,
  extra: Record<string, string> = {},
) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Ttulo"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}</w:body></w:document>`,
  );
  for (const [path, content] of Object.entries(extra)) zip.file(path, content);
  // Word deflates its parts, so the import path is exercised as in real files.
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export const p = (style: string | null, text: string, bold = false) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A paragraph holding only an inline picture, embedded as `rIdImg`. */
export const imageParagraph = `<w:p><w:r><w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Imagen 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

/** The parts `imageParagraph` needs: the image, its type and relationship. */
export const imageParts: Record<string, string> = {
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`,
  // Only its relationship matters: the converter never decodes it.
  "word/media/image1.png": "not really a png",
};

export const MiB = 1024 * 1024;

export interface RawEntry {
  name: string;
  /** Stored bytes: raw for method 0, raw deflate for method 8. */
  data: Buffer;
  method: 0 | 8;
  /** Uncompressed size written to the headers, true or not. */
  declaredSize: number;
}

/**
 * Minimal ZIP writer, so a test can declare any uncompressed size. JSZip
 * skips the CRC check by default, so the CRCs are left at zero.
 */
export function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const stored = (name: string, content: string): RawEntry => {
  const data = Buffer.from(content, "utf8");
  return { name, data, method: 0, declaredSize: data.length };
};

/**
 * Raw deflate stream of `mebibytes` MiB of zeros, about 1 KB per MiB: one
 * fully flushed segment repeated, then an empty final block.
 */
export function zeroBomb(mebibytes: number): Buffer {
  const segment = deflateRawSync(Buffer.alloc(MiB), {
    level: 9,
    finishFlush: constants.Z_FULL_FLUSH,
  });
  return Buffer.concat([
    ...Array.from({ length: mebibytes }, () => segment),
    Buffer.from([0x03, 0x00]),
  ]);
}

/** A DOCX skeleton whose main document part is `document`. */
export function docxWith(document: RawEntry, extra: RawEntry[] = []): Buffer {
  return rawZip([
    stored(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    stored(
      "_rels/.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    document,
    ...extra,
  ]);
}

export const documentXml = (body: string) =>
  `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;

/** Limits small enough that a bomb exhausts the converter quickly. */
export const TEST_LIMITS: DocxLimits = { ...DOCX_LIMITS, converterHeapMb: 64 };

/** `count` attribute names that xmldom accepts without a value. */
export const attributeNames = (count: number) =>
  Array.from({ length: count }, (_, i) => `a${i.toString(36)}`);

/** A deflated DOCX whose main part repeats `element` `times` times. */
export function repeatedElementDocx(element: string, times: number): Buffer {
  const xml = documentXml(element.repeat(times) + p(null, "Texto"));
  return docxWith({
    name: "word/document.xml",
    data: deflateRawSync(Buffer.from(xml, "utf8")),
    method: 8,
    declaredSize: Buffer.byteLength(xml),
  });
}

/**
 * Converts `data` while measuring the longest stretch this process's event
 * loop was blocked, to show the expensive parsing happens elsewhere.
 */
export async function convertTimed(data: Buffer, limits: DocxLimits) {
  let longestStall = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 10);
  try {
    return await convert(data, limits).then(
      (value) => ({ value, error: null, longestStall }),
      (error: unknown) => ({ value: null, error, longestStall }),
    );
  } finally {
    clearInterval(timer);
  }
}

export const cell = (content: string) => `<w:tc>${content}</w:tc>`;
export const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
export const table = (...rows: string[]) => `<w:tbl>${rows.join("")}</w:tbl>`;

/** `levels` tables, each in the only cell of the one around it. */
export function nestedTables(levels: number, inner: string): string {
  let body = inner;
  for (let level = 0; level < levels; level++) body = table(row(cell(body)));
  return body;
}

/** A run of `text` in bold italic. */
export const boldItalic = (text: string) =>
  `<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

export const LINK_RELATIONSHIPS = stored(
  "word/_rels/document.xml.rels",
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://creup.es" TargetMode="External"/></Relationships>`,
);

/** A deflated DOCX whose main part has `body`, with a hyperlink `rIdL`. */
export function deflatedDocx(body: string): Buffer {
  const xml = documentXml(body);
  return docxWith(
    {
      name: "word/document.xml",
      data: deflateRawSync(Buffer.from(xml, "utf8")),
      method: 8,
      declaredSize: Buffer.byteLength(xml),
    },
    [LINK_RELATIONSHIPS],
  );
}

/** Bullets on every level of numbering `1`. */
export const NUMBERING = stored(
  "word/numbering.xml",
  `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${Array.from(
    { length: 9 },
    (_, level) => `<w:lvl w:ilvl="${level}"><w:numFmt w:val="bullet"/></w:lvl>`,
  ).join(
    "",
  )}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
);

/** A deflated DOCX whose main part has `body`, with the bullets of NUMBERING. */
export function listDocx(body: string): Buffer {
  const xml = documentXml(body);
  return docxWith(
    {
      name: "word/document.xml",
      data: deflateRawSync(Buffer.from(xml, "utf8")),
      method: 8,
      declaredSize: Buffer.byteLength(xml),
    },
    [
      stored(
        "word/_rels/document.xml.rels",
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
      ),
      NUMBERING,
    ],
  );
}

/** A list item at `level` holding `runs`. */
export const item = (level: number, runs: string) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>${runs}</w:p>`;

/** A run of `text`. */
export const run = (text: string) =>
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** `count` short lines of text separated by line breaks, in one run. */
export const lines = (count: number) =>
  `<w:r>${"<w:t>x</w:t><w:br/>".repeat(count)}<w:t>x</w:t></w:r>`;

/** `bytes` of words separated by spaces, which the walk collapses one by one. */
export const spaced = (bytes: number) => "a ".repeat(Math.floor(bytes / 2));
