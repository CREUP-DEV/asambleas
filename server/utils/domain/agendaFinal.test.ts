import { describe, expect, it } from "vitest";
import {
  AGENDA_FINAL_CONFLICT_CODE,
  agendaItemBodySchema,
  agendaItemDeleteQuerySchema,
  agendaReorderBodySchema,
} from "~~/shared/utils/schemas/assembly";
import { confirmFinalRootChange } from "./assemblies";

const provisional = { agendaFinalizedAt: null };
const final = { agendaFinalizedAt: new Date("2026-11-01T09:00:00Z") };

describe("confirmFinalRootChange", () => {
  it("lets a provisional agenda change, never marked as after final", () => {
    expect(confirmFinalRootChange(provisional, undefined)).toBe(false);
    expect(confirmFinalRootChange(provisional, true)).toBe(false);
  });

  it("asks for the confirmation once the agenda is final", () => {
    for (const confirmFinal of [undefined, false]) {
      let thrown: unknown;
      try {
        confirmFinalRootChange(final, confirmFinal);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        statusCode: 409,
        data: { code: AGENDA_FINAL_CONFLICT_CODE },
      });
    }
    expect(AGENDA_FINAL_CONFLICT_CODE).toBe("agenda_final");
  });

  it("lets a confirmed change through and marks it as after final", () => {
    expect(confirmFinalRootChange(final, true)).toBe(true);
  });
});

describe("confirmFinal in the agenda schemas", () => {
  it("is an optional boolean in the item and reorder bodies", () => {
    expect(
      agendaItemBodySchema.parse({ title: "Informes" }).confirmFinal,
    ).toBeUndefined();
    expect(
      agendaItemBodySchema.parse({ title: "Informes", confirmFinal: true })
        .confirmFinal,
    ).toBe(true);
    expect(
      agendaItemBodySchema.safeParse({ title: "Informes", confirmFinal: "yes" })
        .success,
    ).toBe(false);

    const items = [{ id: "a".repeat(24), parentId: null, order: 0 }];
    expect(
      agendaReorderBodySchema.parse({ items, confirmFinal: true }).confirmFinal,
    ).toBe(true);
    expect(
      agendaReorderBodySchema.safeParse({ items, confirmFinal: 1 }).success,
    ).toBe(false);
  });

  it("travels as text in the query of a delete", () => {
    expect(agendaItemDeleteQuerySchema.parse({})).toEqual({
      confirmFinal: false,
    });
    expect(agendaItemDeleteQuerySchema.parse({ confirmFinal: "true" })).toEqual(
      { confirmFinal: true },
    );
    expect(
      agendaItemDeleteQuerySchema.parse({ confirmFinal: "false" }),
    ).toEqual({ confirmFinal: false });
    expect(
      agendaItemDeleteQuerySchema.safeParse({ confirmFinal: "1" }).success,
    ).toBe(false);
  });
});
