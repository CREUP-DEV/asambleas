import { Extension, InputRule } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

/**
 * Spanish quotes as one types: a straight `"` becomes «, or » when it closes,
 * and “ ” inside an open «…» (the RAE's order, « “ ” »). Typing it over a
 * selection inside one paragraph wraps it instead of replacing it. Backspace
 * right after a replaced `"` brings the straight one back (TipTap's
 * undoInputRule). Only typing: pasted and stored text never change, so no
 * amendment shows a change nobody wrote. Single quotes stay as they are: in
 * Spanish `'` is nearly always an apostrophe.
 *
 * The editor allows input rules extension by extension: BlockEditor lists
 * `spanishQuotes` in `enable-input-rules`, or the typed quote stays straight.
 */

/** What leaves the next quote opening: the start, a space or an opening sign. */
const OPENS_AFTER = /[\s([{¿¡«“‘/\-–—]$/u;

/** The quotes still open in this text, outermost first. */
export function openQuotes(text: string): string[] {
  const stack: string[] = [];
  for (const char of text) {
    if (char === "«" || char === "“") stack.push(char);
    else if (char === "»" && stack.at(-1) === "«") stack.pop();
    else if (char === "”" && stack.at(-1) === "“") stack.pop();
  }
  return stack;
}

/** The quote a straight `"` typed after this text (of its paragraph) becomes. */
export function quoteToType(textBefore: string): string {
  const open = openQuotes(textBefore);
  if (textBefore === "" || OPENS_AFTER.test(textBefore)) {
    return open.length > 0 ? "“" : "«";
  }
  return open.at(-1) === "“" ? "”" : "»";
}

/** The pair that wraps a selection starting after this text. */
export function wrappingQuotes(textBefore: string): [string, string] {
  return openQuotes(textBefore).length > 0 ? ["“", "”"] : ["«", "»"];
}

/** The text of the paragraph before a position, a line break or image read as a space. */
function paragraphTextBefore(doc: ProseMirrorNode, pos: number): string {
  const $pos = doc.resolve(pos);
  return $pos.parent.textBetween(0, $pos.parentOffset, undefined, " ");
}

export const SpanishQuotesExtension = Extension.create({
  name: "spanishQuotes",

  addInputRules() {
    return [
      new InputRule({
        find: /"$/,
        handler: ({ state, range }) => {
          // Over a selection: the wrapping plugin below.
          if (range.from !== range.to) return null;
          const quote = quoteToType(paragraphTextBefore(state.doc, range.from));
          state.tr.insertText(quote, range.from, range.to);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("spanishQuotesWrap"),
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== '"' || from === to || view.composing) return false;
            const { state } = view;
            const $from = state.doc.resolve(from);
            const $to = state.doc.resolve(to);
            if (
              !$from.parent.isTextblock ||
              !$from.sameParent($to) ||
              $from.parent.type.spec.code ||
              $from.marks().some((mark) => mark.type.spec.code)
            ) {
              return false;
            }
            const [open, close] = wrappingQuotes(
              paragraphTextBefore(state.doc, from),
            );
            const tr = state.tr.insertText(close, to).insertText(open, from);
            // The quoted text stays selected, between its quotes.
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                from + open.length,
                to + open.length,
              ),
            );
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
