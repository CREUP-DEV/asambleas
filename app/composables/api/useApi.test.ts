import { describe, expect, it } from "vitest";
import { createError } from "h3";
import {
  ERROR_REASONS,
  LISTED_ERROR_REASONS,
  listedErrorReasonMessageKey,
} from "~~/shared/constants/errorReasons";
import {
  IDENTITY_CHANGED_KEY,
  errorKeyCandidates,
  errorMessageKey,
  errorPayload,
  errorReasonKey,
  errorStatus,
  isConflict,
  isIdentityChanged,
} from "./useApi";
import es from "../../../i18n/locales/es.json";
import en from "../../../i18n/locales/en.json";

/** The message at a dotted key of a locale file, or undefined. */
function messageIn(locale: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale,
    );
}

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

  it("words the calendar 409s apart from the optimistic lock", () => {
    expect(errorReasonKey(fetchError(409, { reason: "assembly_closed" }))).toBe(
      "common.errors.assemblyClosed",
    );
    expect(
      errorReasonKey(
        createError({
          statusCode: 409,
          data: { reason: "documents_deadline_passed" },
        }),
      ),
    ).toBe("common.errors.documentsDeadlinePassed");
    for (const key of [
      "common.errors.assemblyClosed",
      "common.errors.documentsDeadlinePassed",
      "common.errors.conflict",
      "common.errors.conflictState",
    ]) {
      expect(messageIn(es, key)).toBeTypeOf("string");
      expect(messageIn(en, key)).toBeTypeOf("string");
    }
    // The lock's own 409 keeps the conflict text; one with no reason reads
    // the neutral status text.
    expect(errorReasonKey(fetchError(409, { reason: "stale_write" }))).toBe(
      "common.errors.conflict",
    );
    expect(errorReasonKey(fetchError(409))).toBeNull();
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

describe("the catalog of refusals", () => {
  it("has every key it words a code with in both locales", () => {
    const keys = [
      ...Object.values(ERROR_REASONS).filter(
        (key): key is NonNullable<typeof key> => key !== null,
      ),
      ...LISTED_ERROR_REASONS.map(listedErrorReasonMessageKey),
    ];
    for (const key of keys) {
      expect(messageIn(es, key), key).toBeTypeOf("string");
      expect(messageIn(en, key), key).toBeTypeOf("string");
    }
  });

  it("names its codes in snake_case", () => {
    for (const code of Object.keys(ERROR_REASONS)) {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });
});

describe("errorPayload", () => {
  it("reads a fetch error and an H3Error alike", () => {
    const data = { reason: "seating_stale", layoutUpdatedAt: "x" };
    for (const error of [
      fetchError(409, data),
      createError({ statusCode: 409, data }),
    ]) {
      expect(errorPayload(error)).toEqual({
        status: 409,
        reason: "seating_stale",
        reasons: [],
        messageKey: null,
        data,
      });
    }
  });

  it("keeps only a reason of the catalog", () => {
    expect(errorPayload(fetchError(409, { reason: "gone" })).reason).toBeNull();
    expect(
      errorPayload(fetchError(409, { reason: "toString" })).reason,
    ).toBeNull();
  });

  it("reads the list of problems of a 422", () => {
    expect(
      errorPayload(
        fetchError(422, {
          reasons: [
            { index: 2, reason: "noop" },
            { reason: "inconsistent_counts" },
            { index: 1 },
          ],
        }),
      ).reasons,
    ).toEqual([
      { index: 2, reason: "noop" },
      { index: -1, reason: "inconsistent_counts" },
    ]);
  });

  it("carries no data for a body without any, nor for a network failure", () => {
    expect(errorPayload(fetchError(409)).data).toEqual({});
    expect(errorPayload(new Error("network"))).toEqual({
      status: null,
      reason: null,
      reasons: [],
      messageKey: null,
      data: {},
    });
    expect(errorPayload(null).data).toEqual({});
  });

  it("reads the shape before ARQ-1 for one release", () => {
    expect(
      errorPayload(fetchError(409, { code: "agenda_item_live" })).reason,
    ).toBe("agenda_item_live");
    expect(
      errorPayload(fetchError(409, { code: "passage_changed" })).reason,
    ).toBe("passage_changed");
    expect(errorPayload(fetchError(409, { stale: true })).reason).toBe(
      "form_correction_stale",
    );
    expect(
      errorPayload(fetchError(409, { pendingConciliation: true })).reason,
    ).toBe("form_correction_pending_conciliation");
    expect(errorPayload(fetchError(422, { reason: "empty" })).reason).toBe(
      "docx_empty",
    );
    expect(errorPayload(fetchError(422, { reason: "no_change" })).reason).toBe(
      "form_correction_no_change",
    );
    // A real lock miss keeps its own reason over the old flag.
    expect(
      errorPayload(fetchError(409, { stale: true, reason: "stale_write" }))
        .reason,
    ).toBe("stale_write");
  });
});

describe("errorKeyCandidates", () => {
  it("offers the messageKey, the reason's key and the first listed code's", () => {
    expect(
      errorKeyCandidates(
        errorPayload(
          fetchError(409, {
            messageKey: "common.errors.sessionNotOpen",
            reason: "seating_stale",
          }),
        ),
      ),
    ).toEqual(["common.errors.sessionNotOpen", "common.errors.seatingStale"]);
    // A vote whose counts do not add up words why, not «datos no válidos».
    expect(
      errorKeyCandidates(
        errorPayload(
          fetchError(422, {
            reasons: [
              { index: -1, reason: "unknown_member" },
              { index: -1, reason: "inconsistent_counts" },
            ],
          }),
        ),
      ),
    ).toEqual(["amendment.errors.inconsistent_counts"]);
  });

  it("offers nothing for a code without a key, a 5xx or a network failure", () => {
    expect(
      errorKeyCandidates(
        errorPayload(fetchError(422, { reason: "submission_kind" })),
      ),
    ).toEqual([]);
    expect(
      errorKeyCandidates(
        errorPayload(fetchError(500, { messageKey: "common.errors.conflict" })),
      ),
    ).toEqual([]);
    expect(errorKeyCandidates(errorPayload(new Error("network")))).toEqual([]);
  });
});
