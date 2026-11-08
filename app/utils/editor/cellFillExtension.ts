import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CellSelection, selectionCell } from "@tiptap/pm/tables";

/**
 * A table cell's fill, as the editor offers it: none, the template's light
 * fill (a shaded cell, `BlockCell.shade`) or burgundy, which is a header
 * cell (`BlockCell.header`, white bold text on burgundy). One choice, as in
 * Word, though a header is its own kind of cell underneath.
 */
export type CellFill = "none" | "light" | "dark";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cellFill: {
      /** Gives the cell at the cursor, or every cell selected, a fill. */
      setCellFill: (fill: CellFill) => ReturnType;
    };
  }
}

/** The fill of the cell at the cursor, or of the first one selected. */
export function cellFillOf(editor: Editor | undefined): CellFill | null {
  if (!editor?.isActive("table")) return null;
  if (editor.isActive("tableHeader")) return "dark";
  return editor.isActive("tableCell", { shade: true }) ? "light" : "none";
}

export const CellFillExtension = Extension.create({
  name: "cellFill",
  addGlobalAttributes() {
    return [
      {
        // Header cells keep it too, so turning one into a header and back
        // loses nothing; blocks ignore it on a header.
        types: ["tableCell", "tableHeader"],
        attributes: {
          shade: {
            default: false,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-shade") === "true",
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.shade === true ? { "data-shade": "true" } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setCellFill:
        (fill) =>
        ({ state, tr, dispatch }) => {
          const { tableCell, tableHeader } = state.schema.nodes;
          if (!tableCell || !tableHeader) return false;
          const cells: { node: ProseMirrorNode; pos: number }[] = [];
          if (state.selection instanceof CellSelection) {
            state.selection.forEachCell((node, pos) =>
              cells.push({ node, pos }),
            );
          } else {
            try {
              const $cell = selectionCell(state);
              if ($cell.nodeAfter) {
                cells.push({ node: $cell.nodeAfter, pos: $cell.pos });
              }
            } catch {
              // Not in a table.
            }
          }
          if (cells.length === 0) return false;
          if (dispatch) {
            const type = fill === "dark" ? tableHeader : tableCell;
            for (const { node, pos } of cells) {
              tr.setNodeMarkup(pos, type, {
                ...node.attrs,
                shade: fill === "light",
              });
            }
          }
          return true;
        },
    };
  },
});
