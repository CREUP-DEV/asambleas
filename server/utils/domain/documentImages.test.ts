import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageFileName, processImage } from "./documentImages";

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

describe("imageFileName", () => {
  it("names a stored image by its id and type only", () => {
    expect(imageFileName("q8w2e9r1t7y3u6i4o0p5a2s8", "image/png")).toBe(
      "q8w2e9r1t7y3u6i4o0p5a2s8.png",
    );
    expect(imageFileName("q8w2e9r1t7y3u6i4o0p5a2s8", "image/gif")).toBeNull();
    expect(imageFileName("../../etc/passwd", "image/png")).toBeNull();
  });
});
