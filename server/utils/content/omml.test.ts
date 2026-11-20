import { describe, expect, it } from "vitest";
import { renderFormula } from "../../../shared/utils/content/formula";
import { ommlToLatex, parseOmmlTree, type OmmlNode } from "./omml";

const r = (text: string, style?: string): OmmlNode => ({
  n: "r",
  c: [
    ...(style ? [{ n: "rPr", c: [{ n: "sty", v: style }] }] : []),
    { n: "t", c: [text] },
  ],
});
const sub = (base: OmmlNode[], script: OmmlNode[]): OmmlNode => ({
  n: "sSub",
  c: [{ n: "sSubPr" }, { n: "e", c: base }, { n: "sub", c: script }],
});
const frac = (num: OmmlNode[], den: OmmlNode[]): OmmlNode => ({
  n: "f",
  c: [{ n: "fPr" }, { n: "num", c: num }, { n: "den", c: den }],
});

describe("ommlToLatex", () => {
  it("writes the equations of a resolution as Word draws them", () => {
    // As Word stores "Cumplimiento LOSU_t = Gasto…/PIB…_t × 100": the
    // subscript on the last letter, words with spaces, an empty subscript.
    const compliance: OmmlNode = {
      n: "oMath",
      c: [
        r("Cumplimiento LOS"),
        sub([r("U")], [r("t")]),
        sub([r("=")], []),
        frac(
          [r("Gasto público consolidado")],
          [r("PIB nominal de Españ"), sub([r("a")], [r("t")])],
        ),
        r("×"),
        r("100"),
      ],
    };
    const latex = ommlToLatex(compliance);
    expect(latex).toBe(
      "\\textit{Cumplimiento LOS}{U}_{t}{=}\\frac{\\textit{Gasto público consolidado}}{\\textit{PIB nominal de Españ}{a}_{t}}\\times 100",
    );
    expect(renderFormula(latex, true)).toContain("<mfrac>");

    const indicator: OmmlNode = {
      n: "oMath",
      c: [
        r("IFBA"),
        sub([r("P")], [r("c,t")]),
        r("="),
        {
          n: "d",
          c: [
            {
              n: "dPr",
              c: [
                { n: "begChr", v: "[" },
                { n: "endChr", v: "]" },
              ],
            },
            {
              n: "e",
              c: [r("0'4·"), frac([r("FBA")], [r("PIB")]), r("+0'35·")],
            },
          ],
        },
        r("×100"),
      ],
    };
    expect(ommlToLatex(indicator)).toBe(
      "IFBA{P}_{c,t}=\\left[0'4\\cdot \\frac{FBA}{PIB}+0'35\\cdot \\right]\\times 100",
    );
    // A decimal comma, even split across runs, has no space after it.
    expect(
      ommlToLatex({ n: "oMath", c: [r("0,4·x+0"), r(",35"), r("c,t")] }),
    ).toBe("0{,}4\\cdot x+0{,}35c,t");
  });

  it("reads radicals, sums, accents and upright text", () => {
    expect(
      ommlToLatex({
        n: "oMath",
        c: [
          {
            n: "rad",
            c: [
              { n: "radPr", c: [{ n: "degHide", v: "1" }] },
              { n: "deg" },
              { n: "e", c: [r("x")] },
            ],
          },
          {
            n: "nary",
            c: [
              { n: "naryPr", c: [{ n: "chr", v: "∑" }] },
              { n: "sub", c: [r("i=1")] },
              { n: "sup", c: [r("n")] },
              { n: "e", c: [r("a")] },
            ],
          },
          { n: "acc", c: [{ n: "accPr" }, { n: "e", c: [r("v")] }] },
          r("máx", "p"),
        ],
      }),
    ).toBe("\\sqrt{x}\\sum_{i=1}^{n}{a}\\hat{v}\\text{máx}");
  });

  it("escapes what LaTeX would read as commands", () => {
    expect(ommlToLatex({ n: "oMath", c: [r("50% & {x}_#")] })).toBe(
      "50\\% \\& \\{x\\}\\_\\#",
    );
  });
});

describe("parseOmmlTree", () => {
  it("takes a tree as the converter sends it, and nothing else", () => {
    expect(parseOmmlTree('{"n":"oMath","c":[{"n":"r","c":["x"]}]}')).toEqual({
      n: "oMath",
      c: [{ n: "r", c: ["x"] }],
    });
    expect(parseOmmlTree("not json")).toBeNull();
    expect(parseOmmlTree('{"name":"oMath"}')).toBeNull();
    let deep: OmmlNode = { n: "r", c: ["x"] };
    for (let i = 0; i < 60; i += 1) deep = { n: "e", c: [deep] };
    expect(parseOmmlTree(JSON.stringify(deep))).toBeNull();
  });
});
