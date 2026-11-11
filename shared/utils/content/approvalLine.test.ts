import { describe, expect, it } from "vitest";
import type { Block } from "../../types/content";
import {
  fillApprovalLines,
  filledApprovalText,
  findPlaceholders,
  isApprovalLine,
  isUnfilledApprovalLine,
  type ApprovalFill,
} from "./approvalLine";

const p = (id: string, text: string, marks: Block["marks"] = []): Block => ({
  id,
  type: "paragraph",
  text,
  marks,
});

const fill: ApprovalFill = {
  assembly: { number: 80, type: "AGO" },
  vote: {
    method: "show_of_hands",
    majority: "simple",
    inFavor: 30,
    against: 4,
    abstentions: 2,
    recordedAt: new Date("2026-11-21T17:30:00Z"),
  },
};

describe("findPlaceholders", () => {
  it("finds the template's fields", () => {
    expect(
      findPlaceholders(
        "Aprobada por [Mayoría] en la [Nº] Asamblea General [Ordinaria/Extraordinaria] el [Día] de [Mes] de [Año].",
      ),
    ).toEqual([
      "[Mayoría]",
      "[Nº]",
      "[Ordinaria/Extraordinaria]",
      "[Día]",
      "[Mes]",
      "[Año]",
    ]);
    expect(
      findPlaceholders("el XX de xxxxxxxxx de 202x y el DD de noviembre"),
    ).toEqual(["XX", "xxxxxxxxx", "202x", "DD"]);
  });

  it("leaves numeric references and ordinary words alone", () => {
    expect(findPlaceholders("Según el informe [3], el gasto subió.")).toEqual(
      [],
    );
    expect(findPlaceholders("Siglo XXI y la LOSU")).toEqual([]);
  });
});

describe("isApprovalLine", () => {
  it("recognizes approval and history lines", () => {
    expect(
      isApprovalLine(
        "Aprobado por [MAYORÍA] en la 80.ª Asamblea General Ordinaria el DD de noviembre de 2026.",
      ),
    ).toBe(true);
    expect(
      isApprovalLine(
        "Modificado parcialmente en la 80ª Asamblea General Ordinaria el XX de xxxxxxxxx de 202x.",
      ),
    ).toBe(true);
    expect(isApprovalLine("Aprobada la reforma, la Tesorería informará")).toBe(
      false,
    );
  });

  it("tells an unfilled line from one already filled in", () => {
    expect(
      isUnfilledApprovalLine(
        p(
          "a",
          "Aprobado en la 76ª Asamblea General Ordinaria el 23 de noviembre de 2024",
        ),
      ),
    ).toBe(false);
    expect(
      isUnfilledApprovalLine(
        p(
          "a",
          "Aprobado en la 80.ª Asamblea General Ordinaria el XX de noviembre de 2026",
        ),
      ),
    ).toBe(true);
  });
});

describe("filledApprovalText", () => {
  it("keeps the line's own opening and writes the vote's data", () => {
    expect(
      filledApprovalText(
        "Aprobada por [Mayoría] en la [Nº] Asamblea General [Ordinaria/Extraordinaria] el [Día] de [Mes] de [Año].",
        fill,
      ),
    ).toBe(
      "Aprobada por mayoría simple en la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026.",
    );
    expect(
      filledApprovalText(
        "Modificado parcialmente en la 80ª Asamblea General Ordinaria el XX de xxxxxxxxx de 202x.",
        fill,
      ),
    ).toBe(
      "Modificado parcialmente en la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026.",
    );
  });

  it("says unanimity and assent", () => {
    const unanimous = { ...fill.vote, against: 0, abstentions: 0 };
    expect(
      filledApprovalText("Aprobado por [MAYORÍA] en la …", {
        ...fill,
        vote: unanimous,
      }),
    ).toContain("por unanimidad");
    expect(
      filledApprovalText("Aprobado por [MAYORÍA] en la …", {
        ...fill,
        vote: { ...fill.vote, method: "assent" },
      }),
    ).toContain("por asentimiento");
  });

  it("names the assembly by its type, in the date of Madrid", () => {
    expect(
      filledApprovalText("Aprobado en la [Nº] AGET el XX", {
        assembly: { number: 34, type: "AGET" },
        vote: { ...fill.vote, recordedAt: new Date("2026-10-13T23:30:00Z") },
      }),
    ).toBe(
      "Aprobado por mayoría simple en la 34.ª Asamblea General Extraordinaria Telemática el 14 de octubre de 2026.",
    );
  });
});

describe("fillApprovalLines", () => {
  const blocks = [
    p("title", "Reglamento de Funcionamiento del Comité de Garantías"),
    p(
      "history",
      "Aprobado en la 76ª Asamblea General Ordinaria el 23 de noviembre de 2024",
    ),
    p(
      "pending",
      "Modificado parcialmente en la 80ª Asamblea General Ordinaria el XX de xxxxxxxxx de 202x.",
      [{ type: "italic", from: 0, to: 88 }],
    ),
    p("body", "Artículo 1. Objeto."),
  ];

  it("fills only the unfilled lines, keeping a whole-line style", () => {
    const result = fillApprovalLines(blocks, fill);
    expect(result.filled).toBe(1);
    expect(result.blocks.map((block) => block.id)).toEqual([
      "title",
      "history",
      "pending",
      "body",
    ]);
    const line = result.blocks[2]!;
    expect(line.text).toBe(
      "Modificado parcialmente en la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026.",
    );
    expect(line.marks).toEqual([
      { type: "italic", from: 0, to: line.text.length },
    ]);
    expect(result.blocks[1]).toBe(blocks[1]);
  });

  it("leaves the unfilled lines out while nothing is approved", () => {
    const result = fillApprovalLines(blocks, null);
    expect(result.filled).toBe(0);
    expect(result.blocks.map((block) => block.id)).toEqual([
      "title",
      "history",
      "body",
    ]);
  });

  it("only looks at the opening blocks", () => {
    const late = [
      p("1", "Uno"),
      p("2", "Dos"),
      p("3", "Tres"),
      p("4", "Cuatro"),
      p("5", "Aprobado por [MAYORÍA] en la 80.ª Asamblea General Ordinaria"),
    ];
    expect(fillApprovalLines(late, null).blocks).toHaveLength(5);
  });
});
