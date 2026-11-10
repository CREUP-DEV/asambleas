import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CellSelection, selectionCell } from "@tiptap/pm/tables";
import {
  isCellFillName,
  nearestCellFill,
  type CellFillName,
} from "~~/shared/constants/cellFills";

/**
 * A table cell's fill, as the editor offers it: one of the palette's colours
 * (`BlockCell.fill`, CELL_FILLS) or none. Only how the cell looks: a header
 * cell is its own toggle, and may have a fill too.
 */
export type CellFill = CellFillName | "none";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cellFill: {
      /** Gives the cell at the cursor, or every cell selected, a fill. */
      setCellFill: (fill: CellFill) => ReturnType;
    };
  }
}

/** The cell at the cursor, or every cell selected. */
function targetCells(
  state: Editor["state"],
): { node: ProseMirrorNode; pos: number }[] {
  const cells: { node: ProseMirrorNode; pos: number }[] = [];
  if (state.selection instanceof CellSelection) {
    state.selection.forEachCell((node, pos) => cells.push({ node, pos }));
    return cells;
  }
  try {
    const $cell = selectionCell(state);
    if ($cell.nodeAfter) cells.push({ node: $cell.nodeAfter, pos: $cell.pos });
  } catch {
    // Not in a table.
  }
  return cells;
}

/**
 * The fill of the cell at the cursor; of several cells selected, the one
 * they all share, or "mixed". Null outside a table.
 */
export function cellFillOf(
  editor: Editor | undefined,
): CellFill | "mixed" | null {
  if (!editor?.isActive("table")) return null;
  const fills = new Set(
    targetCells(editor.state).map(({ node }): CellFill =>
      isCellFillName(node.attrs.fill) ? node.attrs.fill : "none",
    ),
  );
  if (fills.size === 0) return null;
  return fills.size === 1 ? [...fills][0]! : "mixed";
}

/**
 * The fill a pasted cell brings: the platform's own (`data-fill`, and
 * `data-shade` from before the palette), or the palette colour nearest to
 * its background (Word, a spreadsheet).
 */
function parseFill(element: HTMLElement): CellFillName | null {
  const named = element.getAttribute("data-fill");
  if (isCellFillName(named)) return named;
  if (element.getAttribute("data-shade") === "true") return "beige";
  const background =
    element.style.backgroundColor || element.getAttribute("bgcolor") || "";
  return background ? nearestCellFill(background) : null;
}

export const CellFillExtension = Extension.create({
  name: "cellFill",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          fill: {
            default: null,
            parseHTML: parseFill,
            renderHTML: (attributes: Record<string, unknown>) =>
              isCellFillName(attributes.fill)
                ? { "data-fill": attributes.fill }
                : {},
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
          const cells = targetCells(state);
          if (cells.length === 0) return false;
          if (dispatch) {
            for (const { node, pos } of cells) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                fill: fill === "none" ? null : fill,
              });
            }
          }
          return true;
        },
    };
  },
});
