import { Mark, Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { renderFormula } from "~~/shared/utils/content/formula";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    formulaBlock: {
      /**
       * A formula on a line of its own at the cursor, from the selected
       * text as its source, or an example to edit.
       */
      insertFormulaBlock: (source?: string) => ReturnType;
    };
    formula: {
      /**
       * The selection becomes a formula inside the sentence (or stops being
       * one); with nothing selected, an example to edit is typed.
       */
      toggleFormula: () => ReturnType;
    };
  }
}

/** What a new formula starts as, to be edited. */
export const FORMULA_EXAMPLE = "\\frac{a}{b}";
export const INLINE_FORMULA_EXAMPLE = "x_{i}";

/**
 * Formulas in the editor (user's decision of 2026-11-20), both kept as their
 * LaTeX source so amendments, diffs and merges treat them as text:
 *
 * - `formulaBlock`: a displayed formula (block type `formula`). Its source
 *   is edited as plain text (no marks; `code` keeps typing rules such as the
 *   Spanish quotes out of it), with the formula drawn below it as it reads.
 * - `formula`: a formula inside a sentence (mark `formula`), shown as its
 *   source while editing; it overlaps no other mark.
 */

export const FormulaBlockExtension = Node.create({
  name: "formulaBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-formula]", preserveWhitespace: "full" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-formula": "",
        class: "cx-formula-editor",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertFormulaBlock:
        (source) =>
        ({ chain, state }) => {
          const { from, to } = state.selection;
          const text =
            source ??
            (state.doc.textBetween(from, to, " ").trim() || FORMULA_EXAMPLE);
          return chain()
            .insertContent({
              type: this.name,
              content: [{ type: "text", text }],
            })
            .command(({ tr }) => {
              // The cursor lands after the new formula: its source selected
              // instead, so typing replaces the example.
              let at = -1;
              tr.doc.nodesBetween(
                Math.max(0, tr.mapping.map(from, -1) - 2),
                tr.selection.from,
                (node, pos) => {
                  if (node.type.name === this.name) at = pos;
                },
              );
              const node = at >= 0 ? tr.doc.nodeAt(at) : null;
              if (node) {
                tr.setSelection(
                  TextSelection.create(
                    tr.doc,
                    at + 1,
                    at + 1 + node.content.size,
                  ),
                );
              }
              return true;
            })
            .run();
        },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "cx-formula-editor";
      dom.setAttribute("data-formula", "");
      const source = document.createElement("div");
      source.className = "cx-formula-editor-source";
      source.setAttribute("spellcheck", "false");
      const preview = document.createElement("div");
      preview.className = "cx-formula-editor-preview";
      preview.contentEditable = "false";
      preview.setAttribute("aria-hidden", "true");
      // renderFormula returns MathML checked against an allowlist, or the
      // escaped source (formula.ts).
      preview.innerHTML = renderFormula(node.textContent, true);
      dom.append(source, preview);
      return {
        dom,
        contentDOM: source,
        update(updated) {
          if (updated.type !== node.type) return false;
          preview.innerHTML = renderFormula(updated.textContent, true);
          return true;
        },
        ignoreMutation(mutation) {
          return preview.contains(mutation.target);
        },
      };
    };
  },
});

export const FormulaExtension = Mark.create({
  name: "formula",
  code: true,
  excludes: "_",
  // Typed over its example, or at its end, text stays in the formula, as
  // Tiptap's `code` mark does; ArrowRight at the paragraph's end leaves it.
  inclusive: true,
  exitable: true,

  addCommands() {
    return {
      toggleFormula:
        () =>
        ({ chain, commands, state }) => {
          if (!state.selection.empty) return commands.toggleMark(this.name);
          const { from } = state.selection;
          // The example comes selected, so typing replaces it.
          return chain()
            .insertContent({
              type: "text",
              text: INLINE_FORMULA_EXAMPLE,
              marks: [{ type: this.name }],
            })
            .setTextSelection({
              from,
              to: from + INLINE_FORMULA_EXAMPLE.length,
            })
            .run();
        },
    };
  },

  parseHTML() {
    return [{ tag: "code[data-formula]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "code",
      mergeAttributes(HTMLAttributes, {
        "data-formula": "",
        class: "cx-formula-source",
        spellcheck: "false",
      }),
      0,
    ];
  },
});
