import { z } from "zod/v4";
import { CONTROL_SHEET_MANUAL_RESULTS } from "../../constants/domain";
import type {
  ControlSheetAmendmentBody,
  ControlSheetItemBody,
} from "../../types/api";
import { entityIdSchema, updatedAtSchema } from "./primitives";

/**
 * Longest observations a sheet row keeps, well under an Excel cell (32,767
 * characters), so the download never cuts what was saved.
 */
export const CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH = 5000;

/**
 * A field's lock token: the `updatedAt` the client read, null while the
 * field was never written (`sameToken` in server/utils/domain/controlSheet.ts).
 */
const token = updatedAtSchema.nullable();

const field = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, updatedAt: token });

/** Observations as saved: line ends kept, outer blank space dropped. */
const observations = z
  .string()
  .max(CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH)
  .transform((value) => value.replace(/\r\n?/g, "\n").trim());

const atLeastOne = (value: Record<string, unknown>) =>
  Object.values(value).some((entry) => entry !== undefined);

/** PATCH .../control-sheet/items/[item] (ControlSheetItemBody). */
export const controlSheetItemBodySchema = z
  .strictObject({
    observations: field(observations).optional(),
    listed: field(z.boolean()).optional(),
    result: field(z.enum(CONTROL_SHEET_MANUAL_RESULTS).nullable()).optional(),
    treated: field(z.boolean()).optional(),
  })
  .refine(atLeastOne, { message: "Nada que cambiar" });

/** PATCH .../control-sheet/amendments/[amendment] (ControlSheetAmendmentBody). */
export const controlSheetAmendmentBodySchema = z
  .strictObject({
    observations: field(observations).optional(),
    observationsAppend: observations
      .refine((value) => value.length > 0)
      .optional(),
    treated: field(z.boolean()).optional(),
  })
  .refine(atLeastOne, { message: "Nada que cambiar" })
  .refine(
    (value) =>
      value.observations === undefined ||
      value.observationsAppend === undefined,
    { message: "O se reemplazan las observaciones o se añade a ellas" },
  );

/**
 * The observations once `addition` is added after them, a blank line
 * apart (ControlSheetAmendmentBody.observationsAppend).
 */
export function appendObservations(current: string, addition: string): string {
  return current.trim() === "" ? addition : `${current}\n\n${addition}`;
}

/** GET .../control-sheet/history: one row of the sheet. */
export const controlSheetHistoryQuerySchema = z.strictObject({
  row: entityIdSchema,
});

// Compile-time check: the parsed bodies are assignable to their API types.
type Assignable<T, U extends T> = U;
export type _ControlSheetSchemaChecks = [
  Assignable<ControlSheetItemBody, z.output<typeof controlSheetItemBodySchema>>,
  Assignable<
    ControlSheetAmendmentBody,
    z.output<typeof controlSheetAmendmentBodySchema>
  >,
];
