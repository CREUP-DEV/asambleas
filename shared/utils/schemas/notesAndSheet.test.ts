import { describe, expect, it } from "vitest";
import { AMENDMENT_NOTE_MAX_LENGTH } from "../amendmentNotes";
import {
  amendmentNoteCreateBodySchema,
  amendmentNoteUpdateBodySchema,
} from "./amendmentNotes";
import {
  appendObservations,
  CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH,
  controlSheetAmendmentBodySchema,
} from "./controlSheet";

describe("amendment note bodies", () => {
  it("takes a text that is not blank, up to the limit", () => {
    expect(amendmentNoteCreateBodySchema.parse({ body: "Revisar" })).toEqual({
      body: "Revisar",
    });
    for (const body of ["", "   ", "x".repeat(AMENDMENT_NOTE_MAX_LENGTH + 1)]) {
      expect(amendmentNoteCreateBodySchema.safeParse({ body }).success).toBe(
        false,
      );
    }
    // Never an anchor: a note is about the whole amendment.
    expect(
      amendmentNoteCreateBodySchema.safeParse({
        body: "Revisar",
        anchor: null,
      }).success,
    ).toBe(false);
  });

  it("changes a note only with the time it was read", () => {
    expect(
      amendmentNoteUpdateBodySchema.safeParse({ body: "Otra cosa" }).success,
    ).toBe(false);
    expect(
      amendmentNoteUpdateBodySchema.safeParse({
        body: "Otra cosa",
        updatedAt: "2026-11-17T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("adding to the observations of an amendment in the sheet", () => {
  it("adds below what is there, a blank line apart", () => {
    expect(appendObservations("", "Nueva")).toBe("Nueva");
    expect(appendObservations("  ", "Nueva")).toBe("Nueva");
    expect(appendObservations("Antes", "Nueva")).toBe("Antes\n\nNueva");
  });

  it("takes an addition alone, trimmed and not blank", () => {
    expect(
      controlSheetAmendmentBodySchema.parse({
        observationsAppend: "  Nota\r\nsegunda línea ",
      }),
    ).toEqual({ observationsAppend: "Nota\nsegunda línea" });
    for (const body of [
      { observationsAppend: "   " },
      {
        observationsAppend: "x".repeat(
          CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH + 1,
        ),
      },
      {
        observationsAppend: "Nota",
        observations: { value: "Otra", updatedAt: null },
      },
    ]) {
      expect(controlSheetAmendmentBodySchema.safeParse(body).success).toBe(
        false,
      );
    }
  });
});
