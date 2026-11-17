import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// The query rules only: the database is never reached.
vi.mock("../../db", () => ({ db: {} }));

const {
  ADMIN_USER_COLUMNS,
  adminUsersAccessWhere,
  adminUsersQuerySchema,
  adminUsersRoleWhere,
  adminUsersSearchWhere,
  adminUsersWhere,
} = await import("./adminUsers");

const dialect = new PgDialect();

describe("adminUsersQuerySchema", () => {
  it("lists every account by default", () => {
    expect(adminUsersQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 50,
      access: "all",
    });
  });

  it("reads the page, the page size and the access filter from the query", () => {
    expect(
      adminUsersQuerySchema.parse({
        page: "3",
        pageSize: "20",
        access: "revoked",
      }),
    ).toEqual({ page: 3, pageSize: 20, access: "revoked" });
  });

  it("rejects an unknown access filter", () => {
    expect(adminUsersQuerySchema.safeParse({ access: "foo" }).success).toBe(
      false,
    );
    expect(
      adminUsersQuerySchema.safeParse({ access: ["revoked", "all"] }).success,
    ).toBe(false);
  });

  it("still rejects an invalid page", () => {
    expect(adminUsersQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(adminUsersQuerySchema.safeParse({ pageSize: "101" }).success).toBe(
      false,
    );
  });
});

describe("adminUsersAccessWhere", () => {
  it("adds no condition for every account", () => {
    expect(adminUsersAccessWhere("all")).toBeUndefined();
  });

  it("keeps only the accounts that lost access", () => {
    const where = adminUsersAccessWhere("revoked");
    expect(where).toBeDefined();
    expect(dialect.sqlToQuery(where!).sql).toBe(
      '"users"."access_revoked_at" is not null',
    );
  });
});

describe("ADMIN_USER_COLUMNS", () => {
  it("returns when and why an account lost access", () => {
    expect(ADMIN_USER_COLUMNS).toMatchObject({
      accessRevokedAt: true,
      accessRevokedReason: true,
    });
  });
});

describe("adminUsersSearchWhere", () => {
  it("adds no condition for an empty search", () => {
    expect(adminUsersSearchWhere(undefined)).toBeUndefined();
    expect(adminUsersQuerySchema.parse({ q: "   " }).q).toBeUndefined();
  });

  it("looks for the text in the account and in its member", () => {
    const query = dialect.sqlToQuery(adminUsersSearchWhere("CEUM")!);
    expect(query.sql).toContain('"users"."name" ilike');
    expect(query.sql).toContain('"users"."email" ilike');
    expect(query.sql).toContain('"users"."external_initials" ilike');
    expect(query.sql).toContain("m.acronym ilike");
    expect(query.params).toContain("%CEUM%");
  });

  it("matches % and _ literally", () => {
    const query = dialect.sqlToQuery(adminUsersSearchWhere("50%_a")!);
    expect(query.params).toContain(String.raw`%50\%\_a%`);
  });

  it("combines the search with the access filter", () => {
    const query = dialect.sqlToQuery(adminUsersWhere("revoked", "SE")!);
    expect(query.sql).toContain('"users"."access_revoked_at" is not null');
    expect(query.sql).toContain('"users"."name" ilike');
  });

  it("filters by role, alone or with the others", () => {
    expect(adminUsersRoleWhere(undefined)).toBeUndefined();
    const alone = dialect.sqlToQuery(adminUsersWhere("all", undefined, "r1")!);
    expect(alone.sql).toBe('"users"."role_id" = $1');
    expect(alone.params).toEqual(["r1"]);
    const all = dialect.sqlToQuery(adminUsersWhere("revoked", "SE", "r1")!);
    expect(all.sql).toContain('"users"."access_revoked_at" is not null');
    expect(all.sql).toContain('"users"."role_id" =');
  });
});

describe("the role filter in the query", () => {
  it("reads a role id, blank being no filter", () => {
    expect(adminUsersQuerySchema.parse({ role: " r1 " }).role).toBe("r1");
    expect(adminUsersQuerySchema.parse({ role: "  " }).role).toBeUndefined();
    expect(
      adminUsersQuerySchema.safeParse({ role: "x".repeat(65) }).success,
    ).toBe(false);
  });
});
