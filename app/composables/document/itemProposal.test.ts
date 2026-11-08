import { describe, expect, it } from "vitest";
import { proposeFromItem, titleFromItemTitle } from "./itemProposal";

/** Agenda of the 80.ª AGO, as the Secretaría wrote it. */
const cases: [string, ReturnType<typeof proposeFromItem>][] = [
  [
    "Aprobación, si procede, del acta de la sesión anterior.",
    { kind: "minutes", title: "Acta de la sesión anterior" },
  ],
  [
    "Lectura y aprobación del acta de acuerdos.",
    { kind: "minutes", title: "Acta de acuerdos" },
  ],
  [
    "Informe de la Presidencia",
    { kind: "report", title: "Informe de la Presidencia" },
  ],
  ["Informes económicos de eventos.", { kind: "report", title: null }],
  [
    "Aprobación, si procede, de las Cuentas Anuales 2025.",
    { kind: "accounts", title: "Cuentas Anuales 2025" },
  ],
  [
    "Aprobación, si procede, de los Presupuestos 2027.",
    { kind: "budget", title: "Presupuestos 2027" },
  ],
  [
    "Aprobación, si procede, del Posicionamiento sobre el Sistema de Becas.",
    { kind: "positioning", title: "Posicionamiento sobre el Sistema de Becas" },
  ],
  [
    "Aprobación, si procede, de Mociones Internas.",
    { kind: "internal_motion", title: null },
  ],
  [
    "Aprobación, si procede, de Resoluciones.",
    { kind: "resolution", title: null },
  ],
  [
    "Aprobación, si procede, de Informes Ejecutivos.",
    { kind: "executive_report", title: null },
  ],
  ["Aprobación, si procede, de convenios.", { kind: "agreement", title: null }],
  [
    "Aprobación, si procede, de la modificación del Reglamento de Funcionamiento del Comité de Garantías.",
    {
      kind: "regulation",
      title:
        "Modificación del Reglamento de Funcionamiento del Comité de Garantías",
    },
  ],
  [
    "Seguimiento de Mociones Internas.",
    { kind: "report", title: "Seguimiento de Mociones Internas" },
  ],
  ["Elección de la Comisión Ejecutiva.", { kind: "candidacy", title: null }],
  [
    "Elección de la sede de la 82.ª Asamblea General Ordinaria.",
    { kind: "venue", title: null },
  ],
  [
    "Aprobación, si procede, del Esquema de cuotas 2027.",
    { kind: null, title: "Esquema de cuotas 2027" },
  ],
  ["Ruegos y preguntas.", { kind: null, title: "Ruegos y preguntas" }],
];

describe("proposeFromItem", () => {
  it.each(cases)("%s", (title, expected) => {
    expect(proposeFromItem({ title })).toEqual(expected);
  });

  it("proposes no title once the item has documents", () => {
    expect(
      proposeFromItem({ title: "Informe de la Tesorería", hasDocuments: true }),
    ).toEqual({ kind: "report", title: null });
  });
});

describe("titleFromItemTitle", () => {
  it("drops the formula and capitalizes", () => {
    expect(titleFromItemTitle("Aprobación si procede de la memoria.")).toBe(
      "Memoria",
    );
  });

  it("gives nothing for an empty or overlong title", () => {
    expect(titleFromItemTitle("  .")).toBeNull();
    expect(titleFromItemTitle("x".repeat(301))).toBeNull();
  });
});
