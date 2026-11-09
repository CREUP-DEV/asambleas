import { describe, expect, it } from "vitest";
import type { Block } from "~~/shared/types/content";
import {
  isApprovalLine,
  repeatsTitle,
  templateHeaderLength,
} from "./templateHeader";

const paragraph = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

describe("repeatsTitle", () => {
  it("accepts the title with the small changes a Word file brings", () => {
    expect(
      repeatsTitle(
        "Moción Interna de obre traducción de documentación a las lenguas oficiales del Estado",
        "Moción Interna sobre la traducción de documentos a las lenguas oficiales del Estado",
      ),
    ).toBe(true);
    expect(
      repeatsTitle(
        "REGLAMENTO DE FUNCIONAMIENTO DEL COMITÉ DE ASUNTOS SECTORIALES",
        "Reglamento de Funcionamiento del Comité de Asuntos Sectoriales",
      ),
    ).toBe(true);
  });

  it("rejects a heading that only shares a word with the title", () => {
    expect(
      repeatsTitle("Resolución", "Resolución sobre el estudiantado saharaui"),
    ).toBe(false);
    expect(
      repeatsTitle("Apartado único", "Moción Interna sobre traducción"),
    ).toBe(false);
  });
});

describe("isApprovalLine", () => {
  it("recognizes the template line, filled in or not", () => {
    expect(
      isApprovalLine(
        "Aprobada en la [NUM] Asamblea General Ordinaria el XX/XX/XXXX por unanimidad",
      ),
    ).toBe(true);
    expect(
      isApprovalLine("Aprobado en la 77.ª AGO el 5 de abril de 2025"),
    ).toBe(true);
    expect(
      isApprovalLine(
        "Aprobado por unanimidad en la 77.ª Asamblea General Ordinaria el 4 de abril de 2025",
      ),
    ).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    expect(isApprovalLine("Aprobada la reforma, la Tesorería informará")).toBe(
      false,
    );
  });
});

describe("templateHeaderLength", () => {
  const title =
    "Moción Interna sobre la traducción de documentos a las lenguas oficiales del Estado";

  it("counts the title and the approval line at the start", () => {
    const blocks = [
      paragraph(
        "a",
        "Moción Interna de obre traducción de documentación a las lenguas oficiales del Estado",
      ),
      paragraph(
        "b",
        "Aprobada en la [NUM] Asamblea General Ordinaria el XX/XX/XXXX",
      ),
      paragraph("c", "Apartado único"),
      paragraph(
        "d",
        "Moción Interna sobre la traducción de documentos a las lenguas oficiales del Estado",
      ),
    ];
    expect(templateHeaderLength(blocks, title)).toBe(2);
  });

  it("takes a first line that spells the title out in full", () => {
    const blocks = [
      paragraph(
        "a",
        "Convenio marco de participación de entidades sectoriales en la Coordinadora de Representantes de Estudiantes de Universidades Públicas",
      ),
      { ...paragraph("b", "Reunidos"), type: "heading" as const, level: 2 },
    ];
    expect(
      templateHeaderLength(
        blocks,
        "Convenio Marco de participación de entidades sectoriales",
      ),
    ).toBe(1);
  });

  it("never takes a later paragraph that merely mentions the title", () => {
    const blocks = [
      paragraph("a", "Apartado único"),
      paragraph("b", "Este informe de Tesorería recoge las cuentas."),
    ];
    expect(templateHeaderLength(blocks, "Informe de Tesorería")).toBe(0);
  });

  it("is zero when the text starts with its content", () => {
    expect(
      templateHeaderLength([paragraph("a", "Apartado único")], title),
    ).toBe(0);
  });

  it("never counts list items or table cells", () => {
    const item: Block = {
      ...paragraph("a", title),
      type: "list_item",
      list: "bullet",
    };
    const cell: Block = {
      ...paragraph("b", title),
      cell: { table: "t", row: "r", cell: "c" },
    };
    expect(templateHeaderLength([item], title)).toBe(0);
    expect(templateHeaderLength([cell], title)).toBe(0);
  });
});
