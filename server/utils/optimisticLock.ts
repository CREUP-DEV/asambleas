import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { STALE_WRITE_REASON } from "~~/shared/constants/errorReasons";
import { httpError } from "./core/http";

/**
 * Optimistic locking (ARQ-31): a client echoes back the `updatedAt` it read
 * and a write whose row moved on since answers 409 `stale_write`. Two forms
 * share one comparison, at millisecond precision (what a DTO carries):
 *
 * - `buildOptimisticLockCondition`, in the UPDATE's WHERE, for a write that
 *   is one statement: no row comes back when the token is stale.
 * - `assertOptimisticLock`, on a row already locked FOR UPDATE, for a write
 *   that checks more than the token first.
 *
 * A missing `updatedAt` is refused (409) unless the call says it may be
 * missing (`{ optional: true }`), never by default. A rule of its own for
 * null (the control sheet's fields, Sala's layout, a position's answer)
 * compares with `isStale` and says what null means where it does.
 */

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
 * `data` of a write refused because the row changed since the client read
 * it (`stale_write`, STALE_WRITE_REASON in the catalog of
 * `shared/constants/errorReasons.ts`), for `fail`. The client words it
 * «Alguien ha modificado estos datos…» (`common.errors.conflict`); a 409
 * without a reason is a rule of the current state and reads a neutral text.
 */
export const STALE_WRITE_DATA = { reason: STALE_WRITE_REASON } as const;

/** The 409 of a stale write: `message` for the logs, the reason for the user. */
export function staleWriteError(message: string) {
  return httpError(409, message, STALE_WRITE_DATA);
}

/**
 * Whether the token a client sent no longer names the stored row: their
 * instants differ to the millisecond. Null, undefined and an unreadable
 * value all read as "none", so none against none is not stale.
 */
export function isStale(
  stored: string | Date | null | undefined,
  sent: string | Date | null | undefined,
): boolean {
  return (
    getOptimisticLockTimestampMs(stored) !== getOptimisticLockTimestampMs(sent)
  );
}

export interface OptimisticLockOptions {
  /**
   * The client may leave `updatedAt` out (an empty string counts as out),
   * and then nothing is checked. Only where the API says so on purpose:
   * submitting and publishing a document, a multipart upload.
   */
  optional?: boolean;
}

/**
 * Throws the 409 of a stale write when `clientUpdatedAt` is not the stored
 * row's `updatedAt`, or when it is missing and not `optional`.
 */
export function assertOptimisticLock(
  clientUpdatedAt: string | null | undefined,
  serverUpdatedAt: string | Date | null | undefined,
  message: string,
  options: OptimisticLockOptions = {},
) {
  if (!clientUpdatedAt) {
    if (options.optional) return;
    throw staleWriteError(message);
  }
  if (isStale(serverUpdatedAt, clientUpdatedAt)) {
    throw staleWriteError(message);
  }
}

/**
 * The WHERE condition of a locked UPDATE. A missing `clientUpdatedAt`
 * compares with 0 and so always fails: this form has no optional mode.
 */
export function buildOptimisticLockCondition(
  updatedAtColumn: SQLWrapper,
  clientUpdatedAt: string | null | undefined,
) {
  return sql`floor(extract(epoch from ${updatedAtColumn}) * 1000) = ${getOptimisticLockTimestampMs(clientUpdatedAt)}`;
}

/**
 * The `updatedAt` of an UPDATE that must not move the lock token. The
 * column's `$onUpdate` (to `now()`) moves it on every write, so a
 * client holding the row would get 409 on its next save; a write that
 * changes nothing a client edits or reads through that token (a stamp in no
 * DTO, a renumbered queue, a cached image's file name) sets
 * `updatedAt: keepUpdatedAt(table.updatedAt)` instead.
 */
export function keepUpdatedAt(column: SQLWrapper): SQL {
  return sql`${column}`;
}
