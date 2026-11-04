import { constants, deflateRawSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { convertDocx, DOCX_LIMITS, hasZipSignature } from "./docx";
import type { DocxLimits } from "./docx";

/** Output caps passed to inflateRawSync, to prove no entry inflates unbounded. */
const inflateCaps = vi.hoisted(() => [] as (number | undefined)[]);

// mammoth must only run in the converter process. If this process ever called
// it, every conversion below would fail.
vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

vi.mock("node:zlib", async (importOriginal) => {
  const zlib = await importOriginal<typeof import("node:zlib")>();
  return {
    ...zlib,
    inflateRawSync: (buffer: Uint8Array, options?: ZlibOptions) => {
      inflateCaps.push(options?.maxOutputLength);
      return zlib.inflateRawSync(buffer, options);
    },
  };
});

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function buildDocx(body: string, extra: Record<string, string> = {}) {
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

const p = (style: string | null, text: string, bold = false) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const MiB = 1024 * 1024;

interface RawEntry {
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
function rawZip(entries: RawEntry[]): Buffer {
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

const stored = (name: string, content: string): RawEntry => {
  const data = Buffer.from(content, "utf8");
  return { name, data, method: 0, declaredSize: data.length };
};

/**
 * Raw deflate stream of `mebibytes` MiB of zeros, about 1 KB per MiB: one
 * fully flushed segment repeated, then an empty final block.
 */
function zeroBomb(mebibytes: number): Buffer {
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
function docxWith(document: RawEntry, extra: RawEntry[] = []): Buffer {
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

const documentXml = (body: string) =>
  `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;

describe("convertDocx", { timeout: 30_000 }, () => {
  it("converts headings, paragraphs and bold text", async () => {
    const data = await buildDocx(
      p("Ttulo", "Resolución sobre becas") +
        p("Ttulo1", "Artículo 1") +
        p(null, "Texto normal ") +
        `<w:p><w:r><w:t xml:space="preserve">Hola </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>mundo</w:t></w:r></w:p>` +
        p("Ttulo2", "Sección"),
    );
    expect(hasZipSignature(data)).toBe(true);
    const result = await convertDocx(data);
    expect(result.warnings).toEqual([]);
    expect(result.blocks.map((b) => [b.type, b.level ?? null, b.text])).toEqual(
      [
        ["heading", 1, "Resolución sobre becas"],
        ["heading", 1, "Artículo 1"],
        ["paragraph", null, "Texto normal"],
        ["paragraph", null, "Hola mundo"],
        ["heading", 2, "Sección"],
      ],
    );
    expect(result.blocks[3]!.marks).toEqual([
      { type: "bold", from: 5, to: 10 },
    ]);
    for (const block of result.blocks)
      expect(block.id).toMatch(/^[a-z0-9]{20,}$/);
  });

  it("warns about tracked changes and comments", async () => {
    const data = await buildDocx(
      `<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>nuevo</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>viejo</w:delText></w:r></w:del></w:p>`,
      {
        "word/comments.xml": `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>Ojo</w:t></w:r></w:p></w:comment></w:comments>`,
      },
    );
    const result = await convertDocx(data);
    expect(result.warnings).toEqual(["tracked_changes", "comments"]);
  });

  it("rejects non-docx data", async () => {
    await expect(
      convertDocx(Buffer.from("%PDF-1.4 hello")),
    ).rejects.toMatchObject({ statusCode: 415 });
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const notDocx = await zip.generateAsync({ type: "nodebuffer" });
    await expect(convertDocx(notDocx)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("rejects an empty document", async () => {
    const data = await buildDocx("<w:p/>");
    await expect(convertDocx(data)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("converts a hand-written archive, so the zip helper is sound", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    const result = await convertDocx(data);
    expect(result.blocks.map((b) => b.text)).toEqual(["Texto"]);
  });
});

describe("convertDocx archive limits", () => {
  beforeEach(() => {
    inflateCaps.length = 0;
  });

  it("refuses a 1 GiB entry that declares 1 KB, stopping at the budget", async () => {
    const bomb = zeroBomb(1024);
    expect(bomb.length).toBeLessThan(2 * MiB);
    const data = docxWith({
      name: "word/document.xml",
      data: bomb,
      method: 8,
      declaredSize: 1024,
    });
    await expect(convertDocx(data)).rejects.toMatchObject({ statusCode: 413 });
    // The entry was inflated once, capped at the remaining budget, so at most
    // 32 MiB of the 1 GiB were ever produced.
    expect(inflateCaps).toHaveLength(1);
    expect(inflateCaps[0]).toBeGreaterThan(0);
    expect(inflateCaps[0]).toBeLessThanOrEqual(
      DOCX_LIMITS.maxUncompressedBytes,
    );
  });

  it("refuses a lying entry hidden in a part with any name", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      [
        {
          name: "word/media/image1.png",
          data: zeroBomb(4),
          method: 8,
          declaredSize: 1,
        },
      ],
    );
    await expect(
      convertDocx(data, { ...DOCX_LIMITS, maxUncompressedBytes: 2 * MiB }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("refuses an honest entry over the budget", async () => {
    const data = docxWith({
      name: "word/document.xml",
      data: zeroBomb(2),
      method: 8,
      declaredSize: 2 * MiB,
    });
    await expect(
      convertDocx(data, { ...DOCX_LIMITS, maxUncompressedBytes: MiB }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("refuses an entry larger than declared even within the budget", async () => {
    const xml = documentXml(p(null, "Texto"));
    const data = docxWith({
      name: "word/document.xml",
      data: deflateRawSync(Buffer.from(xml, "utf8")),
      method: 8,
      declaredSize: 10,
    });
    await expect(convertDocx(data)).rejects.toMatchObject({ statusCode: 415 });
  });

  it("refuses corrupt deflate data", async () => {
    const data = docxWith({
      name: "word/document.xml",
      data: Buffer.from([0xff, 0xff, 0xff, 0xff]),
      method: 8,
      declaredSize: 100,
    });
    await expect(convertDocx(data)).rejects.toMatchObject({ statusCode: 415 });
  });

  it("refuses archives with too many entries", async () => {
    const extra = Array.from({ length: DOCX_LIMITS.maxEntries }, (_, i) =>
      stored(`word/extra/${i}.xml`, "<a/>"),
    );
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      extra,
    );
    await expect(convertDocx(data)).rejects.toMatchObject({ statusCode: 413 });
  });
});

/** Limits small enough that a bomb exhausts the converter quickly. */
const TEST_LIMITS: DocxLimits = { ...DOCX_LIMITS, converterHeapMb: 64 };

/** `count` attribute names that xmldom accepts without a value. */
const attributeNames = (count: number) =>
  Array.from({ length: count }, (_, i) => `a${i.toString(36)}`);

/** A deflated DOCX whose main part repeats `element` `times` times. */
function repeatedElementDocx(element: string, times: number): Buffer {
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
async function convertTimed(data: Buffer, limits: DocxLimits) {
  let longestStall = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 10);
  try {
    return await convertDocx(data, limits).then(
      (value) => ({ value, error: null, longestStall }),
      (error: unknown) => ({ value: null, error, longestStall }),
    );
  } finally {
    clearInterval(timer);
  }
}

// Every test spawns at least one converter process, about 0.6 s each here.
describe("convertDocx converter process", { timeout: 30_000 }, () => {
  // Each bomb below is a few dozen KB that xmldom, which mammoth parses with,
  // turns into hundreds of MB of DOM. In this process that meant gigabytes and
  // a stalled event loop; the converter process runs out of heap instead.

  it("refuses valueless attributes (`<w:p a b c/>`) past the converter heap", async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(200).join(" ")}/>`,
      5_000,
    );
    expect(data.length).toBeLessThan(64 * 1024);
    const { error, longestStall } = await convertTimed(data, TEST_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(2_000);
  });

  it('refuses quote-attached attributes (`a"x"b"y"`) past the converter heap', async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(200)
        .map((name) => `${name}"x"`)
        .join("")}/>`,
      5_000,
    );
    expect(data.length).toBeLessThan(64 * 1024);
    const { error, longestStall } = await convertTimed(data, TEST_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(2_000);
  });

  it("refuses more elements than the converter heap holds", async () => {
    const data = repeatedElementDocx("<w:p/>", 1_000_000);
    expect(data.length).toBeLessThan(64 * 1024);
    await expect(convertDocx(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("reports malformed markup that fits in the heap as an invalid file", async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(3).join(" ")}/>`,
      1,
    );
    await expect(convertDocx(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("stops a conversion that outlasts the timeout", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    await expect(
      convertDocx(data, { ...DOCX_LIMITS, converterTimeoutMs: 1 }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("refuses more HTML than the limits allow", async () => {
    const data = docxWith(
      stored(
        "word/document.xml",
        documentXml(
          ["Uno", "Dos", "Tres", "Cuatro"]
            .map((text) => p(null, text))
            .join(""),
        ),
      ),
    );
    await expect(
      convertDocx(data, { ...DOCX_LIMITS, maxHtmlBytes: 16 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      convertDocx(data, { ...DOCX_LIMITS, maxHtmlTags: 6 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    const result = await convertDocx(data, { ...DOCX_LIMITS, maxHtmlTags: 8 });
    expect(result.blocks.map((block) => block.text)).toEqual([
      "Uno",
      "Dos",
      "Tres",
      "Cuatro",
    ]);
  });

  it("ignores a style map embedded in the file", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      [stored("mammoth/style-map", "p => h1:fresh")],
    );
    const result = await convertDocx(data);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph"]);
  });

  it("queues concurrent imports and answers 429 when the queue is full", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    // One running and six waiting; the eighth is refused before any await.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => convertDocx(data)),
    );
    const refused = outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" &&
        (outcome.reason as { statusCode?: number }).statusCode === 429,
    );
    expect(refused).toHaveLength(1);
    expect(outcomes[7]!.status).toBe("rejected");
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(7);
  });
});
