import { describe, expect, it } from "vitest";
import {
  agreementsRecord,
  agreementsRecordBlocks,
  documentObject,
  itemAction,
  locationCity,
  minutesAssemblies,
  minutesAssembly,
  voteSuffix,
  type AgreementsRecordInput,
  type RecordDocument,
  type RecordItem,
  type RecordItemVote,
  type RecordText,
} from "./agreementsRecord";
import type { SheetVote } from "./controlSheet";
import { blocksSchema } from "./schemas/content";

const assent: SheetVote = {
  method: "assent",
  result: "approved",
  inFavor: 0,
  against: 0,
  abstentions: 0,
  blank: 0,
  invalid: 0,
};
const unanimousAssent: SheetVote = { ...assent, unanimous: true };
const counted = (
  inFavor: number,
  against: number,
  abstentions: number,
  result: SheetVote["result"] = "approved",
): SheetVote => ({
  method: "show_of_hands",
  result,
  inFavor,
  against,
  abstentions,
  blank: 0,
  invalid: 0,
});

/** Ids as the database writes them (cuid2, 24 characters). */
const id = (name: string) => name.padEnd(24, "0");

const item = (name: string, title: string, parent?: string): RecordItem => {
  return {
    id: id(name),
    parentId: parent ? id(parent) : null,
    title,
    listed: true,
  };
};

const doc = (
  name: string,
  itemName: string,
  kind: RecordDocument["kind"],
  title: string,
  finalVote: SheetVote | null,
  over: Partial<RecordDocument> = {},
): RecordDocument => ({
  id: id(name),
  agendaItemId: id(itemName),
  kind,
  title,
  status: "published",
  voted: true,
  finalVote,
  ...over,
});

const itemVote = (
  itemName: string,
  vote: SheetVote,
  election: RecordItemVote["election"] = null,
): RecordItemVote => ({
  ...vote,
  id: id(`v${itemName}`),
  subjectId: id(itemName),
  recordedAt: "2026-11-20T10:00:00.000Z",
  voidedAt: null,
  election,
});

const base = (
  over: Partial<AgreementsRecordInput> = {},
): AgreementsRecordInput => ({
  assembly: {
    number: 80,
    type: "AGO",
    startDate: "2026-11-18T08:00:00.000Z",
    location: "Universidad de León (León)",
  },
  items: [],
  documents: [],
  itemVotes: [],
  selfDocumentId: null,
  selfVote: null,
  secretaryName: "Nombre Apellido",
  texts: new Map(),
  ...over,
});

const printed = (input: AgreementsRecordInput) =>
  agreementsRecord(input)
    .agreements.filter((agreement) => !agreement.omitted)
    .map((agreement) =>
      [
        `${agreement.number}. ${agreement.text}`,
        ...agreement.lines
          .filter((line) => !line.omitted)
          .map((line) => `  ${line.text}`),
      ].join("\n"),
    );

/** The 80.ª AGO as the local copy of production read on 2026-11-20. */
function ago80(): AgreementsRecordInput {
  const items = [
    item("mesa", "Ratificación de la Mesa de Moderación"),
    item("actas", "Aprobación, si procede, del acta de la sesión anterior"),
    item("informes", "Informe de la Comisión Ejecutiva Ampliada"),
    item("presidencia", "Informe de la Presidencia", "informes"),
    item(
      "ce",
      "Ratificación, si procede, de acuerdos de la Comisión Ejecutiva",
    ),
    item("cuentas", "Aprobación, si procede, de las Cuentas Anuales 2025"),
    item("cuotas", "Aprobación, si procede, del Esquema de cuotas 2027"),
    item("presupuestos", "Aprobación, si procede, de los Presupuestos 2027"),
    item(
      "ace",
      "Aprobación, si procede, del Posicionamiento Aprendizaje Centrado en el Estudiante",
    ),
    item(
      "lenguas",
      "Aprobación, si procede, del Posicionamiento sobre Diversidad lingüística en el SUE",
    ),
    item(
      "movilidad",
      "Aprobación, si procede, del Posicionamiento sobre la Internacionalización y Movilidad en el SUE",
    ),
    item("resoluciones", "Aprobación, si procede, de Resoluciones"),
    item(
      "igualdad",
      "Resolución sobre los Planes de Igualdad en el SUE",
      "resoluciones",
    ),
    item("eleccionce", "Elección de la Comisión Ejecutiva"),
    item("candidatura", "Candidatura: EL VALOR DE ESTAR UNIDOS", "eleccionce"),
    item("acta", "Lectura y aprobación del acta de acuerdos"),
    item("ruegos", "Ruegos y preguntas"),
  ];
  const documents = [
    doc("informe", "presidencia", "report", "Informe de la Presidencia", null, {
      voted: false,
    }),
    doc("acta78", "actas", "minutes", "78.ª AGO. FP", assent),
    doc("acta79", "actas", "minutes", "79.ª AGO. FP", null),
    doc("acta33", "actas", "minutes", "33.ª AGET. FP", assent),
    doc("acta34", "actas", "minutes", "34.ª AGET. FP", assent),
    doc(
      "certificado",
      "ce",
      "other",
      "Certificado de acuerdo de la Comisión Ejecutiva de 30 de septiembre de 2026",
      assent,
    ),
    doc("cuentas2025", "cuentas", "accounts", "Cuentas Anuales 2025", assent),
    doc(
      "liquidacion",
      "cuentas",
      "accounts",
      "Liquidación del Presupuesto 2025",
      null,
      { voted: false },
    ),
    doc(
      "esquema",
      "cuotas",
      "budget",
      "Esquema de cuotas de membresía 2027",
      assent,
    ),
    doc("presupuestos2027", "presupuestos", "budget", "Presupuestos 2027", {
      ...counted(16, 8, 0, "rejected"),
      method: "secret",
    }),
    doc(
      "acepos",
      "ace",
      "positioning",
      "Posicionamiento sobre el Aprendizaje Centrado en el Estudiantado",
      assent,
    ),
    doc(
      "lenguaspos",
      "lenguas",
      "positioning",
      "Posicionamiento sobre la Diversidad Lingüística en el Sistema Universitario Español",
      null,
    ),
    doc(
      "movilidadpos",
      "movilidad",
      "positioning",
      "Posicionamiento sobre la Internacionalización y Movilidad del Sistema Universitario Español",
      counted(23, 0, 3),
    ),
    doc(
      "igualdadres",
      "igualdad",
      "resolution",
      "Resolución sobre los Planes de Igualdad en el SUE",
      null,
    ),
    doc(
      "programa",
      "candidatura",
      "candidacy",
      "Programa Electoral: EL VALOR DE ESTAR UNIDOS",
      null,
      { voted: false },
    ),
  ];
  return base({
    items,
    documents,
    itemVotes: [itemVote("mesa", assent)],
  });
}

describe("agreementsRecord on the 80.ª AGO", () => {
  it("words what was agreed so far, as the 79.ª did", () => {
    expect(printed(ago80())).toEqual([
      "1. Se ratifica la Mesa de Moderación, por asentimiento.",
      "2. Se aprueban las actas de la 78.ª Asamblea General Ordinaria y la 33.ª y 34.ª Asamblea General Extraordinaria Telemática, por asentimiento.",
      "3. Se ratifica el acuerdo de la Comisión Ejecutiva de 30 de septiembre de 2026, por asentimiento.",
      "4. Se aprueban las Cuentas Anuales 2025, por asentimiento.",
      "5. Se aprueba el Esquema de cuotas de membresía 2027, por asentimiento.",
      "6. No se aprueban los Presupuestos 2027.",
      "7. Se aprueba el Posicionamiento sobre el Aprendizaje Centrado en el Estudiantado, por asentimiento.",
      "8. Se aprueba el Posicionamiento sobre la Internacionalización y Movilidad del Sistema Universitario Español.",
    ]);
  });

  it("adds the elected candidacy and the record's own approval", () => {
    const input = ago80();
    input.itemVotes = [
      ...input.itemVotes,
      itemVote("eleccionce", counted(0, 0, 0), {
        candidates: ["EL VALOR DE ESTAR UNIDOS"],
        elected: [0],
      }),
    ];
    input.selfDocumentId = id("self");
    input.documents = [
      ...input.documents,
      doc("self", "acta", "minutes", "Acta de Acuerdos 80.ª AGO", null),
    ];
    input.selfVote = assent;
    const lines = printed(input);
    expect(lines.slice(-2)).toEqual([
      "9. Se elige como Comisión Ejecutiva a la candidatura «EL VALOR DE ESTAR UNIDOS».",
      "10. Se aprueba el acta de acuerdos, por asentimiento.",
    ]);
  });

  it("gives nothing for an election that elected nobody yet", () => {
    const input = ago80();
    input.itemVotes = [
      ...input.itemVotes,
      itemVote("eleccionce", counted(0, 0, 0), {
        candidates: ["EL VALOR DE ESTAR UNIDOS"],
        elected: [],
      }),
    ];
    expect(printed(input)).toHaveLength(8);
  });

  it("keeps the corrections and leaves out what the Secretaría omits", () => {
    const input = ago80();
    const texts = new Map<string, RecordText>([
      [
        `doc:${id("certificado")}`,
        {
          text: "Se ratifica el acuerdo de la Comisión Ejecutiva del 30 de septiembre de 2026 por el que se crea un grupo de trabajo.",
          omitted: false,
        },
      ],
      [`item:${id("mesa")}`, { text: null, omitted: true }],
      ["secretary_title", { text: "Secretario Ejecutivo", omitted: false }],
    ]);
    const record = agreementsRecord({ ...input, texts });
    const lines = printed({ ...input, texts });
    expect(lines[0]).toMatch(/^1\. Se aprueban las actas/);
    // The correction's stop gives way to the suffix the vote gives.
    expect(lines[1]).toBe(
      "2. Se ratifica el acuerdo de la Comisión Ejecutiva del 30 de septiembre de 2026 por el que se crea un grupo de trabajo, por asentimiento.",
    );
    expect(record.agreements[0]).toMatchObject({ omitted: true, number: null });
    expect(
      record.header.find((field) => field.key === "secretary_title"),
    ).toMatchObject({ text: "Secretario Ejecutivo" });
  });

  it("never reads unlisted or withheld items, nor the record itself", () => {
    const input = ago80();
    input.items = input.items.map((entry) =>
      entry.id === id("cuotas") ? { ...entry, listed: false } : entry,
    );
    input.selfDocumentId = id("acta78");
    const lines = printed(input);
    expect(lines.join("\n")).not.toContain("Esquema");
    expect(lines[1]).toBe(
      "2. Se aprueban las actas de la 33.ª y 34.ª Asamblea General Extraordinaria Telemática, por asentimiento.",
    );
  });
});

describe("agreementsRecord on the 79.ª AGO's shape", () => {
  it("letters the resolutions and the motions under one agreement", () => {
    const input = base({
      items: [
        item("mociones", "Aprobación, si procede, de Mociones Internas"),
        item("m1", "Moción Interna para el Plan Formativo Anual", "mociones"),
        item("resoluciones", "Aprobación, si procede, de Resoluciones"),
        item("r1", "Resolución sobre las Normas de Evaluación", "resoluciones"),
        item(
          "r2",
          "Resolución sobre Certificación de Competencias",
          "resoluciones",
        ),
        item("r3", "Resolución sobre la Ley Universitaria", "resoluciones"),
        item("r4", "Resolución rechazada", "resoluciones"),
        item(
          "sede",
          "Elección de la sede de la 81.ª Asamblea General Ordinaria",
        ),
      ],
      documents: [
        doc(
          "dm1",
          "m1",
          "internal_motion",
          "Moción Interna para el Plan Formativo Anual",
          assent,
        ),
        doc(
          "dr1",
          "r1",
          "resolution",
          "Resolución sobre las Normas de Evaluación",
          counted(20, 3, 2),
        ),
        doc(
          "dr2",
          "r2",
          "resolution",
          "Resolución sobre Certificación de Competencias",
          assent,
        ),
        doc(
          "dr3",
          "r3",
          "resolution",
          "Resolución sobre la Ley Universitaria",
          counted(25, 0, 0),
        ),
        doc(
          "dr4",
          "r4",
          "resolution",
          "Resolución rechazada",
          counted(2, 20, 3, "rejected"),
        ),
      ],
      itemVotes: [
        itemVote("sede", unanimousAssent, {
          candidates: ["Universidad de Salamanca"],
          elected: [0],
        }),
      ],
    });
    expect(printed(input)).toEqual([
      "1. Se aprueba la siguiente moción interna:\n  Moción Interna para el Plan Formativo Anual, por asentimiento.",
      "2. Se aprueban las siguientes resoluciones:\n  Resolución sobre las Normas de Evaluación.\n  Resolución sobre Certificación de Competencias, por asentimiento.\n  Resolución sobre la Ley Universitaria, por unanimidad.",
      "3. No se aprueba la siguiente resolución:\n  Resolución rechazada.",
      "4. Se elige como sede de la 81.ª Asamblea General Ordinaria a la candidatura «Universidad de Salamanca», por unanimidad.",
    ]);
  });

  it("joins minutes of several assemblies by type", () => {
    expect(
      minutesAssemblies([
        { number: 29, type: "AGET" },
        { number: 31, type: "AGET" },
        { number: 30, type: "AGET" },
        { number: 77, type: "AGO" },
      ]),
    ).toBe(
      "la 29.ª, 30.ª y 31.ª Asamblea General Extraordinaria Telemática y la 77.ª Asamblea General Ordinaria",
    );
  });
});

describe("the words", () => {
  it("reads the verb and object of an item's title", () => {
    expect(itemAction("Ratificación de la Mesa de Moderación")).toEqual({
      verb: { singular: "ratifica", plural: "ratifican" },
      object: "la Mesa de Moderación",
    });
    expect(
      itemAction("Aprobación, si procede, de la entrada de nuevos miembros")
        ?.object,
    ).toBe("la entrada de nuevos miembros");
    expect(itemAction("Informe sobre paridad 2026")).toBeNull();
  });

  it("gives documents their article and drops a certificate's wrapper", () => {
    expect(documentObject("Presupuestos 2027")).toEqual({
      object: "los Presupuestos 2027",
      plural: true,
    });
    expect(
      documentObject("Certificado de acuerdo de la Comisión Ejecutiva").object,
    ).toBe("el acuerdo de la Comisión Ejecutiva");
    expect(documentObject("XIII Stage Formativo").object).toBe(
      "XIII Stage Formativo",
    );
  });

  it("names the assembly of a minutes' title", () => {
    expect(minutesAssembly("78.ª AGO. FP")).toEqual({
      number: 78,
      type: "AGO",
    });
    expect(
      minutesAssembly(
        "Acta de la 34.ª Asamblea General Extraordinaria Telemática",
      ),
    ).toEqual({ number: 34, type: "AGET" });
    expect(minutesAssembly("Acta de la sesión anterior")).toBeNull();
  });

  it("adds a suffix only for an assent or a unanimous vote", () => {
    expect(voteSuffix(assent)).toBe(", por asentimiento");
    expect(voteSuffix(unanimousAssent)).toBe(", por unanimidad");
    expect(voteSuffix(counted(26, 0, 0))).toBe(", por unanimidad");
    expect(voteSuffix(counted(23, 0, 3))).toBe("");
    expect(voteSuffix(counted(1, 20, 0, "rejected"))).toBe("");
  });

  it("reads the city of the place", () => {
    expect(locationCity("Universidad de León (León)")).toBe("León");
    expect(locationCity("Castellón de la Plana")).toBe("Castellón de la Plana");
  });
});

describe("agreementsRecordBlocks", () => {
  it("is valid content with stable ids and the template's frame", () => {
    const input = ago80();
    const blocks = agreementsRecordBlocks(
      agreementsRecord(input),
      input.assembly,
    );
    expect(blocksSchema.parse(blocks)).toEqual(blocks);
    expect(blocks[0]!.text).toContain(
      "Por medio de la presente, Nombre Apellido, en calidad de Secretaría Ejecutiva de la Coordinadora",
    );
    expect(blocks[1]!.text).toBe(
      "Que conforme a la normativa interna de la Asociación fue convocada para el 18 de noviembre de 2026 la 80.ª Asamblea General Ordinaria en León.",
    );
    const numbered = blocks.filter((block) => block.type === "list_item");
    expect(numbered).toHaveLength(8);
    expect(blocks.at(-1)!.text).toBe(
      "Secretaría Ejecutiva de la Coordinadora de Representantes de Estudiantes de Universidades Públicas",
    );
    // Built again, the same ids.
    expect(
      agreementsRecordBlocks(agreementsRecord(input), input.assembly).map(
        (block) => block.id,
      ),
    ).toEqual(blocks.map((block) => block.id));
  });

  it("restarts the letters under each agreement", () => {
    const input = base({
      items: [
        item("res", "Aprobación, si procede, de Resoluciones"),
        item("r1", "Resolución uno", "res"),
        item("mo", "Aprobación, si procede, de Mociones Internas"),
        item("m1", "Moción uno", "mo"),
      ],
      documents: [
        doc("dr1", "r1", "resolution", "Resolución uno", assent),
        doc("dm1", "m1", "internal_motion", "Moción uno", assent),
      ],
    });
    const blocks = agreementsRecordBlocks(
      agreementsRecord(input),
      input.assembly,
    );
    const lettered = blocks.filter((block) => block.level === 1);
    expect(lettered.map((block) => block.start)).toEqual([1, 1]);
  });
});
