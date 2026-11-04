import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertDocx, hasZipSignature } from "./docx";

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
  return zip.generateAsync({ type: "nodebuffer" });
}

const p = (style: string | null, text: string, bold = false) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("convertDocx", () => {
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
    console.log(JSON.stringify(result, null, 1));
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
    console.log(JSON.stringify(result));
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
});
