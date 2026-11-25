import { createId } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "../../constants/domain";
import { RECORD_KEY_PATTERN } from "../agreementsRecord";
import { controlSheetActivityQuerySchema } from "./activity";
import { controlSheetHistoryQuerySchema } from "./controlSheet";
import {
  ENTITY_ID_PATTERN,
  USER_ID_PATTERN,
  entityIdSchema,
  isEntityId,
  isoInstantSchema,
  updatedAtSchema,
  userIdSchema,
} from "./primitives";

const ACCOUNT = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

describe("entity ids", () => {
  it("takes what cuid() generates and the CEA's generic member", () => {
    for (const id of [createId(), createId(), GENERIC_EXECUTIVE_MEMBER_ID]) {
      expect(entityIdSchema.safeParse(id).success).toBe(true);
      expect(isEntityId(id)).toBe(true);
    }
  });

  it("refuses capitals, separators and lengths outside 20-32", () => {
    for (const id of [
      "A".repeat(24),
      "abc-def-ghi-jkl-mno-pqr",
      "a".repeat(19),
      "a".repeat(33),
      "../../etc/passwd",
      "",
    ]) {
      expect(ENTITY_ID_PATTERN.test(id)).toBe(false);
    }
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(null)).toBe(false);
  });

  it("is embedded unchanged by the patterns that carry an id", () => {
    const id = createId();
    expect(RECORD_KEY_PATTERN.test(`item:${id}`)).toBe(true);
    expect(RECORD_KEY_PATTERN.test(`doc:${id}:final:approved`)).toBe(true);
    expect(RECORD_KEY_PATTERN.test(`item:${id.toUpperCase()}`)).toBe(false);
    expect(
      controlSheetActivityQuerySchema.parse({ subject: `amendment:${id}` })
        .subject,
    ).toEqual({ type: "amendment", id });
    expect(
      controlSheetActivityQuerySchema.safeParse({ subject: `vote:${id}` })
        .success,
    ).toBe(false);
  });

  it("gives the sheet history the same id space as every other id", () => {
    for (const row of [
      createId(),
      GENERIC_EXECUTIVE_MEMBER_ID,
      "1".repeat(24),
    ]) {
      expect(controlSheetHistoryQuerySchema.safeParse({ row }).success).toBe(
        true,
      );
    }
    expect(
      controlSheetHistoryQuerySchema.safeParse({ row: "a".repeat(19) }).success,
    ).toBe(false);
  });
});

describe("account ids", () => {
  it("takes better-auth's 32 letters and digits, nothing else", () => {
    expect(userIdSchema.safeParse(ACCOUNT).success).toBe(true);
    expect(USER_ID_PATTERN.test(ACCOUNT.slice(1))).toBe(false);
    expect(USER_ID_PATTERN.test(`${ACCOUNT}a`)).toBe(false);
    expect(USER_ID_PATTERN.test(`${ACCOUNT.slice(1)}-`)).toBe(false);
  });
});

describe("isoInstantSchema", () => {
  it("takes an instant with Z or an offset", () => {
    expect(isoInstantSchema.safeParse("2026-11-25T10:00:00.000Z").success).toBe(
      true,
    );
    expect(
      isoInstantSchema.safeParse("2026-11-25T11:00:00+01:00").success,
    ).toBe(true);
    expect(updatedAtSchema.safeParse("0001-01-01T00:00:00Z").success).toBe(
      true,
    );
  });

  it("refuses year 0000, which Postgres cannot cast, and non-instants", () => {
    expect(isoInstantSchema.safeParse("0000-01-01T00:00:00Z").success).toBe(
      false,
    );
    expect(isoInstantSchema.safeParse("2026-11-25").success).toBe(false);
    expect(isoInstantSchema.safeParse("2026-11-25T10:00:00").success).toBe(
      false,
    );
    expect(isoInstantSchema.safeParse("yesterday").success).toBe(false);
  });

  it("keeps nullable and optional working on the refined schema", () => {
    expect(isoInstantSchema.nullable().parse(null)).toBeNull();
    expect(isoInstantSchema.optional().parse(undefined)).toBeUndefined();
  });
});
