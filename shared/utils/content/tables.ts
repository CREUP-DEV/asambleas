import type { Block, BlockCell } from "../../types/content";

/**
 * Tables in a flat list of blocks (see BlockCell): every renderer groups
 * them with these helpers, so the web view, the editor and the PDF agree on
 * what forms a table, a row and a cell.
 */

export interface TableCellGroup<T> {
  /** The cell's reference, from its first block. */
  cell: BlockCell;
  blocks: T[];
}

export interface TableRowGroup<T> {
  row: string;
  cells: TableCellGroup<T>[];
}

export interface TableGroup<T> {
  table: string;
  rows: TableRowGroup<T>[];
}

export type BlockRun<T> =
  { kind: "blocks"; items: T[] } | { kind: "table"; table: TableGroup<T> };

/**
 * Splits blocks into runs of plain blocks and tables: consecutive blocks of
 * one table form it, consecutive ones of one row a row, and consecutive ones
 * of one cell a cell.
 */
export function groupTables<T extends Pick<Block, "cell">>(
  items: T[],
): BlockRun<T>[] {
  const runs: BlockRun<T>[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (!item.cell) {
      if (last?.kind === "blocks") last.items.push(item);
      else runs.push({ kind: "blocks", items: [item] });
      continue;
    }
    const { table, row, cell } = item.cell;
    let group: TableGroup<T>;
    if (last?.kind === "table" && last.table.table === table) {
      group = last.table;
    } else {
      group = { table, rows: [] };
      runs.push({ kind: "table", table: group });
    }
    let rowGroup = group.rows[group.rows.length - 1];
    if (!rowGroup || rowGroup.row !== row) {
      rowGroup = { row, cells: [] };
      group.rows.push(rowGroup);
    }
    const cellGroup = rowGroup.cells[rowGroup.cells.length - 1];
    if (cellGroup && cellGroup.cell.cell === cell) cellGroup.blocks.push(item);
    else rowGroup.cells.push({ cell: item.cell, blocks: [item] });
  }
  return runs;
}

export interface GridCell<T> extends TableCellGroup<T> {
  /** The first column the cell takes. */
  column: number;
  colspan: number;
  rowspan: number;
}

export interface TableGrid<T> {
  columns: number;
  rows: GridCell<T>[][];
  /** Rows at the top whose cells are all headers. */
  headerRows: number;
}

/**
 * Lays a table out on a grid, as a browser does: each cell takes the first
 * free column of its row, after the cells that span into it from above.
 * Rows may hold fewer cells than others (an amendment may leave them so);
 * renderers that need a full grid fill the rest.
 */
export function tableGrid<T>(table: TableGroup<T>): TableGrid<T> {
  // Columns taken in each row by cells spanning down from rows above.
  const taken: Set<number>[] = table.rows.map(() => new Set<number>());
  let columns = 0;
  const rows = table.rows.map((row, rowIndex) => {
    let column = 0;
    return row.cells.map((cell) => {
      while (taken[rowIndex]!.has(column)) column += 1;
      const colspan = cell.cell.colspan ?? 1;
      const rowspan = Math.min(
        cell.cell.rowspan ?? 1,
        table.rows.length - rowIndex,
      );
      for (let r = rowIndex; r < rowIndex + rowspan; r += 1) {
        for (let c = column; c < column + colspan; c += 1) taken[r]!.add(c);
      }
      const placed: GridCell<T> = { ...cell, column, colspan, rowspan };
      column += colspan;
      columns = Math.max(columns, column);
      return placed;
    });
  });
  // Cells spanning down count too, past where their rows' own cells end.
  for (const row of taken) {
    for (const column of row) columns = Math.max(columns, column + 1);
  }
  let headerRows = 0;
  while (
    headerRows < rows.length &&
    rows[headerRows]!.length > 0 &&
    rows[headerRows]!.every((cell) => cell.cell.header)
  ) {
    headerRows += 1;
  }
  return { columns, rows, headerRows };
}
