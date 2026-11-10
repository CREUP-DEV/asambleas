import { describe, expect, it } from "vitest";
import { isSafeHref } from "~~/shared/utils/content/render";
import { isEditorLinkAllowed, normalizeHref } from "./links";

describe("isEditorLinkAllowed", () => {
  it("takes the addresses content keeps", () => {
    for (const href of [
      "https://creup.es",
      "http://creup.es/normativa?x=1#a",
      "HTTPS://CREUP.ES",
      "mailto:info@creup.es",
    ]) {
      expect(isEditorLinkAllowed(href)).toBe(true);
    }
  });

  it("refuses any other scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      "ftp://creup.es/file",
      "tel:+34600000000",
      "file:///C:/doc.pdf",
      "data:text/html,hola",
      "localhost:3000",
    ]) {
      expect(isEditorLinkAllowed(href)).toBe(false);
    }
  });

  it("takes text found without a scheme only as a host or an email", () => {
    expect(isEditorLinkAllowed("creup.es")).toBe(true);
    expect(isEditorLinkAllowed("www.creup.es/normativa")).toBe(true);
    expect(isEditorLinkAllowed("info@creup.es")).toBe(true);
    expect(isEditorLinkAllowed("/asambleas/80-ago")).toBe(false);
    expect(isEditorLinkAllowed("#ancla")).toBe(false);
    expect(isEditorLinkAllowed("documento")).toBe(false);
    expect(isEditorLinkAllowed("")).toBe(false);
    expect(isEditorLinkAllowed(undefined)).toBe(false);
  });

  it("allows nothing that is unsafe once it gets its scheme", () => {
    for (const value of [
      "creup.es",
      "www.creup.es/normativa",
      "info@creup.es",
      "https://creup.es",
      "mailto:info@creup.es",
    ]) {
      expect(isEditorLinkAllowed(value)).toBe(true);
      expect(isSafeHref(normalizeHref(value))).toBe(true);
    }
  });
});

describe("normalizeHref", () => {
  it("adds the scheme an address lacks", () => {
    expect(normalizeHref(" creup.es ")).toBe("https://creup.es");
    expect(normalizeHref("info@creup.es")).toBe("mailto:info@creup.es");
    expect(normalizeHref("http://creup.es")).toBe("http://creup.es");
    expect(normalizeHref("ftp://creup.es")).toBe("ftp://creup.es");
    expect(normalizeHref("")).toBe("");
  });
});
