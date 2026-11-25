import type { EditorState } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";

/**
 * The first and the last cell of the table around the selection, as
 * `setCellSelection` takes them, so the table menu can select the whole
 * table: a touch screen cannot drag across cells, and «Bordes» and the
 * cells' colour act on the cells selected (M-141). The innermost table when
 * one sits in another; null outside a table.
 */
export function wholeTableCells(
  state: EditorState,
): { anchorCell: number; headCell: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.spec.tableRole !== "table") continue;
    const start = $from.start(depth);
    const { map } = TableMap.get(node);
    if (map.length === 0) return null;
    return { anchorCell: start + map[0]!, headCell: start + map.at(-1)! };
  }
  return null;
}
