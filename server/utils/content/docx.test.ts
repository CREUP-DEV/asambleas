import type { ChildProcess } from "node:child_process";
import { constants, deflateRawSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  BLOCK_ID_PATTERN,
  DOCUMENT_MAX_BLOCKS,
} from "../../../shared/utils/schemas/content";
import { convertDocx, DOCX_LIMITS, hasZipSignature } from "./docx";
import type { DocxLimits } from "./docx";

/** Output caps passed to inflateRawSync, to prove no entry inflates unbounded. */
const inflateCaps = vi.hoisted(() => [] as (number | undefined)[]);

/** Converter processes started, and a hook run right after each start. */
const converters = vi.hoisted(() => ({
  started: [] as ChildProcess[],
  onStart: null as (() => void) | null,
}));

// mammoth must only run in the converter process. If this process ever called
// it, every conversion below would fail.
vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess =
    await importOriginal<typeof import("node:child_process")>();
  const spawn = childProcess.spawn as (...args: unknown[]) => ChildProcess;
  return {
    ...childProcess,
    spawn: (...args: unknown[]) => {
      const child = spawn(...args);
      converters.started.push(child);
      converters.onStart?.();
      return child;
    },
  };
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
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

let owners = 0;

/** A fresh user for every conversion, so the per-user limit stays out of the way. */
function nextOwner(): string {
  return `user-${++owners}`;
}

function convert(data: Buffer, limits: DocxLimits = DOCX_LIMITS) {
  return convertDocx(data, { owner: nextOwner(), limits });
}

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

/** A paragraph holding only an inline picture, embedded as `rIdImg`. */
const imageParagraph = `<w:p><w:r><w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Imagen 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

/** The parts `imageParagraph` needs: the image, its type and relationship. */
const imageParts: Record<string, string> = {
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
    const result = await convert(data);
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
    // Shaped like the editor's cuid2 ids, and valid block ids.
    for (const block of result.blocks) {
      expect(block.id).toMatch(/^[a-z][a-z0-9]{23}$/);
      expect(block.id).toMatch(BLOCK_ID_PATTERN);
    }
    expect(new Set(result.blocks.map((b) => b.id)).size).toBe(5);
  });

  it("warns about tracked changes and comments", async () => {
    const data = await buildDocx(
      `<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>nuevo</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>viejo</w:delText></w:r></w:del></w:p>`,
      {
        "word/comments.xml": `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>Ojo</w:t></w:r></w:p></w:comment></w:comments>`,
      },
    );
    const result = await convert(data);
    expect(result.warnings).toEqual(["tracked_changes", "comments"]);
  });

  it("rejects non-docx data", async () => {
    await expect(convert(Buffer.from("%PDF-1.4 hello"))).rejects.toMatchObject({
      statusCode: 415,
    });
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const notDocx = await zip.generateAsync({ type: "nodebuffer" });
    await expect(convert(notDocx)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("rejects an empty document, telling it apart from a limit hit", async () => {
    const empty = { statusCode: 422, data: { reason: "empty" } };
    await expect(convert(await buildDocx("<w:p/>"))).rejects.toMatchObject(
      empty,
    );
    await expect(
      convert(await buildDocx(p(null, "   ") + p(null, ""))),
    ).rejects.toMatchObject(empty);

    // The other 422 carries no reason, so the client does not call a file
    // over the limits empty.
    const three = await buildDocx(
      p(null, "Uno") + p(null, "Dos") + p(null, "Tres"),
    );
    const error = await convert(three, { ...DOCX_LIMITS, maxBlocks: 2 }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ statusCode: 422 });
    expect((error as { data?: unknown }).data).toBeUndefined();
  });

  it("rejects a document of images alone as empty", async () => {
    // A scanned page pasted into Word: the image is dropped, no text is left.
    const data = await buildDocx(imageParagraph, imageParts);
    await expect(convert(data)).rejects.toMatchObject({
      statusCode: 422,
      data: { reason: "empty" },
    });
  });

  it("drops images and keeps the text around them, with a warning", async () => {
    const data = await buildDocx(p(null, "Texto") + imageParagraph, imageParts);
    const result = await convert(data);
    expect(result.blocks.map((block) => block.text)).toEqual(["Texto"]);
    expect(result.warnings).toEqual(["images_dropped"]);
  });

  it("converts a hand-written archive, so the zip helper is sound", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    const result = await convert(data);
    expect(result.blocks.map((b) => b.text)).toEqual(["Texto"]);
  });
});

describe("convertDocx archive limits", () => {
  beforeEach(() => {
    inflateCaps.length = 0;
  });

  it("accepts empty parts, stored or deflated", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      [
        stored("customXml/empty.xml", ""),
        {
          name: "customXml/deflated.xml",
          data: deflateRawSync(Buffer.alloc(0)),
          method: 8,
          declaredSize: 0,
        },
      ],
    );
    const result = await convert(data);
    expect(result.blocks.map((block) => block.text)).toEqual(["Texto"]);
  });

  it("never inflates an entry declared empty, whatever it stores", async () => {
    // JSZip drops the stored bytes of an entry declared empty, so mammoth
    // reads it as empty too.
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      [
        {
          name: "customXml/item1.xml",
          data: zeroBomb(64),
          method: 8,
          declaredSize: 0,
        },
      ],
    );
    const result = await convert(data);
    expect(result.blocks.map((block) => block.text)).toEqual(["Texto"]);
    expect(inflateCaps).toEqual([]);
  });

  it("refuses an empty main document part", async () => {
    const data = docxWith(stored("word/document.xml", ""));
    await expect(convert(data)).rejects.toMatchObject({ statusCode: 415 });
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
    await expect(convert(data)).rejects.toMatchObject({ statusCode: 413 });
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
      convert(data, { ...DOCX_LIMITS, maxUncompressedBytes: 2 * MiB }),
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
      convert(data, { ...DOCX_LIMITS, maxUncompressedBytes: MiB }),
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
    await expect(convert(data)).rejects.toMatchObject({ statusCode: 415 });
  });

  it("refuses corrupt deflate data", async () => {
    const data = docxWith({
      name: "word/document.xml",
      data: Buffer.from([0xff, 0xff, 0xff, 0xff]),
      method: 8,
      declaredSize: 100,
    });
    await expect(convert(data)).rejects.toMatchObject({ statusCode: 415 });
  });

  it("refuses archives with too many entries", async () => {
    const extra = Array.from({ length: DOCX_LIMITS.maxEntries }, (_, i) =>
      stored(`word/extra/${i}.xml`, "<a/>"),
    );
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
      extra,
    );
    await expect(convert(data)).rejects.toMatchObject({ statusCode: 413 });
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
    return await convert(data, limits).then(
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
    await expect(convert(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("reports malformed markup that fits in the heap as an invalid file", async () => {
    const data = repeatedElementDocx(
      `<w:p ${attributeNames(3).join(" ")}/>`,
      1,
    );
    await expect(convert(data, TEST_LIMITS)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("stops a conversion that outlasts the timeout", async () => {
    const data = docxWith(
      stored("word/document.xml", documentXml(p(null, "Texto"))),
    );
    await expect(
      convert(data, { ...DOCX_LIMITS, converterTimeoutMs: 1 }),
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
      convert(data, { ...DOCX_LIMITS, maxHtmlBytes: 16 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 6 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 8 });
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
    const result = await convert(data);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph"]);
  });
});

const isRefused = (outcome: PromiseSettledResult<unknown>, status: number) =>
  outcome.status === "rejected" &&
  (outcome.reason as { statusCode?: number }).statusCode === status;

describe("convertDocx queue", { timeout: 30_000 }, () => {
  const data = docxWith(
    stored("word/document.xml", documentXml(p(null, "Texto"))),
  );

  it("queues concurrent imports and answers 429 when the queue is full", async () => {
    const users = Array.from({ length: 8 }, nextOwner);
    // One running and six waiting; the eighth is refused before any await.
    const outcomes = await Promise.allSettled(
      users.map((owner) => convertDocx(data, { owner })),
    );
    expect(outcomes.filter((outcome) => isRefused(outcome, 429))).toHaveLength(
      1,
    );
    expect(isRefused(outcomes[7]!, 429)).toBe(true);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(7);
    // Refusing the eighth did not count it as running.
    await expect(convertDocx(data, { owner: users[7]! })).resolves.toEqual(
      expect.objectContaining({ blocks: [expect.anything()] }),
    );
  });

  it("allows each user one import running or waiting", async () => {
    const owner = nextOwner();
    const [first, second] = await Promise.allSettled([
      convertDocx(data, { owner }),
      convertDocx(data, { owner }),
    ]);
    expect(first!.status).toBe("fulfilled");
    expect(isRefused(second!, 429)).toBe(true);
    // Once the first is done, the same user may import again, even after a
    // conversion that failed.
    await expect(
      convertDocx(docxWith(stored("word/document.xml", "")), { owner }),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(convertDocx(data, { owner })).resolves.toEqual(
      expect.objectContaining({ blocks: [expect.anything()] }),
    );
  });

  it("does not let one user hold the queue", async () => {
    const owner = nextOwner();
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 7 }, () => convertDocx(data, { owner })),
      convertDocx(data, { owner: nextOwner() }),
    ]);
    expect(outcomes.filter((outcome) => isRefused(outcome, 429))).toHaveLength(
      6,
    );
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect(outcomes[7]!.status).toBe("fulfilled");
  });

  it("lets a user whose queued import was cancelled import again at once", async () => {
    const before = converters.started.length;
    const owner = nextOwner();
    const cancel = new AbortController();
    const running = convertDocx(data, { owner: nextOwner() });
    const queued = convertDocx(data, { owner, signal: cancel.signal });
    cancel.abort();
    // Still behind the running import: queued again, not refused.
    const again = convertDocx(data, { owner });
    const [cancelled, first, second] = await Promise.allSettled([
      queued,
      running,
      again,
    ]);
    expect(isRefused(cancelled!, 499)).toBe(true);
    expect(first!.status).toBe("fulfilled");
    expect(second!.status).toBe("fulfilled");
    expect(converters.started.length - before).toBe(2);
  });

  it("refuses an import whose client is already gone without queueing it", async () => {
    const owner = nextOwner();
    await expect(
      convertDocx(data, { owner, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ statusCode: 499 });
    await expect(convertDocx(data, { owner })).resolves.toBeDefined();
  });

  it("skips a queued import whose client went away", async () => {
    const before = converters.started.length;
    const cancel = new AbortController();
    const running = convertDocx(data, { owner: nextOwner() });
    const queued = convertDocx(data, {
      owner: nextOwner(),
      signal: cancel.signal,
    });
    cancel.abort();
    await expect(queued).rejects.toMatchObject({ statusCode: 499 });
    await expect(running).resolves.toBeDefined();
    expect(converters.started.length - before).toBe(1);
    // The slot it held was passed on.
    await expect(convert(data)).resolves.toBeDefined();
  });

  it("stops a running import whose client went away", async () => {
    const cancel = new AbortController();
    converters.onStart = () => setImmediate(() => cancel.abort());
    try {
      await expect(
        convertDocx(data, { owner: nextOwner(), signal: cancel.signal }),
      ).rejects.toMatchObject({ statusCode: 499 });
    } finally {
      converters.onStart = null;
    }
    expect(converters.started.at(-1)!.killed).toBe(true);
    await expect(convert(data)).resolves.toBeDefined();
  });
});

const cell = (content: string) => `<w:tc>${content}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl>${rows.join("")}</w:tbl>`;

/** `levels` tables, each in the only cell of the one around it. */
function nestedTables(levels: number, inner: string): string {
  let body = inner;
  for (let level = 0; level < levels; level++) body = table(row(cell(body)));
  return body;
}

/** A run of `text` in bold italic. */
const boldItalic = (text: string) =>
  `<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

const LINK_RELATIONSHIPS = stored(
  "word/_rels/document.xml.rels",
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://creup.es" TargetMode="External"/></Relationships>`,
);

/** A deflated DOCX whose main part has `body`, with a hyperlink `rIdL`. */
function deflatedDocx(body: string): Buffer {
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
const NUMBERING = stored(
  "word/numbering.xml",
  `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${Array.from(
    { length: 9 },
    (_, level) => `<w:lvl w:ilvl="${level}"><w:numFmt w:val="bullet"/></w:lvl>`,
  ).join(
    "",
  )}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
);

/** A deflated DOCX whose main part has `body`, with the bullets of NUMBERING. */
function listDocx(body: string): Buffer {
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
const item = (level: number, runs: string) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>${runs}</w:p>`;

/** A run of `text`. */
const run = (text: string) =>
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** `count` short lines of text separated by line breaks, in one run. */
const lines = (count: number) =>
  `<w:r>${"<w:t>x</w:t><w:br/>".repeat(count)}<w:t>x</w:t></w:r>`;

/** `bytes` of words separated by spaces, which the walk collapses one by one. */
const spaced = (bytes: number) => "a ".repeat(Math.floor(bytes / 2));

// Parsing and walking the converter's HTML runs on this process's event loop.
// Before these bounds, a 4 KB file of 30,000 paragraphs blocked it for 22 s,
// and an 8 KB file of 7 MB of text in nested tables for 38 s. The stall
// ceilings below are loose so that a busy machine does not fail them; the
// bounds keep the real stalls far below.
describe("convertDocx HTML bounds", { timeout: 60_000 }, () => {
  it("refuses a tiny file of 30,000 paragraphs without stalling", async () => {
    const data = deflatedDocx(p(null, "x").repeat(30_000));
    expect(data.length).toBeLessThan(16 * 1024);
    const started = Date.now();
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("still converts 3,000 paragraphs, the block limit", async () => {
    // Each entity becomes nodes of its own; a few per paragraph are fine.
    const data = deflatedDocx(
      p(null, "Texto de I+D &amp; innovación: 3 &lt; 4 y 5 &gt; 2.").repeat(
        DOCUMENT_MAX_BLOCKS,
      ),
    );
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.text).toBe(
      "Texto de I+D & innovación: 3 < 4 y 5 > 2.",
    );
    expect(new Set(value!.blocks.map((block) => block.id)).size).toBe(
      DOCUMENT_MAX_BLOCKS,
    );
    expect(longestStall).toBeLessThan(3_000);
  });

  it("still converts 3,000 densely formatted paragraphs", async () => {
    // Ten bold or italic words among plain text: about 93,000 nodes.
    let paragraph = "";
    for (let word = 0; word < 10; word++) {
      const style = word % 2 ? "<w:b/>" : "<w:i/>";
      paragraph += `<w:r><w:rPr>${style}</w:rPr><w:t>palabra</w:t></w:r><w:r><w:t xml:space="preserve"> y </w:t></w:r>`;
    }
    const data = deflatedDocx(
      `<w:p>${paragraph}</w:p>`.repeat(DOCUMENT_MAX_BLOCKS),
    );
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.marks).toHaveLength(10);
    expect(longestStall).toBeLessThan(3_000);
  });

  it("stops the walk at the first block past the limit", async () => {
    // Few enough paragraphs to pass the element count before parsing.
    const data = deflatedDocx(p(null, "x").repeat(DOCUMENT_MAX_BLOCKS + 200));
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(3_000);

    const three = deflatedDocx(
      p(null, "Uno") + p(null, "Dos") + p(null, "Tres"),
    );
    await expect(
      convert(three, { ...DOCX_LIMITS, maxBlocks: 2 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(three, { ...DOCX_LIMITS, maxBlocks: 3 });
    expect(result.blocks).toHaveLength(3);
  });

  it("counts the elements the walk visits, text or not", async () => {
    const data = deflatedDocx(p(null, " ").repeat(3) + p(null, "Texto"));
    await expect(
      convert(data, { ...DOCX_LIMITS, maxBlockElements: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(data, { ...DOCX_LIMITS, maxBlockElements: 4 });
    expect(result.blocks.map((block) => block.text)).toEqual(["Texto"]);
  });

  it("counts table rows, not the paragraphs in their cells", async () => {
    const twoRows = table(
      row(cell(p(null, "a")), cell(p(null, "b")), cell(p(null, "c"))),
      row(cell(p(null, "d")), cell(p(null, "e")), cell(p(null, "f"))),
    );
    const data = deflatedDocx(twoRows);
    const result = await convert(data, { ...DOCX_LIMITS, maxBlockElements: 2 });
    expect(result.blocks.map((block) => block.text)).toEqual([
      "a | b | c",
      "d | e | f",
    ]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxBlockElements: 1 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses tables nested deeper than the limit", async () => {
    // table > tr > td > table > tr > td > p
    const data = deflatedDocx(nestedTables(2, p(null, "x")));
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlDepth: 7 });
    expect(result.blocks.map((block) => block.text)).toEqual(["x | x", "x"]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlDepth: 6 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Each nested table makes the walk read every cell below it again: 300
    // levels took 0.6 s, and the cost grows with the cube of the depth.
    const deep = deflatedDocx(nestedTables(150, p(null, "x")));
    const { error, longestStall } = await convertTimed(deep, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("counts one mark per formatting element around each run of text", async () => {
    const data = deflatedDocx(`<w:p>${boldItalic("x")}</w:p>`);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxMarks: 1 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(data, { ...DOCX_LIMITS, maxMarks: 2 });
    expect(result.blocks[0]!.marks.map((mark) => mark.type).sort()).toEqual([
      "bold",
      "italic",
    ]);
  });

  it("refuses marks multiplied by nested links without stalling", async () => {
    // Every run of text inside 26 nested links gets 28 marks.
    let body = boldItalic("x").replace(
      "</w:t></w:r>",
      `</w:t>${"<w:br/><w:t>x</w:t>".repeat(10_000)}</w:r>`,
    );
    for (let level = 0; level < 26; level++) {
      body = `<w:hyperlink r:id="rIdL">${body}</w:hyperlink>`;
    }
    const data = deflatedDocx(`<w:p>${body}</w:p>`);
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("refuses long text without stalling, in nested tables or not", async () => {
    // The walk collapses the spaces of every cell nested in a row again for
    // each row and cell around it: 55 times ten tables deep.
    const nested = deflatedDocx(nestedTables(10, p(null, spaced(3 * MiB))));
    expect(nested.length).toBeLessThan(16 * 1024);
    const inTables = await convertTimed(nested, DOCX_LIMITS);
    expect(inTables.error).toMatchObject({ statusCode: 422 });
    expect(inTables.longestStall).toBeLessThan(1_000);

    const paragraph = deflatedDocx(p(null, spaced(7 * MiB)));
    const alone = await convertTimed(paragraph, DOCX_LIMITS);
    expect(alone.error).toMatchObject({ statusCode: 422 });
    expect(alone.longestStall).toBeLessThan(1_000);
  });

  it("counts the text of each block, rows with everything nested in them", async () => {
    const limits = { ...DOCX_LIMITS, maxBlockTextBytes: 4 };
    const paragraphs = deflatedDocx(p(null, "abcd") + p(null, "efgh"));
    const result = await convert(paragraphs, limits);
    expect(result.blocks.map((block) => block.text)).toEqual(["abcd", "efgh"]);
    await expect(
      convert(paragraphs, { ...limits, maxBlockTextBytes: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const rows = deflatedDocx(
      table(
        row(cell(p(null, "ab")), cell(p(null, "cd"))),
        row(cell(p(null, "ef")), cell(nestedTables(1, p(null, "gh")))),
      ),
    );
    const tableResult = await convert(rows, limits);
    expect(tableResult.blocks.map((block) => block.text)).toEqual([
      "ab | cd",
      "ef | gh | gh",
      "gh",
    ]);
    await expect(
      convert(rows, { ...limits, maxBlockTextBytes: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("counts again the text nested tables make the walk read again", async () => {
    const text = "a".repeat(1_000);
    const limits = { ...DOCX_LIMITS, maxWalkReads: 2_000 };
    // Read once outside tables, three times two tables deep.
    const plain = await convert(deflatedDocx(p(null, text)), limits);
    expect(plain.blocks.map((block) => block.text)).toEqual([text]);
    const nested = deflatedDocx(nestedTables(2, p(null, text)));
    await expect(convert(nested, limits)).rejects.toMatchObject({
      statusCode: 422,
    });
    const result = await convert(nested);
    expect(result.blocks.map((block) => block.text)).toEqual([
      `${text} | ${text}`,
      text,
    ]);
  });

  it("refuses text read again in many nested tables without stalling", async () => {
    // Each table alone fits in the budget; together they do not.
    const data = deflatedDocx(
      nestedTables(10, p(null, spaced(20 * 1024))).repeat(8),
    );
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);

    // Nodes count as well as text: 45,000 line breaks ten tables deep.
    const breaks = deflatedDocx(
      nestedTables(10, `<w:p>${lines(45_000)}</w:p>`),
    );
    const nodes = await convertTimed(breaks, DOCX_LIMITS);
    expect(nodes.error).toMatchObject({ statusCode: 422 });
    expect(nodes.longestStall).toBeLessThan(1_000);
  });

  it("counts a text node for every entity", async () => {
    // `a &amp; b`: three text nodes in one paragraph.
    const data = deflatedDocx(p(null, "a &amp; b"));
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 4 });
    expect(result.blocks.map((block) => block.text)).toEqual(["a & b"]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 3 }),
    ).rejects.toMatchObject({ statusCode: 413 });

    // Each of them takes the marks around it.
    const bold = deflatedDocx(p(null, "a&amp;b", true));
    await expect(
      convert(bold, { ...DOCX_LIMITS, maxMarks: 3 }),
    ).resolves.toBeDefined();
    await expect(
      convert(bold, { ...DOCX_LIMITS, maxMarks: 2 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a tiny file full of entities without stalling", async () => {
    // 120,000 text nodes. Counted as one each, 7 MB of them blocked the
    // event loop for 7.8 s.
    const data = deflatedDocx(p(null, "&amp;".repeat(15_000)).repeat(4));
    expect(data.length).toBeLessThan(16 * 1024);
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("counts the copies the walk makes of nested list items", async () => {
    // Flat, each node is copied once: four. Nested, the second item and its
    // text three times each, and its list once: nine.
    const flat = listDocx(item(0, run("a")) + item(0, run("b")));
    const nested = listDocx(item(0, run("a")) + item(1, run("b")));
    const limits = { ...DOCX_LIMITS, maxListCopies: 5 };
    const result = await convert(flat, limits);
    expect(
      result.blocks.map((block) => [block.type, block.level, block.text]),
    ).toEqual([
      ["list_item", 0, "a"],
      ["list_item", 0, "b"],
    ]);
    await expect(convert(nested, limits)).rejects.toMatchObject({
      statusCode: 422,
    });
    const nestedResult = await convert(nested);
    expect(nestedResult.blocks.map((block) => block.level)).toEqual([0, 1]);
  });

  it("refuses deeply nested list items without stalling", async () => {
    // 90,000 nodes five lists deep took 2 to 3.5 s to walk.
    let body = "";
    for (let level = 0; level < 4; level++) body += item(level, run("x"));
    const data = listDocx(body + item(4, lines(45_000)));
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("still converts a list of 3,000 densely formatted items", async () => {
    let runs = "";
    for (let word = 0; word < 10; word++) {
      const style = word % 2 ? "<w:b/>" : "<w:i/>";
      runs += `<w:r><w:rPr>${style}</w:rPr><w:t>palabra</w:t></w:r>${run(" y ")}`;
    }
    const data = listDocx(item(0, runs).repeat(DOCUMENT_MAX_BLOCKS));
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.type).toBe("list_item");
    expect(longestStall).toBeLessThan(3_000);
  });
});
