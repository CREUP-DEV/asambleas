import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { focusAfterUndo, justificationLead, passagePlace } from "./-validated";

function block(
  id: string,
  text: string,
  type: Block["type"] = "paragraph",
): Block {
  return { id, type, text, marks: [] };
}

const base: Block[] = [
  block("intro", "Preámbulo"),
  block("h3", "3. Devolución", "heading"),
  block("p1", "Primer párrafo"),
  block("p2", "Segundo párrafo"),
];

function replace(blockId: string): AmendmentOp {
  return {
    op: "replace",
    blockId,
    from: 0,
    to: 1,
    text: "X",
    baseText: "S",
  };
}

describe("passagePlace", () => {
  it("names the heading and the paragraph under it", () => {
    expect(passagePlace([replace("p2")], base)).toEqual({
      heading: "3. Devolución",
      paragraph: 2,
    });
  });

  it("takes the first change in the order of the text", () => {
    expect(passagePlace([replace("p2"), replace("p1")], base)).toEqual({
      heading: "3. Devolución",
      paragraph: 1,
    });
  });

  it("names a heading the amendment changes", () => {
    expect(passagePlace([replace("h3")], base)).toEqual({
      heading: "3. Devolución",
      paragraph: 0,
    });
  });

  it("gives the paragraph alone before any heading", () => {
    expect(passagePlace([replace("intro")], base)).toEqual({
      heading: null,
      paragraph: 1,
    });
  });

  it("is null without the text, without ops or on an unknown block", () => {
    expect(passagePlace([replace("p1")], null)).toBeNull();
    expect(passagePlace([], base)).toBeNull();
    expect(passagePlace([replace("gone")], base)).toBeNull();
  });
});

describe("justificationLead", () => {
  it("keeps the first line with text, trimmed", () => {
    expect(justificationLead("\n  Primera línea  \r\nSegunda")).toBe(
      "Primera línea",
    );
  });

  it("is null when there is nothing to show", () => {
    expect(justificationLead("")).toBeNull();
    expect(justificationLead("  \n ")).toBeNull();
    expect(justificationLead(null)).toBeNull();
  });
});

describe("focusAfterUndo", () => {
  it("goes to the next row", () => {
    expect(focusAfterUndo(["a", "b", "c"], "b")).toBe("c");
  });

  it("goes to the row before when the last one leaves", () => {
    expect(focusAfterUndo(["a", "b", "c"], "c")).toBe("b");
  });

  it("is null when the list empties or the row is not shown", () => {
    expect(focusAfterUndo(["a"], "a")).toBeNull();
    expect(focusAfterUndo(["a", "b"], "z")).toBeNull();
  });
});
