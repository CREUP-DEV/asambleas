import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { documents } from "../db/schema";
import {
  STALE_WRITE_REASON,
  assertOptimisticLock,
  buildOptimisticLockCondition,
  isStale,
  keepUpdatedAt,
} from "./optimisticLock";

const dialect = new PgDialect();
const AT = "2026-11-25T10:00:00.123Z";

function refusal(run: () => void) {
  try {
    run();
  } catch (error) {
    const { statusCode, data } = error as {
      statusCode?: number;
      data?: { reason?: string };
    };
    return { statusCode, reason: data?.reason };
  }
  return null;
}

describe("isStale", () => {
  it("compares instants to the millisecond, whatever their form", () => {
    expect(isStale(new Date(AT), AT)).toBe(false);
    expect(isStale(new Date(AT), "2026-11-25T11:00:00.123+01:00")).toBe(false);
    expect(isStale(new Date(AT), "2026-11-25T10:00:00.124Z")).toBe(true);
  });

  it("reads null, undefined and an unreadable value as none", () => {
    expect(isStale(null, null)).toBe(false);
    expect(isStale(null, undefined)).toBe(false);
    expect(isStale(new Date(AT), null)).toBe(true);
    expect(isStale(null, AT)).toBe(true);
    expect(isStale(new Date(AT), "not a date")).toBe(true);
  });
});

describe("assertOptimisticLock", () => {
  it("passes the token it was given and refuses another as stale", () => {
    expect(refusal(() => assertOptimisticLock(AT, new Date(AT), "x"))).toBe(
      null,
    );
    expect(
      refusal(() =>
        assertOptimisticLock("2026-11-25T09:00:00Z", new Date(AT), "x"),
      ),
    ).toEqual({ statusCode: 409, reason: STALE_WRITE_REASON });
  });

  it("refuses a missing token unless the call says it is optional", () => {
    for (const missing of [undefined, null, ""]) {
      expect(
        refusal(() => assertOptimisticLock(missing, new Date(AT), "x")),
      ).toEqual({ statusCode: 409, reason: STALE_WRITE_REASON });
      expect(
        refusal(() =>
          assertOptimisticLock(missing, new Date(AT), "x", { optional: true }),
        ),
      ).toBe(null);
    }
  });

  it("still checks a token that is optional but sent", () => {
    expect(
      refusal(() =>
        assertOptimisticLock("2026-11-25T09:00:00Z", new Date(AT), "x", {
          optional: true,
        }),
      ),
    ).toEqual({ statusCode: 409, reason: STALE_WRITE_REASON });
  });
});

describe("buildOptimisticLockCondition", () => {
  it("compares the column's milliseconds with the token's", () => {
    const query = dialect.sqlToQuery(
      buildOptimisticLockCondition(documents.updatedAt, AT),
    );
    expect(query.sql).toBe(
      'floor(extract(epoch from "documents"."updated_at") * 1000) = $1',
    );
    expect(query.params).toEqual([Date.parse(AT)]);
  });
});

describe("keepUpdatedAt", () => {
  it("sets the column to itself", () => {
    expect(dialect.sqlToQuery(keepUpdatedAt(documents.updatedAt)).sql).toBe(
      '"documents"."updated_at"',
    );
  });
});
