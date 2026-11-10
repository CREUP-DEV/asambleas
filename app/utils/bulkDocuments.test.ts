import { describe, expect, it } from "vitest";
import {
  BULK_PDF_MAX_BYTES,
  bulkErrorIndex,
  bulkFileProblem,
  bulkRowProblems,
  bulkRowsToSend,
  isBlankBulkRow,
  titleFromFileName,
  type BulkRow,
} from "./bulkDocuments";

function row(extra: Partial<BulkRow> = {}): BulkRow {
  return {
    key: 1,
    title: "",
    kind: undefined,
    proponentMemberId: null,
    format: "structured",
    file: null,
    ...extra,
  };
}

const pdf = { name: "texto.pdf", type: "application/pdf", size: 1_000 };

describe("isBlankBulkRow", () => {
  it("is a row with no title and no PDF", () => {
    expect(isBlankBulkRow(row({ title: "  " }))).toBe(true);
    expect(isBlankBulkRow(row({ kind: "resolution" }))).toBe(true);
  });

  it("is not a row with a title or a PDF", () => {
    expect(isBlankBulkRow(row({ title: "Resolución" }))).toBe(false);
    expect(isBlankBulkRow(row({ format: "file", file: pdf }))).toBe(false);
  });

  it("ignores a PDF left on a row switched back to text", () => {
    expect(isBlankBulkRow(row({ format: "structured", file: pdf }))).toBe(true);
  });
});

describe("bulkRowsToSend", () => {
  it("leaves out the blank rows", () => {
    const rows = [
      row({ key: 1, title: "Uno" }),
      row({ key: 2 }),
      row({ key: 3, title: "Tres" }),
      row({ key: 4 }),
    ];
    expect(bulkRowsToSend(rows).map((entry) => entry.key)).toEqual([1, 3]);
  });

  it("keeps the first row when nothing is written", () => {
    const rows = [row({ key: 1 }), row({ key: 2 })];
    expect(bulkRowsToSend(rows).map((entry) => entry.key)).toEqual([1]);
  });

  it("is empty for no rows", () => {
    expect(bulkRowsToSend([])).toEqual([]);
  });
});

describe("bulkRowProblems", () => {
  it("finds nothing in a complete row", () => {
    expect(
      bulkRowProblems(row({ title: "Resolución", kind: "resolution" })),
    ).toEqual({});
    expect(
      bulkRowProblems(
        row({ title: "Acta", kind: "minutes", format: "file", file: pdf }),
      ),
    ).toEqual({});
  });

  it("asks for the title and the kind", () => {
    expect(bulkRowProblems(row())).toEqual({
      title: "required",
      kind: "required",
    });
  });

  it("refuses a title that is too long", () => {
    expect(
      bulkRowProblems(row({ title: "a".repeat(301), kind: "report" })).title,
    ).toBe("tooLong");
  });

  it("checks the PDF only while the row is a PDF", () => {
    const notPdf = { name: "texto.docx", type: "application/msword", size: 10 };
    expect(
      bulkRowProblems(
        row({ title: "x", kind: "report", format: "file", file: notPdf }),
      ).file,
    ).toBe("invalidType");
    expect(
      bulkRowProblems(
        row({ title: "x", kind: "report", format: "structured", file: notPdf }),
      ).file,
    ).toBeUndefined();
  });

  it("takes a PDF row with no file yet", () => {
    expect(
      bulkRowProblems(row({ title: "x", kind: "report", format: "file" })),
    ).toEqual({});
  });
});

describe("bulkFileProblem", () => {
  it("takes a PDF by type or by name", () => {
    expect(bulkFileProblem(pdf)).toBeUndefined();
    expect(
      bulkFileProblem({ name: "ACTA.PDF", type: "", size: 10 }),
    ).toBeUndefined();
  });

  it("refuses a file over the limit", () => {
    expect(bulkFileProblem({ ...pdf, size: BULK_PDF_MAX_BYTES + 1 })).toBe(
      "tooLarge",
    );
  });
});

describe("titleFromFileName", () => {
  it("drops the extension and the underscores", () => {
    expect(titleFromFileName("Resolución_sobre_becas.pdf")).toBe(
      "Resolución sobre becas",
    );
  });

  it("keeps a name without extension", () => {
    expect(titleFromFileName("  Moción 3  ")).toBe("Moción 3");
  });
});

describe("bulkErrorIndex", () => {
  it("reads the row of a refused request", () => {
    expect(
      bulkErrorIndex({
        data: { data: { reason: "presenter_kind", index: 2 } },
      }),
    ).toBe(2);
    expect(bulkErrorIndex({ data: { index: 0 } })).toBe(0);
  });

  it("is null when the failure names no row", () => {
    expect(bulkErrorIndex(null)).toBeNull();
    expect(bulkErrorIndex({ data: { data: { reason: "x" } } })).toBeNull();
    expect(bulkErrorIndex({ data: { data: { index: -1 } } })).toBeNull();
    expect(bulkErrorIndex({ data: { data: { index: "1" } } })).toBeNull();
  });
});
