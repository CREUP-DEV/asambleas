import { describe, expect, it } from "vitest";
import type { Block } from "../../types/content";
import {
  annexStart,
  findWrittenClosing,
  isClosingFormula,
  withoutWrittenClosing,
} from "./writtenClosing";

let next = 0;
const p = (text: string, extra: Partial<Block> = {}): Block => ({
  id: `b${++next}`,
  type: "paragraph",
  text,
  marks: [],
  ...extra,
});
const h = (text: string, extra: Partial<Block> = {}): Block =>
  p(text, { type: "heading", level: 1, ...extra });
const texts = (blocks: readonly Block[]) => blocks.map((block) => block.text);

const body = [
  h("Acta de la 80.ª Asamblea General Ordinaria"),
  p("Se abre la sesión a las 10:00 con la presencia de los asociados."),
  p("Se aprueba el orden del día por asentimiento."),
  p("Sin más asuntos que tratar, se levanta la sesión a las 20:00."),
];

describe("isClosingFormula", () => {
  it.each([
    "Para que conste a los efectos oportunos, firmo la presente.",
    "  PARA QUE CONSTE, firmo.",
    "Y para que conste, firmo la presente.",
    "Y para que así conste, firmo en Madrid.",
    "Y PARA QUE ASI CONSTE",
    "Y por tanto firmo, a 3 de noviembre de 2026.",
    "Y por tanto, firmo.",
    "Firmado: Juan Pérez",
    "Fdo.: Juan Pérez",
    "Fdo: Juan Pérez",
  ])("recognises «%s»", (text) => {
    expect(isClosingFormula(text)).toBe(true);
  });

  it.each([
    "Firmados los acuerdos, se levanta la sesión.",
    "Se deja constancia para que conste en acta.",
    "Paraguay para que conste",
    "",
  ])("leaves «%s»", (text) => {
    expect(isClosingFormula(text)).toBe(false);
  });
});

describe("findWrittenClosing / withoutWrittenClosing", () => {
  it("drops an acta's closing with its signer's name and office", () => {
    const blocks = [
      ...body,
      p(""),
      p("Para que conste a los efectos oportunos, firmo la presente acta."),
      p(""),
      p(""),
      p("Juan Pérez García"),
      p("Secretario General"),
    ];
    expect(findWrittenClosing(blocks)).toEqual({ from: 5, to: 10 });
    const result = withoutWrittenClosing(blocks);
    expect(texts(result.blocks)).toEqual(texts(body));
    // The closing's five blocks and the blank line before it.
    expect(result.removed).toBe(6);
  });

  it("drops a budget's «Y por tanto firmo» closing with its blank lines", () => {
    const budget = [
      h("Presupuesto 2027"),
      p("El presupuesto asciende a 12.000 euros."),
    ];
    const blocks = [
      ...budget,
      p(""),
      p(""),
      p("Y por tanto firmo, en Madrid a 3 de noviembre de 2026."),
      p(""),
      p(""),
      p(""),
      p("María López", { align: "center" }),
      p("Tesorera", { align: "center" }),
      p(""),
    ];
    const result = withoutWrittenClosing(blocks);
    expect(texts(result.blocks)).toEqual(texts(budget));
    expect(result.removed).toBe(9);
  });

  it("takes the whole closing when a later «Fdo.» follows the formula", () => {
    const blocks = [
      ...body,
      p("Y para que así conste, firmo la presente con el visto bueno."),
      p("En Madrid, a 3 de noviembre de 2026."),
      p("Fdo.: Juan Pérez García"),
      p("Secretario General"),
    ];
    expect(findWrittenClosing(blocks)).toEqual({ from: 4, to: 8 });
  });

  it("drops a closing that is only «Fdo.:» and the name", () => {
    const blocks = [
      ...body,
      p("Fdo.: Juan Pérez García"),
      p("Secretario General del CREUP"),
    ];
    const result = withoutWrittenClosing(blocks);
    expect(texts(result.blocks)).toEqual(texts(body));
    expect(result.removed).toBe(2);
  });

  it("drops the closing before an annex and keeps the annex", () => {
    const annex = [
      h("Anexo I: lista de asistentes", { annex: true }),
      p("Universidad de Alcalá"),
      p("Para que conste, la lista la firma la Mesa."),
      p("Fdo.: la Mesa"),
    ];
    const blocks = [
      ...body,
      p("Para que conste a los efectos oportunos."),
      p("Juan Pérez García"),
      p("Secretario General"),
      p(""),
      ...annex,
    ];
    expect(findWrittenClosing(blocks)).toEqual({ from: 4, to: 8 });
    const result = withoutWrittenClosing(blocks);
    expect(texts(result.blocks)).toEqual([...texts(body), ...texts(annex)]);
    expect(result.blocks[4]?.annex).toBe(true);
    expect(result.removed).toBe(4);
  });

  it("ends the text at a heading that opens with «Anexo», though unmarked", () => {
    const table = Array.from({ length: 14 }, (_, i) =>
      p(`Celda ${i}`, { cell: { table: "t", row: `r${i}`, cell: `c${i}` } }),
    );
    const blocks = [
      ...body,
      p("Y por tanto firmo, a fecha de la firma digital."),
      p("Nombre Apellido"),
      p("Tesorero"),
      h("Anexo - Resumen"),
      ...table,
    ];
    expect(annexStart(blocks)).toBe(7);
    expect(findWrittenClosing(blocks)).toEqual({ from: 4, to: 7 });
  });

  it("leaves a «Para que conste» in the middle of the text", () => {
    const blocks = [
      ...body.slice(0, 2),
      p("Para que conste en acta, la Presidencia recuerda el turno."),
      p("Se debate la propuesta de la Comisión de Asuntos Académicos."),
      p("Se aprueba por mayoría simple."),
      p("Se debate la moción sobre becas y ayudas al estudio."),
      p("Se aprueba por asentimiento."),
      p("Se debate el informe de la Comisión Ejecutiva."),
      p("Se aprueba el informe por mayoría simple."),
      p("Se levanta la sesión a las 20:00."),
    ];
    expect(findWrittenClosing(blocks)).toBeNull();
    expect(withoutWrittenClosing(blocks)).toEqual({
      blocks,
      removed: 0,
    });
  });

  it("leaves a formula followed by long text", () => {
    const blocks = [
      ...body,
      p("Para que conste a los efectos oportunos."),
      p(
        "La Asamblea recuerda que las universidades miembro deben presentar sus informes antes de la siguiente sesión ordinaria, que el Reglamento fija con un mes de antelación, y que la Comisión Ejecutiva los publicará en la plataforma.",
      ),
    ];
    expect(findWrittenClosing(blocks)).toBeNull();
  });

  it("leaves a formula followed by more than five lines", () => {
    const blocks = [
      ...body,
      p("Para que conste a los efectos oportunos."),
      ...["Uno", "Dos", "Tres", "Cuatro", "Cinco", "Seis"].map((text) =>
        p(text),
      ),
    ];
    expect(findWrittenClosing(blocks)).toBeNull();
  });

  it("leaves a formula followed by a heading or a list", () => {
    expect(
      findWrittenClosing([
        ...body,
        p("Para que conste a los efectos oportunos."),
        h("Disposición final"),
      ]),
    ).toBeNull();
    expect(
      findWrittenClosing([
        ...body,
        p("Para que conste a los efectos oportunos."),
        p("Juan Pérez", { type: "list_item", list: "bullet", level: 0 }),
      ]),
    ).toBeNull();
  });

  it("leaves a signature written in a table", () => {
    const cell = { table: "t1", row: "r1", cell: "c1" };
    expect(
      findWrittenClosing([
        ...body,
        p("Y por tanto firmo, a fecha de la firma digital."),
        p("María López", { cell }),
        p("Tesorera", { cell }),
      ]),
    ).toBeNull();
  });

  it("leaves a text that is only its closing", () => {
    expect(
      findWrittenClosing([p("Para que conste."), p("Juan Pérez")]),
    ).toBeNull();
  });

  it("finds nothing in a text without a closing", () => {
    expect(findWrittenClosing(body)).toBeNull();
    expect(findWrittenClosing([])).toBeNull();
  });
});
