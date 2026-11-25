import { describe, expect, it } from "vitest";
import { repropose } from "./itemProposalForm";

const REPORTS = { kind: "report" as const, title: null };
const PRESIDENCY = {
  kind: "report" as const,
  title: "Informe de la Presidencia",
};
const BUDGET = { kind: "budget" as const, title: "Presupuestos 2027" };
const NOTHING = { kind: null, title: null };

describe("repropose", () => {
  it("proposes the new item's type and title over the previous ones", () => {
    expect(
      repropose(
        { kind: "report", title: "Informe de la Presidencia" },
        PRESIDENCY,
        BUDGET,
      ),
    ).toEqual({ kind: "budget", title: "Presupuestos 2027" });
  });

  it("fills an empty form from the first item chosen", () => {
    expect(repropose({ kind: undefined, title: "" }, NOTHING, BUDGET)).toEqual({
      kind: "budget",
      title: "Presupuestos 2027",
    });
  });

  it("keeps what the user typed or chose", () => {
    expect(
      repropose(
        { kind: "work_plan", title: "Informe de Becas" },
        PRESIDENCY,
        BUDGET,
      ),
    ).toEqual({ kind: "work_plan", title: "Informe de Becas" });
  });

  it("empties a proposed title the new item does not propose", () => {
    expect(
      repropose(
        { kind: "report", title: "Informe de la Presidencia" },
        PRESIDENCY,
        REPORTS,
      ),
    ).toEqual({ kind: "report", title: "" });
  });
});
