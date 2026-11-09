import { describe, expect, it } from "vitest";
import { SLUG_MAX_LENGTH, slugify } from "./slug";

describe("slugify", () => {
  it("keeps a short title whole", () => {
    expect(slugify("Resolución sobre Ponderaciones")).toBe(
      "resolucion-sobre-ponderaciones",
    );
  });

  it("cuts a long title after its last whole word", () => {
    const slug = slugify(
      "Moción Interna sobre la traducción de documentos a las lenguas oficiales del Estado",
    );
    expect(slug).toBe("mocion-interna-sobre-la-traduccion-de-documentos-a-las");
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it("keeps a word that ends exactly at the limit", () => {
    const title = `${"a".repeat(SLUG_MAX_LENGTH - 4)} bcd efg`;
    expect(slugify(title)).toBe(`${"a".repeat(SLUG_MAX_LENGTH - 4)}-bcd`);
  });

  it("cuts a single overlong word at the limit", () => {
    expect(slugify("x".repeat(SLUG_MAX_LENGTH + 10))).toHaveLength(
      SLUG_MAX_LENGTH,
    );
  });
});
