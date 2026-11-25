import { describe, expect, it } from "vitest";
import { Node, getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { FormulaExtension, INLINE_FORMULA_EXAMPLE } from "./formulaExtension";

const schema = getSchema([
  Node.create({ name: "doc", topNode: true, content: "block+" }),
  Node.create({
    name: "paragraph",
    group: "block",
    content: "inline*",
    renderHTML: () => ["p", 0],
  }),
  Node.create({ name: "text", group: "inline" }),
  FormulaExtension,
]);

describe("FormulaExtension", () => {
  it("keeps what is typed over the example, key after key, in the formula (M-140)", () => {
    const formula = schema.marks.formula!.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Sea "),
        schema.text(INLINE_FORMULA_EXAMPLE, [formula]),
      ]),
    ]);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(
        doc,
        5,
        5 + INLINE_FORMULA_EXAMPLE.length,
      ),
    });
    // As the view types: over the selection first, then at the cursor.
    for (const key of ["a", "^", "2"]) {
      const { from, to } = state.selection;
      state = state.apply(state.tr.insertText(key, from, to));
    }
    const paragraph = state.doc.firstChild!;
    expect(paragraph.lastChild!.text).toBe("a^2");
    expect(formula.isInSet(paragraph.lastChild!.marks)).toBe(true);
  });
});
