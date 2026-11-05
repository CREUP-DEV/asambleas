import { describe, expect, it } from "vitest";
import { nativeLocaleName } from "./useLocaleSwitcher";

const LOCALES = [
  { code: "es", name: "Español" },
  { code: "en", name: "English" },
];

describe("nativeLocaleName", () => {
  it("names each language in itself", () => {
    expect(nativeLocaleName(LOCALES, "es")).toBe("Español");
    expect(nativeLocaleName(LOCALES, "en")).toBe("English");
  });

  it("falls back to the code when the locale has no name", () => {
    expect(nativeLocaleName([{ code: "es" }], "es")).toBe("es");
    expect(nativeLocaleName([], "en")).toBe("en");
  });
});
