import { describe, expect, it } from "vitest";
import {
  amendDocumentPath,
  parseAmendSelection,
  unreadAmendmentsPath,
} from "./documentLinks";

describe("document links", () => {
  it("asks for the amendments left to read", () => {
    expect(unreadAmendmentsPath("/a/documentos/x")).toBe(
      "/a/documentos/x?enmiendas=sin-leer",
    );
  });

  it("opens the editor at a paragraph", () => {
    expect(amendDocumentPath("/d", "b1")).toBe("/d?enmendar=b1");
    // No paragraph: an id no text holds, so the editor opens at the start.
    expect(amendDocumentPath("/d", null)).toBe("/d?enmendar=1");
  });

  it("carries the selection and reads it back", () => {
    const span = {
      start: { blockId: "b1", offset: 4 },
      end: { blockId: "b2", offset: 17 },
    };
    const path = amendDocumentPath("/d", "b1", span);
    expect(path).toBe("/d?enmendar=b1&seleccion=4.b2.17");
    expect(parseAmendSelection("b1", "4.b2.17")).toEqual(span);
  });

  it("leaves out a selection that starts in another paragraph", () => {
    expect(
      amendDocumentPath("/d", "b1", {
        start: { blockId: "b9", offset: 0 },
        end: { blockId: "b9", offset: 3 },
      }),
    ).toBe("/d?enmendar=b1");
  });

  it("ignores a broken selection", () => {
    expect(parseAmendSelection("b1", undefined)).toBeNull();
    expect(parseAmendSelection("b1", ["4.b2.17"])).toBeNull();
    expect(parseAmendSelection("b1", "4.b2")).toBeNull();
    expect(parseAmendSelection("b1", "x.b2.3")).toBeNull();
    expect(parseAmendSelection("b1", "4.b 2.3")).toBeNull();
  });
});
