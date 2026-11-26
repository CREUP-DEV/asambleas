import { describe, expect, it } from "vitest";
import type { Block } from "~~/shared/types/content";
import {
  endsWithClosing,
  hasSigning,
  isSignableActa,
  toSigningDto,
} from "./agreementsSignedFile";

const p = (id: string, text: string): Block =>
  ({ id, type: "paragraph", text, marks: [] }) as Block;

describe("which documents are signed", () => {
  it("signs a structured acta the platform did not write", () => {
    const acta = {
      kind: "minutes",
      generated: null,
      format: "structured",
    } as const;
    expect(isSignableActa(acta)).toBe(true);
    expect(hasSigning(acta)).toBe(true);
  });

  it("leaves the acta de acuerdos to its own page, though it is signed", () => {
    const record = {
      kind: "minutes",
      generated: "agreements_record",
      format: "structured",
    } as const;
    expect(isSignableActa(record)).toBe(false);
    expect(hasSigning(record)).toBe(true);
  });

  it("signs no uploaded acta nor any other kind", () => {
    expect(
      isSignableActa({ kind: "minutes", generated: null, format: "file" }),
    ).toBe(false);
    expect(
      hasSigning({ kind: "resolution", generated: null, format: "structured" }),
    ).toBe(false);
  });
});

describe("endsWithClosing", () => {
  it("finds the formula of an acta written with its own signature", () => {
    const blocks = [
      p("a", "Se levanta la sesión."),
      p(
        "b",
        "Para que conste a los efectos oportunos, se firma en fecha de la firma digital,",
      ),
      p("c", ""),
      p("d", "Nombre Apellido"),
      p("e", "Secretaría Ejecutiva de la Coordinadora"),
    ];
    expect(endsWithClosing(blocks)).toBe(true);
  });

  it("reads only the end of the text", () => {
    const blocks = [
      p("a", "Para que conste lo dicho en el punto anterior."),
      ...Array.from({ length: 20 }, (_, i) => p(`x${i}`, "Texto.")),
    ];
    expect(endsWithClosing(blocks)).toBe(false);
  });
});

describe("toSigningDto", () => {
  const row = {
    documentId: "doc",
    versionId: "v2",
    preparedFile: "a.pdf",
    preparedAt: new Date("2026-11-26T10:00:00Z"),
    preparedByUserId: "u",
    preparedWithImage: true,
    signedFileUrl: "/api/uploads/agreements/b.pdf",
    signedFileName: "Acta.pdf",
    signedVersionId: "v1",
    signedAt: new Date("2026-11-26T11:00:00Z"),
    signedByUserId: "u",
    updatedAt: new Date("2026-11-26T11:00:00Z"),
  };

  it("marks each PDF current only for the text in force", () => {
    const dto = toSigningDto(row, "v2");
    expect(dto.prepared).toMatchObject({ current: true, withImage: true });
    expect(dto.signed).toMatchObject({ current: false, name: "Acta.pdf" });
  });

  it("marks none current without a text in force", () => {
    const dto = toSigningDto(row, null);
    expect(dto.prepared?.current).toBe(false);
    expect(dto.signed?.current).toBe(false);
  });
});
