import { describe, expect, it } from "vitest";

import type { Block } from "../../types/content";
import { blockLabels, labelHeading } from "./render";

describe("labelHeading", () => {
  it("keeps a heading of 80 characters or fewer as it is", () => {
    expect(labelHeading("  3.  Devolución \n")).toBe("3. Devolución");
    expect(labelHeading("a".repeat(80))).toBe("a".repeat(80));
    expect(labelHeading("   ")).toBeNull();
  });

  it("cuts a long heading at a word boundary and closes it with «…»", () => {
    const text =
      "El Espacio Europeo de Educación y la movilidad para todas la comunidad universitaria y su entorno";
    const label = labelHeading(text);
    expect(label).toBe(
      "El Espacio Europeo de Educación y la movilidad para todas la comunidad…",
    );
    expect(label!.length).toBeLessThanOrEqual(81);
  });

  it("keeps the last word when the limit falls just before a space", () => {
    const head = `${"a".repeat(70)} comunidad`;
    const text = `${head} universitaria`;
    expect(head).toHaveLength(80);
    expect(text[80]).toBe(" ");
    expect(labelHeading(text)).toBe(`${head}…`);
  });

  it("cuts at the limit when no space falls in the second half", () => {
    expect(labelHeading("x".repeat(100))).toBe(`${"x".repeat(80)}…`);
  });
});

describe("blockLabels", () => {
  it("labels paragraphs with the shortened heading above them", () => {
    const long = `Título ${"largo ".repeat(20)}final`;
    const blocks = [
      { id: "h", type: "heading", text: long },
      { id: "p", type: "paragraph", text: "Texto." },
    ] as Block[];
    const labels = blockLabels(blocks);
    expect(labels.get("p")?.paragraph).toBe(1);
    expect(labels.get("p")?.heading).toMatch(/^Título largo .*largo…$/);
    expect(labels.get("h")?.heading).toBe(labels.get("p")?.heading);
  });
});
