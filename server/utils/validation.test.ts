import { createId } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "~~/shared/constants/domain";
import { validateAuthId, validateCuid } from "./validation";

function statusOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
  return undefined;
}

describe("validateCuid", () => {
  it("passes a cuid2 and the CEA's generic member", () => {
    const id = createId();
    expect(validateCuid(id)).toBe(id);
    expect(validateCuid(GENERIC_EXECUTIVE_MEMBER_ID)).toBe(
      GENERIC_EXECUTIVE_MEMBER_ID,
    );
  });

  it("answers 400 to a missing or malformed id", () => {
    expect(statusOf(() => validateCuid(undefined))).toBe(400);
    expect(statusOf(() => validateCuid("short"))).toBe(400);
    expect(statusOf(() => validateCuid("A".repeat(24)))).toBe(400);
  });
});

describe("validateAuthId", () => {
  it("passes an account id and answers 400 to anything else", () => {
    const id = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    expect(validateAuthId(id)).toBe(id);
    expect(statusOf(() => validateAuthId(createId()))).toBe(400);
    expect(statusOf(() => validateAuthId(undefined))).toBe(400);
  });
});
