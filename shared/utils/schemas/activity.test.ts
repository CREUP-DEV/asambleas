import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PAGE_DEFAULT_LIMIT,
  ADMIN_ACTIVITY_MAX_LIMIT,
  IMPERSONATION_REASON_MAX_LENGTH,
  ME_ACTIVITY_MAX_LIMIT,
} from "../../constants/activity";
import {
  adminActivityQuerySchema,
  adminImpersonationQuerySchema,
  decodeActivityCursor,
  encodeActivityCursor,
  impersonationStartBodySchema,
  meActivityQuerySchema,
} from "./activity";

const USER_ID = "Ab3dEfGhIjKlMnOpQrStUvWxYz012345";
const CUID = "clz0abc1def2ghi3jkl4mno5";

describe("activity cursor", () => {
  it("round-trips the microsecond time and the id", () => {
    const cursor = { at: "2026-11-05T10:15:30.123456Z", id: CUID };
    const encoded = encodeActivityCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(encoded)).toEqual(cursor);
    expect(
      decodeActivityCursor(
        encodeActivityCursor({ at: "2026-11-05T10:15:30Z", id: CUID }),
      ),
    ).toEqual({ at: "2026-11-05T10:15:30Z", id: CUID });
  });

  it("rejects anything this API did not issue", () => {
    for (const value of [
      "",
      "not a cursor",
      "e30",
      encodeActivityCursor({ at: "yesterday", id: CUID }),
      encodeActivityCursor({ at: "2026-11-05T10:15:30.1234567Z", id: CUID }),
      encodeActivityCursor({ at: "2026-11-05T10:15:30Z", id: "'; drop" }),
      "A".repeat(500),
    ]) {
      expect(decodeActivityCursor(value)).toBeNull();
    }
    expect(
      meActivityQuerySchema.safeParse({ cursor: "garbage!" }).success,
    ).toBe(false);
  });

  it("rejects times of the right shape that name no instant Postgres takes", () => {
    for (const at of [
      "2026-02-30T00:00:00Z",
      "2026-99-99T99:99:99Z",
      "2026-01-01T25:00:00Z",
      "2026-01-01T24:00:00Z",
      "0000-01-01T00:00:00Z",
    ]) {
      expect(decodeActivityCursor(encodeActivityCursor({ at, id: CUID }))).toBe(
        null,
      );
    }
    expect(
      decodeActivityCursor(
        encodeActivityCursor({ at: "2024-02-29T23:59:59.999999Z", id: CUID }),
      ),
    ).toEqual({ at: "2024-02-29T23:59:59.999999Z", id: CUID });
  });
});

describe("impersonationStartBodySchema", () => {
  it("needs a one-line reason of 1..200 characters", () => {
    expect(
      impersonationStartBodySchema.parse({
        reason: "  Revisar\n su  borrador ",
      }),
    ).toEqual({ reason: "Revisar su borrador" });
    expect(
      impersonationStartBodySchema.safeParse({ reason: "   " }).success,
    ).toBe(false);
    expect(impersonationStartBodySchema.safeParse({}).success).toBe(false);
    expect(
      impersonationStartBodySchema.safeParse({
        reason: "x".repeat(IMPERSONATION_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("meActivityQuerySchema", () => {
  it("defaults to what I did, 50 at a time", () => {
    expect(meActivityQuerySchema.parse({})).toEqual({
      tab: "by",
      limit: ACTIVITY_PAGE_DEFAULT_LIMIT,
    });
  });

  it("parses tabs, filters, dates and pages", () => {
    const cursor = encodeActivityCursor({
      at: "2026-11-05T10:15:30.5Z",
      id: CUID,
    });
    expect(
      meActivityQuerySchema.parse({
        tab: "access",
        assembly: "80-ago",
        category: ["document", "amendment,document"],
        from: "2026-10-01T00:00:00+02:00",
        to: "2026-11-01T00:00:00+01:00",
        cursor,
        limit: "20",
      }),
    ).toEqual({
      tab: "access",
      assembly: "80-ago",
      category: ["document", "amendment"],
      from: "2026-10-01T00:00:00+02:00",
      to: "2026-11-01T00:00:00+01:00",
      cursor: { at: "2026-11-05T10:15:30.5Z", id: CUID },
      limit: 20,
    });
  });

  it("rejects unknown tabs, bad ranges and oversized pages", () => {
    for (const query of [
      { tab: "all" },
      { category: "everything" },
      { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" },
      { from: "2026-11-01" },
      { from: "2026-02-30T00:00:00Z" },
      { from: "0000-01-01T00:00:00Z" },
      { to: "0000-06-01T00:00:00+02:00" },
      { limit: String(ME_ACTIVITY_MAX_LIMIT + 1) },
      { limit: "0" },
      { assembly: "../etc" },
    ]) {
      expect(meActivityQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("treats an empty list filter as missing", () => {
    expect(meActivityQuerySchema.parse({ category: "" }).category).toBe(
      undefined,
    );
  });
});

describe("adminActivityQuerySchema", () => {
  it("parses every filter", () => {
    expect(
      adminActivityQuerySchema.parse({
        actor: USER_ID,
        target: USER_ID,
        user: USER_ID,
        member: CUID,
        assembly: CUID,
        action: ["role.assign", "amendment_submitted"],
        category: "account,access",
        kind: ["event", "audit"],
        source: "intranet",
        impersonated: "true",
        impersonation: CUID,
        q: "  ana   garcía ",
        limit: String(ADMIN_ACTIVITY_MAX_LIMIT),
      }),
    ).toEqual({
      actor: USER_ID,
      target: USER_ID,
      user: USER_ID,
      member: CUID,
      assembly: CUID,
      action: ["role.assign", "amendment_submitted"],
      category: ["account", "access"],
      kind: ["event", "audit"],
      source: ["intranet"],
      impersonated: true,
      impersonation: CUID,
      q: "ana garcía",
      limit: ADMIN_ACTIVITY_MAX_LIMIT,
    });
    expect(adminActivityQuerySchema.parse({ impersonated: "0" })).toMatchObject(
      { impersonated: false },
    );
    expect(adminActivityQuerySchema.parse({ q: "   " }).q).toBeUndefined();
  });

  it("rejects ids of the wrong kind and unknown values", () => {
    for (const query of [
      { actor: CUID },
      { member: USER_ID },
      { kind: "session" },
      { source: "web" },
      { action: "DROP TABLE" },
      { impersonated: "yes" },
      { limit: String(ADMIN_ACTIVITY_MAX_LIMIT + 1) },
      { q: "x".repeat(101) },
    ]) {
      expect(adminActivityQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe("adminImpersonationQuerySchema", () => {
  it("filters by Admin, target and whether it still applies", () => {
    expect(
      adminImpersonationQuerySchema.parse({
        admin: USER_ID,
        active: "1",
      }),
    ).toEqual({
      admin: USER_ID,
      active: true,
      limit: ACTIVITY_PAGE_DEFAULT_LIMIT,
    });
    expect(
      adminImpersonationQuerySchema.safeParse({ target: "nope" }).success,
    ).toBe(false);
  });
});
