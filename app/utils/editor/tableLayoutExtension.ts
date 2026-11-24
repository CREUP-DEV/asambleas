import { Extension, findParentNode, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CellSelection, TableMap, selectionCell } from "@tiptap/pm/tables";
import {
  CELL_SIDES,
  TABLE_MIN_WIDTH,
  type BlockAlign,
  type CellBorders,
  type CellSide,
} from "~~/shared/types/content";
import {
  cellBorderTokens,
  formatCellBorders,
  parseCellBorders,
  tableLayoutAttributes,
  tableLayoutFields,
  type CellEdge,
} from "~~/shared/utils/content/tables";

/**
 * A table's width and place, and its cells' sides, in the editor
 * (BlockCell.tableWidth, tableAlign and borders). The table node carries
 * `tableWidth` and `tableAlign`; each cell `borders`, written as the DOCX
 * import writes `data-borders` ("top=thick;left=none"). The view draws them
 * from main.css (`data-cx-width`, `data-cx-align`, `data-cx-borders`), and
 * the editor shows a hidden side as a faint dashed guide.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableLayout: {
      /**
       * Draws the given sides of the cell at the cursor, or of every cell
       * selected, as said; the cell beside each of those sides takes the
       * same on its own side, since a side two cells share is drawn as the
       * stronger of the two.
       */
      setCellSides: (sides: Partial<Record<CellSide, CellEdge>>) => ReturnType;
      /** The table's width (percent of the text's; 100 for all) and place. */
      setTableLayout: (layout: {
        width: number;
        align?: BlockAlign | null;
      }) => ReturnType;
    };
  }
}

interface CellAt {
  node: ProseMirrorNode;
  pos: number;
}

/** The cell at the cursor, or every cell selected. */
function targetCells(state: Editor["state"]): CellAt[] {
  const cells: CellAt[] = [];
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

const OPPOSITE: Record<CellSide, CellSide> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/** The cells across `side` of the cell at `pos`, by their positions. */
function neighbours(
  doc: ProseMirrorNode,
  pos: number,
  side: CellSide,
): number[] {
  const $cell = doc.resolve(pos);
  const table = $cell.node($cell.depth - 1);
  if (table.type.spec.tableRole !== "table") return [];
  const start = $cell.start($cell.depth - 1);
  const map = TableMap.get(table);
  const rect = map.findCell(pos - start);
  const found = new Set<number>();
  const add = (row: number, column: number) => {
    if (row < 0 || row >= map.height || column < 0 || column >= map.width)
      return;
    found.add(start + map.map[row * map.width + column]!);
  };
  if (side === "top" || side === "bottom") {
    const row = side === "top" ? rect.top - 1 : rect.bottom;
    for (let column = rect.left; column < rect.right; column += 1) {
      add(row, column);
    }
  } else {
    const column = side === "left" ? rect.left - 1 : rect.right;
    for (let row = rect.top; row < rect.bottom; row += 1) add(row, column);
  }
  return [...found];
}

/** A cell node's sides (`borders`). */
export function cellNodeBorders(node: ProseMirrorNode): CellBorders {
  return (
    parseCellBorders(
      typeof node.attrs.borders === "string" ? node.attrs.borders : null,
    ) ?? {}
  );
}

/**
 * How each side looks on the cell at the cursor, or on every cell
 * selected: one way when they all agree, "mixed" otherwise. Null outside
 * a table.
 */
export function cellSidesOf(
  editor: Editor | undefined,
): Record<CellSide, CellEdge | "mixed"> | null {
  if (!editor?.isActive("table")) return null;
  const cells = targetCells(editor.state);
  if (cells.length === 0) return null;
  const result = {} as Record<CellSide, CellEdge | "mixed">;
  for (const side of CELL_SIDES) {
    const seen = new Set(
      cells.map(({ node }): CellEdge => cellNodeBorders(node)[side] ?? "thin"),
    );
    result[side] = seen.size === 1 ? [...seen][0]! : "mixed";
  }
  return result;
}

/** The table's width and place around the cursor. Null outside a table. */
export function tableLayoutAt(
  editor: Editor | undefined,
): { width: number; align: BlockAlign | null } | null {
  if (!editor?.isActive("table")) return null;
  const table = findParentNode((node) => node.type.name === "table")(
    editor.state.selection,
  );
  if (!table) return null;
  const fields = tableLayoutFields(
    table.node.attrs.tableWidth,
    table.node.attrs.tableAlign,
  );
  return {
    width: fields.tableWidth ?? 100,
    align: fields.tableAlign ?? null,
  };
}

/** A pasted cell's sides: the platform's own (`data-cx-borders`). */
function parseSides(element: HTMLElement): string | null {
  const borders: CellBorders = {};
  for (const token of (element.getAttribute("data-cx-borders") ?? "").split(
    /\s+/,
  )) {
    const [side, style] = token.split("-");
    if (
      (CELL_SIDES as readonly string[]).includes(side ?? "") &&
      (style === "none" || style === "thick")
    ) {
      borders[side as CellSide] = style;
    }
  }
  return formatCellBorders(borders) || null;
}

export const TableLayoutExtension = Extension.create({
  name: "tableLayout",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          borders: {
            default: null,
            parseHTML: parseSides,
            renderHTML: (attributes: Record<string, unknown>) => {
              const tokens = cellBorderTokens(
                parseCellBorders(
                  typeof attributes.borders === "string"
                    ? attributes.borders
                    : null,
                ),
              );
              return tokens ? { "data-cx-borders": tokens } : {};
            },
          },
        },
      },
      {
        types: ["table"],
        attributes: {
          tableWidth: {
            default: null,
            parseHTML: (element: HTMLElement) => {
              const width = parseInt(
                element.style.getPropertyValue("--cx-table-width"),
                10,
              );
              return tableLayoutFields(width, null).tableWidth ?? null;
            },
            // Written with the place below, from both attributes.
            renderHTML: () => ({}),
          },
          tableAlign: {
            default: null,
            parseHTML: (element: HTMLElement) => {
              const align = element.getAttribute("data-cx-align");
              return align === "center" || align === "right" ? align : null;
            },
            renderHTML: (attributes: Record<string, unknown>) => {
              const fields = tableLayoutFields(
                attributes.tableWidth,
                attributes.tableAlign,
              );
              return tableLayoutAttributes({
                width: fields.tableWidth ?? 100,
                ...(fields.tableAlign ? { align: fields.tableAlign } : {}),
              });
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setCellSides:
        (sides) =>
        ({ state, tr, dispatch }) => {
          const cells = targetCells(state);
          if (cells.length === 0) return false;
          if (!dispatch) return true;
          // Every cell's new sides, its neighbours' included, by position.
          const changes = new Map<number, Record<CellSide, CellEdge>>();
          const bordersAt = (pos: number): Record<CellSide, CellEdge> => {
            let edges = changes.get(pos);
            if (!edges) {
              const node = state.doc.nodeAt(pos);
              const own = node ? cellNodeBorders(node) : {};
              edges = {
                top: own.top ?? "thin",
                right: own.right ?? "thin",
                bottom: own.bottom ?? "thin",
                left: own.left ?? "thin",
              };
              changes.set(pos, edges);
            }
            return edges;
          };
          const set = (
            edges: Record<CellSide, CellEdge>,
            side: CellSide,
            edge: CellEdge,
          ) => {
            edges[side] = edge;
          };
          for (const { pos } of cells) {
            for (const side of CELL_SIDES) {
              const edge = sides[side];
              if (!edge) continue;
              set(bordersAt(pos), side, edge);
              for (const other of neighbours(state.doc, pos, side)) {
                set(bordersAt(other), OPPOSITE[side], edge);
              }
            }
          }
          for (const [pos, edges] of changes) {
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            // The thin rule is every side's default: only the others stay.
            const borders: CellBorders = {};
            for (const side of CELL_SIDES) {
              const edge = edges[side];
              if (edge !== "thin") borders[side] = edge;
            }
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              borders: formatCellBorders(borders) || null,
            });
          }
          return true;
        },
      setTableLayout:
        ({ width, align }) =>
        ({ state, tr, dispatch }) => {
          const table = findParentNode((node) => node.type.name === "table")(
            state.selection,
          );
          if (!table) return false;
          if (dispatch) {
            const full = width >= 100 || width < TABLE_MIN_WIDTH;
            tr.setNodeMarkup(table.pos, undefined, {
              ...table.node.attrs,
              tableWidth: full ? null : Math.round(width),
              tableAlign: full ? null : (align ?? null),
            });
          }
          return true;
        },
    };
  },
});
