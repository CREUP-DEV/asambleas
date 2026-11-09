import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageAssetId, imageFileName, processImage } from "./documentImages";
import { IMAGE_ASSET_PATTERN } from "../../../shared/types/content";

/** Uploaded pictures are checked, then written again by sharp. */

const solid = (format: "png" | "jpeg", width = 40, height = 20) =>
  sharp({
    create: { width, height, channels: 3, background: "#792225" },
  })
    [format]()
    .toBuffer();

describe("processImage", () => {
  it("keeps a PNG a PNG and a JPEG a JPEG, with their size", async () => {
    const png = await processImage(await solid("png"));
    expect(png).toMatchObject({ mimeType: "image/png", width: 40, height: 20 });
    expect((await sharp(png.data).metadata()).format).toBe("png");

    const jpeg = await processImage(await solid("jpeg"));
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", width: 40 });
    expect((await sharp(jpeg.data).metadata()).format).toBe("jpeg");
  });

  it("turns a photo upright and drops its metadata (location, camera)", async () => {
    // Stored sideways, with orientation 6: shown 20 wide and 40 tall.
    const photo = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#fff" },
    })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: "Fone" } } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const stored = await processImage(photo);
    expect(stored).toMatchObject({ width: 20, height: 40 });
    const metadata = await sharp(stored.data).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it("makes large pictures smaller, never larger", async () => {
    const large = await processImage(await solid("png", 4000, 1000));
    expect(large).toMatchObject({ width: 2400, height: 600 });
  });

  it("refuses what is not a PNG or a JPEG, or only looks like one", async () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
    await expect(processImage(gif)).rejects.toMatchObject({ statusCode: 415 });

    // A PNG signature in front of something else (an HTML page, say).
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("<html><script>alert(1)</script></html>"),
    ]);
    await expect(processImage(fake)).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe("processImage for a Word file's pictures", () => {
  const coloured = (format: "gif" | "webp" | "tiff") =>
    sharp({
      create: { width: 30, height: 10, channels: 3, background: "#792225" },
    })
      [format]()
      .toBuffer();

  it("takes GIF, WebP and TIFF, written again as PNG", async () => {
    for (const format of ["gif", "webp", "tiff"] as const) {
      const input = await coloured(format);
      // An upload never takes them.
      await expect(processImage(input)).rejects.toMatchObject({
        statusCode: 415,
      });
      const stored = await processImage(input, "import");
      expect(stored).toMatchObject({
        mimeType: "image/png",
        width: 30,
        height: 10,
      });
      expect((await sharp(stored.data).metadata()).format).toBe("png");
    }
  });

  it("still refuses what sharp cannot read (Office's EMF, SVG)", async () => {
    const emf = Buffer.from([0x01, 0, 0, 0, 0x6c, 0, 0, 0, 0, 0, 0, 0]);
    await expect(processImage(emf, "import")).rejects.toMatchObject({
      statusCode: 415,
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(processImage(svg, "import")).rejects.toMatchObject({
      statusCode: 415,
    });
  });
});

describe("imageAssetId", () => {
  it("is the same for the same picture and document, a valid asset id", () => {
    const picture = Buffer.from("picture");
    const id = imageAssetId("doc1", picture);
    expect(id).toMatch(IMAGE_ASSET_PATTERN);
    expect(imageAssetId("doc1", Buffer.from("picture"))).toBe(id);
    // Another document, or another picture, never shares it.
    expect(imageAssetId("doc2", picture)).not.toBe(id);
    expect(imageAssetId("doc1", Buffer.from("picturf"))).not.toBe(id);
  });
});

describe("imageFileName", () => {
  it("names a stored image by its id and type only", () => {
    expect(imageFileName("q8w2e9r1t7y3u6i4o0p5a2s8", "image/png")).toBe(
      "q8w2e9r1t7y3u6i4o0p5a2s8.png",
    );
    expect(imageFileName("q8w2e9r1t7y3u6i4o0p5a2s8", "image/gif")).toBeNull();
    expect(imageFileName("../../etc/passwd", "image/png")).toBeNull();
  });
});
