import { z } from "zod/v4";
import type { ReadMarksBody } from "../../types/api";

/** Most documents or amendments one request marks. */
export const READ_MARKS_MAX_IDS = 500;

const entityId = z.string().regex(/^[a-z0-9]{20,32}$/);
const ids = z.array(entityId).max(READ_MARKS_MAX_IDS).optional();

/** PUT /api/assemblies/[assembly]/read-marks (ReadMarksBody). */
export const readMarksBodySchema = z
  .strictObject({
    read: z.boolean(),
    documentIds: ids,
    amendmentIds: ids,
  })
  .refine(
    (body) =>
      (body.documentIds?.length ?? 0) + (body.amendmentIds?.length ?? 0) > 0,
  );

// Compile-time check: the parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _ReadMarksSchemaChecks = [
  Assignable<ReadMarksBody, z.output<typeof readMarksBodySchema>>,
];
