import { createError } from "h3";
import { eq, sql } from "drizzle-orm";
import type { AmendmentStatus } from "~~/shared/constants/statuses";
import {
  AMENDMENT_STATUSES,
  AMENDMENT_INCORPORATED_STATUSES,
} from "~~/shared/constants/statuses";
import { applyPatch, hashContent } from "~~/shared/utils/diff";
import { sanitizeRichTextHtml } from "./richText";
import { amendments } from "../db/schema/amendment";
import { documents } from "../db/schema/document";
import type { ContentHistoryEntry } from "../db/schema/document";

type TransactionContext = Parameters<
  Parameters<typeof import("../db").db.transaction>[0]
>[0];

export const AMENDMENT_STATUS_TRANSITIONS: Record<
  AmendmentStatus,
  AmendmentStatus[]
> = {
  [AMENDMENT_STATUSES.DRAFT]: [AMENDMENT_STATUSES.PENDING_REVIEW],
  [AMENDMENT_STATUSES.PENDING_REVIEW]: [
    AMENDMENT_STATUSES.REJECTED_SECRETARIA,
    AMENDMENT_STATUSES.FORMAL,
    AMENDMENT_STATUSES.ACCEPTED_SECRETARIA,
  ],
  [AMENDMENT_STATUSES.REJECTED_SECRETARIA]: [],
  [AMENDMENT_STATUSES.FORMAL]: [],
  [AMENDMENT_STATUSES.ACCEPTED_SECRETARIA]: [
    AMENDMENT_STATUSES.ACCEPTED_PROPONENT,
    AMENDMENT_STATUSES.REJECTED_PROPONENT,
  ],
  [AMENDMENT_STATUSES.ACCEPTED_PROPONENT]: [],
  [AMENDMENT_STATUSES.REJECTED_PROPONENT]: [
    AMENDMENT_STATUSES.APPROVED_VOTE,
    AMENDMENT_STATUSES.REJECTED_VOTE,
  ],
  [AMENDMENT_STATUSES.APPROVED_VOTE]: [],
  [AMENDMENT_STATUSES.REJECTED_VOTE]: [],
};

export function validateAmendmentTransition(
  current: AmendmentStatus,
  target: AmendmentStatus,
): boolean {
  return AMENDMENT_STATUS_TRANSITIONS[current].includes(target);
}

export async function incorporateAmendment(
  tx: TransactionContext,
  amendmentId: string,
  incorporationType: ContentHistoryEntry["type"],
) {
  const amendment = await tx.query.amendments.findFirst({
    where: eq(amendments.id, amendmentId),
  });

  if (!amendment) {
    throw createError({ statusCode: 404, message: "Amendment not found" });
  }

  const document = await tx.query.documents.findFirst({
    where: eq(documents.id, amendment.documentId),
  });

  if (!document || !document.content) {
    throw createError({
      statusCode: 400,
      message: "Document has no content to patch",
    });
  }

  const patched = applyPatch(document.content, amendment.contentPatch);
  if (patched === null) {
    throw createError({
      statusCode: 409,
      message: "Amendment patch cannot be applied to current document content",
    });
  }

  const sanitizedPatched = sanitizeRichTextHtml(patched);
  const newVersion = await hashContent(sanitizedPatched);
  const historyEntry: ContentHistoryEntry = {
    contentHash: newVersion,
    amendmentId,
    type: incorporationType,
    incorporatedAt: new Date().toISOString(),
  };

  const existingHistory =
    (document.contentHistory as ContentHistoryEntry[] | null) ?? [];

  await tx
    .update(documents)
    .set({
      content: sanitizedPatched,
      contentVersion: newVersion,
      contentHistory: [...existingHistory, historyEntry],
      updatedAt: sql`now()`,
    })
    .where(eq(documents.id, amendment.documentId));
}

export function shouldIncorporate(status: AmendmentStatus): boolean {
  return AMENDMENT_INCORPORATED_STATUSES.includes(status);
}

export function getIncorporationType(
  status: AmendmentStatus,
): ContentHistoryEntry["type"] | null {
  switch (status) {
    case AMENDMENT_STATUSES.FORMAL:
      return "formal";
    case AMENDMENT_STATUSES.ACCEPTED_PROPONENT:
      return "accepted_proponent";
    case AMENDMENT_STATUSES.APPROVED_VOTE:
      return "approved_vote";
    default:
      return null;
  }
}
