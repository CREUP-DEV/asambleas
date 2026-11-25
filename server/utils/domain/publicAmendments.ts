import { and, isNotNull, notInArray, type SQL } from "drizzle-orm";
import type { AmendmentStatus } from "~~/shared/constants/domain";
import { amendments } from "../../db/schema";

/**
 * Statuses that are never public, published or not: drafts, and withdrawn
 * amendments (user's decision of 2026-11-17).
 */
export const NEVER_PUBLIC_AMENDMENT_STATUSES: readonly AmendmentStatus[] = [
  "draft",
  "withdrawn",
];

/**
 * An amendment everyone who sees its document reads (canSeeAmendment): the
 * Secretaría published it (`publishedAt`) and it is neither a draft nor
 * withdrawn.
 */
export function isPublicAmendment(amendment: {
  status: AmendmentStatus;
  publishedAt: Date | string | null;
}): boolean {
  return (
    amendment.publishedAt !== null &&
    !NEVER_PUBLIC_AMENDMENT_STATUSES.includes(amendment.status)
  );
}

/**
 * isPublicAmendment as a condition on `amendments`, for the queries that
 * list what everyone reads (the read marks). Never write the rule again in
 * SQL: change it here and in isPublicAmendment together
 * (publicAmendments.test.ts checks they agree).
 */
export function publicAmendmentWhere(): SQL {
  return and(
    notInArray(amendments.status, [...NEVER_PUBLIC_AMENDMENT_STATUSES]),
    isNotNull(amendments.publishedAt),
  )!;
}
