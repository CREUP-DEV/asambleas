import { describe, expect, it } from "vitest";
import type { Block, ConsolidatedBlock } from "../../types/content";
import { blocksSchema } from "../schemas/content";
import { blocksToEditor, editorToBlocks } from "./editor";
import { formulaRuns, isSafeMathMl, renderFormula } from "./formula";
import { renderAnnotated, renderBlocks, renderInline } from "./render";

const formulaBlock: Block = {
  id: "form1",
  type: "formula",
  text: "IFBAP_{c,t} = \\frac{FBA_{c,t}}{PIB_{c,t}} \\cdot 100",
  marks: [],
};
const sentence: Block = {
  id: "para1",
  type: "paragraph",
  text: "Donde FBA_{c,t} es la financiación basal.",
  marks: [
    { type: "formula", from: 6, to: 15 },
    { type: "bold", from: 16, to: 41 },
  ],
};

describe("renderFormula", () => {
  it("draws a formula as MathML, inline or displayed", () => {
    const inline = renderFormula("x_{i}", false);
    expect(inline).toMatch(/^<math[\s>]/);
    expect(inline).toContain("<msub>");
    const display = renderFormula("\\frac{a}{b}", true);
    expect(display).toMatch(/^<div class="cx-formula"><math/);
    expect(display).toContain("<mfrac>");
  });

  it("shows the source of a formula that does not parse", () => {
    expect(renderFormula("\\frac{1}{", true)).toBe(
      '<div class="cx-formula cx-formula-error"><code class="cx-formula-source">\\frac{1}{</code></div>',
    );
  });

  it("never lets a link, a script or markup through", () => {
    for (const source of [
      "\\href{javascript:alert(1)}{x}",
      "\\url{http://example.com}",
      "\\htmlClass{x}{y}",
      "<script>alert(1)</script>",
      "\\text{<img src=x onerror=alert(1)>}",
    ]) {
      const html = renderFormula(source, true);
      expect(html).not.toMatch(/<(a|script|img|span|style)[\s>]/i);
      // Inside a tag: text such as "&lt;img src=x&gt;" is escaped content.
      expect(html).not.toMatch(/<[^>]*\s(href|src|on\w+)=/i);
    }
  });

  it("accepts only the MathML of the allowlist", () => {
    expect(isSafeMathMl("<math><mi>x</mi></math>")).toBe(true);
    expect(isSafeMathMl('<math><a href="x">y</a></math>')).toBe(false);
    expect(isSafeMathMl('<math><mi onclick="x">y</mi></math>')).toBe(false);
    expect(
      isSafeMathMl('<math><mi style="background:url(x)">y</mi></math>'),
    ).toBe(false);
    expect(isSafeMathMl("<math><mi>x</mi></math><script>")).toBe(false);
  });
});

describe("formulaRuns", () => {
  it("reads a formula as text with its scripts raised and lowered", () => {
    expect(formulaRuns("IFBAP_{c,t}")).toEqual([
      { text: "IFBAP" },
      { text: "c,t", script: "sub" },
    ]);
    expect(formulaRuns("x^2 + \\frac{a + b}{c} \\cdot 0{,}4")).toEqual([
      { text: "x" },
      { text: "2", script: "sup" },
      { text: " + (a + b)/c · 0,4" },
    ]);
    expect(formulaRuns("\\left[\\textit{Gasto público}\\right]")).toEqual([
      { text: "[Gasto público]" },
    ]);
  });
});

describe("formula content", () => {
  it("keeps a formula block's source alone, and formulas apart from other marks", () => {
    const [block, paragraph] = blocksSchema.parse([
      { ...formulaBlock, marks: [{ type: "bold", from: 0, to: 3 }], level: 2 },
      {
        ...sentence,
        marks: [
          { type: "formula", from: 6, to: 15 },
          { type: "formula", from: 10, to: 20 },
          { type: "italic", from: 0, to: 20 },
        ],
      },
    ]);
    expect(block).toEqual(formulaBlock);
    expect(paragraph!.marks).toEqual([
      { type: "italic", from: 0, to: 6 },
      { type: "italic", from: 15, to: 20 },
      { type: "formula", from: 6, to: 15 },
    ]);
  });

  it("goes through the editor and back unchanged", () => {
    const blocks = [formulaBlock, sentence];
    let n = 0;
    expect(editorToBlocks(blocksToEditor(blocks), () => `new${++n}`)).toEqual(
      blocks,
    );
  });

  it("draws a formula whole, and shows the source of one a range cuts", () => {
    const html = renderBlocks([formulaBlock, sentence]);
    expect(html).toContain('class="cx-formula-block"');
    expect(html).toContain("<mfrac>");
    expect(html).toContain("<strong>es la financiación basal.</strong>");
    // An unknown command (\href, untrusted) shows the source instead.
    expect(renderFormula("\\href{x}{y}", false)).toContain("cx-formula-source");
    // A diff segment ending inside the formula: its source, not half of it.
    expect(renderInline("Donde FBA_", sentence.marks, 0)).toBe(
      'Donde <code class="cx-formula-source">FBA_</code>',
    );
  });

  it("shows a changed formula's source with the change and both versions drawn", () => {
    const changed: ConsolidatedBlock = {
      id: "form1",
      type: "formula",
      marks: [],
      status: "kept",
      source: null,
      segments: [
        { text: "x = ", source: null },
        { text: "0{,}4", source: "A1", removed: true },
        { text: "0{,}5", source: "A1" },
      ],
    } as ConsolidatedBlock;
    const html = renderAnnotated([changed], {
      mode: "diff",
      diffLabels: { inserted: "Se añade:", removed: "Se quita:" },
    });
    expect(html).toContain('<code class="cx-formula-source">');
    expect(html).toContain('<del class="cx-del');
    expect(html).toContain('class="cx-formula-before"');
    expect(html).toContain('class="cx-formula-after"');
    expect(html.match(/<math/g)).toHaveLength(2);
    // Read clean, it is the formula as it reads now.
    expect(
      renderAnnotated([changed], { mode: "clean" }).match(/<math/g),
    ).toHaveLength(1);
  });
});
