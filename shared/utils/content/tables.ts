import {
  CELL_BORDER_STYLES,
  CELL_SIDES,
  TABLE_MIN_WIDTH,
  type Block,
  type BlockAlign,
  type BlockCell,
  type CellBorderStyle,
  type CellBorders,
  type CellSide,
} from "../../types/content";

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
  /**
   * Rows at the top whose cells are all headers, or blank (the empty corner
   * over a column of labels), with at least one header.
   */
  headerRows: number;
}

/**
 * Lays a table out on a grid, as a browser does: each cell takes the first
 * free column of its row, after the cells that span into it from above.
 * Rows may hold fewer cells than others (an amendment may leave them so);
 * renderers that need a full grid fill the rest.
 */
export function tableGrid<T>(
  table: TableGroup<T>,
  /** Whether a block is blank; without it, no cell counts as blank. */
  isBlank: (item: T) => boolean = () => false,
): TableGrid<T> {
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
  const blank = (cell: GridCell<T>) => cell.blocks.every(isBlank);
  let headerRows = 0;
  while (
    headerRows < rows.length &&
    rows[headerRows]!.some((cell) => cell.cell.header) &&
    rows[headerRows]!.every((cell) => cell.cell.header || blank(cell))
  ) {
    headerRows += 1;
  }
  return { columns, rows, headerRows };
}

/** How wide a table is and where it sits (BlockCell.tableWidth). */
export interface TableLayout {
  /** Percent of the text's width; 100 when the table takes all of it. */
  width: number;
  /** Where a narrower table sits; at the start when absent. */
  align?: BlockAlign;
}

/** A table's width and place, from its first cell (every cell has them). */
export function tableLayoutOf<T>(table: TableGroup<T>): TableLayout {
  const first = table.rows[0]?.cells[0]?.cell;
  const width = first?.tableWidth;
  if (!width || width >= 100) return { width: 100 };
  return first.tableAlign ? { width, align: first.tableAlign } : { width };
}

/** How a side is drawn once its neighbour is counted. */
export type CellEdge = "none" | "thin" | "thick";

const EDGE_WEIGHT: Record<CellEdge, number> = { none: 0, thin: 1, thick: 2 };

/** A cell's own side, before its neighbour is counted. */
export function cellSide(cell: BlockCell, side: CellSide): CellEdge {
  return cell.borders?.[side] ?? "thin";
}

/** The stronger of two ways to draw a side (thick, thin, none). */
export function strongerEdge(a: CellEdge, b: CellEdge): CellEdge {
  return EDGE_WEIGHT[a] >= EDGE_WEIGHT[b] ? a : b;
}

const OPPOSITE: Record<CellSide, CellSide> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

/**
 * How each side of each cell of a grid is drawn: a side shared with other
 * cells as the strongest of its own and theirs (BlockCell.borders), an
 * outer side as the cell says. For renderers that draw each cell's sides
 * themselves (the PDF); a browser's collapsed borders do the same.
 */
export function gridEdges<T>(
  grid: TableGrid<T>,
): Map<GridCell<T>, Record<CellSide, CellEdge>> {
  const height = grid.rows.length;
  const at: (GridCell<T> | undefined)[][] = Array.from(
    { length: height },
    () => new Array<GridCell<T> | undefined>(grid.columns),
  );
  grid.rows.forEach((row, r) => {
    for (const cell of row) {
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          const line = at[r + dr];
          if (line) line[cell.column + dc] = cell;
        }
      }
    }
  });
  const edges = new Map<GridCell<T>, Record<CellSide, CellEdge>>();
  grid.rows.forEach((row, r) => {
    for (const cell of row) {
      const neighbours: Record<CellSide, (GridCell<T> | undefined)[]> = {
        top: [],
        right: [],
        bottom: [],
        left: [],
      };
      for (let dc = 0; dc < cell.colspan; dc += 1) {
        neighbours.top.push(at[r - 1]?.[cell.column + dc]);
        neighbours.bottom.push(at[r + cell.rowspan]?.[cell.column + dc]);
      }
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        neighbours.left.push(at[r + dr]?.[cell.column - 1]);
        neighbours.right.push(at[r + dr]?.[cell.column + cell.colspan]);
      }
      const own = {} as Record<CellSide, CellEdge>;
      for (const side of CELL_SIDES) {
        let edge = cellSide(cell.cell, side);
        for (const other of neighbours[side]) {
          if (other && other !== cell) {
            edge = strongerEdge(edge, cellSide(other.cell, OPPOSITE[side]));
          }
        }
        own[side] = edge;
      }
      edges.set(cell, own);
    }
  });
  return edges;
}

/**
 * What a cell looks like besides its place and kind, for the comparisons
 * that tell whether a text changed: its sides and its table's width and
 * place, absent ones as their defaults.
 */
export function cellLayoutKey(cell: BlockCell): unknown[] {
  return [
    ...CELL_SIDES.map((side) => cell.borders?.[side] ?? null),
    cell.tableWidth ?? 100,
    (cell.tableWidth ?? 100) < 100 ? (cell.tableAlign ?? null) : null,
  ];
}

/** A cell's sides as "top=thick;left=none" (`data-borders`), "" for none. */
export function formatCellBorders(borders: CellBorders | undefined): string {
  if (!borders) return "";
  return CELL_SIDES.filter((side) => borders[side])
    .map((side) => `${side}=${borders[side]}`)
    .join(";");
}

/** `data-borders` read back: the sides it sets, undefined for none. */
export function parseCellBorders(
  value: string | null | undefined,
): CellBorders | undefined {
  const borders: CellBorders = {};
  for (const part of (value ?? "").split(";")) {
    const [side, style] = part.split("=");
    if (
      (CELL_SIDES as readonly string[]).includes(side ?? "") &&
      (CELL_BORDER_STYLES as readonly string[]).includes(style ?? "")
    ) {
      borders[side as CellSide] = style as CellBorderStyle;
    }
  }
  return Object.keys(borders).length > 0 ? borders : undefined;
}

/**
 * A table's width and place as attributes give them (`data-table-width`,
 * `data-table-align`, or the editor's table node): the cell fields to
 * write, none for a table as wide as the text.
 */
export function tableLayoutFields(
  width: unknown,
  align: unknown,
): Pick<BlockCell, "tableWidth" | "tableAlign"> {
  const n = typeof width === "string" ? Number(width) : width;
  if (
    typeof n !== "number" ||
    !Number.isInteger(n) ||
    n < TABLE_MIN_WIDTH ||
    n >= 100
  ) {
    return {};
  }
  return align === "center" || align === "right"
    ? { tableWidth: n, tableAlign: align }
    : { tableWidth: n };
}

/**
 * A cell's sides as the web view and the editor name them for main.css
 * (`data-cx-borders`, "top-thick right-none"), "" for none.
 */
export function cellBorderTokens(borders: CellBorders | undefined): string {
  if (!borders) return "";
  return CELL_SIDES.filter((side) => borders[side])
    .map((side) => `${side}-${borders[side]}`)
    .join(" ");
}

/**
 * A narrower table's width and place as the web view and the editor write
 * them for main.css: its width in a custom property, its place in
 * `data-cx-align`. Nothing for a table as wide as the text.
 */
export function tableLayoutAttributes(layout: TableLayout): {
  style?: string;
  "data-cx-width"?: string;
  "data-cx-align"?: string;
} {
  if (layout.width >= 100) return {};
  return {
    style: `--cx-table-width: ${Math.trunc(layout.width)}%`,
    "data-cx-width": "",
    ...(layout.align ? { "data-cx-align": layout.align } : {}),
  };
}
