import { describe, expect, it } from "vitest";
import {
  openQuotes,
  quoteToType,
  wrappingQuotes,
} from "./spanishQuotesExtension";

describe("quoteToType", () => {
  it("opens at the start, after a space or an opening sign", () => {
    expect(quoteToType("")).toBe("«");
    expect(quoteToType("dijo ")).toBe("«");
    expect(quoteToType("(")).toBe("«");
    expect(quoteToType("¿")).toBe("«");
  });

  it("closes after a word or a sign that ends one", () => {
    expect(quoteToType("«hola")).toBe("»");
    expect(quoteToType("«hola.")).toBe("»");
    expect(quoteToType("palabra")).toBe("»");
  });

  it("nests “ ” inside an open «…»", () => {
    expect(quoteToType("«dijo ")).toBe("“");
    expect(quoteToType("«")).toBe("“");
    expect(quoteToType("«dijo “basta")).toBe("”");
    expect(quoteToType("«dijo “basta”")).toBe("»");
  });

  it("opens « again once every quote is closed", () => {
    expect(quoteToType("«uno» y ")).toBe("«");
  });
});

describe("openQuotes", () => {
  it("ignores closing quotes that close nothing", () => {
    expect(openQuotes("» «a “b”")).toEqual(["«"]);
  });
});

describe("wrappingQuotes", () => {
  it("wraps in « » outside a quote and in “ ” inside one", () => {
    expect(wrappingQuotes("Ver ")).toEqual(["«", "»"]);
    expect(wrappingQuotes("«Ver ")).toEqual(["“", "”"]);
  });
});
