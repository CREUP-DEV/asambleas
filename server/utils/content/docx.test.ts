// DOCX import: conversion, images and archive limits. The converter's tests are
// split over docx*.test.ts so that Vitest runs them side by side, since each
// spawns its converter processes one after another; their builders live in
// server/testing/docx.ts.

import { deflateRawSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { BLOCK_ID_PATTERN } from "../../../shared/utils/schemas/content";
import { convertDocx, DOCX_LIMITS, hasZipSignature } from "./docx";
import {
  W,
  nextOwner,
  convert,
  buildDocx,
  p,
  imageParagraph,
  imageParts,
  MiB,
  stored,
  zeroBomb,
  docxWith,
  documentXml,
} from "../../testing/docx";

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
    // The Word title is no heading: Heading 1 keeps level 1 to itself.
    expect(result.blocks.map((b) => [b.type, b.level ?? null, b.text])).toEqual(
      [
        ["paragraph", null, "Resolución sobre becas"],
        ["heading", 1, "Artículo 1"],
        ["paragraph", null, "Texto normal"],
        ["paragraph", null, "Hola mundo"],
        ["heading", 2, "Sección"],
      ],
    );
    expect(result.blocks[0]!.marks).toEqual([
      { type: "bold", from: 0, to: 22 },
    ]);
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
    // The code before ARQ-1 for one release (the client reads it as
    // `docx_empty`); `docx_empty` itself in the release after.
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

  describe("with images stored", () => {
    /** Stores every picture as asset `img…`, counting the calls. */
    function storing() {
      const stored: Buffer[] = [];
      return {
        stored,
        storeImage: async (data: Buffer) => {
          stored.push(data);
          return {
            asset: `img${stored.length}xxxxxxxxxxxxxxxxxxx`,
            width: 640,
            height: 480,
          };
        },
      };
    }

    /** The picture of `imageParagraph`, with a description. */
    const described = imageParagraph.replace(
      'name="Imagen 1"',
      'name="Imagen 1" descr="Logo de CREUP"',
    );

    it("keeps a picture as its own block, between the text", async () => {
      const store = storing();
      const data = await buildDocx(
        p(null, "Antes") + described + p(null, "Después"),
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: store.storeImage,
      });
      expect(result.warnings).toEqual([]);
      expect(result.blocks.map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "Antes"],
        ["image", ""],
        ["paragraph", "Después"],
      ]);
      expect(result.blocks[1]!.image).toEqual({
        asset: "img1xxxxxxxxxxxxxxxxxxx",
        width: 640,
        height: 480,
        alt: "Logo de CREUP",
      });
      expect(store.stored.map((data) => data.toString())).toEqual([
        "not really a png",
      ]);
    });

    it("lifts a picture out of the paragraph it sits in", async () => {
      const store = storing();
      const run = described.slice("<w:p>".length, -"</w:p>".length);
      const data = await buildDocx(
        `<w:p><w:r><w:t xml:space="preserve">Antes </w:t></w:r>${run}<w:r><w:t>después</w:t></w:r></w:p>`,
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: store.storeImage,
      });
      expect(result.blocks.map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "Antes"],
        ["image", ""],
        ["paragraph", "después"],
      ]);
    });

    it("warns about a picture with no description", async () => {
      const data = await buildDocx(
        p(null, "Texto") + imageParagraph,
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: storing().storeImage,
      });
      expect(result.blocks[1]!.image?.alt).toBe("");
      expect(result.warnings).toEqual(["images_without_alt"]);
    });

    it("leaves out a picture it could not store, with a warning", async () => {
      const data = await buildDocx(p(null, "Texto") + described, imageParts);
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: async () => null,
      });
      expect(result.blocks.map((block) => block.type)).toEqual(["paragraph"]);
      expect(result.warnings).toEqual(["images_dropped"]);
    });

    it("keeps a picture in a one-column table, which is only layout", async () => {
      const data = await buildDocx(
        p(null, "Texto") +
          `<w:tbl><w:tr><w:tc>${described}</w:tc></w:tr></w:tbl>`,
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: storing().storeImage,
      });
      expect(result.blocks.map((block) => block.type)).toEqual([
        "paragraph",
        "image",
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("leaves out a picture inside a table, with a warning", async () => {
      const data = await buildDocx(
        p(null, "Texto") +
          `<w:tbl><w:tr><w:tc>${p(null, "Celda")}</w:tc><w:tc>${described}</w:tc></w:tr></w:tbl>`,
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        storeImage: storing().storeImage,
      });
      expect(result.blocks.some((block) => block.type === "image")).toBe(false);
      expect(result.warnings).toContain("images_in_tables");
    });

    it("leaves out pictures past the count limit", async () => {
      const store = storing();
      const data = await buildDocx(
        p(null, "Texto") + described + described,
        imageParts,
      );
      const result = await convertDocx(data, {
        owner: nextOwner(),
        limits: { ...DOCX_LIMITS, maxImages: 1 },
        storeImage: store.storeImage,
      });
      expect(
        result.blocks.filter((block) => block.type === "image"),
      ).toHaveLength(1);
      expect(store.stored).toHaveLength(1);
      expect(result.warnings).toEqual(["images_dropped"]);
    });
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
