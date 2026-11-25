import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_KEYS,
  type PermissionCheck,
  type PermissionKey,
} from "../constants/permissions";
import {
  moderates,
  notesSpeakers,
  readsControlSheet,
  recordsResults,
  reviewsAmendments,
  seesDraftAssemblies,
  usesReviewQueue,
  validatesDocuments,
  viewsSeating,
} from "./permissionRules";

/** A check over exactly these keys, as Actor.can does on the server. */
function only(...keys: PermissionKey[]): PermissionCheck {
  return (key) => keys.includes(key);
}

const K = PERMISSION_KEYS;

/** Each rule and the keys that, held alone, let an account in. */
const RULES: [string, (can: PermissionCheck) => boolean, PermissionKey[]][] = [
  ["moderates", moderates, [K.SESSION_MODERATE]],
  [
    "recordsResults",
    recordsResults,
    [K.SESSION_MODERATE, K.ASSEMBLY_VOTE_RESULT],
  ],
  [
    "notesSpeakers",
    notesSpeakers,
    [K.SESSION_MODERATE, K.SESSION_RECORD_SPEAKERS],
  ],
  ["viewsSeating", viewsSeating, [K.SEATING_VIEW, K.SEATING_EDIT]],
  ["validatesDocuments", validatesDocuments, [K.DOCUMENT_MANAGE]],
  [
    "reviewsAmendments",
    reviewsAmendments,
    [K.AMENDMENT_REVIEW, K.AMENDMENT_MANAGE],
  ],
  [
    "usesReviewQueue",
    usesReviewQueue,
    [K.DOCUMENT_MANAGE, K.AMENDMENT_REVIEW, K.AMENDMENT_MANAGE],
  ],
  [
    "seesDraftAssemblies",
    seesDraftAssemblies,
    [K.ASSEMBLY_MANAGE, K.SESSION_MODERATE],
  ],
  [
    "readsControlSheet",
    readsControlSheet,
    [
      K.CONTROL_SHEET_VIEW,
      K.CONTROL_SHEET_EDIT,
      K.SESSION_RECORD_SPEAKERS,
      K.ASSEMBLY_VOTE_RESULT,
    ],
  ],
];

describe.each(RULES)("%s", (_name, rule, opening) => {
  it("lets in exactly its keys, each held alone", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(rule(only(key)), key).toBe(opening.includes(key));
    }
  });

  it("keeps out an account with no key", () => {
    expect(rule(only())).toBe(false);
  });

  it("lets in an Admin, whose check holds every key", () => {
    expect(rule(() => true)).toBe(true);
  });
});

describe("the divergences ARQ-11 names", () => {
  it("opens «Validación» to an account with only amendment:manage", () => {
    const can = only(K.AMENDMENT_MANAGE);
    expect(usesReviewQueue(can)).toBe(true);
    expect(reviewsAmendments(can)).toBe(true);
    expect(validatesDocuments(can)).toBe(false);
  });

  it("opens the room to an account with only seating:edit", () => {
    expect(viewsSeating(only(K.SEATING_EDIT))).toBe(true);
  });
});
