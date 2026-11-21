import { z } from "zod/v4";
import {
  ACCEPTED_AMENDMENT_RULES,
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  MAJORITIES,
} from "../../constants/domain";
import { READING_BEAT_MAX_SECONDS } from "../documentViews";
import type {
  AmendmentCorrectionBody,
  BulkDocumentsBody,
  ConciliationBody,
  CorrectionBody,
  UndoValidationBody,
  DocumentCreateBody,
  DocumentUpdateBody,
  FinalVoteAnnulBody,
  FinalVoteBody,
  FormCorrectionBody,
  FormCorrectionDecisionBody,
  FormCorrectionWithdrawBody,
} from "../../types/api";
import { BULK_DOCUMENTS_MAX } from "../agendaSubmissions";
import { passageWordingBodySchema } from "./amendment";
import { blocksSchema } from "./content";
import { voteInputSchema } from "./vote";

/**
 * Request bodies of the document endpoints. They mirror the types in
 * shared/types/api.ts (DocumentCreateBody, DocumentUpdateBody,
 * DocumentContentBody, CorrectionBody, FinalVoteBody, FinalVoteAnnulBody).
 */

const ENTITY_ID_PATTERN = /^[a-z0-9]{20,32}$/;

export const entityIdSchema = z.string().regex(ENTITY_ID_PATTERN);

export const isoDateSchema = z.iso.datetime({ offset: true });

/** More co-presenters than this is surely a mistake. */
export const MAX_CO_PROPONENTS = 20;

/** Members presenting a document jointly with its main presenter. */
const coProponentIdsSchema = z
  .array(entityIdSchema)
  .max(MAX_CO_PROPONENTS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "duplicate_member_id",
  });

const titleSchema = z.string().trim().min(1).max(300);
/** An empty summary is stored as null. */
const summarySchema = z
  .string()
  .trim()
  .max(5_000)
  .transform((value) => value || null);

export const documentCreateSchema = z.object({
  agendaItemId: entityIdSchema,
  kind: z.enum(DOCUMENT_KINDS),
  format: z.enum(DOCUMENT_FORMATS),
  title: titleSchema,
  summary: summarySchema.nullable().optional(),
  proponentMemberId: entityIdSchema.nullable().optional(),
  coProponentMemberIds: coProponentIdsSchema.optional(),
  amendable: z.boolean().optional(),
  acceptedAmendments: z.enum(ACCEPTED_AMENDMENT_RULES).optional(),
  voted: z.boolean().optional(),
  majority: z.enum(MAJORITIES).optional(),
  blocks: blocksSchema.optional(),
  dueAt: isoDateSchema.nullable().optional(),
});

/**
 * Body of POST .../agenda/[item]/documents (BulkDocumentsBody): the
 * documents a manager adds to one agenda item in one go. Each row is a
 * placeholder to fill in later (its text in the editor, its PDF through the
 * upload endpoint), so it carries no text.
 */
export const bulkDocumentsSchema = z.object({
  documents: z
    .array(
      z.object({
        title: titleSchema,
        kind: z.enum(DOCUMENT_KINDS),
        format: z.enum(DOCUMENT_FORMATS),
        proponentMemberId: entityIdSchema.nullable().optional(),
        dueAt: isoDateSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(BULK_DOCUMENTS_MAX),
});

export const documentUpdateSchema = z.object({
  title: titleSchema.optional(),
  summary: summarySchema.nullable().optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  format: z.enum(DOCUMENT_FORMATS).optional(),
  agendaItemId: entityIdSchema.optional(),
  proponentMemberId: entityIdSchema.nullable().optional(),
  coProponentMemberIds: coProponentIdsSchema.optional(),
  amendable: z.boolean().optional(),
  voted: z.boolean().optional(),
  majority: z.enum(MAJORITIES).optional(),
  acceptedAmendments: z.enum(ACCEPTED_AMENDMENT_RULES).optional(),
  amendmentsOpenAt: isoDateSchema.nullable().optional(),
  amendmentsCloseAt: isoDateSchema.nullable().optional(),
  dueAt: isoDateSchema.nullable().optional(),
  status: z.enum(["withdrawn", "postponed", "submitted"]).optional(),
  updatedAt: isoDateSchema,
});

export const CORRECTION_NOTE_MAX_LENGTH = 2_000;

/**
 * Body of POST .../correction for documents and amendments (CorrectionBody):
 * the note tells the presenters what to fix, so it cannot be empty.
 */
export const correctionBodySchema = z.object({
  note: z.string().trim().min(1).max(CORRECTION_NOTE_MAX_LENGTH),
  updatedAt: isoDateSchema,
});

/**
 * Body of POST .../amendments/[amendment]/correction
 * (AmendmentCorrectionBody): the same note, and whether the amendment can be
 * corrected (`correctable`, true when absent); false declares it not
 * admitted instead, and then the note may be left empty (user's decision
 * of 2026-11-20).
 */
export const amendmentCorrectionBodySchema = z
  .object({
    note: z.string().trim().max(CORRECTION_NOTE_MAX_LENGTH),
    updatedAt: isoDateSchema,
    correctable: z.boolean().optional(),
  })
  .refine((body) => body.correctable === false || body.note.length > 0, {
    message: "note_required",
    path: ["note"],
  });

/** Body of PUT .../documents/[document]/positions (PositionsPublicationBody). */
export const positionsPublicationBodySchema = z.object({
  public: z.boolean(),
  updatedAt: isoDateSchema,
});

/** Body of POST .../amendments/[amendment]/unvalidate (UndoValidationBody). */
export const undoValidationBodySchema = z.object({
  updatedAt: isoDateSchema,
});

/** SHA-256 hex digest, as produced by hashContent. */
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const documentContentSchema = z.object({
  blocks: blocksSchema,
  baseHash: contentHashSchema,
});

/** The most a correction of form's reason or the Secretaría's note takes. */
export const FORM_CORRECTION_REASON_MAX_LENGTH = 2_000;

/** Body of POST .../form-corrections (FormCorrectionBody). */
export const formCorrectionSchema = z.object({
  fromVersionId: z.string().min(1).max(64),
  blocks: blocksSchema,
  reason: z.string().trim().min(1).max(FORM_CORRECTION_REASON_MAX_LENGTH),
});

/**
 * Body of POST .../conciliations (ConciliationBody): the wording of a
 * passage the final vote left pending, as the Mesa's wordings are.
 */
export const conciliationSchema = passageWordingBodySchema
  .pick({ amendmentIds: true, blockIds: true, ops: true })
  .extend({
    fromVersionId: z.string().min(1).max(64),
    reason: z
      .string()
      .trim()
      .max(FORM_CORRECTION_REASON_MAX_LENGTH)
      .transform((value) => value || null)
      .nullable()
      .optional(),
  });

/** Body of POST .../form-corrections/[correction]/decision. */
export const formCorrectionDecisionSchema = z.object({
  decision: z.enum(["apply", "reject"]),
  note: z
    .string()
    .trim()
    .max(FORM_CORRECTION_REASON_MAX_LENGTH)
    .transform((value) => value || null)
    .nullable()
    .optional(),
  updatedAt: isoDateSchema,
});

/** Body of DELETE .../form-corrections/[correction]. */
export const formCorrectionWithdrawSchema = z.object({
  updatedAt: isoDateSchema,
});

/** Time a published document was open (DocumentReadingBody). */
export const documentReadingSchema = z.strictObject({
  opened: z.boolean().optional(),
  seconds: z.int().min(0).max(READING_BEAT_MAX_SECONDS),
});

/** Heartbeat of an open draft editor (DocumentPresenceBody). */
export const documentPresenceSchema = z.strictObject({
  tabId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  unsaved: z.boolean().optional(),
  leaving: z.boolean().optional(),
});

/** Optional body of submit and publish: the updatedAt the client last saw. */
export const documentActionSchema = z
  .object({ updatedAt: isoDateSchema.optional() })
  .default({});

// One vote input for every vote body (./vote.ts).
export { voteInputSchema };

export const finalVoteSchema = z.object({
  vote: voteInputSchema,
  order: z
    .array(entityIdSchema)
    .max(2_000)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "duplicate_amendment_id",
    })
    .optional(),
  project: z.boolean().optional(),
  allowPendingPassages: z.boolean().optional(),
});

/** Body of DELETE .../final-vote (FinalVoteAnnulBody). An empty note is null. */
export const finalVoteAnnulSchema = z.object({
  updatedAt: isoDateSchema,
  note: z
    .string()
    .trim()
    .max(2_000)
    .transform((value) => value || null)
    .nullable()
    .optional(),
});

// Compile-time checks: every parsed body is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _DocumentSchemaChecks = [
  Assignable<DocumentCreateBody, z.output<typeof documentCreateSchema>>,
  Assignable<BulkDocumentsBody, z.output<typeof bulkDocumentsSchema>>,
  Assignable<DocumentUpdateBody, z.output<typeof documentUpdateSchema>>,
  Assignable<CorrectionBody, z.output<typeof correctionBodySchema>>,
  Assignable<
    AmendmentCorrectionBody,
    z.output<typeof amendmentCorrectionBodySchema>
  >,
  Assignable<UndoValidationBody, z.output<typeof undoValidationBodySchema>>,
  Assignable<FinalVoteBody, z.output<typeof finalVoteSchema>>,
  Assignable<FinalVoteAnnulBody, z.output<typeof finalVoteAnnulSchema>>,
  Assignable<FormCorrectionBody, z.output<typeof formCorrectionSchema>>,
  Assignable<ConciliationBody, z.output<typeof conciliationSchema>>,
  Assignable<
    FormCorrectionDecisionBody,
    z.output<typeof formCorrectionDecisionSchema>
  >,
  Assignable<
    FormCorrectionWithdrawBody,
    z.output<typeof formCorrectionWithdrawSchema>
  >,
];
