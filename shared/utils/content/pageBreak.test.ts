import { describe, expect, it } from "vitest";
import type { Block } from "../../types/content";
import { blocksSchema } from "../schemas/content";
import { consolidate } from "./consolidate";
import { blocksToEditor, editorToBlocks } from "./editor";
import { blockFormatChanges, blockFormatOf } from "./format";
import { renderBlocks } from "./render";

/**
 * «Empezar en una página nueva» (Block.pageBreak, user's decision of
 * 2026-11-26): stored on headings and paragraphs outside tables, carried by
 * the editor, the amendments and the views.
 */

const p = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
  ...extra,
});

describe("the stored block", () => {
  it("keeps it on a heading or a paragraph", () => {
    const [heading, paragraph] = blocksSchema.parse([
      {
        id: "head1",
        type: "heading",
        level: 1,
        text: "Anexo",
        pageBreak: true,
      },
      { id: "para1", type: "paragraph", text: "Texto", pageBreak: true },
    ]);
    expect(heading!.pageBreak).toBe(true);
    expect(paragraph!.pageBreak).toBe(true);
  });

  it("drops it on a list, a quote or a table cell, and when false", () => {
    const blocks = blocksSchema.parse([
      {
        id: "list1",
        type: "list_item",
        list: "bullet",
        text: "x",
        pageBreak: true,
      },
      { id: "quot1", type: "quote", text: "x", pageBreak: true },
      {
        id: "cell1",
        type: "paragraph",
        text: "x",
        pageBreak: true,
        cell: { table: "tab01", row: "row01", cell: "cel01" },
      },
      { id: "fals1", type: "paragraph", text: "x", pageBreak: false },
    ]);
    for (const block of blocks) expect(block).not.toHaveProperty("pageBreak");
  });
});

describe("the editor", () => {
  it("reads back what it was given", () => {
    const blocks: Block[] = [
      p("a", "Uno"),
      {
        id: "b",
        type: "heading",
        level: 1,
        text: "Anexo",
        marks: [],
        pageBreak: true,
      },
      p("c", "Dos", { pageBreak: true }),
    ];
    let n = 0;
    expect(editorToBlocks(blocksToEditor(blocks), () => `n${++n}`)).toEqual(
      blocks,
    );
  });
});

describe("an amendment", () => {
  it("says it starts a block on a new page, or stops doing so", () => {
    const before = blockFormatOf(p("a", "x"))!;
    const after = blockFormatOf(p("a", "x", { pageBreak: true }))!;
    expect(blockFormatChanges(before, after)).toEqual([
      { code: "page_break_on" },
    ]);
    expect(blockFormatChanges(after, before)).toEqual([
      { code: "page_break_off" },
    ]);
  });

  it("carries it into the consolidated text, both ways", () => {
    const base = [p("a", "Uno"), p("b", "Dos", { pageBreak: true })];
    const { blocks } = consolidate(base, [
      {
        id: "E1",
        ops: [
          {
            op: "replace",
            blockId: "a",
            from: 0,
            to: 0,
            text: "",
            baseText: "",
            block: { type: "paragraph", pageBreak: true },
          },
          {
            op: "replace",
            blockId: "b",
            from: 0,
            to: 0,
            text: "",
            baseText: "",
            block: { type: "paragraph" },
          },
        ],
      },
    ]);
    expect(blocks[0]!.pageBreak).toBe(true);
    expect(blocks[1]).not.toHaveProperty("pageBreak");
  });
});

describe("the views", () => {
  it("mark the block that starts a new page", () => {
    const html = renderBlocks([
      p("a", "Uno"),
      p("b", "Dos", { pageBreak: true }),
    ]);
    expect(html).toMatch(/data-block-id="b"[^>]*class="[^"]*cx-page-break/);
    expect(html).not.toMatch(/data-block-id="a"[^>]*cx-page-break/);
  });
});
