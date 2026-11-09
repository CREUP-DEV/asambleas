import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../types/content";
import { consolidate } from "./consolidate";
import { diffPassage } from "./diff";
import { blocksToEditor, editorToBlocks } from "./editor";
import { renderAnnotated, renderBlocks } from "./render";
import { validateOps } from "./ops";
import { blocksSchema } from "../schemas/content";

/** Image blocks through every path a block travels (phase 1 of images). */

let counter = 0;
const newId = () => `new${String(counter++).padStart(4, "0")}`;

const ASSET = "q8w2e9r1t7y3u6i4o0p5a2s8";

const paragraph = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const image = (id: string, alt = "Logo de CREUP"): Block => ({
  id,
  type: "image",
  image: { asset: ASSET, width: 800, height: 400, alt },
  text: "",
  marks: [],
});

const base: Block[] = [
  paragraph("blk001", "Antes de la imagen."),
  image("img001"),
  paragraph("blk002", "Después de la imagen."),
];

describe("image blocks", () => {
  it("validate and keep their picture, never any text", () => {
    const parsed = blocksSchema.parse([
      {
        ...image("img002", "  Gráfico\n de cuentas  "),
        text: "texto colado",
        level: 3,
      },
    ]);
    expect(parsed).toEqual([
      {
        id: "img002",
        type: "image",
        image: {
          asset: ASSET,
          width: 800,
          height: 400,
          alt: "Gráfico de cuentas",
        },
        text: "",
        marks: [],
      },
    ]);
  });

  it("refuse a block without its picture, a bad asset id, or a table cell", () => {
    const bare = { id: "img003", type: "image", text: "", marks: [] };
    expect(blocksSchema.safeParse([bare]).success).toBe(false);
    expect(
      blocksSchema.safeParse([
        {
          ...image("img004"),
          image: { asset: "../etc/passwd", width: 1, height: 1, alt: "" },
        },
      ]).success,
    ).toBe(false);
    expect(
      blocksSchema.safeParse([
        {
          ...image("img005"),
          cell: { table: "tab1", row: "row1", cell: "cel1" },
        },
      ]).success,
    ).toBe(false);
  });

  it("leave the picture out of other blocks", () => {
    const [parsed] = blocksSchema.parse([
      { ...paragraph("blk003", "Texto"), image: image("x").image },
    ]);
    expect(parsed).not.toHaveProperty("image");
  });

  it("survive a round trip through the editor", () => {
    const doc = blocksToEditor(base);
    expect(doc.content!.map((node) => node.type)).toEqual([
      "paragraph",
      "blockImage",
      "paragraph",
    ]);
    expect(doc.content![1]!.attrs).toMatchObject({
      blockId: "img001",
      asset: ASSET,
      alt: "Logo de CREUP",
    });
    expect(editorToBlocks(doc, newId)).toEqual(base);
  });

  it("drop an editor image that is not a stored one", () => {
    const doc = blocksToEditor(base);
    doc.content![1]!.attrs = { blockId: "img001", asset: "https://x.y/z.png" };
    expect(editorToBlocks(doc, newId).map((block) => block.id)).toEqual([
      "blk001",
      "blk002",
    ]);
  });

  it("render as an escaped figure pointing to the stored image only", () => {
    const html = renderBlocks([image("img006", '"><script>x</script>')]);
    expect(html).toContain(
      `<figure data-block-id="img006" class="cx-figure"><img src="/api/uploads/images/${ASSET}"`,
    );
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(html).not.toContain("<script>");
  });

  it("are inserted and deleted by amendments, and kept when untouched", () => {
    const inserted = image("img007", "Nuevo gráfico");
    const ops = diffPassage(base, [...base, inserted], null, newId);
    expect(ops).toEqual([
      { op: "insert", afterBlockId: "blk002", blocks: [inserted] },
    ]);
    expect(validateOps(base, ops)).toEqual([]);

    const removal = diffPassage(base, [base[0]!, base[2]!], null, newId);
    expect(removal).toEqual([{ op: "delete", blockIds: ["img001"] }]);
    expect(diffPassage(base, base, null, newId)).toEqual([]);
  });

  it("keep their picture through consolidation", () => {
    const ops: AmendmentOp[] = [
      {
        op: "insert",
        afterBlockId: "blk002",
        blocks: [image("img008", "Anexo")],
      },
      { op: "delete", blockIds: ["img001"] },
    ];
    const result = consolidate(base, [{ id: "am1", ops }]);
    expect(result.blocks.map((block) => [block.id, block.image?.alt])).toEqual([
      ["blk001", undefined],
      ["blk002", undefined],
      ["img008", "Anexo"],
    ]);
    const annotated = renderAnnotated(result.annotated, { mode: "diff" });
    expect(annotated.match(/<img /g)).toHaveLength(2);
  });

  it("say to screen readers, in a diff, that they were added or removed", () => {
    const ops: AmendmentOp[] = [
      {
        op: "insert",
        afterBlockId: "blk002",
        blocks: [image("img009", "Anexo")],
      },
      { op: "delete", blockIds: ["img001"] },
    ];
    const result = consolidate(base, [{ id: "am1", ops }]);
    const html = renderAnnotated(result.annotated, {
      mode: "diff",
      diffLabels: { inserted: "Imagen añadida", removed: "Imagen quitada" },
    });
    expect(html).toMatch(
      /<figure [^>]*class="[^"]*cx-block-deleted[^"]*"[^>]*><span class="sr-only">Imagen quitada ?<\/span><img /,
    );
    expect(html).toMatch(
      /<figure [^>]*class="[^"]*cx-block-inserted[^"]*"[^>]*><span class="sr-only">Imagen añadida ?<\/span><img /,
    );
    // The clean text says nothing and leaves the removed one out.
    const clean = renderAnnotated(result.annotated, { mode: "clean" });
    expect(clean).not.toContain("sr-only");
    expect(clean.match(/<img /g)).toHaveLength(1);
  });
});
