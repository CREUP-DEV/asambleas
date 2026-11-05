import { describe, expect, it } from "vitest";
import {
  activityDateRange,
  activityDay,
  activityDayEnd,
  activityDayStart,
  adminActivityApiQuery,
  adminActivityFilterCount,
  adminActivityRouteQuery,
  adminImpersonationApiQuery,
  emptyAdminActivityFilters,
  meActivityApiQuery,
  meActivityHasFilters,
  meActivityRouteQuery,
  parseAdminActivityQuery,
  parseMeActivityQuery,
} from "./-filters";

const USER = "a".repeat(32);
const MEMBER = "m".repeat(24);
const IMPERSONATION = "i".repeat(24);

describe("activityDay", () => {
  it("keeps real days only", () => {
    expect(activityDay("2026-11-05")).toBe("2026-11-05");
    expect(activityDay(["2026-11-05", "2026-11-06"])).toBe("2026-11-05");
    expect(activityDay("2026-02-30")).toBeNull();
    expect(activityDay("2026-1-5")).toBeNull();
    expect(activityDay("yesterday")).toBeNull();
    expect(activityDay(undefined)).toBeNull();
  });
});

describe("day boundaries in Madrid", () => {
  it("starts a winter day at 23:00 UTC the day before", () => {
    expect(activityDayStart("2026-11-05")).toBe("2026-11-04T23:00:00.000Z");
    expect(activityDayEnd("2026-11-05")).toBe("2026-11-05T23:00:00.000Z");
  });

  it("starts a summer day at 22:00 UTC the day before", () => {
    expect(activityDayStart("2026-07-01")).toBe("2026-06-30T22:00:00.000Z");
  });

  it("spans 23 hours on the spring change", () => {
    const start = activityDayStart("2026-03-29");
    const end = activityDayEnd("2026-03-29");
    expect(start).toBe("2026-03-28T23:00:00.000Z");
    expect(end).toBe("2026-03-29T22:00:00.000Z");
    expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(23);
  });

  it("spans 25 hours on the autumn change", () => {
    const start = activityDayStart("2026-10-25");
    const end = activityDayEnd("2026-10-25");
    expect(start).toBe("2026-10-24T22:00:00.000Z");
    expect(end).toBe("2026-10-25T23:00:00.000Z");
    expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(25);
  });
});

describe("activityDateRange", () => {
  it("includes the whole last day", () => {
    expect(activityDateRange("2026-11-01", "2026-11-05")).toEqual({
      from: "2026-10-31T23:00:00.000Z",
      to: "2026-11-05T23:00:00.000Z",
    });
  });

  it("swaps an inverted pair instead of sending a refused query", () => {
    expect(activityDateRange("2026-11-05", "2026-11-01")).toEqual(
      activityDateRange("2026-11-01", "2026-11-05"),
    );
  });

  it("leaves an open end out", () => {
    expect(activityDateRange(null, "2026-11-05")).toEqual({
      from: undefined,
      to: "2026-11-05T23:00:00.000Z",
    });
    expect(activityDateRange(null, null)).toEqual({
      from: undefined,
      to: undefined,
    });
  });
});

describe("Mi actividad filters", () => {
  it("defaults to what the account did", () => {
    expect(parseMeActivityQuery({}, { hasMember: false })).toEqual({
      tab: "by",
      assembly: null,
      category: null,
      from: null,
      to: null,
    });
  });

  it("opens the member tab only for a linked account", () => {
    expect(
      parseMeActivityQuery({ tab: "member" }, { hasMember: true }).tab,
    ).toBe("member");
    expect(
      parseMeActivityQuery({ tab: "member" }, { hasMember: false }).tab,
    ).toBe("by");
    expect(parseMeActivityQuery({ tab: "nope" }, { hasMember: true }).tab).toBe(
      "by",
    );
  });

  it("drops filters the tab does not offer", () => {
    const filters = parseMeActivityQuery(
      { tab: "access", assembly: "80-ago", category: "document" },
      { hasMember: false },
    );
    expect(filters.assembly).toBeNull();
    expect(filters.category).toBeNull();
    expect(
      parseMeActivityQuery(
        { tab: "to", category: "roles" },
        { hasMember: false },
      ).category,
    ).toBe("roles");
    expect(
      parseMeActivityQuery({ category: "other" }, { hasMember: false })
        .category,
    ).toBeNull();
  });

  it("refuses malformed assemblies", () => {
    expect(
      parseMeActivityQuery({ assembly: "80 AGO" }, { hasMember: false })
        .assembly,
    ).toBeNull();
    expect(
      parseMeActivityQuery({ assembly: "80-ago" }, { hasMember: false })
        .assembly,
    ).toBe("80-ago");
  });

  it("round-trips through the URL", () => {
    const filters = parseMeActivityQuery(
      {
        tab: "member",
        assembly: "80-ago",
        category: "amendment",
        from: "2026-11-01",
        to: "2026-11-05",
      },
      { hasMember: true },
    );
    expect(
      parseMeActivityQuery(meActivityRouteQuery(filters), { hasMember: true }),
    ).toEqual(filters);
    expect(meActivityRouteQuery({ ...filters, tab: "by" }).tab).toBeUndefined();
    expect(meActivityHasFilters(filters)).toBe(true);
    expect(
      meActivityHasFilters(parseMeActivityQuery({}, { hasMember: false })),
    ).toBe(false);
  });

  it("builds the API query with day boundaries", () => {
    expect(
      meActivityApiQuery({
        tab: "by",
        assembly: "80-ago",
        category: "document",
        from: "2026-11-05",
        to: null,
      }),
    ).toEqual({
      tab: "by",
      assembly: "80-ago",
      category: "document",
      from: "2026-11-04T23:00:00.000Z",
    });
  });
});

describe("admin activity filters", () => {
  it("parses lists, booleans and ids", () => {
    const filters = parseAdminActivityQuery({
      view: "impersonations",
      user: USER,
      member: MEMBER,
      assembly: "80-ago",
      category: ["document,amendment", "bogus", "document"],
      source: "intranet,auth,nope",
      impersonated: "1",
      impersonation: IMPERSONATION,
      from: "2026-11-01",
      to: "2026-11-31",
      state: "active",
    });
    expect(filters).toEqual({
      view: "impersonations",
      user: USER,
      member: MEMBER,
      assembly: "80-ago",
      category: ["document", "amendment"],
      source: ["intranet", "auth"],
      impersonated: true,
      impersonation: IMPERSONATION,
      from: "2026-11-01",
      to: null,
      state: "active",
    });
  });

  it("ignores malformed ids", () => {
    const filters = parseAdminActivityQuery({
      user: "short",
      member: "NOT-A-CUID",
      impersonation: "x",
      view: "other",
      state: "maybe",
      impersonated: "yes",
    });
    expect(filters).toEqual(emptyAdminActivityFilters());
  });

  it("round-trips through the URL", () => {
    const filters = {
      ...emptyAdminActivityFilters(),
      user: USER,
      category: ["session" as const],
      source: ["system" as const, "seed" as const],
      impersonated: true,
      from: "2026-10-25",
    };
    expect(parseAdminActivityQuery(adminActivityRouteQuery(filters))).toEqual(
      filters,
    );
    expect(adminActivityRouteQuery(emptyAdminActivityFilters())).toEqual({
      view: undefined,
      user: undefined,
      member: undefined,
      assembly: undefined,
      category: undefined,
      source: undefined,
      impersonated: undefined,
      impersonation: undefined,
      from: undefined,
      to: undefined,
      state: undefined,
    });
  });

  it("comma-joins lists for the API and leaves empty filters out", () => {
    expect(
      adminActivityApiQuery({
        ...emptyAdminActivityFilters(),
        category: ["document", "amendment"],
        source: ["user"],
        impersonated: true,
        to: "2026-11-05",
      }),
    ).toEqual({
      category: "document,amendment",
      source: "user",
      impersonated: "1",
      to: "2026-11-05T23:00:00.000Z",
    });
    expect(adminActivityApiQuery(emptyAdminActivityFilters())).toEqual({});
  });

  it("filters impersonations by the account acted as and by state", () => {
    expect(
      adminImpersonationApiQuery({
        ...emptyAdminActivityFilters("impersonations"),
        user: USER,
        state: "ended",
      }),
    ).toEqual({ target: USER, active: "0" });
    expect(
      adminImpersonationApiQuery({
        ...emptyAdminActivityFilters("impersonations"),
        state: "active",
      }),
    ).toEqual({ active: "1" });
  });

  it("counts the log filters only", () => {
    expect(adminActivityFilterCount(emptyAdminActivityFilters())).toBe(0);
    expect(
      adminActivityFilterCount({
        ...emptyAdminActivityFilters("impersonations"),
        state: "active",
        user: USER,
        category: ["document", "amendment"],
        impersonated: true,
      }),
    ).toBe(3);
  });
});
