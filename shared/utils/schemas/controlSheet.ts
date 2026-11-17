import { z } from "zod/v4";
import { CONTROL_SHEET_MANUAL_RESULTS } from "../../constants/domain";
import type {
  ControlSheetAmendmentBody,
  ControlSheetItemBody,
} from "../../types/api";

/**
 * Longest observations a sheet row keeps, well under an Excel cell (32,767
 * characters), so the download never cuts what was saved.
 */
export const CONTROL_SHEET_OBSERVATIONS_MAX_LENGTH = 5000;

const token = z.iso.datetime({ offset: true }).nullable();

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
    treated: field(z.boolean()).optional(),
  })
  .refine(atLeastOne, { message: "Nada que cambiar" });

/** GET .../control-sheet/history: one row of the sheet. */
export const controlSheetHistoryQuerySchema = z.strictObject({
  row: z.string().regex(/^[a-z][a-z0-9]{23}$/),
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
