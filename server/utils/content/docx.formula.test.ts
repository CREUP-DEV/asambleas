// DOCX import: Word equations (Office Math) become formula blocks and
// marks. Kept in a file of its own, like the other converter tests, so that
// Vitest runs it beside them; its builders live in server/testing/docx.ts.

import { describe, expect, it, vi } from "vitest";
import { buildDocx, convert, p } from "../../testing/docx";

vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

const M =
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const mr = (text: string) =>
  `<m:r><m:t xml:space="preserve">${text}</m:t></m:r>`;
const msub = (base: string, script: string) =>
  `<m:sSub><m:sSubPr><m:ctrlPr/></m:sSubPr><m:e>${mr(base)}</m:e><m:sub>${mr(script)}</m:sub></m:sSub>`;

describe("convertDocx with equations", () => {
  it("turns an equation alone in its paragraph into a formula block and one in a sentence into a formula", async () => {
    const equation = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><m:oMath ${M}>${mr("IFBA")}${msub("P", "c,t")}${mr("=")}<m:f><m:num>${mr("FBA")}</m:num><m:den>${mr("PIB")}</m:den></m:f></m:oMath></w:p>`;
    const sentence = `<w:p><m:oMath ${M}>${mr("FBA")}${msub("", "c,t")}</m:oMath><w:r><w:t xml:space="preserve"> es la financiación basal.</w:t></w:r></w:p>`;
    const result = await convert(
      await buildDocx(p(null, "Texto") + equation + sentence),
    );
    expect(result.warnings).toEqual([]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "formula",
      "paragraph",
    ]);
    expect(result.blocks[1]).toMatchObject({
      type: "formula",
      text: "IFBA{P}_{c,t}=\\frac{FBA}{PIB}",
      marks: [],
    });
    const last = result.blocks[2]!;
    expect(last.text).toBe("FBA{}_{c,t} es la financiación basal.");
    expect(last.marks).toEqual([{ type: "formula", from: 0, to: 11 }]);
  }, 30_000);
});
