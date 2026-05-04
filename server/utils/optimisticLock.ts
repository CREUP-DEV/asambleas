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
    throw createError({
      statusCode: 409,
      message,
    });
  }
}

export function buildOptimisticLockCondition(
  updatedAtColumn: SQLWrapper,
  clientUpdatedAt: string | null | undefined,
) {
  return sql`floor(extract(epoch from ${updatedAtColumn}) * 1000) = ${getOptimisticLockTimestampMs(clientUpdatedAt)}`;
}
