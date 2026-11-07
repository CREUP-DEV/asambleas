import { Extension } from "@tiptap/core";

/**
 * Keeps the ids of tables, rows and cells (BlockCell) on their TipTap nodes,
 * so editing a table does not renumber it: amendments anchor to blocks, and
 * a block keeps its row and cell. New rows and cells start without an id and
 * get one when the editor's content becomes blocks, which also gives a fresh
 * id to any copy (splitting a cell copies its attributes). Ids are never read
 * from pasted HTML, like block ids.
 */
export const TableIdsExtension = Extension.create({
  name: "tableIds",
  addGlobalAttributes() {
    const hidden = (name: string) => ({
      [name]: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    });
    return [
      { types: ["table"], attributes: hidden("tableId") },
      { types: ["tableRow"], attributes: hidden("rowId") },
      { types: ["tableCell", "tableHeader"], attributes: hidden("cellId") },
    ];
  },
});
