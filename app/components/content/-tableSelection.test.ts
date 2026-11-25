import { describe, expect, it } from "vitest";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { CellSelection, tableNodes } from "@tiptap/pm/tables";
import { wholeTableCells } from "./-tableSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: {},
    ...tableNodes({
      tableGroup: "block",
      cellContent: "block+",
      cellAttributes: {},
    }),
  },
});

const { doc, paragraph, table, table_row, table_cell } = schema.nodes as Record<
  string,
  NonNullable<(typeof schema.nodes)[string]>
>;

function cell(text: string, attrs: Record<string, unknown> = {}) {
  return table_cell!.create(attrs, paragraph!.create(null, schema.text(text)));
}

/** A paragraph, then a table of the rows given, then a paragraph. */
function documentWith(rows: ProseMirrorNode[][]): ProseMirrorNode {
  return doc!.create(null, [
    paragraph!.create(null, schema.text("Antes")),
    table!.create(
      null,
      rows.map((cells) => table_row!.create(null, cells)),
    ),
    paragraph!.create(null, schema.text("Después")),
  ]);
}

/** The position just inside the text `text`. */
function inside(node: ProseMirrorNode, text: string): number {
  let found = -1;
  node.descendants((child, pos) => {
    if (found < 0 && child.isText && child.text === text) found = pos + 1;
  });
  return found;
}

function stateAt(node: ProseMirrorNode, text: string): EditorState {
  return EditorState.create({
    doc: node,
    selection: TextSelection.create(node, inside(node, text)),
  });
}

describe("wholeTableCells", () => {
  it("is null outside a table", () => {
    const node = documentWith([[cell("a")]]);
    expect(wholeTableCells(stateAt(node, "Antes"))).toBeNull();
  });

  it("selects from the first cell to the last, from any cell", () => {
    const node = documentWith([
      [cell("a"), cell("b")],
      [cell("c"), cell("d")],
    ]);
    const range = wholeTableCells(stateAt(node, "c"))!;
    const selection = CellSelection.create(
      node,
      range.anchorCell,
      range.headCell,
    );
    const texts: string[] = [];
    selection.forEachCell((each) => texts.push(each.textContent));
    expect(texts).toEqual(["a", "b", "c", "d"]);
  });

  it("covers a merged cell at the end", () => {
    const node = documentWith([
      [cell("a"), cell("b")],
      [cell("c", { colspan: 2 })],
    ]);
    const range = wholeTableCells(stateAt(node, "b"))!;
    const selection = CellSelection.create(
      node,
      range.anchorCell,
      range.headCell,
    );
    const texts: string[] = [];
    selection.forEachCell((each) => texts.push(each.textContent));
    expect(texts).toEqual(["a", "b", "c"]);
  });

  it("works from a cell selection too", () => {
    const node = documentWith([[cell("a"), cell("b")]]);
    const first = wholeTableCells(stateAt(node, "a"))!;
    const state = EditorState.create({
      doc: node,
      selection: CellSelection.create(node, first.headCell),
    });
    expect(wholeTableCells(state)).toEqual(first);
  });
});
