import { z } from "zod/v4";
import type {
  AgreementRecordTextBody,
  AgreementsRecordCreateBody,
} from "../../types/api";
import {
  RECORD_KEY_PATTERN,
  RECORD_TEXT_MAX_LENGTH,
} from "../agreementsRecord";
import { normalizeText } from "./content";
import { entityIdSchema, updatedAtSchema } from "./primitives";

/** POST .../agreements-record (AgreementsRecordCreateBody). */
export const agreementsRecordCreateBodySchema = z.strictObject({
  agendaItemId: entityIdSchema,
});

/** PUT .../agreements-record/texts (AgreementRecordTextBody). */
export const agreementRecordTextBodySchema = z.strictObject({
  key: z.string().regex(RECORD_KEY_PATTERN),
  // One line of the record: line ends become spaces.
  text: z
    .string()
    .max(RECORD_TEXT_MAX_LENGTH)
    .transform((value) => normalizeText(value).replace(/\s*\n\s*/g, " "))
    .nullable(),
  omitted: z.boolean(),
  updatedAt: updatedAtSchema.nullable(),
});

type Assignable<T, U extends T> = U;
export type _AgreementsRecordBodiesMatch = [
  Assignable<
    AgreementsRecordCreateBody,
    z.output<typeof agreementsRecordCreateBodySchema>
  >,
  Assignable<
    AgreementRecordTextBody,
    z.output<typeof agreementRecordTextBodySchema>
  >,
];
