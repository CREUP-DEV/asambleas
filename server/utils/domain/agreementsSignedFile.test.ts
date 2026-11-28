import { describe, expect, it } from "vitest";
import type { Block } from "~~/shared/types/content";
import {
  endsWithClosing,
  hasSigning,
  isSignedDocument,
  toSigningDto,
  canSignDocument,
  signedTextVersionId,
} from "./agreementsSignedFile";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { testActor } from "../../testing/actor";

const p = (id: string, text: string): Block =>
  ({ id, type: "paragraph", text, marks: [] }) as Block;

describe("which documents are signed", () => {
  it("signs a structured text marked so the platform did not write", () => {
    const report = {
      generated: null,
      format: "structured",
      signed: true,
    } as const;
    expect(isSignedDocument(report)).toBe(true);
    expect(hasSigning(report)).toBe(true);
  });

  it("leaves the acta de acuerdos to its own page, though it is signed", () => {
    const record = {
      generated: "agreements_record",
      format: "structured",
      signed: false,
    } as const;
    expect(isSignedDocument(record)).toBe(false);
    expect(hasSigning(record)).toBe(true);
  });

  it("signs no PDF nor any text not marked so", () => {
    expect(
      isSignedDocument({ generated: null, format: "file", signed: true }),
    ).toBe(false);
    expect(
      hasSigning({ generated: null, format: "structured", signed: false }),
    ).toBe(false);
  });
});

describe("signedTextVersionId", () => {
  it("signs the approved text of a voted document, the published one else", () => {
    expect(
      signedTextVersionId({
        consolidatedVersionId: "c",
        baseVersionId: "b",
        voted: true,
      }),
    ).toBe("c");
    expect(
      signedTextVersionId({
        consolidatedVersionId: null,
        baseVersionId: "b",
        voted: true,
      }),
    ).toBeNull();
    expect(
      signedTextVersionId({
        consolidatedVersionId: null,
        baseVersionId: "b",
        voted: false,
      }),
    ).toBe("b");
    expect(
      signedTextVersionId({
        consolidatedVersionId: null,
        baseVersionId: null,
        voted: false,
      }),
    ).toBeNull();
  });
});

describe("canSignDocument", () => {
  const manager = testActor({
    permissions: [PERMISSION_KEYS.DOCUMENT_MANAGE],
  });
  const treasurer = testActor({ memberId: "m-t" });
  it("leaves an acta to the document managers", () => {
    const acta = { kind: "minutes", proponentMemberId: "m-t" } as const;
    expect(canSignDocument(manager, acta)).toBe(true);
    expect(canSignDocument(treasurer, acta)).toBe(false);
  });
  it("leaves anything else to its main presenter", () => {
    const budget = { kind: "budget", proponentMemberId: "m-t" } as const;
    expect(canSignDocument(treasurer, budget)).toBe(true);
    expect(canSignDocument(manager, budget)).toBe(false);
    expect(canSignDocument(testActor({ memberId: "other" }), budget)).toBe(
      false,
    );
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

  it("reads the text before an unmarked «Anexo» heading and its table", () => {
    const blocks = [
      p("a", "Texto."),
      p("b", "Y por tanto firmo, a fecha de la firma digital."),
      p("c", "Nombre Apellido"),
      { ...p("h", "Anexo - Resumen"), type: "heading", level: 1 } as Block,
      ...Array.from({ length: 14 }, (_, i) => ({
        ...p(`t${i}`, "Celda"),
        cell: { table: "t", row: `r${i}`, cell: `c${i}` },
      })),
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

describe("endsWithClosing and annexes", () => {
  it("reads the end of the text before its first annex", () => {
    const blocks = [
      p("a", "Se levanta la sesión."),
      p("b", "Para que conste a los efectos oportunos, se firma."),
      p("c", "Nombre Apellido"),
      {
        ...p("d", "Anexo - Cuotas"),
        type: "heading",
        level: 1,
        annex: true,
      } as Block,
      ...Array.from({ length: 20 }, (_, i) => p(`x${i}`, "Fila.")),
    ];
    expect(endsWithClosing(blocks)).toBe(true);
  });
});
