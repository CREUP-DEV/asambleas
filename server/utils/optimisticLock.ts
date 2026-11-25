import { createError } from "h3";
import { sql, type SQLWrapper } from "drizzle-orm";

export function getOptimisticLockTimestampMs(
  value: string | Date | null | undefined,
) {
  if (!value) {
    return 0;
  }

  const timestamp =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/**
 * `data.reason` of a write refused because the row changed since the client
 * read it. useApi's REASON_KEYS words it «Alguien ha modificado estos
 * datos…» (`common.errors.conflict`); a 409 without a reason is a rule of
 * the current state and reads a neutral text.
 */
export const STALE_WRITE_REASON = "stale_write";

/** `data` of a stale write's 409 (STALE_WRITE_REASON), for `fail`. */
export const STALE_WRITE_DATA = { reason: STALE_WRITE_REASON } as const;

/** The 409 of a stale write: `message` for the logs, the reason for the user. */
export function staleWriteError(message: string) {
  return createError({ statusCode: 409, message, data: STALE_WRITE_DATA });
}

export function assertOptimisticLock(
  clientUpdatedAt: string | null | undefined,
  serverUpdatedAt: string | Date | null | undefined,
  message: string,
) {
  if (!clientUpdatedAt) {
    return;
  }

  if (
    getOptimisticLockTimestampMs(clientUpdatedAt) !==
    getOptimisticLockTimestampMs(serverUpdatedAt)
  ) {
    throw staleWriteError(message);
  }
}

export function buildOptimisticLockCondition(
  updatedAtColumn: SQLWrapper,
  clientUpdatedAt: string | null | undefined,
) {
  return sql`floor(extract(epoch from ${updatedAtColumn}) * 1000) = ${getOptimisticLockTimestampMs(clientUpdatedAt)}`;
}
