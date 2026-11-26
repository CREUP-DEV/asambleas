import { z } from "zod/v4";
import type { MeNoticesSeenBody } from "../../types/api";
import { isoInstantSchema } from "./primitives";

/** PUT /api/me/notices/seen (MeNoticesSeenBody). */
export const noticesSeenBodySchema = z.strictObject({
  at: isoInstantSchema,
});

// Compile-time check: the parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _NoticesSeenSchemaChecks = [
  Assignable<MeNoticesSeenBody, z.output<typeof noticesSeenBodySchema>>,
];
