import { describe, expect, it } from "vitest";
import { createError } from "h3";
import {
  IDENTITY_CHANGED_KEY,
  errorMessageKey,
  errorReasonKey,
  errorStatus,
  isConflict,
  isIdentityChanged,
} from "./useApi";

/** What ofetch throws: the JSON error body Nitro sent, in `data`. */
function fetchError(statusCode: number, data?: Record<string, unknown>) {
  return Object.assign(new Error("fetch failed"), {
    statusCode,
    data: { error: true, statusCode, message: "x", data },
  });
}

describe("errorMessageKey", () => {
  it("reads the key from a fetch error body and from an H3Error", () => {
    expect(
      errorMessageKey(fetchError(403, { messageKey: "admin.forbidden" })),
    ).toBe("admin.forbidden");
    expect(
      errorMessageKey(
        createError({
          statusCode: 409,
          data: { messageKey: IDENTITY_CHANGED_KEY },
        }),
      ),
    ).toBe(IDENTITY_CHANGED_KEY);
  });

  it("is null without one", () => {
    expect(errorMessageKey(fetchError(409))).toBeNull();
    expect(errorMessageKey(fetchError(409, { messageKey: "" }))).toBeNull();
    expect(errorMessageKey(fetchError(409, { messageKey: 3 }))).toBeNull();
    expect(errorMessageKey(new Error("network"))).toBeNull();
    expect(errorMessageKey(null)).toBeNull();
    expect(errorMessageKey("409")).toBeNull();
  });
});

describe("errorReasonKey", () => {
  it("words the refusal of the CEA, from a fetch error and an H3Error", () => {
    expect(
      errorReasonKey(fetchError(422, { reason: "executive_member" })),
    ).toBe("common.errors.executiveMember");
    expect(
      errorReasonKey(
        createError({ statusCode: 422, data: { reason: "executive_member" } }),
      ),
    ).toBe("common.errors.executiveMember");
    expect(errorReasonKey(fetchError(422, { reason: "executive_main" }))).toBe(
      "common.errors.executiveMain",
    );
  });

  it("words the refusal of the generic CEA on an amendment", () => {
    expect(
      errorReasonKey(fetchError(422, { reason: "executive_author" })),
    ).toBe("common.errors.executiveAuthor");
    expect(
      errorReasonKey(fetchError(422, { reason: "executive_author_main" })),
    ).toBeNull();
  });

  it("is null for other reasons and for none", () => {
    expect(errorReasonKey(fetchError(422, { reason: "file_kind" }))).toBeNull();
    expect(errorReasonKey(fetchError(422, { reason: "toString" }))).toBeNull();
    expect(errorReasonKey(fetchError(422, { reason: 3 }))).toBeNull();
    expect(errorReasonKey(fetchError(422))).toBeNull();
    expect(errorReasonKey(new Error("network"))).toBeNull();
    expect(errorReasonKey(null)).toBeNull();
  });
});

describe("isIdentityChanged", () => {
  it("recognises the stale-identity 409, which is no data conflict", () => {
    const error = fetchError(409, { messageKey: IDENTITY_CHANGED_KEY });
    expect(errorStatus(error)).toBe(409);
    expect(isIdentityChanged(error)).toBe(true);
    expect(isConflict(error)).toBe(false);
    expect(isConflict(fetchError(409))).toBe(true);
  });

  it("leaves other conflicts and statuses to the caller", () => {
    expect(isIdentityChanged(fetchError(409))).toBe(false);
    expect(
      isIdentityChanged(
        fetchError(409, { messageKey: "impersonation.errors.nested" }),
      ),
    ).toBe(false);
    expect(
      isIdentityChanged(fetchError(403, { messageKey: IDENTITY_CHANGED_KEY })),
    ).toBe(false);
  });
});
