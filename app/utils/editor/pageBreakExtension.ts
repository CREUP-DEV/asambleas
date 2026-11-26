import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * «Empezar en una página nueva» (user's decision of 2026-11-26): a heading
 * or a paragraph of the text itself, never one in a list, a quote or a
 * table, may start a new page in the PDF and the Word file (`pageBreak` on
 * its block, PAGE_BREAK_TYPES). The editor shows it as the views do, a
 * dashed rule labelled «Página nueva» (main.css, `cx-page-break`). Enter at
 * the end of such a block never carries it over to the next one. Ctrl + Enter
 * (⌘ + Enter) inserts a page break where the cursor is, as Word does: what
 * follows it opens a new block on a new page, or the block itself does when
 * the cursor is at its start. Where no page starts (a list, a quote, a
 * table) it stays a line break (HardBreak's).
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      /** Starts the block at the cursor on a new page, or stops it doing so. */
      togglePageBreak: () => ReturnType;
      /** A page break at the cursor, as Word's Ctrl + Enter. */
      insertPageBreak: () => ReturnType;
    };
  }
}

const TYPES = ["heading", "paragraph"];

/** The heading or paragraph of the text at the cursor, with its position. */
function textBlockAtCursor(
  state: Editor["state"],
): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const node = $from.node(1);
  if (!TYPES.includes(node.type.name)) return null;
  return { node, pos: $from.before(1) };
}

/**
 * Whether the block at the cursor starts a new page; null where no block
 * may (a list, a quote, a table, an image).
 */
export function pageBreakAtCursor(editor: Editor | undefined): boolean | null {
  if (!editor) return null;
  const block = textBlockAtCursor(editor.state);
  return block ? block.node.attrs.pageBreak === true : null;
}

export const PageBreakExtension = Extension.create({
  name: "pageBreak",
  // Ahead of HardBreak, which takes Ctrl + Enter for a line break.
  priority: 1000,
  addGlobalAttributes() {
    return [
      {
        types: TYPES,
        attributes: {
          pageBreak: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) =>
              element.getAttribute("data-page-break") === "true" ? true : null,
            renderHTML: (attributes) =>
              attributes.pageBreak === true
                ? { "data-page-break": "true", class: "cx-page-break" }
                : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      togglePageBreak:
        () =>
        ({ state, tr, dispatch }) => {
          const block = textBlockAtCursor(state);
          if (!block) return false;
          if (dispatch) {
            tr.setNodeMarkup(block.pos, undefined, {
              ...block.node.attrs,
              pageBreak: block.node.attrs.pageBreak === true ? null : true,
            });
          }
          return true;
        },
      insertPageBreak:
        () =>
        ({ state, chain }) => {
          const block = textBlockAtCursor(state);
          if (!block) return false;
          const { $from, empty } = state.selection;
          // At the start of its block, the block itself opens the page.
          if (empty && $from.parentOffset === 0) {
            return block.node.attrs.pageBreak === true
              ? true
              : chain().togglePageBreak().run();
          }
          // What follows the cursor opens a block of its own, on a new page
          // (the split never carries the break, keepOnSplit).
          return chain().splitBlock().togglePageBreak().run();
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => this.editor.commands.insertPageBreak(),
    };
  },
});
